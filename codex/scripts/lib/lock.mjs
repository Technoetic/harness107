import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, win32 } from "node:path";

import { HarnessError } from "./errors.mjs";

const RETRY_INTERVAL_MS = 25;
const lockContext = new AsyncLocalStorage();
const eventWriteContext = new AsyncLocalStorage();
const eventWriteTail = Symbol("eventWriteTail");

function hasWindowsAbsoluteSyntax(value) {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:\\\\|\/\/)(?:[?.][\\/]|[^\\/]+[\\/][^\\/]+)/.test(value)
  );
}

function lockTimeout(lockPath, waitMs) {
  return new HarnessError("LOCK_TIMEOUT", "timed out waiting for the workflow lock", {
    lock_path: lockPath,
    wait_ms: waitMs
  });
}

function validOptions(waitMs, staleMs, beforeReclaim, afterReclaimTransition, beforeRelease) {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "waitMs must be a non-negative finite number");
  }
  if (!Number.isFinite(staleMs) || staleMs < 0) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "staleMs must be a non-negative finite number");
  }
  if (
    typeof beforeReclaim !== "function" ||
    typeof afterReclaimTransition !== "function" ||
    typeof beforeRelease !== "function"
  ) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "lock transition hooks must be functions");
  }
}

function parseLockRecord(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.hostname !== "string" ||
    record.hostname === "" ||
    typeof record.acquired_at !== "string" ||
    Number.isNaN(Date.parse(record.acquired_at)) ||
    typeof record.token !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.token)
  ) {
    return null;
  }
  return record;
}

function processIsProvablyAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function archiveSuffix(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function claimName(token) {
  return `owner-${token}.json`;
}

function sameNode(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

async function directoryIdentity(path) {
  try {
    const information = await lstat(path);
    return information.isDirectory() && !information.isSymbolicLink() ? information : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeObservedDirectory(lockPath, identity) {
  if (!sameNode(identity, await directoryIdentity(lockPath))) return false;
  try {
    // Never rename or recursively delete the directory: a published successor is
    // nonempty, so even a replacement after the identity check cannot be removed.
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (["ENOTEMPTY", "EEXIST", "ENOTDIR", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
}

async function readObservedLock(lockPath) {
  let identity;
  let names;
  try {
    identity = await lstat(lockPath);
    if (identity.isSymbolicLink() || !identity.isDirectory()) return null;
    names = await readdir(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { absent: true };
    return null;
  }
  if (names.length === 0) return { absent: false, empty: true, identity };
  const claims = names.filter(name => /^owner-[A-Za-z0-9_-]+\.json$/.test(name));
  if (claims.length !== 1 || names.length !== 1) return null;
  const claimPath = join(lockPath, claims[0]);
  let raw;
  try {
    const claim = await lstat(claimPath);
    if (!claim.isFile() || claim.isSymbolicLink() || claim.nlink !== 1) return null;
    raw = await readFile(claimPath, "utf8");
  } catch {
    return null;
  }
  const record = parseLockRecord(raw);
  if (record === null || claimName(record.token) !== claims[0]) return null;
  if (!sameNode(identity, await directoryIdentity(lockPath))) return null;
  return { absent: false, claimPath, record, identity };
}

async function restoreClaim(archivedPath, claimPath) {
  try {
    await link(archivedPath, claimPath);
    await unlink(archivedPath);
    return true;
  } catch {
    return false;
  }
}

async function reclaimIfSafe(lockPath, { staleMs, now, beforeReclaim, afterReclaimTransition }) {
  const observed = await readObservedLock(lockPath);
  if (observed?.absent) return true;
  if (observed === null) return false;

  const currentTime = now();
  if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) return false;
  if (observed.empty) {
    // mtime is refreshed when the last claim is moved out during release/reclaim.
    // The publication path below never exposes an ownerless initialization.
    if (currentTime.getTime() - observed.identity.mtimeMs <= staleMs) return false;
    await beforeReclaim(null);
    const current = await directoryIdentity(lockPath);
    if (!sameNode(observed.identity, current) || current.mtimeMs !== observed.identity.mtimeMs) return false;
    return removeObservedDirectory(lockPath, observed.identity);
  }
  if (
    observed.record.hostname !== hostname() ||
    currentTime.getTime() - Date.parse(observed.record.acquired_at) <= staleMs ||
    !processIsProvablyAbsent(observed.record.pid)
  ) {
    return false;
  }

  await beforeReclaim(observed.record);
  if (!sameNode(observed.identity, await directoryIdentity(lockPath))) return false;
  const archivedPath = `${lockPath}.stale-${archiveSuffix(currentTime)}-${observed.record.token}.json`;
  try {
    await rename(observed.claimPath, archivedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await afterReclaimTransition(observed.record);

  try {
    if (await removeObservedDirectory(lockPath, observed.identity)) return true;
    // Restore only into the observed generation, never into a successor.
    if (sameNode(observed.identity, await directoryIdentity(lockPath))) {
      await restoreClaim(archivedPath, observed.claimPath);
    }
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (sameNode(observed.identity, await directoryIdentity(lockPath))) {
      await restoreClaim(archivedPath, observed.claimPath);
    }
    return false;
  }
}

async function createLock(lockPath, now, beforePublish) {
  const acquiredAt = now();
  if (!(acquiredAt instanceof Date) || Number.isNaN(acquiredAt.getTime())) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "now must return a valid Date");
  }
  const record = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: acquiredAt.toISOString(),
    token: randomUUID()
  };
  const claimPath = join(lockPath, claimName(record.token));
  const stagingPath = `${lockPath}.initializing-${record.token}`;
  const stagedClaimPath = join(stagingPath, claimName(record.token));
  let handle;
  let directoryCreated = false;
  try {
    // A completed owner record and directory become visible together. A killed
    // initializer leaves only a unique staging directory, never a blocked lock.
    await mkdir(stagingPath, { mode: 0o700 });
    directoryCreated = true;
    handle = await open(stagedClaimPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    const identity = await directoryIdentity(stagingPath);
    await beforePublish(record);
    // POSIX rename may replace an empty destination: leave observed orphans for
    // the age-checked reclamation path instead of replacing them here.
    try {
      await lstat(lockPath);
      throw Object.assign(new Error("lock already exists"), { code: "EEXIST" });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingPath, lockPath);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code) && await lstat(lockPath).catch(() => null)) {
        throw Object.assign(new Error("lock already exists"), { code: "EEXIST" });
      }
      throw error;
    }
    return { lockPath, claimPath, identity, token: record.token, active: true, closing: false };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (directoryCreated) {
      await unlink(stagedClaimPath).catch(() => {});
      await rmdir(stagingPath).catch(() => {});
    }
    throw error;
  }
}

async function acquireLock(lockPath, options) {
  const { waitMs, staleMs, now, beforeReclaim, afterReclaimTransition, beforeRelease } = options;
  validOptions(waitMs, staleMs, beforeReclaim, afterReclaimTransition, beforeRelease);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      return await createLock(lockPath, now, options.beforePublish);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (await reclaimIfSafe(lockPath, { staleMs, now, beforeReclaim, afterReclaimTransition })) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockTimeout(lockPath, waitMs);
    await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, remaining)));
  }
}

async function releaseLock(owner, beforeRelease) {
  await beforeRelease(owner);
  if (!sameNode(owner.identity, await directoryIdentity(owner.lockPath))) return;
  const retiredPath = `${owner.lockPath}.released-${owner.token}.json`;
  try {
    await rename(owner.claimPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  try {
    if (!await removeObservedDirectory(owner.lockPath, owner.identity)) {
      if (!sameNode(owner.identity, await directoryIdentity(owner.lockPath))) return;
      throw new Error("owned lock directory is not empty");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (sameNode(owner.identity, await directoryIdentity(owner.lockPath))) {
        await restoreClaim(retiredPath, owner.claimPath);
      }
      throw new HarnessError("LOCK_RELEASE_INTEGRITY_ERROR", "could not remove the owned lock directory", {
        cause: error.message
      });
    }
  }
  await unlink(retiredPath).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export function assertRunLockHeld(lockPath) {
  const owner = lockContext.getStore();
  if (!sameRunLockIdentity(owner?.lockPath, lockPath) || owner.active !== true) {
    throw new HarnessError("ARCHIVE_LOCK_REQUIRED", "active-state archival requires the workspace run lock");
  }
}

export function isRunLockHeld(lockPath) {
  const owner = lockContext.getStore();
  return sameRunLockIdentity(owner?.lockPath, lockPath) && owner.active === true;
}

export function sameRunLockIdentity(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (hasWindowsAbsoluteSyntax(left) && hasWindowsAbsoluteSyntax(right)) {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
  }
  return left === right;
}

export async function withRunLockEventWrite(lockPath, fn) {
  if (typeof fn !== "function") {
    throw new HarnessError("LOCK_CALLBACK_INVALID", "lock callback must be a function");
  }
  const owner = lockContext.getStore();
  if (!sameRunLockIdentity(owner?.lockPath, lockPath) || owner.active !== true) {
    throw new HarnessError("EVENT_WRITE_LOCK_REQUIRED", "event writes require the workspace run lock");
  }
  if (owner.closing) {
    throw new HarnessError("EVENT_WRITE_LOCK_CLOSING", "event writes cannot start while the run lock is closing");
  }
  if (eventWriteContext.getStore() === owner) {
    throw new HarnessError("EVENT_WRITE_REENTRANT", "nested event writes are not permitted");
  }

  const previous = owner[eventWriteTail] ?? Promise.resolve();
  let release;
  const ticket = new Promise(resolve => {
    release = resolve;
  });
  owner[eventWriteTail] = ticket;
  await previous;
  try {
    return await eventWriteContext.run(owner, fn);
  } finally {
    release();
    if (owner[eventWriteTail] === ticket) delete owner[eventWriteTail];
  }
}

export async function withRunLock(lockPath, fn, {
  waitMs = 5000,
  staleMs = 30000,
  now = () => new Date(),
  beforeReclaim = async () => {},
  afterReclaimTransition = async () => {},
  beforePublish = async () => {},
  beforeRelease = async () => {}
} = {}) {
  if (typeof fn !== "function") {
    throw new HarnessError("LOCK_CALLBACK_INVALID", "lock callback must be a function");
  }
  if (typeof beforePublish !== "function") {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "beforePublish must be a function");
  }
  const options = { waitMs, staleMs, now, beforeReclaim, afterReclaimTransition, beforeRelease, beforePublish };
  const owner = await acquireLock(lockPath, options);
  try {
    return await lockContext.run(owner, fn);
  } finally {
    owner.closing = true;
    await (owner[eventWriteTail] ?? Promise.resolve());
    owner.active = false;
    await releaseLock(owner, beforeRelease);
  }
}

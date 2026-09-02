import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { HarnessError } from "./errors.mjs";

const RETRY_INTERVAL_MS = 25;
const lockContext = new AsyncLocalStorage();

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

async function readObservedLock(lockPath) {
  let names;
  try {
    names = await readdir(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { absent: true };
    return null;
  }
  const claims = names.filter(name => /^owner-[A-Za-z0-9_-]+\.json$/.test(name));
  if (claims.length !== 1 || names.length !== 1) return null;
  const claimPath = join(lockPath, claims[0]);
  let raw;
  try {
    raw = await readFile(claimPath, "utf8");
  } catch {
    return null;
  }
  const record = parseLockRecord(raw);
  if (record === null || claimName(record.token) !== claims[0]) return null;
  return { absent: false, claimPath, record };
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
  if (
    !(currentTime instanceof Date) ||
    Number.isNaN(currentTime.getTime()) ||
    observed.record.hostname !== hostname() ||
    currentTime.getTime() - Date.parse(observed.record.acquired_at) <= staleMs ||
    !processIsProvablyAbsent(observed.record.pid)
  ) {
    return false;
  }

  await beforeReclaim(observed.record);
  const archivedPath = `${lockPath}.stale-${archiveSuffix(currentTime)}-${observed.record.token}.json`;
  try {
    await rename(observed.claimPath, archivedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await afterReclaimTransition(observed.record);

  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    await restoreClaim(archivedPath, observed.claimPath);
    return false;
  }
}

async function createLock(lockPath, now) {
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
  let handle;
  let directoryCreated = false;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    directoryCreated = true;
    handle = await open(claimPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return { lockPath, claimPath, token: record.token, active: true };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (directoryCreated) {
      await unlink(claimPath).catch(() => {});
      await rmdir(lockPath).catch(() => {});
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
      return await createLock(lockPath, now);
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
  const retiredPath = `${owner.lockPath}.released-${owner.token}.json`;
  try {
    await rename(owner.claimPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  try {
    await rmdir(owner.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await restoreClaim(retiredPath, owner.claimPath);
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
  if (owner?.lockPath !== lockPath || owner.active !== true) {
    throw new HarnessError("ARCHIVE_LOCK_REQUIRED", "active-state archival requires the workspace run lock");
  }
}

export function isRunLockHeld(lockPath) {
  const owner = lockContext.getStore();
  return owner?.lockPath === lockPath && owner.active === true;
}

export async function withRunLock(lockPath, fn, {
  waitMs = 5000,
  staleMs = 30000,
  now = () => new Date(),
  beforeReclaim = async () => {},
  afterReclaimTransition = async () => {},
  beforeRelease = async () => {}
} = {}) {
  if (typeof fn !== "function") {
    throw new HarnessError("LOCK_CALLBACK_INVALID", "lock callback must be a function");
  }
  const options = { waitMs, staleMs, now, beforeReclaim, afterReclaimTransition, beforeRelease };
  const owner = await acquireLock(lockPath, options);
  try {
    return await lockContext.run(owner, fn);
  } finally {
    owner.active = false;
    await releaseLock(owner, beforeRelease);
  }
}

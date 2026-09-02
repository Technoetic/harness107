import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { HarnessError } from "./errors.mjs";

const RETRY_INTERVAL_MS = 25;

function lockTimeout(lockPath, waitMs) {
  return new HarnessError("LOCK_TIMEOUT", "timed out waiting for the workflow lock", {
    lock_path: lockPath,
    wait_ms: waitMs
  });
}

function validOptions(waitMs, staleMs) {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "waitMs must be a non-negative finite number");
  }
  if (!Number.isFinite(staleMs) || staleMs < 0) {
    throw new HarnessError("LOCK_OPTIONS_INVALID", "staleMs must be a non-negative finite number");
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
    record.token === ""
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

async function restoreMovedLock(archivedPath, lockPath) {
  try {
    await link(archivedPath, lockPath);
    await unlink(archivedPath);
  } catch {
    // A new owner won the empty path. Never overwrite it while restoring.
  }
}

async function reclaimIfSafe(lockPath, { staleMs, now }) {
  let observedRaw;
  try {
    observedRaw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }

  const record = parseLockRecord(observedRaw);
  const currentTime = now();
  if (
    record === null ||
    !(currentTime instanceof Date) ||
    Number.isNaN(currentTime.getTime()) ||
    record.hostname !== hostname() ||
    currentTime.getTime() - Date.parse(record.acquired_at) <= staleMs ||
    !processIsProvablyAbsent(record.pid)
  ) {
    return false;
  }

  let latestRaw;
  try {
    latestRaw = await readFile(lockPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (latestRaw !== observedRaw) return false;

  const archivedPath = `${lockPath}.stale-${archiveSuffix(currentTime)}-${randomUUID()}`;
  try {
    await rename(lockPath, archivedPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }

  let movedRaw;
  try {
    movedRaw = await readFile(archivedPath, "utf8");
  } catch {
    await restoreMovedLock(archivedPath, lockPath);
    return false;
  }
  if (movedRaw !== observedRaw) {
    await restoreMovedLock(archivedPath, lockPath);
    return false;
  }
  return true;
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
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return { lockPath, token: record.token };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
    throw error;
  }
}

async function acquireLock(lockPath, { waitMs, staleMs, now }) {
  validOptions(waitMs, staleMs);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      return await createLock(lockPath, now);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (await reclaimIfSafe(lockPath, { staleMs, now })) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockTimeout(lockPath, waitMs);
    await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, remaining)));
  }
}

async function releaseLock(owner) {
  let raw;
  try {
    raw = await readFile(owner.lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const record = parseLockRecord(raw);
  if (record?.token !== owner.token) return;
  await unlink(owner.lockPath).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function withRunLock(lockPath, fn, {
  waitMs = 5000,
  staleMs = 30000,
  now = () => new Date()
} = {}) {
  if (typeof fn !== "function") {
    throw new HarnessError("LOCK_CALLBACK_INVALID", "lock callback must be a function");
  }
  const owner = await acquireLock(lockPath, { waitMs, staleMs, now });
  try {
    return await fn();
  } finally {
    await releaseLock(owner);
  }
}

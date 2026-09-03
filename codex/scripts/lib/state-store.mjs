import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { basename, join } from "node:path";

import { HarnessError } from "./errors.mjs";
import {
  assertRunLockHeld,
  isRunLockHeld,
  withRunLock,
  withRunLockEventWrite
} from "./lock.mjs";
import { pathsFor } from "./paths.mjs";
import { parseState } from "./schema.mjs";

const WINDOWS_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_RETRIES = 8;
const WINDOWS_RENAME_DELAY_MS = 25;
export const EVENT_LOG_LIMIT = 1024 * 1024;
const ACTIVE_METADATA = [
  "state.json",
  "receipts",
  "imports",
  "events.jsonl",
  "import-error.json"
];
const SAFE_EVENT_FIELDS = new Set([
  "kind",
  "timestamp",
  "workflow_id",
  "step",
  "selected_step",
  "attempt_id",
  "session_id",
  "turn_id",
  "status",
  "tool_name",
  "rule_id",
  "error_code",
  "reason_code",
  "imported_prefix_count",
  "prefix_length",
  "baseline_receipt_count",
  "receipt_count",
  "completed_count",
  "imported_count",
  "codex_verified_count",
  "failure_count",
  "consecutive_failures",
  "generation_id",
  "source_preserved"
]);
const preparedEventBatches = new WeakSet();

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function renameAtomic(sourcePath, destinationPath, {
  renameFile,
  platform,
  retryDelay
}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !WINDOWS_RENAME_ERRORS.has(error?.code) ||
        attempt >= WINDOWS_RENAME_RETRIES
      ) {
        throw error;
      }
      await retryDelay(WINDOWS_RENAME_DELAY_MS);
    }
  }
}

async function flushDirectory(directoryPath) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

function sanitizeEvent(event, now) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new HarnessError("EVENT_INVALID", "event must be an object");
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(event)) {
    if (!SAFE_EVENT_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  if (typeof sanitized.kind !== "string" || !/^[a-z][a-z0-9_]*$/.test(sanitized.kind)) {
    throw new HarnessError("EVENT_INVALID", "event kind must be a lower-case identifier");
  }
  if (!("timestamp" in sanitized)) {
    const timestamp = now();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new HarnessError("EVENT_INVALID", "now must return a valid Date");
    }
    sanitized.timestamp = timestamp.toISOString();
  }
  if (typeof sanitized.timestamp !== "string" || Number.isNaN(Date.parse(sanitized.timestamp))) {
    throw new HarnessError("EVENT_INVALID", "event timestamp must be an ISO-8601 string");
  }
  return sanitized;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function eventPathStat(path, message) {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", message);
  }
}

async function eventHandleStat(handle, message) {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", message);
  }
}

function requirePreparedBatch(prepared) {
  if (!preparedEventBatches.has(prepared)) {
    throw new HarnessError("EVENT_INVALID", "event batch must be prepared canonically");
  }
}

export function prepareEventBatch(events, { now = () => new Date() } = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new HarnessError("EVENT_INVALID", "event batch must be a non-empty array");
  }
  if (typeof now !== "function") {
    throw new HarnessError("EVENT_INVALID", "now must be a function");
  }
  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new HarnessError("EVENT_INVALID", "now must return a valid Date");
  }
  const clock = () => new Date(timestamp);
  const canonicalTimestamp = timestamp.toISOString();
  const values = events.map(event => Object.freeze(sanitizeEvent({
    ...event,
    timestamp: canonicalTimestamp
  }, clock)));
  const bytes = Buffer.from(values.map(event => `${JSON.stringify(event)}\n`).join(""), "utf8");
  const prepared = Object.freeze({
    events: Object.freeze(values),
    bytes
  });
  preparedEventBatches.add(prepared);
  return prepared;
}

async function writeAll(handle, bytes, position, writeChunk, onProgress = () => {}) {
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const result = await writeChunk(handle, bytes, offset, remaining, position + offset);
    if (result?.bytesWritten === 0) {
      throw new HarnessError("EVENT_WRITE_FAILED", "event batch write made no progress");
    }
    if (
      !Number.isInteger(result?.bytesWritten) ||
      result.bytesWritten < 0 ||
      result.bytesWritten > remaining
    ) {
      throw new HarnessError("EVENT_WRITE_INTEGRITY", "event batch write reported an invalid byte count");
    }
    offset += result.bytesWritten;
    onProgress(offset);
  }
}

async function defaultWriteChunk(handle, buffer, offset, length, position) {
  return handle.write(buffer, offset, length, position);
}

async function withEventWriteLock(workspaceRoot, operation) {
  const { lockPath } = pathsFor(workspaceRoot);
  const serialize = () => withRunLockEventWrite(lockPath, operation);
  if (isRunLockHeld(lockPath)) return serialize();
  return withRunLock(lockPath, serialize);
}

async function readEventRegion(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  try {
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, position + offset);
      if (!Number.isInteger(result?.bytesRead) || result.bytesRead <= 0) {
        throw new HarnessError("EVENT_WRITE_INTEGRITY", "partial event write could not be verified");
      }
      offset += result.bytesRead;
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("EVENT_WRITE_INTEGRITY", "partial event write could not be verified");
  }
  return bytes;
}

async function inspectRollbackTarget(handle, eventsPath, original) {
  const opened = await eventHandleStat(handle, "event log could not be rolled back safely");
  const current = await eventPathStat(eventsPath, "event log could not be rolled back safely");
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    !sameNode(original, opened) ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameNode(original, current) ||
    current.size !== opened.size
  ) {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be rolled back safely");
  }
  return opened.size;
}

async function assertRollbackTarget(handle, eventsPath, original, expectedSize) {
  if (await inspectRollbackTarget(handle, eventsPath, original) !== expectedSize) {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be rolled back safely");
  }
}

async function rollbackPreparedAppend(handle, eventsPath, original, originalSize, prepared, successfulBytes) {
  const observedSize = await inspectRollbackTarget(handle, eventsPath, original);
  const observedDelta = observedSize - originalSize;
  if (observedDelta < 0n || observedDelta > BigInt(prepared.length)) {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be rolled back safely");
  }
  const observedBytes = Number(observedDelta);
  if (observedBytes < successfulBytes) {
    throw new HarnessError("EVENT_WRITE_INTEGRITY", "partial event write had an invalid acknowledged size");
  }
  const written = await readEventRegion(handle, observedBytes, Number(originalSize));
  if (!written.equals(prepared.subarray(0, observedBytes))) {
    throw new HarnessError("EVENT_WRITE_INTEGRITY", "partial event write did not match the prepared batch");
  }
  await assertRollbackTarget(handle, eventsPath, original, observedSize);
  try {
    await handle.truncate(Number(originalSize));
    await handle.sync();
  } catch {
    throw new HarnessError("EVENT_ROLLBACK_FAILED", "partial event write could not be rolled back");
  }
  const restored = await eventHandleStat(handle, "event log rollback could not be verified safely");
  const current = await eventPathStat(eventsPath, "event log rollback could not be verified safely");
  if (
    !restored.isFile() ||
    restored.nlink !== 1n ||
    !sameNode(original, restored) ||
    restored.size !== originalSize ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameNode(original, current) ||
    current.size !== originalSize
  ) {
    throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log rollback could not be verified safely");
  }
}

async function appendPreparedBytes(handle, eventsPath, original, originalSize, prepared, writeChunk) {
  let successfulBytes = 0;
  try {
    await writeAll(
      handle,
      prepared,
      Number(originalSize),
      writeChunk,
      count => {
        successfulBytes = count;
      }
    );
    await handle.sync();
  } catch (error) {
    await rollbackPreparedAppend(
      handle,
      eventsPath,
      original,
      originalSize,
      prepared,
      successfulBytes
    );
    throw error;
  }
}

export async function withPinnedEventBatch(workspaceRoot, prepared, mutation, {
  writeChunk = defaultWriteChunk,
  beforeAppend = async () => {}
} = {}) {
  requirePreparedBatch(prepared);
  if (
    typeof mutation !== "function" ||
    typeof writeChunk !== "function" ||
    typeof beforeAppend !== "function"
  ) {
    throw new HarnessError("EVENT_INVALID", "event batch callbacks must be functions");
  }
  return withEventWriteLock(workspaceRoot, async () => {
    const { eventsPath } = pathsFor(workspaceRoot);
    const original = await eventPathStat(eventsPath, "event log must already exist");
    if (original.isSymbolicLink() || !original.isFile() || original.nlink !== 1n) {
      throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log must be an unaliased regular file");
    }
    let handle;
    try {
      try {
        handle = await open(eventsPath, "r+");
      } catch {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be opened safely");
      }
      const opened = await eventHandleStat(handle, "event log could not be inspected safely");
      if (!opened.isFile() || opened.nlink !== 1n || !sameNode(original, opened)) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log changed before batch mutation");
      }
      if (opened.size + BigInt(prepared.bytes.length) > BigInt(EVENT_LOG_LIMIT)) {
        throw new HarnessError("EVENT_LOG_LIMIT", "event log exceeds the byte limit");
      }
      const result = await mutation();
      await beforeAppend();
      const prewrite = await eventHandleStat(handle, "event log changed during batch mutation");
      if (
        !prewrite.isFile() ||
        prewrite.nlink !== 1n ||
        !sameNode(original, prewrite) ||
        prewrite.size !== opened.size
      ) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log changed during batch mutation");
      }
      const current = await eventPathStat(eventsPath, "event log changed during batch mutation");
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1n ||
        !sameNode(original, current) ||
        current.size !== prewrite.size
      ) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log changed during batch mutation");
      }
      if (prewrite.size + BigInt(prepared.bytes.length) > BigInt(EVENT_LOG_LIMIT)) {
        throw new HarnessError("EVENT_LOG_LIMIT", "event log exceeds the byte limit");
      }
      const expectedSize = prewrite.size + BigInt(prepared.bytes.length);
      await appendPreparedBytes(handle, eventsPath, original, prewrite.size, prepared.bytes, writeChunk);
      const written = await eventHandleStat(handle, "event log changed during batch append");
      const final = await eventPathStat(eventsPath, "event log changed during batch append");
      if (
        !written.isFile() ||
        written.nlink !== 1n ||
        !sameNode(original, written) ||
        written.size !== expectedSize ||
        final.isSymbolicLink() ||
        !final.isFile() ||
        final.nlink !== 1n ||
        !sameNode(original, final) ||
        final.size !== expectedSize
      ) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log changed during batch append");
      }
      return result;
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

function archiveReason(value) {
  if (typeof value !== "string") return "archive";
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || "archive";
}

export async function readState(workspaceRoot) {
  const { statePath } = pathsFor(workspaceRoot);
  try {
    return parseState(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeStateAtomic(workspaceRoot, state, {
  beforeRename,
  renameFile = rename,
  platform = process.platform,
  retryDelay = delay
} = {}) {
  const { codexDir, statePath } = pathsFor(workspaceRoot);
  if (typeof renameFile !== "function" || typeof retryDelay !== "function") {
    throw new HarnessError("STATE_WRITE_OPTIONS_INVALID", "renameFile and retryDelay must be functions");
  }
  const canonicalState = parseState(JSON.stringify(state));
  const serialized = `${JSON.stringify(canonicalState, null, 2)}\n`;
  const temporaryPath = join(codexDir, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(codexDir, { recursive: true });

  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (beforeRename !== undefined) {
      if (typeof beforeRename !== "function") {
        throw new HarnessError("STATE_WRITE_OPTIONS_INVALID", "beforeRename must be a function");
      }
      await beforeRename({ temporaryPath, statePath });
    }
    await renameAtomic(temporaryPath, statePath, { renameFile, platform, retryDelay });
    renamed = true;
    await flushDirectory(codexDir);
    return canonicalState;
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function mutateState(workspaceRoot, mutation, lockOptions = {}) {
  if (typeof mutation !== "function") {
    throw new HarnessError("STATE_MUTATION_INVALID", "state mutation must be a function");
  }
  const { lockPath } = pathsFor(workspaceRoot);
  return withRunLock(lockPath, async () => {
    const current = await readState(workspaceRoot);
    const next = await mutation(current);
    return writeStateAtomic(workspaceRoot, next);
  }, lockOptions);
}

export async function appendEvent(workspaceRoot, event, { now = () => new Date() } = {}) {
  const { codexDir, eventsPath } = pathsFor(workspaceRoot);
  const prepared = prepareEventBatch([event], { now });
  await withEventWriteLock(workspaceRoot, async () => {
    await mkdir(codexDir, { recursive: true });
    let handle;
    try {
      try {
        handle = await open(eventsPath, "r+");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be opened safely");
        }
        try {
          handle = await open(eventsPath, "wx+", 0o600);
        } catch {
          throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log could not be opened safely");
        }
      }
      const opened = await eventHandleStat(handle, "event log could not be inspected safely");
      const current = await eventPathStat(eventsPath, "event log could not be inspected safely");
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1n ||
        !sameNode(opened, current) ||
        current.size !== opened.size
      ) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log must be an unaliased regular file");
      }
      if (opened.size + BigInt(prepared.bytes.length) > BigInt(EVENT_LOG_LIMIT)) {
        throw new HarnessError("EVENT_LOG_LIMIT", "event log exceeds the byte limit");
      }
      const expectedSize = opened.size + BigInt(prepared.bytes.length);
      await appendPreparedBytes(
        handle,
        eventsPath,
        opened,
        opened.size,
        prepared.bytes,
        defaultWriteChunk
      );
      const written = await eventHandleStat(handle, "event log changed during append");
      const final = await eventPathStat(eventsPath, "event log changed during append");
      if (
        !written.isFile() ||
        written.nlink !== 1n ||
        written.size !== expectedSize ||
        final.isSymbolicLink() ||
        !final.isFile() ||
        final.nlink !== 1n ||
        !sameNode(written, final) ||
        final.size !== expectedSize
      ) {
        throw new HarnessError("WORKSPACE_PATH_UNSAFE", "event log changed during append");
      }
    } finally {
      await handle?.close();
    }
  });
  return prepared.events[0];
}

/** Must be called from the callback of withRunLock() for this workspace. */
export async function archiveActiveState(workspaceRoot, {
  reason = "archive",
  now = () => new Date(),
  renameFile = rename
} = {}) {
  const { codexDir, backupsDir } = pathsFor(workspaceRoot);
  assertRunLockHeld(pathsFor(workspaceRoot).lockPath);
  if (typeof renameFile !== "function") {
    throw new HarnessError("ARCHIVE_OPTIONS_INVALID", "renameFile must be a function");
  }
  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new HarnessError("ARCHIVE_OPTIONS_INVALID", "now must return a valid Date");
  }
  const archiveName = `${timestamp.toISOString().replace(/[:.]/g, "-")}-${archiveReason(reason)}-${randomUUID()}`;
  const archivePath = join(backupsDir, archiveName);
  await mkdir(archivePath, { recursive: true });

  const moved = [];
  try {
    const activeNames = new Set(await readdir(codexDir));
    for (const name of ACTIVE_METADATA) {
      if (!activeNames.has(name)) continue;
      const sourcePath = join(codexDir, name);
      const destinationPath = join(archivePath, name);
      await renameFile(sourcePath, destinationPath);
      moved.push({ sourcePath, destinationPath });
    }
    await flushDirectory(codexDir);
    await flushDirectory(backupsDir);
    return archivePath;
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...moved].reverse()) {
      try {
        await renameFile(item.destinationPath, item.sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push({
          name: basename(item.sourcePath),
          message: rollbackError?.message ?? String(rollbackError)
        });
      }
    }
    if (rollbackErrors.length > 0) {
      throw new HarnessError("ARCHIVE_INTEGRITY_ERROR", "active metadata could not be fully restored", {
        cause: error?.message ?? String(error),
        archive_path: archivePath,
        archived_items: rollbackErrors.map(item => item.name),
        rollback_errors: rollbackErrors
      });
    }
    throw error;
  } finally {
    const remaining = await readdir(archivePath).catch(() => ["unavailable"]);
    if (remaining.length === 0) await rmdir(archivePath).catch(() => {});
  }
}

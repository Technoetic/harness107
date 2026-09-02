import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { basename, join } from "node:path";

import { HarnessError } from "./errors.mjs";
import { assertRunLockHeld, withRunLock } from "./lock.mjs";
import { pathsFor } from "./paths.mjs";
import { parseState } from "./schema.mjs";

const WINDOWS_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_RETRIES = 8;
const WINDOWS_RENAME_DELAY_MS = 25;
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
  "source_preserved"
]);

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
  const sanitized = sanitizeEvent(event, now);
  const line = `${JSON.stringify(sanitized)}\n`;
  await mkdir(codexDir, { recursive: true });
  const handle = await open(eventsPath, "a", 0o600);
  try {
    await handle.write(line, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sanitized;
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

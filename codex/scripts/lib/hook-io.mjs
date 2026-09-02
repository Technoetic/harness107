import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { HarnessError } from "./errors.mjs";
import { readJsonInput, writeOutput } from "./json-io.mjs";
import { withRunLock } from "./lock.mjs";
import { pathsFor } from "./paths.mjs";

export const HOOK_INPUT_LIMIT = 1024 * 1024;

const COMMON_REQUIRED_FIELDS = new Set([
  "session_id",
  "transcript_path",
  "permission_mode",
  "model"
]);
const EVENT_FIELDS = new Map([
  ["SessionStart", {
    required: new Set(["hook_event_name", "cwd", "source", ...COMMON_REQUIRED_FIELDS]),
    optional: new Set()
  }],
  ["UserPromptSubmit", {
    required: new Set([
      "hook_event_name",
      "cwd",
      "turn_id",
      "prompt",
      ...COMMON_REQUIRED_FIELDS
    ]),
    optional: new Set(["agent_id", "agent_type"])
  }],
  ["Stop", {
    required: new Set([
      "hook_event_name",
      "cwd",
      "turn_id",
      "stop_hook_active",
      "last_assistant_message",
      ...COMMON_REQUIRED_FIELDS
    ]),
    optional: new Set()
  }]
]);
const SESSION_SOURCES = new Set(["startup", "resume", "clear", "compact"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions"
]);
const SAFE_HOOK_EVENT_FIELDS = new Set([
  "kind",
  "workflow_id",
  "step",
  "turn_id",
  "status",
  "reason_code",
  "baseline_receipt_count",
  "completed_count"
]);
const preparedHookEvents = new WeakSet();

function fail(code, message) {
  throw new HarnessError(code, message);
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireText(value) {
  return typeof value === "string" && value.length > 0;
}

async function assertPhysicalPath(workspaceRoot, candidate, { rejectFileAliases = false } = {}) {
  const root = resolve(workspaceRoot);
  const target = resolve(candidate);
  const relative = target.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of relative) {
    current = join(current, part);
    let information;
    try {
      information = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    if (information.isSymbolicLink()) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    let canonical;
    try {
      canonical = await realpath(current);
    } catch {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    if (!samePath(current, canonical)) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    if (rejectFileAliases && samePath(current, target) && information.isFile() && information.nlink !== 1) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
  }
}

function storagePaths(paths) {
  return [
    join(paths.workspaceRoot, "step_archive"),
    paths.codexDir,
    paths.statePath,
    paths.eventsPath,
    paths.receiptsDir,
    paths.lockPath
  ];
}

async function assertPhysicalComponents(workspaceRoot, candidates) {
  const root = resolve(workspaceRoot);
  let rootBefore;
  let canonicalRoot;
  try {
    rootBefore = await lstat(root, { bigint: true });
    canonicalRoot = await realpath(root);
  } catch {
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory() || !samePath(root, canonicalRoot)) {
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
  for (const candidate of candidates) {
    const target = resolve(candidate);
    const pathFromRoot = relative(root, target);
    if (
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(pathFromRoot)
    ) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    let current = root;
    for (const part of pathFromRoot.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, part);
      let before;
      try {
        before = await lstat(current, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") break;
        fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
      }
      let canonical;
      let after;
      try {
        canonical = await realpath(current);
        after = await lstat(current, { bigint: true });
      } catch {
        fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
      }
      if (
        before.isSymbolicLink() ||
        !sameNode(before, after) ||
        !samePath(current, canonical)
      ) {
        fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
      }
    }
  }
}

async function existingStat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
}

async function assertControlFiles(controlPaths) {
  for (const path of controlPaths) {
    const information = await existingStat(path);
    if (
      information !== null &&
      (information.isSymbolicLink() || !information.isFile() || information.nlink !== 1n)
    ) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
  }
}

export async function captureHookStorageGuard(workspaceRoot, { includeLock = true } = {}) {
  const paths = pathsFor(workspaceRoot);
  await assertPhysicalComponents(paths.workspaceRoot, storagePaths(paths));
  const identities = new Map();
  const stableDirectories = [
    paths.workspaceRoot,
    join(paths.workspaceRoot, "step_archive"),
    paths.codexDir,
    paths.receiptsDir
  ];
  if (includeLock) stableDirectories.push(paths.lockPath);
  for (const path of stableDirectories) {
    const information = await existingStat(path);
    if (information === null) continue;
    if (information.isSymbolicLink() || !information.isDirectory()) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    identities.set(path, information);
  }
  let eventsIdentity;
  if (includeLock) {
    const information = await existingStat(paths.eventsPath);
    eventsIdentity = information !== null &&
      !information.isSymbolicLink() &&
      information.isFile() &&
      information.nlink === 1n
      ? information
      : null;
  }
  return { paths, identities, eventsIdentity };
}

export async function assertHookStorageGuard(guard, controlPaths = []) {
  const { paths, identities } = guard;
  await assertPhysicalComponents(paths.workspaceRoot, storagePaths(paths));
  await assertControlFiles(controlPaths);
  for (const [path, expected] of identities) {
    const current = await existingStat(path);
    if (current === null || current.isSymbolicLink() || !sameNode(expected, current)) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
  }
  if (guard.eventsIdentity !== undefined && guard.eventsIdentity !== null) {
    const current = await existingStat(paths.eventsPath);
    if (
      current === null ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameNode(guard.eventsIdentity, current)
    ) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
  }
}

export function preparePinnedHookEvent(event, {
  now = () => new Date()
} = {}) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    fail("HOOK_INTERNAL", "hook failed safely");
  }
  if (typeof now !== "function") fail("HOOK_INTERNAL", "hook failed safely");
  const materialized = {};
  for (const [key, value] of Object.entries(event)) {
    if (!SAFE_HOOK_EVENT_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      materialized[key] = value;
    }
  }
  if (typeof materialized.kind !== "string" || !/^[a-z][a-z0-9_]*$/.test(materialized.kind)) {
    fail("HOOK_INTERNAL", "hook failed safely");
  }
  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    fail("HOOK_INTERNAL", "hook failed safely");
  }
  materialized.timestamp = timestamp.toISOString();
  const prepared = Object.freeze({
    value: Object.freeze(materialized),
    bytes: Buffer.from(`${JSON.stringify(materialized)}\n`, "utf8")
  });
  preparedHookEvents.add(prepared);
  return prepared;
}

async function openPinnedHookEventHandle(guard) {
  await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
  const original = guard.eventsIdentity;
  if (original === undefined || original === null) {
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
  let handle;
  try {
    handle = await open(guard.paths.eventsPath, "r+");
    const opened = await handle.stat({ bigint: true });
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameNode(original, opened)
    ) {
      fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
    }
    await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
    return { handle, opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
    throw error;
  }
}

export async function preflightPinnedHookEventTarget(guard, prepared) {
  if (!preparedHookEvents.has(prepared)) fail("HOOK_INTERNAL", "hook failed safely");
  const { handle, opened } = await openPinnedHookEventHandle(guard);
  try {
    if (opened.size + BigInt(prepared.bytes.length) > BigInt(HOOK_INPUT_LIMIT)) {
      fail("HOOK_INTERNAL", "hook failed safely");
    }
  } catch (error) {
    await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
    throw error;
  } finally {
    await handle.close();
  }
  await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
}

export async function appendPreparedPinnedHookEvent(guard, prepared) {
  if (!preparedHookEvents.has(prepared)) fail("HOOK_INTERNAL", "hook failed safely");
  const { handle, opened } = await openPinnedHookEventHandle(guard);
  try {
    if (opened.size + BigInt(prepared.bytes.length) > BigInt(HOOK_INPUT_LIMIT)) {
      fail("HOOK_INTERNAL", "hook failed safely");
    }
    const result = await handle.write(
      prepared.bytes,
      0,
      prepared.bytes.length,
      Number(opened.size)
    );
    if (result.bytesWritten !== prepared.bytes.length) fail("HOOK_INTERNAL", "hook failed safely");
    await handle.sync();
    await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
    return prepared.value;
  } catch (error) {
    await assertHookStorageGuard(guard, [guard.paths.eventsPath]);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function appendPinnedHookEvent(guard, event, options = {}) {
  const prepared = preparePinnedHookEvent(event, options);
  return appendPreparedPinnedHookEvent(guard, prepared);
}

export async function guardedHookOperation(guard, controlPaths, operation, {
  allowReplacement = false
} = {}) {
  await assertHookStorageGuard(guard, controlPaths);
  const identities = new Map();
  if (!allowReplacement) {
    for (const path of controlPaths) {
      const information = await existingStat(path);
      if (information !== null) identities.set(path, information);
    }
  }
  try {
    const result = await operation();
    await assertHookStorageGuard(guard, controlPaths);
    for (const [path, expected] of identities) {
      const current = await existingStat(path);
      if (current === null || !sameNode(expected, current)) {
        fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
      }
    }
    return result;
  } catch (error) {
    await assertHookStorageGuard(guard, controlPaths);
    throw error;
  }
}

export async function withHookStorageLock(workspaceRoot, operation) {
  const beforeLock = await captureHookStorageGuard(workspaceRoot, { includeLock: false });
  return withRunLock(beforeLock.paths.lockPath, async () => {
    await assertHookStorageGuard(beforeLock);
    const locked = await captureHookStorageGuard(workspaceRoot);
    try {
      const result = await operation(locked);
      await assertHookStorageGuard(locked);
      return result;
    } catch (error) {
      await assertHookStorageGuard(locked);
      throw error;
    }
  });
}

export async function validateEventWorkspace(cwd) {
  if (!requireText(cwd) || !isAbsolute(cwd)) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  let information;
  let canonical;
  let processCanonical;
  try {
    information = await lstat(cwd);
    canonical = await realpath(cwd);
    processCanonical = await realpath(process.cwd());
  } catch {
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
  if (
    information.isSymbolicLink() ||
    !information.isDirectory() ||
    !samePath(cwd, canonical) ||
    !samePath(canonical, processCanonical)
  ) {
    fail("HOOK_WORKSPACE_UNSAFE", "hook workspace rejected");
  }
  await assertPhysicalPath(canonical, join(canonical, "step_archive"));
  const codexRoot = join(canonical, "step_archive", ".harness50-codex");
  await assertPhysicalPath(canonical, codexRoot);
  await assertPhysicalPath(canonical, join(codexRoot, "state.json"), { rejectFileAliases: true });
  await assertPhysicalPath(canonical, join(codexRoot, "events.jsonl"), { rejectFileAliases: true });
  await assertPhysicalPath(canonical, join(codexRoot, "receipts"));
  await assertPhysicalPath(canonical, join(codexRoot, "run.lock"));
  return canonical;
}

function validateOptionalFields(event) {
  if ("session_id" in event && typeof event.session_id !== "string") {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if (
    "transcript_path" in event &&
    !(event.transcript_path === null || typeof event.transcript_path === "string")
  ) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if ("permission_mode" in event && !PERMISSION_MODES.has(event.permission_mode)) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if ("model" in event && typeof event.model !== "string") {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  for (const field of ["agent_id", "agent_type"]) {
    if (field in event && typeof event[field] !== "string") {
      fail("HOOK_EVENT_INVALID", "hook event rejected");
    }
  }
}

export async function validateHookEvent(raw, expectedName) {
  const schema = EVENT_FIELDS.get(expectedName);
  if (schema === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  const allowed = new Set([...schema.required, ...schema.optional]);
  const fields = Object.keys(raw);
  if (
    fields.some(field => !allowed.has(field)) ||
    [...schema.required].some(field => !(field in raw)) ||
    raw.hook_event_name !== expectedName
  ) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if (typeof raw.cwd !== "string") fail("HOOK_EVENT_INVALID", "hook event rejected");
  validateOptionalFields(raw);

  if (expectedName === "SessionStart" && !SESSION_SOURCES.has(raw.source)) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if (expectedName === "UserPromptSubmit") {
    if (typeof raw.turn_id !== "string" || typeof raw.prompt !== "string") {
      fail("HOOK_EVENT_INVALID", "hook event rejected");
    }
  }
  if (expectedName === "Stop") {
    if (
      typeof raw.turn_id !== "string" ||
      typeof raw.stop_hook_active !== "boolean" ||
      !(raw.last_assistant_message === null || typeof raw.last_assistant_message === "string")
    ) {
      fail("HOOK_EVENT_INVALID", "hook event rejected");
    }
  }
  const workspaceRoot = await validateEventWorkspace(raw.cwd);
  return { event: raw, workspaceRoot };
}

export function continuationMarker(continuation) {
  return `[HARNESS50_CONTINUE ${JSON.stringify(continuation)}]`;
}

export async function readLifecycleEvents(workspaceRoot) {
  const eventsPath = join(workspaceRoot, "step_archive", ".harness50-codex", "events.jsonl");
  let bytes;
  try {
    bytes = await readFile(eventsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    fail("HOOK_INTERNAL", "hook failed safely");
  }
  if (bytes.length > HOOK_INPUT_LIMIT) fail("HOOK_INTERNAL", "hook failed safely");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("HOOK_INTERNAL", "hook failed safely");
  }
  if (text === "") return [];
  if (!text.endsWith("\n") || text.includes("\r")) fail("HOOK_INTERNAL", "hook failed safely");
  try {
    return text.slice(0, -1).split("\n").map(line => {
      const event = JSON.parse(line);
      if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error();
      return event;
    });
  } catch {
    fail("HOOK_INTERNAL", "hook failed safely");
  }
}

function matchesCurrentContinuation(event, state) {
  return event.workflow_id === state.workflow_id &&
    event.step === state.current_step &&
    event.baseline_receipt_count === state.completed_steps.length;
}

export function currentContinuationLedgerGeneration(events, state) {
  if (!Array.isArray(events) || state === null || typeof state !== "object") return null;
  let latestWorkflowBoundary = -1;
  let matchingBoundary = -1;
  if (state.continuation !== null && state.continuation !== undefined) {
    if (
      state.continuation.workflow_id !== state.workflow_id ||
      state.continuation.step !== state.current_step ||
      state.continuation.baseline_receipt_count !== state.completed_steps.length
    ) {
      return null;
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.kind !== "continuation_issued" || event.workflow_id !== state.workflow_id) continue;
      latestWorkflowBoundary = index;
      if (
        matchesCurrentContinuation(event, state) &&
        event.timestamp === state.continuation.issued_at
      ) {
        matchingBoundary = index;
      }
    }
  } else if (state.current_attempt !== null && state.current_attempt !== undefined) {
    const consumed = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        event.kind === "continuation_consumed" &&
        event.workflow_id === state.workflow_id &&
        event.step === state.current_step &&
        event.baseline_receipt_count === state.completed_steps.length &&
        event.attempt_id === state.current_attempt.id
      ) {
        consumed.push(index);
      }
    }
    if (consumed.length !== 1) return null;
    const consumedIndex = consumed[0];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.kind !== "continuation_issued" || event.workflow_id !== state.workflow_id) continue;
      latestWorkflowBoundary = index;
      if (index < consumedIndex && matchesCurrentContinuation(event, state)) {
        matchingBoundary = index;
      }
    }
  } else {
    return null;
  }
  if (matchingBoundary < 0 || matchingBoundary !== latestWorkflowBoundary) return null;

  const requests = [];
  for (let index = matchingBoundary + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind !== "stop_continuation_requested" || event.workflow_id !== state.workflow_id) {
      continue;
    }
    if (!matchesCurrentContinuation(event, state) || typeof event.turn_id !== "string") return null;
    requests.push({ event, index });
  }
  if (requests.length > 1) return null;
  const requestRecord = requests[0] ?? null;
  const accepted = requestRecord !== null && events.slice(requestRecord.index + 1).some(event =>
    event.kind === "continuation_prompt_accepted" &&
    matchesCurrentContinuation(event, state) &&
    event.turn_id === requestRecord.event.turn_id
  );
  return Object.freeze({
    boundaryIndex: matchingBoundary,
    request: requestRecord?.event ?? null,
    requestIndex: requestRecord?.index ?? null,
    accepted
  });
}

export function stopTurnWasRequested(events, workflowId, turnId) {
  return events.some(event =>
    event.kind === "stop_continuation_requested" &&
    event.workflow_id === workflowId &&
    event.turn_id === turnId
  );
}

export function stopTurnWasAccepted(events, state, turnId = state.last_stop_turn_id) {
  return events.some(event =>
    event.kind === "continuation_prompt_accepted" &&
    event.workflow_id === state.workflow_id &&
    event.turn_id === turnId
  );
}

function publicError(error) {
  if (error instanceof HarnessError) {
    if (error.code === "INPUT_TOO_LARGE") {
      return { code: "HOOK_INPUT_TOO_LARGE", message: "hook input exceeds the byte limit" };
    }
    if (typeof error.code === "string" && error.code.startsWith("INPUT_")) {
      return { code: "HOOK_INPUT_INVALID", message: "hook input rejected" };
    }
    if (error.code === "HOOK_EVENT_INVALID") {
      return { code: "HOOK_EVENT_INVALID", message: "hook event rejected" };
    }
    if (error.code === "HOOK_WORKSPACE_UNSAFE" || error.code === "WORKSPACE_PATH_UNSAFE") {
      return { code: "HOOK_WORKSPACE_UNSAFE", message: "hook workspace rejected" };
    }
  }
  return { code: "HOOK_INTERNAL", message: "hook failed safely" };
}

function isPlainOutput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function runHookMain(expectedName, handler, {
  stdin = process.stdin,
  stdout = process.stdout
} = {}) {
  if (typeof handler !== "function") fail("HOOK_INTERNAL", "hook failed safely");
  const raw = await readJsonInput(stdin, HOOK_INPUT_LIMIT);
  const { event, workspaceRoot } = await validateHookEvent(raw, expectedName);
  const output = await handler(event, { workspaceRoot });
  if (!isPlainOutput(output)) fail("HOOK_INTERNAL", "hook failed safely");
  await writeOutput(stdout, `${JSON.stringify(output)}\n`);
  return 0;
}

export async function runHookDirect(expectedName, handler, {
  stdout = process.stdout,
  runMain = runHookMain
} = {}) {
  try {
    const code = await Promise.resolve().then(() => runMain(expectedName, handler));
    process.exitCode = code;
    return code;
  } catch (error) {
    process.exitCode = 1;
    try {
      await writeOutput(stdout, `${JSON.stringify({ error: publicError(error) })}\n`);
    } catch {
      // A failed hook output stream cannot safely receive another document.
    }
    return 1;
  }
}

export function isDirectEntrypoint(metaUrl, argvPath = process.argv[1]) {
  if (typeof argvPath !== "string") return false;
  try {
    return metaUrl === pathToFileURL(argvPath).href;
  } catch {
    return false;
  }
}

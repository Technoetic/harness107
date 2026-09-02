import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { HarnessError } from "./errors.mjs";
import { readJsonInput, writeOutput } from "./json-io.mjs";

export const HOOK_INPUT_LIMIT = 1024 * 1024;

const COMMON_OPTIONAL_FIELDS = new Set(["session_id", "transcript_path", "permission_mode"]);
const EVENT_FIELDS = new Map([
  ["SessionStart", {
    required: new Set(["hook_event_name", "cwd", "source"]),
    optional: COMMON_OPTIONAL_FIELDS
  }],
  ["UserPromptSubmit", {
    required: new Set(["hook_event_name", "cwd", "turn_id", "prompt"]),
    optional: COMMON_OPTIONAL_FIELDS
  }],
  ["Stop", {
    required: new Set([
      "hook_event_name",
      "cwd",
      "turn_id",
      "stop_hook_active",
      "last_assistant_message"
    ]),
    optional: COMMON_OPTIONAL_FIELDS
  }]
]);
const SESSION_SOURCES = new Set(["startup", "resume", "compact"]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function fail(code, message) {
  throw new HarnessError(code, message);
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
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
  if ("session_id" in event && !SAFE_ID.test(event.session_id)) {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if ("transcript_path" in event && typeof event.transcript_path !== "string") {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
  }
  if ("permission_mode" in event && typeof event.permission_mode !== "string") {
    fail("HOOK_EVENT_INVALID", "hook event rejected");
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
    if (!SAFE_ID.test(raw.turn_id) || typeof raw.prompt !== "string") {
      fail("HOOK_EVENT_INVALID", "hook event rejected");
    }
  }
  if (expectedName === "Stop") {
    if (
      !SAFE_ID.test(raw.turn_id) ||
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

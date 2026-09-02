import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { HarnessError } from "./errors.mjs";
import { withRunLock } from "./lock.mjs";
import {
  assertOwner,
  claimOwner,
  renewOwner,
  transferOwner
} from "./ownership.mjs";
import { assertInside, pathsFor } from "./paths.mjs";
import {
  parseReceipt,
  readReceipts,
  reconcileReceipts,
  sanitizeEvidence,
  writeReceiptExclusive
} from "./receipts.mjs";
import { createInitialState, validateState } from "./schema.mjs";
import {
  appendEvent,
  archiveActiveState,
  readState,
  writeStateAtomic
} from "./state-store.mjs";

const STEP_COUNT = 50;
const TOPIC_RELATIVE_PATH = "step_archive/TOPIC/TOPIC.md";
const IMPORT_RECOVERY_ACTION = "repair the Claude state or use a separate workspace";
const ACTIVE_METADATA = new Set([
  "state.json",
  "receipts",
  "imports",
  "events.jsonl",
  "import-error.json"
]);
const RECOGNIZED_OUTPUTS = ["outputs", "specs", "screenshots"];
const IMPORT_ERROR_FIELDS = new Set([
  "schema_version",
  "code",
  "source_preserved",
  "source_path",
  "source_sha256",
  "occurred_at",
  "action"
]);

function fail(code, message, details = {}) {
  throw new HarnessError(code, message, details);
}

function clockFrom(rawNow = () => new Date()) {
  const value = typeof rawNow === "function" ? rawNow() : rawNow;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) fail("CLOCK_INVALID", "now must identify a valid time");
  return {
    date,
    iso: date.toISOString(),
    now: () => new Date(date)
  };
}

function requireFactory(idFactory) {
  if (typeof idFactory !== "function") {
    fail("ID_FACTORY_INVALID", "idFactory must be a function");
  }
  return idFactory;
}

function nextId(idFactory, label) {
  const value = idFactory();
  if (typeof value !== "string" || value.trim() === "") {
    fail("ID_FACTORY_INVALID", `idFactory must return a non-empty ${label}`);
  }
  return value;
}

function requireStep(step) {
  if (!Number.isInteger(step) || step < 1 || step > STEP_COUNT) {
    fail("STEP_RANGE", `step must be an integer from 1 through ${STEP_COUNT}`, { step });
  }
  return step;
}

function requireText(value, field, code = "WORKFLOW_INPUT_INVALID") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function normalizeSessionId(value) {
  if (value === undefined || value === null) return null;
  return requireText(value, "sessionId", "SESSION_INVALID");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function withMutation(workspaceRoot, rawNow, callback) {
  const paths = pathsFor(workspaceRoot);
  const clock = clockFrom(rawNow);
  return withRunLock(paths.lockPath, () => callback(paths, clock), { now: clock.now });
}

async function requireState(workspaceRoot) {
  const state = await readState(workspaceRoot);
  if (state === null) fail("WORKFLOW_NOT_FOUND", "no active Codex workflow exists");
  return validateState(state);
}

async function appendEvents(workspaceRoot, events, clock) {
  for (const event of events) {
    await appendEvent(workspaceRoot, { ...event, timestamp: clock.iso }, { now: clock.now });
  }
}

async function appendRejectedContinuation(workspaceRoot, state, error, clock) {
  try {
    await appendEvents(workspaceRoot, [{
      kind: "continuation_replay_rejected",
      workflow_id: state.workflow_id,
      step: state.current_step,
      error_code: error.code
    }], clock);
  } catch {
    // Rejection is authoritative even when its diagnostic event cannot be appended.
  }
}

function markerFields(marker) {
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    fail("CONTINUATION_INVALID", "continuation marker must be an object");
  }
  const fields = ["workflow_id", "step", "nonce", "issued_at", "baseline_receipt_count"];
  if (Object.keys(marker).some(field => !fields.includes(field)) || fields.some(field => !(field in marker))) {
    fail("CONTINUATION_INVALID", "continuation marker has an invalid shape");
  }
  return marker;
}

export function issueContinuation(rawState, { now, nonce = randomUUID() } = {}) {
  const state = validateState(rawState);
  if (state.status !== "running" || state.current_step === null) {
    fail("WORKFLOW_STATE", "continuations require a running incomplete workflow");
  }
  requireText(nonce, "nonce", "CONTINUATION_INVALID");
  const issuedAt = clockFrom(now).iso;
  return validateState({
    ...state,
    continuation: {
      workflow_id: state.workflow_id,
      step: state.current_step,
      nonce,
      issued_at: issuedAt,
      baseline_receipt_count: state.completed_steps.length
    }
  });
}

export function consumeContinuation(rawState, { marker } = {}) {
  const state = validateState(rawState);
  const candidate = markerFields(marker);
  if (state.continuation === null) {
    fail("CONTINUATION_REPLAY", "the continuation marker has already been consumed");
  }
  if (candidate.workflow_id !== state.workflow_id) {
    fail("CONTINUATION_WORKFLOW_MISMATCH", "continuation workflow does not match active workflow");
  }
  if (candidate.step !== state.current_step) {
    fail("CONTINUATION_STEP_MISMATCH", "continuation step does not match current step");
  }
  if (candidate.baseline_receipt_count !== state.completed_steps.length) {
    fail("CONTINUATION_COUNT_MISMATCH", "continuation receipt count is stale");
  }
  if (
    candidate.nonce !== state.continuation.nonce ||
    candidate.issued_at !== state.continuation.issued_at
  ) {
    fail("CONTINUATION_REPLAY", "continuation nonce is invalid or stale");
  }
  return validateState({ ...state, continuation: null });
}

async function assertNoInitConflict(workspaceRoot, paths) {
  const archiveRoot = join(workspaceRoot, "step_archive");
  const sharedPaths = [
    join(archiveRoot, "progress.json"),
    join(archiveRoot, "TOPIC", "TOPIC.md"),
    ...RECOGNIZED_OUTPUTS.map(name => join(archiveRoot, name))
  ];
  for (const path of sharedPaths) {
    if (await pathExists(path)) {
      fail("WORKFLOW_CONFLICT", "existing Harness50 work must be resumed or moved to another workspace", {
        path: assertInside(workspaceRoot, path)
      });
    }
  }
  const codexEntries = await readdir(paths.codexDir).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (codexEntries.some(name => ACTIVE_METADATA.has(name))) {
    fail("WORKFLOW_CONFLICT", "existing or incomplete Codex workflow metadata must not be overwritten");
  }
}

async function flushDirectory(directoryPath) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeTopicExclusive(workspaceRoot, topic) {
  const topicPath = assertInside(workspaceRoot, join(workspaceRoot, ...TOPIC_RELATIVE_PATH.split("/")));
  const topicDirectory = dirname(topicPath);
  await mkdir(topicDirectory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(topic.endsWith("\n") ? topic : `${topic}\n`, "utf8");
  const temporaryPath = join(topicDirectory, `.${basename(topicPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, topicPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("WORKFLOW_CONFLICT", "an existing topic must not be overwritten");
      }
      throw error;
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    await flushDirectory(topicDirectory);
    return {
      path: topicPath,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryExists) await unlink(temporaryPath).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function initWorkflow({
  workspaceRoot,
  topic,
  now = () => new Date(),
  idFactory = randomUUID
} = {}) {
  requireText(topic, "topic", "TOPIC_INVALID");
  requireFactory(idFactory);
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    await assertNoInitConflict(paths.workspaceRoot, paths);
    const workflowId = nextId(idFactory, "workflow ID");
    const nonce = nextId(idFactory, "continuation nonce");
    const createdTopic = await writeTopicExclusive(paths.workspaceRoot, topic);
    let state = createInitialState({
      workflowId,
      workspaceRoot: paths.workspaceRoot,
      topicSha256: createdTopic.sha256,
      now: clock.iso
    });
    state = issueContinuation(state, { now: clock.iso, nonce });
    try {
      state = await writeStateAtomic(paths.workspaceRoot, state);
    } catch (error) {
      if (await readState(paths.workspaceRoot).catch(() => null) === null) {
        await unlink(createdTopic.path).catch(() => {});
      }
      throw error;
    }
    await appendEvents(paths.workspaceRoot, [{
      kind: "continuation_issued",
      workflow_id: state.workflow_id,
      step: state.current_step,
      baseline_receipt_count: state.completed_steps.length
    }], clock);
    return state;
  });
}

export async function beginStep({
  workspaceRoot,
  step,
  sessionId = null,
  marker,
  now = () => new Date(),
  idFactory = randomUUID
} = {}) {
  requireStep(step);
  const requestedSession = normalizeSessionId(sessionId);
  requireFactory(idFactory);
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    let state = await requireState(paths.workspaceRoot);
    if (state.status !== "running") fail("WORKFLOW_STATE", "begin requires a running workflow");
    if (state.current_step !== step) {
      fail("STEP_MISMATCH", "begin step must match the current step", {
        expected_step: state.current_step,
        requested_step: step
      });
    }
    if (
      state.owner !== null &&
      state.current_attempt !== null &&
      !state.current_attempt.failure_recorded
    ) {
      assertOwner(state, { sessionId: requestedSession, now: clock.iso });
    }
    try {
      state = consumeContinuation(state, { marker });
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("CONTINUATION_")) {
        await appendRejectedContinuation(paths.workspaceRoot, state, error, clock);
      }
      throw error;
    }
    state = state.owner === null
      ? claimOwner(state, { sessionId: requestedSession, now: clock.iso })
      : assertOwner(state, { sessionId: requestedSession, now: clock.iso });
    const attemptId = nextId(idFactory, "attempt ID");
    const receipts = await readReceipts(paths.workspaceRoot);
    if (
      state.current_attempt?.id === attemptId ||
      receipts.some(receipt => receipt.attempt_id === attemptId)
    ) {
      fail("ATTEMPT_ID_REUSED", "attempt IDs must be unique within a workflow");
    }
    if (state.current_attempt !== null && !state.current_attempt.failure_recorded) {
      fail("ATTEMPT_ACTIVE", "the current step already has an active attempt");
    }
    state = renewOwner(state, { sessionId: requestedSession, now: clock.iso });
    const attempt = {
      id: attemptId,
      step,
      session_id: requestedSession,
      started_at: clock.iso,
      failure_recorded: false
    };
    state = validateState({
      ...state,
      current_attempt: attempt,
      updated_at: clock.iso
    });
    state = await writeStateAtomic(paths.workspaceRoot, state);
    await appendEvents(paths.workspaceRoot, [{
      kind: "continuation_consumed",
      workflow_id: state.workflow_id,
      step,
      attempt_id: attempt.id,
      ...(requestedSession === null ? {} : { session_id: requestedSession }),
      baseline_receipt_count: state.completed_steps.length
    }], clock);
    return { state, attempt: state.current_attempt };
  });
}

async function validatePluginRoot(pluginRoot) {
  if (typeof pluginRoot !== "string" || pluginRoot.trim() === "") {
    fail("PLUGIN_ROOT_INVALID", "pluginRoot must be a non-empty directory path");
  }
  try {
    const canonicalRoot = await realpath(resolve(pluginRoot));
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
    const indexPath = assertInside(canonicalRoot, join(canonicalRoot, "codex", "assets", "steps", "index.json"));
    const canonicalIndexPath = await realpath(indexPath);
    assertInside(canonicalRoot, canonicalIndexPath);
    if (!(await stat(canonicalIndexPath)).isFile()) throw new Error("missing step index");
    return canonicalRoot;
  } catch (error) {
    fail("PLUGIN_ROOT_INVALID", "pluginRoot must resolve to an installed Harness50 package root", {
      cause_code: typeof error?.code === "string" ? error.code : "INVALID"
    });
  }
}

function receiptForCompletion(state, {
  step,
  attemptId,
  summary,
  evidence,
  completedAt
}) {
  return parseReceipt({
    schema_version: 1,
    workflow_id: state.workflow_id,
    step,
    attempt_id: attemptId,
    provenance: "codex-verified",
    completed_at: completedAt,
    summary,
    evidence
  });
}

function sameCompletion(existing, expected) {
  return existing.workflow_id === expected.workflow_id &&
    existing.step === expected.step &&
    existing.attempt_id === expected.attempt_id &&
    existing.provenance === "codex-verified" &&
    existing.summary === expected.summary &&
    sameJson(existing.evidence, expected.evidence);
}

function assertAttempt(state, step, attemptId) {
  if (state.current_step !== step) {
    fail("STEP_MISMATCH", "operation step must match the current step", {
      expected_step: state.current_step,
      requested_step: step
    });
  }
  if (state.current_attempt === null || state.current_attempt.id !== attemptId) {
    fail("ATTEMPT_STALE", "attempt is not the active attempt for this step");
  }
  if (state.current_attempt.step !== step) {
    fail("ATTEMPT_STALE", "attempt step does not match the active step");
  }
  return state.current_attempt;
}

function renewAttemptOwner(state, attempt, clock) {
  return renewOwner(state, { sessionId: attempt.session_id, now: clock.iso });
}

export async function completeStep({
  workspaceRoot,
  pluginRoot,
  step,
  attemptId,
  summary,
  evidence,
  now = () => new Date(),
  hooks = {},
  stateWriter = writeStateAtomic,
  receiptWriter = writeReceiptExclusive
} = {}) {
  requireStep(step);
  requireText(attemptId, "attemptId", "ATTEMPT_INVALID");
  requireText(summary, "summary", "RECEIPT_INVALID");
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    fail("WORKFLOW_OPTIONS_INVALID", "hooks must be an object");
  }
  for (const hook of Object.values(hooks)) {
    if (typeof hook !== "function") fail("WORKFLOW_OPTIONS_INVALID", "workflow hooks must be functions");
  }
  if (typeof stateWriter !== "function" || typeof receiptWriter !== "function") {
    fail("WORKFLOW_OPTIONS_INVALID", "stateWriter and receiptWriter must be functions");
  }
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    await validatePluginRoot(pluginRoot);
    const sanitizedEvidence = sanitizeEvidence(evidence);
    let state = await requireState(paths.workspaceRoot);
    const receipts = await readReceipts(paths.workspaceRoot);
    const existing = receipts.find(receipt => receipt.step === step);
    const semanticReceipt = receiptForCompletion(state, {
      step,
      attemptId,
      summary,
      evidence: sanitizedEvidence,
      completedAt: existing?.completed_at ?? clock.iso
    });

    if (state.completed_steps.includes(step)) {
      if (existing && sameCompletion(existing, semanticReceipt)) return state;
      fail("RECEIPT_CONFLICT", "completed step has different immutable receipt content", { step });
    }
    if (state.status !== "running") fail("WORKFLOW_STATE", "complete requires a running workflow");
    const attempt = assertAttempt(state, step, attemptId);
    if (attempt.failure_recorded) fail("ATTEMPT_STALE", "a failed attempt cannot complete");
    state = renewAttemptOwner(state, attempt, clock);

    let receipt;
    if (existing) {
      if (!sameCompletion(existing, semanticReceipt)) {
        fail("RECEIPT_CONFLICT", "a different receipt already exists for this step", { step });
      }
      receipt = existing;
    } else {
      receipt = await receiptWriter(paths.workspaceRoot, semanticReceipt);
    }
    await hooks.afterReceipt?.({ receipt, state });

    const completedSteps = [...state.completed_steps, step];
    const completed = step === STEP_COUNT;
    state = validateState({
      ...state,
      status: completed ? "completed" : "running",
      current_step: completed ? null : step + 1,
      completed_steps: completedSteps,
      current_attempt: null,
      consecutive_failures: 0,
      blocked_reason: null,
      continuation: null,
      updated_at: clock.iso,
      completed_at: completed ? receipt.completed_at : null
    });
    if (!completed) state = issueContinuation(state, { now: clock.iso });
    await hooks.beforeStateWrite?.({ state, receipt });
    state = await stateWriter(paths.workspaceRoot, state);
    await hooks.afterStateWrite?.({ state, receipt });
    const events = [{
      kind: "step_completed",
      workflow_id: state.workflow_id,
      step,
      attempt_id: attemptId,
      completed_count: state.completed_steps.length
    }];
    if (!completed) {
      events.push({
        kind: "continuation_issued",
        workflow_id: state.workflow_id,
        step: state.current_step,
        baseline_receipt_count: state.completed_steps.length
      });
    }
    await appendEvents(paths.workspaceRoot, events, clock);
    return state;
  });
}

export async function failStep({
  workspaceRoot,
  step,
  attemptId,
  reason,
  evidence,
  now = () => new Date()
} = {}) {
  requireStep(step);
  requireText(attemptId, "attemptId", "ATTEMPT_INVALID");
  requireText(reason, "reason", "FAILURE_INVALID");
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    sanitizeEvidence(evidence);
    let state = await requireState(paths.workspaceRoot);
    if (state.status !== "running") fail("WORKFLOW_STATE", "fail requires a running workflow");
    const attempt = assertAttempt(state, step, attemptId);
    if (attempt.failure_recorded) {
      fail("ATTEMPT_ALREADY_FAILED", "failure was already recorded for this attempt");
    }
    state = renewAttemptOwner(state, attempt, clock);
    const failureCount = state.consecutive_failures + 1;
    const blocked = failureCount >= 3;
    state = validateState({
      ...state,
      status: blocked ? "blocked" : "running",
      current_attempt: { ...attempt, failure_recorded: true },
      consecutive_failures: failureCount,
      blocked_reason: blocked ? "THREE_CONSECUTIVE_FAILURES" : null,
      continuation: null,
      updated_at: clock.iso
    });
    if (!blocked) state = issueContinuation(state, { now: clock.iso });
    state = await writeStateAtomic(paths.workspaceRoot, state);
    const events = [{
      kind: "step_failed",
      workflow_id: state.workflow_id,
      step,
      attempt_id: attemptId,
      failure_count: failureCount,
      consecutive_failures: failureCount
    }];
    if (blocked) {
      events.push({
        kind: "workflow_blocked",
        workflow_id: state.workflow_id,
        step,
        status: "blocked",
        reason_code: "THREE_CONSECUTIVE_FAILURES",
        consecutive_failures: failureCount
      });
    } else {
      events.push({
        kind: "continuation_issued",
        workflow_id: state.workflow_id,
        step,
        baseline_receipt_count: state.completed_steps.length
      });
    }
    await appendEvents(paths.workspaceRoot, events, clock);
    return state;
  });
}

export async function pauseWorkflow({
  workspaceRoot,
  reason,
  now = () => new Date()
} = {}) {
  requireText(reason, "reason", "PAUSE_INVALID");
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    let state = await requireState(paths.workspaceRoot);
    if (state.status === "paused") return state;
    if (state.status !== "running") fail("WORKFLOW_STATE", "only a running workflow can be paused");
    state = validateState({
      ...state,
      status: "paused",
      continuation: null,
      updated_at: clock.iso
    });
    state = await writeStateAtomic(paths.workspaceRoot, state);
    await appendEvents(paths.workspaceRoot, [{
      kind: "workflow_paused",
      workflow_id: state.workflow_id,
      step: state.current_step,
      status: "paused",
      reason_code: "USER_REQUEST"
    }], clock);
    return state;
  });
}

export async function resumeWorkflow({
  workspaceRoot,
  sessionId = null,
  now = () => new Date(),
  idFactory = randomUUID
} = {}) {
  const requestedSession = normalizeSessionId(sessionId);
  requireFactory(idFactory);
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    let state = await requireState(paths.workspaceRoot);
    if (state.status === "completed") fail("WORKFLOW_STATE", "a completed workflow cannot resume");
    const nonce = nextId(idFactory, "continuation nonce");
    state = validateState({
      ...state,
      status: "running",
      blocked_reason: null,
      consecutive_failures: 0,
      completed_at: null,
      updated_at: clock.iso
    });
    state = transferOwner(state, {
      sessionId: requestedSession,
      now: clock.iso,
      nonce
    });
    state = await writeStateAtomic(paths.workspaceRoot, state);
    await appendEvents(paths.workspaceRoot, [
      {
        kind: "workflow_resumed",
        workflow_id: state.workflow_id,
        step: state.current_step,
        status: "running",
        ...(requestedSession === null ? {} : { session_id: requestedSession })
      },
      {
        kind: "continuation_issued",
        workflow_id: state.workflow_id,
        step: state.current_step,
        baseline_receipt_count: state.completed_steps.length
      }
    ], clock);
    return state;
  });
}

function blockForReceiptError(state, code) {
  const completedSteps = state.status === "completed"
    ? state.completed_steps.slice(0, STEP_COUNT - 1)
    : state.completed_steps;
  const importedFrom = state.imported_from === null
    ? null
    : { ...state.imported_from, prefix_length: Math.min(state.imported_from.prefix_length, completedSteps.length) };
  return validateState({
    ...state,
    status: "blocked",
    current_step: completedSteps.length + 1,
    completed_steps: completedSteps,
    current_attempt: null,
    continuation: null,
    blocked_reason: code,
    imported_from: importedFrom,
    completed_at: null
  });
}

export async function reconcileWorkflow({
  workspaceRoot,
  now = () => new Date()
} = {}) {
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    const before = await requireState(paths.workspaceRoot);
    let result;
    try {
      result = reconcileReceipts(before, await readReceipts(paths.workspaceRoot));
    } catch (error) {
      if (typeof error?.code !== "string" || !error.code.startsWith("RECEIPT_")) throw error;
      result = {
        state: blockForReceiptError(before, error.code),
        diagnostics: [{ code: error.code }]
      };
    }
    let state = result.state;
    const changed = !sameJson(state, before);
    if (changed) {
      state = validateState({ ...state, updated_at: clock.iso });
      state = await writeStateAtomic(paths.workspaceRoot, state);
      if (state.status === "blocked") {
        await appendEvents(paths.workspaceRoot, [{
          kind: "workflow_blocked",
          workflow_id: state.workflow_id,
          step: state.current_step,
          status: "blocked",
          reason_code: state.blocked_reason
        }], clock);
      }
    }
    return state;
  });
}

function validateImportError(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("IMPORT_ERROR_INVALID", "import-error.json must contain an object");
  }
  if (Object.keys(value).some(field => !IMPORT_ERROR_FIELDS.has(field))) {
    fail("IMPORT_ERROR_INVALID", "import-error.json contains an unknown field");
  }
  if (
    value.schema_version !== 1 ||
    typeof value.code !== "string" || value.code === "" ||
    typeof value.source_preserved !== "boolean" ||
    typeof value.action !== "string" || value.action === ""
  ) {
    fail("IMPORT_ERROR_INVALID", "import-error.json is malformed");
  }
  return {
    code: value.code,
    source_preserved: value.source_preserved,
    action: value.action
  };
}

async function readImportError(path) {
  try {
    return validateImportError(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof HarnessError) throw error;
    fail("IMPORT_ERROR_INVALID", "import-error.json is not valid JSON");
  }
}

export async function showWorkflow({ workspaceRoot } = {}) {
  const paths = pathsFor(workspaceRoot);
  const state = await readState(paths.workspaceRoot);
  const claudeProgressFound = await pathExists(join(paths.workspaceRoot, "step_archive", "progress.json"));
  if (state === null) {
    const result = {
      active: false,
      claude_progress_found: claudeProgressFound
    };
    const importError = await readImportError(paths.importErrorPath);
    if (importError !== null) result.import_error = importError;
    return result;
  }

  validateState(state);
  const receipts = await readReceipts(paths.workspaceRoot);
  const reconciliation = reconcileReceipts(state, receipts);
  const matching = receipts.filter(receipt => receipt.workflow_id === state.workflow_id);
  const imported = matching.filter(receipt => receipt.provenance === "claude-progress-import").length;
  const codexVerified = matching.filter(receipt => receipt.provenance === "codex-verified").length;
  return {
    active: true,
    claude_progress_found: claudeProgressFound,
    workflow_id: state.workflow_id,
    status: state.status,
    total_steps: state.total_steps,
    current_step: state.current_step,
    completed_count: state.completed_steps.length,
    topic_path: state.topic_path,
    owner: state.owner,
    continuation_available: state.continuation !== null,
    imported_from: state.imported_from,
    completions: {
      imported,
      codex_verified: codexVerified,
      total: imported + codexVerified
    },
    diagnostics: reconciliation.diagnostics
  };
}

export async function resetWorkflow({
  workspaceRoot,
  now = () => new Date()
} = {}) {
  return withMutation(workspaceRoot, now, async (paths, clock) => {
    const entries = await readdir(paths.codexDir).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (!entries.some(name => ACTIVE_METADATA.has(name))) {
      fail("WORKFLOW_NOT_FOUND", "no Codex workflow metadata exists to reset");
    }
    const backupPath = await archiveActiveState(paths.workspaceRoot, {
      reason: "manual-reset",
      now: clock.now
    });
    return { backupPath };
  });
}

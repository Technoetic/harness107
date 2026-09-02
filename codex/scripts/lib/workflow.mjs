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
  ownerLeaseExpired,
  renewOwner,
  transferOwner
} from "./ownership.mjs";
import { assertInside, pathsFor } from "./paths.mjs";
import {
  parseReceipt,
  readReceipts,
  receiptPath,
  reconcileReceipts,
  sanitizeEvidence,
  syncDirectoryDurable,
  writeReceiptExclusive
} from "./receipts.mjs";
import { createInitialState, validateState } from "./schema.mjs";
import {
  appendEvent,
  archiveActiveState,
  prepareEventBatch,
  readState,
  withPinnedEventBatch,
  writeStateAtomic
} from "./state-store.mjs";

const STEP_COUNT = 50;
const TOPIC_RELATIVE_PATH = "step_archive/TOPIC/TOPIC.md";
const IMPORT_RECOVERY_ACTION = "repair the Claude state or use a separate workspace";
const SAFE_IMPORT_ERROR_CODES = new Set([
  "CLAUDE_COMPLETED_STEPS",
  "CLAUDE_IMPORT_FAILED",
  "CLAUDE_PROGRESS_INVALID",
  "CLAUDE_PROGRESS_JSON",
  "CLAUDE_PROGRESS_MISSING",
  "CLAUDE_SOURCE_CHANGED",
  "CLAUDE_STEP_RANGE",
  "CLAUDE_STEP_VALUE",
  "CLAUDE_TOPIC_MISSING",
  "CLAUDE_TOTAL_STEPS",
  "CODEX_STEP_DEFINITIONS"
]);
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
const RECEIPT_VALIDATION_CODES = new Set([
  "EVIDENCE_INVALID",
  "RECEIPT_CONFLICT",
  "RECEIPT_INVALID",
  "RECEIPT_PARSE_ERROR",
  "RECEIPT_PATH_MISMATCH",
  "SENSITIVE_EVIDENCE"
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

function samePath(left, right) {
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertPhysicalComponents(workspaceRoot, candidates) {
  const lexicalRoot = resolve(workspaceRoot);
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = await lstat(lexicalRoot, { bigint: true });
    canonicalRoot = await realpath(lexicalRoot);
  } catch (error) {
    fail("WORKSPACE_PATH_UNSAFE", "workspace root must be a physical directory", {
      cause_code: typeof error?.code === "string" ? error.code : "INVALID"
    });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !samePath(lexicalRoot, canonicalRoot)) {
    fail("WORKSPACE_PATH_UNSAFE", "workspace root cannot be a link or redirected path");
  }
  for (const candidate of candidates) {
    const contained = assertInside(lexicalRoot, candidate);
    const relativeParts = contained.slice(lexicalRoot.length).split(/[\\/]+/).filter(Boolean);
    let current = lexicalRoot;
    for (const part of relativeParts) {
      current = join(current, part);
      let before;
      try {
        before = await lstat(current, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
      if (before.isSymbolicLink()) {
        fail("WORKSPACE_PATH_UNSAFE", "workspace path cannot traverse a link or reparse point");
      }
      const canonical = await realpath(current);
      const after = await lstat(current, { bigint: true });
      if (!sameNode(before, after) || !samePath(current, canonical)) {
        fail("WORKSPACE_PATH_UNSAFE", "workspace path changed or redirected during validation");
      }
    }
  }
  return { lexicalRoot, rootStat };
}

async function assertPhysicalDirectory(workspaceRoot, directoryPath) {
  await assertPhysicalComponents(workspaceRoot, [directoryPath]);
  let value;
  try {
    value = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (value.isSymbolicLink() || !value.isDirectory()) {
    fail("WORKSPACE_PATH_UNSAFE", "workflow directory must be a physical directory");
  }
  return value;
}

function assertMonotonicClock(state, clock) {
  const current = clock.date.getTime();
  const timestamps = [
    state.created_at,
    state.updated_at,
    state.completed_at,
    state.owner?.lease_updated_at,
    state.current_attempt?.started_at,
    state.continuation?.issued_at
  ].filter(value => value !== null && value !== undefined);
  if (timestamps.some(value => current < Date.parse(value))) {
    fail("CLOCK_REGRESSION", "workflow mutation time cannot precede persisted state time");
  }
  return state;
}

function assertReceiptClock(receipts, clock) {
  if (receipts.some(receipt => clock.date.getTime() < Date.parse(receipt.completed_at))) {
    fail("CLOCK_REGRESSION", "workflow mutation time cannot precede a durable receipt");
  }
  return receipts;
}

function generationId(kind, rawId, state, extra = {}) {
  const generation = {
    kind,
    raw_id: rawId,
    workflow_id: state.workflow_id,
    step: state.current_step,
    completed_count: state.completed_steps.length,
    updated_at: state.updated_at,
    continuation: state.continuation,
    current_attempt: state.current_attempt,
    owner: state.owner,
    ...extra
  };
  return `${kind}-${createHash("sha256").update(JSON.stringify(generation)).digest("hex")}`;
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
  await assertPhysicalComponents(paths.workspaceRoot, [
    join(paths.workspaceRoot, "step_archive"),
    paths.codexDir,
    paths.lockPath
  ]);
  return withRunLock(paths.lockPath, async () => {
    const guard = await captureMutationGuard(paths);
    try {
      const result = await callback(paths, clock, guard);
      await assertMutationGuard(guard);
      return result;
    } catch (error) {
      await assertMutationGuard(guard);
      throw error;
    }
  }, { now: clock.now });
}

function mutationControlPaths(paths) {
  return [
    join(paths.workspaceRoot, "step_archive"),
    join(paths.workspaceRoot, "step_archive", "TOPIC"),
    join(paths.workspaceRoot, ...TOPIC_RELATIVE_PATH.split("/")),
    paths.codexDir,
    paths.lockPath,
    paths.statePath,
    paths.receiptsDir,
    paths.eventsPath,
    paths.backupsDir,
    paths.importsDir,
    paths.importErrorPath
  ];
}

function finalControlFiles(paths) {
  return [
    join(paths.workspaceRoot, ...TOPIC_RELATIVE_PATH.split("/")),
    paths.statePath,
    paths.eventsPath,
    paths.importErrorPath
  ];
}

async function assertUnaliasedControlFiles(paths) {
  for (const path of finalControlFiles(paths)) {
    let value;
    try {
      value = await lstat(path, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (value.isSymbolicLink() || !value.isFile() || value.nlink !== 1n) {
      fail("WORKSPACE_PATH_UNSAFE", "workflow control files must be unaliased regular files");
    }
  }
}

async function captureMutationGuard(paths) {
  const stablePaths = [
    paths.workspaceRoot,
    join(paths.workspaceRoot, "step_archive"),
    paths.codexDir,
    paths.lockPath
  ];
  await assertPhysicalComponents(paths.workspaceRoot, mutationControlPaths(paths));
  const identities = new Map();
  for (const path of stablePaths) {
    const value = await lstat(path, { bigint: true });
    identities.set(path, value);
  }
  return { paths, identities };
}

async function assertMutationGuard(guard, extraPaths = []) {
  const { paths, identities } = guard;
  await assertPhysicalComponents(paths.workspaceRoot, [
    ...mutationControlPaths(paths),
    ...extraPaths
  ]);
  await assertUnaliasedControlFiles(paths);
  for (const [path, expected] of identities) {
    let current;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      fail("WORKSPACE_PATH_UNSAFE", "workflow storage changed during a locked mutation", {
        cause_code: typeof error?.code === "string" ? error.code : "INVALID"
      });
    }
    if (current.isSymbolicLink() || !sameNode(expected, current)) {
      fail("WORKSPACE_PATH_UNSAFE", "workflow storage changed during a locked mutation");
    }
  }
}

async function guardedOperation(guard, paths, operation) {
  await assertMutationGuard(guard, paths);
  try {
    const result = await operation();
    await assertMutationGuard(guard, paths);
    return result;
  } catch (error) {
    await assertMutationGuard(guard, paths);
    throw error;
  }
}

async function guardedId(idFactory, label, guard) {
  const value = nextId(idFactory, label);
  await assertMutationGuard(guard);
  return value;
}

function frozenEvidence(evidence) {
  const sanitized = sanitizeEvidence(evidence);
  for (const item of sanitized) Object.freeze(item);
  return Object.freeze(sanitized);
}

async function requireState(workspaceRoot, guard) {
  const state = await guardedOperation(
    guard,
    [pathsFor(workspaceRoot).statePath],
    () => readState(workspaceRoot)
  );
  if (state === null) fail("WORKFLOW_NOT_FOUND", "no active Codex workflow exists");
  return validateState(state);
}

async function guardedReadReceipts(workspaceRoot, guard) {
  return guardedOperation(
    guard,
    [pathsFor(workspaceRoot).receiptsDir],
    () => readReceipts(workspaceRoot)
  );
}

async function guardedWriteState(workspaceRoot, state, guard) {
  return guardedOperation(
    guard,
    [pathsFor(workspaceRoot).statePath],
    () => writeStateAtomic(workspaceRoot, state)
  );
}

async function guardedWriteReceipt(workspaceRoot, receipt, guard) {
  return guardedOperation(
    guard,
    [pathsFor(workspaceRoot).receiptsDir, receiptPath(workspaceRoot, receipt.step)],
    () => writeReceiptExclusive(workspaceRoot, receipt)
  );
}

async function appendEvents(workspaceRoot, events, clock, guard) {
  for (const event of events) {
    await guardedOperation(
      guard,
      [pathsFor(workspaceRoot).eventsPath],
      () => appendEvent(workspaceRoot, { ...event, timestamp: clock.iso }, { now: clock.now })
    );
  }
}

async function appendRejectedContinuation(workspaceRoot, state, error, clock, guard) {
  try {
    await appendEvents(workspaceRoot, [{
      kind: "continuation_replay_rejected",
      workflow_id: state.workflow_id,
      step: state.current_step,
      error_code: error.code
    }], clock, guard);
  } catch (appendError) {
    if (appendError?.code === "WORKSPACE_PATH_UNSAFE") throw appendError;
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

export function issueContinuation(rawState, {
  now,
  nonce = randomUUID(),
  generationId = randomUUID(),
  allowActiveStop = true
} = {}) {
  const clock = clockFrom(now);
  const state = assertMonotonicClock(validateState(rawState), clock);
  if (state.status !== "running" || state.current_step === null) {
    fail("WORKFLOW_STATE", "continuations require a running incomplete workflow");
  }
  requireText(nonce, "nonce", "CONTINUATION_INVALID");
  requireText(generationId, "generationId", "CONTINUATION_INVALID");
  if (typeof allowActiveStop !== "boolean") {
    fail("CONTINUATION_INVALID", "allowActiveStop must be boolean");
  }
  const issuedAt = clock.iso;
  return validateState({
    ...state,
    continuation: {
      workflow_id: state.workflow_id,
      step: state.current_step,
      nonce,
      issued_at: issuedAt,
      baseline_receipt_count: state.completed_steps.length
    },
    stop_delivery: {
      generation_id: generationId,
      requested_turn_id: null,
      accepted: false,
      allow_active_stop: allowActiveStop
    },
    last_stop_turn_id: null
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
  return validateState({
    ...state,
    continuation: null,
    stop_delivery: state.current_attempt === null ? null : state.stop_delivery
  });
}

async function assertNoInitConflict(workspaceRoot, paths) {
  const archiveRoot = join(workspaceRoot, "step_archive");
  await assertPhysicalComponents(workspaceRoot, [
    archiveRoot,
    join(archiveRoot, "TOPIC"),
    join(archiveRoot, "TOPIC", "TOPIC.md"),
    paths.codexDir
  ]);
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

async function ensureDurableDirectory(workspaceRoot, directoryPath) {
  const parentPath = dirname(directoryPath);
  await assertPhysicalComponents(workspaceRoot, [parentPath, directoryPath]);
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const directory = await assertPhysicalDirectory(workspaceRoot, directoryPath);
  if (directory === null) fail("WORKSPACE_PATH_UNSAFE", "durable directory disappeared after creation");
  await syncDirectoryDurable(directoryPath);
  await syncDirectoryDurable(parentPath);
  return directory;
}

async function writeTopicExclusive(workspaceRoot, topic) {
  const topicPath = assertInside(workspaceRoot, join(workspaceRoot, ...TOPIC_RELATIVE_PATH.split("/")));
  const topicDirectory = dirname(topicPath);
  const archiveRoot = dirname(topicDirectory);
  await ensureDurableDirectory(workspaceRoot, archiveRoot);
  const topicDirectoryIdentity = await ensureDurableDirectory(workspaceRoot, topicDirectory);
  await assertPhysicalComponents(workspaceRoot, [topicDirectory, topicPath]);
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
    const prePublishDirectory = await assertPhysicalDirectory(workspaceRoot, topicDirectory);
    if (prePublishDirectory === null || !sameNode(topicDirectoryIdentity, prePublishDirectory)) {
      fail("WORKSPACE_PATH_UNSAFE", "topic directory changed before publication");
    }
    const temporaryStat = await lstat(temporaryPath, { bigint: true });
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
      fail("WORKSPACE_PATH_UNSAFE", "topic temporary must remain a physical file");
    }
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
    const currentTopicDirectory = await assertPhysicalDirectory(workspaceRoot, topicDirectory);
    if (currentTopicDirectory === null || !sameNode(topicDirectoryIdentity, currentTopicDirectory)) {
      fail("WORKSPACE_PATH_UNSAFE", "topic directory changed during publication");
    }
    const topicStat = await lstat(topicPath, { bigint: true });
    if (topicStat.isSymbolicLink() || !topicStat.isFile()) {
      fail("WORKSPACE_PATH_UNSAFE", "published topic must be a physical file");
    }
    await syncDirectoryDurable(topicDirectory);
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
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    await guardedOperation(
      guard,
      [join(paths.workspaceRoot, "step_archive"), paths.codexDir],
      () => assertNoInitConflict(paths.workspaceRoot, paths)
    );
    const workflowId = await guardedId(idFactory, "workflow ID", guard);
    const nonce = await guardedId(idFactory, "continuation nonce", guard);
    const generationId = await guardedId(idFactory, "stop delivery generation ID", guard);
    const topicPath = join(paths.workspaceRoot, ...TOPIC_RELATIVE_PATH.split("/"));
    const createdTopic = await guardedOperation(
      guard,
      [topicPath],
      () => writeTopicExclusive(paths.workspaceRoot, topic)
    );
    let state = createInitialState({
      workflowId,
      workspaceRoot: paths.workspaceRoot,
      topicSha256: createdTopic.sha256,
      now: clock.iso
    });
    state = issueContinuation(state, {
      now: clock.iso,
      nonce,
      generationId,
      allowActiveStop: false
    });
    try {
      state = await guardedWriteState(paths.workspaceRoot, state, guard);
    } catch (error) {
      if (await guardedOperation(
        guard,
        [paths.statePath],
        () => readState(paths.workspaceRoot)
      ).catch(readError => {
        if (readError?.code === "WORKSPACE_PATH_UNSAFE") throw readError;
        return null;
      }) === null) {
        await guardedOperation(guard, [createdTopic.path], async () => {
          await unlink(createdTopic.path).catch(unlinkError => {
            if (unlinkError?.code !== "ENOENT") throw unlinkError;
          });
        });
      }
      throw error;
    }
    await appendEvents(paths.workspaceRoot, [{
      kind: "continuation_issued",
      workflow_id: state.workflow_id,
      step: state.current_step,
      generation_id: state.stop_delivery.generation_id,
      baseline_receipt_count: state.completed_steps.length
    }], clock, guard);
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
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    let state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
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
    const continuationGeneration = state.continuation;
    const stopDeliveryGeneration = state.stop_delivery;
    try {
      state = consumeContinuation(state, { marker });
      await assertMutationGuard(guard);
    } catch (error) {
      await assertMutationGuard(guard);
      if (typeof error?.code === "string" && error.code.startsWith("CONTINUATION_")) {
        await appendRejectedContinuation(paths.workspaceRoot, state, error, clock, guard);
      }
      throw error;
    }
    state = state.owner === null
      ? claimOwner(state, { sessionId: requestedSession, now: clock.iso })
      : assertOwner(state, { sessionId: requestedSession, now: clock.iso });
    const rawAttemptId = await guardedId(idFactory, "attempt ID", guard);
    const attemptId = generationId("attempt", rawAttemptId, state, {
      continuation_generation: continuationGeneration
    });
    const receipts = await guardedReadReceipts(paths.workspaceRoot, guard);
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
      stop_delivery: stopDeliveryGeneration,
      updated_at: clock.iso
    });
    state = await guardedWriteState(paths.workspaceRoot, state, guard);
    await appendEvents(paths.workspaceRoot, [{
      kind: "continuation_consumed",
      workflow_id: state.workflow_id,
      step,
      attempt_id: attempt.id,
      generation_id: stopDeliveryGeneration.generation_id,
      ...(requestedSession === null ? {} : { session_id: requestedSession }),
      baseline_receipt_count: state.completed_steps.length
    }], clock, guard);
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
  now = () => new Date()
} = {}) {
  requireStep(step);
  requireText(attemptId, "attemptId", "ATTEMPT_INVALID");
  requireText(summary, "summary", "RECEIPT_INVALID");
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    await validatePluginRoot(pluginRoot);
    await assertMutationGuard(guard);
    const sanitizedEvidence = frozenEvidence(evidence);
    await assertMutationGuard(guard);
    let state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    const receipts = await guardedReadReceipts(paths.workspaceRoot, guard);
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

    let receipt;
    if (existing) {
      if (!sameCompletion(existing, semanticReceipt)) {
        fail("RECEIPT_CONFLICT", "a different receipt already exists for this step", { step });
      }
      if (clock.date.getTime() < Date.parse(existing.completed_at)) {
        fail("CLOCK_REGRESSION", "recovery time cannot precede the durable receipt");
      }
      if (state.owner !== null) {
        if (state.owner.session_id !== attempt.session_id) {
          fail("OWNER_CONFLICT", "durable receipt attempt does not belong to the current owner");
        }
        state = ownerLeaseExpired(state.owner, clock.iso)
          ? validateState({ ...state, owner: null })
          : renewAttemptOwner(state, attempt, clock);
      }
      receipt = existing;
    } else {
      state = renewAttemptOwner(state, attempt, clock);
      receipt = await guardedWriteReceipt(paths.workspaceRoot, semanticReceipt, guard);
    }

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
      stop_delivery: null,
      updated_at: clock.iso,
      completed_at: completed ? receipt.completed_at : null
    });
    if (!completed) state = issueContinuation(state, { now: clock.iso, allowActiveStop: true });
    state = await guardedWriteState(paths.workspaceRoot, state, guard);
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
        generation_id: state.stop_delivery.generation_id,
        baseline_receipt_count: state.completed_steps.length
      });
    }
    await appendEvents(paths.workspaceRoot, events, clock, guard);
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
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    frozenEvidence(evidence);
    await assertMutationGuard(guard);
    let state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
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
      stop_delivery: blocked ? null : state.stop_delivery,
      updated_at: clock.iso
    });
    if (!blocked) state = issueContinuation(state, { now: clock.iso, allowActiveStop: true });
    state = await guardedWriteState(paths.workspaceRoot, state, guard);
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
        generation_id: state.stop_delivery.generation_id,
        baseline_receipt_count: state.completed_steps.length
      });
    }
    await appendEvents(paths.workspaceRoot, events, clock, guard);
    return state;
  });
}

export async function pauseWorkflow({
  workspaceRoot,
  reason,
  now = () => new Date()
} = {}) {
  requireText(reason, "reason", "PAUSE_INVALID");
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    let state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    if (state.status === "paused") return state;
    if (state.status !== "running") fail("WORKFLOW_STATE", "only a running workflow can be paused");
    if (state.owner !== null) {
      state = renewOwner(state, {
        sessionId: state.owner.session_id,
        now: clock.iso
      });
    }
    state = validateState({
      ...state,
      status: "paused",
      continuation: null,
      stop_delivery: null,
      updated_at: clock.iso
    });
    state = await guardedWriteState(paths.workspaceRoot, state, guard);
    await appendEvents(paths.workspaceRoot, [{
      kind: "workflow_paused",
      workflow_id: state.workflow_id,
      step: state.current_step,
      status: "paused",
      reason_code: "USER_REQUEST"
    }], clock, guard);
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
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    let state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    if (state.status === "completed") fail("WORKFLOW_STATE", "a completed workflow cannot resume");
    const nonce = await guardedId(idFactory, "continuation nonce", guard);
    const generationId = await guardedId(idFactory, "stop delivery generation ID", guard);
    state = validateState({
      ...state,
      status: "running",
      current_attempt: null,
      stop_delivery: null,
      blocked_reason: null,
      consecutive_failures: 0,
      completed_at: null,
      updated_at: clock.iso
    });
    state = transferOwner(state, {
      sessionId: requestedSession,
      now: clock.iso,
      nonce,
      generationId
    });
    state = await guardedWriteState(paths.workspaceRoot, state, guard);
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
        generation_id: state.stop_delivery.generation_id,
        baseline_receipt_count: state.completed_steps.length
      }
    ], clock, guard);
    return state;
  });
}

function receiptValidationError(error) {
  return typeof error?.code === "string" && RECEIPT_VALIDATION_CODES.has(error.code);
}

async function reconcileUnderGuard(paths, clock, guard, before, idFactory) {
  let result;
  try {
    const receipts = assertReceiptClock(
      await guardedReadReceipts(paths.workspaceRoot, guard),
      clock
    );
    const authority = authoritativeReceiptPrefix(before, receipts);
    if (authority.code !== null) {
      result = {
        state: blockForReceiptError(before, authority.code, authority.prefix, {
          preserveAttempt: authority.preserveAttempt
        }),
        diagnostics: [{ code: authority.code }]
      };
    } else {
      result = reconcileReceipts(before, receipts);
    }
  } catch (error) {
    if (!receiptValidationError(error)) throw error;
    const prefixReceipts = await trustedReceiptPrefix(paths.workspaceRoot, before, guard);
    assertReceiptClock(prefixReceipts, clock);
    result = {
      state: blockForReceiptError(before, error.code, prefixReceipts),
      diagnostics: [{ code: error.code }]
    };
  }
  let state = result.state;
  if (state.owner !== null && ownerLeaseExpired(state.owner, clock.iso)) {
    state = validateState({ ...state, owner: null });
  }
  const recoveredForward = state.completed_steps.length > before.completed_steps.length;
  if (
    recoveredForward &&
    state.status === "running" &&
    state.current_step !== null &&
    state.continuation === null
  ) {
    const nonce = await guardedId(idFactory, "continuation nonce", guard);
    const generationId = await guardedId(idFactory, "stop delivery generation ID", guard);
    state = issueContinuation(state, {
      now: clock.iso,
      nonce,
      generationId,
      allowActiveStop: true
    });
  }
  const changed = !sameJson(state, before);
  if (changed) state = validateState({ ...state, updated_at: clock.iso });
  return { state, changed, recoveredForward, diagnostics: result.diagnostics };
}

function stopRequestEvent(state, turnId) {
  return {
    kind: "stop_continuation_requested",
    workflow_id: state.workflow_id,
    step: state.current_step,
    turn_id: turnId,
    generation_id: state.stop_delivery.generation_id,
    baseline_receipt_count: state.completed_steps.length
  };
}

async function commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions = {}) {
  const changed = !sameJson(before, state);
  if (events.length === 0) {
    return changed ? guardedWriteState(paths.workspaceRoot, state, guard) : state;
  }
  const prepared = prepareEventBatch(events, { now: clock.now });
  let stateCommitted = false;
  try {
    return await withPinnedEventBatch(paths.workspaceRoot, prepared, async () => {
      if (!changed) return state;
      const written = await guardedWriteState(paths.workspaceRoot, state, guard);
      stateCommitted = true;
      return written;
    }, eventBatchOptions);
  } catch (error) {
    if (!stateCommitted) throw error;
    if (error?.code === "WORKSPACE_PATH_UNSAFE" || error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
    // State is the control authority. Telemetry projection may be repaired or omitted.
    return state;
  }
}

export async function acceptStopDelivery({
  workspaceRoot,
  prompt,
  now = () => new Date()
} = {}) {
  if (typeof prompt !== "string") fail("STOP_INVALID", "prompt must be a string");
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    const state = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    const delivery = state.stop_delivery;
    if (
      state.status !== "running" ||
      state.continuation === null ||
      delivery === null ||
      delivery.requested_turn_id === null ||
      delivery.accepted ||
      prompt !== `[HARNESS50_CONTINUE ${JSON.stringify(state.continuation)}]`
    ) {
      return false;
    }
    const accepted = await guardedWriteState(paths.workspaceRoot, validateState({
      ...state,
      stop_delivery: { ...delivery, accepted: true },
      updated_at: clock.iso
    }), guard);
    try {
      await appendEvents(paths.workspaceRoot, [{
        kind: "continuation_prompt_accepted",
        workflow_id: accepted.workflow_id,
        step: accepted.current_step,
        turn_id: accepted.stop_delivery.requested_turn_id,
        generation_id: accepted.stop_delivery.generation_id,
        baseline_receipt_count: accepted.completed_steps.length
      }], clock, guard);
    } catch (error) {
      if (error?.code === "WORKSPACE_PATH_UNSAFE") throw error;
      // Delivery state is authoritative; audit projection failure cannot undo acceptance.
    }
    return true;
  });
}

export async function processStop({
  workspaceRoot,
  turnId,
  stopHookActive,
  now = () => new Date(),
  idFactory = randomUUID,
  eventBatchOptions = {}
} = {}) {
  requireText(turnId, "turnId", "STOP_INVALID");
  if (typeof stopHookActive !== "boolean") fail("STOP_INVALID", "stopHookActive must be boolean");
  requireFactory(idFactory);
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    const before = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    const reconciliation = await reconcileUnderGuard(paths, clock, guard, before, idFactory);
    let state = reconciliation.state;
    const events = [];
    if (reconciliation.changed && state.status === "blocked") {
      events.push({
        kind: "workflow_blocked",
        workflow_id: state.workflow_id,
        step: state.current_step,
        status: "blocked",
        reason_code: state.blocked_reason
      });
    }
    if (reconciliation.recoveredForward && state.status === "running") {
      events.push({
        kind: "continuation_issued",
        workflow_id: state.workflow_id,
        step: state.current_step,
        generation_id: state.stop_delivery.generation_id,
        baseline_receipt_count: state.completed_steps.length
      });
    }

    if (state.status !== "running") {
      await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "release" };
    }

    if (state.continuation !== null) {
      const delivery = state.stop_delivery;
      if (delivery.requested_turn_id !== null) {
        if (delivery.accepted || stopHookActive) {
          await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
          return { decision: "release" };
        }
        await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
        return { decision: "block", continuation: state.continuation };
      }
      if (stopHookActive && !delivery.allow_active_stop) {
        await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
        return { decision: "release" };
      }
      state = validateState({
        ...state,
        stop_delivery: { ...delivery, requested_turn_id: turnId }
      });
      events.push(stopRequestEvent(state, turnId));
      state = await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "block", continuation: state.continuation };
    }

    if (state.current_attempt === null || state.stop_delivery === null) {
      await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "release" };
    }
    if (
      state.stop_delivery.requested_turn_id === turnId &&
      !stopHookActive
    ) {
      await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "release" };
    }
    if (state.current_attempt.failure_recorded) {
      await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "release" };
    }

    const attempt = state.current_attempt;
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
      stop_delivery: blocked ? null : state.stop_delivery,
      updated_at: clock.iso
    });
    events.push({
      kind: "step_failed",
      workflow_id: state.workflow_id,
      step: attempt.step,
      attempt_id: attempt.id,
      failure_count: failureCount,
      consecutive_failures: failureCount
    });
    if (blocked) {
      events.push({
        kind: "workflow_blocked",
        workflow_id: state.workflow_id,
        step: attempt.step,
        status: "blocked",
        reason_code: "THREE_CONSECUTIVE_FAILURES",
        consecutive_failures: failureCount
      });
      await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
      return { decision: "release" };
    }
    const nonce = await guardedId(idFactory, "continuation nonce", guard);
    const generationId = await guardedId(idFactory, "stop delivery generation ID", guard);
    state = issueContinuation(state, {
      now: clock.iso,
      nonce,
      generationId,
      allowActiveStop: true
    });
    state = validateState({
      ...state,
      stop_delivery: { ...state.stop_delivery, requested_turn_id: turnId }
    });
    events.push({
      kind: "continuation_issued",
      workflow_id: state.workflow_id,
      step: state.current_step,
      generation_id: state.stop_delivery.generation_id,
      baseline_receipt_count: state.completed_steps.length
    });
    events.push(stopRequestEvent(state, turnId));
    state = await commitStopTransition(paths, guard, clock, before, state, events, eventBatchOptions);
    return { decision: "block", continuation: state.continuation };
  });
}

function receiptAuthorityCode(state, receipt) {
  const importedPrefix = state.imported_from?.prefix_length ?? 0;
  if (state.imported_from === null) {
    if (receipt.provenance !== "codex-verified") return "RECEIPT_PROVENANCE_MISMATCH";
  } else if (receipt.step <= importedPrefix) {
    if (receipt.provenance !== "claude-progress-import") {
      return "RECEIPT_IMPORT_PREFIX_MISMATCH";
    }
    if (receipt.source_sha256 !== state.imported_from.source_sha256) {
      return "RECEIPT_IMPORT_SOURCE_MISMATCH";
    }
  } else if (receipt.provenance !== "codex-verified") {
    return "RECEIPT_IMPORT_PREFIX_MISMATCH";
  }

  const forwardStep = state.completed_steps.length + 1;
  if (receipt.step >= forwardStep) {
    if (
      receipt.step !== forwardStep ||
      receipt.provenance !== "codex-verified" ||
      state.current_attempt === null ||
      state.current_attempt.step !== forwardStep ||
      state.current_attempt.failure_recorded ||
      receipt.attempt_id !== state.current_attempt.id
    ) {
      return "RECEIPT_ATTEMPT_MISMATCH";
    }
  }
  return null;
}

function authoritativeReceiptPrefix(state, receipts) {
  const prefix = [];
  for (const receipt of receipts) {
    const expectedStep = prefix.length + 1;
    if (receipt.step !== expectedStep) {
      if (receipt.step > expectedStep) {
        return {
          prefix,
          code: "RECEIPT_GAP",
          preserveAttempt: state.current_step === expectedStep && state.current_attempt !== null
        };
      }
      break;
    }
    if (receipt.workflow_id !== state.workflow_id) {
      return {
        prefix,
        code: "RECEIPT_WORKFLOW_MISMATCH",
        preserveAttempt: receipt.step === state.current_step && state.current_attempt !== null
      };
    }
    const code = receiptAuthorityCode(state, receipt);
    if (code !== null) {
      return {
        prefix,
        code,
        preserveAttempt: receipt.step === state.current_step && state.current_attempt !== null
      };
    }
    prefix.push(receipt);
  }
  return { prefix, code: null, preserveAttempt: false };
}

async function trustedReceiptPrefix(workspaceRoot, state, guard) {
  const { receiptsDir } = pathsFor(workspaceRoot);
  const entries = await guardedOperation(guard, [receiptsDir], () => (
    readdir(receiptsDir, { withFileTypes: true }).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    })
  ));
  const names = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
  const prefix = [];
  for (let step = 1; step <= STEP_COUNT; step += 1) {
    const name = `step${String(step).padStart(3, "0")}.json`;
    if (!names.has(name)) break;
    let receipt;
    try {
      const path = receiptPath(workspaceRoot, step);
      receipt = parseReceipt(await guardedOperation(
        guard,
        [receiptsDir, path],
        () => readFile(path, "utf8")
      ));
    } catch (error) {
      if (!receiptValidationError(error)) throw error;
      break;
    }
    if (receipt.step !== step || receipt.workflow_id !== state.workflow_id) break;
    if (receiptAuthorityCode(state, receipt) !== null) break;
    prefix.push(receipt);
  }
  return prefix;
}

function blockForReceiptError(state, code, prefixReceipts = [], { preserveAttempt = false } = {}) {
  const trustworthyPrefix = prefixReceipts.slice(0, STEP_COUNT - 1);
  const completedSteps = trustworthyPrefix.map(receipt => receipt.step);
  let importedPrefix = 0;
  for (const receipt of trustworthyPrefix) {
    if (receipt.provenance !== "claude-progress-import") break;
    importedPrefix += 1;
  }
  const importedFrom = state.imported_from === null
    ? null
    : { ...state.imported_from, prefix_length: importedPrefix };
  const canPreserveAttempt = preserveAttempt &&
    state.current_attempt !== null &&
    state.current_attempt.step === completedSteps.length + 1;
  return validateState({
    ...state,
    status: "blocked",
    current_step: completedSteps.length + 1,
    completed_steps: completedSteps,
    current_attempt: canPreserveAttempt ? state.current_attempt : null,
    continuation: null,
    stop_delivery: null,
    blocked_reason: code,
    imported_from: importedFrom,
    completed_at: null
  });
}

export async function reconcileWorkflow({
  workspaceRoot,
  now = () => new Date(),
  idFactory = randomUUID
} = {}) {
  requireFactory(idFactory);
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    const before = assertMonotonicClock(await requireState(paths.workspaceRoot, guard), clock);
    const result = await reconcileUnderGuard(paths, clock, guard, before, idFactory);
    let state = result.state;
    const changed = result.changed;
    if (changed) {
      state = await guardedWriteState(paths.workspaceRoot, state, guard);
      if (state.status === "blocked") {
        await appendEvents(paths.workspaceRoot, [{
          kind: "workflow_blocked",
          workflow_id: state.workflow_id,
          step: state.current_step,
          status: "blocked",
          reason_code: state.blocked_reason
        }], clock, guard);
      } else if (result.recoveredForward && state.status === "running") {
        await appendEvents(paths.workspaceRoot, [{
          kind: "continuation_issued",
          workflow_id: state.workflow_id,
          step: state.current_step,
          generation_id: state.stop_delivery.generation_id,
          baseline_receipt_count: state.completed_steps.length
        }], clock, guard);
      }
    }
    return state;
  });
}

function validateImportError(value) {
  const safeFailure = {
    code: "CLAUDE_IMPORT_FAILED",
    source_preserved: false,
    action: IMPORT_RECOVERY_ACTION
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return safeFailure;
  if (
    Object.keys(value).length !== IMPORT_ERROR_FIELDS.size ||
    Object.keys(value).some(field => !IMPORT_ERROR_FIELDS.has(field)) ||
    [...IMPORT_ERROR_FIELDS].some(field => !(field in value)) ||
    value.schema_version !== 1 ||
    typeof value.code !== "string" || value.code === "" ||
    typeof value.source_preserved !== "boolean" ||
    value.source_path !== "step_archive/progress.json" ||
    !(
      value.source_sha256 === null ||
      (typeof value.source_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.source_sha256))
    ) ||
    typeof value.occurred_at !== "string" || Number.isNaN(Date.parse(value.occurred_at)) ||
    typeof value.action !== "string" || value.action === ""
  ) return safeFailure;
  if (!SAFE_IMPORT_ERROR_CODES.has(value.code)) return safeFailure;
  return {
    code: value.code,
    source_preserved: value.source_preserved,
    action: IMPORT_RECOVERY_ACTION
  };
}

async function readImportError(path) {
  try {
    return validateImportError(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return validateImportError(null);
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
  return withMutation(workspaceRoot, now, async (paths, clock, guard) => {
    const codexIdentity = await assertPhysicalDirectory(paths.workspaceRoot, paths.codexDir);
    if (codexIdentity === null) fail("WORKFLOW_NOT_FOUND", "no Codex workflow metadata exists to reset");
    let backupsIdentity = await assertPhysicalDirectory(paths.workspaceRoot, paths.backupsDir);
    if (backupsIdentity === null) {
      backupsIdentity = await guardedOperation(
        guard,
        [paths.backupsDir],
        () => ensureDurableDirectory(paths.workspaceRoot, paths.backupsDir)
      );
    }
    const entries = await guardedOperation(guard, [paths.codexDir], () => (
      readdir(paths.codexDir).catch(error => {
        if (error?.code === "ENOENT") return [];
        throw error;
      })
    ));
    if (!entries.some(name => ACTIVE_METADATA.has(name))) {
      fail("WORKFLOW_NOT_FOUND", "no Codex workflow metadata exists to reset");
    }
    try {
      const state = await guardedOperation(
        guard,
        [paths.statePath],
        () => readState(paths.workspaceRoot)
      );
      if (state !== null) assertMonotonicClock(state, clock);
    } catch (error) {
      if (!new Set(["STATE_INVALID", "STATE_PARSE_ERROR"]).has(error?.code)) throw error;
    }
    await assertPhysicalComponents(paths.workspaceRoot, [
      paths.codexDir,
      paths.backupsDir,
      ...entries.filter(name => ACTIVE_METADATA.has(name)).map(name => join(paths.codexDir, name))
    ]);
    const archiveCandidates = [
      paths.codexDir,
      paths.backupsDir,
      ...entries.filter(name => ACTIVE_METADATA.has(name)).map(name => join(paths.codexDir, name))
    ];
    const backupPath = await guardedOperation(guard, archiveCandidates, () => (
      archiveActiveState(paths.workspaceRoot, {
        reason: "manual-reset",
        now: clock.now
      })
    ));
    const currentCodex = await assertPhysicalDirectory(paths.workspaceRoot, paths.codexDir);
    const currentBackups = await assertPhysicalDirectory(paths.workspaceRoot, paths.backupsDir);
    if (
      currentCodex === null || currentBackups === null ||
      !sameNode(codexIdentity, currentCodex) ||
      !sameNode(backupsIdentity, currentBackups)
    ) {
      fail("WORKSPACE_PATH_UNSAFE", "reset storage changed during archival");
    }
    await assertPhysicalComponents(paths.workspaceRoot, [backupPath]);
    return { backupPath };
  });
}

import { HarnessError } from "./errors.mjs";

const SCHEMA_VERSION = 1;
const STEP_COUNT = 50;
const STATUSES = new Set(["running", "paused", "blocked", "completed"]);
const TOPIC_PATH = "step_archive/TOPIC/TOPIC.md";
const STATE_FIELDS = new Set([
  "schema_version", "workflow_id", "status", "total_steps", "current_step",
  "completed_steps", "topic_path", "topic_sha256", "current_attempt",
  "consecutive_failures", "blocked_reason", "owner", "continuation",
  "imported_from", "last_stop_turn_id", "created_at", "updated_at", "completed_at"
]);
const CURRENT_ATTEMPT_FIELDS = new Set(["id", "step", "session_id", "started_at", "failure_recorded"]);
const OWNER_FIELDS = new Set(["session_id", "lease_updated_at"]);
const CONTINUATION_FIELDS = new Set(["workflow_id", "step", "nonce", "issued_at", "baseline_receipt_count"]);
const IMPORTED_FROM_FIELDS = new Set(["kind", "source_sha256", "imported_at", "prefix_length", "warnings"]);

function invalid(message, details = {}) {
  throw new HarnessError("STATE_INVALID", message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) invalid(`${label} contains an unknown field: ${field}`, { field: `${label}.${field}` });
  }
  for (const field of fields) {
    if (!(field in value)) invalid(`${label} is missing required field: ${field}`, { field: `${label}.${field}` });
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") invalid(`${field} must be a non-empty string`, { field });
}

function requireNullableString(value, field) {
  if (value !== null) requireString(value, field);
}

function requireTimestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    invalid(`${field} must be an ISO-8601 timestamp`, { field });
  }
}

function requireStep(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > STEP_COUNT) {
    invalid(`${field} must be an integer from 1 through ${STEP_COUNT}`, { field });
  }
}

function validateCompletedSteps(completedSteps) {
  if (!Array.isArray(completedSteps)) invalid("completed_steps must be an array", { field: "completed_steps" });
  for (let index = 0; index < completedSteps.length; index += 1) {
    const step = completedSteps[index];
    requireStep(step, "completed_steps");
    if (step !== index + 1) {
      invalid("completed_steps must be a contiguous prefix beginning with step 1", {
        field: "completed_steps",
        step
      });
    }
  }
}

function validateCurrentAttempt(value, currentStep) {
  if (value === null) return;
  if (!isPlainObject(value)) invalid("current_attempt must be null or an object", { field: "current_attempt" });
  requireExactFields(value, CURRENT_ATTEMPT_FIELDS, "current_attempt");
  requireString(value.id, "current_attempt.id");
  requireStep(value.step, "current_attempt.step");
  if (value.step !== currentStep) invalid("current_attempt.step must match current_step", { field: "current_attempt.step" });
  requireNullableString(value.session_id, "current_attempt.session_id");
  requireTimestamp(value.started_at, "current_attempt.started_at");
  if (typeof value.failure_recorded !== "boolean") {
    invalid("current_attempt.failure_recorded must be boolean", { field: "current_attempt.failure_recorded" });
  }
}

function validateOwner(value) {
  if (value === null) return;
  if (!isPlainObject(value)) invalid("owner must be null or an object", { field: "owner" });
  requireExactFields(value, OWNER_FIELDS, "owner");
  requireString(value.session_id, "owner.session_id");
  requireTimestamp(value.lease_updated_at, "owner.lease_updated_at");
}

function validateContinuation(value, state) {
  if (value === null) return;
  if (!isPlainObject(value)) invalid("continuation must be null or an object", { field: "continuation" });
  requireExactFields(value, CONTINUATION_FIELDS, "continuation");
  if (value.workflow_id !== state.workflow_id) invalid("continuation.workflow_id must match workflow_id", { field: "continuation.workflow_id" });
  if (value.step !== state.current_step) invalid("continuation.step must match current_step", { field: "continuation.step" });
  requireString(value.nonce, "continuation.nonce");
  requireTimestamp(value.issued_at, "continuation.issued_at");
  if (!Number.isInteger(value.baseline_receipt_count) || value.baseline_receipt_count < 0 || value.baseline_receipt_count > STEP_COUNT) {
    invalid("continuation.baseline_receipt_count must be an integer from 0 through 50", { field: "continuation.baseline_receipt_count" });
  }
  if (value.baseline_receipt_count !== state.completed_steps.length) {
    invalid("continuation.baseline_receipt_count must match completed_steps", { field: "continuation.baseline_receipt_count" });
  }
}

function validateImportedFrom(value, completedStepCount) {
  if (value === null) return;
  if (!isPlainObject(value)) invalid("imported_from must be null or an object", { field: "imported_from" });
  requireExactFields(value, IMPORTED_FROM_FIELDS, "imported_from");
  if (value.kind !== "claude-progress") invalid("imported_from.kind is invalid", { field: "imported_from.kind" });
  if (!/^[a-f0-9]{64}$/.test(value.source_sha256 ?? "")) {
    invalid("imported_from.source_sha256 must be a SHA-256 digest", { field: "imported_from.source_sha256" });
  }
  requireTimestamp(value.imported_at, "imported_from.imported_at");
  if (!Number.isInteger(value.prefix_length) || value.prefix_length < 0 || value.prefix_length > STEP_COUNT) {
    invalid("imported_from.prefix_length must be an integer from 0 through 50", { field: "imported_from.prefix_length" });
  }
  if (value.prefix_length > completedStepCount) {
    invalid("imported_from.prefix_length cannot exceed completed_steps", { field: "imported_from.prefix_length" });
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    invalid("imported_from.warnings must be an array of strings", { field: "imported_from.warnings" });
  }
}

export function nextIncompleteStep(state) {
  const completed = new Set(state.completed_steps);
  for (let step = 1; step <= STEP_COUNT; step += 1) {
    if (!completed.has(step)) return step;
  }
  return null;
}

export function validateState(state) {
  if (!isPlainObject(state)) invalid("state must be an object");
  for (const field of Object.keys(state)) {
    if (!STATE_FIELDS.has(field)) invalid(`state contains an unknown field: ${field}`, { field });
  }
  for (const field of STATE_FIELDS) {
    if (!(field in state)) invalid(`state is missing required field: ${field}`, { field });
  }

  if (state.schema_version !== SCHEMA_VERSION) invalid("state schema_version must be 1", { field: "schema_version" });
  requireString(state.workflow_id, "workflow_id");
  if (!STATUSES.has(state.status)) invalid("state status is invalid", { field: "status" });
  if (state.total_steps !== STEP_COUNT) invalid("state total_steps must be 50", { field: "total_steps" });
  validateCompletedSteps(state.completed_steps);
  if (state.topic_path !== TOPIC_PATH) invalid(`topic_path must be ${TOPIC_PATH}`, { field: "topic_path" });
  if (!/^[a-f0-9]{64}$/.test(state.topic_sha256 ?? "")) {
    invalid("topic_sha256 must be a SHA-256 digest", { field: "topic_sha256" });
  }
  if (!Number.isInteger(state.consecutive_failures) || state.consecutive_failures < 0) {
    invalid("consecutive_failures must be a non-negative integer", { field: "consecutive_failures" });
  }
  requireTimestamp(state.created_at, "created_at");
  requireTimestamp(state.updated_at, "updated_at");
  requireTimestamp(state.completed_at, "completed_at", { nullable: true });
  if ((state.status === "completed") !== (state.completed_at !== null)) {
    invalid("completed_at must be set only for completed state", { field: "completed_at" });
  }
  requireNullableString(state.last_stop_turn_id, "last_stop_turn_id");
  validateOwner(state.owner);
  validateImportedFrom(state.imported_from, state.completed_steps.length);

  const expectedCurrentStep = state.completed_steps.length === STEP_COUNT
    ? null
    : state.completed_steps.length + 1;
  if (state.status === "completed") {
    if (state.completed_steps.length !== STEP_COUNT || state.current_step !== null) {
      invalid("completed state requires all 50 completed steps and current_step=null", { field: "status" });
    }
    if (state.current_attempt !== null || state.continuation !== null) {
      invalid("completed state cannot have an active attempt or continuation", { field: "status" });
    }
  } else {
    if (state.current_step !== expectedCurrentStep) {
      invalid("current_step must be the first incomplete step", { field: "current_step" });
    }
    requireStep(state.current_step, "current_step");
  }
  if (state.status === "blocked") {
    requireString(state.blocked_reason, "blocked_reason");
  } else if (state.blocked_reason !== null) {
    invalid("blocked_reason must be null unless status is blocked", { field: "blocked_reason" });
  }
  validateCurrentAttempt(state.current_attempt, state.current_step);
  validateContinuation(state.continuation, state);
  return state;
}

export function parseState(raw) {
  if (typeof raw !== "string") {
    throw new HarnessError("STATE_PARSE_ERROR", "state JSON must be a string");
  }
  try {
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("STATE_PARSE_ERROR", "state JSON is invalid", {
      cause: error.message
    });
  }
}

export function createInitialState({ workflowId, workspaceRoot, topicSha256, now } = {}) {
  requireString(workflowId, "workflowId");
  requireString(workspaceRoot, "workspaceRoot");
  if (!/^[a-f0-9]{64}$/.test(topicSha256 ?? "")) {
    invalid("topicSha256 must be a SHA-256 digest", { field: "topicSha256" });
  }
  requireTimestamp(now, "now");
  return validateState({
    schema_version: SCHEMA_VERSION,
    workflow_id: workflowId,
    status: "running",
    total_steps: STEP_COUNT,
    current_step: 1,
    completed_steps: [],
    topic_path: TOPIC_PATH,
    topic_sha256: topicSha256,
    current_attempt: null,
    consecutive_failures: 0,
    blocked_reason: null,
    owner: null,
    continuation: null,
    imported_from: null,
    last_stop_turn_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null
  });
}

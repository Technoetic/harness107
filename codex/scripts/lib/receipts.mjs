import { randomUUID } from "node:crypto";
import { link, open, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HarnessError } from "./errors.mjs";
import { pathsFor } from "./paths.mjs";
import { validateState } from "./schema.mjs";

const STEP_COUNT = 50;
const RECEIPT_FIELDS = new Set([
  "schema_version",
  "workflow_id",
  "step",
  "attempt_id",
  "provenance",
  "completed_at",
  "summary",
  "evidence",
  "source_sha256"
]);
const REQUIRED_RECEIPT_FIELDS = [
  "schema_version",
  "workflow_id",
  "step",
  "attempt_id",
  "provenance",
  "completed_at",
  "summary",
  "evidence"
];
const EVIDENCE_FIELDS = new Set([
  "acceptance_id",
  "kind",
  "detail",
  "ok",
  "artifact_path",
  "artifact_sha256",
  "command",
  "exit_code"
]);
const REQUIRED_EVIDENCE_FIELDS = ["acceptance_id", "kind", "detail", "ok"];
const EVIDENCE_KINDS = new Set(["command", "artifact", "check", "import"]);
const RECEIPT_PROVENANCE = new Set(["codex-verified", "claude-progress-import"]);
const RECEIPT_FILE_PATTERN = /^step(\d{3})\.json$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key)\b\s*[:=]\s*\S+/i,
  /(?:^|[\s;&|])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/i,
  /(?:^|[\s;&|])\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/i,
  /(?:^|[\s;&|])set\s+(?:"[A-Za-z_][A-Za-z0-9_]*\s*=|[A-Za-z_][A-Za-z0-9_]*\s*=)\S*/i
];
const SENSITIVE_FIELD_NAME = /(?:password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key)/i;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidReceipt(message, details = {}) {
  throw new HarnessError("RECEIPT_INVALID", message, details);
}

function invalidEvidence(message, details = {}) {
  throw new HarnessError("EVIDENCE_INVALID", message, details);
}

function requireNonemptyString(value, field, invalid) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${field} must be a non-empty string`, { field });
  }
}

function requireTimestamp(value, field) {
  requireNonemptyString(value, field, invalidReceipt);
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    invalidReceipt(`${field} must be an ISO-8601 timestamp`, { field });
  }
}

function requireExactFields(value, allowed, required, label, invalid) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(`${label} contains an unknown field`, { field: label });
  }
  for (const field of required) {
    if (!(field in value)) invalid(`${label} is missing required field: ${field}`, { field: `${label}.${field}` });
  }
}

function containsSensitiveMaterial(value) {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(value));
}

function assertNoSensitiveData(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (containsSensitiveMaterial(value)) {
      throw new HarnessError("SENSITIVE_EVIDENCE", "receipt contains sensitive material");
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [field, nested] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAME.test(field) || containsSensitiveMaterial(field)) {
      throw new HarnessError("SENSITIVE_EVIDENCE", "receipt contains sensitive material");
    }
    assertNoSensitiveData(nested, seen);
  }
}

function validateEvidenceItem(raw, index) {
  const label = `evidence[${index}]`;
  if (!isPlainObject(raw)) invalidEvidence(`${label} must be an object`, { field: label });
  assertNoSensitiveData(raw);
  requireExactFields(raw, EVIDENCE_FIELDS, REQUIRED_EVIDENCE_FIELDS, label, invalidEvidence);

  if (raw.acceptance_id !== null) {
    requireNonemptyString(raw.acceptance_id, `${label}.acceptance_id`, invalidEvidence);
  }
  if (!EVIDENCE_KINDS.has(raw.kind)) {
    invalidEvidence(`${label}.kind is invalid`, { field: `${label}.kind` });
  }
  requireNonemptyString(raw.detail, `${label}.detail`, invalidEvidence);
  if (typeof raw.ok !== "boolean") {
    invalidEvidence(`${label}.ok must be boolean`, { field: `${label}.ok` });
  }

  for (const field of ["artifact_path", "command"]) {
    if (field in raw) requireNonemptyString(raw[field], `${label}.${field}`, invalidEvidence);
  }
  if ("artifact_sha256" in raw && !SHA256.test(raw.artifact_sha256 ?? "")) {
    invalidEvidence(`${label}.artifact_sha256 must be a SHA-256 digest`, { field: `${label}.artifact_sha256` });
  }
  if ("exit_code" in raw && !Number.isInteger(raw.exit_code)) {
    invalidEvidence(`${label}.exit_code must be an integer`, { field: `${label}.exit_code` });
  }

  const item = {};
  for (const field of EVIDENCE_FIELDS) {
    if (field in raw) item[field] = raw[field];
  }
  return item;
}

export function sanitizeEvidence(evidence) {
  if (!Array.isArray(evidence)) invalidEvidence("evidence must be an array", { field: "evidence" });
  assertNoSensitiveData(evidence);
  return evidence.map(validateEvidenceItem);
}

export function parseReceipt(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HarnessError("RECEIPT_PARSE_ERROR", "receipt JSON is invalid");
    }
  }
  if (!isPlainObject(value)) invalidReceipt("receipt must be an object");
  assertNoSensitiveData(value);
  requireExactFields(value, RECEIPT_FIELDS, REQUIRED_RECEIPT_FIELDS, "receipt", invalidReceipt);

  if (value.schema_version !== 1) invalidReceipt("receipt schema_version must be 1", { field: "schema_version" });
  requireNonemptyString(value.workflow_id, "workflow_id", invalidReceipt);
  if (!Number.isInteger(value.step) || value.step < 1 || value.step > STEP_COUNT) {
    invalidReceipt(`step must be an integer from 1 through ${STEP_COUNT}`, { field: "step" });
  }
  if (!RECEIPT_PROVENANCE.has(value.provenance)) {
    invalidReceipt("receipt provenance is invalid", { field: "provenance" });
  }
  requireTimestamp(value.completed_at, "completed_at");
  requireNonemptyString(value.summary, "summary", invalidReceipt);

  if (value.provenance === "codex-verified") {
    requireNonemptyString(value.attempt_id, "attempt_id", invalidReceipt);
    if ("source_sha256" in value) {
      invalidReceipt("codex-verified receipt cannot include source_sha256", { field: "source_sha256" });
    }
  } else {
    if (value.attempt_id !== null) {
      invalidReceipt("imported receipt attempt_id must be null", { field: "attempt_id" });
    }
    if (!("source_sha256" in value) || !SHA256.test(value.source_sha256 ?? "")) {
      invalidReceipt("imported receipt source_sha256 must be a SHA-256 digest", { field: "source_sha256" });
    }
  }

  const receipt = {
    schema_version: value.schema_version,
    workflow_id: value.workflow_id,
    step: value.step,
    attempt_id: value.attempt_id,
    provenance: value.provenance,
    completed_at: value.completed_at,
    summary: value.summary,
    evidence: sanitizeEvidence(value.evidence)
  };
  if ("source_sha256" in value) receipt.source_sha256 = value.source_sha256;
  return receipt;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalValue(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function validateStep(step) {
  if (!Number.isInteger(step) || step < 1 || step > STEP_COUNT) {
    invalidReceipt(`step must be an integer from 1 through ${STEP_COUNT}`, { field: "step" });
  }
  return step;
}

export function receiptPath(workspaceRoot, step) {
  validateStep(step);
  return join(pathsFor(workspaceRoot).receiptsDir, `step${String(step).padStart(3, "0")}.json`);
}

export async function readReceipts(workspaceRoot) {
  const { receiptsDir } = pathsFor(workspaceRoot);
  let entries;
  try {
    entries = await readdir(receiptsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const receiptFiles = entries
    .filter(entry => entry.isFile() && RECEIPT_FILE_PATTERN.test(entry.name))
    .map(entry => ({
      name: entry.name,
      step: Number(RECEIPT_FILE_PATTERN.exec(entry.name)[1])
    }))
    .sort((left, right) => left.step - right.step);

  const receipts = [];
  for (const file of receiptFiles) {
    validateStep(file.step);
    const receipt = parseReceipt(await readFile(join(receiptsDir, file.name), "utf8"));
    if (receipt.step !== file.step) {
      throw new HarnessError("RECEIPT_PATH_MISMATCH", "receipt step does not match its filename", {
        path_step: file.step,
        receipt_step: receipt.step
      });
    }
    receipts.push(receipt);
  }
  return receipts;
}

export async function syncDirectoryDurable(directoryPath, {
  platform = process.platform,
  openDirectory = open
} = {}) {
  if (typeof openDirectory !== "function") {
    throw new HarnessError("RECEIPT_WRITE_OPTIONS_INVALID", "openDirectory must be a function");
  }
  let handle;
  let failure;
  try {
    handle = await openDirectory(directoryPath, platform === "win32" ? "r+" : "r");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) {
    throw new HarnessError("RECEIPT_DURABILITY_ERROR", "receipt storage directory could not be synchronized", {
      cause_code: typeof failure?.code === "string" ? failure.code : "UNKNOWN"
    });
  }
}

async function ensureReceiptStorage(workspaceRoot, codexDir, receiptsDir, syncDirectory) {
  const directories = [
    join(workspaceRoot, "step_archive"),
    codexDir,
    receiptsDir
  ];
  for (const directoryPath of directories) {
    try {
      await mkdir(directoryPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await syncDirectory(directoryPath);
    await syncDirectory(dirname(directoryPath));
  }
}

async function writeBytesDefault(handle, bytes) {
  await handle.writeFile(bytes, "utf8");
}

async function syncFileDefault(handle) {
  await handle.sync();
}

export async function writeReceiptExclusive(workspaceRoot, rawReceipt, {
  writeBytes = writeBytesDefault,
  syncFile = syncFileDefault,
  beforePublish,
  publishFile = link,
  syncDirectory = syncDirectoryDurable,
  removeFile = unlink,
  idFactory = randomUUID
} = {}) {
  const receipt = parseReceipt(rawReceipt);
  const paths = pathsFor(workspaceRoot);
  const { codexDir, receiptsDir } = paths;
  const path = receiptPath(workspaceRoot, receipt.step);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const [name, value] of Object.entries({ writeBytes, syncFile, publishFile, syncDirectory, removeFile, idFactory })) {
    if (typeof value !== "function") {
      throw new HarnessError("RECEIPT_WRITE_OPTIONS_INVALID", `${name} must be a function`);
    }
  }
  if (beforePublish !== undefined && typeof beforePublish !== "function") {
    throw new HarnessError("RECEIPT_WRITE_OPTIONS_INVALID", "beforePublish must be a function");
  }
  await ensureReceiptStorage(paths.workspaceRoot, codexDir, receiptsDir, syncDirectory);

  const temporaryPath = join(receiptsDir, `.${basename(path)}.${process.pid}.${idFactory()}.tmp`);

  let handle;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await writeBytes(handle, serialized);
    await syncFile(handle);
    await handle.close();
    handle = undefined;
    await beforePublish?.({ temporaryPath, receiptPath: path });

    try {
      await publishFile(temporaryPath, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeFile(temporaryPath);
      temporaryExists = false;
      await syncDirectory(receiptsDir);

      let identical = false;
      try {
        const existing = parseReceipt(await readFile(path, "utf8"));
        identical = canonicalJson(existing) === canonicalJson(receipt);
      } catch {
        identical = false;
      }
      if (identical) return receipt;
      throw new HarnessError("RECEIPT_CONFLICT", "a different receipt already exists for this step", {
        step: receipt.step
      });
    }

    await removeFile(temporaryPath);
    temporaryExists = false;
    await syncDirectory(receiptsDir);
    return receipt;
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryExists) await removeFile(temporaryPath).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function importedPrefixLength(receipts) {
  let length = 0;
  for (const receipt of receipts) {
    if (receipt.provenance !== "claude-progress-import") break;
    length += 1;
  }
  return length;
}

function blockedReconciliation(state, reason, prefixReceipts = []) {
  const normalizedPrefix = prefixReceipts.slice(0, STEP_COUNT - 1);
  const completedSteps = normalizedPrefix.map(receipt => receipt.step);
  const importedFrom = state.imported_from === null
    ? null
    : {
        ...state.imported_from,
        prefix_length: importedPrefixLength(normalizedPrefix)
      };
  return {
    state: validateState({
      ...state,
      status: "blocked",
      current_step: completedSteps.length + 1,
      completed_steps: completedSteps,
      current_attempt: null,
      consecutive_failures: 0,
      blocked_reason: reason,
      continuation: null,
      imported_from: importedFrom,
      completed_at: null
    }),
    prefix_receipts: normalizedPrefix,
    diagnostics: [{ code: reason }]
  };
}

function reconciledState(state, prefixReceipts) {
  const completedSteps = prefixReceipts.map(receipt => receipt.step);
  const recoveredForward = completedSteps.length > state.completed_steps.length;
  const completed = completedSteps.length === STEP_COUNT;
  const status = completed
    ? "completed"
    : recoveredForward && state.status !== "paused"
      ? "running"
      : state.status;
  const clearsBlockedReason = completed || (recoveredForward && state.status !== "paused");
  return validateState({
    ...state,
    completed_steps: completedSteps,
    current_step: completed ? null : completedSteps.length + 1,
    current_attempt: recoveredForward ? null : state.current_attempt,
    consecutive_failures: recoveredForward ? 0 : state.consecutive_failures,
    continuation: recoveredForward ? null : state.continuation,
    status,
    blocked_reason: clearsBlockedReason ? null : state.blocked_reason,
    completed_at: completed ? prefixReceipts.at(-1).completed_at : null
  });
}

export function reconcileReceipts(rawState, receipts) {
  const state = validateState(rawState);
  if (!Array.isArray(receipts)) invalidReceipt("receipts must be an array", { field: "receipts" });

  const byStep = new Map();
  const conflictingSteps = new Set();
  let workflowMismatch = false;
  for (const raw of receipts) {
    const receipt = parseReceipt(raw);
    if (receipt.workflow_id !== state.workflow_id) {
      workflowMismatch = true;
      continue;
    }
    if (conflictingSteps.has(receipt.step)) continue;
    const existing = byStep.get(receipt.step);
    if (existing && canonicalJson(existing) !== canonicalJson(receipt)) {
      conflictingSteps.add(receipt.step);
      byStep.delete(receipt.step);
      continue;
    }
    byStep.set(receipt.step, receipt);
  }

  const prefixReceipts = [];
  for (let step = 1; step <= STEP_COUNT && byStep.has(step); step += 1) {
    prefixReceipts.push(byStep.get(step));
  }
  const stateAhead = state.completed_steps.length > prefixReceipts.length;
  const gap = [...byStep.keys()].some(step => step > prefixReceipts.length + 1);
  if (workflowMismatch) {
    return blockedReconciliation(state, "RECEIPT_WORKFLOW_MISMATCH", prefixReceipts);
  }
  if (conflictingSteps.size > 0) {
    return blockedReconciliation(state, "RECEIPT_CONFLICT", prefixReceipts);
  }
  if (stateAhead) {
    return blockedReconciliation(state, "STATE_AHEAD_OF_RECEIPTS", prefixReceipts);
  }
  if (gap) {
    return blockedReconciliation(state, "RECEIPT_GAP", prefixReceipts);
  }

  return {
    state: reconciledState(state, prefixReceipts),
    prefix_receipts: prefixReceipts,
    diagnostics: []
  };
}

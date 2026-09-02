import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HarnessError } from "./errors.mjs";
import { withRunLock } from "./lock.mjs";
import { assertInside, pathsFor } from "./paths.mjs";
import {
  readReceipts,
  syncDirectoryDurable,
  writeReceiptExclusive
} from "./receipts.mjs";
import { createInitialState, validateState } from "./schema.mjs";
import { appendEvent, readState, writeStateAtomic } from "./state-store.mjs";

const STEP_COUNT = 50;
const SOURCE_PATH = "step_archive/progress.json";
const TOPIC_PATH = "step_archive/TOPIC/TOPIC.md";
const IMPORT_ACTION = "repair the Claude state or use a separate workspace";
const HOOK_NAMES = new Set([
  "afterSnapshot",
  "afterMetadata",
  "afterReceipt",
  "beforeStateWrite",
  "beforeEvent"
]);

function fail(code, message, details = {}) {
  throw new HarnessError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIntegerString(value) {
  return typeof value === "string" && /^[+-]?\d+$/.test(value.trim());
}

function normalizeStepNumber(value) {
  if (!Number.isInteger(value) && !isIntegerString(value)) {
    fail("CLAUDE_STEP_VALUE", "Claude step values must be integers or integer-like strings");
  }
  const normalized = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isSafeInteger(normalized)) {
    fail("CLAUDE_STEP_VALUE", "Claude step values must be safe integers");
  }
  return normalized;
}

function requireStepRange(value, totalSteps) {
  const step = normalizeStepNumber(value);
  if (step < 1 || step > totalSteps) {
    fail("CLAUDE_STEP_RANGE", `Claude step values must be from 1 through ${totalSteps}`);
  }
  return step;
}

export function deriveContiguousPrefix(values, totalSteps = STEP_COUNT) {
  if (!Array.isArray(values)) {
    fail("CLAUDE_COMPLETED_STEPS", "completed_steps must be an array");
  }
  if (!Number.isInteger(totalSteps) || totalSteps < 1) {
    fail("CLAUDE_TOTAL_STEPS", "totalSteps must be a positive integer");
  }
  const normalizedValues = values.map(value => requireStepRange(value, totalSteps));
  const normalized = [...new Set(normalizedValues)].sort((left, right) => left - right);
  const prefix = [];
  for (let expected = 1; expected <= totalSteps; expected += 1) {
    if (!normalized.includes(expected)) break;
    prefix.push(expected);
  }
  return { normalized, prefix };
}

export function normalizeClaudeProgress(value) {
  if (!isPlainObject(value)) {
    fail("CLAUDE_PROGRESS_INVALID", "Claude progress must be a JSON object");
  }
  const totalSteps = normalizeStepNumber(value.total_steps);
  if (totalSteps !== STEP_COUNT) {
    fail("CLAUDE_TOTAL_STEPS", "Claude total_steps must be exactly 50");
  }
  if (!Array.isArray(value.completed_steps)) {
    fail("CLAUDE_COMPLETED_STEPS", "Claude completed_steps must be an array");
  }
  const sourceCurrentStep = requireStepRange(value.current_step, STEP_COUNT);
  const normalizedValues = value.completed_steps.map(step => requireStepRange(step, STEP_COUNT));
  const { normalized, prefix } = deriveContiguousPrefix(value.completed_steps, STEP_COUNT);
  const warnings = [];
  if (
    typeof value.total_steps === "string" ||
    typeof value.current_step === "string" ||
    value.completed_steps.some(step => typeof step === "string")
  ) {
    warnings.push("integer-like Claude step values were normalized");
  }
  if (new Set(normalizedValues).size !== normalizedValues.length) {
    warnings.push("duplicate completed_steps were normalized");
  }
  if (normalized.some(step => step > prefix.length + 1)) {
    warnings.push("sparse completed_steps beyond the contiguous prefix were ignored");
  }
  const selectedStep = prefix.length === STEP_COUNT ? null : prefix.length + 1;
  const expectedSourceStep = selectedStep ?? STEP_COUNT;
  if (sourceCurrentStep !== expectedSourceStep) {
    warnings.push("current_step did not match the derived selected step");
  }
  return {
    total_steps: STEP_COUNT,
    current_step: selectedStep,
    completed_steps: prefix,
    normalized_steps: normalized,
    warnings
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function importedAtFrom(now) {
  if (typeof now !== "function") {
    fail("IMPORT_OPTIONS_INVALID", "now must be a function");
  }
  const date = now();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    fail("IMPORT_OPTIONS_INVALID", "now must return a valid Date");
  }
  return date;
}

function validateIdFactory(idFactory) {
  if (typeof idFactory !== "function") {
    fail("IMPORT_OPTIONS_INVALID", "idFactory must be a function");
  }
}

function validateHooks(rawHooks) {
  if (!isPlainObject(rawHooks)) {
    fail("IMPORT_OPTIONS_INVALID", "hooks must be an object");
  }
  for (const [name, hook] of Object.entries(rawHooks)) {
    if (!HOOK_NAMES.has(name) || typeof hook !== "function") {
      fail("IMPORT_OPTIONS_INVALID", "import hooks must be known functions", { hook: name });
    }
  }
  return rawHooks;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function entries(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoExistingImport(workspaceRoot) {
  const paths = pathsFor(workspaceRoot);
  if (await fileExists(paths.statePath)) {
    try {
      if (await readState(workspaceRoot)) {
        fail("CODEX_STATE_EXISTS", "a valid Codex state already exists");
      }
    } catch (error) {
      if (error?.code === "CODEX_STATE_EXISTS") throw error;
      fail("IMPORT_INCOMPLETE", "Codex state exists but is not a valid resumable import");
    }
  }

  const [receiptEntries, importEntries, hasImportError] = await Promise.all([
    entries(paths.receiptsDir),
    entries(paths.importsDir),
    fileExists(paths.importErrorPath)
  ]);
  if (receiptEntries.length > 0 || importEntries.length > 0 || hasImportError) {
    fail(
      "IMPORT_INCOMPLETE",
      "Codex import artifacts exist without valid state; use the recoverable reset path"
    );
  }
  const receipts = await readReceipts(workspaceRoot);
  if (receipts.length > 0) {
    fail("IMPORT_INCOMPLETE", "Codex receipts exist without valid state; use the recoverable reset path");
  }
}

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
}

async function publishImmutableFile(path, bytes) {
  const directoryPath = dirname(path);
  await ensureDirectory(directoryPath);
  const temporaryPath = join(
    directoryPath,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
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
      await link(temporaryPath, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("IMPORT_ARTIFACT_EXISTS", "an import artifact already exists and will not be overwritten");
      }
      throw error;
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    await syncDirectoryDurable(directoryPath);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryExists) {
      await unlink(temporaryPath).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

async function writeJsonImmutable(path, value) {
  await publishImmutableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseProgress(rawBytes) {
  const withoutBom = rawBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? rawBytes.subarray(3)
    : rawBytes;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
    return JSON.parse(decoded);
  } catch {
    fail("CLAUDE_PROGRESS_JSON", "Claude progress.json is not valid UTF-8 JSON");
  }
}

async function loadTopic(workspaceRoot) {
  const topicPath = assertInside(workspaceRoot, join(workspaceRoot, "step_archive", "TOPIC", "TOPIC.md"));
  let bytes;
  try {
    bytes = await readFile(topicPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("CLAUDE_TOPIC_MISSING", "the required Claude topic is missing");
    }
    throw error;
  }
  if (bytes.length === 0 || bytes.toString("utf8").trim() === "") {
    fail("CLAUDE_TOPIC_MISSING", "the required Claude topic is empty");
  }
  return sha256(bytes);
}

async function loadStepDefinitions(pluginRoot) {
  if (typeof pluginRoot !== "string" || pluginRoot.trim() === "") {
    fail("IMPORT_OPTIONS_INVALID", "pluginRoot is required");
  }
  const indexPath = assertInside(
    pluginRoot,
    join(pluginRoot, "codex", "assets", "steps", "index.json")
  );
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    fail("CODEX_STEP_DEFINITIONS", "Codex step definitions are missing or invalid");
  }
  if (!isPlainObject(index) || index.schema_version !== 1 || !Array.isArray(index.steps) || index.steps.length !== STEP_COUNT) {
    fail("CODEX_STEP_DEFINITIONS", "Codex step definitions must contain exactly 50 steps");
  }
  for (let number = 1; number <= STEP_COUNT; number += 1) {
    const id = `step${String(number).padStart(3, "0")}`;
    const target = `codex/assets/steps/${id}.md`;
    const definition = index.steps[number - 1];
    if (
      !isPlainObject(definition) ||
      definition.number !== number ||
      definition.id !== id ||
      definition.target !== target
    ) {
      fail("CODEX_STEP_DEFINITIONS", `Codex definition ${id} is not canonical`, { step: number });
    }
    const definitionPath = assertInside(pluginRoot, join(pluginRoot, ...target.split("/")));
    let contents;
    try {
      contents = await readFile(definitionPath, "utf8");
    } catch {
      fail("CODEX_STEP_DEFINITIONS", `Codex definition ${id} is missing`, { step: number });
    }
    if (contents.trim() === "") {
      fail("CODEX_STEP_DEFINITIONS", `Codex definition ${id} is empty`, { step: number });
    }
  }
}

function importedReceipt({ workflowId, step, importedAt, sourceSha256 }) {
  return {
    schema_version: 1,
    workflow_id: workflowId,
    step,
    attempt_id: null,
    provenance: "claude-progress-import",
    completed_at: importedAt,
    summary: `Imported historical completion for step ${step}`,
    evidence: [{
      acceptance_id: null,
      kind: "import",
      detail: "Historical completion imported from preserved Claude progress",
      ok: true
    }],
    source_sha256: sourceSha256
  };
}

function importedState({ workspaceRoot, workflowId, topicSha256, normalized, sourceSha256, importedAt }) {
  const initial = createInitialState({
    workflowId,
    workspaceRoot,
    topicSha256,
    now: importedAt
  });
  const completed = normalized.completed_steps.length === STEP_COUNT;
  return validateState({
    ...initial,
    status: completed ? "completed" : "running",
    current_step: normalized.current_step,
    completed_steps: normalized.completed_steps,
    imported_from: {
      kind: "claude-progress",
      source_sha256: sourceSha256,
      imported_at: importedAt,
      prefix_length: normalized.completed_steps.length,
      warnings: normalized.warnings
    },
    completed_at: completed ? importedAt : null
  });
}

function failureCode(error) {
  return typeof error?.code === "string" && error.code.startsWith("CLAUDE_")
    ? error.code
    : error?.code === "CODEX_STEP_DEFINITIONS"
      ? error.code
      : "CLAUDE_IMPORT_FAILED";
}

async function recordImportError(path, {
  error,
  sourcePreserved,
  sourceSha256,
  occurredAt
}) {
  const artifact = {
    schema_version: 1,
    code: failureCode(error),
    source_preserved: sourcePreserved,
    source_path: SOURCE_PATH,
    source_sha256: sourceSha256,
    occurred_at: occurredAt,
    action: IMPORT_ACTION
  };
  await writeJsonImmutable(path, artifact);
}

export async function importClaudeProgress({
  workspaceRoot,
  pluginRoot,
  now = () => new Date(),
  idFactory = randomUUID,
  lockOptions = {},
  hooks = {}
} = {}) {
  validateIdFactory(idFactory);
  const importHooks = validateHooks(hooks);
  if (!isPlainObject(lockOptions)) {
    fail("IMPORT_OPTIONS_INVALID", "lockOptions must be an object");
  }
  const paths = pathsFor(workspaceRoot);
  return withRunLock(paths.lockPath, async () => {
    await assertNoExistingImport(workspaceRoot);
    const importDate = importedAtFrom(now);
    const importedAt = importDate.toISOString();
    const sourcePath = assertInside(
      workspaceRoot,
      join(workspaceRoot, "step_archive", "progress.json")
    );
    const baseName = `claude-progress-${timestampForPath(importDate)}`;
    const snapshotPath = assertInside(workspaceRoot, join(paths.importsDir, `${baseName}.json`));
    const metadataPath = assertInside(workspaceRoot, join(paths.importsDir, `${baseName}.meta.json`));
    let sourcePreserved = false;
    let sourceSha256 = null;
    let stateWritten = false;

    try {
      const [sourceBytes, sourceStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
      sourceSha256 = sha256(sourceBytes);
      await publishImmutableFile(snapshotPath, sourceBytes);
      sourcePreserved = true;
      await importHooks.afterSnapshot?.({ snapshotPath });

      const normalized = normalizeClaudeProgress(parseProgress(sourceBytes));
      const topicSha256 = await loadTopic(workspaceRoot);
      await loadStepDefinitions(pluginRoot);
      const workflowId = idFactory();
      if (typeof workflowId !== "string" || workflowId.trim() === "") {
        fail("IMPORT_OPTIONS_INVALID", "idFactory must return a non-empty workflow ID");
      }
      const metadata = {
        schema_version: 1,
        source_path: SOURCE_PATH,
        source_sha256: sourceSha256,
        size: sourceBytes.length,
        source_mtime: sourceStat.mtime.toISOString(),
        imported_at: importedAt,
        workflow_id: workflowId,
        normalized_prefix: normalized.completed_steps,
        warnings: normalized.warnings
      };
      await writeJsonImmutable(metadataPath, metadata);
      await importHooks.afterMetadata?.({ metadataPath });

      for (const step of normalized.completed_steps) {
        await writeReceiptExclusive(workspaceRoot, importedReceipt({
          workflowId,
          step,
          importedAt,
          sourceSha256
        }));
        await importHooks.afterReceipt?.({ step });
      }

      const state = importedState({
        workspaceRoot,
        workflowId,
        topicSha256,
        normalized,
        sourceSha256,
        importedAt
      });
      await importHooks.beforeStateWrite?.({ state });
      const durableState = await writeStateAtomic(workspaceRoot, state);
      stateWritten = true;
      await importHooks.beforeEvent?.({ state: durableState });
      const event = {
        kind: "claude_imported",
        workflow_id: workflowId,
        imported_prefix_count: normalized.completed_steps.length
      };
      if (durableState.current_step !== null) event.selected_step = durableState.current_step;
      await appendEvent(workspaceRoot, event, { now });
      return {
        state: durableState,
        warnings: normalized.warnings,
        snapshot_path: snapshotPath,
        metadata_path: metadataPath
      };
    } catch (error) {
      if (!stateWritten) {
        await recordImportError(paths.importErrorPath, {
          error,
          sourcePreserved,
          sourceSha256,
          occurredAt: importedAt
        });
      }
      throw error;
    }
  }, { ...lockOptions, now });
}

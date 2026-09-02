import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { HarnessError } from "./errors.mjs";
import { withRunLock } from "./lock.mjs";
import { assertInside, pathsFor } from "./paths.mjs";
import {
  receiptPath,
  syncDirectoryDurable,
  writeReceiptExclusive
} from "./receipts.mjs";
import { createInitialState, parseState, validateState } from "./schema.mjs";
import { appendEvent, writeStateAtomic } from "./state-store.mjs";

const STEP_COUNT = 50;
const SOURCE_PATH = "step_archive/progress.json";
const TOPIC_PATH = "step_archive/TOPIC/TOPIC.md";
const IMPORT_ACTION = "repair the Claude state or use a separate workspace";
const HOOK_NAMES = new Set([
  "afterSourceOpen",
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

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameNode(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile()
  );
}

function stableFileGeneration(left, right) {
  return (
    sameNode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function unsafePath(message, details = {}) {
  fail("IMPORT_PATH_UNSAFE", message, details);
}

async function physicalRoot(path, label) {
  if (typeof path !== "string" || path.trim() === "") {
    fail("IMPORT_OPTIONS_INVALID", `${label} root is required`);
  }
  const lexicalRoot = resolve(path);
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = await lstat(lexicalRoot, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      unsafePath(`${label} root must be a physical directory`, { path: lexicalRoot });
    }
    canonicalRoot = await realpath(lexicalRoot);
  } catch (error) {
    if (error?.code === "IMPORT_PATH_UNSAFE") throw error;
    unsafePath(`${label} root cannot be physically resolved`, { path: lexicalRoot });
  }
  if (!samePath(lexicalRoot, canonicalRoot)) {
    unsafePath(`${label} root cannot traverse a link or reparse point`, { path: lexicalRoot });
  }
  return { label, lexicalRoot, canonicalRoot, rootStat };
}

async function assertPhysicalPath(root, candidatePath, {
  allowMissing = true,
  kind = null
} = {}) {
  let lexicalPath;
  try {
    lexicalPath = assertInside(root.lexicalRoot, candidatePath);
  } catch {
    unsafePath(`${root.label} path escapes its physical root`);
  }

  let currentRootStat;
  let currentCanonicalRoot;
  try {
    currentRootStat = await lstat(root.lexicalRoot, { bigint: true });
    currentCanonicalRoot = await realpath(root.lexicalRoot);
  } catch {
    unsafePath(`${root.label} root changed during import`);
  }
  if (
    currentRootStat.isSymbolicLink() ||
    !currentRootStat.isDirectory() ||
    !sameNode(root.rootStat, currentRootStat) ||
    !samePath(root.canonicalRoot, currentCanonicalRoot)
  ) {
    unsafePath(`${root.label} root changed during import`);
  }

  const pathFromRoot = relative(root.lexicalRoot, lexicalPath);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    unsafePath(`${root.label} path escapes its physical root`, { path: lexicalPath });
  }
  const components = pathFromRoot === "" ? [] : pathFromRoot.split(sep);
  let currentPath = root.lexicalRoot;
  let finalStat = currentRootStat;
  for (let index = 0; index < components.length; index += 1) {
    currentPath = join(currentPath, components[index]);
    let beforeRealpath;
    try {
      beforeRealpath = await lstat(currentPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) {
        return { path: lexicalPath, exists: false, stat: null };
      }
      if (error?.code === "ENOENT") {
        unsafePath(`${root.label} path is missing`, { path: lexicalPath });
      }
      throw error;
    }
    if (beforeRealpath.isSymbolicLink()) {
      unsafePath(`${root.label} path traverses a link or reparse point`, { path: currentPath });
    }
    if (index < components.length - 1 && !beforeRealpath.isDirectory()) {
      unsafePath(`${root.label} path has a non-directory ancestor`, { path: currentPath });
    }

    let canonicalPath;
    let afterRealpath;
    try {
      canonicalPath = await realpath(currentPath);
      afterRealpath = await lstat(currentPath, { bigint: true });
    } catch {
      unsafePath(`${root.label} path changed during physical resolution`, { path: currentPath });
    }
    const expectedCanonical = join(root.canonicalRoot, ...components.slice(0, index + 1));
    if (
      afterRealpath.isSymbolicLink() ||
      !sameNode(beforeRealpath, afterRealpath) ||
      !samePath(canonicalPath, expectedCanonical)
    ) {
      unsafePath(`${root.label} path traverses or changed to a link or reparse point`, {
        path: currentPath
      });
    }
    finalStat = afterRealpath;
  }

  if (kind === "file" && !finalStat.isFile()) {
    unsafePath(`${root.label} path must be a physical file`, { path: lexicalPath });
  }
  if (kind === "directory" && !finalStat.isDirectory()) {
    unsafePath(`${root.label} path must be a physical directory`, { path: lexicalPath });
  }
  return { path: lexicalPath, exists: true, stat: finalStat };
}

async function secureEntries(root, path) {
  const before = await assertPhysicalPath(root, path, { kind: "directory" });
  if (!before.exists) return [];
  const result = await readdir(before.path);
  const after = await assertPhysicalPath(root, path, { allowMissing: false, kind: "directory" });
  if (!sameNode(before.stat, after.stat)) {
    unsafePath(`${root.label} directory changed while being read`, { path: before.path });
  }
  return result;
}

async function secureReadState(workspace, workspaceRoot) {
  const { statePath } = pathsFor(workspaceRoot);
  const checked = await assertPhysicalPath(workspace, statePath, { kind: "file" });
  if (!checked.exists) return null;
  const { bytes } = await readContainedFile(workspace, statePath, {
    missingCode: "IMPORT_INCOMPLETE",
    missingMessage: "Codex state disappeared during import",
    changedCode: "IMPORT_PATH_UNSAFE",
    changedMessage: "Codex state changed while being read"
  });
  return parseState(bytes.toString("utf8"));
}

async function assertNoExistingImport(workspace, workspaceRoot) {
  const paths = pathsFor(workspaceRoot);
  const stateEntry = await assertPhysicalPath(workspace, paths.statePath, { kind: "file" });
  if (stateEntry.exists) {
    try {
      if (await secureReadState(workspace, workspaceRoot)) {
        fail("CODEX_STATE_EXISTS", "a valid Codex state already exists");
      }
    } catch (error) {
      if (error?.code === "CODEX_STATE_EXISTS" || error?.code === "IMPORT_PATH_UNSAFE") throw error;
      fail("IMPORT_INCOMPLETE", "Codex state exists but is not a valid resumable import");
    }
  }

  const [receiptEntries, importEntries, importErrorEntry] = await Promise.all([
    secureEntries(workspace, paths.receiptsDir),
    secureEntries(workspace, paths.importsDir),
    assertPhysicalPath(workspace, paths.importErrorPath, { kind: "file" })
  ]);
  if (receiptEntries.length > 0 || importEntries.length > 0 || importErrorEntry.exists) {
    fail(
      "IMPORT_INCOMPLETE",
      "Codex import artifacts exist without valid state; use the recoverable reset path"
    );
  }
}

async function preflightWorkspacePaths(workspace, workspaceRoot) {
  const paths = pathsFor(workspaceRoot);
  const sourcePath = join(workspaceRoot, "step_archive", "progress.json");
  const topicPath = join(workspaceRoot, "step_archive", "TOPIC", "TOPIC.md");
  for (const [path, kind] of [
    [sourcePath, "file"],
    [topicPath, "file"],
    [paths.codexDir, "directory"],
    [paths.importsDir, "directory"],
    [paths.receiptsDir, "directory"],
    [paths.statePath, "file"],
    [paths.eventsPath, "file"],
    [paths.importErrorPath, "file"],
    [paths.lockPath, "directory"]
  ]) {
    await assertPhysicalPath(workspace, path, { kind });
  }
}

async function preflightPluginPaths(plugin, pluginRoot) {
  await assertPhysicalPath(
    plugin,
    join(pluginRoot, "codex", "assets", "steps", "index.json"),
    { kind: "file" }
  );
}

async function ensureDirectory(root, directoryPath) {
  await assertPhysicalPath(root, directoryPath, { kind: "directory" });
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  return assertPhysicalPath(root, directoryPath, { allowMissing: false, kind: "directory" });
}

async function publishImmutableFile(root, path, bytes) {
  const directoryPath = dirname(path);
  const directory = await ensureDirectory(root, directoryPath);
  const temporaryPath = join(
    directoryPath,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  await assertPhysicalPath(root, temporaryPath, { kind: "file" });
  await assertPhysicalPath(root, path, { kind: "file" });
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const temporary = await assertPhysicalPath(root, temporaryPath, {
      allowMissing: false,
      kind: "file"
    });
    const currentDirectory = await assertPhysicalPath(root, directoryPath, {
      allowMissing: false,
      kind: "directory"
    });
    if (!sameNode(directory.stat, currentDirectory.stat)) {
      unsafePath("import storage directory changed before publication", { path: directoryPath });
    }
    try {
      await link(temporary.path, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("IMPORT_ARTIFACT_EXISTS", "an import artifact already exists and will not be overwritten");
      }
      throw error;
    }
    await assertPhysicalPath(root, path, { allowMissing: false, kind: "file" });
    await unlink(temporary.path);
    temporaryExists = false;
    await syncDirectoryDurable(directoryPath);
    await assertPhysicalPath(root, directoryPath, { allowMissing: false, kind: "directory" });
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryExists) {
      await unlink(temporaryPath).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

async function writeJsonImmutable(root, path, value) {
  await publishImmutableFile(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readContainedFile(root, path, {
  missingCode,
  missingMessage,
  changedCode,
  changedMessage,
  afterOpen
}) {
  const checked = await assertPhysicalPath(root, path, { kind: "file" });
  if (!checked.exists) fail(missingCode, missingMessage);
  const flags = typeof fileConstants.O_NOFOLLOW === "number"
    ? fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW
    : "r";
  let handle;
  try {
    handle = await open(checked.path, flags);
    const before = await handle.stat({ bigint: true });
    const pathAtOpen = await assertPhysicalPath(root, checked.path, {
      allowMissing: false,
      kind: "file"
    });
    if (!sameNode(before, pathAtOpen.stat)) {
      fail(changedCode, changedMessage);
    }
    await afterOpen?.({ path: checked.path, stat: before });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfterRead = await assertPhysicalPath(root, checked.path, {
      allowMissing: false,
      kind: "file"
    });
    if (
      !stableFileGeneration(before, after) ||
      !sameNode(after, pathAfterRead.stat) ||
      after.size !== BigInt(bytes.length)
    ) {
      fail(changedCode, changedMessage);
    }
    return { bytes, stat: after };
  } catch (error) {
    if (error?.code === "ELOOP") unsafePath(`${root.label} file became a link`, { path });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
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

async function loadTopic(workspace, workspaceRoot) {
  const topicPath = join(workspaceRoot, "step_archive", "TOPIC", "TOPIC.md");
  const { bytes } = await readContainedFile(workspace, topicPath, {
    missingCode: "CLAUDE_TOPIC_MISSING",
    missingMessage: "the required Claude topic is missing",
    changedCode: "IMPORT_PATH_UNSAFE",
    changedMessage: "the Claude topic changed while being read"
  });
  if (bytes.length === 0 || bytes.toString("utf8").trim() === "") {
    fail("CLAUDE_TOPIC_MISSING", "the required Claude topic is empty");
  }
  return sha256(bytes);
}

async function loadStepDefinitions(plugin, pluginRoot) {
  const indexPath = join(pluginRoot, "codex", "assets", "steps", "index.json");
  let index;
  try {
    const { bytes } = await readContainedFile(plugin, indexPath, {
      missingCode: "CODEX_STEP_DEFINITIONS",
      missingMessage: "Codex step definitions are missing",
      changedCode: "IMPORT_PATH_UNSAFE",
      changedMessage: "Codex step definitions changed while being read"
    });
    index = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "IMPORT_PATH_UNSAFE") throw error;
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
    const definitionPath = join(pluginRoot, ...target.split("/"));
    let contents;
    try {
      const { bytes } = await readContainedFile(plugin, definitionPath, {
        missingCode: "CODEX_STEP_DEFINITIONS",
        missingMessage: `Codex definition ${id} is missing`,
        changedCode: "IMPORT_PATH_UNSAFE",
        changedMessage: `Codex definition ${id} changed while being read`
      });
      contents = bytes.toString("utf8");
    } catch (error) {
      if (error?.code === "IMPORT_PATH_UNSAFE") throw error;
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

async function recordImportError(workspace, path, {
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
  await writeJsonImmutable(workspace, path, artifact);
}

export async function importClaudeProgress({
  workspaceRoot,
  pluginRoot,
  now = () => new Date(),
  idFactory = randomUUID,
  lockOptions = {},
  hooks = {},
  stateWriter = writeStateAtomic
} = {}) {
  validateIdFactory(idFactory);
  const importHooks = validateHooks(hooks);
  if (!isPlainObject(lockOptions)) {
    fail("IMPORT_OPTIONS_INVALID", "lockOptions must be an object");
  }
  if (typeof stateWriter !== "function") {
    fail("IMPORT_OPTIONS_INVALID", "stateWriter must be a function");
  }
  const workspace = await physicalRoot(workspaceRoot, "workspace");
  const plugin = await physicalRoot(pluginRoot, "plugin");
  const safeWorkspaceRoot = workspace.lexicalRoot;
  const safePluginRoot = plugin.lexicalRoot;
  const paths = pathsFor(safeWorkspaceRoot);
  await preflightWorkspacePaths(workspace, safeWorkspaceRoot);
  await preflightPluginPaths(plugin, safePluginRoot);

  return withRunLock(paths.lockPath, async () => {
    await assertPhysicalPath(workspace, paths.lockPath, {
      allowMissing: false,
      kind: "directory"
    });
    await preflightWorkspacePaths(workspace, safeWorkspaceRoot);
    await preflightPluginPaths(plugin, safePluginRoot);
    await assertNoExistingImport(workspace, safeWorkspaceRoot);
    const importDate = importedAtFrom(now);
    const importedAt = importDate.toISOString();
    const sourcePath = join(safeWorkspaceRoot, "step_archive", "progress.json");
    const baseName = `claude-progress-${timestampForPath(importDate)}`;
    const snapshotPath = assertInside(safeWorkspaceRoot, join(paths.importsDir, `${baseName}.json`));
    const metadataPath = assertInside(safeWorkspaceRoot, join(paths.importsDir, `${baseName}.meta.json`));
    let sourcePreserved = false;
    let sourceSha256 = null;
    let stateWritten = false;
    let expectedState = null;

    try {
      const { bytes: sourceBytes, stat: sourceStat } = await readContainedFile(workspace, sourcePath, {
        missingCode: "CLAUDE_PROGRESS_MISSING",
        missingMessage: "Claude progress.json is missing",
        changedCode: "CLAUDE_SOURCE_CHANGED",
        changedMessage: "Claude progress.json changed while being read",
        afterOpen: importHooks.afterSourceOpen
      });
      sourceSha256 = sha256(sourceBytes);
      await publishImmutableFile(workspace, snapshotPath, sourceBytes);
      sourcePreserved = true;
      await importHooks.afterSnapshot?.({ snapshotPath });

      const normalized = normalizeClaudeProgress(parseProgress(sourceBytes));
      const topicSha256 = await loadTopic(workspace, safeWorkspaceRoot);
      await loadStepDefinitions(plugin, safePluginRoot);
      const workflowId = idFactory();
      if (typeof workflowId !== "string" || workflowId.trim() === "") {
        fail("IMPORT_OPTIONS_INVALID", "idFactory must return a non-empty workflow ID");
      }
      const metadata = {
        schema_version: 1,
        source_path: SOURCE_PATH,
        source_sha256: sourceSha256,
        size: sourceBytes.length,
        source_mtime: new Date(Number((sourceStat.mtimeNs + 500_000n) / 1_000_000n)).toISOString(),
        imported_at: importedAt,
        workflow_id: workflowId,
        normalized_prefix: normalized.completed_steps,
        warnings: normalized.warnings
      };
      await writeJsonImmutable(workspace, metadataPath, metadata);
      await importHooks.afterMetadata?.({ metadataPath });

      for (const step of normalized.completed_steps) {
        await assertPhysicalPath(workspace, paths.receiptsDir, { kind: "directory" });
        await writeReceiptExclusive(safeWorkspaceRoot, importedReceipt({
          workflowId,
          step,
          importedAt,
          sourceSha256
        }));
        await assertPhysicalPath(workspace, paths.receiptsDir, {
          allowMissing: false,
          kind: "directory"
        });
        await assertPhysicalPath(workspace, receiptPath(safeWorkspaceRoot, step), {
          allowMissing: false,
          kind: "file"
        });
        await importHooks.afterReceipt?.({ step });
      }

      expectedState = importedState({
        workspaceRoot: safeWorkspaceRoot,
        workflowId,
        topicSha256,
        normalized,
        sourceSha256,
        importedAt
      });
      await importHooks.beforeStateWrite?.({ state: expectedState });
      await assertPhysicalPath(workspace, paths.statePath, { kind: "file" });
      let writerResult;
      try {
        writerResult = await stateWriter(safeWorkspaceRoot, expectedState);
      } catch (error) {
        let visibleState = null;
        try {
          visibleState = await secureReadState(workspace, safeWorkspaceRoot);
        } catch (probeError) {
          if (probeError?.code === "IMPORT_PATH_UNSAFE") throw probeError;
        }
        if (visibleState !== null && JSON.stringify(visibleState) === JSON.stringify(expectedState)) {
          stateWritten = true;
          throw new HarnessError(
            "IMPORT_STATE_DURABILITY_AMBIGUOUS",
            "the matching imported state is visible after a state durability failure",
            { cause_code: typeof error?.code === "string" ? error.code : "UNKNOWN" }
          );
        }
        throw error;
      }
      const durableState = await secureReadState(workspace, safeWorkspaceRoot);
      if (
        durableState === null ||
        JSON.stringify(durableState) !== JSON.stringify(expectedState) ||
        JSON.stringify(writerResult) !== JSON.stringify(expectedState)
      ) {
        fail("IMPORT_STATE_PUBLISH_MISMATCH", "state writer did not publish the expected imported state");
      }
      stateWritten = true;
      await importHooks.beforeEvent?.({ state: durableState });
      const event = {
        kind: "claude_imported",
        workflow_id: workflowId,
        imported_prefix_count: normalized.completed_steps.length
      };
      if (durableState.current_step !== null) event.selected_step = durableState.current_step;
      await assertPhysicalPath(workspace, paths.eventsPath, { kind: "file" });
      await appendEvent(safeWorkspaceRoot, event, { now });
      await assertPhysicalPath(workspace, paths.eventsPath, {
        allowMissing: false,
        kind: "file"
      });
      return {
        state: durableState,
        warnings: normalized.warnings,
        snapshot_path: snapshotPath,
        metadata_path: metadataPath
      };
    } catch (error) {
      if (!stateWritten && error?.code !== "IMPORT_PATH_UNSAFE") {
        await recordImportError(workspace, paths.importErrorPath, {
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

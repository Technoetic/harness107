import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STEP_COUNT = 50;
const PHASES = new Set([
  "preflight", "tooling", "research", "planning", "implementation", "review", "e2e"
]);
const ACCEPTANCE_KINDS = new Set(["command", "artifact", "check"]);
const RETIRED_VALIDATOR = /\b(?:tokei|dependency|research-chunk|research|build|c8|biome|linting|formatting|stylelint|semgrep|playwright|e2e|ui-regression|accessibility|axe-core|jscpd|madge|knip|deadcode|lhci|load-test|type-safety|refactoring|step03)-(?:validator|checker)\.(?:ps1|sh)\b/gi;

function fail(message) {
  throw new Error(message);
}

function canonicalId(number) {
  return `step${String(number).padStart(3, "0")}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

function workspacePath(root, value, label) {
  requireString(value, label);
  if (isAbsolute(value)) fail(`${label} must be workspace-relative`);
  const absolute = resolve(root, value);
  const pathFromRoot = relative(root, absolute);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    fail(`${label} escapes the workspace`);
  }
  return absolute;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateAcceptance(entry, repoRoot) {
  if (!Array.isArray(entry.acceptance)) fail(`${entry.id}.acceptance must be an array`);
  const ids = new Set();
  let hasRequiredScreenshotArtifact = false;
  let hasRequiredCheck = false;

  for (const item of entry.acceptance) {
    if (!isPlainObject(item)) fail(`${entry.id}.acceptance items must be objects`);
    requireString(item.id, `${entry.id}.acceptance id`);
    if (ids.has(item.id)) fail(`${entry.id}.acceptance ids must be unique`);
    ids.add(item.id);
    if (!ACCEPTANCE_KINDS.has(item.kind)) fail(`${entry.id}.acceptance kind is invalid`);
    if (typeof item.required !== "boolean") fail(`${entry.id}.acceptance required must be boolean`);
    requireString(item.description, `${entry.id}.acceptance description`);

    if (item.kind === "artifact") {
      workspacePath(repoRoot, item.path, `${entry.id}.acceptance artifact path`);
      if (item.required && (/screenshot/i.test(item.id) || /screenshot/i.test(item.path))) {
        hasRequiredScreenshotArtifact = true;
      }
    }
    if (item.kind === "command") {
      const declaration = item.command ?? item.command_pattern;
      requireString(declaration, `${entry.id}.acceptance command`);
    }
    if (item.kind === "check" && item.required) hasRequiredCheck = true;
  }

  if (entry.visual_review && (!hasRequiredScreenshotArtifact || !hasRequiredCheck)) {
    fail(`${entry.id}.visual_review requires a required screenshot artifact and required check`);
  }
}

function validateFinalMetadata(entry, repoRoot) {
  for (const field of [
    "inputs", "outputs", "requires", "optional_requires", "acceptance"
  ]) {
    if (!Array.isArray(entry[field])) fail(`${entry.id}.${field} must be an array`);
  }
  if (typeof entry.network !== "boolean") fail(`${entry.id}.network must be boolean`);
  if (typeof entry.visual_review !== "boolean") fail(`${entry.id}.visual_review must be boolean`);
  validateAcceptance(entry, repoRoot);
}

function validatePortedEntry(entry, repoRoot) {
  const targetPath = workspacePath(repoRoot, entry.target, `${entry.id}.target`);
  if (!existsSync(targetPath)) fail(`missing Codex step: ${entry.target}`);
  if (entry.ported !== true) fail(`${entry.id} must be marked ported`);
  validateFinalMetadata(entry, repoRoot);
  const diagnostics = scanForbiddenTokens(readFileSync(targetPath, "utf8"));
  if (diagnostics.length > 0) {
    fail(`${entry.id} contains forbidden token(s): ${diagnostics.map((item) => item.code).join(", ")}`);
  }
}

export async function loadIndex(repoRoot) {
  const indexPath = resolve(repoRoot, "codex", "assets", "steps", "index.json");
  return JSON.parse(await readFile(indexPath, "utf8"));
}

export function scanForbiddenTokens(content) {
  requireString(content, "content");
  const rules = [
    ["MODEL_SPECIFIC", /\b(?:Claude|Haiku|Sonnet)\b/gi],
    ["TOOL_SPECIFIC", /\b(?:Read|Write|Edit|Bash|Task|WebFetch|WebSearch)\b/gi],
    ["CLAUDE_PATH", /\.claude(?:[\\/]|\b)/gi],
    ["STALE_STEP", /\bsteps?\s*(?:0?(?:69|81|84)|104|107)\b/gi],
    ["RETIRED_VALIDATOR", RETIRED_VALIDATOR]
  ];
  const diagnostics = [];
  for (const [code, pattern] of rules) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match) diagnostics.push({ code, token: match[0], index: match.index });
  }
  return diagnostics;
}

export async function recordSourceHashes(repoRoot, entries) {
  const sourceEntries = Array.isArray(entries) ? entries : entries.steps;
  if (!Array.isArray(sourceEntries)) fail("entries must be an array or index object");
  const hashes = {};
  for (const entry of sourceEntries) {
    requireString(entry?.id, "entry id");
    const sourcePath = workspacePath(repoRoot, entry.source, `${entry.id}.source`);
    hashes[entry.id] = sha256(await readFile(sourcePath));
  }
  return hashes;
}

export function validateIndex(index, { repoRoot, requirePorted = false } = {}) {
  if (!isPlainObject(index) || index.schema_version !== 1 || !Array.isArray(index.steps)) {
    fail("index must have schema_version 1 and a steps array");
  }
  if (typeof repoRoot !== "string" || repoRoot === "") fail("repoRoot is required");
  if (index.steps.length !== STEP_COUNT) fail(`index must contain exactly ${STEP_COUNT} steps`);

  const numbers = new Set();
  for (const entry of index.steps) {
    if (!isPlainObject(entry)) fail("step entry must be an object");
    if (!Number.isInteger(entry.number) || entry.number < 1 || entry.number > STEP_COUNT) {
      fail("step numbers must be integers from 1 through 50");
    }
    numbers.add(entry.number);
  }
  for (let number = 1; number <= STEP_COUNT; number += 1) {
    if (!numbers.has(number)) fail(`index has a gap at step ${number}`);
  }

  const ids = new Set();
  for (const entry of index.steps) {
    const id = canonicalId(entry.number);
    if (entry.id !== id || ids.has(entry.id)) fail(`step ${entry.number} has a non-canonical id`);
    ids.add(entry.id);
    requireString(entry.title, `${id}.title`);
    if (!PHASES.has(entry.phase)) fail(`${id}.phase is invalid`);
    if (entry.source !== `assets/steps/${id}.md`) fail(`${id}.source is not canonical`);
    if (entry.target !== `codex/assets/steps/${id}.md`) fail(`${id}.target is not canonical`);
    const sourcePath = workspacePath(repoRoot, entry.source, `${id}.source`);
    if (!existsSync(sourcePath)) fail(`missing Claude source step: ${entry.source}`);
    if (!/^[a-f0-9]{64}$/.test(entry.source_sha256 ?? "")) fail(`${id}.source_sha256 is invalid`);
    const actualHash = sha256(readFileSync(sourcePath));
    if (actualHash !== entry.source_sha256) {
      fail(`SOURCE_CHANGED_REVIEW_REQUIRED: ${entry.source} expected ${entry.source_sha256} actual ${actualHash}`);
    }
    const expectedNext = entry.number === STEP_COUNT ? null : canonicalId(entry.number + 1);
    if (entry.next !== expectedNext) fail(`${id}.next must be ${expectedNext ?? "null"}`);
    if (entry.ported !== false && entry.ported !== true) fail(`${id}.ported must be boolean`);
    if (entry.ported || requirePorted) validatePortedEntry(entry, repoRoot);
  }
  return { steps: index.steps };
}

export async function validateStepBatch(repoRoot, numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) fail("numbers must be a non-empty array");
  const index = await loadIndex(repoRoot);
  const report = validateIndex(index, { repoRoot, requirePorted: false });
  const selected = [];
  for (const number of numbers) {
    if (!Number.isInteger(number) || number < 1 || number > STEP_COUNT) fail("batch step numbers must be 1 through 50");
    const entry = report.steps[number - 1];
    validatePortedEntry(entry, repoRoot);
    selected.push(entry);
  }
  return { steps: selected };
}

function parseRange(value) {
  const match = /^(\d+):(\d+)$/.exec(value ?? "");
  if (!match) fail("--range must use start:end");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) fail("--range is invalid");
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rangeIndex = process.argv.indexOf("--range");
  const report = rangeIndex === -1
    ? validateIndex(await loadIndex(repoRoot), { repoRoot, requirePorted: false })
    : await validateStepBatch(repoRoot, parseRange(process.argv[rangeIndex + 1]));
  process.stdout.write(`validated ${report.steps.length} indexed step(s)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

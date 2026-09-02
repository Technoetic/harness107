import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessError } from "./lib/errors.mjs";

const STEP_COUNT = 50;
const PHASES = new Set([
  "preflight", "tooling", "research", "planning", "implementation", "review", "e2e"
]);
const ACCEPTANCE_KINDS = new Set(["command", "artifact", "check"]);
const TOP_LEVEL_KEYS = ["schema_version", "steps"];
const STEP_KEYS = [
  "number", "id", "title", "phase", "source", "target", "source_sha256", "inputs",
  "outputs", "requires", "optional_requires", "network", "visual_review", "acceptance",
  "ported", "next"
];
const ACCEPTANCE_COMMON_KEYS = ["id", "kind", "required", "description"];
const INITIAL_INPUTS = new Set(["step_archive/TOPIC/TOPIC.md", "package.json"]);
const VISUAL_STEPS = new Set([22, 23, 24, 29, 37, 39, 40, 43, 46, 47, 48, 49]);
const TARGET_AUXILIARY_FILES = new Set(["index.json", "PORTING.md"]);
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

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function requireUniqueStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const value of values) {
    requireString(value, `${label} item`);
    if (seen.has(value)) fail(`${label} contains a duplicate: ${value}`);
    seen.add(value);
  }
}

function expectedPhase(number) {
  if (number <= 5) return "preflight";
  if (number <= 15) return "tooling";
  if (number <= 24) return "research";
  if (number <= 30) return "planning";
  if (number <= 38) return "implementation";
  if (number <= 44) return "review";
  return "e2e";
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

function validatePortablePath(value, label) {
  requireString(value, label);
  if (value !== value.trim() || value !== value.normalize("NFC")) {
    fail(`${label} must be a normalized NFC portable path`);
  }
  if (
    value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)
  ) {
    fail(`${label} must be a portable workspace-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} must be a normalized portable path without empty, dot, or parent segments`);
  }
  if (segments.some((segment) => (
    /[<>:"|?*\u0000-\u001f]/.test(segment)
    || /[ .]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ))) {
    fail(`${label} must use portable filename segments`);
  }
  return value;
}

function hasTopLevelAlternation(pattern) {
  let depth = 0;
  let escaped = false;
  let inClass = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "|" && depth === 0) return true;
  }
  return false;
}

function validateCommandPattern(pattern, label) {
  requireString(pattern, label);
  let precedingBackslashes = 0;
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === "\\"; index -= 1) {
    precedingBackslashes += 1;
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || precedingBackslashes % 2 === 1) {
    fail(`${label} must be anchored with ^ and $`);
  }
  if (hasTopLevelAlternation(pattern)) fail(`${label} must not use top-level alternation`);
  try {
    new RegExp(pattern);
  } catch {
    fail(`${label} must be a valid regular expression`);
  }
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

function validateStrictAcceptance(entry) {
  if (!Array.isArray(entry.acceptance) || entry.acceptance.length === 0) {
    fail(`${entry.id}.acceptance must be a non-empty array`);
  }
  const ids = new Set();
  for (const [offset, item] of entry.acceptance.entries()) {
    const label = `${entry.id}.acceptance[${offset}]`;
    if (!isPlainObject(item)) fail(`${label} must be an object`);
    if (!ACCEPTANCE_KINDS.has(item.kind)) fail(`${label}.kind is invalid`);
    const hasCommand = Object.hasOwn(item, "command");
    const hasPattern = Object.hasOwn(item, "command_pattern");
    if (item.kind === "command" && hasCommand === hasPattern) {
      fail(`${label} command declaration must contain exactly one command or command_pattern`);
    }
    const expectedKeys = item.kind === "artifact"
      ? [...ACCEPTANCE_COMMON_KEYS, "path"]
      : item.kind === "command"
        ? [...ACCEPTANCE_COMMON_KEYS, hasCommand ? "command" : "command_pattern"]
        : ACCEPTANCE_COMMON_KEYS;
    exactKeys(item, expectedKeys, `${label} acceptance`);
    requireString(item.id, `${label}.id`);
    if (ids.has(item.id)) fail(`${entry.id}.acceptance ids must be unique`);
    ids.add(item.id);
    if (typeof item.required !== "boolean") fail(`${label}.required must be boolean`);
    requireString(item.description, `${label}.description`);
    if (item.kind === "artifact") validatePortablePath(item.path, `${label}.path`);
    if (item.kind === "command") {
      if (hasCommand) requireString(item.command, `${label}.command`);
      else validateCommandPattern(item.command_pattern, `${label}.command_pattern`);
    }
  }
}

function validateStrictSchema(index) {
  exactKeys(index, TOP_LEVEL_KEYS, "index top-level");
  if (index.schema_version !== 1) fail("index.schema_version must be 1");
  if (!Array.isArray(index.steps) || index.steps.length !== STEP_COUNT) {
    fail(`index must contain exactly ${STEP_COUNT} steps`);
  }
  for (let offset = 0; offset < index.steps.length; offset += 1) {
    const number = offset + 1;
    const id = canonicalId(number);
    const entry = index.steps[offset];
    exactKeys(entry, STEP_KEYS, `${id} row`);
    if (entry.number !== number) fail(`${id} row is out of order at position ${number}`);
    if (entry.id !== id) fail(`step ${number} has a non-canonical id`);
    requireString(entry.title, `${id}.title`);
    const phase = expectedPhase(number);
    if (entry.phase !== phase) fail(`${id}.phase must be ${phase}`);
    if (entry.source !== `assets/steps/${id}.md`) fail(`${id}.source is not canonical`);
    if (entry.target !== `codex/assets/steps/${id}.md`) fail(`${id}.target is not canonical`);
    if (!/^[a-f0-9]{64}$/.test(entry.source_sha256)) fail(`${id}.source_sha256 is invalid`);
    const expectedNext = number === STEP_COUNT ? null : canonicalId(number + 1);
    if (entry.next !== expectedNext) fail(`${id}.next must be ${expectedNext ?? "null"}`);
    if (entry.ported !== true) fail(`${id}.ported must be true for repository parity`);
    for (const field of ["inputs", "outputs", "requires", "optional_requires"]) {
      requireUniqueStrings(entry[field], `${id}.${field}`);
    }
    if (typeof entry.network !== "boolean") fail(`${id}.network must be boolean`);
    if (typeof entry.visual_review !== "boolean") fail(`${id}.visual_review must be boolean`);
    validateStrictAcceptance(entry);
  }
}

async function validateStepDirectory(repoRoot, relativeDirectory, allowedAuxiliary = new Set()) {
  const directory = resolve(repoRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail(`missing step directory: ${relativeDirectory}`);
  }
  const expected = new Set(
    Array.from({ length: STEP_COUNT }, (_, offset) => `${canonicalId(offset + 1)}.md`)
  );
  const allowed = new Set([...expected, ...allowedAuxiliary]);
  const unexpected = entries.map((entry) => entry.name).filter((name) => !allowed.has(name)).sort();
  if (unexpected.length > 0) {
    fail(`${relativeDirectory} contains unexpected step file(s): ${unexpected.join(", ")}`);
  }
  const actual = new Set(entries.map((entry) => entry.name));
  for (const name of expected) {
    if (!actual.has(name)) fail(`${relativeDirectory} is missing canonical step file ${name}`);
    const path = resolve(directory, name);
    const status = await lstat(path);
    if (status.isSymbolicLink()) fail(`${relativeDirectory}/${name} must not be a symbolic link`);
    if (!status.isFile()) fail(`${relativeDirectory}/${name} must be a regular file`);
  }
}

function findMarkdownAtxH1Lines(content) {
  const headings = [];
  let fence = null;
  for (const line of content.split("\n")) {
    if (fence !== null) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (
        closing && closing[1][0] === fence.character
        && closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = /^( {0,3})#(?:[ \t]+.*|[ \t]*)$/.exec(line);
    if (heading) headings.push({ indentation: heading[1].length, line });
  }
  return headings;
}

function validateTargetDocument(entry, content) {
  const normalized = content.replaceAll("\r\n", "\n");
  const frontmatterMatch = /^---\n([^]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) fail(`${entry.id} target is missing frontmatter`);
  const frontmatter = {};
  for (const line of frontmatterMatch[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) fail(`${entry.id} frontmatter is invalid`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (Object.hasOwn(frontmatter, key)) fail(`${entry.id} has a duplicate frontmatter key: ${key}`);
    frontmatter[key] = value;
  }
  exactKeys(frontmatter, ["name", "phase"], `${entry.id} frontmatter`);
  if (frontmatter.name !== entry.id) fail(`${entry.id} frontmatter name must match the index`);
  if (frontmatter.phase !== entry.phase) fail(`${entry.id} frontmatter phase must match the index`);
  const headings = findMarkdownAtxH1Lines(normalized);
  if (headings.length !== 1) fail(`${entry.id} target must contain exactly one H1`);
  const expectedHeading = `# Step ${entry.number} - ${entry.title}`;
  if (headings[0].line !== expectedHeading) {
    if (headings[0].indentation > 0 && headings[0].line.trimStart() === expectedHeading) {
      fail(`${entry.id} canonical H1 must start at column zero`);
    }
    fail(`${entry.id} H1 must be ${expectedHeading}`);
  }
}

function validatePathAndGraphParity(index) {
  const observedSpellings = new Map();
  const registerPath = (value, label) => {
    validatePortablePath(value, label);
    const identity = value.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = observedSpellings.get(identity);
    if (previous !== undefined && previous !== value) {
      fail(`${label} has a case or NFC path collision with ${previous}`);
    }
    observedSpellings.set(identity, value);
  };
  const owners = new Map();

  for (const entry of index.steps) {
    for (const input of entry.inputs) registerPath(input, `${entry.id}.input`);
    for (const output of entry.outputs) {
      registerPath(output, `${entry.id}.output`);
      if (INITIAL_INPUTS.has(output)) fail(`${entry.id}.output claims reserved initial input ${output}`);
      if (owners.has(output)) fail(`${output} has a duplicate output owner`);
      owners.set(output, entry);
    }
    for (const item of entry.acceptance) {
      if (item.kind === "artifact") registerPath(item.path, `${entry.id}.${item.id}.artifact path`);
    }
  }

  for (const entry of index.steps) {
    const required = new Set(entry.requires);
    const optional = new Set(entry.optional_requires);
    for (const dependency of [...entry.requires, ...entry.optional_requires]) {
      if (!/^step(?:00[1-9]|0[1-4][0-9]|050)$/.test(dependency)) {
        fail(`${entry.id} dependency must be a canonical step001 through step050 id`);
      }
      const dependencyNumber = Number(dependency.slice(4));
      const label = optional.has(dependency) ? "optional_requires" : "requires";
      if (dependencyNumber >= entry.number) fail(`${entry.id}.${label} must reference prior steps only`);
    }
    for (const dependency of required) {
      if (optional.has(dependency)) fail(`${entry.id} required and optional dependencies must be disjoint`);
    }
    for (const input of entry.inputs) {
      if (INITIAL_INPUTS.has(input)) continue;
      const owner = owners.get(input);
      if (!owner) fail(`${entry.id}.input is unresolved and is not an approved initial input: ${input}`);
      if (owner.number >= entry.number) fail(`${entry.id} has a future input from ${owner.id}: ${input}`);
      if (!required.has(owner.id)) fail(`${entry.id} must directly require owner ${owner.id} for input ${input}`);
    }
    for (const dependency of required) {
      const consumed = entry.inputs.some((input) => owners.get(input)?.id === dependency);
      if (!consumed) fail(`${entry.id}.requires has unused dependency ${dependency}; no owned output is an input`);
    }
    for (const output of entry.outputs) {
      if (!entry.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      ))) {
        fail(`${entry.id}.output lacks required artifact acceptance: ${output}`);
      }
    }
    for (const item of entry.acceptance.filter((candidate) => candidate.kind === "artifact" && candidate.required)) {
      if (!entry.inputs.includes(item.path) && !entry.outputs.includes(item.path)) {
        fail(`${entry.id}.${item.id} required artifact path is not a declared input or output`);
      }
    }
  }
}

function validateVisualParity(index) {
  for (const entry of index.steps) {
    const expected = VISUAL_STEPS.has(entry.number);
    if (entry.visual_review !== expected) {
      fail(`${entry.id}.visual_review must match the exact visual step set`);
    }
    if (!expected) continue;
    const hasScreenshot = entry.acceptance.some((item) => (
      item.kind === "artifact" && item.required
      && (entry.inputs.includes(item.path) || entry.outputs.includes(item.path))
      && /\.(?:png|jpe?g|webp)$/i.test(item.path)
    ));
    if (!hasScreenshot) fail(`${entry.id}.visual_review requires a required screenshot output`);
    const hasInspection = entry.acceptance.some((item) => (
      item.kind === "check" && item.required
      && /(?:visual|screenshot|capture)[^]*(?:inspect|open|compare)|(?:inspect|open|compare)[^]*(?:visual|screenshot|capture)/i
        .test(`${item.id} ${item.description}`)
    ));
    if (!hasInspection) fail(`${entry.id}.visual_review requires a required visual inspection check`);
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
      throw new HarnessError(
        "SOURCE_CHANGED_REVIEW_REQUIRED",
        `SOURCE_CHANGED_REVIEW_REQUIRED: ${entry.source} expected ${entry.source_sha256} actual ${actualHash}`,
        { source: entry.source, expected: entry.source_sha256, actual: actualHash }
      );
    }
    const expectedNext = entry.number === STEP_COUNT ? null : canonicalId(entry.number + 1);
    if (entry.next !== expectedNext) fail(`${id}.next must be ${expectedNext ?? "null"}`);
    if (entry.ported !== false && entry.ported !== true) fail(`${id}.ported must be boolean`);
    if (entry.ported || requirePorted) validatePortedEntry(entry, repoRoot);
  }
  return { steps: index.steps };
}

export async function validateRepositoryParity(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot === "") fail("repoRoot is required");
  const index = await loadIndex(repoRoot);
  validateStrictSchema(index);
  await validateStepDirectory(repoRoot, "assets/steps");
  await validateStepDirectory(repoRoot, "codex/assets/steps", TARGET_AUXILIARY_FILES);
  const report = validateIndex(index, { repoRoot, requirePorted: true });
  validatePathAndGraphParity(index);
  validateVisualParity(index);
  for (const entry of index.steps) {
    validateTargetDocument(entry, await readFile(resolve(repoRoot, entry.target), "utf8"));
  }
  return report;
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
  const args = process.argv.slice(2);
  let report;
  if (args.length === 0) {
    report = await validateRepositoryParity(repoRoot);
  } else if (args.length === 2 && args[0] === "--range") {
    report = await validateStepBatch(repoRoot, parseRange(args[1]));
  } else {
    fail("invalid arguments; usage: validate-steps.mjs [--range start:end]");
  }
  process.stdout.write(`validated ${report.steps.length} indexed step(s)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  readFile,
  realpath
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { HarnessError } from "./errors.mjs";
import { sanitizeEvidence } from "./receipts.mjs";
import { validateHtmlBytes } from "../../../scripts/lib/html-document.mjs";
import { validateBrowserReportBytes } from "../../../scripts/lib/browser-report.mjs";

const STEP_COUNT = 50;
const SHA256 = /^[a-f0-9]{64}$/;
const STEP_KEYS = new Set([
  "number", "id", "title", "phase", "source", "target", "source_sha256", "inputs",
  "outputs", "requires", "optional_requires", "network", "visual_review", "acceptance",
  "ported", "next"
]);
const ACCEPTANCE_COMMON_KEYS = ["id", "kind", "required", "description"];
const EVIDENCE_COMMON_KEYS = ["acceptance_id", "kind", "detail", "ok"];
const ACCEPTANCE_KINDS = new Set(["artifact", "command", "check"]);

function fail(code, message, details = {}) {
  throw new HarnessError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, expected, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    fail(code, `${label} has an invalid shape`);
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalStepId(step) {
  return `step${String(step).padStart(3, "0")}`;
}

function expectedPhase(step) {
  if (step <= 5) return "preflight";
  if (step <= 15) return "tooling";
  if (step <= 24) return "research";
  if (step <= 30) return "planning";
  if (step <= 38) return "implementation";
  if (step <= 44) return "review";
  return "e2e";
}

function uniqueStringArray(value) {
  return Array.isArray(value) &&
    value.every(item => nonempty(item)) &&
    new Set(value).size === value.length;
}

function requireStep(step) {
  if (!Number.isInteger(step) || step < 1 || step > STEP_COUNT) {
    fail("STEP_CONTRACT_INVALID", `step must be an integer from 1 through ${STEP_COUNT}`);
  }
  return step;
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameNode(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs;
}

function portablePath(value) {
  if (!nonempty(value) || value !== value.trim() || value !== value.normalize("NFC")) return false;
  if (
    value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some(segment => (
    segment === "" || segment === "." || segment === ".." ||
    /[<>:"|?*\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ));
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

function containedPath(root, portable, code) {
  if (!portablePath(portable)) fail(code, "artifact path must be a portable workspace-relative path");
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...portable.split("/"));
  const fromRoot = relative(absoluteRoot, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(code, "artifact path escapes the workspace");
  }
  return absolute;
}

async function physicalRoot(rawRoot, code) {
  if (!nonempty(rawRoot)) fail(code, "root must be a non-empty directory path");
  const root = resolve(rawRoot);
  let before;
  let canonical;
  let after;
  try {
    before = await lstat(root, { bigint: true });
    canonical = await realpath(root);
    after = await lstat(root, { bigint: true });
  } catch (error) {
    fail(code, "root must be a physical directory", {
      cause_code: typeof error?.code === "string" ? error.code : "INVALID"
    });
  }
  if (
    before.isSymbolicLink() || !before.isDirectory() || !sameNode(before, after) ||
    !samePath(root, canonical)
  ) {
    fail(code, "root must be a stable physical directory");
  }
  return { root, snapshot: after };
}

async function physicalFile(root, path, {
  missingCode,
  unsafeCode,
  requireSingleLink = true
}) {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(unsafeCode, "file escapes its physical root");
  }
  const segments = fromRoot.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let before;
    let canonical;
    let after;
    try {
      before = await lstat(current, { bigint: true });
      canonical = await realpath(current);
      after = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        fail(missingCode, "required file is missing");
      }
      fail(unsafeCode, "required file could not be inspected", {
        cause_code: typeof error?.code === "string" ? error.code : "INVALID"
      });
    }
    if (before.isSymbolicLink() || !sameNode(before, after) || !samePath(current, canonical)) {
      fail(unsafeCode, "required file traverses an alias or changed during inspection");
    }
    const final = index === segments.length - 1;
    if (final) {
      if (!after.isFile()) fail(missingCode, "required path is not a regular file");
      if (requireSingleLink && after.nlink !== 1n) fail(unsafeCode, "required file must not be aliased");
      return after;
    }
    if (!after.isDirectory()) fail(missingCode, "required file has a non-directory parent");
  }
  fail(missingCode, "required file is missing");
}

function validateAcceptanceDeclarations(contract) {
  if (!isPlainObject(contract) || !Number.isInteger(contract.number) || !nonempty(contract.id)) {
    fail("STEP_CONTRACT_INVALID", "step contract is invalid");
  }
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) {
    fail("STEP_CONTRACT_INVALID", "step acceptance contract must be non-empty");
  }
  const seen = new Set();
  for (const declaration of contract.acceptance) {
    if (!isPlainObject(declaration) || !ACCEPTANCE_KINDS.has(declaration.kind)) {
      fail("STEP_CONTRACT_INVALID", "acceptance declaration is invalid");
    }
    const hasCommand = Object.hasOwn(declaration, "command");
    const hasPattern = Object.hasOwn(declaration, "command_pattern");
    const fields = declaration.kind === "artifact"
      ? [...ACCEPTANCE_COMMON_KEYS, "path", ...(Object.hasOwn(declaration, "validator") ? ["validator"] : [])]
      : declaration.kind === "command"
        ? [...ACCEPTANCE_COMMON_KEYS, hasCommand ? "command" : "command_pattern"]
        : ACCEPTANCE_COMMON_KEYS;
    exactFields(declaration, fields, "STEP_CONTRACT_INVALID", "acceptance declaration");
    if (Object.hasOwn(declaration, "validator") && !["html-document", "browser-output"].includes(declaration.validator)) {
      fail("STEP_CONTRACT_INVALID", "artifact validator is unknown");
    }
    if (
      !nonempty(declaration.id) || seen.has(declaration.id) ||
      typeof declaration.required !== "boolean" || !nonempty(declaration.description)
    ) {
      fail("STEP_CONTRACT_INVALID", "acceptance declaration fields are invalid");
    }
    seen.add(declaration.id);
    if (declaration.kind === "artifact" && !portablePath(declaration.path)) {
      fail("ACCEPTANCE_ARTIFACT_PATH_UNSAFE", "declared artifact path is unsafe");
    }
    if (declaration.kind === "command") {
      if (hasCommand === hasPattern) fail("STEP_CONTRACT_INVALID", "command declaration is ambiguous");
      if (hasCommand && !nonempty(declaration.command)) {
        fail("STEP_CONTRACT_INVALID", "declared command is invalid");
      }
      if (hasPattern) {
        let precedingBackslashes = 0;
        for (
          let index = declaration.command_pattern.length - 2;
          index >= 0 && declaration.command_pattern[index] === "\\";
          index -= 1
        ) {
          precedingBackslashes += 1;
        }
        if (
          !nonempty(declaration.command_pattern) ||
          !declaration.command_pattern.startsWith("^") ||
          !declaration.command_pattern.endsWith("$") ||
          precedingBackslashes % 2 === 1 ||
          hasTopLevelAlternation(declaration.command_pattern)
        ) {
          fail("STEP_CONTRACT_INVALID", "declared command pattern must be anchored");
        }
        try {
          new RegExp(declaration.command_pattern, "u");
        } catch {
          fail("STEP_CONTRACT_INVALID", "declared command pattern is invalid");
        }
      }
    }
  }
  if (contract.visual_review === true) {
    const hasScreenshot = contract.acceptance.some(declaration => (
      declaration.kind === "artifact" && declaration.required &&
      /\.(?:avif|gif|jpe?g|png|webp)$/i.test(declaration.path)
    ));
    const hasInspection = contract.acceptance.some(declaration => {
      if (declaration.kind !== "check" || !declaration.required) return false;
      const text = `${declaration.id} ${declaration.description}`;
      return /visual/i.test(text) && /inspect/i.test(text);
    });
    if (!hasScreenshot || !hasInspection) {
      fail(
        "STEP_CONTRACT_INVALID",
        "visual review requires a screenshot artifact and a visual inspection check"
      );
    }
  }
  return contract;
}

function validateLoadedContract(entry, step) {
  exactFields(entry, STEP_KEYS, "STEP_CONTRACT_INVALID", "step contract");
  const id = canonicalStepId(step);
  if (
    entry.number !== step || entry.id !== id || !nonempty(entry.title) ||
    entry.phase !== expectedPhase(step) || entry.target !== `codex/assets/steps/${id}.md` ||
    entry.source !== `assets/steps/${id}.md` || entry.ported !== true ||
    !SHA256.test(entry.source_sha256 ?? "") ||
    entry.next !== (step === STEP_COUNT ? null : canonicalStepId(step + 1)) ||
    typeof entry.network !== "boolean" || typeof entry.visual_review !== "boolean" ||
    !uniqueStringArray(entry.inputs) || !uniqueStringArray(entry.outputs) ||
    !uniqueStringArray(entry.requires) || !uniqueStringArray(entry.optional_requires)
  ) {
    fail("STEP_CONTRACT_INVALID", "step contract is not canonical and ported");
  }
  return validateAcceptanceDeclarations(entry);
}

export async function loadStepContract(pluginRoot, step) {
  requireStep(step);
  const { root } = await physicalRoot(pluginRoot, "PLUGIN_ROOT_INVALID");
  const indexPath = join(root, "codex", "assets", "steps", "index.json");
  await physicalFile(root, indexPath, {
    missingCode: "STEP_CONTRACT_INVALID",
    unsafeCode: "PLUGIN_ROOT_INVALID"
  });
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    fail("STEP_CONTRACT_INVALID", "step index JSON is invalid", {
      cause_code: typeof error?.code === "string" ? error.code : "INVALID"
    });
  }
  if (
    !isPlainObject(index) || Object.keys(index).sort().join(",") !== "schema_version,steps" ||
    index.schema_version !== 1 || !Array.isArray(index.steps) || index.steps.length !== STEP_COUNT
  ) {
    fail("STEP_CONTRACT_INVALID", "step index must contain the canonical fifty-step schema");
  }
  for (let offset = 0; offset < index.steps.length; offset += 1) {
    if (index.steps[offset]?.number !== offset + 1 || index.steps[offset]?.id !== canonicalStepId(offset + 1)) {
      fail("STEP_CONTRACT_INVALID", "step index order is not canonical");
    }
  }
  const contract = validateLoadedContract(index.steps[step - 1], step);
  const targetPath = containedPath(root, contract.target, "STEP_CONTRACT_INVALID");
  await physicalFile(root, targetPath, {
    missingCode: "STEP_CONTRACT_INVALID",
    unsafeCode: "PLUGIN_ROOT_INVALID"
  });
  return contract;
}

function expectedEvidenceFields(kind, hasDigest) {
  if (kind === "artifact") {
    return hasDigest
      ? [...EVIDENCE_COMMON_KEYS, "artifact_path", "artifact_sha256"]
      : [...EVIDENCE_COMMON_KEYS, "artifact_path"];
  }
  if (kind === "command") return [...EVIDENCE_COMMON_KEYS, "command", "exit_code"];
  return EVIDENCE_COMMON_KEYS;
}

function matchesDeclaredCommand(declaration, command) {
  if (Object.hasOwn(declaration, "command")) return command === declaration.command;
  return new RegExp(declaration.command_pattern, "u").test(command);
}

async function digestHandle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let byteCount = 0n;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    byteCount += BigInt(bytesRead);
  }
  return { digest: hash.digest("hex"), byteCount };
}

async function hashStableArtifact(workspaceRoot, declaration, suppliedDigest, afterArtifactOpen, browserBindings) {
  const { root, snapshot: rootBefore } = await physicalRoot(
    workspaceRoot,
    "ACCEPTANCE_WORKSPACE_UNSAFE"
  );
  const absolutePath = containedPath(root, declaration.path, "ACCEPTANCE_ARTIFACT_PATH_UNSAFE");
  const pathBefore = await physicalFile(root, absolutePath, {
    missingCode: "ACCEPTANCE_ARTIFACT_MISSING",
    unsafeCode: "ACCEPTANCE_ARTIFACT_UNSAFE"
  });
  let handle;
  try {
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    try {
      handle = await open(absolutePath, flags);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        fail("ACCEPTANCE_ARTIFACT_CHANGED", "artifact changed before its stable handle opened");
      }
      fail("ACCEPTANCE_ARTIFACT_UNSAFE", "artifact could not be opened safely", {
        cause_code: typeof error?.code === "string" ? error.code : "INVALID"
      });
    }
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || handleBefore.nlink !== 1n || !sameFileSnapshot(pathBefore, handleBefore)) {
      fail("ACCEPTANCE_ARTIFACT_CHANGED", "artifact changed while its stable handle opened");
    }
    const initialRead = await digestHandle(handle);
    if (initialRead.byteCount !== handleBefore.size) {
      fail("ACCEPTANCE_ARTIFACT_CHANGED", "artifact size changed during initial hashing");
    }
    if (declaration.validator === "html-document" || declaration.validator === "browser-output") {
      try {
        const limit = declaration.validator === "html-document" ? 8 * 1024 * 1024 : 1024 * 1024;
        if (handleBefore.size > BigInt(limit)) throw new Error("Artifact exceeds its content validation limit");
        const content = await handle.readFile();
        if (createHash("sha256").update(content).digest("hex") !== initialRead.digest) throw new Error("Artifact changed during content validation");
        if (declaration.validator === "html-document") validateHtmlBytes(content);
        else browserBindings.set(declaration.id, validateBrowserReportBytes(content));
      } catch (error) {
        fail("ACCEPTANCE_ARTIFACT_CONTENT", error.message, { acceptance_id: declaration.id });
      }
    }
    await afterArtifactOpen?.({ absolutePath, handle });
    const finalRead = await digestHandle(handle);
    const handleAfter = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await physicalFile(root, absolutePath, {
        missingCode: "ACCEPTANCE_ARTIFACT_CHANGED",
        unsafeCode: "ACCEPTANCE_ARTIFACT_CHANGED"
      });
    } catch (error) {
      if (error instanceof HarnessError) {
        fail("ACCEPTANCE_ARTIFACT_CHANGED", "artifact path changed during hashing");
      }
      throw error;
    }
    let rootAfter;
    try {
      rootAfter = await lstat(root, { bigint: true });
    } catch {
      fail("ACCEPTANCE_ARTIFACT_CHANGED", "workspace changed during artifact hashing");
    }
    if (
      finalRead.byteCount !== handleBefore.size || initialRead.digest !== finalRead.digest ||
      !sameFileSnapshot(handleBefore, handleAfter) || !sameFileSnapshot(handleBefore, pathAfter) ||
      !sameNode(rootBefore, rootAfter)
    ) {
      fail("ACCEPTANCE_ARTIFACT_CHANGED", "artifact changed during hashing");
    }
    const digest = finalRead.digest;
    if (suppliedDigest !== undefined && suppliedDigest !== digest) {
      fail("ACCEPTANCE_ARTIFACT_HASH_MISMATCH", "supplied artifact digest does not match stable bytes", {
        acceptance_id: declaration.id
      });
    }
    return digest;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateEvidenceShape(contract, evidence, { requireArtifactDigest = false } = {}) {
  validateAcceptanceDeclarations(contract);
  const declarations = new Map(contract.acceptance.map(item => [item.id, item]));
  const seen = new Set();
  const canonical = [];
  for (const raw of sanitizeEvidence(evidence)) {
    if (raw.acceptance_id === null) {
      fail("EVIDENCE_INVALID", "native completion evidence requires an acceptance ID");
    }
    const declaration = declarations.get(raw.acceptance_id);
    if (!declaration) fail("ACCEPTANCE_UNKNOWN", "evidence ID is not declared");
    if (seen.has(raw.acceptance_id)) fail("ACCEPTANCE_DUPLICATE", "evidence ID is duplicated");
    seen.add(raw.acceptance_id);
    if (raw.kind !== declaration.kind || raw.kind === "import") {
      fail("ACCEPTANCE_KIND_MISMATCH", "evidence kind does not match its declaration");
    }
    const hasDigest = Object.hasOwn(raw, "artifact_sha256");
    exactFields(
      raw,
      expectedEvidenceFields(raw.kind, hasDigest),
      "ACCEPTANCE_FIELDS",
      "completion evidence"
    );
    if (raw.kind === "artifact") {
      if (raw.artifact_path !== declaration.path) {
        fail("ACCEPTANCE_ARTIFACT_PATH", "artifact path does not match its declaration");
      }
      if (requireArtifactDigest && raw.ok && !hasDigest) {
        fail("RECEIPT_CONFLICT", "persisted artifact evidence lacks its canonical digest");
      }
    } else if (raw.kind === "command") {
      if (!matchesDeclaredCommand(declaration, raw.command)) {
        fail("ACCEPTANCE_COMMAND_MISMATCH", "command evidence does not match its declaration");
      }
      if (raw.ok && raw.exit_code !== 0) {
        fail("ACCEPTANCE_COMMAND_FAILED", "successful command evidence requires exit code zero");
      }
    }
    canonical.push({ ...raw });
  }
  const missing = contract.acceptance
    .filter(declaration => declaration.required && !canonical.some(item => (
      item.acceptance_id === declaration.id && item.ok
    )))
    .map(declaration => declaration.id);
  if (missing.length > 0) {
    fail("ACCEPTANCE_MISSING", "required completion evidence is missing", { missing });
  }
  return canonical;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateCompletionEvidence({
  contract,
  evidence,
  workspaceRoot,
  persistedEvidence,
  afterArtifactOpen
} = {}) {
  if (afterArtifactOpen !== undefined && typeof afterArtifactOpen !== "function") {
    fail("ACCEPTANCE_OPTIONS_INVALID", "afterArtifactOpen must be a function");
  }
  const canonical = validateEvidenceShape(contract, evidence);
  if (persistedEvidence !== undefined) {
    const persisted = validateEvidenceShape(contract, persistedEvidence, {
      requireArtifactDigest: true
    });
    const completed = canonical.map((item, index) => {
      const durable = persisted[index];
      if (
        item.kind === "artifact" && durable?.acceptance_id === item.acceptance_id &&
        !Object.hasOwn(item, "artifact_sha256") &&
        Object.hasOwn(durable, "artifact_sha256")
      ) {
        return { ...item, artifact_sha256: durable.artifact_sha256 };
      }
      return item;
    });
    if (!sameJson(completed, persisted)) {
      fail("RECEIPT_CONFLICT", "completion evidence conflicts with the durable receipt");
    }
    return { evidence: persisted, missing_required: [] };
  }

  const result = [];
  const browserBindings = new Map();
  for (const item of canonical) {
    if (item.kind === "artifact" && item.ok) {
      const declaration = contract.acceptance.find(value => value.id === item.acceptance_id);
      const digest = await hashStableArtifact(
        workspaceRoot,
        declaration,
        item.artifact_sha256,
        afterArtifactOpen,
        browserBindings
      );
      result.push({ ...item, artifact_sha256: digest });
    } else {
      result.push(item);
    }
  }
  for (const [acceptanceId, expectedDigest] of browserBindings) {
    const html = result.find(item => item.kind === "artifact" && item.ok && item.artifact_path === "dist/index.html");
    if (!html || html.artifact_sha256 !== expectedDigest) {
      fail("ACCEPTANCE_ARTIFACT_CONTENT", "browser report does not describe the final HTML receipt", { acceptance_id: acceptanceId });
    }
    // Bind against the same bytes retained in the receipt, and check again after
    // all artifact callbacks so a report cannot authorize a replaced final build.
    await hashStableArtifact(workspaceRoot, {
      id: acceptanceId, path: "dist/index.html", validator: "html-document"
    }, expectedDigest);
  }
  return { evidence: result, missing_required: [] };
}

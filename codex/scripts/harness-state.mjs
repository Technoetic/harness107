import { pathToFileURL } from "node:url";

import { HarnessError } from "./lib/errors.mjs";
import { importClaudeProgress } from "./lib/importer.mjs";
import { readJsonInput } from "./lib/json-io.mjs";
import { sanitizeEvidence } from "./lib/receipts.mjs";
import {
  beginStep,
  completeStep,
  failStep,
  initWorkflow,
  pauseWorkflow,
  reconcileWorkflow,
  resetWorkflow,
  resumeWorkflow,
  showWorkflow
} from "./lib/workflow.mjs";

const INPUT_LIMIT = 1024 * 1024;
const COMMANDS = new Set([
  "init",
  "show",
  "import-claude",
  "begin",
  "complete",
  "fail",
  "pause",
  "resume",
  "reconcile",
  "reset"
]);
const KNOWN_FLAGS = new Set([
  "workspace",
  "plugin-root",
  "step",
  "attempt",
  "session",
  "reason",
  "input"
]);
const COMMAND_FLAGS = new Map([
  ["init", { allowed: ["workspace", "input"], required: ["workspace", "input"] }],
  ["show", { allowed: ["workspace"], required: ["workspace"] }],
  ["import-claude", {
    allowed: ["workspace", "plugin-root"],
    required: ["workspace", "plugin-root"]
  }],
  ["begin", {
    allowed: ["workspace", "step", "session", "input"],
    required: ["workspace", "step", "input"]
  }],
  ["complete", {
    allowed: ["workspace", "plugin-root", "step", "attempt", "input"],
    required: ["workspace", "plugin-root", "step", "attempt", "input"]
  }],
  ["fail", {
    allowed: ["workspace", "step", "attempt", "input"],
    required: ["workspace", "step", "attempt", "input"]
  }],
  ["pause", { allowed: ["workspace", "reason"], required: ["workspace", "reason"] }],
  ["resume", { allowed: ["workspace", "session"], required: ["workspace"] }],
  ["reconcile", { allowed: ["workspace"], required: ["workspace"] }],
  ["reset", { allowed: ["workspace"], required: ["workspace"] }]
]);
const INPUT_COMMANDS = new Set(["init", "begin", "complete", "fail"]);
const CLI_MESSAGES = new Map([
  ["COMMAND_REQUIRED", "a command is required"],
  ["COMMAND_UNKNOWN", "the command is not recognized"],
  ["FLAG_UNKNOWN", "an option is not recognized"],
  ["FLAG_FORMAT", "options must use separate argument values"],
  ["FLAG_DUPLICATE", "an option may be provided only once"],
  ["FLAG_VALUE", "an option value is missing or empty"],
  ["FLAG_INVALID_FOR_COMMAND", "the option is invalid for this command"],
  ["FLAG_REQUIRED", "a required option is missing"],
  ["POSITIONAL_ARGUMENT", "unexpected positional arguments are not allowed"],
  ["STEP_INTEGER", "step must be a safe integer"],
  ["STEP_RANGE", "step must be an integer from 1 through 50"],
  ["INPUT_MODE", "structured input must use --input -"],
  ["INPUT_SHAPE", "input JSON has an invalid shape"],
  ["INPUT_TYPE", "input JSON contains an invalid value type"]
]);

const OPERATIONS = Object.freeze({
  initWorkflow,
  showWorkflow,
  importClaudeProgress,
  beginStep,
  completeStep,
  failStep,
  pauseWorkflow,
  resumeWorkflow,
  reconcileWorkflow,
  resetWorkflow
});

function fail(code) {
  throw new HarnessError(code, CLI_MESSAGES.get(code) ?? "state command rejected");
}

function requireText(value) {
  if (typeof value !== "string" || value.trim() === "") fail("INPUT_TYPE");
  return value;
}

function requireExactObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INPUT_OBJECT");
  const actual = Object.keys(value);
  if (
    actual.length !== fields.length ||
    actual.some(field => !fields.includes(field)) ||
    fields.some(field => !(field in value))
  ) {
    fail("INPUT_SHAPE");
  }
  return value;
}

function parseStep(value) {
  if (!/^[+-]?\d+$/.test(value ?? "")) fail("STEP_INTEGER");
  const step = Number(value);
  if (!Number.isSafeInteger(step)) fail("STEP_INTEGER");
  if (step < 1 || step > 50) fail("STEP_RANGE");
  return step;
}

function parseMarker(raw) {
  const marker = requireExactObject(raw, [
    "workflow_id",
    "step",
    "nonce",
    "issued_at",
    "baseline_receipt_count"
  ]);
  requireText(marker.workflow_id);
  requireText(marker.nonce);
  requireText(marker.issued_at);
  if (!Number.isInteger(marker.step) || marker.step < 1 || marker.step > 50) fail("INPUT_TYPE");
  if (
    !Number.isInteger(marker.baseline_receipt_count) ||
    marker.baseline_receipt_count < 0 || marker.baseline_receipt_count > 50
  ) {
    fail("INPUT_TYPE");
  }
  return marker;
}

function parseInput(command, input) {
  if (command === "init") {
    const value = requireExactObject(input, ["topic"]);
    return { topic: requireText(value.topic) };
  }
  if (command === "begin") {
    const value = requireExactObject(input, ["marker"]);
    return { marker: parseMarker(value.marker) };
  }
  if (command === "complete") {
    const value = requireExactObject(input, ["summary", "evidence"]);
    return {
      summary: requireText(value.summary),
      evidence: sanitizeEvidence(value.evidence)
    };
  }
  if (command === "fail") {
    const value = requireExactObject(input, ["reason", "evidence"]);
    return {
      reason: requireText(value.reason),
      evidence: sanitizeEvidence(value.evidence)
    };
  }
  return null;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) fail("COMMAND_REQUIRED");
  const [command, ...tokens] = argv;
  if (typeof command !== "string" || !COMMANDS.has(command)) fail("COMMAND_UNKNOWN");
  const schema = COMMAND_FLAGS.get(command);
  const allowed = new Set(schema.allowed);
  const flags = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string" || !token.startsWith("--")) fail("POSITIONAL_ARGUMENT");
    if (token.includes("=")) fail("FLAG_FORMAT");
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) fail("FLAG_UNKNOWN");
    if (!allowed.has(name)) fail("FLAG_INVALID_FOR_COMMAND");
    if (name in flags) fail("FLAG_DUPLICATE");
    const value = tokens[index + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) fail("FLAG_VALUE");
    flags[name] = value;
    index += 1;
  }

  for (const name of schema.required) {
    if (!(name in flags)) fail("FLAG_REQUIRED");
  }
  if ("input" in flags && flags.input !== "-") fail("INPUT_MODE");
  if ("step" in flags) flags.step = parseStep(flags.step);
  for (const name of ["workspace", "plugin-root", "attempt", "session", "reason"]) {
    if (name in flags && flags[name].trim() === "") fail("FLAG_VALUE");
  }
  return { command, flags };
}

export async function dispatch(command, flags, input, operations = OPERATIONS) {
  const workspaceRoot = flags.workspace;
  switch (command) {
    case "init":
      return operations.initWorkflow({ workspaceRoot, topic: input.topic });
    case "show":
      return operations.showWorkflow({ workspaceRoot });
    case "import-claude":
      return operations.importClaudeProgress({ workspaceRoot, pluginRoot: flags["plugin-root"] });
    case "begin":
      return operations.beginStep({
        workspaceRoot,
        step: flags.step,
        sessionId: flags.session ?? null,
        marker: input.marker
      });
    case "complete":
      return operations.completeStep({
        workspaceRoot,
        pluginRoot: flags["plugin-root"],
        step: flags.step,
        attemptId: flags.attempt,
        summary: input.summary,
        evidence: input.evidence
      });
    case "fail":
      return operations.failStep({
        workspaceRoot,
        step: flags.step,
        attemptId: flags.attempt,
        reason: input.reason,
        evidence: input.evidence
      });
    case "pause":
      return operations.pauseWorkflow({ workspaceRoot, reason: flags.reason });
    case "resume":
      return operations.resumeWorkflow({ workspaceRoot, sessionId: flags.session ?? null });
    case "reconcile":
      return operations.reconcileWorkflow({ workspaceRoot });
    case "reset":
      return operations.resetWorkflow({ workspaceRoot });
    default:
      fail("COMMAND_UNKNOWN");
  }
}

export async function main(argv, {
  stdin = process.stdin,
  stdout = process.stdout
} = {}) {
  const { command, flags } = parseArgs(argv);
  const rawInput = INPUT_COMMANDS.has(command)
    ? await readJsonInput(stdin, INPUT_LIMIT)
    : null;
  const input = parseInput(command, rawInput);
  const result = await dispatch(command, flags, input);
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function publicError(error) {
  if (error instanceof HarnessError && /^[A-Z][A-Z0-9_]*$/.test(error.code)) {
    return {
      code: error.code,
      message: CLI_MESSAGES.get(error.code) ?? "state command rejected"
    };
  }
  return { code: "CLI_INTERNAL", message: "state command failed" };
}

export function errorDocument(error) {
  return `${JSON.stringify({ error: publicError(error) })}\n`;
}

function isDirectEntrypoint() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then(
      code => {
        process.exitCode = code;
      },
      error => {
        process.exitCode = 1;
        process.stderr.write(errorDocument(error));
      }
    );
}

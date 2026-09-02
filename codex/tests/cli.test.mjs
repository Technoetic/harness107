import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { main } from "../scripts/harness-state.mjs";
import { readJsonInput } from "../scripts/lib/json-io.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readReceipts } from "../scripts/lib/receipts.mjs";
import { readState } from "../scripts/lib/state-store.mjs";
import { runCli } from "./helpers/run-cli.mjs";
import {
  makePluginFixture,
  makeWorkspace,
  writeClaudeCompletedPrefix
} from "./helpers/workspace.mjs";

const INPUT_LIMIT = 1024 * 1024;
const IMPORT_ACTION = "repair the Claude state or use a separate workspace";

function evidence(detail = "verified by CLI") {
  return [{
    acceptance_id: "state-transition",
    kind: "check",
    detail,
    ok: true
  }];
}

function parseSuccess(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{[^\r\n]*\}\n$/);
  return JSON.parse(result.stdout);
}

function parseFailure(result) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\{"error":\{"code":"[A-Z0-9_]+","message":"[^\r\n]*"\}\}\n$/);
  return JSON.parse(result.stderr).error;
}

async function writeImportErrorFixture(root, overrides = {}) {
  const path = pathsFor(root).importErrorPath;
  await mkdir(dirname(path), { recursive: true });
  const artifact = {
    schema_version: 1,
    code: "CLAUDE_TOTAL_STEPS",
    source_preserved: true,
    source_path: "step_archive/progress.json",
    source_sha256: "a".repeat(64),
    occurred_at: "2026-09-02T00:00:00.000Z",
    action: "untrusted workspace instruction",
    ...overrides
  };
  await writeFile(path, `${JSON.stringify(artifact)}\n`, "utf8");
}

test("show emits one JSON document and no diagnostic noise", async () => {
  const root = await makeWorkspace();
  const result = await runCli(["show", "--workspace", root]);
  assert.deepEqual(parseSuccess(result), {
    active: false,
    claude_progress_found: false
  });
});

test("all ten commands dispatch to their workflow operations with literal structured values", async () => {
  const parent = await makeWorkspace();
  const root = join(parent, "workspace 공간 $ & ;");
  await mkdir(root);
  const pluginRoot = await makePluginFixture();
  const topic = "한국어 topic with spaces, \"quotes\", $dollar; & | $(never-run)\n";
  const session = "세션 with spaces $ & ; quotes-'";
  const detail = "검증 detail with \"quotes\", $cash; & |";

  const initialized = parseSuccess(await runCli([
    "init", "--workspace", root, "--input", "-"
  ], { input: { topic } }));
  assert.equal(await readFile(join(root, "step_archive", "TOPIC", "TOPIC.md"), "utf8"), topic);
  assert.equal(initialized.current_step, 1);

  const first = parseSuccess(await runCli([
    "begin", "--workspace", root, "--step", "1", "--session", session, "--input", "-"
  ], { input: { marker: initialized.continuation } }));
  assert.equal(first.attempt.session_id, session);

  const failed = parseSuccess(await runCli([
    "fail", "--workspace", root, "--step", "1", "--attempt", first.attempt.id,
    "--input", "-"
  ], { input: { reason: "실패 reason $ & ; |", evidence: evidence(detail) } }));
  assert.equal(failed.current_attempt.failure_recorded, true);

  const retry = parseSuccess(await runCli([
    "begin", "--workspace", root, "--step", "1", "--session", session, "--input", "-"
  ], { input: { marker: failed.continuation } }));
  const summary = "완료 summary with \"quotes\", $cash; & |";
  const completed = parseSuccess(await runCli([
    "complete", "--workspace", root, "--plugin-root", pluginRoot,
    "--step", "1", "--attempt", retry.attempt.id, "--input", "-"
  ], { input: { summary, evidence: evidence(detail) } }));
  assert.deepEqual(completed.completed_steps, [1]);
  const [receipt] = await readReceipts(root);
  assert.equal(receipt.summary, summary);
  assert.equal(receipt.evidence[0].detail, detail);

  const paused = parseSuccess(await runCli([
    "pause", "--workspace", root, "--reason", "사용자 pause $ & ; |"
  ]));
  assert.equal(paused.status, "paused");
  const resumed = parseSuccess(await runCli([
    "resume", "--workspace", root, "--session", session
  ]));
  assert.equal(resumed.status, "running");
  assert.equal(resumed.owner.session_id, session);
  const reconciled = parseSuccess(await runCli(["reconcile", "--workspace", root]));
  assert.deepEqual(reconciled.completed_steps, [1]);
  const shown = parseSuccess(await runCli(["show", "--workspace", root]));
  assert.equal(shown.active, true);
  assert.deepEqual(shown.completions, { imported: 0, codex_verified: 1, total: 1 });
  const reset = parseSuccess(await runCli(["reset", "--workspace", root]));
  assert.equal(typeof reset.backupPath, "string");
  assert.equal((await runCli(["show", "--workspace", root])).code, 0);
  assert.equal(existsSync(join(root, "never-run")), false);
});

test("import-claude maps workspace and plugin roots without modifying Claude source", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const source = await writeClaudeCompletedPrefix(root, 2, { topic: "가져오기 topic\n" });
  const sourcePath = join(root, "step_archive", "progress.json");

  const imported = parseSuccess(await runCli([
    "import-claude", "--workspace", root, "--plugin-root", pluginRoot
  ]));
  assert.deepEqual(imported.state.completed_steps, [1, 2]);
  assert.equal(imported.state.current_step, 3);
  assert.deepEqual(await readFile(sourcePath), source);
  const shown = parseSuccess(await runCli(["show", "--workspace", root]));
  assert.deepEqual(shown.completions, { imported: 2, codex_verified: 0, total: 2 });
});

test("show reports a preserved failed Claude import with constant recovery guidance", async () => {
  const root = await makeWorkspace();
  await writeImportErrorFixture(root);
  const result = await runCli(["show", "--workspace", root]);
  assert.deepEqual(parseSuccess(result).import_error, {
    code: "CLAUDE_TOTAL_STEPS",
    source_preserved: true,
    action: IMPORT_ACTION
  });
});

test("argument validation rejects malformed command lines deterministically", async () => {
  const root = await makeWorkspace();
  const cases = [
    { args: [], code: "COMMAND_REQUIRED" },
    { args: ["unknown"], code: "COMMAND_UNKNOWN" },
    { args: ["show", "--workspace", root, "--mystery", "x"], code: "FLAG_UNKNOWN" },
    { args: ["show", `--workspace=${root}`], code: "FLAG_FORMAT" },
    { args: ["show", "--workspace", root, "--workspace", root], code: "FLAG_DUPLICATE" },
    { args: ["show", "--workspace"], code: "FLAG_VALUE" },
    { args: ["show", "--workspace", root, "extra"], code: "POSITIONAL_ARGUMENT" },
    { args: ["begin", "--workspace", root, "--step", "1.5", "--input", "-"], code: "STEP_INTEGER" },
    { args: ["begin", "--workspace", root, "--step", "9007199254740993", "--input", "-"], code: "STEP_INTEGER" },
    { args: ["begin", "--workspace", root, "--step", "0", "--input", "-"], code: "STEP_RANGE" },
    { args: ["begin", "--workspace", root, "--step", "51", "--input", "-"], code: "STEP_RANGE" },
    { args: ["show", "--workspace", root, "--step", "1"], code: "FLAG_INVALID_FOR_COMMAND" },
    { args: ["show", "--workspace", root, "--input", "-"], code: "FLAG_INVALID_FOR_COMMAND" },
    { args: ["init", "--workspace", root, "--input", "payload.json"], code: "INPUT_MODE" },
    { args: ["init", "--workspace", root], code: "FLAG_REQUIRED" },
    { args: ["import-claude", "--workspace", root], code: "FLAG_REQUIRED" },
    { args: ["show"], code: "FLAG_REQUIRED" }
  ];
  for (const fixture of cases) {
    const error = parseFailure(await runCli(fixture.args));
    assert.equal(error.code, fixture.code, JSON.stringify(fixture.args));
  }
});

test("input validation rejects empty malformed non-object unknown and mistyped JSON before mutation", async () => {
  const fixtures = [
    { input: "", code: "INPUT_EMPTY" },
    { input: "{not-json", code: "INPUT_JSON" },
    { input: "[]", code: "INPUT_OBJECT" },
    { input: { topic: "valid", extra: true }, code: "INPUT_SHAPE" },
    { input: { topic: 42 }, code: "INPUT_TYPE" }
  ];
  for (const fixture of fixtures) {
    const root = await makeWorkspace();
    const result = await runCli(["init", "--workspace", root, "--input", "-"], {
      input: fixture.input
    });
    assert.equal(parseFailure(result).code, fixture.code);
    assert.equal(existsSync(join(root, "step_archive")), false);
  }
});

test("command-specific structured schemas reject bad marker and evidence before workflow writes", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const initialized = parseSuccess(await runCli([
    "init", "--workspace", root, "--input", "-"
  ], { input: { topic: "schema checks" } }));
  const beforeBegin = await readState(root);
  const badBegin = await runCli([
    "begin", "--workspace", root, "--step", "1", "--input", "-"
  ], { input: { marker: { ...initialized.continuation, extra: true } } });
  assert.equal(parseFailure(badBegin).code, "INPUT_SHAPE");
  assert.deepEqual(await readState(root), beforeBegin);

  const started = parseSuccess(await runCli([
    "begin", "--workspace", root, "--step", "1", "--input", "-"
  ], { input: { marker: initialized.continuation } }));
  const beforeComplete = await readState(root);
  const badComplete = await runCli([
    "complete", "--workspace", root, "--plugin-root", pluginRoot,
    "--step", "1", "--attempt", started.attempt.id, "--input", "-"
  ], { input: { summary: "bad evidence", evidence: [{ unexpected: true }] } });
  assert.equal(parseFailure(badComplete).code, "EVIDENCE_INVALID");
  assert.deepEqual(await readState(root), beforeComplete);
  assert.deepEqual(await readReceipts(root), []);
});

test("stdin is byte-bounded and preserves UTF-8 characters split across chunks", async () => {
  const encoded = Buffer.from('{"topic":"앞뒤"}', "utf8");
  const split = encoded.indexOf(Buffer.from("앞")) + 1;
  const value = await readJsonInput(Readable.from([
    encoded.subarray(0, split),
    encoded.subarray(split)
  ]), INPUT_LIMIT);
  assert.deepEqual(value, { topic: "앞뒤" });

  const prefix = Buffer.byteLength('{"value":"');
  const suffix = Buffer.byteLength('"}');
  const exact = `{"value":"${"x".repeat(INPUT_LIMIT - prefix - suffix)}"}`;
  assert.equal(Buffer.byteLength(exact), INPUT_LIMIT);
  assert.equal((await readJsonInput(Readable.from([exact]), INPUT_LIMIT)).value.length, INPUT_LIMIT - prefix - suffix);

  const root = await makeWorkspace();
  const oversized = `{"topic":"${"x".repeat(INPUT_LIMIT)}"}`;
  const result = await runCli(["init", "--workspace", root, "--input", "-"], { input: oversized });
  assert.equal(parseFailure(result).code, "INPUT_TOO_LARGE");
  assert.equal(existsSync(join(root, "step_archive")), false);
});

test("stdin stream failures and stalled streams become stable bounded errors", async () => {
  const secret = "sk-proj-abcdefghijklmnop";
  const broken = new Readable({
    read() {
      this.destroy(new Error(secret));
    }
  });
  await assert.rejects(
    () => readJsonInput(broken, INPUT_LIMIT),
    error => error.code === "INPUT_STREAM" && !error.message.includes(secret)
  );

  const stalled = new PassThrough();
  await assert.rejects(
    () => readJsonInput(stalled, INPUT_LIMIT, { timeoutMs: 20 }),
    error => error.code === "INPUT_TIMEOUT"
  );
  stalled.destroy();
});

test("errors never echo input, secrets, environment values, or stack traces", async () => {
  const root = await makeWorkspace();
  const secret = "sk-proj-abcdefghijklmnop";
  const result = await runCli([
    "show", "--workspace", root, secret
  ], { env: { HARNESS50_UNRELATED_SECRET: secret } });
  const error = parseFailure(result);
  assert.equal(error.code, "POSITIONAL_ARGUMENT");
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stderr, /(?:at file:|Error:|node:internal|stack)/i);

  const malformed = await runCli([
    "init", "--workspace", root, "--input", "-"
  ], { input: `{"topic":"${secret}"` });
  parseFailure(malformed);
  assert.doesNotMatch(malformed.stderr, new RegExp(secret));
});

test("main supports injected streams and importing the module does not execute the entrypoint", async () => {
  const root = await makeWorkspace();
  let stdout = "";
  let stderr = "";
  const stdoutSink = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk.toString();
      callback();
    }
  });
  const stderrSink = new Writable({
    write(chunk, _encoding, callback) {
      stderr += chunk.toString();
      callback();
    }
  });
  const code = await main(["show", "--workspace", root], {
    stdin: Readable.from([]),
    stdout: stdoutSink,
    stderr: stderrSink,
    env: { HARNESS50_UNRELATED_SECRET: "must-not-be-read" }
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { active: false, claude_progress_found: false });
  assert.equal(stderr, "");
  assert.equal(existsSync(join(root, "step_archive")), false);
});

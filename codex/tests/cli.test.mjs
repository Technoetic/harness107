import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, PassThrough, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const cliPath = fileURLToPath(new URL("../scripts/harness-state.mjs", import.meta.url));
const jsonIoUrl = new URL("../scripts/lib/json-io.mjs", import.meta.url).href;
const harnessStateUrl = new URL("../scripts/harness-state.mjs", import.meta.url).href;

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

async function runCliWithClosedStdout(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stderr = [];
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("closed-stdout CLI timed out")));
    }, 5000);
    child.once("error", error => finish(() => reject(error)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("close", code => finish(() => resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderr).toString("utf8")
    })));
    child.stdout.destroy();
  });
}

async function inspectOutputQuarantine(mode) {
  const script = `
    import { EventEmitter } from "node:events";
    import { writeOutput } from ${JSON.stringify(jsonIoUrl)};
    const mode = ${JSON.stringify(mode)};
    const secret = "late output secret";
    const uncaught = [];
    const unhandled = [];
    process.on("uncaughtException", error => uncaught.push(error.message));
    process.on("unhandledRejection", error => unhandled.push(error?.message ?? String(error)));

    class HostileWritable extends EventEmitter {
      constructor({ backpressure = false, destroyMode = "close" } = {}) {
        super();
        this.backpressure = backpressure;
        this.destroyMode = destroyMode;
        this.destroyed = false;
        this.closed = false;
        this.writable = true;
        this.writableEnded = false;
        this.callbacks = [];
      }

      write(_value, callback) {
        this.callbacks.push(error => {
          callback(error);
          if (error) this.emit("error", error);
        });
        return !this.backpressure;
      }

      destroy() {
        if (this.destroyMode === "throw") throw new Error(secret);
        if (this.destroyMode === "noop") return this;
        this.destroyed = true;
        this.closed = true;
        this.emit("close");
        return this;
      }
    }

    const terminalEvents = [];
    const output = new HostileWritable({
      backpressure: mode === "backpressure",
      destroyMode: ["close-then-error", "destroy-noop", "double-error", "never", "repeated"].includes(mode)
        ? "noop"
        : mode === "destroy-throw" ? "throw" : "close"
    });
    output.on("close", () => terminalEvents.push("close"));
    const baseline = {
      error: output.listenerCount("error"),
      close: output.listenerCount("close"),
      drain: output.listenerCount("drain")
    };
    const timeoutMs = mode === "direct-stderr" ? 1000 : 5;
    const rejections = [];
    const startedAt = Date.now();
    const attempts = mode === "repeated" ? 3 : 1;
    let directExitCode = null;
    if (mode === "direct-stderr") {
      const { runDirect } = await import(${JSON.stringify(harnessStateUrl)});
      await runDirect([], {
        stderr: output,
        runMain() {
          throw new Error(secret);
        }
      });
      directExitCode = process.exitCode;
    } else {
      for (let index = 0; index < attempts; index += 1) {
        try {
          await writeOutput(output, "fixture", { timeoutMs });
        } catch (error) {
          rejections.push({ code: error.code, message: error.message });
        }
      }
    }
    const rejectedAfterMs = Date.now() - startedAt;
    const during = {
      error: output.listenerCount("error"),
      close: output.listenerCount("close"),
      drain: output.listenerCount("drain")
    };
    setTimeout(() => {
      if (mode === "delayed-callback-error") output.callbacks[0](new Error(secret));
      else if (mode === "delayed-emitted-error" || mode === "backpressure" || mode === "direct-stderr") {
        output.emit("error", new Error(secret));
      } else if (mode === "double-error" || mode === "destroy-noop" || mode === "destroy-throw" || mode === "repeated") {
        output.emit("error", new Error(secret));
        output.emit("error", new Error(secret));
      } else if (mode === "callback-success-then-error") {
        output.callbacks[0](null);
        output.emit("error", new Error(secret));
      } else if (mode === "close-then-error") {
        output.closed = true;
        output.emit("close");
        output.emit("error", new Error(secret));
      }
    }, 240);
    await new Promise(resolve => setTimeout(resolve, 300));
    const final = {
      error: output.listenerCount("error"),
      close: output.listenerCount("close"),
      drain: output.listenerCount("drain")
    };
    process.stdout.write(JSON.stringify({
      rejections,
      directExitCode,
      rejectedAfterMs,
      baseline,
      during,
      final,
      destroyed: output.destroyed,
      terminalEvents,
      uncaught,
      unhandled
    }) + "\\n");
    process.exitCode = 0;
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > INPUT_LIMIT) {
        child.kill();
        finish(() => reject(new Error("output-quarantine fixture exceeded its output limit")));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("output-quarantine fixture timed out")));
    }, 5000);
    child.once("error", error => finish(() => reject(error)));
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.once("close", code => finish(() => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    })));
  });
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

test("a supplied step is validated before an unrelated required input flag", async () => {
  const root = await makeWorkspace();
  const cases = [
    { value: "51", code: "STEP_RANGE" },
    { value: "0", code: "STEP_RANGE" },
    { value: "-1", code: "STEP_RANGE" },
    { value: "1.0", code: "STEP_INTEGER" },
    { value: "1e2", code: "STEP_INTEGER" },
    { value: "9007199254740993", code: "STEP_INTEGER" }
  ];
  for (const fixture of cases) {
    const result = await runCli([
      "begin", "--workspace", root, "--step", fixture.value
    ]);
    assert.equal(parseFailure(result).code, fixture.code);
    assert.equal(existsSync(join(root, "step_archive")), false);
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
  const oversized = Buffer.from(`{"topic":"${"x".repeat(INPUT_LIMIT)}"}`);
  const chunks = [];
  for (let offset = 0; offset < oversized.length; offset += 16384) {
    chunks.push(oversized.subarray(offset, offset + 16384));
  }
  const result = await runCli(["init", "--workspace", root, "--input", "-"], { input: chunks });
  assert.equal(parseFailure(result).code, "INPUT_TOO_LARGE");
  assert.equal(existsSync(join(root, "step_archive")), false);
});

test("runCli settles cleanly when an early-exit child closes stdin during large writes", async () => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const result = await runCli(["show"], { input: Buffer.alloc(INPUT_LIMIT) });
    assert.equal(parseFailure(result).code, "FLAG_REQUIRED");
  }
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

test("a closed process stdout becomes one sanitized error without a raw EPIPE stack", async () => {
  const root = await makeWorkspace();
  const result = await runCliWithClosedStdout(["show", "--workspace", root]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, "{\"error\":{\"code\":\"OUTPUT_STREAM\",\"message\":\"output stream failed\"}}\n");
  assert.doesNotMatch(result.stderr, /EPIPE|node:internal|harness-state\.mjs|file:\/|Error:/i);
});

test("main rejects asynchronous output errors and removes its temporary listeners", async () => {
  const root = await makeWorkspace();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(new Error("asynchronous output secret")));
    }
  });
  const retainedErrorListener = () => {};
  output.on("error", retainedErrorListener);
  const baseline = {
    error: output.listenerCount("error"),
    close: output.listenerCount("close"),
    drain: output.listenerCount("drain")
  };
  await assert.rejects(
    () => main(["show", "--workspace", root], { stdout: output }),
    error => error.code === "OUTPUT_STREAM" && !error.message.includes("secret")
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({
    error: output.listenerCount("error"),
    close: output.listenerCount("close"),
    drain: output.listenerCount("drain")
  }, baseline);
  output.removeListener("error", retainedErrorListener);
});

test("main rejects an output close before completion and removes its temporary listeners", async () => {
  const root = await makeWorkspace();
  const output = new Writable({
    write(_chunk, _encoding, _callback) {
      setImmediate(() => this.destroy());
    }
  });
  const baseline = {
    error: output.listenerCount("error"),
    close: output.listenerCount("close"),
    drain: output.listenerCount("drain")
  };
  await assert.rejects(
    () => main(["show", "--workspace", root], { stdout: output }),
    error => error.code === "OUTPUT_STREAM"
  );
  assert.deepEqual({
    error: output.listenerCount("error"),
    close: output.listenerCount("close"),
    drain: output.listenerCount("drain")
  }, baseline);
});

for (const fixture of [
  { mode: "delayed-callback-error", label: "a callback error beyond the old cleanup window" },
  { mode: "delayed-emitted-error", label: "an emitted error beyond the old cleanup window" },
  { mode: "double-error", label: "repeated late errors" },
  { mode: "callback-success-then-error", label: "an error after callback success" },
  { mode: "backpressure", label: "an error after backpressure without drain" },
  { mode: "close-then-error", label: "an error after close" },
  { mode: "destroy-noop", label: "late errors when destroy is a no-op" },
  { mode: "destroy-throw", label: "late errors when destroy throws" },
  { mode: "never", label: "a non-terminating stream" }
]) {
  test(`writeOutput quarantines ${fixture.label} without retaining temporary listeners`, async () => {
    const result = await inspectOutputQuarantine(fixture.mode);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stderr, /late output secret|Error:|node:internal|json-io\.mjs/i);
    const inspection = JSON.parse(result.stdout);
    assert.deepEqual(inspection.rejections, [{
      code: "OUTPUT_STREAM",
      message: "output stream failed"
    }]);
    assert.ok(inspection.rejectedAfterMs < 200, `timeout settled after ${inspection.rejectedAfterMs} ms`);
    assert.equal(inspection.during.error, inspection.baseline.error + 1);
    assert.equal(inspection.during.close, inspection.baseline.close);
    assert.equal(inspection.during.drain, inspection.baseline.drain);
    assert.deepEqual(inspection.uncaught, []);
    assert.deepEqual(inspection.unhandled, []);
    assert.equal(inspection.final.error, inspection.baseline.error + 1);
    assert.equal(inspection.final.close, inspection.baseline.close);
    assert.equal(inspection.final.drain, inspection.baseline.drain);
  });
}

test("repeated writeOutput timeouts share exactly one quarantine guard", async () => {
  const result = await inspectOutputQuarantine("repeated");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection.rejections, Array.from({ length: 3 }, () => ({
    code: "OUTPUT_STREAM",
    message: "output stream failed"
  })));
  assert.equal(inspection.during.error, inspection.baseline.error + 1);
  assert.equal(inspection.during.close, inspection.baseline.close);
  assert.equal(inspection.during.drain, inspection.baseline.drain);
  assert.deepEqual(inspection.final, inspection.during);
  assert.deepEqual(inspection.uncaught, []);
  assert.deepEqual(inspection.unhandled, []);
});

test("the direct error-path stderr timeout retains its one guard for later errors", async () => {
  const result = await inspectOutputQuarantine("direct-stderr");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stderr, /late output secret|Error:|node:internal|json-io\.mjs/i);
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection.rejections, []);
  assert.equal(inspection.directExitCode, 1);
  assert.ok(inspection.rejectedAfterMs >= 900);
  assert.ok(inspection.rejectedAfterMs < 1300, `stderr timeout settled after ${inspection.rejectedAfterMs} ms`);
  assert.equal(inspection.final.error, inspection.baseline.error + 1);
  assert.equal(inspection.final.close, inspection.baseline.close);
  assert.equal(inspection.final.drain, inspection.baseline.drain);
  assert.deepEqual(inspection.uncaught, []);
  assert.deepEqual(inspection.unhandled, []);
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

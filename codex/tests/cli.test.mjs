import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, PassThrough, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatch, main } from "../scripts/harness-state.mjs";
import { readJsonInput } from "../scripts/lib/json-io.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readReceipts } from "../scripts/lib/receipts.mjs";
import { readState } from "../scripts/lib/state-store.mjs";
import { runCli } from "./helpers/run-cli.mjs";
import {
  makeWorkspace,
  writeClaudeCompletedPrefix
} from "./helpers/workspace.mjs";

const INPUT_LIMIT = 1024 * 1024;
const IMPORT_ACTION = "repair the Claude state or use a separate workspace";
const cliPath = fileURLToPath(new URL("../scripts/harness-state.mjs", import.meta.url));
const jsonIoUrl = new URL("../scripts/lib/json-io.mjs", import.meta.url).href;
const harnessStateUrl = new URL("../scripts/harness-state.mjs", import.meta.url).href;
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function evidence(detail = "verified by CLI") {
  return [
    {
      acceptance_id: "topic-contract",
      kind: "artifact",
      detail,
      ok: true,
      artifact_path: "step_archive/TOPIC/TOPIC.md"
    },
    {
      acceptance_id: "preflight-report",
      kind: "artifact",
      detail: "preflight report persisted",
      ok: true,
      artifact_path: "step_archive/step001_preflight.md"
    },
    {
      acceptance_id: "node-runtime-version",
      kind: "command",
      detail: "version command exited successfully",
      ok: true,
      command: "node --version",
      exit_code: 0
    },
    {
      acceptance_id: "npm-cli-version",
      kind: "command",
      detail: "version command exited successfully",
      ok: true,
      command: "npm --version",
      exit_code: 0
    },
    {
      acceptance_id: "required-tool-inventory",
      kind: "check",
      detail: "required tools verified",
      ok: true
    },
    {
      acceptance_id: "optional-tool-disposition",
      kind: "check",
      detail: "optional tools recorded",
      ok: true
    }
  ];
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

async function runCliFromCwd(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.once("error", reject);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("close", code => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
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
    const warnings = [];
    process.on("uncaughtException", error => uncaught.push(error.message));
    process.on("unhandledRejection", error => unhandled.push(error?.message ?? String(error)));
    process.on("warning", warning => warnings.push(warning.message));

    class HostileWritable extends EventEmitter {
      constructor({ backpressure = false, destroyMode = "close", listenerMode = "normal" } = {}) {
        super();
        this.backpressure = backpressure;
        this.destroyMode = destroyMode;
        this.listenerMode = listenerMode;
        this.destroyCalls = 0;
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

      on(...args) {
        if (this.listenerMode === "throw-add") throw new Error(secret);
        return super.on(...args);
      }

      addListener(...args) {
        if (this.listenerMode === "throw-add") throw new Error(secret);
        return super.addListener(...args);
      }

      removeListener(...args) {
        if (this.listenerMode === "throw-remove") throw new Error(secret);
        return super.removeListener(...args);
      }

      destroy() {
        this.destroyCalls += 1;
        if (this.destroyMode === "throw") throw new Error(secret);
        if (this.destroyMode === "noop") return this;
        if (this.destroyMode === "clear-errors") {
          EventEmitter.prototype.removeAllListeners.call(this, "error");
          return this;
        }
        this.destroyed = true;
        this.closed = true;
        this.emit("close");
        return this;
      }
    }

    const terminalEvents = [];
    const output = new HostileWritable({
      backpressure: mode === "backpressure",
      destroyMode: ["close-then-error", "destroy-noop", "double-error", "never", "repeated", "guard-reinstall", "concurrent"].includes(mode)
        ? "noop"
        : ["destroy-throw", "direct-destroy-throw"].includes(mode) ? "throw"
          : ["destroy-clears", "direct-destroy-clears"].includes(mode) ? "clear-errors" : "close",
      listenerMode: ["remove-throws", "direct-remove-throws"].includes(mode)
        ? "throw-remove"
        : ["add-throws", "direct-add-throws"].includes(mode) ? "throw-add" : "normal"
    });
    EventEmitter.prototype.on.call(output, "close", () => terminalEvents.push("close"));
    const baseline = {
      error: output.listenerCount("error"),
      close: output.listenerCount("close"),
      drain: output.listenerCount("drain")
    };
    const isDirect = mode.startsWith("direct-");
    const timeoutMs = isDirect ? 1000 : 5;
    const rejections = [];
    const startedAt = Date.now();
    const attempts = mode === "repeated" ? 3 : 1;
    let directExitCode = null;
    let afterGuardRemoval = null;
    if (isDirect) {
      const { runDirect } = await import(${JSON.stringify(harnessStateUrl)});
      await runDirect([], {
        stderr: output,
        runMain() {
          throw new Error(secret);
        }
      });
      directExitCode = process.exitCode;
    } else if (mode === "concurrent") {
      const results = await Promise.allSettled(Array.from(
        { length: 20 },
        () => writeOutput(output, "fixture", { timeoutMs })
      ));
      for (const result of results) {
        const error = result.reason;
        rejections.push({ code: error?.code, message: error?.message });
      }
    } else if (mode === "guard-reinstall") {
      for (let index = 0; index < 2; index += 1) {
        try {
          await writeOutput(output, "fixture", { timeoutMs });
        } catch (error) {
          rejections.push({ code: error.code, message: error.message });
        }
        if (index === 0) {
          EventEmitter.prototype.removeAllListeners.call(output, "error");
          afterGuardRemoval = output.listenerCount("error");
        }
      }
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
      else if (mode === "delayed-emitted-error" || mode === "backpressure" || isDirect) {
        output.emit("error", new Error(secret));
      } else if (["double-error", "destroy-noop", "destroy-throw", "destroy-clears", "remove-throws", "add-throws", "repeated", "guard-reinstall", "concurrent"].includes(mode)) {
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
      afterGuardRemoval,
      rejectedAfterMs,
      baseline,
      during,
      final,
      destroyCalls: output.destroyCalls,
      destroyed: output.destroyed,
      terminalEvents,
      uncaught,
      unhandled,
      warnings
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

test("dispatch derives the immutable installed package root for import and completion", async () => {
  const seen = [];
  const operations = {
    importClaudeProgress: async options => {
      seen.push(options);
      return { imported: true };
    },
    completeStep: async options => {
      seen.push(options);
      return { completed: true };
    }
  };

  await dispatch("import-claude", { workspace: "workspace" }, null, operations);
  await dispatch("complete", {
    workspace: "workspace",
    step: 1,
    attempt: "attempt",
    input: "-"
  }, { summary: "summary", evidence: [] }, operations);

  assert.equal(seen[0].pluginRoot, packageRoot);
  assert.equal(seen[1].pluginRoot, packageRoot);
});

test("all ten commands dispatch to their workflow operations with literal structured values", async () => {
  const parent = await makeWorkspace();
  const root = join(parent, "workspace 공간 $ & ;");
  await mkdir(root);
  const topic = "한국어 topic with spaces, \"quotes\", $dollar; & | $(never-run)\n";
  const session = "세션 with spaces $ & ; quotes-'";
  const detail = "검증 detail with \"quotes\", $cash; & |";

  const initialized = parseSuccess(await runCli([
    "init", "--workspace", root, "--input", "-"
  ], { input: { topic } }));
  assert.equal(await readFile(join(root, "step_archive", "TOPIC", "TOPIC.md"), "utf8"), topic);
  assert.equal(initialized.current_step, 1);
  await writeFile(join(root, "step_archive", "step001_preflight.md"), "preflight passed\n", "utf8");

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
    "complete", "--workspace", root,
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
  const unrelatedCwd = await makeWorkspace();
  const source = await writeClaudeCompletedPrefix(root, 2, { topic: "가져오기 topic\n" });
  const sourcePath = join(root, "step_archive", "progress.json");

  const imported = parseSuccess(await runCliFromCwd([
    "import-claude", "--workspace", root
  ], unrelatedCwd, {
    PLUGIN_ROOT: join(root, "attacker-plugin"),
    CLAUDE_PLUGIN_ROOT: join(root, "attacker-claude-plugin")
  }));
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
    { args: ["import-claude", "--workspace", root, "--plugin-root", root], code: "FLAG_UNKNOWN" },
    {
      args: [
        "complete", "--workspace", root, "--plugin-root", root,
        "--step", "1", "--attempt", "attempt", "--input", "-"
      ],
      code: "FLAG_UNKNOWN"
    },
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
    "complete", "--workspace", root,
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

test("main rejects a non-EventEmitter output shape before invoking its methods", async () => {
  const root = await makeWorkspace();
  let methodCalled = false;
  const output = {
    destroyed: false,
    writable: true,
    writableEnded: false,
    write(_value, callback) {
      methodCalled = true;
      callback();
      return true;
    },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    destroy() { return this; }
  };
  await assert.rejects(
    () => main(["show", "--workspace", root], { stdout: output }),
    error => error.code === "OUTPUT_STREAM" && error.message === "output stream failed"
  );
  assert.equal(methodCalled, false);
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
  { mode: "destroy-clears", label: "late errors when destroy clears error listeners" },
  { mode: "remove-throws", label: "a throwing removeListener override" },
  { mode: "add-throws", label: "throwing on and addListener overrides" },
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
    assert.deepEqual(inspection.warnings, []);
    assert.equal(inspection.destroyCalls, 0);
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

test("a later writeOutput call reinstalls one externally removed quarantine guard", async () => {
  const result = await inspectOutputQuarantine("guard-reinstall");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection.rejections, Array.from({ length: 2 }, () => ({
    code: "OUTPUT_STREAM",
    message: "output stream failed"
  })));
  assert.equal(inspection.afterGuardRemoval, 0);
  assert.equal(inspection.during.error, inspection.baseline.error + 1);
  assert.equal(inspection.during.close, inspection.baseline.close);
  assert.equal(inspection.during.drain, inspection.baseline.drain);
  assert.deepEqual(inspection.final, inspection.during);
  assert.equal(inspection.destroyCalls, 0);
  assert.deepEqual(inspection.uncaught, []);
  assert.deepEqual(inspection.unhandled, []);
  assert.deepEqual(inspection.warnings, []);
});

test("concurrent writeOutput timeouts share listeners without process warnings", async () => {
  const result = await inspectOutputQuarantine("concurrent");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning|late output secret|node:internal|json-io\.mjs/i);
  const inspection = JSON.parse(result.stdout);
  assert.deepEqual(inspection.rejections, Array.from({ length: 20 }, () => ({
    code: "OUTPUT_STREAM",
    message: "output stream failed"
  })));
  assert.equal(inspection.during.error, inspection.baseline.error + 1);
  assert.equal(inspection.during.close, inspection.baseline.close);
  assert.equal(inspection.during.drain, inspection.baseline.drain);
  assert.deepEqual(inspection.final, inspection.during);
  assert.equal(inspection.destroyCalls, 0);
  assert.deepEqual(inspection.uncaught, []);
  assert.deepEqual(inspection.unhandled, []);
  assert.deepEqual(inspection.warnings, []);
});

for (const fixture of [
  { mode: "direct-stderr", label: "ordinary hostile stderr" },
  { mode: "direct-destroy-clears", label: "stderr whose destroy clears listeners" },
  { mode: "direct-destroy-throw", label: "stderr whose destroy throws" },
  { mode: "direct-remove-throws", label: "stderr with a throwing removeListener override" },
  { mode: "direct-add-throws", label: "stderr with throwing listener-add overrides" }
]) {
  test(`the direct error path quarantines ${fixture.label}`, async () => {
    const result = await inspectOutputQuarantine(fixture.mode);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning|late output secret|Error:|node:internal|json-io\.mjs/i);
    const inspection = JSON.parse(result.stdout);
    assert.deepEqual(inspection.rejections, []);
    assert.equal(inspection.directExitCode, 1);
    assert.ok(inspection.rejectedAfterMs >= 900);
    assert.ok(inspection.rejectedAfterMs < 1300, `stderr timeout settled after ${inspection.rejectedAfterMs} ms`);
    assert.equal(inspection.final.error, inspection.baseline.error + 1);
    assert.equal(inspection.final.close, inspection.baseline.close);
    assert.equal(inspection.final.drain, inspection.baseline.drain);
    assert.equal(inspection.destroyCalls, 0);
    assert.deepEqual(inspection.uncaught, []);
    assert.deepEqual(inspection.unhandled, []);
    assert.deepEqual(inspection.warnings, []);
  });
}

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

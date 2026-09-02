import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beginStep, completeStep, initWorkflow } from "../scripts/lib/workflow.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import { runHook } from "./helpers/run-hook.mjs";
import {
  makeDirectoryLink,
  makePluginFixture,
  makeWorkspace,
  readJson
} from "./helpers/workspace.mjs";

const now = "2026-09-02T00:00:00.000Z";
const fixtureRoot = new URL("./fixtures/hooks/", import.meta.url);

function ids(prefix = "fixture-id") {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function fixture(name, workspaceRoot) {
  const value = await readJson(new URL(name, fixtureRoot));
  if (value.cwd === "__WORKSPACE__") value.cwd = workspaceRoot;
  return value;
}

async function init(root, prefix = "workflow") {
  return initWorkflow({
    workspaceRoot: root,
    topic: "Hook lifecycle fixture",
    now,
    idFactory: ids(prefix)
  });
}

async function begin(root, state, prefix = "attempt") {
  return beginStep({
    workspaceRoot: root,
    step: state.current_step,
    marker: { ...state.continuation },
    now: new Date(Math.max(Date.now(), Date.parse(state.updated_at) + 1)).toISOString(),
    idFactory: ids(prefix)
  });
}

async function events(root) {
  const raw = await readFile(pathsFor(root).eventsPath, "utf8").catch(error => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map(line => JSON.parse(line));
}

function markerFor(continuation) {
  return `[HARNESS50_CONTINUE ${JSON.stringify(continuation)}]`;
}

function assertEmptySuccess(result) {
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, {});
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "{}\n");
}

test("documented hook fixtures have distinct event-specific shapes", async () => {
  const names = [
    "session-start.json",
    "session-start-windows.json",
    "session-start-missing.json",
    "session-start-completed.json",
    "user-prompt-direct.json",
    "stop-running.json"
  ];
  const values = await Promise.all(names.map(name => readJson(new URL(name, fixtureRoot))));
  assert.deepEqual(values.map(value => value.hook_event_name), [
    "SessionStart", "SessionStart", "SessionStart", "SessionStart", "UserPromptSubmit", "Stop"
  ]);
  assert.equal(values[1].cwd, "C:\\Harness50 Workspaces\\fixture");
  assert.equal(values[4].prompt, "다른 버그를 먼저 고쳐줘");
  assert.equal(values[5].stop_hook_active, false);
});

test("SessionStart provides concise startup resume and compact context without mutating state", async () => {
  for (const source of ["startup", "resume", "compact"]) {
    const root = await makeWorkspace();
    await init(root, source);
    const before = await readFile(pathsFor(root).statePath);
    const result = await runHook("session-start", {
      hook_event_name: "SessionStart",
      cwd: root,
      source,
      session_id: `session-${source}`
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(Object.keys(result.output), ["hookSpecificOutput"]);
    assert.equal(result.output.hookSpecificOutput.hookEventName, "SessionStart");
    const context = result.output.hookSpecificOutput.additionalContext;
    assert.match(context, /^Harness50: running, 0\/50 complete\./);
    assert.match(context, /Topic: step_archive\/TOPIC\/TOPIC\.md\./);
    assert.match(context, /Next: Step 001\./);
    assert.match(context, /\$webapp resume\.$/);
    assert.ok(Buffer.from(await readFile(pathsFor(root).statePath)).equals(before));
    const observations = (await events(root)).filter(event => event.kind === "session_context_loaded");
    assert.equal(observations.length, 1);
    assert.deepEqual(Object.keys(observations[0]).sort(), [
      "completed_count", "kind", "status", "step", "timestamp", "workflow_id"
    ]);
  }
});

test("SessionStart missing and completed workflows return the documented empty result", async () => {
  const missingRoot = await makeWorkspace();
  assertEmptySuccess(await runHook("session-start", await fixture("session-start-missing.json", missingRoot)));

  const completedRoot = await makeWorkspace();
  const running = await init(completedRoot, "completed");
  await writeStateAtomic(completedRoot, {
    ...running,
    status: "completed",
    current_step: null,
    completed_steps: Array.from({ length: 50 }, (_, index) => index + 1),
    current_attempt: null,
    continuation: null,
    owner: null,
    completed_at: now
  });
  assertEmptySuccess(await runHook(
    "session-start",
    await fixture("session-start-completed.json", completedRoot)
  ));
});

test("SessionStart reports corrupt state concisely without overwrite or disclosure", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const secret = "sk-proj-session-secret-1234567890";
  const corrupt = Buffer.from(`{\"password\":\"${secret}\",`);
  await writeFile(paths.statePath, corrupt);
  const result = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "startup"
  }, { env: { HOOK_SECRET: secret } });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.output.hookSpecificOutput.additionalContext,
    "Harness50 state is unreadable. Run $harness50-status, then repair or reset the Codex workflow."
  );
  assert.ok(Buffer.from(await readFile(paths.statePath)).equals(corrupt));
  assert.doesNotMatch(result.stdout, /sk-proj|password|node:internal|hook-lifecycle|\\|\/[A-Za-z]/i);
});

test("SessionStart context remains available when its observation append fails", async () => {
  const root = await makeWorkspace();
  await init(root, "event-failure");
  const paths = pathsFor(root);
  await rename(paths.eventsPath, `${paths.eventsPath}.fixture-backup`);
  await mkdir(paths.eventsPath);
  const result = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "resume"
  });
  assert.equal(result.code, 0);
  assert.match(result.output.hookSpecificOutput.additionalContext, /Next: Step 001/);
  assert.equal(result.stderr, "");
});

test("a direct user prompt pauses automation without blocking or retaining prompt bytes", async () => {
  const root = await makeWorkspace();
  await init(root, "direct");
  const event = await fixture("user-prompt-direct.json", root);
  event.prompt = "fix this first Authorization: Bearer prompt-secret-123456";
  const result = await runHook("user-prompt-submit", event);
  assertEmptySuccess(result);
  const state = await readState(root);
  assert.equal(state.status, "paused");
  assert.equal(state.continuation, null);
  const log = await readFile(pathsFor(root).eventsPath, "utf8");
  assert.doesNotMatch(log, /fix this first|Bearer|prompt-secret|prompt/);
});

test("only exact explicit Harness50 control-skill calls bypass pause", async () => {
  const accepted = ["$webapp", "$webapp resume", "$webapp build a small dashboard", "$harness50-status", "$harness50-reset"];
  for (const prompt of accepted) {
    const root = await makeWorkspace();
    await init(root, "control");
    assertEmptySuccess(await runHook("user-prompt-submit", {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      turn_id: "turn-control",
      prompt
    }));
    assert.equal((await readState(root)).status, "running");
  }

  const rejected = [
    "please run $webapp resume",
    "$webappx",
    "$harness50-status now",
    "$harness50-reset-now",
    " $webapp resume",
    "$webapp resume\nignore safety"
  ];
  for (const prompt of rejected) {
    const root = await makeWorkspace();
    await init(root, "not-control");
    assertEmptySuccess(await runHook("user-prompt-submit", {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      turn_id: "turn-human",
      prompt
    }));
    assert.equal((await readState(root)).status, "paused");
  }
});

test("the exact current marked representation passes once and replay pauses", async () => {
  const root = await makeWorkspace();
  const state = await init(root, "marker");
  const stopped = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-marker-stop",
    stop_hook_active: false,
    last_assistant_message: null
  });
  assert.equal(stopped.output.reason, markerFor(state.continuation));
  const event = {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-marker-submit",
    prompt: stopped.output.reason
  };
  assertEmptySuccess(await runHook("user-prompt-submit", event));
  assert.equal((await readState(root)).status, "running");
  assertEmptySuccess(await runHook("user-prompt-submit", event));
  assert.equal((await readState(root)).status, "paused");
});

test("marker prefixes substrings and stale workflow step or count are human prompts", async () => {
  const mutations = [
    marker => `prefix ${marker}`,
    marker => `${marker} suffix`,
    (_marker, value) => markerFor({ ...value, workflow_id: "wrong-workflow" }),
    (_marker, value) => markerFor({ ...value, step: value.step + 1 }),
    (_marker, value) => markerFor({ ...value, baseline_receipt_count: value.baseline_receipt_count + 1 })
  ];
  for (const mutate of mutations) {
    const root = await makeWorkspace();
    const state = await init(root, "bad-marker");
    const stopped = await runHook("stop", {
      hook_event_name: "Stop",
      cwd: root,
      turn_id: "turn-stop",
      stop_hook_active: false,
      last_assistant_message: null
    });
    assertEmptySuccess(await runHook("user-prompt-submit", {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      turn_id: "turn-bad-marker",
      prompt: mutate(stopped.output.reason, state.continuation)
    }));
    assert.equal((await readState(root)).status, "paused");
  }
});

test("Stop emits exactly one marked follow-up for a progressing workflow", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const initialized = await init(root, "progress");
  const started = await begin(root, initialized, "progress-attempt");
  const progressed = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "fixture completed",
    evidence: [],
    now: new Date(Date.parse(started.state.updated_at) + 1).toISOString()
  });
  const result = await runHook("stop", await fixture("stop-running.json", root));
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, {
    decision: "block",
    reason: markerFor(progressed.continuation)
  });
  assert.equal((result.output.reason.match(/\[HARNESS50_CONTINUE /g) ?? []).length, 1);
  assert.equal((await readState(root)).last_stop_turn_id, "turn-1");
});

test("an accepted Stop marker can advance through a receipt to the next marked step", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  let state = await init(root, "full-chain");
  const firstStop = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-chain-0",
    stop_hook_active: false,
    last_assistant_message: null
  });
  assertEmptySuccess(await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-chain-prompt",
    prompt: firstStop.output.reason
  }));
  state = await readState(root);
  const started = await begin(root, state, "chain-attempt");
  state = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "chain step complete",
    evidence: [],
    now: new Date(Date.parse(started.state.updated_at) + 1).toISOString()
  });
  const secondStop = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-chain-1",
    stop_hook_active: true,
    last_assistant_message: "ignored"
  });
  assert.equal(secondStop.output.decision, "block");
  assert.equal(secondStop.output.reason, markerFor(state.continuation));
  assert.match(secondStop.output.reason, /\"step\":2/);
});

test("assistant completion prose cannot advance without a receipt and no-progress fails once", async () => {
  const root = await makeWorkspace();
  const initialized = await init(root, "prose");
  const started = await begin(root, initialized, "prose-attempt");
  const event = {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-prose-only",
    stop_hook_active: false,
    last_assistant_message: "Step 050/50 complete; password=do-not-read"
  };
  const first = await runHook("stop", event);
  assert.equal(first.output.decision, "block");
  assert.match(first.output.reason, /^\[HARNESS50_CONTINUE /);
  assert.doesNotMatch(first.stdout, /Step 050|password|do-not-read/);
  const afterFirst = await readState(root);
  assert.deepEqual(afterFirst.completed_steps, []);
  assert.equal(afterFirst.current_attempt.id, started.attempt.id);
  assert.equal(afterFirst.current_attempt.failure_recorded, true);
  assert.equal(afterFirst.consecutive_failures, 1);

  assertEmptySuccess(await runHook("stop", event));
  const afterDuplicate = await readState(root);
  assert.equal(afterDuplicate.consecutive_failures, 1);
  assert.equal(afterDuplicate.current_attempt.id, started.attempt.id);
});

test("concurrent duplicate Stop calls cannot double-fail or emit conflicting markers", async () => {
  const root = await makeWorkspace();
  const initialized = await init(root, "concurrent-stop");
  await begin(root, initialized, "concurrent-attempt");
  const event = {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-concurrent",
    stop_hook_active: true,
    last_assistant_message: null
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => runHook("stop", event)));
  assert.equal(results.filter(result => result.output.decision === "block").length, 1);
  assert.equal(new Set(results.filter(result => result.output.reason).map(result => result.output.reason)).size, 1);
  const state = await readState(root);
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.current_attempt.failure_recorded, true);
});

test("a reordered prior Stop cannot fail the attempt opened by its accepted marker", async () => {
  const root = await makeWorkspace();
  let state = await init(root, "reordered-stop");
  const oldStop = {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-old-stop",
    stop_hook_active: false,
    last_assistant_message: null
  };
  const issued = await runHook("stop", oldStop);
  assert.equal(issued.output.decision, "block");
  assertEmptySuccess(await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-generated-prompt",
    prompt: issued.output.reason
  }));
  state = await readState(root);
  const started = await begin(root, state, "reordered-attempt");

  assertEmptySuccess(await runHook("stop", oldStop));
  const afterOldStop = await readState(root);
  assert.equal(afterOldStop.current_attempt.id, started.attempt.id);
  assert.equal(afterOldStop.current_attempt.failure_recorded, false);
  assert.equal(afterOldStop.consecutive_failures, 0);

  const current = await runHook("stop", {
    ...oldStop,
    turn_id: "turn-current-stop",
    stop_hook_active: true
  });
  assert.equal(current.output.decision, "block");
  assert.equal((await readState(root)).consecutive_failures, 1);
});

test("stop_hook_active no-progress retries are bounded by the third durable failure", async () => {
  const root = await makeWorkspace();
  let state = await init(root, "bounded");
  for (let failure = 1; failure <= 3; failure += 1) {
    const started = await begin(root, state, `bounded-attempt-${failure}`);
    const stopped = await runHook("stop", {
      hook_event_name: "Stop",
      cwd: root,
      turn_id: `turn-failure-${failure}`,
      stop_hook_active: true,
      last_assistant_message: "not completion evidence"
    });
    state = await readState(root);
    assert.equal(state.current_attempt.id, started.attempt.id);
    assert.equal(state.consecutive_failures, failure);
    if (failure < 3) {
      assert.equal(stopped.output.decision, "block");
      assert.equal(stopped.output.reason, markerFor(state.continuation));
      assertEmptySuccess(await runHook("user-prompt-submit", {
        hook_event_name: "UserPromptSubmit",
        cwd: root,
        turn_id: `turn-retry-${failure}`,
        prompt: stopped.output.reason
      }));
      state = await readState(root);
    } else {
      assertEmptySuccess(stopped);
      assert.equal(state.status, "blocked");
      assert.equal(state.blocked_reason, "THREE_CONSECUTIVE_FAILURES");
      assert.equal(state.continuation, null);
    }
  }
});

test("paused blocked completed corrupt and missing Stop states always release", async () => {
  const roots = [];
  const missing = await makeWorkspace();
  roots.push(missing);

  for (const status of ["paused", "blocked", "completed"]) {
    const root = await makeWorkspace();
    const state = await init(root, status);
    if (status === "completed") {
      await writeStateAtomic(root, {
        ...state,
        status,
        current_step: null,
        completed_steps: Array.from({ length: 50 }, (_, index) => index + 1),
        continuation: null,
        completed_at: now
      });
    } else {
      await writeStateAtomic(root, {
        ...state,
        status,
        continuation: null,
        blocked_reason: status === "blocked" ? "TEST_BLOCK" : null
      });
    }
    roots.push(root);
  }

  const corrupt = await makeWorkspace();
  await mkdir(pathsFor(corrupt).codexDir, { recursive: true });
  await writeFile(pathsFor(corrupt).statePath, "{corrupt secret=never-echoed\n");
  roots.push(corrupt);

  for (const [index, root] of roots.entries()) {
    assertEmptySuccess(await runHook("stop", {
      hook_event_name: "Stop",
      cwd: root,
      turn_id: `turn-release-${index}`,
      stop_hook_active: false,
      last_assistant_message: "Bearer release-secret-123456"
    }));
  }
});

test("hook input is byte-bounded fatal UTF-8 and exactly one event object", async () => {
  const root = await makeWorkspace();
  const base = {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "startup"
  };
  const invalidInputs = [
    "{}{}",
    "[]",
    "null",
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
    Buffer.alloc(1024 * 1024 + 1, 0x20)
  ];
  for (const input of invalidInputs) {
    const result = await runHook("session-start", base, { input });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(Object.keys(result.output), ["error"]);
    assert.match(result.output.error.code, /^HOOK_/);
    assert.doesNotMatch(result.stdout, /node:internal|file:\/\/|\\codex\\|\/codex\//i);
  }
});

test("event-specific names fields types cwd turn IDs and booleans fail before mutation", async () => {
  const root = await makeWorkspace();
  const state = await init(root, "invalid-events");
  const other = await makeWorkspace();
  const cases = [
    ["session-start", { hook_event_name: "Stop", cwd: root, source: "startup" }, "HOOK_EVENT_INVALID"],
    ["session-start", { hook_event_name: "SessionStart", cwd: root, source: "launch" }, "HOOK_EVENT_INVALID"],
    ["session-start", { hook_event_name: "SessionStart", cwd: other, source: "startup" }, "HOOK_WORKSPACE_UNSAFE"],
    ["user-prompt-submit", { hook_event_name: "UserPromptSubmit", cwd: root, turn_id: "", prompt: "hello" }, "HOOK_EVENT_INVALID"],
    ["user-prompt-submit", { hook_event_name: "UserPromptSubmit", cwd: root, turn_id: "turn", prompt: 7 }, "HOOK_EVENT_INVALID"],
    ["stop", { hook_event_name: "Stop", cwd: root, turn_id: "turn", stop_hook_active: "false", last_assistant_message: null }, "HOOK_EVENT_INVALID"],
    ["stop", { hook_event_name: "Stop", cwd: root, turn_id: "turn", stop_hook_active: false, last_assistant_message: [], extra: true }, "HOOK_EVENT_INVALID"]
  ];
  for (const [name, event, expectedCode] of cases) {
    const result = await runHook(name, event, { cwd: root });
    assert.equal(result.code, 1);
    assert.equal(result.output.error.code, expectedCode);
    assert.equal(
      result.output.error.message,
      expectedCode === "HOOK_EVENT_INVALID" ? "hook event rejected" : "hook workspace rejected"
    );
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(await readState(root), state);
});

test("physical workspace links are rejected without following workflow state", async () => {
  const target = await makeWorkspace();
  await init(target, "physical");
  const holder = await makeWorkspace();
  const link = join(holder, "linked-workspace");
  await makeDirectoryLink(target, link);
  const result = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: link,
    source: "startup"
  }, { cwd: link });
  assert.equal(result.code, 1);
  assert.equal(result.output.error.code, "HOOK_WORKSPACE_UNSAFE");
  assert.equal(result.stderr, "");
});

test("hard-linked state and event control files are rejected before hook access", async () => {
  for (const field of ["statePath", "eventsPath"]) {
    const root = await makeWorkspace();
    await init(root, `hard-link-${field}`);
    const outside = await makeWorkspace();
    await link(pathsFor(root)[field], join(outside, `${field}.alias`));
    const result = await runHook("session-start", {
      hook_event_name: "SessionStart",
      cwd: root,
      source: "startup"
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.output, {
      error: { code: "HOOK_WORKSPACE_UNSAFE", message: "hook workspace rejected" }
    });
    assert.equal(result.stderr, "");
  }
});

test("malformed secret-bearing input and environment values never escape sanitized errors", async () => {
  const root = await makeWorkspace();
  const secret = "sk-proj-hook-secret-abcdefghijklmnopqrstuvwxyz";
  const result = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-secret",
    stop_hook_active: false,
    last_assistant_message: null
  }, {
    input: `{\"password\":\"${secret}\"`,
    env: { PRIVATE_HOOK_TOKEN: secret }
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /sk-proj|password|PRIVATE_HOOK|node:internal|\.mjs:/i);
});

test("runHook tolerates an early input-pipe close and bounds a broken output pipe", async () => {
  const root = await makeWorkspace();
  const large = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const oversized = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "startup"
  }, { input: large });
  assert.equal(oversized.code, 1);
  assert.equal(oversized.output.error.code, "HOOK_INPUT_TOO_LARGE");

  const closed = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "startup"
  }, { closeStdout: true });
  assert.notEqual(closed.code, 0);
  assert.equal(closed.output, null);
  assert.doesNotMatch(closed.stderr, /EPIPE|node:internal|\.mjs:|secret/i);
});

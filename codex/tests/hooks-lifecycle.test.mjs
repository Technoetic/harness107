import test from "node:test";
import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import { link, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { handleSessionStart } from "../hooks/session-start.mjs";
import { handleStop } from "../hooks/stop.mjs";
import { handleUserPromptSubmit } from "../hooks/user-prompt-submit.mjs";
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

function swapCodexDirectory(workspaceRoot, outsideRoot) {
  const original = pathsFor(workspaceRoot).codexDir;
  renameSync(original, `${original}.before-swap`);
  symlinkSync(
    pathsFor(outsideRoot).codexDir,
    original,
    process.platform === "win32" ? "junction" : "dir"
  );
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
  assert.deepEqual(values[0], {
    hook_event_name: "SessionStart",
    cwd: "__WORKSPACE__",
    source: "clear",
    session_id: "session-realistic-01",
    transcript_path: null,
    permission_mode: "default",
    model: "gpt-5.6-codex"
  });
  for (const value of values) {
    assert.equal(typeof value.session_id, "string");
    assert.ok(value.transcript_path === null || typeof value.transcript_path === "string");
    assert.equal(typeof value.permission_mode, "string");
    assert.equal(typeof value.model, "string");
  }
  assert.equal(values[4].agent_id, "agent-reviewer-01");
  assert.equal(values[4].agent_type, "reviewer");
  assert.equal(values[4].prompt, "다른 버그를 먼저 고쳐줘");
  assert.equal(values[5].stop_hook_active, false);
});

test("generated hook schemas require common wire fields and scope agent metadata to prompts", async () => {
  const root = await makeWorkspace();
  const complete = {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "startup",
    session_id: "session-required-wire",
    transcript_path: null,
    permission_mode: "default",
    model: "gpt-5.6-codex"
  };
  for (const field of ["session_id", "transcript_path", "permission_mode", "model"]) {
    const incomplete = { ...complete };
    delete incomplete[field];
    const result = await runHook("session-start", incomplete, { rawEvent: true });
    assert.equal(result.code, 1, field);
    assert.equal(result.output.error.code, "HOOK_EVENT_INVALID", field);
  }

  assertEmptySuccess(await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-agent-wire",
    prompt: "$webapp",
    agent_id: "agent-01",
    agent_type: "reviewer"
  }));
  for (const [name, event] of [
    ["session-start", { ...complete, agent_id: "agent-01" }],
    ["stop", {
      ...complete,
      hook_event_name: "Stop",
      turn_id: "turn-no-agent",
      stop_hook_active: false,
      last_assistant_message: null,
      agent_type: "reviewer"
    }],
    ["user-prompt-submit", {
      ...complete,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-bad-agent",
      prompt: "$webapp",
      agent_id: 7
    }]
  ]) {
    const result = await runHook(name, event, { rawEvent: true });
    assert.equal(result.code, 1);
    assert.equal(result.output.error.code, "HOOK_EVENT_INVALID");
  }
});

test("generated string identifiers accept schema-valid whitespace and Unicode without artifacts", async () => {
  const common = {
    session_id: " session/id 雪\n",
    transcript_path: null,
    permission_mode: "default",
    model: " model preview 雪 "
  };
  const cases = [
    ["session-start", {
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    }],
    ["user-prompt-submit", {
      ...common,
      hook_event_name: "UserPromptSubmit",
      turn_id: " turn/id 雪\n",
      prompt: "$webapp",
      agent_id: " agent/id 雪\n",
      agent_type: " reviewer type 雪 "
    }],
    ["stop", {
      ...common,
      hook_event_name: "Stop",
      turn_id: " turn/id 雪\n",
      stop_hook_active: false,
      last_assistant_message: null
    }]
  ];
  for (const [name, partial] of cases) {
    const root = await makeWorkspace();
    const result = await runHook(name, { ...partial, cwd: root }, { rawEvent: true });
    assertEmptySuccess(result);
    await assert.rejects(lstat(pathsFor(root).codexDir), error => error?.code === "ENOENT");
  }
});

test("SessionStart accepts the official full shape and all documented sources without mutating state", async () => {
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const root = await makeWorkspace();
    await init(root, source);
    const before = await readFile(pathsFor(root).statePath);
    const result = await runHook("session-start", {
      hook_event_name: "SessionStart",
      cwd: root,
      source,
      session_id: `session-${source}`,
      transcript_path: source === "clear" ? null : `transcripts/${source}.jsonl`,
      permission_mode: "default",
      model: "gpt-5.6-codex"
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
  assertEmptySuccess(await runHook("session-start", await fixture("session-start.json", missingRoot)));
  await assert.rejects(lstat(pathsFor(missingRoot).codexDir), error => error?.code === "ENOENT");

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

test("stop_hook_active releases bounded recursive entries until durable work advances", async () => {
  const root = await makeWorkspace();
  const initial = await init(root, "active-loop");
  const beforeEvents = await events(root);
  for (let retry = 0; retry < 5; retry += 1) {
    assertEmptySuccess(await runHook("stop", {
      hook_event_name: "Stop",
      cwd: root,
      turn_id: `turn-active-loop-${retry}`,
      stop_hook_active: true,
      last_assistant_message: "must remain ignored"
    }));
  }
  const after = await readState(root);
  assert.deepEqual(after, initial);
  assert.equal(after.consecutive_failures, 0);
  assert.equal((await events(root)).filter(event =>
    event.kind === "stop_continuation_requested" ||
    (event.kind === "step_failed" && event.reason_code === "STOP_NO_PROGRESS")
  ).length, 0);
  assert.deepEqual(await events(root), beforeEvents);
});

test("every Stop stays quiet after acceptance until the executor begins a new attempt", async () => {
  const root = await makeWorkspace();
  const initialized = await init(root, "active-before-attempt");
  await begin(root, initialized, "active-before-attempt-run");
  const failed = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-active-failed",
    stop_hook_active: true,
    last_assistant_message: null
  });
  assert.equal(failed.output.decision, "block");
  assertEmptySuccess(await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-active-accepted",
    prompt: failed.output.reason
  }));

  for (const stopHookActive of [false, true]) {
    for (let retry = 0; retry < 3; retry += 1) {
      assertEmptySuccess(await runHook("stop", {
        hook_event_name: "Stop",
        cwd: root,
        turn_id: `turn-waiting-${stopHookActive}-${retry}`,
        stop_hook_active: stopHookActive,
        last_assistant_message: null
      }));
    }
  }
  const state = await readState(root);
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.current_attempt.failure_recorded, true);
  assert.equal((await events(root)).filter(event =>
    event.kind === "stop_continuation_requested"
  ).length, 1);
});

test("a lost Stop output is re-delivered idempotently until its marker is accepted", async () => {
  const root = await makeWorkspace();
  const initialized = await init(root, "lost-output");
  const firstEvent = {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-lost-output",
    stop_hook_active: false,
    last_assistant_message: null
  };
  const lost = await runHook("stop", firstEvent, { closeStdout: true });
  assert.notEqual(lost.code, 0);
  assert.equal(lost.output, null);

  const expectedMarker = markerFor(initialized.continuation);
  const stateAfterLoss = await readState(root);
  const requestsAfterLoss = (await events(root)).filter(event =>
    event.kind === "stop_continuation_requested"
  );
  assert.equal(stateAfterLoss.last_stop_turn_id, firstEvent.turn_id);
  assert.equal(requestsAfterLoss.length, 1);

  const sameTurn = await runHook("stop", firstEvent);
  assert.deepEqual(sameTurn.output, { decision: "block", reason: expectedMarker });
  const newTurn = await runHook("stop", { ...firstEvent, turn_id: "turn-lost-output-retry" });
  assert.deepEqual(newTurn.output, { decision: "block", reason: expectedMarker });
  assert.equal((await readState(root)).last_stop_turn_id, firstEvent.turn_id);
  assert.equal((await events(root)).filter(event =>
    event.kind === "stop_continuation_requested"
  ).length, 1);

  assertEmptySuccess(await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-lost-output-prompt",
    prompt: expectedMarker
  }));
  assertEmptySuccess(await runHook("stop", {
    ...firstEvent,
    turn_id: "turn-after-acceptance",
    stop_hook_active: true
  }));
  assert.equal((await events(root)).filter(event =>
    event.kind === "stop_continuation_requested"
  ).length, 1);
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

  const repeated = await runHook("stop", event);
  assert.deepEqual(repeated.output, first.output);
  const afterDuplicate = await readState(root);
  assert.equal(afterDuplicate.consecutive_failures, 1);
  assert.equal(afterDuplicate.current_attempt.id, started.attempt.id);
  assert.equal((await events(root)).filter(item =>
    item.kind === "stop_continuation_requested" && item.turn_id === event.turn_id
  ).length, 1);
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
    ["session-start", { hook_event_name: "SessionStart", cwd: root, source: "startup", model: 7 }, "HOOK_EVENT_INVALID"],
    ["session-start", { hook_event_name: "SessionStart", cwd: root, source: "startup", permission_mode: "workspace-write" }, "HOOK_EVENT_INVALID"],
    ["session-start", { hook_event_name: "SessionStart", cwd: root, source: "startup", unknown_official_field: true }, "HOOK_EVENT_INVALID"],
    ["session-start", { hook_event_name: "SessionStart", cwd: other, source: "startup" }, "HOOK_WORKSPACE_UNSAFE"],
    ["session-start", { hook_event_name: "SessionStart", cwd: root, source: "startup", session_id: 7 }, "HOOK_EVENT_INVALID"],
    ["user-prompt-submit", { hook_event_name: "UserPromptSubmit", cwd: root, turn_id: 7, prompt: "hello" }, "HOOK_EVENT_INVALID"],
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

test("hook getters cannot redirect locked state or event mutations outside the workspace", async () => {
  for (const handlerName of ["prompt", "stop"]) {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await init(root, `swap-${handlerName}-inside`);
    await init(outside, `swap-${handlerName}-outside`);
    const outsideStateBefore = await readFile(pathsFor(outside).statePath);
    const outsideEventsBefore = await readFile(pathsFor(outside).eventsPath);
    let swapped = false;
    const swapOnce = value => {
      if (!swapped) {
        swapped = true;
        swapCodexDirectory(root, outside);
      }
      return value;
    };

    const operation = handlerName === "prompt"
      ? handleUserPromptSubmit({
        turn_id: "turn-swap-prompt",
        get prompt() { return swapOnce("human prompt must not escape"); }
      }, { workspaceRoot: root })
      : handleStop({
        turn_id: "turn-swap-stop",
        get stop_hook_active() { return swapOnce(true); }
      }, { workspaceRoot: root });

    await assert.rejects(operation, error => error?.code === "HOOK_WORKSPACE_UNSAFE");
    assert.equal(swapped, true);
    assert.ok(Buffer.from(await readFile(pathsFor(outside).statePath)).equals(outsideStateBefore));
    assert.ok(Buffer.from(await readFile(pathsFor(outside).eventsPath)).equals(outsideEventsBefore));
  }
});

test("hook append callbacks cannot redirect SessionStart PromptSubmit or Stop events outside", async () => {
  for (const handlerName of ["session", "prompt", "stop"]) {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await init(root, `append-${handlerName}-inside`);
    await init(outside, `append-${handlerName}-outside`);
    const outsideStateBefore = await readFile(pathsFor(outside).statePath);
    const outsideEventsBefore = await readFile(pathsFor(outside).eventsPath);
    let swapped = false;
    const eventNow = () => {
      if (!swapped) {
        swapped = true;
        swapCodexDirectory(root, outside);
      }
      return new Date("2026-09-02T12:00:00.000Z");
    };

    let operation;
    if (handlerName === "session") {
      operation = handleSessionStart({}, { workspaceRoot: root, eventNow });
    } else if (handlerName === "prompt") {
      operation = handleUserPromptSubmit({
        turn_id: "turn-append-prompt",
        prompt: "pause safely"
      }, { workspaceRoot: root, eventNow });
    } else {
      operation = handleStop({
        turn_id: "turn-append-stop",
        stop_hook_active: false
      }, { workspaceRoot: root, eventNow });
    }
    await operation.catch(() => {});

    assert.equal(swapped, true, handlerName);
    assert.ok(
      Buffer.from(await readFile(pathsFor(outside).statePath)).equals(outsideStateBefore),
      `${handlerName} changed outside state`
    );
    assert.ok(
      Buffer.from(await readFile(pathsFor(outside).eventsPath)).equals(outsideEventsBefore),
      `${handlerName} changed outside events`
    );
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

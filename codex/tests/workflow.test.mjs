import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  lstatSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  watch
} from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { importClaudeProgress } from "../scripts/lib/importer.mjs";
import {
  OWNER_LEASE_MS,
  assertOwner,
  claimOwner,
  ownerLeaseExpired,
  renewOwner,
  transferOwner
} from "../scripts/lib/ownership.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import {
  readReceipts,
  receiptPath,
  syncDirectoryDurable,
  writeReceiptExclusive
} from "../scripts/lib/receipts.mjs";
import { createInitialState, validateState } from "../scripts/lib/schema.mjs";
import { readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import {
  acceptStopDelivery,
  beginStep,
  completeStep,
  consumeContinuation,
  failStep,
  initWorkflow,
  issueContinuation,
  pauseWorkflow,
  processStop,
  reconcileWorkflow,
  resetWorkflow,
  resumeWorkflow,
  showWorkflow
} from "../scripts/lib/workflow.mjs";
import {
  hashFile,
  makeDirectoryLink,
  makePluginFixture,
  makeWorkspace,
  writeClaudeCompletedPrefix
} from "./helpers/workspace.mjs";

const baseTime = "2026-09-02T00:00:00.000Z";

function ids(...values) {
  let index = 0;
  return () => values[index++] ?? `fixture-id-${index}`;
}

function plus(milliseconds) {
  return new Date(Date.parse(baseTime) + milliseconds).toISOString();
}

function initialState() {
  return createInitialState({
    workflowId: "workflow-1",
    workspaceRoot: "C:/fixture",
    topicSha256: "a".repeat(64),
    now: baseTime
  });
}

function evidenceFor(step, detail = `verified step ${step}`) {
  return [{
    acceptance_id: "state-transition",
    kind: "check",
    detail,
    ok: true
  }];
}

async function readEvents(root) {
  const raw = await readFile(pathsFor(root).eventsPath, "utf8");
  return raw.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function replaceWithDirectoryLink(path, target) {
  const heldPath = `${path}.held-for-containment-test`;
  if (existsSync(path)) renameSync(path, heldPath);
  symlinkSync(resolve(target), path, process.platform === "win32" ? "junction" : "dir");
  return () => {
    if (existsSync(path)) {
      try {
        if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
        else rmdirSync(path);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        rmdirSync(path);
      }
    }
    if (existsSync(heldPath)) renameSync(heldPath, path);
  };
}

function replaceWithHardLink(path, target) {
  const heldPath = `${path}.held-for-hard-link-test`;
  if (existsSync(path)) renameSync(path, heldPath);
  linkSync(target, path);
  return () => {
    if (existsSync(path)) unlinkSync(path);
    if (existsSync(heldPath)) renameSync(heldPath, path);
  };
}

function callbackEvidence(callback, detail = "callback evidence") {
  let called = false;
  const item = {
    acceptance_id: "state-transition",
    kind: "check",
    ok: true
  };
  Object.defineProperty(item, "detail", {
    enumerable: true,
    get() {
      if (!called) {
        called = true;
        callback();
      }
      return detail;
    }
  });
  return [item];
}

async function crashChildAfterReceipt({ root, pluginRoot, step, attemptId, summary, evidence, now }) {
  await mkdir(pathsFor(root).receiptsDir, { recursive: true });
  let publish;
  const published = new Promise(resolve => {
    publish = resolve;
  });
  const watcher = watch(pathsFor(root).receiptsDir, (eventType, filename) => {
    if (filename === `step${String(step).padStart(3, "0")}.json`) publish();
  });
  const moduleUrl = new URL("../scripts/lib/workflow.mjs", import.meta.url).href;
  const input = { workspaceRoot: root, pluginRoot, step, attemptId, summary, evidence, now };
  const script = `
    import { completeStep } from ${JSON.stringify(moduleUrl)};
    await completeStep(${JSON.stringify(input)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  const exited = once(child, "exit");
  let timeout;
  try {
    await Promise.race([
      published,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("receipt publication timeout")), 5000);
      })
    ]);
    child.kill();
    await exited;
    if (existsSync(pathsFor(root).lockPath)) {
      await rename(pathsFor(root).lockPath, `${pathsFor(root).lockPath}.crashed-test-lock`);
    }
  } finally {
    clearTimeout(timeout);
    watcher.close();
    if (child.exitCode === null) child.kill();
  }
  assert.equal(existsSync(receiptPath(root, step)), true);
}

async function initAndBegin(root, {
  sessionId = "session-1",
  initNow = baseTime,
  beginNow = plus(1),
  idFactory = ids("workflow-1", "nonce-1", "attempt-1")
} = {}) {
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "Safe fixture topic",
    now: initNow,
    idFactory
  });
  const marker = { ...initialized.continuation };
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId,
    marker,
    now: beginNow,
    idFactory
  });
  return { ...started, marker };
}

async function failCurrentStepThreeTimes(root) {
  const factory = ids("workflow-fail", "nonce-initial", "attempt-1", "attempt-2", "attempt-3");
  let state = await initWorkflow({
    workspaceRoot: root,
    topic: "Failure fixture",
    now: baseTime,
    idFactory: factory
  });
  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const started = await beginStep({
      workspaceRoot: root,
      step: 1,
      sessionId: "session-fail",
      marker: { ...state.continuation },
      now: plus(attemptNumber * 2 - 1),
      idFactory: factory
    });
    state = await failStep({
      workspaceRoot: root,
      step: 1,
      attemptId: started.attempt.id,
      reason: `fixture failure ${attemptNumber}`,
      evidence: evidenceFor(1, `failed check ${attemptNumber}`),
      now: plus(attemptNumber * 2)
    });
  }
  return state;
}

test("owner lease is live before expiry and expired at the exact boundary", () => {
  let state = claimOwner(initialState(), { sessionId: "session-1", now: baseTime });
  assert.equal(ownerLeaseExpired(state.owner, plus(OWNER_LEASE_MS - 1)), false);
  assert.equal(ownerLeaseExpired(state.owner, plus(OWNER_LEASE_MS)), true);
  assert.doesNotThrow(() => assertOwner(state, { sessionId: "session-1", now: plus(OWNER_LEASE_MS - 1) }));
  assert.throws(
    () => assertOwner(state, { sessionId: "session-1", now: plus(OWNER_LEASE_MS) }),
    error => error.code === "OWNER_LEASE_EXPIRED"
  );

  state = renewOwner(state, { sessionId: "session-1", now: plus(100) });
  assert.equal(state.owner.lease_updated_at, plus(100));
  assert.throws(
    () => claimOwner(state, { sessionId: "session-2", now: plus(101) }),
    error => error.code === "OWNER_CONFLICT"
  );
  assert.throws(
    () => ownerLeaseExpired(state.owner, baseTime),
    error => error.code === "CLOCK_REGRESSION"
  );
});

test("anonymous ownership stays null and transfer invalidates attempt and continuation", () => {
  let state = issueContinuation(initialState(), { now: baseTime, nonce: "nonce-old" });
  state = {
    ...state,
    current_attempt: {
      id: "attempt-old",
      step: 1,
      session_id: null,
      started_at: baseTime,
      failure_recorded: false
    }
  };
  assert.equal(claimOwner(state, { sessionId: null, now: baseTime }).owner, null);
  const transferred = transferOwner(state, {
    sessionId: "session-2",
    now: plus(1),
    nonce: "nonce-new"
  });
  assert.equal(transferred.owner.session_id, "session-2");
  assert.equal(transferred.current_attempt, null);
  assert.match(transferred.continuation.nonce, /^continuation-[a-f0-9]{64}$/);
  assert.notEqual(transferred.continuation.nonce, "nonce-old");
  const retransferred = transferOwner(transferred, {
    sessionId: "session-2",
    now: plus(1),
    nonce: "nonce-new"
  });
  assert.notEqual(retransferred.continuation.nonce, transferred.continuation.nonce);
});

test("continuations are one-use and bind workflow step and receipt count", () => {
  const issued = issueContinuation(initialState(), { now: baseTime, nonce: "nonce-1" });
  const marker = { ...issued.continuation };
  const consumed = consumeContinuation(issued, { marker });
  assert.equal(consumed.continuation, null);
  assert.equal(consumed.stop_delivery, null);
  assert.throws(
    () => consumeContinuation({ ...issued, continuation: null, stop_delivery: null }, { marker }),
    error => error.code === "CONTINUATION_REPLAY"
  );
  for (const [field, value, code] of [
    ["workflow_id", "other", "CONTINUATION_WORKFLOW_MISMATCH"],
    ["step", 2, "CONTINUATION_STEP_MISMATCH"],
    ["baseline_receipt_count", 1, "CONTINUATION_COUNT_MISMATCH"]
  ]) {
    assert.throws(
      () => consumeContinuation(issued, { marker: { ...marker, [field]: value } }),
      error => error.code === code
    );
  }
  assert.throws(
    () => consumeContinuation(issued, { marker: { ...marker, nonce: "nonce-wrong" } }),
    error => error.code === "CONTINUATION_REPLAY"
  );
});

test("processStop claims delivery in state and replays it without event authority", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "state delivery",
    now: baseTime,
    idFactory: ids("workflow-delivery", "nonce-delivery", "generation-delivery")
  });
  const first = await processStop({
    workspaceRoot: root,
    turnId: "turn-delivery",
    stopHookActive: false,
    now: plus(1)
  });
  assert.deepEqual(first, { decision: "block", continuation: initialized.continuation });
  const claimed = await readState(root);
  assert.deepEqual(claimed.stop_delivery, {
    generation_id: "generation-delivery",
    requested_turn_id: "turn-delivery",
    accepted: false,
    allow_active_stop: false
  });

  await writeFile(pathsFor(root).eventsPath, "");
  assert.deepEqual(await processStop({
    workspaceRoot: root,
    turnId: "turn-retry",
    stopHookActive: false,
    now: plus(2)
  }), first);
  assert.equal((await readState(root)).stop_delivery.requested_turn_id, "turn-delivery");
});

test("processStop propagates post-commit telemetry path swaps and replays after repair", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "projection integrity",
    now: baseTime,
    idFactory: ids("workflow-projection", "nonce-projection", "generation-projection")
  });
  const paths = pathsFor(root);
  const held = `${paths.eventsPath}.held-projection`;
  let callbackCalls = 0;
  await assert.rejects(() => processStop({
    workspaceRoot: root,
    turnId: "turn-projection",
    stopHookActive: false,
    now: plus(1),
    eventBatchOptions: {
      beforeAppend: async () => {
        callbackCalls += 1;
        await rename(paths.eventsPath, held);
        await writeFile(paths.eventsPath, "outside replacement\n");
      }
    }
  }), error => error.code === "WORKSPACE_PATH_UNSAFE");
  assert.equal(callbackCalls, 1);
  const committed = await readState(root);
  assert.equal(committed.stop_delivery.requested_turn_id, "turn-projection");
  assert.equal(await readFile(paths.eventsPath, "utf8"), "outside replacement\n");

  await unlink(paths.eventsPath);
  await rename(held, paths.eventsPath);
  assert.deepEqual(await processStop({
    workspaceRoot: root,
    turnId: "turn-projection-retry",
    stopHookActive: false,
    now: plus(2)
  }), { decision: "block", continuation: initialized.continuation });
});

test("processStop tolerates an ordinary post-commit telemetry fault and replays from state", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "projection availability",
    now: baseTime,
    idFactory: ids("workflow-projection-io", "nonce-projection-io", "generation-projection-io")
  });
  const result = await processStop({
    workspaceRoot: root,
    turnId: "turn-projection-io",
    stopHookActive: false,
    now: plus(1),
    eventBatchOptions: {
      beforeAppend: async () => {
        const error = new Error("fixture projection failure");
        error.code = "EIO";
        throw error;
      }
    }
  });
  assert.deepEqual(result, { decision: "block", continuation: initialized.continuation });
  assert.equal((await readState(root)).stop_delivery.requested_turn_id, "turn-projection-io");
  assert.deepEqual(await processStop({
    workspaceRoot: root,
    turnId: "turn-projection-io-retry",
    stopHookActive: false,
    now: plus(2)
  }), result);
});

test("acceptStopDelivery atomically accepts only the exact requested state marker", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "accept delivery",
    now: baseTime,
    idFactory: ids("workflow-accept", "nonce-accept", "generation-accept")
  });
  await processStop({ workspaceRoot: root, turnId: "turn-accept", stopHookActive: false, now: plus(1) });
  const exact = `[HARNESS50_CONTINUE ${JSON.stringify(initialized.continuation)}]`;
  assert.equal(await acceptStopDelivery({ workspaceRoot: root, prompt: `${exact} trailing`, now: plus(2) }), false);
  assert.equal((await readState(root)).stop_delivery.accepted, false);
  assert.equal(await acceptStopDelivery({ workspaceRoot: root, prompt: exact, now: plus(3) }), true);
  const accepted = await readState(root);
  assert.equal(accepted.stop_delivery.accepted, true);
  assert.equal(accepted.stop_delivery.requested_turn_id, "turn-accept");
  assert.equal(await acceptStopDelivery({ workspaceRoot: root, prompt: exact, now: plus(4) }), false);
});

test("a consumed same-turn active Stop fails once while its inactive replay releases", async t => {
  for (const active of [false, true]) {
    await t.test(`stop_hook_active=${active}`, async () => {
      const root = await makeWorkspace();
      const initialized = await initWorkflow({
        workspaceRoot: root,
        topic: `same turn ${active}`,
        now: baseTime,
        idFactory: ids(`workflow-same-${active}`, `nonce-same-${active}`, `generation-same-${active}`)
      });
      await processStop({ workspaceRoot: root, turnId: "turn-same", stopHookActive: false, now: plus(1) });
      const started = await beginStep({
        workspaceRoot: root,
        step: 1,
        marker: initialized.continuation,
        now: plus(2),
        idFactory: ids(`attempt-same-${active}`)
      });
      const result = await processStop({
        workspaceRoot: root,
        turnId: "turn-same",
        stopHookActive: active,
        now: plus(3),
        idFactory: ids(`nonce-failed-${active}`, `generation-failed-${active}`)
      });
      const state = await readState(root);
      if (active) {
        assert.equal(result.decision, "block");
        assert.equal(state.current_attempt.id, started.attempt.id);
        assert.equal(state.current_attempt.failure_recorded, true);
        assert.equal(state.consecutive_failures, 1);
        assert.deepEqual(result.continuation, state.continuation);
      } else {
        assert.deepEqual(result, { decision: "release" });
        assert.equal(state.current_attempt.failure_recorded, false);
        assert.equal(state.consecutive_failures, 0);
      }
    });
  }
});

test("processStop recovers a receipt-first step into one claimed next continuation", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(2),
    summary: "durable receipt",
    evidence: evidenceFor(1)
  });

  const result = await processStop({
    workspaceRoot: root,
    turnId: "turn-receipt-forward",
    stopHookActive: true,
    now: plus(3),
    idFactory: ids("nonce-receipt-forward", "generation-receipt-forward")
  });
  const state = await readState(root);
  assert.equal(result.decision, "block");
  assert.equal(result.continuation.step, 2);
  assert.deepEqual(state.completed_steps, [1]);
  assert.equal(state.current_step, 2);
  assert.equal(state.stop_delivery.generation_id, "generation-receipt-forward");
  assert.equal(state.stop_delivery.requested_turn_id, "turn-receipt-forward");
  assert.equal(state.stop_delivery.allow_active_stop, true);
});

test("concurrent receipt-first Stops publish one generation without conflicting claims", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(2),
    summary: "concurrent durable receipt",
    evidence: evidenceFor(1)
  });

  const results = await Promise.all(["left", "right"].map(label => processStop({
    workspaceRoot: root,
    turnId: `turn-receipt-${label}`,
    stopHookActive: true,
    now: plus(3),
    idFactory: ids("nonce-receipt-concurrent", "generation-receipt-concurrent")
  })));
  assert.equal(results.filter(result => result.decision === "block").length, 1);
  assert.equal(results.filter(result => result.decision === "release").length, 1);
  const state = await readState(root);
  assert.equal(state.completed_steps.length, 1);
  assert.equal(state.stop_delivery.generation_id, "generation-receipt-concurrent");
  assert.ok(["turn-receipt-left", "turn-receipt-right"].includes(state.stop_delivery.requested_turn_id));
  const requests = (await readEvents(root)).filter(event =>
    event.kind === "stop_continuation_requested" &&
    event.generation_id === "generation-receipt-concurrent"
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].turn_id, state.stop_delivery.requested_turn_id);
});

test("processStop capacity uses the exact full UTF-8 failure batch before state mutation", async t => {
  const transitionTime = plus(3);
  const nextGeneration = "세대-🙂";
  const nextNonce = "비밀-🙂";
  const turnId = "정지-turn-🙂";
  const padding = length => {
    const prefix = '{"kind":"padding","padding":"';
    const suffix = '"}\n';
    return Buffer.from(prefix + "p".repeat(length - Buffer.byteLength(prefix + suffix)) + suffix);
  };
  for (const extraByte of [1, 0]) {
    await t.test(extraByte === 1 ? "one byte short" : "exact fit", async () => {
      const root = await makeWorkspace();
      const initialized = await initWorkflow({
        workspaceRoot: root,
        topic: "UTF-8 capacity",
        now: baseTime,
        idFactory: ids("워크플로-🙂", "초기-nonce", "초기-generation")
      });
      const started = await beginStep({
        workspaceRoot: root,
        step: 1,
        marker: initialized.continuation,
        now: plus(1),
        idFactory: ids("시도-🙂")
      });
      const expectedEvents = [{
        kind: "step_failed",
        workflow_id: initialized.workflow_id,
        step: 1,
        attempt_id: started.attempt.id,
        failure_count: 1,
        consecutive_failures: 1,
        timestamp: transitionTime
      }, {
        kind: "continuation_issued",
        workflow_id: initialized.workflow_id,
        step: 1,
        generation_id: nextGeneration,
        baseline_receipt_count: 0,
        timestamp: transitionTime
      }, {
        kind: "stop_continuation_requested",
        workflow_id: initialized.workflow_id,
        step: 1,
        turn_id: turnId,
        generation_id: nextGeneration,
        baseline_receipt_count: 0,
        timestamp: transitionTime
      }];
      const batch = Buffer.from(expectedEvents.map(event => `${JSON.stringify(event)}\n`).join(""));
      const paths = pathsFor(root);
      const originalEvents = await readFile(paths.eventsPath);
      const targetSize = (1024 * 1024) - batch.length + extraByte;
      await writeFile(paths.eventsPath, Buffer.concat([
        originalEvents,
        padding(targetSize - originalEvents.length)
      ]));
      const stateBefore = await readFile(paths.statePath);
      const receiptsBefore = await readReceipts(root);

      const operation = processStop({
        workspaceRoot: root,
        turnId,
        stopHookActive: true,
        now: transitionTime,
        idFactory: ids(nextNonce, nextGeneration)
      });
      if (extraByte === 1) {
        await assert.rejects(operation, error => error.code === "EVENT_LOG_LIMIT");
        assert.ok(Buffer.from(await readFile(paths.statePath)).equals(stateBefore));
        assert.deepEqual(await readReceipts(root), receiptsBefore);
        assert.equal((await readFile(paths.eventsPath)).length, targetSize);
      } else {
        const result = await operation;
        assert.equal(result.decision, "block");
        assert.equal(result.continuation.nonce, nextNonce);
        assert.equal((await readFile(paths.eventsPath)).length, 1024 * 1024);
        assert.equal((await readFile(paths.eventsPath)).subarray(-batch.length).equals(batch), true);
      }
    });
  }
});

test("a full ledger cannot mutate the third active failure into blocked state", async () => {
  const root = await makeWorkspace();
  let state = await initWorkflow({
    workspaceRoot: root,
    topic: "third failure capacity",
    now: baseTime,
    idFactory: ids("workflow-third-capacity", "nonce-initial", "generation-initial")
  });
  for (let failure = 1; failure <= 2; failure += 1) {
    const started = await beginStep({
      workspaceRoot: root,
      step: 1,
      marker: state.continuation,
      now: plus(failure * 2 - 1),
      idFactory: ids(`attempt-${failure}`)
    });
    const stopped = await processStop({
      workspaceRoot: root,
      turnId: `turn-${failure}`,
      stopHookActive: true,
      now: plus(failure * 2),
      idFactory: ids(`nonce-${failure}`, `generation-${failure}`)
    });
    assert.equal(stopped.decision, "block");
    state = await readState(root);
    assert.equal(state.current_attempt.id, started.attempt.id);
  }
  await beginStep({
    workspaceRoot: root,
    step: 1,
    marker: state.continuation,
    now: plus(5),
    idFactory: ids("attempt-3")
  });
  const paths = pathsFor(root);
  const original = await readFile(paths.eventsPath);
  const prefix = '{"kind":"padding","padding":"';
  const suffix = '"}\n';
  const remaining = (1024 * 1024) - original.length - Buffer.byteLength(prefix + suffix);
  await writeFile(paths.eventsPath, Buffer.concat([
    original,
    Buffer.from(prefix + "p".repeat(remaining) + suffix)
  ]));
  const stateBefore = await readFile(paths.statePath);

  await assert.rejects(() => processStop({
    workspaceRoot: root,
    turnId: "turn-third-full",
    stopHookActive: true,
    now: plus(6)
  }), error => error.code === "EVENT_LOG_LIMIT");
  assert.ok(Buffer.from(await readFile(paths.statePath)).equals(stateBefore));
  assert.equal((await readState(root)).consecutive_failures, 2);
});

test("new workflow atomically creates topic and refuses all recognized shared work", async t => {
  const root = await makeWorkspace();
  const state = await initWorkflow({
    workspaceRoot: root,
    topic: "안전한 주제",
    now: baseTime,
    idFactory: ids("workflow-init", "nonce-init")
  });
  const topicPath = join(root, "step_archive", "TOPIC", "TOPIC.md");
  assert.equal(state.topic_path, "step_archive/TOPIC/TOPIC.md");
  assert.equal(state.topic_sha256, await hashFile(topicPath));
  assert.equal(await readFile(topicPath, "utf8"), "안전한 주제\n");
  await assert.rejects(
    () => initWorkflow({ workspaceRoot: root, topic: "다른 주제", now: plus(1), idFactory: ids("unused") }),
    error => error.code === "WORKFLOW_CONFLICT"
  );
  assert.equal(await readFile(topicPath, "utf8"), "안전한 주제\n");

  const conflictFixtures = [
    ["Claude progress", async candidate => {
      await mkdir(join(candidate, "step_archive"), { recursive: true });
      await writeFile(join(candidate, "step_archive", "progress.json"), "{}\n");
    }],
    ["existing topic", async candidate => {
      await mkdir(join(candidate, "step_archive", "TOPIC"), { recursive: true });
      await writeFile(join(candidate, "step_archive", "TOPIC", "TOPIC.md"), "existing\n");
    }],
    ["recognized output", async candidate => {
      await mkdir(join(candidate, "step_archive", "outputs"), { recursive: true });
      await writeFile(join(candidate, "step_archive", "outputs", "result.md"), "existing\n");
    }],
    ["incomplete Codex metadata", async candidate => {
      await mkdir(pathsFor(candidate).codexDir, { recursive: true });
      await writeFile(pathsFor(candidate).importErrorPath, "{}\n");
    }]
  ];
  for (const [name, prepare] of conflictFixtures) {
    await t.test(name, async () => {
      const candidate = await makeWorkspace();
      await prepare(candidate);
      await assert.rejects(
        () => initWorkflow({ workspaceRoot: candidate, topic: "new", now: baseTime, idFactory: ids("unused") }),
        error => error.code === "WORKFLOW_CONFLICT"
      );
      assert.equal(existsSync(join(candidate, "step_archive", "TOPIC", "TOPIC.md")), name === "existing topic");
    });
  }
});

test("init rejects a redirected TOPIC directory before writing outside the workspace", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  const archiveRoot = join(root, "step_archive");
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(external, "sentinel.txt"), "outside-before\n");
  await makeDirectoryLink(external, join(archiveRoot, "TOPIC"));

  await assert.rejects(
    () => initWorkflow({
      workspaceRoot: root,
      topic: "must stay inside",
      now: baseTime,
      idFactory: ids("workflow-unsafe", "nonce-unsafe")
    }),
    error => error.code === "WORKSPACE_PATH_UNSAFE"
  );
  assert.equal(existsSync(join(external, "TOPIC.md")), false);
  assert.equal(await readFile(join(external, "sentinel.txt"), "utf8"), "outside-before\n");
  assert.equal(await readState(root), null);
});

test("workflow mutations reject redirected control roots before creating an external lock", async () => {
  const initRoot = await makeWorkspace();
  const initExternal = await makeWorkspace();
  await makeDirectoryLink(initExternal, join(initRoot, "step_archive"));
  await assert.rejects(
    () => initWorkflow({
      workspaceRoot: initRoot,
      topic: "redirected archive",
      now: baseTime,
      idFactory: ids("workflow-root-link", "nonce-root-link")
    }),
    error => error.code === "WORKSPACE_PATH_UNSAFE"
  );
  assert.deepEqual(await readdir(initExternal), []);

  const resetRoot = await makeWorkspace();
  const resetExternal = await makeWorkspace();
  await mkdir(join(resetRoot, "step_archive"), { recursive: true });
  await makeDirectoryLink(resetExternal, pathsFor(resetRoot).codexDir);
  await assert.rejects(
    () => resetWorkflow({ workspaceRoot: resetRoot, now: baseTime }),
    error => error.code === "WORKSPACE_PATH_UNSAFE"
  );
  assert.deepEqual(await readdir(resetExternal), []);
});

test("first-use topic hierarchy and publication are durable with platform-correct handles", async () => {
  const root = await makeWorkspace();
  await initWorkflow({
    workspaceRoot: root,
    topic: "durable topic",
    now: baseTime,
    idFactory: ids("workflow-durable", "nonce-durable")
  });
  for (const path of [
    join(root, "step_archive"),
    join(root, "step_archive", "TOPIC")
  ]) {
    assert.equal((await stat(path)).isDirectory(), true);
    await assert.doesNotReject(() => syncDirectoryDurable(path));
  }
  assert.equal(await readFile(join(root, "step_archive", "TOPIC", "TOPIC.md"), "utf8"), "durable topic\n");

  const flags = [];
  const openDirectory = async (path, flag) => {
    flags.push(flag);
    return { sync: async () => {}, close: async () => {} };
  };
  await syncDirectoryDurable(root, { platform: "win32", openDirectory });
  await syncDirectoryDurable(root, { platform: "linux", openDirectory });
  assert.deepEqual(flags, ["r+", "r"]);
});

test("concurrent initialization serializes and never mixes topic with workflow state", async () => {
  const root = await makeWorkspace();
  const settled = await Promise.allSettled([
    initWorkflow({ workspaceRoot: root, topic: "topic A", now: baseTime, idFactory: ids("workflow-a", "nonce-a") }),
    initWorkflow({ workspaceRoot: root, topic: "topic B", now: baseTime, idFactory: ids("workflow-b", "nonce-b") })
  ]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter(result => result.status === "rejected" && result.reason.code === "WORKFLOW_CONFLICT").length, 1);
  const state = await readState(root);
  const topicPath = join(root, "step_archive", "TOPIC", "TOPIC.md");
  assert.equal(state.topic_sha256, await hashFile(topicPath));
  assert.ok(["topic A\n", "topic B\n"].includes(await readFile(topicPath, "utf8")));
});

test("begin consumes exactly the current marker and creates one unique current attempt", async () => {
  const root = await makeWorkspace();
  const factory = ids("workflow-begin", "nonce-begin", "attempt-begin");
  const initialized = await initWorkflow({ workspaceRoot: root, topic: "begin", now: baseTime, idFactory: factory });
  const marker = { ...initialized.continuation };
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker,
    now: plus(1),
    idFactory: factory
  });
  assert.match(started.attempt.id, /^attempt-[a-f0-9]{64}$/);
  assert.deepEqual(started.attempt, {
    id: started.attempt.id,
    step: 1,
    session_id: null,
    started_at: plus(1),
    failure_recorded: false
  });
  assert.equal(started.state.owner, null);
  assert.equal(started.state.continuation, null);
  assert.deepEqual(await readState(root), started.state);
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: null, marker, now: plus(2), idFactory: ids("attempt-other") }),
    error => error.code === "CONTINUATION_REPLAY"
  );
});

test("concurrent begin calls serialize so a marker creates only one attempt", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "concurrent begin",
    now: baseTime,
    idFactory: ids("workflow-concurrent", "nonce-concurrent")
  });
  const marker = { ...initialized.continuation };
  const settled = await Promise.allSettled([
    beginStep({ workspaceRoot: root, step: 1, sessionId: null, marker, now: plus(1), idFactory: ids("attempt-a") }),
    beginStep({ workspaceRoot: root, step: 1, sessionId: null, marker, now: plus(1), idFactory: ids("attempt-b") })
  ]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter(result => result.status === "rejected" && result.reason.code === "CONTINUATION_REPLAY").length, 1);
  assert.match((await readState(root)).current_attempt.id, /^attempt-[a-f0-9]{64}$/);
});

test("valid ownership blocks ordinary mutation but explicit resume transfers and stales old work", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const first = await initAndBegin(root, { sessionId: "session-1" });
  const oldMarker = first.marker;
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: "session-2", marker: oldMarker, now: plus(2), idFactory: ids("attempt-2") }),
    error => error.code === "OWNER_CONFLICT"
  );

  const transferred = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "session-2",
    now: plus(3),
    idFactory: ids("nonce-transferred")
  });
  assert.equal(transferred.owner.session_id, "session-2");
  assert.equal(transferred.current_attempt, null);
  assert.notEqual(transferred.continuation.nonce, oldMarker.nonce);
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: "session-1", marker: oldMarker, now: plus(4), idFactory: ids("attempt-old") }),
    error => error.code === "CONTINUATION_REPLAY"
  );
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: first.attempt.id,
      summary: "stale",
      evidence: evidenceFor(1),
      now: plus(4)
    }),
    error => error.code === "ATTEMPT_STALE"
  );
});

test("resume cannot resurrect a consumed marker or recreate its attempt with repeated IDs and time", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const repeated = () => "repeated-id";
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "generation binding",
    now: baseTime,
    idFactory: repeated
  });
  const oldMarker = { ...initialized.continuation };
  const first = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: "session-generation",
    marker: oldMarker,
    now: baseTime,
    idFactory: repeated
  });
  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "session-generation",
    now: baseTime,
    idFactory: repeated
  });
  assert.notDeepEqual(resumed.continuation, oldMarker);
  await assert.rejects(
    () => beginStep({
      workspaceRoot: root,
      step: 1,
      sessionId: "session-generation",
      marker: oldMarker,
      now: baseTime,
      idFactory: repeated
    }),
    error => error.code === "CONTINUATION_REPLAY"
  );
  const second = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: "session-generation",
    marker: { ...resumed.continuation },
    now: baseTime,
    idFactory: repeated
  });
  assert.notEqual(second.attempt.id, first.attempt.id);
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: first.attempt.id,
      summary: "stale attempt",
      evidence: evidenceFor(1),
      now: baseTime
    }),
    error => error.code === "ATTEMPT_STALE"
  );
});

test("retry after failure cannot recreate a stale attempt when the raw ID repeats", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const repeated = () => "repeated-failure-id";
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "failed attempt generations",
    now: baseTime,
    idFactory: repeated
  });
  const first = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker: { ...initialized.continuation },
    now: baseTime,
    idFactory: repeated
  });
  const failed = await failStep({
    workspaceRoot: root,
    step: 1,
    attemptId: first.attempt.id,
    reason: "retry",
    evidence: evidenceFor(1),
    now: baseTime
  });
  const second = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker: { ...failed.continuation },
    now: baseTime,
    idFactory: repeated
  });
  assert.notEqual(second.attempt.id, first.attempt.id);
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: first.attempt.id,
      summary: "stale failed attempt",
      evidence: evidenceFor(1),
      now: baseTime
    }),
    error => error.code === "ATTEMPT_STALE"
  );
});

test("workflow mutations reject regressing clocks even for anonymous ownership", async () => {
  const futureState = validateState({ ...initialState(), updated_at: plus(100) });
  assert.throws(
    () => claimOwner(futureState, { sessionId: null, now: baseTime }),
    error => error.code === "CLOCK_REGRESSION"
  );
  assert.throws(
    () => issueContinuation(futureState, { now: baseTime, nonce: "stale-clock-nonce" }),
    error => error.code === "CLOCK_REGRESSION"
  );
  assert.throws(
    () => transferOwner(futureState, { sessionId: null, now: baseTime, nonce: "stale-transfer" }),
    error => error.code === "CLOCK_REGRESSION"
  );
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "monotonic clock",
    now: plus(100),
    idFactory: ids("workflow-clock", "nonce-clock")
  });
  await assert.rejects(
    () => beginStep({
      workspaceRoot: root,
      step: 1,
      sessionId: null,
      marker: { ...initialized.continuation },
      now: baseTime,
      idFactory: ids("attempt-clock")
    }),
    error => error.code === "CLOCK_REGRESSION"
  );
  assert.deepEqual(await readState(root), initialized);
});

test("an owned attempt is rejected once its lease reaches expiry", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root, { sessionId: "session-stale" });
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "too late",
      evidence: evidenceFor(1),
      now: plus(1 + OWNER_LEASE_MS)
    }),
    error => error.code === "OWNER_LEASE_EXPIRED"
  );
  assert.deepEqual(await readReceipts(root), []);
  assert.equal((await readState(root)).current_attempt.id, started.attempt.id);
});

test("complete writes a sanitized receipt before state and advances exactly one step", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  const state = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "preflight passed",
    evidence: evidenceFor(1, "tool inventory"),
    now: plus(2)
  });
  assert.deepEqual(state.completed_steps, [1]);
  assert.equal(state.current_step, 2);
  assert.equal(state.current_attempt, null);
  assert.equal(state.consecutive_failures, 0);
  assert.equal(state.owner.lease_updated_at, plus(2));
  assert.equal(state.continuation.step, 2);
  const [receipt] = await readReceipts(root);
  assert.equal(receipt.attempt_id, started.attempt.id);
  assert.deepEqual(receipt.evidence, evidenceFor(1, "tool inventory"));
});

test("receipt-first state failure is recoverable and semantic complete retry is idempotent", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  await crashChildAfterReceipt({
    root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "durable receipt",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  assert.equal((await readReceipts(root)).length, 1);
  assert.deepEqual((await readState(root)).completed_steps, []);

  const recovered = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "durable receipt",
    evidence: evidenceFor(1),
    now: plus(50)
  });
  assert.deepEqual(recovered.completed_steps, [1]);
  assert.equal((await readReceipts(root)).length, 1);
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "different content",
      evidence: evidenceFor(1),
      now: plus(51)
    }),
    error => error.code === "RECEIPT_CONFLICT"
  );
});

test("exact receipt crash-gap recovery advances at and after owner lease expiry", async () => {
  for (const elapsed of [OWNER_LEASE_MS, OWNER_LEASE_MS + 1000]) {
    const root = await makeWorkspace();
    const pluginRoot = await makePluginFixture();
    const started = await initAndBegin(root, { initNow: baseTime, beginNow: baseTime });
    await writeReceiptExclusive(root, {
      schema_version: 1,
      workflow_id: started.state.workflow_id,
      step: 1,
      attempt_id: started.attempt.id,
      provenance: "codex-verified",
      completed_at: plus(1),
      summary: "crash-gap lease recovery",
      evidence: evidenceFor(1)
    });
    const recovered = await completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "crash-gap lease recovery",
      evidence: evidenceFor(1),
      now: plus(elapsed)
    });
    assert.deepEqual(recovered.completed_steps, [1]);
    assert.equal(recovered.current_step, 2);
    assert.equal(recovered.owner, null);
  }
});

test("Step 50 publishes its receipt before completed state", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 49);
  await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now: () => new Date(baseTime),
    idFactory: ids("workflow-step-50")
  });
  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "session-50",
    now: plus(1),
    idFactory: ids("nonce-50")
  });
  const started = await beginStep({
    workspaceRoot: root,
    step: 50,
    sessionId: "session-50",
    marker: { ...resumed.continuation },
    now: plus(2),
    idFactory: ids("attempt-50")
  });
  await crashChildAfterReceipt({
    root,
    pluginRoot,
    step: 50,
    attemptId: started.attempt.id,
    summary: "final step",
    evidence: evidenceFor(50),
    now: plus(3)
  });
  const stateAtReceipt = await readState(root);
  const completed = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 50,
    attemptId: started.attempt.id,
    summary: "final step",
    evidence: evidenceFor(50),
    now: plus(4)
  });
  assert.equal(stateAtReceipt.status, "running");
  assert.equal(stateAtReceipt.current_step, 50);
  assert.equal(completed.status, "completed");
  assert.equal(completed.current_step, null);
  assert.equal(completed.completed_steps.length, 50);
  assert.equal(completed.completed_at, plus(3));
});

test("complete validates plugin roots and rejects sensitive evidence before mutation", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot: join(root, "missing-plugin"),
      step: 1,
      attemptId: started.attempt.id,
      summary: "invalid plugin",
      evidence: evidenceFor(1),
      now: plus(2)
    }),
    error => error.code === "PLUGIN_ROOT_INVALID"
  );
  const pluginRoot = await makePluginFixture();
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "secret evidence",
      evidence: evidenceFor(1, "Authorization: Bearer abcdefghijklmnop"),
      now: plus(2)
    }),
    error => error.code === "SENSITIVE_EVIDENCE"
  );
  assert.deepEqual(await readReceipts(root), []);
  assert.deepEqual(await readState(root), started.state);
});

test("complete rejects a plugin step index redirected outside the resolved plugin root", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  const pluginRoot = await makeWorkspace();
  const external = await makeWorkspace();
  await mkdir(join(pluginRoot, "codex", "assets"), { recursive: true });
  await mkdir(join(external, "steps"), { recursive: true });
  await writeFile(join(external, "steps", "index.json"), "{}\n");
  await makeDirectoryLink(join(external, "steps"), join(pluginRoot, "codex", "assets", "steps"));

  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "redirected plugin",
      evidence: evidenceFor(1),
      now: plus(2)
    }),
    error => error.code === "PLUGIN_ROOT_INVALID"
  );
  assert.deepEqual(await readReceipts(root), []);
  assert.deepEqual(await readState(root), started.state);
});

test("complete ignores caller-supplied writer and hook seams and persists through production writers", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  let executed = false;
  const forbidden = async () => {
    executed = true;
    return started.state;
  };
  const completed = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "production persistence only",
    evidence: evidenceFor(1),
    now: plus(2),
    hooks: { afterReceipt: forbidden },
    stateWriter: forbidden,
    receiptWriter: forbidden
  });
  assert.equal(executed, false);
  assert.deepEqual((await readState(root)).completed_steps, [1]);
  assert.equal((await readReceipts(root)).length, 1);
  assert.deepEqual(completed, await readState(root));
});

test("each attempt can fail once and three consecutive failures block", async () => {
  const root = await makeWorkspace();
  const factory = ids("workflow-once", "nonce-once", "attempt-once");
  const initialized = await initWorkflow({ workspaceRoot: root, topic: "fail once", now: baseTime, idFactory: factory });
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: "session-1",
    marker: { ...initialized.continuation },
    now: plus(1),
    idFactory: factory
  });
  const failed = await failStep({
    workspaceRoot: root,
    step: 1,
    attemptId: started.attempt.id,
    reason: "acceptance failed",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  assert.equal(failed.consecutive_failures, 1);
  assert.equal(failed.current_attempt.failure_recorded, true);
  assert.equal(failed.continuation.step, 1);
  await assert.rejects(
    () => failStep({
      workspaceRoot: root,
      step: 1,
      attemptId: started.attempt.id,
      reason: "duplicate",
      evidence: [],
      now: plus(3)
    }),
    error => error.code === "ATTEMPT_ALREADY_FAILED"
  );

  const blockedRoot = await makeWorkspace();
  const blocked = await failCurrentStepThreeTimes(blockedRoot);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.consecutive_failures, 3);
  assert.equal(blocked.blocked_reason, "THREE_CONSECUTIVE_FAILURES");
  assert.equal(blocked.continuation, null);
  const events = await readEvents(blockedRoot);
  assert.deepEqual(events.filter(event => event.kind === "step_failed").map(event => event.failure_count), [1, 2, 3]);
  assert.equal(events.at(-1).kind, "workflow_blocked");
});

test("explicit resume opens a fresh retry window and pause obeys state boundaries", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "pause fixture",
    now: baseTime,
    idFactory: ids("workflow-pause", "nonce-before-pause")
  });
  const paused = await pauseWorkflow({ workspaceRoot: root, reason: "user request", now: plus(1) });
  assert.equal(paused.status, "paused");
  assert.equal(paused.continuation, null);
  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: null,
    now: plus(2),
    idFactory: ids("nonce-after-pause")
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.owner, null);
  assert.equal(resumed.consecutive_failures, 0);
  assert.notEqual(resumed.continuation.nonce, initialized.continuation.nonce);

  const blockedRoot = await makeWorkspace();
  await failCurrentStepThreeTimes(blockedRoot);
  await assert.rejects(
    () => pauseWorkflow({ workspaceRoot: blockedRoot, reason: "invalid", now: plus(10) }),
    error => error.code === "WORKFLOW_STATE"
  );
  const unblocked = await resumeWorkflow({
    workspaceRoot: blockedRoot,
    sessionId: "session-2",
    now: plus(11),
    idFactory: ids("nonce-unblocked")
  });
  assert.equal(unblocked.status, "running");
  assert.equal(unblocked.consecutive_failures, 0);
  assert.equal(unblocked.blocked_reason, null);
  assert.equal(unblocked.current_attempt, null);
});

test("pause renews a live owner lease and rejects the exact expiry boundary", async () => {
  const root = await makeWorkspace();
  await initAndBegin(root, { sessionId: "session-pause", initNow: baseTime, beginNow: baseTime });
  const paused = await pauseWorkflow({
    workspaceRoot: root,
    reason: "pause before expiry",
    now: plus(4 * 60 * 1000)
  });
  assert.equal(paused.owner.lease_updated_at, plus(4 * 60 * 1000));

  const expiredRoot = await makeWorkspace();
  const started = await initAndBegin(expiredRoot, {
    sessionId: "session-expired",
    initNow: baseTime,
    beginNow: baseTime
  });
  await assert.rejects(
    () => pauseWorkflow({
      workspaceRoot: expiredRoot,
      reason: "too late",
      now: plus(OWNER_LEASE_MS)
    }),
    error => error.code === "OWNER_LEASE_EXPIRED"
  );
  assert.deepEqual(await readState(expiredRoot), started.state);
});

test("begin rejects a codex directory swap performed by its idFactory without outside writes", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "callback containment",
    now: baseTime,
    idFactory: ids("workflow-callback", "nonce-callback")
  });
  await writeFile(join(external, "sentinel.txt"), "outside-before\n");
  const codexDir = pathsFor(root).codexDir;
  let restore;
  try {
    await assert.rejects(
      () => beginStep({
        workspaceRoot: root,
        step: 1,
        sessionId: "session-callback",
        marker: { ...initialized.continuation },
        now: plus(1),
        idFactory: () => {
          restore = replaceWithDirectoryLink(codexDir, external);
          return "attempt-after-swap";
        }
      }),
      error => error.code === "WORKSPACE_PATH_UNSAFE"
    );
    assert.deepEqual((await readdir(external)).sort(), ["sentinel.txt"]);
    assert.equal(await readFile(join(external, "sentinel.txt"), "utf8"), "outside-before\n");
  } finally {
    restore?.();
  }
  assert.deepEqual(await readState(root), initialized);
});

test("evidence callbacks cannot redirect receipt, state, or event control paths", async () => {
  const pluginRoot = await makePluginFixture();
  for (const controlName of ["receiptsDir", "statePath", "eventsPath"]) {
    const root = await makeWorkspace();
    const external = await makeWorkspace();
    const started = await initAndBegin(root);
    const controlPath = pathsFor(root)[controlName];
    await writeFile(join(external, "sentinel.txt"), "outside-before\n");
    let restore;
    const evidence = callbackEvidence(() => {
      restore = replaceWithDirectoryLink(controlPath, external);
    });
    try {
      const operation = controlName === "receiptsDir"
        ? () => completeStep({
            workspaceRoot: root,
            pluginRoot,
            step: 1,
            attemptId: started.attempt.id,
            summary: "must remain contained",
            evidence,
            now: plus(2)
          })
        : () => failStep({
            workspaceRoot: root,
            step: 1,
            attemptId: started.attempt.id,
            reason: "must remain contained",
            evidence,
            now: plus(2)
          });
      await assert.rejects(operation, error => error.code === "WORKSPACE_PATH_UNSAFE");
      assert.deepEqual((await readdir(external)).sort(), ["sentinel.txt"]);
      assert.equal(await readFile(join(external, "sentinel.txt"), "utf8"), "outside-before\n");
    } finally {
      restore?.();
    }
    assert.deepEqual(await readState(root), started.state);
  }
});

test("fail rejects an event hard link installed by evidence before state advances", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  const started = await initAndBegin(root);
  const externalEvent = join(external, "external-events.jsonl");
  await writeFile(externalEvent, "outside-before\n");
  let restore;
  try {
    await assert.rejects(
      () => failStep({
        workspaceRoot: root,
        step: 1,
        attemptId: started.attempt.id,
        reason: "hard-link containment",
        evidence: callbackEvidence(() => {
          restore = replaceWithHardLink(pathsFor(root).eventsPath, externalEvent);
        }),
        now: plus(2)
      }),
      error => error.code === "WORKSPACE_PATH_UNSAFE"
    );
    assert.equal(await readFile(externalEvent, "utf8"), "outside-before\n");
  } finally {
    restore?.();
  }
  assert.deepEqual(await readState(root), started.state);
});

test("begin rejects an event hard link installed by idFactory before state advances", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "hard-link begin containment",
    now: baseTime,
    idFactory: ids("workflow-hard-link", "nonce-hard-link")
  });
  const externalEvent = join(external, "external-events.jsonl");
  await writeFile(externalEvent, "outside-before\n");
  let restore;
  try {
    await assert.rejects(
      () => beginStep({
        workspaceRoot: root,
        step: 1,
        sessionId: "session-hard-link",
        marker: { ...initialized.continuation },
        now: plus(1),
        idFactory: () => {
          restore = replaceWithHardLink(pathsFor(root).eventsPath, externalEvent);
          return "attempt-hard-link";
        }
      }),
      error => error.code === "WORKSPACE_PATH_UNSAFE"
    );
    assert.equal(await readFile(externalEvent, "utf8"), "outside-before\n");
  } finally {
    restore?.();
  }
  assert.deepEqual(await readState(root), initialized);
  assert.equal((await stat(pathsFor(root).eventsPath)).nlink, 1);
});

test("reconcile advances a receipt crash gap and blocks malformed receipt storage", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(2),
    summary: "crash gap",
    evidence: evidenceFor(1)
  });
  const recovered = await reconcileWorkflow({
    workspaceRoot: root,
    now: plus(3),
    idFactory: ids("nonce-reconciled", "generation-reconciled")
  });
  assert.deepEqual(recovered.completed_steps, [1]);
  assert.equal(recovered.current_step, 2);
  assert.equal(recovered.continuation.nonce, "nonce-reconciled");
  assert.deepEqual(recovered.stop_delivery, {
    generation_id: "generation-reconciled",
    requested_turn_id: null,
    accepted: false,
    allow_active_stop: true
  });

  await writeFile(receiptPath(root, 2), "not-json\n", "utf8");
  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(4) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "RECEIPT_PARSE_ERROR");
  assert.deepEqual(blocked.completed_steps, [1]);
});

test("reconcile keeps receipt-forward paused workflows paused without a delivery", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await pauseWorkflow({ workspaceRoot: root, reason: "human pause", now: plus(2) });
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(3),
    summary: "receipt while paused",
    evidence: evidenceFor(1)
  });

  const recovered = await reconcileWorkflow({
    workspaceRoot: root,
    now: plus(4),
    idFactory: () => {
      throw new Error("paused recovery must not issue a continuation");
    }
  });
  assert.equal(recovered.status, "paused");
  assert.deepEqual(recovered.completed_steps, [1]);
  assert.equal(recovered.current_step, 2);
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.continuation, null);
  assert.equal(recovered.stop_delivery, null);
});

test("reconcile completes a receipt-first Step 50 without a delivery", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 49);
  await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now: () => new Date(baseTime),
    idFactory: ids("workflow-reconcile-50")
  });
  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "session-reconcile-50",
    now: plus(1),
    idFactory: ids("nonce-reconcile-50", "generation-reconcile-50")
  });
  const started = await beginStep({
    workspaceRoot: root,
    step: 50,
    sessionId: "session-reconcile-50",
    marker: resumed.continuation,
    now: plus(2),
    idFactory: ids("attempt-reconcile-50")
  });
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 50,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(3),
    summary: "final receipt before state",
    evidence: evidenceFor(50)
  });

  const recovered = await reconcileWorkflow({ workspaceRoot: root, now: plus(4) });
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.completed_steps.length, 50);
  assert.equal(recovered.current_step, null);
  assert.equal(recovered.continuation, null);
  assert.equal(recovered.stop_delivery, null);
});

test("reconcile blocks a mismatched forward attempt without discarding the active attempt", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: "different-attempt-generation",
    provenance: "codex-verified",
    completed_at: plus(2),
    summary: "not the persisted attempt",
    evidence: evidenceFor(1)
  });

  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(3) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "RECEIPT_ATTEMPT_MISMATCH");
  assert.deepEqual(blocked.completed_steps, []);
  assert.deepEqual(blocked.current_attempt, started.attempt);
  assert.equal(blocked.current_step, 1);
});

test("reconcile preserves the active attempt and owner for a wrong-workflow forward receipt", async () => {
  for (const [elapsed, ownerExpected] of [[3, true], [OWNER_LEASE_MS, false]]) {
    const root = await makeWorkspace();
    const started = await initAndBegin(root, { initNow: baseTime, beginNow: baseTime });
    await writeReceiptExclusive(root, {
      schema_version: 1,
      workflow_id: "different-workflow",
      step: 1,
      attempt_id: started.attempt.id,
      provenance: "codex-verified",
      completed_at: plus(2),
      summary: "unauthorized workflow",
      evidence: evidenceFor(1)
    });

    const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(elapsed) });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_reason, "RECEIPT_WORKFLOW_MISMATCH");
    assert.deepEqual(blocked.completed_steps, []);
    assert.deepEqual(blocked.current_attempt, started.attempt);
    if (ownerExpected) assert.deepEqual(blocked.owner, started.state.owner);
    else assert.equal(blocked.owner, null);
    assert.doesNotThrow(() => validateState(blocked));
  }
});

test("reconcile receipt gaps preserve a schema-coherent active attempt without advancing", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const stepOne = await initAndBegin(root);
  const afterStepOne = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: stepOne.attempt.id,
    summary: "trusted prefix",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  const stepTwo = await beginStep({
    workspaceRoot: root,
    step: 2,
    sessionId: "session-1",
    marker: { ...afterStepOne.continuation },
    now: plus(3),
    idFactory: ids("attempt-step-two")
  });
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: afterStepOne.workflow_id,
    step: 3,
    attempt_id: "unauthorized-future-attempt",
    provenance: "codex-verified",
    completed_at: plus(4),
    summary: "gap after trusted prefix",
    evidence: evidenceFor(3)
  });

  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(5) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "RECEIPT_GAP");
  assert.deepEqual(blocked.completed_steps, [1]);
  assert.deepEqual(blocked.current_attempt, stepTwo.attempt);
  assert.deepEqual(blocked.owner, stepTwo.state.owner);
  assert.doesNotThrow(() => validateState(blocked));
});

test("reconcile exact crash-gap recovery releases an owner at the lease boundary", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root, { initNow: baseTime, beginNow: baseTime });
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(1),
    summary: "exact persisted attempt",
    evidence: evidenceFor(1)
  });

  const recovered = await reconcileWorkflow({ workspaceRoot: root, now: plus(OWNER_LEASE_MS) });
  assert.deepEqual(recovered.completed_steps, [1]);
  assert.equal(recovered.current_step, 2);
  assert.equal(recovered.owner, null);
});

test("reconcile converts malformed and sensitive receipt evidence into safe blocked state", async () => {
  for (const [rawEvidence, expectedCode] of [
    [[{ acceptance_id: "state-transition", kind: "check", detail: 42, ok: true }], "EVIDENCE_INVALID"],
    [[{
      acceptance_id: "state-transition",
      kind: "check",
      detail: "Authorization: Bearer abcdefghijklmnop",
      ok: true
    }], "SENSITIVE_EVIDENCE"]
  ]) {
    const root = await makeWorkspace();
    const started = await initAndBegin(root);
    await mkdir(pathsFor(root).receiptsDir, { recursive: true });
    await writeFile(receiptPath(root, 1), `${JSON.stringify({
      schema_version: 1,
      workflow_id: started.state.workflow_id,
      step: 1,
      attempt_id: started.attempt.id,
      provenance: "codex-verified",
      completed_at: plus(2),
      summary: "malformed evidence",
      evidence: rawEvidence
    })}\n`);

    const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(3) });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_reason, expectedCode);
    assert.deepEqual(blocked.completed_steps, []);
    assert.equal(blocked.current_step, 1);
    assert.equal(blocked.continuation, null);
  }
});

test("reconcile preserves a valid trusted prefix before later malformed evidence", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  const afterStepOne = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "valid native prefix",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  await writeFile(receiptPath(root, 2), `${JSON.stringify({
    schema_version: 1,
    workflow_id: afterStepOne.workflow_id,
    step: 2,
    attempt_id: "malformed-step-two",
    provenance: "codex-verified",
    completed_at: plus(3),
    summary: "bad later evidence",
    evidence: [{ acceptance_id: null, kind: "check", detail: false, ok: true }]
  })}\n`);

  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(4) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "EVIDENCE_INVALID");
  assert.deepEqual(blocked.completed_steps, [1]);
  assert.equal(blocked.current_step, 2);
});

test("reconcile malformed-tail blocks release expired owners and preserve live owners", async () => {
  for (const [elapsed, ownerExpected] of [
    [OWNER_LEASE_MS - 1, true],
    [OWNER_LEASE_MS, false],
    [OWNER_LEASE_MS + 1000, false]
  ]) {
    const root = await makeWorkspace();
    const started = await initAndBegin(root, { initNow: baseTime, beginNow: baseTime });
    await writeReceiptExclusive(root, {
      schema_version: 1,
      workflow_id: started.state.workflow_id,
      step: 1,
      attempt_id: started.attempt.id,
      provenance: "codex-verified",
      completed_at: plus(1),
      summary: "authorized trusted prefix",
      evidence: evidenceFor(1)
    });
    await writeFile(receiptPath(root, 2), `${JSON.stringify({
      schema_version: 1,
      workflow_id: started.state.workflow_id,
      step: 2,
      attempt_id: "malformed-tail",
      provenance: "codex-verified",
      completed_at: plus(2),
      summary: "malformed tail",
      evidence: [{ acceptance_id: null, kind: "check", detail: 42, ok: true }]
    })}\n`);
    if (elapsed === OWNER_LEASE_MS - 1) {
      await assert.rejects(
        () => reconcileWorkflow({ workspaceRoot: root, now: plus(-1) }),
        error => error.code === "CLOCK_REGRESSION"
      );
      assert.deepEqual(await readState(root), started.state);
    }

    const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(elapsed) });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked_reason, "EVIDENCE_INVALID");
    assert.deepEqual(blocked.completed_steps, [1]);
    assert.equal(blocked.current_step, 2);
    assert.equal(blocked.current_attempt, null);
    if (ownerExpected) assert.deepEqual(blocked.owner, started.state.owner);
    else assert.equal(blocked.owner, null);
    assert.doesNotThrow(() => validateState(blocked));
  }
});

test("reconcile rejects imported receipt provenance in a native workflow", async () => {
  const root = await makeWorkspace();
  const started = await initAndBegin(root);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 1,
    attempt_id: null,
    provenance: "claude-progress-import",
    source_sha256: "b".repeat(64),
    completed_at: plus(2),
    summary: "foreign imported history",
    evidence: evidenceFor(1)
  });

  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(3) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "RECEIPT_PROVENANCE_MISMATCH");
  assert.deepEqual(blocked.completed_steps, []);
  assert.deepEqual(blocked.current_attempt, started.attempt);
});

test("reconcile enforces imported receipt source hash and declared prefix", async () => {
  for (const mutation of ["source", "prefix"]) {
    const root = await makeWorkspace();
    const pluginRoot = await makePluginFixture();
    await writeClaudeCompletedPrefix(root, 2);
    await importClaudeProgress({
      workspaceRoot: root,
      pluginRoot,
      now: () => new Date(baseTime),
      idFactory: ids(`workflow-import-${mutation}`)
    });
    if (mutation === "source") {
      const receipt = (await readReceipts(root))[1];
      await writeFile(receiptPath(root, 2), `${JSON.stringify({
        ...receipt,
        source_sha256: "c".repeat(64)
      }, null, 2)}\n`);
    } else {
      const state = await readState(root);
      await writeStateAtomic(root, {
        ...state,
        imported_from: { ...state.imported_from, prefix_length: 1 }
      });
    }

    const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(1) });
    assert.equal(blocked.status, "blocked");
    assert.equal(
      blocked.blocked_reason,
      mutation === "source" ? "RECEIPT_IMPORT_SOURCE_MISMATCH" : "RECEIPT_IMPORT_PREFIX_MISMATCH"
    );
    assert.deepEqual(blocked.completed_steps, [1]);
    assert.equal(blocked.imported_from.prefix_length, 1);
  }
});

test("reconcile preserves a valid imported receipt prefix", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 2);
  await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now: () => new Date(baseTime),
    idFactory: ids("workflow-valid-import")
  });
  const before = await readState(root);
  const reconciled = await reconcileWorkflow({ workspaceRoot: root, now: plus(1) });
  assert.deepEqual(reconciled, before);
  assert.deepEqual(reconciled.completed_steps, [1, 2]);
  assert.equal(reconciled.imported_from.prefix_length, 2);
});

test("malformed first receipt discards state-only completion while later corruption preserves valid prefix", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "step one",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  await writeFile(receiptPath(root, 1), "malformed-first\n", "utf8");
  let blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(3) });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.completed_steps, []);
  assert.equal(blocked.current_step, 1);
  assert.equal(blocked.current_attempt, null);
  assert.equal(blocked.continuation, null);

  const laterRoot = await makeWorkspace();
  const laterStarted = await initAndBegin(laterRoot);
  await completeStep({
    workspaceRoot: laterRoot,
    pluginRoot,
    step: 1,
    attemptId: laterStarted.attempt.id,
    summary: "valid prefix",
    evidence: evidenceFor(1),
    now: plus(2)
  });
  await writeFile(receiptPath(laterRoot, 2), "malformed-later\n", "utf8");
  blocked = await reconcileWorkflow({ workspaceRoot: laterRoot, now: plus(3) });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.completed_steps, [1]);
  assert.equal(blocked.current_step, 2);
});

test("status derives imported and native counts from receipt provenance", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 2);
  await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now: () => new Date(baseTime),
    idFactory: ids("workflow-imported")
  });
  let status = await showWorkflow({ workspaceRoot: root });
  assert.deepEqual(status.completions, { imported: 2, codex_verified: 0, total: 2 });

  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: null,
    now: plus(1),
    idFactory: ids("nonce-step-3")
  });
  const started = await beginStep({
    workspaceRoot: root,
    step: 3,
    sessionId: null,
    marker: { ...resumed.continuation },
    now: plus(2),
    idFactory: ids("attempt-step-3")
  });
  await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 3,
    attemptId: started.attempt.id,
    summary: "native step",
    evidence: evidenceFor(3),
    now: plus(3)
  });
  status = await showWorkflow({ workspaceRoot: root });
  assert.deepEqual(status.completions, { imported: 2, codex_verified: 1, total: 3 });
  assert.equal(status.completed_count, 3);
});

test("show reports preserved import diagnostics without inventing active state", async () => {
  const root = await makeWorkspace();
  await mkdir(pathsFor(root).codexDir, { recursive: true });
  await writeFile(pathsFor(root).importErrorPath, `${JSON.stringify({
    schema_version: 1,
    code: "CLAUDE_TOTAL_STEPS",
    source_preserved: true,
    source_path: "step_archive/progress.json",
    source_sha256: "b".repeat(64),
    occurred_at: baseTime,
    action: "repair the Claude state or use a separate workspace"
  })}\n`);
  const shown = await showWorkflow({ workspaceRoot: root });
  assert.deepEqual(shown, {
    active: false,
    claude_progress_found: false,
    import_error: {
      code: "CLAUDE_TOTAL_STEPS",
      source_preserved: true,
      action: "repair the Claude state or use a separate workspace"
    }
  });
});

test("show maps untrusted or malformed import diagnostics to constant safe output", async () => {
  const trustedAction = "repair the Claude state or use a separate workspace";
  for (const [artifact, expectedCode, expectedPreserved] of [
    [{
      schema_version: 1,
      code: "SECRET_CODE_Bearer_abcdefghijklmnop",
      source_preserved: true,
      source_path: "step_archive/progress.json",
      source_sha256: "b".repeat(64),
      occurred_at: baseTime,
      action: "Authorization: Bearer abcdefghijklmnop"
    }, "CLAUDE_IMPORT_FAILED", false],
    [{
      schema_version: 1,
      code: "CLAUDE_TOTAL_STEPS",
      source_preserved: true,
      source_path: "step_archive/progress.json",
      source_sha256: "b".repeat(64),
      occurred_at: baseTime,
      action: "password=known-code-secret-action"
    }, "CLAUDE_TOTAL_STEPS", true],
    [{ code: "password=do-not-disclose", action: "secret-action" }, "CLAUDE_IMPORT_FAILED", false]
  ]) {
    const root = await makeWorkspace();
    await mkdir(pathsFor(root).codexDir, { recursive: true });
    await writeFile(pathsFor(root).importErrorPath, `${JSON.stringify(artifact)}\n`);
    const raw = JSON.stringify(await showWorkflow({ workspaceRoot: root }));
    assert.equal(raw.includes("abcdefghijklmnop"), false);
    assert.equal(raw.includes("do-not-disclose"), false);
    assert.equal(raw.includes("secret-action"), false);
    assert.deepEqual(JSON.parse(raw).import_error, {
      code: expectedCode,
      source_preserved: expectedPreserved,
      action: trustedAction
    });
  }
});

test("reset archives only Codex metadata and preserves Claude topic outputs and application bytes", async () => {
  const root = await makeWorkspace();
  await initWorkflow({
    workspaceRoot: root,
    topic: "preserved topic",
    now: baseTime,
    idFactory: ids("workflow-reset", "nonce-reset")
  });
  const preserved = [
    [join(root, "step_archive", "progress.json"), "claude-state\n"],
    [join(root, "step_archive", "TOPIC", "TOPIC.md"), "preserved topic\n"],
    [join(root, "step_archive", "outputs", "result.bin"), "output-bytes\u0000\u0001"],
    [join(root, "src", "app.js"), "console.log('app');\n"]
  ];
  for (const [path, contents] of preserved) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const before = new Map(await Promise.all(preserved.map(async ([path]) => [path, await hashFile(path)])));
  const result = await resetWorkflow({ workspaceRoot: root, now: plus(1) });
  assert.equal(existsSync(result.backupPath), true);
  assert.equal(existsSync(join(result.backupPath, "state.json")), true);
  assert.equal(await readState(root), null);
  for (const [path] of preserved) assert.equal(await hashFile(path), before.get(path));
  assert.deepEqual((await readdir(pathsFor(root).codexDir)).sort(), ["backups"]);
});

test("reset rejects a redirected backups directory before moving metadata outside", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  await initWorkflow({
    workspaceRoot: root,
    topic: "reset containment",
    now: baseTime,
    idFactory: ids("workflow-reset-unsafe", "nonce-reset-unsafe")
  });
  await writeFile(join(external, "sentinel.txt"), "outside-before\n");
  await makeDirectoryLink(external, pathsFor(root).backupsDir);
  const before = await readState(root);

  await assert.rejects(
    () => resetWorkflow({ workspaceRoot: root, now: plus(1) }),
    error => error.code === "WORKSPACE_PATH_UNSAFE"
  );
  assert.deepEqual(await readState(root), before);
  assert.equal(await readFile(join(external, "sentinel.txt"), "utf8"), "outside-before\n");
  assert.deepEqual((await readdir(external)).sort(), ["sentinel.txt"]);
});

test("reset does not execute an unknown caller idFactory during archival", async () => {
  const root = await makeWorkspace();
  const external = await makeWorkspace();
  await initWorkflow({
    workspaceRoot: root,
    topic: "reset callback isolation",
    now: baseTime,
    idFactory: ids("workflow-reset-callback", "nonce-reset-callback")
  });
  await writeFile(join(external, "sentinel.txt"), "outside-before\n");
  let called = false;
  const result = await resetWorkflow({
    workspaceRoot: root,
    now: plus(1),
    idFactory: () => {
      called = true;
      replaceWithDirectoryLink(pathsFor(root).backupsDir, external);
      return "hostile-reset-id";
    }
  });
  assert.equal(called, false);
  assert.equal(existsSync(join(result.backupPath, "state.json")), true);
  assert.deepEqual((await readdir(external)).sort(), ["sentinel.txt"]);
});

test("workflow events contain only allowlisted metadata and never nonce evidence reason or summary", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const factory = ids("workflow-events", "NONCE_MUST_NOT_LOG", "attempt-events");
  const initialized = await initWorkflow({ workspaceRoot: root, topic: "TOPIC_MUST_NOT_LOG", now: baseTime, idFactory: factory });
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker: { ...initialized.continuation },
    now: plus(1),
    idFactory: factory
  });
  await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "SUMMARY_MUST_NOT_LOG",
    evidence: evidenceFor(1, "EVIDENCE_MUST_NOT_LOG"),
    now: plus(2)
  });
  const raw = await readFile(pathsFor(root).eventsPath, "utf8");
  for (const forbidden of [
    "NONCE_MUST_NOT_LOG",
    "TOPIC_MUST_NOT_LOG",
    "SUMMARY_MUST_NOT_LOG",
    "EVIDENCE_MUST_NOT_LOG",
    "prompt",
    "command",
    "transcript",
    "secret"
  ]) assert.equal(raw.includes(forbidden), false);
  const allowedFields = new Set([
    "kind", "timestamp", "workflow_id", "step", "attempt_id", "session_id",
    "status", "error_code", "reason_code", "baseline_receipt_count",
    "receipt_count", "completed_count", "failure_count", "consecutive_failures",
    "generation_id"
  ]);
  for (const event of await readEvents(root)) {
    for (const field of Object.keys(event)) assert.equal(allowedFields.has(field), true, field);
  }
});

test("invalid event targets fail before consuming the continuation and permit a repaired retry", async () => {
  const root = await makeWorkspace();
  const factory = ids("workflow-event-failure", "nonce-event-failure", "attempt-event-failure");
  const initialized = await initWorkflow({ workspaceRoot: root, topic: "events", now: baseTime, idFactory: factory });
  const marker = { ...initialized.continuation };
  await unlink(pathsFor(root).eventsPath);
  await mkdir(pathsFor(root).eventsPath);
  await assert.rejects(() => beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker,
    now: plus(1),
    idFactory: factory
  }));
  const state = await readState(root);
  assert.doesNotThrow(() => validateState(state));
  assert.deepEqual(state, initialized);
  assert.equal((await stat(pathsFor(root).eventsPath)).isDirectory(), true);
  rmdirSync(pathsFor(root).eventsPath);
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: null,
    marker,
    now: plus(2),
    idFactory: factory
  });
  assert.match(started.attempt.id, /^attempt-[a-f0-9]{64}$/);
  assert.equal(started.state.continuation, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";

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
import { readReceipts, receiptPath } from "../scripts/lib/receipts.mjs";
import { createInitialState, validateState } from "../scripts/lib/schema.mjs";
import { readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import {
  beginStep,
  completeStep,
  consumeContinuation,
  failStep,
  initWorkflow,
  issueContinuation,
  pauseWorkflow,
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
  assert.equal(transferred.continuation.nonce, "nonce-new");
  assert.notEqual(transferred.continuation.nonce, "nonce-old");
});

test("continuations are one-use and bind workflow step and receipt count", () => {
  const issued = issueContinuation(initialState(), { now: baseTime, nonce: "nonce-1" });
  const marker = { ...issued.continuation };
  assert.equal(consumeContinuation(issued, { marker }).continuation, null);
  assert.throws(
    () => consumeContinuation({ ...issued, continuation: null }, { marker }),
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
  assert.deepEqual(started.attempt, {
    id: "attempt-begin",
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
  assert.ok(["attempt-a", "attempt-b"].includes((await readState(root)).current_attempt.id));
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
  let observed;
  const state = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "preflight passed",
    evidence: evidenceFor(1, "tool inventory"),
    now: plus(2),
    hooks: {
      afterReceipt: async () => {
        observed = {
          receiptExists: existsSync(receiptPath(root, 1)),
          state: await readState(root)
        };
      }
    }
  });
  assert.equal(observed.receiptExists, true);
  assert.deepEqual(observed.state.completed_steps, []);
  assert.equal(observed.state.current_attempt.id, started.attempt.id);
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
  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "durable receipt",
      evidence: evidenceFor(1),
      now: plus(2),
      stateWriter: async () => {
        throw new Error("injected state failure");
      }
    }),
    /injected state failure/
  );
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
  let stateAtReceipt;
  const completed = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 50,
    attemptId: started.attempt.id,
    summary: "final step",
    evidence: evidenceFor(50),
    now: plus(3),
    hooks: {
      afterReceipt: async () => {
        assert.equal(existsSync(receiptPath(root, 50)), true);
        stateAtReceipt = await readState(root);
      }
    }
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

test("reconcile advances a receipt crash gap and blocks malformed receipt storage", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const started = await initAndBegin(root);
  await assert.rejects(() => completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "crash gap",
    evidence: evidenceFor(1),
    now: plus(2),
    stateWriter: async () => {
      throw new Error("crash before state");
    }
  }));
  const recovered = await reconcileWorkflow({ workspaceRoot: root, now: plus(3) });
  assert.deepEqual(recovered.completed_steps, [1]);
  assert.equal(recovered.current_step, 2);

  await writeFile(receiptPath(root, 2), "not-json\n", "utf8");
  const blocked = await reconcileWorkflow({ workspaceRoot: root, now: plus(4) });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "RECEIPT_PARSE_ERROR");
  assert.deepEqual(blocked.completed_steps, [1]);
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
    "receipt_count", "completed_count", "failure_count", "consecutive_failures"
  ]);
  for (const event of await readEvents(root)) {
    for (const field of Object.keys(event)) assert.equal(allowedFields.has(field), true, field);
  }
});

test("event append failure leaves a valid consumed state and replay cannot create another attempt", async () => {
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
  assert.equal(state.current_attempt.id, "attempt-event-failure");
  assert.equal(state.continuation, null);
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: null, marker, now: plus(2), idFactory: ids("attempt-other") }),
    error => error.code === "CONTINUATION_REPLAY"
  );
  assert.equal((await stat(pathsFor(root).eventsPath)).isDirectory(), true);
});

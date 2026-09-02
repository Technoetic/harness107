import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { pathsFor } from "../scripts/lib/paths.mjs";
import {
  parseReceipt,
  readReceipts,
  receiptPath,
  reconcileReceipts,
  sanitizeEvidence,
  writeReceiptExclusive
} from "../scripts/lib/receipts.mjs";
import { createInitialState, validateState } from "../scripts/lib/schema.mjs";
import { makeWorkspace } from "./helpers/workspace.mjs";

const baseTime = "2026-09-02T00:00:00.000Z";
const nextTime = "2026-09-02T00:00:01.000Z";

function initialState(workflowId = "wf-1") {
  return createInitialState({
    workflowId,
    workspaceRoot: "C:/fixture",
    topicSha256: "a".repeat(64),
    now: baseTime
  });
}

function receiptFor(step, overrides = {}) {
  return {
    schema_version: 1,
    workflow_id: "wf-1",
    step,
    attempt_id: `attempt-${step}`,
    provenance: "codex-verified",
    completed_at: nextTime,
    summary: `Completed step ${step}`,
    evidence: [{
      acceptance_id: "state-transition",
      kind: "check",
      detail: `Observed step ${step}`,
      ok: true
    }],
    ...overrides
  };
}

function importedReceiptFor(step, overrides = {}) {
  return receiptFor(step, {
    attempt_id: null,
    provenance: "claude-progress-import",
    evidence: [{
      acceptance_id: null,
      kind: "import",
      detail: `Historical Claude completion ${step}`,
      ok: true
    }],
    source_sha256: "b".repeat(64),
    ...overrides
  });
}

function completedState(workflowId = "wf-1") {
  return validateState({
    ...initialState(workflowId),
    status: "completed",
    current_step: null,
    completed_steps: Array.from({ length: 50 }, (_, index) => index + 1),
    completed_at: "2026-09-02T00:50:00.000Z"
  });
}

function diagnosticText(error) {
  return JSON.stringify({
    code: error?.code,
    message: error?.message,
    details: error?.details
  });
}

function publishBarrier(expected) {
  let arrivals = 0;
  let release;
  const released = new Promise(resolve => {
    release = resolve;
  });
  return {
    get arrivals() {
      return arrivals;
    },
    async wait() {
      arrivals += 1;
      if (arrivals === expected) release();
      await released;
    }
  };
}

test("native and imported receipts enforce their exact schemas", () => {
  assert.deepEqual(parseReceipt(JSON.stringify(receiptFor(1))), receiptFor(1));
  assert.deepEqual(parseReceipt(importedReceiptFor(2)), importedReceiptFor(2));

  const invalidReceipts = [
    { ...receiptFor(1), extra: true },
    { ...receiptFor(1), schema_version: 2 },
    { ...receiptFor(1), workflow_id: "" },
    { ...receiptFor(1), step: 0 },
    { ...receiptFor(1), step: 51 },
    { ...receiptFor(1), step: "1" },
    { ...receiptFor(1), attempt_id: null },
    { ...receiptFor(1), provenance: "unknown" },
    { ...receiptFor(1), completed_at: "yesterday" },
    { ...receiptFor(1), summary: "" },
    { ...receiptFor(1), source_sha256: "c".repeat(64) },
    { ...importedReceiptFor(1), attempt_id: "attempt-1" },
    (() => {
      const value = importedReceiptFor(1);
      delete value.source_sha256;
      return value;
    })(),
    { ...importedReceiptFor(1), source_sha256: "not-a-digest" }
  ];

  for (const receipt of invalidReceipts) {
    assert.throws(
      () => parseReceipt(receipt),
      error => error.code === "RECEIPT_INVALID"
    );
  }
  assert.throws(
    () => parseReceipt({ ...receiptFor(1), evidence: {} }),
    error => error.code === "EVIDENCE_INVALID"
  );
  assert.throws(
    () => parseReceipt("{not json"),
    error => error.code === "RECEIPT_PARSE_ERROR"
  );
});

test("evidence accepts bounded command, artifact, check, and import records", () => {
  const evidence = [
    {
      acceptance_id: "build",
      kind: "command",
      detail: "Build completed",
      ok: true,
      command: "npm run build",
      exit_code: 0
    },
    {
      acceptance_id: "report",
      kind: "artifact",
      detail: "Saved build report",
      ok: true,
      artifact_path: "step_archive/outputs/report.json",
      artifact_sha256: "c".repeat(64)
    },
    {
      acceptance_id: "visual-review",
      kind: "check",
      detail: "No clipping observed",
      ok: true
    },
    {
      acceptance_id: null,
      kind: "import",
      detail: "Historical completion",
      ok: true
    }
  ];

  assert.deepEqual(sanitizeEvidence(evidence), evidence);
  assert.notEqual(sanitizeEvidence(evidence), evidence);
});

test("evidence rejects unknown fields, invalid types, and invalid bounds", () => {
  const base = {
    acceptance_id: "check",
    kind: "check",
    detail: "Observed",
    ok: true
  };
  const invalidEvidence = [
    null,
    { ...base, extra: true },
    { ...base, acceptance_id: 1 },
    { ...base, kind: "log" },
    { ...base, detail: "" },
    { ...base, ok: 1 },
    { ...base, artifact_path: "" },
    { ...base, artifact_sha256: "bad" },
    { ...base, command: "" },
    { ...base, exit_code: 1.5 }
  ];

  for (const item of invalidEvidence) {
    assert.throws(
      () => sanitizeEvidence([item]),
      error => error.code === "EVIDENCE_INVALID"
    );
  }
  assert.throws(
    () => sanitizeEvidence("not-an-array"),
    error => error.code === "EVIDENCE_INVALID"
  );
});

test("receipt evidence cannot persist credentials, private keys, or raw environment assignments", () => {
  const sensitiveDetails = [
    "OPENAI_API_KEY=secret",
    "Authorization: Bearer abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----",
    "DATABASE_URL=postgres://user:password@example.test/db",
    "ghp_123456789012345678901234567890123456"
  ];

  for (const detail of sensitiveDetails) {
    assert.throws(
      () => sanitizeEvidence([{
        acceptance_id: "secret-scan",
        kind: "check",
        detail,
        ok: true
      }]),
      error => error.code === "SENSITIVE_EVIDENCE"
    );
  }
});

test("receipt summaries reject POSIX PowerShell and cmd environment assignments without disclosure", () => {
  const summaries = [
    "export DATABASE_URL=postgres://user:posix-secret@example.test/db",
    "$env:DATABASE_URL = 'powershell-secret'",
    "set DATABASE_URL=cmd-secret",
    "set \"DATABASE_URL=quoted-cmd-secret\""
  ];

  for (const summary of summaries) {
    assert.throws(
      () => parseReceipt(receiptFor(1, { summary })),
      error => {
        assert.equal(error.code, "SENSITIVE_EVIDENCE");
        assert.equal(diagnosticText(error).includes(summary), false);
        return true;
      }
    );
  }
});

test("sensitive unknown receipt properties are rejected before schema diagnostics can disclose them", () => {
  const fixtures = [
    {
      secret: "unknown-value-secret",
      receipt: { ...receiptFor(1), metadata: "OPENAI_API_KEY=unknown-value-secret" }
    },
    {
      secret: "unknown-name-secret",
      receipt: { ...receiptFor(1), "PASSWORD=unknown-name-secret": true }
    },
    {
      secret: "plain-property-secret",
      receipt: { ...receiptFor(1), password: "plain-property-secret" }
    }
  ];

  for (const fixture of fixtures) {
    assert.throws(
      () => parseReceipt(fixture.receipt),
      error => {
        assert.equal(error.code, "SENSITIVE_EVIDENCE");
        assert.equal(diagnosticText(error).includes(fixture.secret), false);
        return true;
      }
    );
  }
});

test("receipt creation is immutable and identical replay is idempotent", async () => {
  const root = await makeWorkspace();
  const receipt = receiptFor(1);

  await writeReceiptExclusive(root, receipt);
  await writeReceiptExclusive(root, receipt);
  await assert.rejects(
    () => writeReceiptExclusive(root, { ...receipt, summary: "conflict" }),
    error => error.code === "RECEIPT_CONFLICT"
  );

  assert.deepEqual(JSON.parse(await readFile(receiptPath(root, 1), "utf8")), receipt);
});

test("receipt replay compares canonical JSON rather than key or whitespace order", async () => {
  const root = await makeWorkspace();
  const receipt = receiptFor(1);
  const reordered = {
    evidence: receipt.evidence.map(item => ({ ok: item.ok, detail: item.detail, kind: item.kind, acceptance_id: item.acceptance_id })),
    summary: receipt.summary,
    completed_at: receipt.completed_at,
    provenance: receipt.provenance,
    attempt_id: receipt.attempt_id,
    step: receipt.step,
    workflow_id: receipt.workflow_id,
    schema_version: receipt.schema_version
  };

  await writeReceiptExclusive(root, receipt);
  await assert.doesNotReject(() => writeReceiptExclusive(root, reordered));
});

test("secret evidence is rejected before a receipt file is created", async () => {
  const root = await makeWorkspace();
  const receipt = receiptFor(1, {
    evidence: [{ acceptance_id: "check", kind: "check", detail: "PASSWORD=hunter2", ok: true }]
  });

  await assert.rejects(
    () => writeReceiptExclusive(root, receipt),
    error => error.code === "SENSITIVE_EVIDENCE"
  );
  assert.deepEqual(await readReceipts(root), []);
});

test("receipt publication exposes no final file before complete bytes are file-synced", async () => {
  const root = await makeWorkspace();
  const path = receiptPath(root, 1);
  const stages = [];

  await writeReceiptExclusive(root, receiptFor(1), {
    writeBytes: async (handle, bytes) => {
      stages.push("write");
      await handle.writeFile(bytes, "utf8");
    },
    syncFile: async handle => {
      stages.push("file-sync");
      await handle.sync();
    },
    beforePublish: async () => {
      stages.push("before-publish");
      await assert.rejects(() => readFile(path), error => error.code === "ENOENT");
    },
    publishFile: async (temporaryPath, finalPath) => {
      stages.push("publish");
      const { link } = await import("node:fs/promises");
      await link(temporaryPath, finalPath);
    },
    syncDirectory: async () => {
      stages.push("directory-sync");
    }
  });

  assert.deepEqual(stages, ["write", "file-sync", "before-publish", "publish", "directory-sync"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receiptFor(1));
});

test("concurrent identical receipt writers publish once and both become idempotent", async () => {
  const root = await makeWorkspace();
  const barrier = publishBarrier(2);
  const receipt = receiptFor(1);

  const results = await Promise.all([
    writeReceiptExclusive(root, receipt, { beforePublish: () => barrier.wait() }),
    writeReceiptExclusive(root, receipt, { beforePublish: () => barrier.wait() })
  ]);

  assert.equal(barrier.arrivals, 2);
  assert.deepEqual(results, [receipt, receipt]);
  assert.deepEqual(await readReceipts(root), [receipt]);
  assert.deepEqual((await readdir(pathsFor(root).receiptsDir)).filter(name => name.endsWith(".tmp")), []);
});

test("concurrent conflicting receipt writers preserve one stable winner", async () => {
  const root = await makeWorkspace();
  const barrier = publishBarrier(2);
  const first = receiptFor(1, { summary: "first candidate" });
  const second = receiptFor(1, { summary: "second candidate" });

  const settled = await Promise.allSettled([
    writeReceiptExclusive(root, first, { beforePublish: () => barrier.wait() }),
    writeReceiptExclusive(root, second, { beforePublish: () => barrier.wait() })
  ]);

  assert.equal(barrier.arrivals, 2);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const rejection = settled.find(result => result.status === "rejected");
  assert.equal(rejection.reason.code, "RECEIPT_CONFLICT");
  const winner = settled.find(result => result.status === "fulfilled").value;
  assert.deepEqual(await readReceipts(root), [winner]);
  assert.deepEqual((await readdir(pathsFor(root).receiptsDir)).filter(name => name.endsWith(".tmp")), []);
});

test("write, file-sync, and publish failures expose no final receipt and leave retries recoverable", async t => {
  const failures = [
    {
      name: "write",
      options: { writeBytes: async () => { throw new Error("injected write failure"); } }
    },
    {
      name: "file sync",
      options: { syncFile: async () => { throw new Error("injected file-sync failure"); } }
    },
    {
      name: "publish",
      options: { publishFile: async () => { throw new Error("injected publish failure"); } }
    }
  ];

  for (const fixture of failures) {
    await t.test(fixture.name, async () => {
      const root = await makeWorkspace();
      await assert.rejects(() => writeReceiptExclusive(root, receiptFor(1), fixture.options), /injected/);
      assert.deepEqual(await readReceipts(root), []);
      assert.deepEqual((await readdir(pathsFor(root).receiptsDir)).filter(name => name.endsWith(".tmp")), []);

      await writeReceiptExclusive(root, receiptFor(1));
      assert.deepEqual(await readReceipts(root), [receiptFor(1)]);
    });
  }
});

test("directory-sync failure keeps the complete winner and identical retry finishes durability", async () => {
  const root = await makeWorkspace();
  let syncAttempts = 0;

  await assert.rejects(() => writeReceiptExclusive(root, receiptFor(1), {
    syncDirectory: async () => {
      syncAttempts += 1;
      throw new Error("injected directory-sync failure");
    }
  }), /injected directory-sync failure/);

  assert.equal(syncAttempts, 1);
  assert.deepEqual(await readReceipts(root), [receiptFor(1)]);
  await assert.doesNotReject(() => writeReceiptExclusive(root, receiptFor(1)));
  await assert.rejects(
    () => writeReceiptExclusive(root, receiptFor(1, { summary: "conflicting retry" })),
    error => error.code === "RECEIPT_CONFLICT"
  );
  assert.deepEqual(await readReceipts(root), [receiptFor(1)]);
});

test("receipt paths enforce integer step bounds", () => {
  const root = "C:/fixture";
  assert.match(receiptPath(root, 1), /step001\.json$/);
  assert.match(receiptPath(root, 50), /step050\.json$/);
  for (const step of [0, 51, 1.5, "1"]) {
    assert.throws(
      () => receiptPath(root, step),
      error => error.code === "RECEIPT_INVALID"
    );
  }
});

test("receipt reads are empty when absent and deterministic by numeric step", async () => {
  const root = await makeWorkspace();
  assert.deepEqual(await readReceipts(root), []);

  const { receiptsDir } = pathsFor(root);
  await mkdir(receiptsDir, { recursive: true });
  await writeFile(receiptPath(root, 10), `${JSON.stringify(receiptFor(10))}\n`, "utf8");
  await writeFile(receiptPath(root, 2), `${JSON.stringify(importedReceiptFor(2))}\n`, "utf8");
  await writeFile(receiptPath(root, 1), `${JSON.stringify(importedReceiptFor(1))}\n`, "utf8");
  await writeFile(`${receiptsDir}/notes.txt`, "ignored", "utf8");

  assert.deepEqual((await readReceipts(root)).map(receipt => receipt.step), [1, 2, 10]);
});

test("receipt reads reject a filename and payload step mismatch", async () => {
  const root = await makeWorkspace();
  const { receiptsDir } = pathsFor(root);
  await mkdir(receiptsDir, { recursive: true });
  await writeFile(receiptPath(root, 1), `${JSON.stringify(receiptFor(2))}\n`, "utf8");

  await assert.rejects(
    () => readReceipts(root),
    error => error.code === "RECEIPT_PATH_MISMATCH"
  );
});

test("reconciliation blocks receipts for another workflow", () => {
  const state = initialState();
  const result = reconcileReceipts(state, [receiptFor(1, { workflow_id: "wf-other" })]);

  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "RECEIPT_WORKFLOW_MISMATCH");
  assert.deepEqual(result.diagnostics, [{ code: "RECEIPT_WORKFLOW_MISMATCH" }]);
  assert.deepEqual(result.prefix_receipts, []);
});

test("reconciliation permits identical duplicates and blocks conflicting duplicates", () => {
  const state = initialState();
  const identical = reconcileReceipts(state, [receiptFor(1), receiptFor(1)]);
  assert.deepEqual(identical.state.completed_steps, [1]);

  const conflict = reconcileReceipts(state, [receiptFor(1), receiptFor(1, { summary: "different" })]);
  assert.equal(conflict.state.status, "blocked");
  assert.equal(conflict.state.blocked_reason, "RECEIPT_CONFLICT");
  assert.deepEqual(conflict.diagnostics, [{ code: "RECEIPT_CONFLICT" }]);
});

test("reconciliation advances only a contiguous receipt prefix", () => {
  const result = reconcileReceipts(initialState(), [receiptFor(1), receiptFor(3)]);

  assert.deepEqual(result.state.completed_steps, [1]);
  assert.equal(result.state.current_step, 2);
  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "RECEIPT_GAP");
  assert.deepEqual(result.prefix_receipts, [receiptFor(1)]);
});

test("reconciliation blocks state that claims completion beyond durable receipts", () => {
  const state = validateState({
    ...initialState(),
    completed_steps: [1, 2],
    current_step: 3
  });
  const result = reconcileReceipts(state, [receiptFor(1)]);

  assert.deepEqual(result.state.completed_steps, [1]);
  assert.equal(result.state.current_step, 2);
  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "STATE_AHEAD_OF_RECEIPTS");
  assert.doesNotThrow(() => validateState(result.state));
});

test("completed-state workflow mismatch returns a valid blocked state", () => {
  const receipts = Array.from({ length: 50 }, (_, index) => receiptFor(index + 1));
  receipts.push(receiptFor(1, { workflow_id: "wf-other" }));

  const result = reconcileReceipts(completedState(), receipts);

  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "RECEIPT_WORKFLOW_MISMATCH");
  assert.equal(result.state.completed_steps.length, 49);
  assert.equal(result.state.current_step, 50);
  assert.equal(result.state.completed_at, null);
  assert.doesNotThrow(() => validateState(result.state));
});

test("completed state missing its final receipt becomes a valid state-ahead block", () => {
  const receipts = Array.from({ length: 49 }, (_, index) => receiptFor(index + 1));

  const result = reconcileReceipts(completedState(), receipts);

  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "STATE_AHEAD_OF_RECEIPTS");
  assert.equal(result.state.completed_steps.length, 49);
  assert.equal(result.state.current_step, 50);
  assert.equal(result.state.completed_at, null);
  assert.doesNotThrow(() => validateState(result.state));
});

test("state-ahead outranks a receipt gap and rebases incompatible state metadata", () => {
  const state = validateState({
    ...initialState(),
    completed_steps: [1, 2],
    current_step: 3,
    current_attempt: {
      id: "attempt-3",
      step: 3,
      session_id: "session-1",
      started_at: baseTime,
      failure_recorded: false
    },
    consecutive_failures: 2,
    continuation: {
      workflow_id: "wf-1",
      step: 3,
      nonce: "nonce-3",
      issued_at: baseTime,
      baseline_receipt_count: 2
    },
    imported_from: {
      kind: "claude-progress",
      source_sha256: "b".repeat(64),
      imported_at: baseTime,
      prefix_length: 2,
      warnings: []
    }
  });
  const result = reconcileReceipts(state, [importedReceiptFor(1), receiptFor(4)]);

  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "STATE_AHEAD_OF_RECEIPTS");
  assert.deepEqual(result.state.completed_steps, [1]);
  assert.equal(result.state.current_step, 2);
  assert.equal(result.state.current_attempt, null);
  assert.equal(result.state.continuation, null);
  assert.equal(result.state.consecutive_failures, 0);
  assert.equal(result.state.imported_from.prefix_length, 1);
  assert.deepEqual(result.diagnostics, [{ code: "STATE_AHEAD_OF_RECEIPTS" }]);
  assert.doesNotThrow(() => validateState(result.state));
});

test("receipt-first recovery advances state and clears stale attempt metadata", () => {
  const state = validateState({
    ...initialState(),
    current_attempt: {
      id: "attempt-1",
      step: 1,
      session_id: "session-1",
      started_at: baseTime,
      failure_recorded: false
    },
    consecutive_failures: 2,
    continuation: {
      workflow_id: "wf-1",
      step: 1,
      nonce: "nonce-1",
      issued_at: baseTime,
      baseline_receipt_count: 0
    }
  });
  const result = reconcileReceipts(state, [receiptFor(1)]);

  assert.deepEqual(result.state.completed_steps, [1]);
  assert.equal(result.state.current_step, 2);
  assert.equal(result.state.status, "running");
  assert.equal(result.state.current_attempt, null);
  assert.equal(result.state.continuation, null);
  assert.equal(result.state.consecutive_failures, 0);
  assert.equal(result.state.completed_at, null);
  assert.deepEqual(result.diagnostics, []);
});

test("reconciliation never invents receipts from state or transcript-shaped fields", () => {
  const state = initialState();
  const result = reconcileReceipts(state, []);

  assert.deepEqual(result.state, state);
  assert.deepEqual(result.prefix_receipts, []);
  assert.deepEqual(result.diagnostics, []);
});

test("receipt-first recovery preserves an explicit paused state", () => {
  const state = validateState({ ...initialState(), status: "paused" });
  const result = reconcileReceipts(state, [receiptFor(1)]);

  assert.equal(result.state.status, "paused");
  assert.deepEqual(result.state.completed_steps, [1]);
  assert.equal(result.state.current_step, 2);
});

test("the fiftieth receipt sets completion time from the durable receipt", () => {
  const state = initialState();
  const receipts = Array.from({ length: 50 }, (_, index) => receiptFor(index + 1, {
    completed_at: index === 49 ? "2026-09-02T00:50:00.000Z" : nextTime
  }));
  const result = reconcileReceipts(state, receipts.reverse());

  assert.equal(result.state.status, "completed");
  assert.equal(result.state.current_step, null);
  assert.deepEqual(result.state.completed_steps, Array.from({ length: 50 }, (_, index) => index + 1));
  assert.equal(result.state.completed_at, "2026-09-02T00:50:00.000Z");
  assert.deepEqual(result.prefix_receipts.map(receipt => receipt.step), Array.from({ length: 50 }, (_, index) => index + 1));
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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

  assert.deepEqual(result.state.completed_steps, [1, 2]);
  assert.equal(result.state.current_step, 3);
  assert.equal(result.state.status, "blocked");
  assert.equal(result.state.blocked_reason, "STATE_AHEAD_OF_RECEIPTS");
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

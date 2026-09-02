import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";

import { HarnessError } from "../scripts/lib/errors.mjs";
import { assertInside, pathsFor } from "../scripts/lib/paths.mjs";
import {
  createInitialState,
  nextIncompleteStep,
  parseState,
  validateState
} from "../scripts/lib/schema.mjs";
import { hashFile, makeWorkspace, readJson } from "./helpers/workspace.mjs";

const now = "2026-09-02T00:00:00.000Z";

function initialState() {
  return createInitialState({
    workflowId: "wf-1",
    workspaceRoot: "C:/fixture",
    topicSha256: "a".repeat(64),
    now
  });
}

function stateWithCanonicalMetadata() {
  const state = initialState();
  return {
    ...state,
    current_step: 2,
    completed_steps: [1],
    current_attempt: {
      id: "attempt-2",
      step: 2,
      session_id: "session-1",
      started_at: now,
      failure_recorded: false
    },
    owner: {
      session_id: "session-1",
      lease_updated_at: now
    },
    continuation: {
      workflow_id: "wf-1",
      step: 2,
      nonce: "nonce-2",
      issued_at: now,
      baseline_receipt_count: 1
    },
    stop_delivery: {
      generation_id: "delivery-2",
      requested_turn_id: null,
      accepted: false,
      allow_active_stop: true
    },
    imported_from: {
      kind: "claude-progress",
      source_sha256: "b".repeat(64),
      imported_at: now,
      prefix_length: 1,
      warnings: []
    }
  };
}

test("HarnessError preserves a stable code and details", () => {
  const error = new HarnessError("STATE_INVALID", "state is invalid", { field: "status" });

  assert.equal(error.name, "HarnessError");
  assert.equal(error.code, "STATE_INVALID");
  assert.deepEqual(error.details, { field: "status" });
  assert.equal(error.message, "state is invalid");
});

test("workspace helper hashes bytes and reads JSON from its isolated workspace", async () => {
  const root = await makeWorkspace();
  const sourcePath = join(root, "fixture.txt");
  const jsonPath = join(root, "fixture.json");
  await writeFile(sourcePath, "fixture bytes\n");
  await writeFile(jsonPath, "{\"step\":1}\n");

  assert.equal(await hashFile(sourcePath), "eac2a5a0837a324061f4b038b4c0af8c011bf9c47b595cda9459fd9c90651623");
  assert.deepEqual(await readJson(jsonPath), { step: 1 });
});

test("paths stay under the selected workspace", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);

  assert.equal(paths.codexDir, join(root, "step_archive", ".harness50-codex"));
  assert.equal(paths.statePath, join(paths.codexDir, "state.json"));
  assert.equal(paths.receiptsDir, join(paths.codexDir, "receipts"));
  assert.equal(paths.importsDir, join(paths.codexDir, "imports"));
  assert.equal(paths.eventsPath, join(paths.codexDir, "events.jsonl"));
  assert.equal(paths.lockPath, join(paths.codexDir, "run.lock"));
  assert.equal(paths.backupsDir, join(paths.codexDir, "backups"));
  assert.equal(paths.importErrorPath, join(paths.codexDir, "import-error.json"));
  assert.equal(assertInside(root, root), resolve(root));
  assert.equal(assertInside(root, join(root, "step_archive", "safe.json")), join(root, "step_archive", "safe.json"));
  assert.throws(() => assertInside(root, resolve(root, "..", "escape")));
  assert.throws(() => assertInside(root, `${resolve(root)}-sibling`));
});

test("Windows path flavor rejects sibling drives and UNC paths on every host platform", () => {
  const root = "C:\\fixture\\workspace";
  const inside = "C:\\fixture\\workspace\\step_archive\\safe.json";

  assert.equal(assertInside(root, root), win32.resolve(root));
  assert.equal(assertInside(root, inside), win32.resolve(inside));
  assert.equal(pathsFor(root).codexDir, win32.join(root, "step_archive", ".harness50-codex"));
  assert.throws(() => assertInside(root, "C:\\fixture\\workspace-sibling\\state.json"));
  assert.throws(() => assertInside(root, "D:\\escape\\state.json"));
  assert.throws(() => assertInside(root, "\\\\server\\share\\escape\\state.json"));
});

test("initial state has the canonical first-step values", () => {
  const state = initialState();

  assert.deepEqual(state, {
    schema_version: 1,
    workflow_id: "wf-1",
    status: "running",
    total_steps: 50,
    current_step: 1,
    completed_steps: [],
    topic_path: "step_archive/TOPIC/TOPIC.md",
    topic_sha256: "a".repeat(64),
    current_attempt: null,
    consecutive_failures: 0,
    blocked_reason: null,
    owner: null,
    continuation: null,
    stop_delivery: null,
    imported_from: null,
    last_stop_turn_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null
  });
  assert.equal(nextIncompleteStep(state), 1);
  assert.deepEqual(parseState(JSON.stringify(state)), state);
});

test("state requires a contiguous prefix and matching next step", () => {
  const state = initialState();

  assert.throws(() => validateState({ ...state, completed_steps: [1, 3] }));
  assert.throws(() => validateState({ ...state, completed_steps: [1], current_step: 1 }));
  assert.throws(() => validateState({ ...state, completed_steps: [0], current_step: 2 }));
  assert.equal(nextIncompleteStep({ ...state, completed_steps: [1, 2] }), 3);
});

test("state rejects invalid versions, totals, and statuses", () => {
  const state = initialState();

  assert.throws(() => validateState({ ...state, schema_version: 2 }));
  assert.throws(() => validateState({ ...state, total_steps: 49 }));
  assert.throws(() => validateState({ ...state, status: "unknown" }));
  assert.throws(() => validateState({ ...state, status: "blocked" }));
  assert.doesNotThrow(() => validateState({
    ...state,
    status: "blocked",
    blocked_reason: "RECEIPT_CONFLICT"
  }));
});

test("parseState rejects malformed and non-string JSON without changing valid input", () => {
  const state = initialState();
  const before = structuredClone(state);

  assert.throws(() => parseState("{"), error => error.code === "STATE_PARSE_ERROR");
  assert.throws(() => parseState({}), error => error.code === "STATE_PARSE_ERROR");
  assert.equal(validateState(state), state);
  assert.deepEqual(state, before);
});

test("state rejects completion timestamps inconsistent with status", () => {
  const state = initialState();
  const completedSteps = Array.from({ length: 50 }, (_, index) => index + 1);
  const completed = {
    ...state,
    status: "completed",
    current_step: null,
    completed_steps: completedSteps,
    completed_at: now
  };

  assert.throws(() => validateState({ ...completed, completed_at: null }));
  assert.throws(() => validateState({ ...state, completed_at: now }));
  assert.throws(() => validateState({ ...state, status: "paused", completed_at: now }));
  assert.throws(() => validateState({
    ...state,
    status: "blocked",
    blocked_reason: "RECEIPT_GAP",
    completed_at: now
  }));
});

test("state rejects unknown fields in each nested canonical record", () => {
  const state = stateWithCanonicalMetadata();
  const invalidStates = [
    { ...state, current_attempt: { ...state.current_attempt, unexpected: true } },
    { ...state, owner: { ...state.owner, unexpected: true } },
    { ...state, continuation: { ...state.continuation, unexpected: true } },
    { ...state, stop_delivery: { ...state.stop_delivery, unexpected: true } },
    { ...state, imported_from: { ...state.imported_from, unexpected: true } }
  ];

  for (const invalidState of invalidStates) assert.throws(() => validateState(invalidState));
});

test("state requires a canonical stop delivery for every live continuation generation", () => {
  const state = stateWithCanonicalMetadata();

  assert.doesNotThrow(() => validateState(state));
  assert.throws(() => validateState({ ...state, stop_delivery: null }));
  assert.throws(() => validateState({
    ...state,
    continuation: null,
    current_attempt: null
  }));
  assert.throws(() => validateState({ ...state, stop_delivery: { ...state.stop_delivery, generation_id: "" } }));
  assert.throws(() => validateState({ ...state, stop_delivery: { ...state.stop_delivery, requested_turn_id: 7 } }));
  assert.throws(() => validateState({ ...state, stop_delivery: { ...state.stop_delivery, accepted: "false" } }));
  assert.throws(() => validateState({ ...state, stop_delivery: { ...state.stop_delivery, allow_active_stop: "true" } }));
  assert.throws(() => validateState({
    ...state,
    stop_delivery: { ...state.stop_delivery, accepted: true, requested_turn_id: null }
  }));
});

test("consumed attempts retain delivery while terminal states clear it", () => {
  const state = stateWithCanonicalMetadata();
  const consumed = { ...state, continuation: null };
  assert.doesNotThrow(() => validateState(consumed));
  assert.throws(() => validateState({ ...consumed, stop_delivery: null }));
  assert.throws(() => validateState({ ...state, status: "paused" }));

  const completedSteps = Array.from({ length: 50 }, (_, index) => index + 1);
  assert.throws(() => validateState({
    ...state,
    status: "completed",
    current_step: null,
    completed_steps: completedSteps,
    current_attempt: null,
    continuation: null,
    completed_at: now
  }));
});

test("state reconciles continuation and import counts to its completed prefix", () => {
  const state = stateWithCanonicalMetadata();

  assert.throws(() => validateState({
    ...state,
    continuation: { ...state.continuation, baseline_receipt_count: 0 }
  }));
  assert.throws(() => validateState({
    ...state,
    imported_from: { ...state.imported_from, prefix_length: 2 }
  }));
});

test("completed state requires every step and no current step", () => {
  const state = initialState();
  const completedSteps = Array.from({ length: 50 }, (_, index) => index + 1);
  const completed = {
    ...state,
    status: "completed",
    current_step: null,
    completed_steps: completedSteps,
    completed_at: now
  };

  assert.doesNotThrow(() => validateState(completed));
  assert.equal(nextIncompleteStep(completed), null);
  assert.throws(() => validateState({ ...completed, current_step: 50 }));
  assert.throws(() => validateState({ ...completed, completed_steps: completedSteps.slice(0, -1) }));
  assert.throws(() => validateState({ ...state, current_step: null }));
});

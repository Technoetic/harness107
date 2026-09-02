import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  assert.equal(assertInside(root, join(root, "step_archive", "safe.json")), join(root, "step_archive", "safe.json"));
  assert.throws(() => assertInside(root, resolve(root, "..", "escape")));
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

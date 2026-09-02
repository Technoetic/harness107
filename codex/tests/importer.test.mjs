import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  deriveContiguousPrefix,
  importClaudeProgress,
  normalizeClaudeProgress
} from "../scripts/lib/importer.mjs";
import { assertRunLockHeld } from "../scripts/lib/lock.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readReceipts, writeReceiptExclusive } from "../scripts/lib/receipts.mjs";
import { createInitialState } from "../scripts/lib/schema.mjs";
import { readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import {
  hashFile,
  makePluginFixture,
  makeWorkspace,
  readJson,
  writeClaudeCompletedPrefix,
  writeClaudeFixture
} from "./helpers/workspace.mjs";

const instant = new Date("2026-09-02T00:00:00.000Z");
const now = () => new Date(instant);

function ids(...values) {
  let index = 0;
  return () => values[index++] ?? `fixture-id-${index}`;
}

async function readEvents(root) {
  const raw = await readFile(pathsFor(root).eventsPath, "utf8");
  return raw.trimEnd().split("\n").map(line => JSON.parse(line));
}

async function importFiles(root) {
  const names = await readdir(pathsFor(root).importsDir);
  return names.sort();
}

function errorCode(code) {
  return error => error?.code === code;
}

test("normalization accepts integer-like legacy values and derives a sorted contiguous prefix", () => {
  assert.deepEqual(deriveContiguousPrefix(["03", 1, "2", 3]), {
    normalized: [1, 2, 3],
    prefix: [1, 2, 3]
  });
  assert.deepEqual(normalizeClaudeProgress({
    total_steps: "50",
    current_step: "5",
    completed_steps: ["01", 2, "4", 4],
    eval_rounds: 104,
    transcript_path: "never-read.jsonl",
    unknown: { retained: "only in snapshot" }
  }), {
    total_steps: 50,
    current_step: 3,
    completed_steps: [1, 2],
    normalized_steps: [1, 2, 4],
    warnings: [
      "integer-like Claude step values were normalized",
      "duplicate completed_steps were normalized",
      "sparse completed_steps beyond the contiguous prefix were ignored",
      "current_step did not match the derived selected step"
    ]
  });
});

test("normalization rejects totals other than exactly 50 and invalid completed step contracts", () => {
  const base = { total_steps: 50, current_step: 1, completed_steps: [] };
  for (const total_steps of [49, 107, "107"]) {
    assert.throws(
      () => normalizeClaudeProgress({ ...base, total_steps }),
      errorCode("CLAUDE_TOTAL_STEPS")
    );
  }
  for (const completed_steps of [null, {}, "1,2"]) {
    assert.throws(
      () => normalizeClaudeProgress({ ...base, completed_steps }),
      errorCode("CLAUDE_COMPLETED_STEPS")
    );
  }
  for (const completed_steps of [[true], [1.5], ["1.0"], [{}]]) {
    assert.throws(
      () => normalizeClaudeProgress({ ...base, completed_steps }),
      errorCode("CLAUDE_STEP_VALUE")
    );
  }
  for (const completed_steps of [[0], [51], ["51"]]) {
    assert.throws(
      () => normalizeClaudeProgress({ ...base, completed_steps }),
      errorCode("CLAUDE_STEP_RANGE")
    );
  }
});

test("imports a BOM source byte-for-byte and persists only its contiguous historical prefix", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const sourceBytes = await writeClaudeFixture(root, {
    total_steps: 50,
    current_step: 5,
    completed_steps: [1, "2", 4, 4],
    eval_rounds: { "49": "legacy", "69": "legacy", "104": "legacy" },
    auto_continue: { nonce: "must-not-be-read" },
    transcript_path: "private/transcript.jsonl",
    unknown_claude_field: { preserved: true }
  }, { bom: true });
  await writeFile(join(root, "step_archive", "auto-continue.json"), "not importer input\n", "utf8");
  const sourcePath = join(root, "step_archive", "progress.json");
  const beforeHash = await hashFile(sourcePath);
  const beforeStat = await stat(sourcePath);

  const result = await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now,
    idFactory: ids("workflow-import-1"),
    hooks: {
      afterSnapshot: () => assertRunLockHeld(pathsFor(root).lockPath),
      afterReceipt: () => assertRunLockHeld(pathsFor(root).lockPath),
      beforeStateWrite: () => assertRunLockHeld(pathsFor(root).lockPath)
    }
  });

  assert.deepEqual(result.state.completed_steps, [1, 2]);
  assert.equal(result.state.current_step, 3);
  assert.match(result.warnings.join("\n"), /sparse/);
  assert.match(result.warnings.join("\n"), /duplicate/);
  assert.match(result.warnings.join("\n"), /current_step/);
  assert.equal(await hashFile(sourcePath), beforeHash);
  assert.equal((await stat(sourcePath)).mtimeMs, beforeStat.mtimeMs);

  const names = await importFiles(root);
  assert.deepEqual(names, [
    "claude-progress-2026-09-02T00-00-00-000Z.json",
    "claude-progress-2026-09-02T00-00-00-000Z.meta.json"
  ]);
  const snapshotPath = join(pathsFor(root).importsDir, names[0]);
  assert.deepEqual(await readFile(snapshotPath), sourceBytes);
  const metadata = await readJson(join(pathsFor(root).importsDir, names[1]));
  assert.deepEqual(metadata, {
    schema_version: 1,
    source_path: "step_archive/progress.json",
    source_sha256: beforeHash,
    size: sourceBytes.length,
    source_mtime: beforeStat.mtime.toISOString(),
    imported_at: instant.toISOString(),
    workflow_id: "workflow-import-1",
    normalized_prefix: [1, 2],
    warnings: result.warnings
  });
  assert.equal(JSON.stringify(metadata).includes("eval_rounds"), false);
  assert.equal(JSON.stringify(metadata).includes("transcript"), false);
  assert.equal(JSON.stringify(result.state).includes("unknown_claude_field"), false);

  const receipts = await readReceipts(root);
  assert.deepEqual(receipts.map(receipt => receipt.step), [1, 2]);
  assert.ok(receipts.every(receipt => receipt.provenance === "claude-progress-import"));
  assert.ok(receipts.every(receipt => receipt.attempt_id === null));
  assert.ok(receipts.every(receipt => receipt.source_sha256 === beforeHash));
  assert.ok(receipts.every(receipt => receipt.evidence.length === 1));
  const events = await readEvents(root);
  assert.deepEqual(events, [{
    kind: "claude_imported",
    workflow_id: "workflow-import-1",
    imported_prefix_count: 2,
    selected_step: 3,
    timestamp: instant.toISOString()
  }]);
  assert.equal(JSON.stringify(events).includes("transcript"), false);
  assert.equal(JSON.stringify(events).includes("Fixture topic"), false);
});

test("an empty prefix starts at step 1 and ignores legacy milestone, transcript, and auto-continue fields", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeFixture(root, {
    total_steps: 50,
    current_step: "1",
    completed_steps: [],
    eval_rounds: [49, 69, 104],
    transcript: { completed_steps: [1, 2, 3] },
    auto_continue: { completed_steps: [1, 2, 3] }
  });

  const result = await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now,
    idFactory: ids("workflow-empty")
  });

  assert.deepEqual(result.state.completed_steps, []);
  assert.equal(result.state.current_step, 1);
  assert.deepEqual(await readReceipts(root), []);
  assert.equal(result.state.imported_from.prefix_length, 0);
  assert.equal(JSON.stringify(result.state).includes("eval_rounds"), false);
});

test("malformed JSON creates a deterministic preserved-source error and no running state", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  const source = await writeClaudeFixture(root, null, { raw: "{ malformed\n" });
  const before = await hashFile(join(root, "step_archive", "progress.json"));

  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
    errorCode("CLAUDE_PROGRESS_JSON")
  );

  assert.equal(await readState(root), null);
  assert.deepEqual(await readReceipts(root), []);
  assert.equal(await hashFile(join(root, "step_archive", "progress.json")), before);
  const names = await importFiles(root);
  assert.deepEqual(names, ["claude-progress-2026-09-02T00-00-00-000Z.json"]);
  assert.deepEqual(await readFile(join(pathsFor(root).importsDir, names[0])), source);
  assert.deepEqual(await readJson(pathsFor(root).importErrorPath), {
    schema_version: 1,
    code: "CLAUDE_PROGRESS_JSON",
    source_preserved: true,
    source_path: "step_archive/progress.json",
    source_sha256: before,
    occurred_at: instant.toISOString(),
    action: "repair the Claude state or use a separate workspace"
  });
});

test("total_steps 107, wrong completed value types, and step 51 fail without activating state", async t => {
  const fixtures = [
    ["legacy total", { total_steps: 107, current_step: 1, completed_steps: [] }, "CLAUDE_TOTAL_STEPS"],
    ["wrong type", { total_steps: 50, current_step: 2, completed_steps: [1, false] }, "CLAUDE_STEP_VALUE"],
    ["out of range", { total_steps: 50, current_step: 2, completed_steps: [1, 51] }, "CLAUDE_STEP_RANGE"]
  ];
  for (const [name, progress, code] of fixtures) {
    await t.test(name, async () => {
      const root = await makeWorkspace();
      const pluginRoot = await makePluginFixture();
      await writeClaudeFixture(root, progress);
      await assert.rejects(
        () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
        errorCode(code)
      );
      assert.equal(await readState(root), null);
      assert.equal((await readJson(pathsFor(root).importErrorPath)).code, code);
    });
  }
});

test("missing topic and any missing canonical step definition fail closed", async t => {
  await t.test("missing topic", async () => {
    const root = await makeWorkspace();
    const pluginRoot = await makePluginFixture();
    await writeClaudeCompletedPrefix(root, 1, { topic: null });
    await assert.rejects(
      () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
      errorCode("CLAUDE_TOPIC_MISSING")
    );
    assert.equal(await readState(root), null);
  });
  await t.test("missing step definition", async () => {
    const root = await makeWorkspace();
    const pluginRoot = await makePluginFixture({ missingStep: 44 });
    await writeClaudeCompletedPrefix(root, 1);
    await assert.rejects(
      () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
      errorCode("CODEX_STEP_DEFINITIONS")
    );
    assert.equal(await readState(root), null);
  });
});

test("never merges changed Claude progress after valid Codex state exists", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 2);
  const first = await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    now,
    idFactory: ids("workflow-first")
  });
  await writeClaudeCompletedPrefix(root, 4);

  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("workflow-second") }),
    errorCode("CODEX_STATE_EXISTS")
  );
  assert.deepEqual((await readState(root)).completed_steps, first.state.completed_steps);
  assert.equal((await importFiles(root)).length, 2);
  assert.equal((await readEvents(root)).length, 1);
});

test("a pre-existing valid state refuses import before creating artifacts", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 1);
  const state = createInitialState({
    workflowId: "existing-workflow",
    workspaceRoot: root,
    topicSha256: "a".repeat(64),
    now: instant.toISOString()
  });
  await writeStateAtomic(root, state);

  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
    errorCode("CODEX_STATE_EXISTS")
  );
  await assert.rejects(() => readdir(pathsFor(root).importsDir), error => error.code === "ENOENT");
});

test("any receipt without state is an incomplete import and is never assigned a new workflow", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 1);
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: "orphaned-workflow",
    step: 1,
    attempt_id: null,
    provenance: "claude-progress-import",
    completed_at: instant.toISOString(),
    summary: "Imported historical completion for step 1",
    evidence: [{
      acceptance_id: null,
      kind: "import",
      detail: "Historical completion imported from preserved Claude progress",
      ok: true
    }],
    source_sha256: "b".repeat(64)
  });
  let called = false;

  await assert.rejects(
    () => importClaudeProgress({
      workspaceRoot: root,
      pluginRoot,
      now,
      idFactory: () => {
        called = true;
        return "must-not-be-used";
      }
    }),
    errorCode("IMPORT_INCOMPLETE")
  );
  assert.equal(called, false);
  assert.equal(await readState(root), null);
});

test("a failure after receipt publication leaves no state and makes retry report incomplete import", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 2);

  await assert.rejects(
    () => importClaudeProgress({
      workspaceRoot: root,
      pluginRoot,
      now,
      idFactory: ids("crashed-workflow"),
      hooks: {
        afterReceipt: ({ step }) => {
          if (step === 1) throw new Error("injected crash after receipt");
        }
      }
    }),
    /injected crash/
  );
  assert.equal(await readState(root), null);
  assert.deepEqual((await readReceipts(root)).map(receipt => receipt.step), [1]);
  assert.equal((await readJson(pathsFor(root).importErrorPath)).code, "CLAUDE_IMPORT_FAILED");

  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("new-workflow") }),
    errorCode("IMPORT_INCOMPLETE")
  );
  assert.deepEqual((await readReceipts(root)).map(receipt => receipt.workflow_id), ["crashed-workflow"]);
});

test("state-write failure records a deterministic failure artifact and never exposes running state", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 0);

  await assert.rejects(
    () => importClaudeProgress({
      workspaceRoot: root,
      pluginRoot,
      now,
      idFactory: ids("write-failure"),
      hooks: { beforeStateWrite: () => { throw new Error("injected state write failure"); } }
    }),
    /injected state write failure/
  );
  assert.equal(await readState(root), null);
  assert.equal((await readJson(pathsFor(root).importErrorPath)).code, "CLAUDE_IMPORT_FAILED");
});

test("the import event is attempted only after durable state and contains sanitized identifiers and counts", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 1, { topic: "sensitive topic text\n" });
  let durableState;

  await assert.rejects(
    () => importClaudeProgress({
      workspaceRoot: root,
      pluginRoot,
      now,
      idFactory: ids("event-failure"),
      hooks: {
        beforeEvent: async () => {
          durableState = await readState(root);
          throw new Error("injected event failure");
        }
      }
    }),
    /injected event failure/
  );
  assert.equal(durableState.workflow_id, "event-failure");
  assert.deepEqual(durableState.completed_steps, [1]);
  await assert.rejects(() => readFile(pathsFor(root).eventsPath), error => error.code === "ENOENT");
  await assert.rejects(() => readFile(pathsFor(root).importErrorPath), error => error.code === "ENOENT");
});

test("concurrent imports serialize so exactly one workflow and one stable snapshot win", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 1);

  const settled = await Promise.allSettled([
    importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("concurrent-a") }),
    importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("concurrent-b") })
  ]);

  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const rejected = settled.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "CODEX_STATE_EXISTS");
  assert.equal((await importFiles(root)).length, 2);
  assert.equal((await readReceipts(root)).length, 1);
  assert.equal((await readEvents(root)).length, 1);
});

test("step-definition targets cannot escape the selected plugin root", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 1);
  const indexPath = join(pluginRoot, "codex", "assets", "steps", "index.json");
  const index = await readJson(indexPath);
  index.steps[0].target = "../outside.md";
  await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory: ids("unused") }),
    errorCode("CODEX_STEP_DEFINITIONS")
  );
  assert.equal(await readState(root), null);
});

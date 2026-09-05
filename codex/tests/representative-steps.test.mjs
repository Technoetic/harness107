import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadStepContract,
  validateCompletionEvidence
} from "../scripts/lib/acceptance.mjs";
import { importClaudeProgress } from "../scripts/lib/importer.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readReceipts, writeReceiptExclusive } from "../scripts/lib/receipts.mjs";
import { readState } from "../scripts/lib/state-store.mjs";
import {
  beginStep,
  completeStep,
  initWorkflow,
  resumeWorkflow
} from "../scripts/lib/workflow.mjs";
import { runCli } from "./helpers/run-cli.mjs";
import {
  hashFile,
  makeDirectoryLink,
  makePluginFixture,
  makeWorkspace,
  writeClaudeCompletedPrefix
} from "./helpers/workspace.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseTime = new Date(Date.now() - 60_000).toISOString();

function plus(milliseconds) {
  return new Date(Date.parse(baseTime) + milliseconds).toISOString();
}

function ids(prefix) {
  let offset = 0;
  return () => `${prefix}-${++offset}`;
}

function commandFor(declaration) {
  if (declaration.command) return declaration.command;
  if (declaration.id === "project-build-command" || declaration.id === "final-build") {
    return "npm run build";
  }
  if (declaration.id === "project-e2e-command") return "npm run e2e";
  throw new Error(`representative command fixture missing for ${declaration.id}`);
}

function evidenceFor(contract) {
  return contract.acceptance
    .filter(item => item.required)
    .map(item => {
      const common = {
        acceptance_id: item.id,
        kind: item.kind,
        detail: `${item.id} independently verified`,
        ok: true
      };
      if (item.kind === "artifact") return { ...common, artifact_path: item.path };
      if (item.kind === "command") {
        return { ...common, command: commandFor(item), exit_code: 0 };
      }
      return common;
    });
}

async function materializeRepresentativeFixture(contract, workspaceRoot = null) {
  const root = workspaceRoot ?? await makeWorkspace();
  for (const item of contract.acceptance.filter(value => value.required && value.kind === "artifact")) {
    const path = join(root, ...item.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.validator === "html-document"
      ? '<!doctype html><html lang="en"><head><title>Fixture</title></head><body>Fixture</body></html>'
      : `fixture bytes for ${contract.id}/${item.id}\n`, "utf8");
  }
  for (const item of contract.acceptance.filter(value => value.validator === "browser-output")) {
    await writeFile(join(root, item.path), JSON.stringify(browserReport(await hashFile(join(root, "dist/index.html")))));
  }
  return { workspaceRoot: root, evidence: evidenceFor(contract) };
}

function browserReport(digest) {
  return {
    schema_version: 1, generated_at: new Date().toISOString(), verdict: "PASS",
    artifact_path: "dist/index.html", artifact_sha256: digest,
    viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }].map(view => ({
      ...view, pass: true, errors: [], blocked_requests: 0, violations: [],
      accessibility_incomplete: [], horizontal_overflow: false, visible_text_length: 7,
      focusable_elements: 0, keyboard_focus: false,
      screenshot: `step_archive/screenshots/verified-${view.name}.png`
    }))
  };
}

test("Step 50 requires a passing browser report bound to its current HTML", async () => {
  const contract = await loadStepContract(repoRoot, 50);
  assert.ok(contract.acceptance.some(item => item.id === "browser-output-report" && item.required && item.validator === "browser-output"));
  const { workspaceRoot, evidence } = await materializeRepresentativeFixture(contract);
  const reportPath = join(workspaceRoot, "step_archive/outputs/browser-output.json");
  const valid = JSON.parse(await readFile(reportPath, "utf8"));
  for (const mutate of [
    report => { report.verdict = "FAIL"; },
    report => { report.viewports[0].pass = false; },
    report => { report.viewports = []; },
    report => { report.viewports[1].name = "desktop"; },
    report => { report.viewports[0].errors = ["pageerror"]; },
    report => { report.artifact_sha256 = "0".repeat(64); }
  ]) {
    const report = structuredClone(valid);
    mutate(report);
    await writeFile(reportPath, JSON.stringify(report));
    await assert.rejects(validateCompletionEvidence({ contract, evidence, workspaceRoot }),
      error => ["ACCEPTANCE_ARTIFACT_CONTENT", "ACCEPTANCE_ARTIFACT_HASH_MISMATCH"].includes(error.code));
  }
  await writeFile(reportPath, JSON.stringify(valid));
  await assert.rejects(validateCompletionEvidence({ contract, workspaceRoot,
    evidence: evidence.filter(item => item.acceptance_id !== "browser-output-report")
  }), error => error.code === "ACCEPTANCE_MISSING");
  await writeFile(join(workspaceRoot, "dist/index.html"), "<html><body>Changed after browser verification</body></html>");
  await assert.rejects(validateCompletionEvidence({ contract, evidence, workspaceRoot }),
    error => ["ACCEPTANCE_ARTIFACT_CONTENT", "ACCEPTANCE_ARTIFACT_HASH_MISMATCH"].includes(error.code));
});

test("Step 50 browser binding survives evidence reordering and rejects a replaced final build", async () => {
  const contract = await loadStepContract(repoRoot, 50);
  for (const reverse of [false, true]) {
    const fixture = await materializeRepresentativeFixture(contract);
    const evidence = reverse ? fixture.evidence.toReversed() : fixture.evidence;
    await validateCompletionEvidence({ contract, evidence, workspaceRoot: fixture.workspaceRoot });
    await assert.rejects(validateCompletionEvidence({ contract, evidence, workspaceRoot: fixture.workspaceRoot,
      afterArtifactOpen: async ({ absolutePath }) => {
        if (absolutePath.endsWith("browser-output.json")) {
          await writeFile(join(fixture.workspaceRoot, "dist/index.html"), "<html><body>Replaced while binding browser evidence</body></html>");
        }
      }
    }), error => ["ACCEPTANCE_ARTIFACT_CONTENT", "ACCEPTANCE_ARTIFACT_HASH_MISMATCH"].includes(error.code));
  }
});

async function beginRepresentativeStep() {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "Representative acceptance topic",
    now: plus(0),
    idFactory: ids("init")
  });
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: "representative-session",
    marker: initialized.continuation,
    now: plus(1),
    idFactory: ids("attempt")
  });
  return { root, started };
}

async function snapshotCompletionStorage(root) {
  const paths = pathsFor(root);
  const readOrNull = path => readFile(path).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return {
    state: await readOrNull(paths.statePath),
    events: await readOrNull(paths.eventsPath),
    receipts: await readdir(paths.receiptsDir).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    })
  };
}

function artifactContract(path = "artifacts/result.txt") {
  return {
    number: 1,
    id: "step001",
    acceptance: [{
      id: "result-artifact",
      kind: "artifact",
      required: true,
      description: "Fixture artifact",
      path
    }]
  };
}

function artifactEvidence(path = "artifacts/result.txt", digest = undefined) {
  const value = {
    acceptance_id: "result-artifact",
    kind: "artifact",
    detail: "artifact verified",
    ok: true,
    artifact_path: path
  };
  if (digest !== undefined) value.artifact_sha256 = digest;
  return [value];
}

for (const step of [1, 16, 30, 38, 45, 50]) {
  test(`Step ${step} validates its real artifact contract`, async () => {
    const contract = await loadStepContract(repoRoot, step);
    const fixture = await materializeRepresentativeFixture(contract);
    const result = await validateCompletionEvidence({
      contract,
      evidence: fixture.evidence,
      workspaceRoot: fixture.workspaceRoot
    });
    assert.deepEqual(result.missing_required, []);

    for (const item of result.evidence.filter(value => value.kind === "artifact")) {
      assert.equal(
        item.artifact_sha256,
        await hashFile(join(fixture.workspaceRoot, ...item.artifact_path.split("/")))
      );
    }

    await assert.rejects(
      () => validateCompletionEvidence({
        contract,
        evidence: fixture.evidence.slice(1),
        workspaceRoot: fixture.workspaceRoot
      }),
      error => error.code === "ACCEPTANCE_MISSING"
    );

    const artifact = contract.acceptance.find(item => item.required && item.kind === "artifact");
    await unlink(join(fixture.workspaceRoot, ...artifact.path.split("/")));
    await assert.rejects(
      () => validateCompletionEvidence({
        contract,
        evidence: fixture.evidence,
        workspaceRoot: fixture.workspaceRoot
      }),
      error => error.code === "ACCEPTANCE_ARTIFACT_MISSING"
    );
  });
}

test("library and CLI completion cannot bypass required acceptance or mutate workflow storage", async () => {
  const { root, started } = await beginRepresentativeStep();
  const contract = await loadStepContract(repoRoot, 1);
  await materializeRepresentativeFixture(contract, root);
  const before = await snapshotCompletionStorage(root);

  await assert.rejects(
    () => completeStep({
      workspaceRoot: root,
      pluginRoot: repoRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "missing evidence",
      evidence: [],
      now: plus(2)
    }),
    error => error.code === "ACCEPTANCE_MISSING"
  );
  assert.deepEqual(await snapshotCompletionStorage(root), before);

  const cli = await runCli([
    "complete", "--workspace", root,
    "--step", "1", "--attempt", started.attempt.id, "--input", "-"
  ], { input: { summary: "still missing", evidence: [] } });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /ACCEPTANCE_MISSING/);
  assert.deepEqual(await snapshotCompletionStorage(root), before);
});

test("native evidence has an exact declaration-bound shape and never executes command text", async () => {
  const root = await makeWorkspace();
  const sentinel = join(root, "must-not-exist");
  const command = `node -e "require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')"`;
  const contract = {
    number: 1,
    id: "step001",
    acceptance: [
      { id: "command", kind: "command", required: true, description: "Command", command },
      { id: "check", kind: "check", required: true, description: "Check" }
    ]
  };
  const valid = [
    {
      acceptance_id: "command",
      kind: "command",
      detail: "represented only",
      ok: true,
      command,
      exit_code: 0
    },
    {
      acceptance_id: "check",
      kind: "check",
      detail: "observed",
      ok: true
    }
  ];
  await validateCompletionEvidence({ contract, evidence: valid, workspaceRoot: root });
  await assert.rejects(() => readFile(sentinel), error => error?.code === "ENOENT");

  const mutations = [
    [[{ ...valid[0], acceptance_id: null }, valid[1]], "EVIDENCE_INVALID"],
    [[{ ...valid[0], kind: "import" }, valid[1]], "ACCEPTANCE_KIND_MISMATCH"],
    [[{ ...valid[0], artifact_path: "extra" }, valid[1]], "ACCEPTANCE_FIELDS"],
    [[valid[0], valid[0], valid[1]], "ACCEPTANCE_DUPLICATE"],
    [[{ ...valid[0], acceptance_id: "unknown" }, valid[1]], "ACCEPTANCE_UNKNOWN"],
    [[{ ...valid[0], command: `${command} extra` }, valid[1]], "ACCEPTANCE_COMMAND_MISMATCH"],
    [[{ ...valid[0], exit_code: 1 }, valid[1]], "ACCEPTANCE_COMMAND_FAILED"],
    [[valid[0]], "ACCEPTANCE_MISSING"]
  ];
  for (const [evidence, code] of mutations) {
    await assert.rejects(
      () => validateCompletionEvidence({ contract, evidence, workspaceRoot: root }),
      error => error.code === code,
      code
    );
  }

  await assert.rejects(
    () => validateCompletionEvidence({
      contract: {
        number: 1,
        id: "step001",
        acceptance: [{
          id: "pattern-command",
          kind: "command",
          required: true,
          description: "Pattern command",
          command_pattern: "^npm test$"
        }]
      },
      evidence: [{
        acceptance_id: "pattern-command",
        kind: "command",
        detail: "must consume every byte",
        ok: true,
        command: "npm test\n",
        exit_code: 0
      }],
      workspaceRoot: root
    }),
    error => error.code === "ACCEPTANCE_COMMAND_MISMATCH"
  );
});

test("receipt replay permits a failed optional artifact without a digest and never reads it", async () => {
  const root = await makeWorkspace();
  const contract = {
    number: 33,
    id: "step033",
    acceptance: [
      {
        id: "required-check",
        kind: "check",
        required: true,
        description: "Required fixture check"
      },
      {
        id: "optional-baseline",
        kind: "artifact",
        required: false,
        description: "Optional fixture artifact",
        path: "step_archive/optional-baseline.json"
      }
    ]
  };
  const evidence = [
    {
      acceptance_id: "required-check",
      kind: "check",
      detail: "required check passed",
      ok: true
    },
    {
      acceptance_id: "optional-baseline",
      kind: "artifact",
      detail: "optional tool unavailable",
      ok: false,
      artifact_path: "step_archive/optional-baseline.json"
    }
  ];
  const result = await validateCompletionEvidence({
    contract,
    evidence,
    persistedEvidence: evidence,
    workspaceRoot: root
  });
  assert.deepEqual(result.evidence, evidence);
  await assert.rejects(
    () => readFile(join(root, "step_archive", "optional-baseline.json")),
    error => error?.code === "ENOENT"
  );
});

test("artifact validation rejects nonportable paths, aliases, and redirected intermediate directories", async t => {
  for (const path of ["../escape.txt", "artifacts\\result.txt", "C:/result.txt", "/result.txt"]) {
    await assert.rejects(
      () => validateCompletionEvidence({
        contract: artifactContract(path),
        evidence: artifactEvidence(path),
        workspaceRoot: repoRoot
      }),
      error => error.code === "ACCEPTANCE_ARTIFACT_PATH_UNSAFE"
    );
  }

  await t.test("hard links are rejected", async () => {
    const root = await makeWorkspace();
    const source = join(root, "source.txt");
    const artifact = join(root, "artifacts", "result.txt");
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(source, "aliased\n", "utf8");
    await link(source, artifact);
    await assert.rejects(
      () => validateCompletionEvidence({
        contract: artifactContract(),
        evidence: artifactEvidence(),
        workspaceRoot: root
      }),
      error => error.code === "ACCEPTANCE_ARTIFACT_UNSAFE"
    );
  });

  await t.test("junction or directory-symlink traversal is rejected", async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "result.txt"), "redirected\n", "utf8");
    await makeDirectoryLink(outside, join(root, "artifacts"));
    await assert.rejects(
      () => validateCompletionEvidence({
        contract: artifactContract(),
        evidence: artifactEvidence(),
        workspaceRoot: root
      }),
      error => error.code === "ACCEPTANCE_ARTIFACT_UNSAFE"
    );
  });

  await t.test("file symlinks are rejected when the host permits creating one", async t => {
    const root = await makeWorkspace();
    const target = join(root, "target.txt");
    const artifact = join(root, "artifacts", "result.txt");
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(target, "redirected\n", "utf8");
    try {
      await symlink(target, artifact, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => validateCompletionEvidence({
        contract: artifactContract(),
        evidence: artifactEvidence(),
        workspaceRoot: root
      }),
      error => error.code === "ACCEPTANCE_ARTIFACT_UNSAFE"
    );
  });
});

test("artifact hashing detects unlink, replacement, and mutation after the stable handle opens", async t => {
  const cases = {
    unlink: async path => unlink(path),
    replace: async path => {
      await rename(path, `${path}.held`);
      await writeFile(path, "replacement bytes\n", "utf8");
    },
    mutate: async path => writeFile(path, "mutated bytes with a different length\n", "utf8"),
    "same-size-mutate": async path => writeFile(path, "mutated! bytes\n", "utf8")
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => {
      const root = await makeWorkspace();
      const artifact = join(root, "artifacts", "result.txt");
      await mkdir(dirname(artifact), { recursive: true });
      await writeFile(artifact, "original bytes\n", "utf8");
      await assert.rejects(
        () => validateCompletionEvidence({
          contract: artifactContract(),
          evidence: artifactEvidence(),
          workspaceRoot: root,
          afterArtifactOpen: async ({ absolutePath }) => mutate(absolutePath)
        }),
        error => error.code === "ACCEPTANCE_ARTIFACT_CHANGED"
      );
    });
  }
});

test("artifact hashes must match when supplied and are canonicalized when omitted", async () => {
  const root = await makeWorkspace();
  const artifact = join(root, "artifacts", "result.txt");
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, "stable bytes\n", "utf8");
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const canonical = await validateCompletionEvidence({
    contract: artifactContract(),
    evidence: artifactEvidence(),
    workspaceRoot: root
  });
  assert.equal(canonical.evidence[0].artifact_sha256, digest);
  await assert.rejects(
    () => validateCompletionEvidence({
      contract: artifactContract(),
      evidence: artifactEvidence("artifacts/result.txt", "0".repeat(64)),
      workspaceRoot: root
    }),
    error => error.code === "ACCEPTANCE_ARTIFACT_HASH_MISMATCH"
  );
});

test("step contracts reject aliased targets and ambiguous command patterns", async () => {
  const aliasedRoot = await makePluginFixture();
  const source = join(aliasedRoot, "target-alias-source.md");
  const target = join(aliasedRoot, "codex", "assets", "steps", "step001.md");
  await writeFile(source, "# Alias source\n", "utf8");
  await unlink(target);
  await link(source, target);
  await assert.rejects(
    () => loadStepContract(aliasedRoot, 1),
    error => error.code === "PLUGIN_ROOT_INVALID"
  );

  const patternRoot = await makePluginFixture();
  const indexPath = join(patternRoot, "codex", "assets", "steps", "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.steps[0].acceptance = [{
    id: "ambiguous-command",
    kind: "command",
    required: true,
    description: "Must reject top-level alternation",
    command_pattern: "^first$|^second$"
  }];
  await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
  await assert.rejects(
    () => loadStepContract(patternRoot, 1),
    error => error.code === "STEP_CONTRACT_INVALID"
  );

  const metadataRoot = await makePluginFixture();
  const metadataIndexPath = join(metadataRoot, "codex", "assets", "steps", "index.json");
  const metadataIndex = JSON.parse(await readFile(metadataIndexPath, "utf8"));
  metadataIndex.steps[0].next = "step050";
  await writeFile(metadataIndexPath, `${JSON.stringify(metadataIndex)}\n`, "utf8");
  await assert.rejects(
    () => loadStepContract(metadataRoot, 1),
    error => error.code === "STEP_CONTRACT_INVALID"
  );

  const escapedAnchorRoot = await makePluginFixture();
  const escapedIndexPath = join(escapedAnchorRoot, "codex", "assets", "steps", "index.json");
  const escapedIndex = JSON.parse(await readFile(escapedIndexPath, "utf8"));
  escapedIndex.steps[0].acceptance = [{
    id: "escaped-anchor-command",
    kind: "command",
    required: true,
    description: "An escaped dollar is not an end anchor",
    command_pattern: "^npm test\\$"
  }];
  await writeFile(escapedIndexPath, `${JSON.stringify(escapedIndex)}\n`, "utf8");
  await assert.rejects(
    () => loadStepContract(escapedAnchorRoot, 1),
    error => error.code === "STEP_CONTRACT_INVALID"
  );
});

test("visual-review contracts require a screenshot artifact and an inspection check", async () => {
  const root = await makeWorkspace();
  const checkOnly = {
    number: 39,
    id: "step039",
    visual_review: true,
    acceptance: [{
      id: "visual-inspection-required",
      kind: "check",
      required: true,
      description: "Confirms visual inspection."
    }]
  };
  await assert.rejects(
    () => validateCompletionEvidence({
      contract: checkOnly,
      evidence: [{
        acceptance_id: "visual-inspection-required",
        kind: "check",
        detail: "opened and inspected",
        ok: true
      }],
      workspaceRoot: root
    }),
    error => error.code === "STEP_CONTRACT_INVALID"
  );

  const screenshotOnly = {
    number: 39,
    id: "step039",
    visual_review: true,
    acceptance: [{
      id: "primary-screenshot",
      kind: "artifact",
      required: true,
      description: "Required screenshot",
      path: "step_archive/screenshots/primary.png"
    }]
  };
  await assert.rejects(
    () => validateCompletionEvidence({
      contract: screenshotOnly,
      evidence: [{
        acceptance_id: "primary-screenshot",
        kind: "artifact",
        detail: "screenshot saved",
        ok: true,
        artifact_path: "step_archive/screenshots/primary.png"
      }],
      workspaceRoot: root
    }),
    error => error.code === "STEP_CONTRACT_INVALID"
  );
});

test("receipt-first retry trusts persisted canonical evidence without reopening live artifacts", async () => {
  const root = await makeWorkspace();
  await writeClaudeCompletedPrefix(root, 49, { topic: "Receipt recovery\n" });
  await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot: repoRoot,
    now: () => new Date(plus(0)),
    idFactory: ids("import")
  });
  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "receipt-session",
    now: plus(1),
    idFactory: ids("resume")
  });
  const started = await beginStep({
    workspaceRoot: root,
    step: 50,
    sessionId: "receipt-session",
    marker: resumed.continuation,
    now: plus(2),
    idFactory: ids("begin")
  });
  const contract = await loadStepContract(repoRoot, 50);
  assert.ok(contract.acceptance.some(item => item.id === "console-errors-zero" && item.kind === "check"));
  assert.ok(contract.acceptance.some(item => item.id === "final-build" && item.kind === "command"));
  const fixture = await materializeRepresentativeFixture(contract, root);
  const canonical = await validateCompletionEvidence({
    contract,
    evidence: fixture.evidence,
    workspaceRoot: root
  });
  await writeReceiptExclusive(root, {
    schema_version: 1,
    workflow_id: started.state.workflow_id,
    step: 50,
    attempt_id: started.attempt.id,
    provenance: "codex-verified",
    completed_at: plus(3),
    summary: "final step",
    evidence: canonical.evidence
  });
  for (const item of contract.acceptance.filter(value => value.required && value.kind === "artifact")) {
    await unlink(join(root, ...item.path.split("/")));
  }

  const recovered = await completeStep({
    workspaceRoot: root,
    pluginRoot: repoRoot,
    step: 50,
    attemptId: started.attempt.id,
    summary: "final step",
    evidence: fixture.evidence,
    now: plus(4)
  });
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.current_step, null);
  assert.equal(recovered.completed_steps.length, 50);
  assert.equal(recovered.completed_at, plus(3));

  const before = await snapshotCompletionStorage(root);
  const artifactIndex = fixture.evidence.findIndex(item => item.kind === "artifact");
  const commandIndex = fixture.evidence.findIndex(item => item.kind === "command");
  const mutations = [
    {
      summary: "different summary",
      evidence: fixture.evidence
    },
    {
      summary: "final step",
      evidence: fixture.evidence.map((item, index) => index === 0 ? { ...item, detail: "different detail" } : item)
    },
    {
      summary: "final step",
      evidence: fixture.evidence.map((item, index) => index === artifactIndex ? { ...item, kind: "check" } : item)
    },
    {
      summary: "final step",
      evidence: fixture.evidence.map((item, index) => index === artifactIndex
        ? { ...item, artifact_path: "different/path.txt" }
        : item)
    },
    {
      summary: "final step",
      evidence: fixture.evidence.map((item, index) => index === artifactIndex
        ? { ...item, artifact_sha256: "0".repeat(64) }
        : item)
    },
    {
      summary: "final step",
      evidence: fixture.evidence.map((item, index) => index === commandIndex
        ? { ...item, command: `${item.command} extra` }
        : item)
    }
  ];
  for (const mutation of mutations) {
    await assert.rejects(
      () => completeStep({
        workspaceRoot: root,
        pluginRoot: repoRoot,
        step: 50,
        attemptId: started.attempt.id,
        summary: mutation.summary,
        evidence: mutation.evidence,
        now: plus(5)
      }),
      error => error.code === "RECEIPT_CONFLICT"
    );
    assert.deepEqual(await snapshotCompletionStorage(root), before);
  }
  assert.equal((await readReceipts(root)).length, 50);
  assert.deepEqual(await readState(root), recovered);
});

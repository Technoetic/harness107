# Harness50 Claude + Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Extend the existing Harness50 repository so the same plugin package supports Claude Code and Codex, including safe one-way Claude-to-Codex progress import and Codex-native 50-step continuation.

**Architecture:** Preserve the current Claude adapter and add an isolated Codex adapter under .codex-plugin/ and codex/. Share tutorial artifacts under step_archive/, but keep Codex control state and immutable receipts under step_archive/.harness50-codex/; Codex reads Claude progress.json only during a one-time import and never writes it.

**Tech Stack:** Dependency-free Node.js ESM, Node built-in test runner, JSON/Markdown plugin assets, Codex command hooks, PowerShell installation/regression scripts, existing Bash and PowerShell Claude regression suites.

**Spec:** docs/superpowers/specs/2026-09-02-harness50-claude-codex-design.md

## Global Constraints

- Commit this approved plan by itself in the original worktree before creating the implementation worktree; that planning commit must not include any protected user-owned file.
- After that planning commit exists, execute this plan in an isolated Git worktree created with superpowers:using-git-worktrees before Task 1.
- Base the worktree on commit 5c0f520 or a descendant containing the approved spec and this plan.
- The plugin identity is harness50 on both hosts; do not create a harness50-codex repository or second marketplace identity.
- The first dual-platform release version is 2.1.0 in both manifests and marketplace metadata.
- Codex invocation is $webapp, $harness50-status, and $harness50-reset; do not create or advertise a Codex /webapp command.
- Keep exactly 50 canonical steps numbered 001 through 050.
- Codex state lives only in step_archive/.harness50-codex/. Claude state remains step_archive/progress.json and is read-only to Codex.
- Imported completions are historical Claude provenance, not Codex-verified evidence.
- Do not parse transcripts to create Codex completion.
- Do not return permissionDecision=allow, approve PermissionRequest, change Codex permission mode, or bypass hook trust.
- Use only Node built-ins in the Codex runtime and tests; do not add npm dependencies or a package.json solely for the adapter.
- Support Windows and POSIX path behavior; all new .mjs, JSON, and Markdown files use LF.
- Do not push, publish, deploy, or modify a remote repository during implementation. Local installation is deferred to Task 22.
- Preserve and never edit, stage, revert, format, or overwrite these current user-owned files:
  - hooks/auto-approve.ps1
  - hooks/destructive-guard.ps1
  - hooks/hooks.json
  - hooks/html-bundler.ps1
  - hooks/lsp-autofix.ps1
  - hooks/mx-tag-validator.ps1
  - hooks/permission-request-guard.ps1
  - hooks/spec-generator.ps1
  - hooks/step-auto-continue.ps1
  - hooks/step-obedience-guard.ps1
  - hooks/step-progress-loader.ps1
  - hooks/step-progress-writer.ps1
  - hooks/trust5-validator.ps1
  - hooks/validate-tools.ps1
  - hooks/webapp-trigger.ps1
  - tests/security-regression.ps1
- Stage exact task paths only. Never use git add -A, git add ., git reset, or checkout-based cleanup.
- Each task receives a spec-compliance review and a code-quality review before moving to the next task.
- Before creating the implementation worktree, record SHA-256 values for all protected files in a temporary report outside the repository. Task 23 compares the same original-worktree paths against that report.

### Required pre-execution setup

Run this from the current original worktree before invoking superpowers:using-git-worktrees or starting Task 1:

~~~powershell
$originalRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
$protectedRelativePaths = @(
  "hooks/auto-approve.ps1",
  "hooks/destructive-guard.ps1",
  "hooks/hooks.json",
  "hooks/html-bundler.ps1",
  "hooks/lsp-autofix.ps1",
  "hooks/mx-tag-validator.ps1",
  "hooks/permission-request-guard.ps1",
  "hooks/spec-generator.ps1",
  "hooks/step-auto-continue.ps1",
  "hooks/step-obedience-guard.ps1",
  "hooks/step-progress-loader.ps1",
  "hooks/step-progress-writer.ps1",
  "hooks/trust5-validator.ps1",
  "hooks/validate-tools.ps1",
  "hooks/webapp-trigger.ps1",
  "tests/security-regression.ps1"
)
$rootPrefix = $originalRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$entries = foreach ($relativePath in $protectedRelativePaths) {
  $absolutePath = (Resolve-Path -LiteralPath (Join-Path $originalRoot $relativePath)).Path
  if (-not $absolutePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected path escaped original worktree: $relativePath"
  }
  [ordered]@{
    relative_path = $relativePath
    absolute_path = $absolutePath
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $absolutePath).Hash.ToLowerInvariant()
  }
}
$protectedReportPath = Join-Path ([IO.Path]::GetTempPath()) ("harness50-protected-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"))
$reportJson = [ordered]@{
  schema_version = 1
  original_root = $originalRoot
  created_at = (Get-Date).ToUniversalTime().ToString("o")
  entries = $entries
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($protectedReportPath, $reportJson, [Text.UTF8Encoding]::new($false))
$protectedReportPath
~~~

Expected: one JSON report under the system temporary directory, with 16 entries and absolute paths rooted in the original worktree. Copy the printed absolute report path into the execution handoff as `PROTECTED_REPORT_PATH`; later tasks must not assume that PowerShell variables survive between task sessions. Never copy the report into Git or into the implementation worktree.

## File and Interface Map

The finished adapter uses these focused units:

~~~text
.codex-plugin/plugin.json
codex/
├─ README.md
├─ assets/steps/
│  ├─ PORTING.md
│  ├─ index.json
│  └─ step001.md~step050.md
├─ hooks/
│  ├─ hooks.json
│  ├─ session-start.mjs
│  ├─ user-prompt-submit.mjs
│  ├─ stop.mjs
│  └─ pre-tool-use.mjs
├─ skills/
│  ├─ webapp/SKILL.md
│  ├─ harness50-status/SKILL.md
│  └─ harness50-reset/SKILL.md
├─ scripts/
│  ├─ harness-state.mjs
│  ├─ validate-steps.mjs
│  └─ lib/
│     ├─ errors.mjs
│     ├─ paths.mjs
│     ├─ schema.mjs
│     ├─ json-io.mjs
│     ├─ lock.mjs
│     ├─ state-store.mjs
│     ├─ receipts.mjs
│     ├─ importer.mjs
│     ├─ ownership.mjs
│     ├─ workflow.mjs
│     ├─ acceptance.mjs
│     ├─ hook-io.mjs
│     └─ guard.mjs
└─ tests/
   ├─ helpers/
   │  ├─ workspace.mjs
   │  ├─ run-cli.mjs
   │  ├─ run-hook.mjs
   │  └─ child-mutate.mjs
   ├─ fixtures/hooks/*.json
   ├─ package.test.mjs
   ├─ paths-schema.test.mjs
   ├─ lock-store.test.mjs
   ├─ receipts.test.mjs
   ├─ importer.test.mjs
   ├─ workflow.test.mjs
   ├─ cli.test.mjs
   ├─ hooks-config.test.mjs
   ├─ hooks-lifecycle.test.mjs
   ├─ guard.test.mjs
   ├─ steps-validator.test.mjs
   ├─ steps-parity.test.mjs
   ├─ representative-steps.test.mjs
   ├─ simulation.test.mjs
   ├─ claude-regression-copy.ps1
   ├─ claude-regression-copy.sh
   └─ install-smoke.ps1
~~~

Canonical runtime types used by every task:

~~~js
// State
{
  schema_version: 1,
  workflow_id: string,
  status: "running" | "paused" | "blocked" | "completed",
  total_steps: 50,
  current_step: number | null,
  completed_steps: number[],
  topic_path: "step_archive/TOPIC/TOPIC.md",
  topic_sha256: string,
  current_attempt: null | {
    id: string,
    step: number,
    session_id: string | null,
    started_at: string,
    failure_recorded: boolean
  },
  consecutive_failures: number,
  blocked_reason: string | null,
  owner: null | { session_id: string, lease_updated_at: string },
  continuation: null | {
    workflow_id: string,
    step: number,
    nonce: string,
    issued_at: string,
    baseline_receipt_count: number
  },
  imported_from: null | {
    kind: "claude-progress",
    source_sha256: string,
    imported_at: string,
    prefix_length: number,
    warnings: string[]
  },
  last_stop_turn_id: string | null,
  created_at: string,
  updated_at: string,
  completed_at: string | null
}

// Receipt
{
  schema_version: 1,
  workflow_id: string,
  step: number,
  attempt_id: string | null,
  provenance: "codex-verified" | "claude-progress-import",
  completed_at: string,
  summary: string,
  evidence: Array<{
    acceptance_id: string | null,
    kind: "command" | "artifact" | "check" | "import",
    detail: string,
    ok: boolean,
    artifact_path?: string,
    artifact_sha256?: string,
    command?: string,
    exit_code?: number
  }>,
  source_sha256?: string
}
~~~

Test helper contracts used throughout the plan:

~~~js
export async function makeWorkspace(): Promise<string>;
export async function makePluginFixture({ steps = 50 } = {}): Promise<string>;
export async function hashFile(path): Promise<string>;
export async function readJson(path): Promise<object>;
export async function writeClaudeFixture(root, progress, { bom = false } = {}): Promise<void>;
export async function writeClaudeCompletedPrefix(root, lastStep): Promise<void>;
export async function runCli(args, { input = null, env = {} } = {}):
  Promise<{ code: number, stdout: string, stderr: string }>;
export async function runHook(name, event, { env = {} } = {}):
  Promise<{ code: number, output: object, stderr: string }>;
~~~

Small helpers that are used in only one test file are defined beside that test before first use: runConcurrentMutators() in lock-store.test.mjs; receiptFor() in receipts.test.mjs; entry() in steps-validator.test.mjs; initAndBegin() and failCurrentStepThreeTimes() in workflow.test.mjs; writeImportErrorFixture() in cli.test.mjs; allCommandHandlers() and assertHookCommandResolvesInsidePlugin() in hooks-config.test.mjs; inspect() and inspectEvent() in guard.test.mjs; makeParityFixture() and targetStep() in steps-parity.test.mjs; materializeRepresentativeFixture() and beginRepresentativeStep() in representative-steps.test.mjs; and beginFromCurrentContinuation() in simulation.test.mjs. makePluginFixture() creates an isolated plugin root with a valid index and 50 minimal step-definition files, each declaring one required `state-transition` check acceptance item, so importer and state-only simulation tests do not depend on the later production ports.

Each test file defines deterministic local factories before use:

~~~js
const now = "2026-09-02T00:00:00.000Z";
const idFactory = (() => {
  let value = 0;
  return () => `fixture-id-${++value}`;
})();
~~~

---

### Task 1: Establish the Codex Package Boundary

**Files:**
- Create: .codex-plugin/plugin.json
- Create: codex/tests/package.test.mjs

**Interfaces:**
- Consumes: approved spec and repository root
- Produces: a stable harness50 manifest with skills=./codex/skills/ and hooks=./codex/hooks/hooks.json

- [ ] **Step 1: Write the failing manifest contract test**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Codex manifest isolates Codex skills and hooks", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../.codex-plugin/plugin.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.name, "harness50");
  assert.equal(manifest.version, "2.1.0");
  assert.equal(manifest.skills, "./codex/skills/");
  assert.equal(manifest.hooks, "./codex/hooks/hooks.json");
  assert.notEqual(manifest.hooks, "./hooks/hooks.json");
});
~~~

- [ ] **Step 2: Run the test and verify the missing manifest fails**

Run: node --test codex/tests/package.test.mjs

Expected: FAIL with ENOENT for .codex-plugin/plugin.json.

- [ ] **Step 3: Add the minimal Codex manifest**

~~~json
{
  "name": "harness50",
  "version": "2.1.0",
  "description": "Run the Harness50 web tutorial workflow in Codex with explicit progress receipts and normal Codex permissions.",
  "author": { "name": "Technoetic" },
  "homepage": "https://github.com/Technoetic/harness50",
  "repository": "https://github.com/Technoetic/harness50",
  "license": "MIT",
  "keywords": ["harness", "tutorial", "codex", "claude-code", "plugin"],
  "skills": "./codex/skills/",
  "hooks": "./codex/hooks/hooks.json"
}
~~~

- [ ] **Step 4: Run the manifest test**

Run: node --test codex/tests/package.test.mjs

Expected: PASS 1 test.

- [ ] **Step 5: Commit only the package boundary**

~~~powershell
git add -- .codex-plugin/plugin.json codex/tests/package.test.mjs
git commit -m "feat(codex): add isolated plugin manifest"
~~~

### Task 2: Establish the 50-Step Mapping Contract

**Files:**
- Create: codex/assets/steps/PORTING.md
- Create: codex/assets/steps/index.json
- Create: codex/scripts/validate-steps.mjs
- Create: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: Claude source steps and the approved provider-neutral conversion rules
- Produces: loadIndex(), validateIndex(), validateStepBatch(), scanForbiddenTokens(), recordSourceHashes(), and an exact 50-row source-to-target map

- [ ] **Step 1: Write failing mapping and validator tests**

~~~js
test("initial map covers every Claude step before runtime work begins", async () => {
  const index = await loadIndex(repoRoot);
  const report = await validateIndex(index, { repoRoot, requirePorted: false });
  assert.deepEqual(report.steps.map(step => step.number),
    Array.from({ length: 50 }, (_, offset) => offset + 1));
  assert.equal(report.steps[0].source, "assets/steps/step001.md");
  assert.equal(report.steps[0].target, "codex/assets/steps/step001.md");
  assert.equal(report.steps.at(-1).next, null);
  assert.ok(report.steps.every(step => step.ported === false));
});

test("validator rejects provider-specific and stale runtime tokens", () => {
  const diagnostics = scanForbiddenTokens(
    "Use Haiku, WebFetch, .claude/state and then read step081.md"
  );
  assert.deepEqual(diagnostics.map(item => item.code), [
    "MODEL_SPECIFIC", "TOOL_SPECIFIC", "CLAUDE_PATH", "STALE_STEP"
  ]);
});

test("index rejects gaps and an invalid final next pointer", () => {
  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: [entry(1, "step003")]
  }, { repoRoot, requirePorted: false }));
});
~~~

- [ ] **Step 2: Run and verify the missing validator fails**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND for validate-steps.mjs.

- [ ] **Step 3: Implement the two-phase index contract and validator**

~~~json
{
  "schema_version": 1,
  "steps": [
    {
      "number": 1,
      "id": "step001",
      "title": "\ud558\ub124\uc2a4 \ud504\ub9ac\ud50c\ub77c\uc774\ud2b8 \uccb4\ud06c",
      "phase": "preflight",
      "source": "assets/steps/step001.md",
      "target": "codex/assets/steps/step001.md",
      "source_sha256": "e7fbe24200dee3a8435b87cb16fed16e056be8c75c329bb635adec1df3e31849",
      "ported": false,
      "next": "step002"
    }
  ]
}
~~~

Populate all 50 rows, not just the illustrated row, with reviewed stable title and phase values. Every digest is computed from the real source bytes during this step. validateIndex always requires unique contiguous numbers 1 through 50, canonical IDs/paths, valid titles/phases, real source files and hashes, and exact next pointers. With requirePorted=false it permits target files and remaining port-only metadata to be absent while ported=false. With requirePorted=true it additionally requires every target and all final metadata.

Each final ported entry contains number, id, title, phase, source, target, source_sha256, inputs, outputs, requires, optional_requires, network, visual_review, acceptance, ported=true, and next. Every acceptance item has a unique id, kind=command|artifact|check, required boolean, and a deterministic description; artifact items also declare a workspace-relative path and command items declare the success command or command pattern. Required visual review pairs a screenshot artifact with a check and remains blocked when visual inspection is unavailable. Allowed phases are preflight, tooling, research, planning, implementation, review, and e2e. recordSourceHashes computes SHA-256 from raw source bytes and never copies or overwrites target content.

PORTING.md defines these exact transformations: provider/model names to role language, Claude tool names to actions, .claude paths to approved shared/Codex paths, no transcript completion, no direct next-step chaining, no stale 69/81/84/104/107 references, and no retired validator dependency.

- [ ] **Step 4: Run the mapping validator tests**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: PASS for exact 50-row mapping, source hashes, schema, paths, phases, gaps, forbidden tokens, retired validators, and final next=null while production targets remain explicitly unported.

- [ ] **Step 5: Commit the mapping contract before state code**

~~~powershell
git add -- codex/assets/steps/PORTING.md codex/assets/steps/index.json codex/scripts/validate-steps.mjs codex/tests/steps-validator.test.mjs
git commit -m "test(codex): define step porting contract"
~~~

### Task 3: Implement Paths, Errors, and State Schema

**Files:**
- Create: codex/scripts/lib/errors.mjs
- Create: codex/scripts/lib/paths.mjs
- Create: codex/scripts/lib/schema.mjs
- Create: codex/tests/helpers/workspace.mjs
- Create: codex/tests/paths-schema.test.mjs

**Interfaces:**
- Consumes: explicit cwd or workspace path
- Produces: HarnessError, pathsFor(), assertInside(), createInitialState(), parseState(), validateState(), nextIncompleteStep()

- [ ] **Step 1: Write failing path and schema tests**

~~~js
test("paths stay under the selected workspace", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  assert.equal(paths.codexDir, join(root, "step_archive", ".harness50-codex"));
  assert.throws(() => assertInside(root, resolve(root, "..", "escape")));
});

test("state requires a contiguous prefix and first gap", () => {
  const state = createInitialState({
    workflowId: "wf-1",
    workspaceRoot: "C:/fixture",
    topicSha256: "a".repeat(64),
    now: "2026-09-02T00:00:00.000Z"
  });
  assert.equal(state.total_steps, 50);
  assert.equal(nextIncompleteStep(state), 1);
  assert.throws(() => validateState({ ...state, completed_steps: [1, 3] }));
});
~~~

- [ ] **Step 2: Run the tests and verify missing modules fail**

Run: node --test codex/tests/paths-schema.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement the minimal public APIs**

~~~js
export class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function nextIncompleteStep(state) {
  const completed = new Set(state.completed_steps);
  for (let step = 1; step <= 50; step += 1) {
    if (!completed.has(step)) return step;
  }
  return null;
}
~~~

Implement pathsFor(workspaceRoot) with statePath, receiptsDir, importsDir, eventsPath, lockPath, backupsDir, and importErrorPath. Pure validateState must reject a wrong schema version, total other than 50, non-prefix completion, inconsistent current_step, invalid status, completed unless completed_steps is exactly 1 through 50 with current_step=null, or blocked without blocked_reason. Task 5 reconciliation, which can read the receipt store, separately proves that all 50 receipt files exist before accepting completed state.

workspace.mjs implements makeWorkspace(), hashFile(), and readJson() here. Task 6 extends the same helper with Claude and miniature plugin fixtures; every temporary path is resolved and checked before cleanup.

- [ ] **Step 4: Run the focused tests**

Run: node --test codex/tests/paths-schema.test.mjs

Expected: PASS for containment, initial state, invalid gap, status, and final-state cases.

- [ ] **Step 5: Commit the core value contracts**

~~~powershell
git add -- codex/scripts/lib/errors.mjs codex/scripts/lib/paths.mjs codex/scripts/lib/schema.mjs codex/tests/helpers/workspace.mjs codex/tests/paths-schema.test.mjs
git commit -m "feat(codex): define workspace and state contracts"
~~~

### Task 4: Add Exclusive Locking and Atomic State Storage

**Files:**
- Create: codex/scripts/lib/lock.mjs
- Create: codex/scripts/lib/state-store.mjs
- Create: codex/tests/helpers/child-mutate.mjs
- Create: codex/tests/lock-store.test.mjs

**Interfaces:**
- Consumes: pathsFor(), parseState(), a mutation callback
- Produces: withRunLock(), readState(), writeStateAtomic(), mutateState(), appendEvent(), archiveActiveState()

- [ ] **Step 1: Write failing lock and crash-safety tests**

~~~js
test("only one child process acquires the same lock", async () => {
  const results = await runConcurrentMutators({ count: 4 });
  assert.equal(results.filter(result => result.acquired).length, 1);
});

test("a failed replacement preserves the previous valid state", async () => {
  await writeStateAtomic(root, state1);
  await assert.rejects(() => writeStateAtomic(root, state2, {
    beforeRename: () => { throw new Error("simulated crash"); }
  }));
  assert.deepEqual(await readState(root), state1);
});
~~~

- [ ] **Step 2: Run the tests and confirm failure**

Run: node --test codex/tests/lock-store.test.mjs

Expected: FAIL because lock.mjs and state-store.mjs do not exist.

- [ ] **Step 3: Implement exclusive-create locks and atomic writes**

~~~js
export async function withRunLock(lockPath, fn, {
  waitMs = 5000,
  staleMs = 30000,
  now = () => new Date()
} = {}) {
  const handle = await acquireLock(lockPath, { waitMs, staleMs, now });
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}
~~~

The lock record contains pid, hostname, acquired_at, and a random token. Reclaim only a same-host lock whose process is provably absent and whose age exceeds staleMs. writeStateAtomic writes UTF-8 JSON to a same-directory unique temporary file, flushes the file, renames with bounded Windows retry, and leaves the old state readable on failure.

- [ ] **Step 4: Run lock and storage tests**

Run: node --test codex/tests/lock-store.test.mjs

Expected: PASS for exclusive acquisition, timeout, safe stale reclaim, unsafe reclaim refusal, atomic replacement, and event append.

- [ ] **Step 5: Commit storage primitives**

~~~powershell
git add -- codex/scripts/lib/lock.mjs codex/scripts/lib/state-store.mjs codex/tests/helpers/child-mutate.mjs codex/tests/lock-store.test.mjs
git commit -m "feat(codex): add atomic state storage"
~~~

### Task 5: Add Immutable Receipts and Reconciliation

**Files:**
- Create: codex/scripts/lib/receipts.mjs
- Create: codex/tests/receipts.test.mjs

**Interfaces:**
- Consumes: State, pathsFor(), writeStateAtomic()
- Produces: parseReceipt(), sanitizeEvidence(), readReceipts(), writeReceiptExclusive(), reconcileReceipts()

- [ ] **Step 1: Write failing receipt tests**

~~~js
test("receipt creation is immutable and identical replay is idempotent", async () => {
  await writeReceiptExclusive(root, receipt);
  await writeReceiptExclusive(root, receipt);
  await assert.rejects(
    () => writeReceiptExclusive(root, { ...receipt, summary: "conflict" }),
    error => error.code === "RECEIPT_CONFLICT"
  );
});

test("reconciliation advances only a contiguous receipt prefix", () => {
  const result = reconcileReceipts(initialState, [receiptFor(1), receiptFor(3)]);
  assert.equal(result.state.current_step, 2);
  assert.equal(result.state.status, "blocked");
});

test("receipt evidence cannot persist obvious secret material", () => {
  assert.throws(
    () => sanitizeEvidence([{ acceptance_id: "secret-scan", kind: "check", detail: "OPENAI_API_KEY=secret", ok: true }]),
    error => error.code === "SENSITIVE_EVIDENCE"
  );
});
~~~

- [ ] **Step 2: Verify the tests fail**

Run: node --test codex/tests/receipts.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement receipt validation and recovery**

~~~js
export function receiptPath(workspaceRoot, step) {
  return join(pathsFor(workspaceRoot).receiptsDir, `step${String(step).padStart(3, "0")}.json`);
}

export function reconcileReceipts(state, receipts) {
  const byStep = new Map();
  for (const raw of receipts) {
    const receipt = parseReceipt(raw);
    if (receipt.workflow_id !== state.workflow_id) {
      return blockedReconciliation(state, "RECEIPT_WORKFLOW_MISMATCH");
    }
    const existing = byStep.get(receipt.step);
    if (existing && canonicalJson(existing) !== canonicalJson(receipt)) {
      return blockedReconciliation(state, "RECEIPT_CONFLICT");
    }
    byStep.set(receipt.step, receipt);
  }

  const prefixReceipts = [];
  for (let step = 1; step <= 50 && byStep.has(step); step += 1) {
    prefixReceipts.push(byStep.get(step));
  }
  if ([...byStep.keys()].some(step => step > prefixReceipts.length + 1)) {
    return blockedReconciliation(state, "RECEIPT_GAP");
  }
  if (state.completed_steps.some(step => step > prefixReceipts.length)) {
    return blockedReconciliation(state, "STATE_AHEAD_OF_RECEIPTS");
  }

  const completedSteps = prefixReceipts.map(receipt => receipt.step);
  const recoveredForward = completedSteps.length > state.completed_steps.length;
  const completed = completedSteps.length === 50;
  const nextState = validateState({
    ...state,
    completed_steps: completedSteps,
    current_step: completed ? null : completedSteps.length + 1,
    current_attempt: recoveredForward ? null : state.current_attempt,
    continuation: recoveredForward ? null : state.continuation,
    status: completed ? "completed" : recoveredForward && state.status !== "paused" ? "running" : state.status,
    completed_at: completed ? prefixReceipts.at(-1).completed_at : null
  });
  return { state: nextState, prefix_receipts: prefixReceipts, diagnostics: [] };
}
~~~

blockedReconciliation() returns the same state fields with status=blocked, a stable blocked_reason code, and one diagnostic; canonicalJson() sorts object keys recursively before comparison. Use flag wx for first receipt creation. For an existing file, compare canonical JSON content: identical content returns success; different content raises RECEIPT_CONFLICT. sanitizeEvidence rejects credential/private-key patterns and raw environment assignments before receipt or event persistence. Never infer a receipt from state or transcript.

- [ ] **Step 4: Run receipt tests**

Run: node --test codex/tests/receipts.test.mjs

Expected: PASS for native/import receipts, idempotency, conflict, wrong workflow, gap, and receipt-first recovery.

- [ ] **Step 5: Commit receipt handling**

~~~powershell
git add -- codex/scripts/lib/receipts.mjs codex/tests/receipts.test.mjs
git commit -m "feat(codex): record immutable step receipts"
~~~

### Task 6: Implement Read-Only Claude Progress Import

**Files:**
- Create: codex/scripts/lib/importer.mjs
- Modify: codex/tests/helpers/workspace.mjs
- Create: codex/tests/importer.test.mjs

**Interfaces:**
- Consumes: raw step_archive/progress.json, TOPIC/TOPIC.md, Codex step definitions, state store, receipt store
- Produces: normalizeClaudeProgress(), deriveContiguousPrefix(), importClaudeProgress()

- [ ] **Step 1: Write failing normalization and provenance tests**

~~~js
test("imports only the contiguous historical prefix", async () => {
  const pluginRoot = await makePluginFixture();
  await writeClaudeFixture(root, {
    total_steps: 50,
    current_step: 5,
    completed_steps: [1, "2", 4, 4]
  });
  const before = await hashFile(join(root, "step_archive", "progress.json"));
  const result = await importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory });
  assert.deepEqual(result.state.completed_steps, [1, 2]);
  assert.equal(result.state.current_step, 3);
  assert.match(result.warnings.join("\n"), /sparse|duplicate|current_step/);
  assert.equal(await hashFile(join(root, "step_archive", "progress.json")), before);
  assert.equal((await readReceipts(root))[0].provenance, "claude-progress-import");
});

test("never merges Claude changes after Codex state exists", async () => {
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 2);
  const first = await importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory });
  await writeClaudeCompletedPrefix(root, 4);
  await assert.rejects(
    () => importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory }),
    error => error.code === "CODEX_STATE_EXISTS"
  );
  assert.deepEqual((await readState(root)).completed_steps, first.state.completed_steps);
});
~~~

Also test a UTF-8 BOM, empty prefix, malformed JSON, total_steps=107, out-of-range step 51, missing topic, missing step definition, an existing receipt without state, legacy eval_rounds values 49/69/104, and byte-for-byte import snapshot. makePluginFixture() supplies the isolated 50-step definitions for these unit tests; the real production definitions are exercised after Tasks 11 through 17.

- [ ] **Step 2: Run the importer test**

Run: node --test codex/tests/importer.test.mjs

Expected: FAIL because importer.mjs is missing.

- [ ] **Step 3: Implement the importer**

~~~js
export function deriveContiguousPrefix(values, totalSteps = 50) {
  const normalized = [...new Set(values.map(normalizeStepNumber))].sort((a, b) => a - b);
  const prefix = [];
  for (let expected = 1; expected <= totalSteps; expected += 1) {
    if (!normalized.includes(expected)) break;
    prefix.push(expected);
  }
  return { normalized, prefix };
}
~~~

importClaudeProgress holds withRunLock() for the complete import, and refuses with CODEX_STATE_EXISTS if any valid Codex state or receipt already exists; it never re-merges changed Claude progress. It snapshots raw bytes first, computes SHA-256, validates total_steps=50, preserves unknown Claude fields only in the snapshot, ignores legacy auto-continue files, transcript paths, and eval_rounds 49/69/104 values, creates provenance-only receipts for the prefix, and writes Codex state. Codex step contracts supply the only 38/44/50 milestones.

Each import writes imports/claude-progress-<timestamp>.json plus a metadata file containing source_path, source_sha256, size, source_mtime, imported_at, workflow_id, normalized prefix, and warnings. Invalid source produces import-error.json and no running state. A crash that leaves imports or receipts without state is reported as an incomplete import and requires the recoverable reset path; it is never silently restarted with a new workflow ID.

After durable state creation, append one sanitized claude_imported event containing workflow_id, imported prefix count, and selected_step, but no source content, topic text, or transcript data.

- [ ] **Step 4: Run importer and source-preservation tests**

Run: node --test codex/tests/importer.test.mjs

Expected: PASS, including identical before/after SHA-256 for Claude progress.json.

- [ ] **Step 5: Commit the one-way importer**

~~~powershell
git add -- codex/scripts/lib/importer.mjs codex/tests/helpers/workspace.mjs codex/tests/importer.test.mjs
git commit -m "feat(codex): import Claude progress read-only"
~~~

### Task 7: Implement Ownership and Workflow Transitions

**Files:**
- Create: codex/scripts/lib/ownership.mjs
- Create: codex/scripts/lib/workflow.mjs
- Create: codex/tests/workflow.test.mjs

**Interfaces:**
- Consumes: state schema, lock/store, receipts, importer
- Produces:
  - OWNER_LEASE_MS and claimOwner(), renewOwner(), assertOwner(), ownerLeaseExpired(), transferOwner()
  - issueContinuation() and consumeContinuation()
  - initWorkflow({ workspaceRoot, topic, now, idFactory }): Promise<State>
  - beginStep({ workspaceRoot, step, sessionId, marker, now, idFactory }): Promise<{ state: State, attempt: State["current_attempt"] }>
  - completeStep({ workspaceRoot, pluginRoot, step, attemptId, summary, evidence, now }): Promise<State>
  - failStep({ workspaceRoot, step, attemptId, reason, evidence, now }): Promise<State>
  - pauseWorkflow({ workspaceRoot, reason, now }): Promise<State>
  - resumeWorkflow({ workspaceRoot, sessionId, now, idFactory }): Promise<State>
  - reconcileWorkflow({ workspaceRoot, now }): Promise<State>
  - resetWorkflow({ workspaceRoot, now }): Promise<{ backupPath: string }>
  - showWorkflow({ workspaceRoot }): Promise<object>

- [ ] **Step 1: Write failing state-machine tests**

~~~js
test("complete writes receipt before state and advances one step", async () => {
  const started = await initAndBegin(root);
  const state = await completeStep({
    workspaceRoot: root,
    pluginRoot,
    step: 1,
    attemptId: started.attempt.id,
    summary: "preflight passed",
    evidence: [{ acceptance_id: "state-transition", kind: "check", detail: "tool inventory", ok: true }],
    now
  });
  assert.deepEqual(state.completed_steps, [1]);
  assert.equal(state.current_step, 2);
});

test("three failures block and explicit resume opens a fresh retry window", async () => {
  await failCurrentStepThreeTimes(root);
  assert.equal((await readState(root)).status, "blocked");
  const resumed = await resumeWorkflow({ workspaceRoot: root, sessionId: "s2", now, idFactory });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.consecutive_failures, 0);
});

test("new workflow writes topic but refuses existing shared work", async () => {
  const state = await initWorkflow({ workspaceRoot: root, topic: "안전한 주제", now, idFactory });
  assert.equal(state.topic_path, "step_archive/TOPIC/TOPIC.md");
  await assert.rejects(
    () => initWorkflow({ workspaceRoot: root, topic: "다른 주제", now, idFactory }),
    error => error.code === "WORKFLOW_CONFLICT"
  );
});

test("valid ownership blocks ordinary mutation but explicit resume transfers it", async () => {
  const first = await initAndBegin(root, { sessionId: "s1" });
  const oldMarker = first.marker;
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: "s2", marker: oldMarker, now, idFactory }),
    error => error.code === "OWNER_CONFLICT"
  );
  const transferred = await resumeWorkflow({ workspaceRoot: root, sessionId: "s2", now, idFactory });
  assert.equal(transferred.owner.session_id, "s2");
  assert.notEqual(transferred.continuation.nonce, oldMarker.nonce);
  await assert.rejects(
    () => beginStep({ workspaceRoot: root, step: 1, sessionId: "s1", marker: oldMarker, now, idFactory }),
    error => error.code === "CONTINUATION_REPLAY"
  );
  await assert.rejects(
    () => completeStep({ workspaceRoot: root, pluginRoot, step: 1, attemptId: first.attempt.id, summary: "stale", evidence: [], now }),
    error => error.code === "ATTEMPT_STALE"
  );
});

test("status separates imported history from Codex verification", async () => {
  const status = await showWorkflow({ workspaceRoot: importedRoot });
  assert.deepEqual(status.completions, { imported: 17, codex_verified: 0, total: 17 });
});
~~~

workflow.test.mjs creates fresh root, importedRoot, and pluginRoot fixtures in its setup; initAndBegin() returns the consumed marker and current attempt as well as state. Every test gets a fresh idFactory sequence.

- [ ] **Step 2: Run the workflow test**

Run: node --test codex/tests/workflow.test.mjs

Expected: FAIL with missing ownership/workflow modules.

- [ ] **Step 3: Implement ownership and operations**

~~~js
export function issueContinuation(state, { now, nonce = randomUUID() }) {
  return {
    ...state,
    continuation: {
      workflow_id: state.workflow_id,
      step: state.current_step,
      nonce,
      issued_at: now,
      baseline_receipt_count: state.completed_steps.length
    }
  };
}
~~~

OWNER_LEASE_MS is a documented bounded duration. claimOwner and renewOwner store lease_updated_at; assertOwner uses the injected current time and rejects another session while the lease is live; ownerLeaseExpired handles expiry deterministically. transferOwner is used only by explicit resume, records the transfer event, invalidates the old continuation nonce and current attempt, replaces the owner, and issues a fresh marker. Every successful owned mutation renews the lease.

Every public mutation runs its read/validate/write sequence inside one withRunLock() critical section; completeStep keeps receipt creation and the later atomic state advance under that same lock. showWorkflow is the only lock-free read operation and validates every file it reports.

initWorkflow writes TOPIC/TOPIC.md atomically only when Claude progress, an existing TOPIC, recognized Harness50 outputs, and active Codex state are all absent. beginStep atomically consumes the current nonce and creates current_attempt. completeStep accepts only the current step and attempt, sanitizes structured evidence, writes a receipt before state advance, resets failures, and sets completed only after Step 50 receipt exists. Its pluginRoot parameter must resolve to the installed package root and is reserved for Task 20's step-contract validation. failStep records one failure per attempt. Missing sessionId leaves owner=null and relies on the one-use continuation nonce; it must not invent a shared anonymous owner. showWorkflow derives imported and codex_verified counts from receipt provenance rather than guessing from state; when import-error.json exists without state it reports source_preserved=true plus the diagnostic code and recovery guidance. resetWorkflow archives Codex metadata inside backups/ and never touches Claude progress, TOPIC, outputs, or application files.

Workflow transitions append sanitized continuation_issued, continuation_consumed, continuation_replay_rejected, workflow_paused, workflow_resumed, step_failed, workflow_blocked, and step_completed event kinds as applicable. Event payloads use IDs, step numbers, counts, rule/error codes, and timestamps only; they omit marker nonces, prompts, commands, evidence details, secrets, and transcript content.

- [ ] **Step 4: Run workflow tests**

Run: node --test codex/tests/workflow.test.mjs

Expected: PASS for init conflict, begin replay, one-step advance, pause, owner claim/renew/expiry/transfer, old-token invalidation, imported/native status counts, three failures, reset backup, and Step 50 ordering.

- [ ] **Step 5: Commit workflow behavior**

~~~powershell
git add -- codex/scripts/lib/ownership.mjs codex/scripts/lib/workflow.mjs codex/tests/workflow.test.mjs
git commit -m "feat(codex): add resumable workflow state machine"
~~~

### Task 8: Add the Structured State CLI

**Files:**
- Create: codex/scripts/lib/json-io.mjs
- Create: codex/scripts/harness-state.mjs
- Create: codex/tests/helpers/run-cli.mjs
- Create: codex/tests/cli.test.mjs

**Interfaces:**
- Consumes: workflow operations and JSON stdin
- Produces: process-safe init, show, import-claude, begin, complete, fail, pause, resume, reconcile, reset commands

- [ ] **Step 1: Write failing CLI tests**

~~~js
test("show emits one JSON document and no diagnostic noise", async () => {
  const result = await runCli(["show", "--workspace", root]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    active: false,
    claude_progress_found: false
  });
  assert.equal(result.stderr, "");
});

test("validation failures use stderr and a nonzero code", async () => {
  const result = await runCli(["begin", "--workspace", root, "--step", "51"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /STEP_RANGE/);
});

test("show reports a preserved failed Claude import without activating it", async () => {
  await writeImportErrorFixture(root, { code: "CLAUDE_TOTAL_STEPS", source_preserved: true });
  const result = await runCli(["show", "--workspace", root]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).import_error, {
    code: "CLAUDE_TOTAL_STEPS",
    source_preserved: true,
    action: "repair the Claude state or use a separate workspace"
  });
});
~~~

- [ ] **Step 2: Run CLI tests and verify failure**

Run: node --test codex/tests/cli.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement deterministic CLI dispatch**

~~~js
const COMMANDS = new Set([
  "init", "show", "import-claude", "begin", "complete",
  "fail", "pause", "resume", "reconcile", "reset"
]);

export async function main(argv, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env
} = {}) {
  const { command, flags } = parseArgs(argv, COMMANDS);
  const input = flags.input === "-" ? await readJsonInput(stdin, 1024 * 1024) : null;
  const result = await dispatch(command, flags, input, env);
  stdout.write(JSON.stringify(result) + "\n");
  return 0;
}
~~~

Reject unknown flags and duplicate singleton flags. init accepts { topic } through --input -. complete and fail accept structured summary/evidence through --input -. Tests include spaces, Korean, quotes, dollar signs, and shell metacharacters in topic text without evaluating them.

- [ ] **Step 4: Run CLI tests**

Run: node --test codex/tests/cli.test.mjs

Expected: PASS for every command, JSON size limit, Unicode, invalid flags, and clean stdout/stderr separation.

- [ ] **Step 5: Commit the CLI**

~~~powershell
git add -- codex/scripts/lib/json-io.mjs codex/scripts/harness-state.mjs codex/tests/helpers/run-cli.mjs codex/tests/cli.test.mjs
git commit -m "feat(codex): expose structured workflow CLI"
~~~

### Task 9: Wire Session, Prompt, and Stop Hooks

**Files:**
- Create: codex/scripts/lib/hook-io.mjs
- Create: codex/hooks/session-start.mjs
- Create: codex/hooks/user-prompt-submit.mjs
- Create: codex/hooks/stop.mjs
- Create: codex/hooks/hooks.json
- Create: codex/tests/fixtures/hooks/session-start.json
- Create: codex/tests/fixtures/hooks/session-start-windows.json
- Create: codex/tests/fixtures/hooks/session-start-missing.json
- Create: codex/tests/fixtures/hooks/session-start-completed.json
- Create: codex/tests/fixtures/hooks/user-prompt-direct.json
- Create: codex/tests/fixtures/hooks/stop-running.json
- Create: codex/tests/helpers/run-hook.mjs
- Create: codex/tests/hooks-config.test.mjs
- Create: codex/tests/hooks-lifecycle.test.mjs

**Interfaces:**
- Consumes: documented Codex hook JSON, PLUGIN_ROOT, event cwd, workflow operations
- Produces: synchronous command hooks with resolvable POSIX/Windows paths and one valid JSON hook result; Stop may emit a marked continuation prompt

- [ ] **Step 1: Write failing hook contract tests**

~~~js
test("a direct user prompt pauses automation without blocking the prompt", async () => {
  const { output } = await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "turn-user",
    prompt: "다른 버그를 먼저 봐줘"
  });
  assert.notEqual(output.decision, "block");
  assert.equal((await readState(root)).status, "paused");
});

test("Stop emits exactly one marked follow-up for a progressing workflow", async () => {
  const { output } = await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-1",
    stop_hook_active: false,
    last_assistant_message: "Step 001 complete"
  });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /^\[HARNESS50_CONTINUE /);
});

test("assistant completion prose cannot advance without a receipt", async () => {
  await runHook("stop", {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "turn-prose-only",
    stop_hook_active: false,
    last_assistant_message: "Step 050/50 완료"
  });
  assert.deepEqual((await readState(root)).completed_steps, []);
});

test("hook config resolves only plugin-contained synchronous commands", async () => {
  const config = await readJson("codex/hooks/hooks.json");
  assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  for (const handler of allCommandHandlers(config)) {
    assert.notEqual(handler.async, true);
    assertHookCommandResolvesInsidePlugin(handler.command, posixPluginRoot);
    assertHookCommandResolvesInsidePlugin(handler.commandWindows, windowsPluginRootWithSpaces);
  }
});
~~~

- [ ] **Step 2: Run hook tests and verify failure**

Run: node --test codex/tests/hooks-config.test.mjs codex/tests/hooks-lifecycle.test.mjs

Expected: FAIL because hook files are absent.

- [ ] **Step 3: Implement strict hook IO and handlers**

~~~json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/codex/hooks/session-start.mjs\"",
        "commandWindows": "node \"${PLUGIN_ROOT}/codex/hooks/session-start.mjs\"",
        "timeout": 10
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/codex/hooks/user-prompt-submit.mjs\"",
        "commandWindows": "node \"${PLUGIN_ROOT}/codex/hooks/user-prompt-submit.mjs\"",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/codex/hooks/stop.mjs\"",
        "commandWindows": "node \"${PLUGIN_ROOT}/codex/hooks/stop.mjs\"",
        "timeout": 10
      }]
    }]
  }
}
~~~

hook-io reads at most 1 MiB, requires one JSON object, emits one documented JSON object, and redacts sensitive values from errors. Every handler is synchronous: omit async or set it false. SessionStart is state-read-only, emits concise additionalContext for startup, resume, and compact, and appends only a sanitized session_context_loaded observation event; missing/completed state returns a normal empty result, while corrupt state returns a concise diagnostic without overwriting it. UserPromptSubmit recognizes only the exact stored marker or explicit control skill calls; every other human prompt pauses but is not blocked. Stop reconciles receipts, deduplicates turn_id, compares baseline receipt count, ignores last_assistant_message for completion, uses stop_hook_active for loop safety, records no-progress at most once against the current attempt, and emits decision=block only when a next step is valid.

hooks-config.test.mjs parses hooks.json, expands PLUGIN_ROOT for POSIX and Windows fixture roots (including a path containing spaces), extracts each quoted script argument, and requires it to resolve to the exact expected file under the plugin root. The host smoke test must still execute the commandWindows form because static quoting tests cannot prove the current Codex Windows command runner behavior.

- [ ] **Step 4: Run lifecycle hook tests**

Run: node --test codex/tests/hooks-config.test.mjs codex/tests/hooks-lifecycle.test.mjs

Expected: PASS for exact config paths, synchronous handlers, POSIX/Windows path fixtures, startup, resume, compact, missing/completed/corrupt state, direct prompt, marker, replay, duplicate turn, progress/no-progress Stop, paused, blocked, and completed states.

- [ ] **Step 5: Commit lifecycle hooks**

~~~powershell
git add -- codex/scripts/lib/hook-io.mjs codex/hooks/session-start.mjs codex/hooks/user-prompt-submit.mjs codex/hooks/stop.mjs codex/hooks/hooks.json codex/tests/fixtures/hooks codex/tests/helpers/run-hook.mjs codex/tests/hooks-config.test.mjs codex/tests/hooks-lifecycle.test.mjs
git commit -m "feat(codex): add lifecycle continuation hooks"
~~~

### Task 10: Add the Deny-Only Destructive Guard

**Files:**
- Create: codex/scripts/lib/guard.mjs
- Create: codex/hooks/pre-tool-use.mjs
- Create: codex/tests/fixtures/hooks/pre-tool-use-bash.json
- Create: codex/tests/fixtures/hooks/pre-tool-use-powershell.json
- Create: codex/tests/fixtures/hooks/pre-tool-use-cmd.json
- Create: codex/tests/fixtures/hooks/pre-tool-use-apply-patch.json
- Create: codex/tests/guard.test.mjs
- Modify: codex/hooks/hooks.json
- Modify: codex/tests/hooks-config.test.mjs

**Interfaces:**
- Consumes: PreToolUse event, workspace root, running Harness50 state, sanitized appendEvent()
- Produces: {} for no decision or Codex permissionDecision=deny; never allow

- [ ] **Step 1: Write failing security cases**

~~~js
const mustDeny = [
  "rm -rf /",
  "Remove-Item -Recurse -Force C:/",
  "cmd /c rd /s /q C:\\",
  "git reset --hard",
  "git clean -fdx",
  "git push --force origin main",
  "shutdown /s /t 0"
];

const mustDefer = [
  "npm run build",
  "npx playwright test",
  "Remove-Item -Recurse -Force ./dist",
  "git status"
];

test("guard never approves", async () => {
  for (const command of [...mustDeny, ...mustDefer]) {
    const output = await inspect(command);
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "allow");
  }
});

test("documented shell and patch fixtures cover containment boundaries", async () => {
  for (const name of ["bash", "powershell", "cmd", "apply-patch"]) {
    const event = await readJson(`codex/tests/fixtures/hooks/pre-tool-use-${name}.json`);
    assert.equal((await inspectEvent(event)).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal((await inspect("rm -rf \"./build/../..\"")).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await inspect("Remove-Item -Recurse -Force \"./dist\""), {});
});
~~~

Fixtures use the documented tool_name and tool_input.command shape. POSIX, PowerShell, and cmd.exe command payloads all use Codex's canonical Bash hook alias; apply_patch uses its own alias, so Bash|apply_patch covers the four fixture families. Add separate cases for apply_patch outside-workspace and .git targets, traversal after resolution, quoted paths with spaces, chained commands, encoded PowerShell, malformed input, inactive/no-state workflow, and benign in-workspace cleanup. The installed-host smoke test confirms the current Windows command execution path actually emits the documented Bash alias before claiming guard coverage.

- [ ] **Step 2: Run guard tests and confirm failure**

Run: node --test codex/tests/guard.test.mjs

Expected: FAIL because guard.mjs and pre-tool-use.mjs are absent.

- [ ] **Step 3: Implement conservative classification**

~~~js
export function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}

export function inspectPreToolUse(event, { workspaceRoot, active }) {
  if (!active) return {};
  const candidate = normalizeSupportedToolInput(event);
  if (candidate === null) return {};
  const risk = classifyCandidate(candidate, workspaceRoot);
  return risk.deny ? deny(risk.reason) : {};
}
~~~

Protect filesystem roots, home, workspace root, parents/outside workspace, .git, credentials, keys, shell profiles, and Codex configuration. Reject traversal after path resolution. Do not promise full shell parsing, and do not deny benign in-workspace build cleanup. The hook records only guard_denied or guard_deferred, tool_name, rule ID, and timestamp through appendEvent(); it never stores the raw command, patch, environment, or prompt. Tests feed a secret-bearing command and assert the event log contains none of its secret text.

- [ ] **Step 4: Register PreToolUse and run security tests**

Add this PreToolUse command handler for pre-tool-use.mjs to codex/hooks/hooks.json:

~~~json
{
  "PreToolUse": [{
    "matcher": "Bash|apply_patch",
    "hooks": [{
      "type": "command",
      "command": "node \"${PLUGIN_ROOT}/codex/hooks/pre-tool-use.mjs\"",
      "commandWindows": "node \"${PLUGIN_ROOT}/codex/hooks/pre-tool-use.mjs\"",
      "timeout": 10
    }]
  }]
}
~~~

Then run:

Merge that object into the existing hooks map. Update hooks-config.test.mjs to require the new PreToolUse event, exact Bash|apply_patch matcher, synchronous handler, and plugin-contained POSIX/Windows command paths. The Bash matcher intentionally covers Codex unified exec_command calls under the documented hook aliases.

Run: node --test codex/tests/guard.test.mjs codex/tests/hooks-config.test.mjs codex/tests/hooks-lifecycle.test.mjs

Expected: PASS, exact deny shape for covered risks, {} for benign commands, and no allow decision anywhere.

- [ ] **Step 5: Commit the guard**

~~~powershell
git add -- codex/scripts/lib/guard.mjs codex/hooks/pre-tool-use.mjs codex/hooks/hooks.json codex/tests/fixtures/hooks/pre-tool-use-bash.json codex/tests/fixtures/hooks/pre-tool-use-powershell.json codex/tests/fixtures/hooks/pre-tool-use-cmd.json codex/tests/fixtures/hooks/pre-tool-use-apply-patch.json codex/tests/guard.test.mjs codex/tests/hooks-config.test.mjs
git commit -m "feat(codex): deny destructive harness commands"
~~~

Tasks 11 through 17 all finish each touched index row by setting ported=true and populating the same acceptance object schema defined in Task 2. They may not store bare acceptance strings. Every required item has a stable acceptance id; artifact and command fields are filled where their kinds require them, and each batch test validates those objects before commit. Korean titles in fenced JSON use ASCII `\uXXXX` escapes deliberately so Windows PowerShell 5.1 and UTF-8-aware parsers decode the same exact strings.

### Task 11: Port Steps 001 Through 005

**Files:**
- Create: codex/assets/steps/step001.md through step005.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: assets/steps/step001.md through step005.md and PORTING.md
- Produces: preflight phase entries and Codex-native setup evidence

- [ ] **Step 1: Add a failing expected-range test**

~~~js
await assert.rejects(
  () => validateStepBatch(repoRoot, [1, 2, 3, 4, 5]),
  /missing Codex step/
);
~~~

- [ ] **Step 2: Run the batch test**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL because step001.md through step005.md are missing.

- [ ] **Step 3: Port the five exact titles and contracts**

~~~json
[
  [1, "\ud558\ub124\uc2a4 \ud504\ub9ac\ud50c\ub77c\uc774\ud2b8 \uccb4\ud06c", "preflight"],
  [2, "\ud504\ub85c\uc81d\ud2b8 \ubd84\uc11d \ubc0f Context \uc804\ub7b5 \uc218\ub9bd", "preflight"],
  [3, "Playwright \ud658\uacbd \ud14c\uc2a4\ud2b8", "preflight"],
  [4, "@axe-core/playwright \ud658\uacbd \uc124\uce58", "preflight"],
  [5, "c8 \ucf54\ub4dc \ucee4\ubc84\ub9ac\uc9c0 \ud658\uacbd \uc124\uce58", "preflight"]
]
~~~

Keep topic, tool inventory, context strategy, Playwright, axe, and c8 intent. Replace Claude state initialization with Codex state prerequisites; do not let a step write state directly. Declare step001_preflight.md, step003_playwright_test.md, step004_axe_core_test.md, and step005_c8_test.md outputs where the source requires them. Compute real source hashes with recordSourceHashes for 1:5.

- [ ] **Step 4: Validate the batch**

Run: node codex/scripts/validate-steps.mjs --range 1:5

Expected: PASS 5 indexed steps with no forbidden tokens or unresolved paths.

- [ ] **Step 5: Commit the preflight batch**

~~~powershell
git add -- codex/assets/steps/step001.md codex/assets/steps/step002.md codex/assets/steps/step003.md codex/assets/steps/step004.md codex/assets/steps/step005.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port preflight steps"
~~~

### Task 12: Port Steps 006 Through 015

**Files:**
- Create: codex/assets/steps/step006.md through step015.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: Claude steps 006 through 015
- Produces: tooling phase with explicit required versus optional capability outcomes

- [ ] **Step 1: Add the failing tooling-range test**

~~~js
await validateStepBatch(repoRoot, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
~~~

- [ ] **Step 2: Run and confirm missing-file failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming step006.md as the first missing target.

- [ ] **Step 3: Port the ten tooling steps**

~~~json
[
  [6, "Vitest/Jest \uc720\ub2db \ud14c\uc2a4\ud2b8 \ub7ec\ub108 \ud658\uacbd \uc124\uce58"],
  [7, "\ubc88\ub4e4 \ubd84\uc11d \ub3c4\uad6c \ud658\uacbd \uc124\uce58"],
  [8, "jscpd \ucf54\ub4dc \uc911\ubcf5 \ud0d0\uc9c0 \ud658\uacbd \uc124\uce58"],
  [9, "Semgrep \uc815\uc801 \ubd84\uc11d \ud658\uacbd \uc124\uce58"],
  [10, "knip \ubbf8\uc0ac\uc6a9 \ucf54\ub4dc \ud0d0\uc9c0 \ud658\uacbd \uc124\uce58"],
  [11, "tokei \ucf54\ub4dc \ud1b5\uacc4 \ud658\uacbd \uc124\uce58"],
  [12, "Lighthouse CI \uc6f9 \uc131\ub2a5 \uac10\uc0ac \ud658\uacbd \uc124\uce58"],
  [13, "stylelint CSS \ub9b0\ud305 \ud658\uacbd \uc124\uce58"],
  [14, "Biome \ud3ec\ub9e4\ud305/\ub9b0\ud305 \ud658\uacbd \uc124\uce58"],
  [15, "madge \uc21c\ud658 \uc758\uc874\uc131 \ud0d0\uc9c0 \ud658\uacbd \uc124\uce58"]
]
~~~

Assign phase=tooling. Each capability declares required or optional status and an explicit absent-tool result. Optional absence records skipped evidence; required absence blocks. No tool is reported installed unless its version or smoke command succeeds. Compute source hashes for 6:15.

- [ ] **Step 4: Validate tooling steps**

Run: node codex/scripts/validate-steps.mjs --range 6:15

Expected: PASS 10 steps; every optional capability has a skip reason contract.

- [ ] **Step 5: Commit the tooling batch**

~~~powershell
git add -- codex/assets/steps/step006.md codex/assets/steps/step007.md codex/assets/steps/step008.md codex/assets/steps/step009.md codex/assets/steps/step010.md codex/assets/steps/step011.md codex/assets/steps/step012.md codex/assets/steps/step013.md codex/assets/steps/step014.md codex/assets/steps/step015.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port tooling steps"
~~~

### Task 13: Port Steps 016 Through 024

**Files:**
- Create: codex/assets/steps/step016.md through step024.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: Claude research steps and shared prior artifacts
- Produces: research phase with URLs, raw evidence, cloned references, screenshots, and sufficiency results

- [ ] **Step 1: Add the failing research-range test**

~~~js
await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);
~~~

- [ ] **Step 2: Run and confirm failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming missing step016.md.

- [ ] **Step 3: Port the nine research steps**

~~~json
[
  [16, "\uc804\uccb4 \uc870\uc0ac"],
  [17, "GitHub \uc870\uc0ac"],
  [18, "API \uacc4\uc57d \ubb38\uc11c \uc870\uc0ac"],
  [19, "\ucc38\uace0 \ub808\ud3ec\uc9c0\ud1a0\ub9ac \ud074\ub860 \ubc0f \ucf54\ub4dc \ubd84\uc11d"],
  [20, "Awwwards \uc0ac\uc774\ud2b8 \uc120\uc815"],
  [21, "\uc758\uc874\uc131 \uac8c\uc774\ud2b8 \uac80\uc99d"],
  [22, "Awwwards \ub370\uc774\ud130 \uc218\uc9d1"],
  [23, "Awwwards \ub514\uc790\uc778 \ud328\ud134 \ubd84\uc11d"],
  [24, "Awwwards \uc870\uc0ac \ucda9\ubd84\uc131 \uac80\uc99d"]
]
~~~

Assign phase=research. Replace Haiku fan-out and WebFetch/WebSearch directives with available-agent and web/browser capability language. Preserve URL/source attribution and raw artifact requirements. Step021 must require Step001 receipt/artifact, and Step022 must require Step020 selected-URL output. Mandatory network failure blocks rather than fabricating findings. Compute source hashes for 16:24.

- [ ] **Step 4: Validate research contracts**

Run: node codex/scripts/validate-steps.mjs --range 16:24

Expected: PASS with explicit network policies, resolved prior outputs, and no retired validator dependency.

- [ ] **Step 5: Commit the research batch**

~~~powershell
git add -- codex/assets/steps/step016.md codex/assets/steps/step017.md codex/assets/steps/step018.md codex/assets/steps/step019.md codex/assets/steps/step020.md codex/assets/steps/step021.md codex/assets/steps/step022.md codex/assets/steps/step023.md codex/assets/steps/step024.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port research steps"
~~~

### Task 14: Port Steps 025 Through 030

**Files:**
- Create: codex/assets/steps/step025.md through step030.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: research outputs from Steps 016 through 024
- Produces: planning artifacts and integrated layout/interaction design

- [ ] **Step 1: Add the failing planning-range test**

~~~js
await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30]);
~~~

- [ ] **Step 2: Run and confirm failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming missing step025.md.

- [ ] **Step 3: Port the six planning steps**

~~~json
[
  [25, "\uae30\ud68d: \uc804\uccb4 \uc870\uc0ac\uacb0\uacfc \uae30\ubc18 (\ub3c5\ub9bd \uac80\uc99d \ub8e8\ud504)"],
  [26, "\uae30\ud68d \ubcf4\uac15: GitHub \uc870\uc0ac\uacb0\uacfc"],
  [27, "\uae30\ud68d \ubcf4\uac15: API \uacc4\uc57d \ubb38\uc11c \uc870\uc0ac\uacb0\uacfc"],
  [28, "\uae30\ud68d \ubcf4\uac15: \ucc38\uace0 \ub808\ud3ec \ucf54\ub4dc \ubd84\uc11d"],
  [29, "\uae30\ud68d \ubcf4\uac15: Awwwards UX/UI\u00b7\ub808\uc774\uc544\uc6c3 \uc870\uc0ac\uacb0\uacfc"],
  [30, "\ud1b5\ud569 \uc124\uacc4 (\ub808\uc774\uc544\uc6c3 + \uc804\uccb4)"]
]
~~~

Assign phase=planning. Preserve all required research inputs, persisted decisions, evaluation rounds, topic constraints, accessibility and interaction contracts. Replace named Claude model roles with independent author/reviewer roles that Codex may satisfy through available delegation. Compute source hashes for 25:30.

- [ ] **Step 4: Validate planning steps**

Run: node codex/scripts/validate-steps.mjs --range 25:30

Expected: PASS with every prior research input resolved and each review loop producing a named output.

- [ ] **Step 5: Commit the planning batch**

~~~powershell
git add -- codex/assets/steps/step025.md codex/assets/steps/step026.md codex/assets/steps/step027.md codex/assets/steps/step028.md codex/assets/steps/step029.md codex/assets/steps/step030.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port planning steps"
~~~

### Task 15: Port Steps 031 Through 038

**Files:**
- Create: codex/assets/steps/step031.md through step038.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: integrated design and target project
- Produces: implementation preparation, baselines, application implementation, and first build gate

- [ ] **Step 1: Add the failing implementation-range test**

~~~js
await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38]);
~~~

- [ ] **Step 2: Run and confirm failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming missing step031.md.

- [ ] **Step 3: Port the eight implementation steps**

~~~json
[
  [31, "\ud658\uacbd \uc900\ube44"],
  [32, "\uad6c\ud604 \ud30c\uc77c \uc778\ub371\uc2f1 (tokei)"],
  [33, "jscpd \ucf54\ub4dc \uc911\ubcf5 \ubca0\uc774\uc2a4\ub77c\uc778 \uc218\uc9d1"],
  [34, "knip \ubbf8\uc0ac\uc6a9 \ucf54\ub4dc \ubca0\uc774\uc2a4\ub77c\uc778 \uc218\uc9d1"],
  [35, "\ucee8\ud14d\uc2a4\ud2b8 \uc708\ub3c4\uc6b0 \uc81c\ud55c \ubc29\uc9c0"],
  [36, "\uc778\ucf54\ub529 \uaddc\uce59 (\ubaa8\uc9c0\ubc14\ucf00 \ubc29\uc9c0)"],
  [37, "\uad6c\ud604"],
  [38, "\ube4c\ub4dc \uc2a4\ubaa8\ud06c \ud14c\uc2a4\ud2b8 (\uad6c\ud604 \uc644\ub8cc \uac8c\uc774\ud2b8)"]
]
~~~

Assign phase=implementation. Step037 performs the implementation described by Step030 without model-name routing. Step038 requires a successful build and the first 38-step quality milestone. Optional baseline tools may skip only with recorded reasons; the build gate may not skip. Compute source hashes for 31:38.

- [ ] **Step 4: Validate implementation steps**

Run: node codex/scripts/validate-steps.mjs --range 31:38

Expected: PASS and no step081/legacy build reference.

- [ ] **Step 5: Commit the implementation batch**

~~~powershell
git add -- codex/assets/steps/step031.md codex/assets/steps/step032.md codex/assets/steps/step033.md codex/assets/steps/step034.md codex/assets/steps/step035.md codex/assets/steps/step036.md codex/assets/steps/step037.md codex/assets/steps/step038.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port implementation steps"
~~~

### Task 16: Port Steps 039 Through 044

**Files:**
- Create: codex/assets/steps/step039.md through step044.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: built application and research/design screenshots
- Produces: visual comparison evidence and modularized JS/CSS/HTML

- [ ] **Step 1: Add the failing review-range test**

~~~js
await validateStepBatch(repoRoot, [39, 40, 41, 42, 43, 44]);
~~~

- [ ] **Step 2: Run and confirm failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming missing step039.md.

- [ ] **Step 3: Port the six review steps**

~~~json
[
  [39, "\ub808\uc774\uc544\uc6c3 \uc2a4\ud06c\ub9b0\uc0f7 \uac80\uc99d (\ub3c5\ub9bd \uac80\uc99d \ub8e8\ud504)"],
  [40, "\uc870\uc0ac \uc2a4\ud06c\ub9b0\uc0f7 vs \uad6c\ud604 \uc2a4\ud06c\ub9b0\uc0f7 \ube44\uad50 \uac80\uc99d (\ub3c5\ub9bd \uac80\uc99d \ub8e8\ud504)"],
  [41, "JavaScript \ubaa8\ub4c8\ud654"],
  [42, "CSS \ud30c\uc77c \ubd84\ub9ac (\ucee8\ud14d\uc2a4\ud2b8 \ucd5c\uc801\ud654)"],
  [43, "Awwwards \ub514\uc790\uc778 \uac80\uc99d \ubc0f CSS \ubcf4\uac15 (\ub3c5\ub9bd \uac80\uc99d \ub8e8\ud504)"],
  [44, "HTML \ucef4\ud3ec\ub10c\ud2b8\ud654"]
]
~~~

Assign phase=review. Visual checks require deterministic screenshot paths plus model inspection when image input exists. If visual inspection is unavailable, deterministic DOM/layout/accessibility checks still run but the visual acceptance remains blocked. Remove the Step081 bundler reference and use the current build contract. Step044 is the second quality milestone. Compute source hashes for 39:44.

- [ ] **Step 4: Validate review steps**

Run: node codex/scripts/validate-steps.mjs --range 39:44

Expected: PASS with visual_review=true where required and no stale step reference.

- [ ] **Step 5: Commit the review batch**

~~~powershell
git add -- codex/assets/steps/step039.md codex/assets/steps/step040.md codex/assets/steps/step041.md codex/assets/steps/step042.md codex/assets/steps/step043.md codex/assets/steps/step044.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port review steps"
~~~

### Task 17: Port Steps 045 Through 050

**Files:**
- Create: codex/assets/steps/step045.md through step050.md
- Modify: codex/assets/steps/index.json
- Modify: codex/tests/steps-validator.test.mjs

**Interfaces:**
- Consumes: refactored built application
- Produces: E2E, responsive, keyboard, mouse, visual, console, and final build evidence

- [ ] **Step 1: Add the failing E2E-range test**

~~~js
await validateStepBatch(repoRoot, [45, 46, 47, 48, 49, 50]);
~~~

- [ ] **Step 2: Run and confirm failure**

Run: node --test codex/tests/steps-validator.test.mjs

Expected: FAIL naming missing step045.md.

- [ ] **Step 3: Port the six final steps**

~~~json
[
  [45, "E2E \ud14c\uc2a4\ud2b8"],
  [46, "Playwright \uc2a4\ud06c\ub9b0\uc0f7 \uae30\ubc18 \uc0c1\uc138 E2E \ud14c\uc2a4\ud2b8"],
  [47, "\ud0a4\ubcf4\ub4dc \uc778\ud130\ub799\uc158 \uc2dc\uac01 \uac80\uc99d"],
  [48, "\ub9c8\uc6b0\uc2a4 \uc778\ud130\ub799\uc158 \uc2dc\uac01 \uac80\uc99d"],
  [49, "Playwright \ub514\uc790\uc778 \uc2dc\uac01 \uac80\uc99d (\ub3c5\ub9bd \uac80\uc99d \ub8e8\ud504)"],
  [50, "\ucf58\uc194 \uc5d0\ub7ec \uc218\uc9d1 \ubc0f \ud574\uacb0"]
]
~~~

Assign phase=e2e. Remove legacy step084 and 107-step language. Step050 acceptance uses required object entries with stable ids console-errors-zero and final-build, plus the final quality milestone and durable Step 50 evidence before completed state. Compute source hashes for 45:50.

- [ ] **Step 4: Validate the final batch**

Run: node codex/scripts/validate-steps.mjs --range 45:50

Expected: PASS, with step050 next=null and all final gates explicit.

- [ ] **Step 5: Commit the final step batch**

~~~powershell
git add -- codex/assets/steps/step045.md codex/assets/steps/step046.md codex/assets/steps/step047.md codex/assets/steps/step048.md codex/assets/steps/step049.md codex/assets/steps/step050.md codex/assets/steps/index.json codex/tests/steps-validator.test.mjs
git commit -m "feat(codex): port final validation steps"
~~~

### Task 18: Enforce Full 50-Step Parity and Representative Contracts

**Files:**
- Create: codex/tests/steps-parity.test.mjs
- Modify: codex/scripts/validate-steps.mjs
- Modify: codex/assets/steps/index.json

**Interfaces:**
- Consumes: all Claude and Codex step files and completed index
- Produces: validateRepositoryParity(), full-repository dependency/parity gate, and review-required source hash diagnostics

- [ ] **Step 1: Write failing full-parity tests**

~~~js
test("Claude and Codex expose exactly the same 001 through 050 identities", async () => {
  const report = await validateRepositoryParity(repoRoot);
  assert.equal(report.steps.length, 50);
  assert.deepEqual(report.steps.map(step => step.number), Array.from({ length: 50 }, (_, i) => i + 1));
});

test("source drift requires review and never overwrites a port", async () => {
  const { fixtureRoot, targetTextBefore } = await makeParityFixture({ mutateClaudeStep: 30 });
  await assert.rejects(
    () => validateRepositoryParity(fixtureRoot),
    error => error.code === "SOURCE_CHANGED_REVIEW_REQUIRED"
  );
  assert.equal(await readFile(targetStep(fixtureRoot, 30), "utf8"), targetTextBefore);
});

test("representative dependency and final gates are present", async () => {
  const index = await loadIndex(repoRoot);
  assert.ok(index.steps[20].inputs.includes("step_archive/step001_preflight.md"));
  assert.ok(index.steps[21].inputs.some(path => path.includes("step020")));
  assert.ok(index.steps[49].acceptance.some(item =>
    item.id === "console-errors-zero" && item.kind === "check" && item.required === true));
  assert.ok(index.steps[49].acceptance.some(item =>
    item.id === "final-build" && item.kind === "command" && item.required === true));
});
~~~

- [ ] **Step 2: Run full parity and observe any gaps**

Run: node --test codex/tests/steps-parity.test.mjs

Expected: FAIL because validateRepositoryParity() and its full dependency-closure/source-drift diagnostics do not exist yet.

- [ ] **Step 3: Complete full-index checks without rewriting ported steps**

~~~js
const expected = Array.from({ length: 50 }, (_, index) => index + 1);
assert.deepEqual(entries.map(entry => entry.number), expected);
assert.equal(entries.at(-1).next, null);
~~~

validateRepositoryParity calls validateIndex(..., requirePorted=true), checks every declared input against a prior declared output or approved initial input, verifies unique acceptance IDs and all final fields across the complete graph, and compares current Claude bytes with each recorded source hash. Make hash mismatch return code SOURCE_CHANGED_REVIEW_REQUIRED with source path, expected digest, and actual digest. Do not provide an automatic target overwrite mode.

- [ ] **Step 4: Run all step validation**

Run: node codex/scripts/validate-steps.mjs

Expected: PASS 50/50, zero provider-specific runtime tokens, zero unresolved dependencies, all source hashes current.

Run: node --test codex/tests/steps-validator.test.mjs codex/tests/steps-parity.test.mjs

Expected: PASS.

- [ ] **Step 5: Commit the parity gate**

~~~powershell
git add -- codex/tests/steps-parity.test.mjs codex/scripts/validate-steps.mjs codex/assets/steps/index.json
git commit -m "test(codex): enforce fifty-step parity"
~~~

### Task 19: Add the Three Codex Skills After Step Parity Passes

**Files:**
- Create: codex/skills/webapp/SKILL.md
- Create: codex/skills/harness50-status/SKILL.md
- Create: codex/skills/harness50-reset/SKILL.md
- Modify: codex/tests/package.test.mjs

**Interfaces:**
- Consumes: state CLI, verified 50-step resources, plugin-relative paths, user arguments
- Produces: $webapp, $harness50-status, $harness50-reset workflows

- [ ] **Step 1: Extend package tests for skill discovery and forbidden behavior**

~~~js
const skills = ["webapp", "harness50-status", "harness50-reset"];
for (const name of skills) {
  const text = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
  assert.match(text, new RegExp(`^---[\\s\\S]*name: ${name}[\\s\\S]*---`));
  assert.doesNotMatch(text, /dangerously-bypass|permissionDecision:\s*allow|\/webapp/);
}
~~~

- [ ] **Step 2: Run and verify missing skills fail**

Run: node --test codex/tests/package.test.mjs

Expected: FAIL with ENOENT under codex/skills.

- [ ] **Step 3: Write exact skill control flows**

webapp/SKILL.md must specify:

~~~text
$webapp <topic>:
1. Resolve this installed skill directory and its ../../scripts/harness-state.mjs resource.
2. Initialize without overwriting any existing Claude or Codex workflow.
3. Begin only state.current_step.
4. Read only codex/assets/steps/stepNNN.md for the current step.
5. Complete with structured evidence or fail with a reason.
6. Let the trusted Stop hook request the next single step.

$webapp resume:
1. Resume valid Codex state when present.
2. Otherwise import Claude progress read-only.
3. Report imported historical count separately.

$webapp pause:
1. Persist paused state.
2. Do not emit another continuation.
~~~

status must be read-only, distinguish imported from Codex-verified completions, and surface preserved import errors with repair/separate-workspace guidance. reset must archive only Codex metadata and explicitly report that Claude state and shared outputs were retained. Each skill resolves bundled resources relative to its own SKILL.md; it must not assume PLUGIN_ROOT is available to model-issued shell commands. Package tests require the manifest's skills and hooks paths to become usable only now that the full step parity gate has passed; no local installation occurs before Task 22.

- [ ] **Step 4: Run package, parity, and workflow tests**

Run: node --test codex/tests/package.test.mjs codex/tests/steps-parity.test.mjs codex/tests/cli.test.mjs codex/tests/workflow.test.mjs

Expected: PASS, all 50 referenced step resources exist, and no Claude slash-command or auto-approval language appears in Codex skills.

- [ ] **Step 5: Commit the skills**

~~~powershell
git add -- codex/skills codex/tests/package.test.mjs
git commit -m "feat(codex): add harness control skills"
~~~

### Task 20: Add Acceptance Integration, State Simulation, and Claude Isolation Regression

**Files:**
- Create: codex/scripts/lib/acceptance.mjs
- Modify: codex/scripts/lib/workflow.mjs
- Modify: codex/scripts/harness-state.mjs
- Modify: codex/tests/helpers/workspace.mjs
- Create: codex/tests/representative-steps.test.mjs
- Create: codex/tests/simulation.test.mjs
- Create: codex/tests/claude-regression-copy.ps1
- Create: codex/tests/claude-regression-copy.sh
- Create: .github/workflows/test.yml

**Interfaces:**
- Consumes: full workflow API, importer, hooks, existing Claude tests
- Produces: loadStepContract(), validateCompletionEvidence(), six representative artifact-contract integrations, 50/50 simulation, Claude 17-to-Codex 50 transition, and cross-platform CI

- [ ] **Step 1: Write failing representative acceptance tests**

~~~js
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
    await assert.rejects(
      () => validateCompletionEvidence({ contract, evidence: [], workspaceRoot: fixture.workspaceRoot }),
      error => error.code === "ACCEPTANCE_MISSING"
    );
  });
}

test("library and CLI completion cannot bypass required acceptance", async () => {
  const started = await beginRepresentativeStep({ pluginRoot: repoRoot, step: 1 });
  const before = await readState(started.workspaceRoot);
  await assert.rejects(
    () => completeStep({
      workspaceRoot: started.workspaceRoot,
      pluginRoot: repoRoot,
      step: 1,
      attemptId: started.attempt.id,
      summary: "missing evidence",
      evidence: [],
      now
    }),
    error => error.code === "ACCEPTANCE_MISSING"
  );
  assert.deepEqual(await readState(started.workspaceRoot), before);
  assert.equal((await readReceipts(started.workspaceRoot)).length, 0);

  const cli = await runCli([
    "complete", "--workspace", started.workspaceRoot,
    "--step", "1", "--attempt", started.attempt.id, "--input", "-"
  ], { input: { summary: "still missing", evidence: [] } });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /ACCEPTANCE_MISSING/);
  assert.deepEqual(await readState(started.workspaceRoot), before);
  assert.equal((await readReceipts(started.workspaceRoot)).length, 0);
});
~~~

materializeRepresentativeFixture() creates the exact declared workspace-relative artifacts and executes only safe fixture verification commands. Coverage is concrete: Step 1 tool/preflight evidence, Step 16 sourced research output, Step 30 implementation plan output linked to prior research, Step 38 successful build plus milestone artifact, Step 45 E2E report artifact, and Step 50 zero-console-error plus final-build evidence and receipt-first completion. Each case also removes or corrupts one required artifact/evidence item and proves completion is rejected.

- [ ] **Step 2: Run and verify acceptance integration fails**

Run: node --test codex/tests/representative-steps.test.mjs

Expected: FAIL because acceptance.mjs is missing and workflow completion does not yet enforce the indexed contract.

- [ ] **Step 3: Implement step-contract evidence validation**

~~~js
export async function validateCompletionEvidence({ contract, evidence, workspaceRoot }) {
  const declarations = new Map(contract.acceptance.map(item => [item.id, item]));
  const seen = new Set();
  const canonical = [];
  for (const raw of sanitizeEvidence(evidence)) {
    const declaration = declarations.get(raw.acceptance_id);
    if (!declaration) throw new HarnessError("ACCEPTANCE_UNKNOWN", raw.acceptance_id);
    if (seen.has(raw.acceptance_id)) throw new HarnessError("ACCEPTANCE_DUPLICATE", raw.acceptance_id);
    seen.add(raw.acceptance_id);

    const item = { ...raw };
    if (item.ok && declaration.kind === "artifact") {
      if (item.artifact_path !== declaration.path) {
        throw new HarnessError("ACCEPTANCE_ARTIFACT_PATH", declaration.id);
      }
      const absolute = resolve(workspaceRoot, item.artifact_path);
      assertInside(workspaceRoot, absolute);
      const file = await stat(absolute);
      if (!file.isFile()) throw new HarnessError("ACCEPTANCE_ARTIFACT_MISSING", declaration.id);
      item.artifact_sha256 = await sha256File(absolute);
    }
    if (item.ok && declaration.kind === "command" &&
        (typeof item.command !== "string" || item.command.length === 0 || item.exit_code !== 0)) {
      throw new HarnessError("ACCEPTANCE_COMMAND_FAILED", declaration.id);
    }
    if (item.ok && declaration.kind === "command" && !matchesDeclaredCommand(declaration, item.command)) {
      throw new HarnessError("ACCEPTANCE_COMMAND_MISMATCH", declaration.id);
    }
    if (item.ok && declaration.kind === "check" && item.detail.trim().length === 0) {
      throw new HarnessError("ACCEPTANCE_CHECK_EMPTY", declaration.id);
    }
    canonical.push(item);
  }

  const missingRequired = contract.acceptance
    .filter(item => item.required && !canonical.some(value => value.acceptance_id === item.id && value.ok))
    .map(item => item.id);
  if (missingRequired.length > 0) {
    throw new HarnessError("ACCEPTANCE_MISSING", "Required evidence is missing", { missing: missingRequired });
  }
  return { evidence: canonical, missing_required: [] };
}
~~~

sha256File() streams the file through Node's SHA-256 implementation. matchesDeclaredCommand() uses an exact normalized command or an anchored regular expression stored in the contract; it never executes the evidence text. loadStepContract(pluginRoot, step) loads the completed index, verifies ported=true and the target file, and returns exactly one entry. Native evidence must use unique acceptance_id values declared by that entry. Artifact evidence must match the declared relative path, resolve inside the workspace, exist, and record a SHA-256; command evidence must match its declaration, include a nonempty command, and have integer exit_code=0; check evidence must include a nonempty observation. Required visual review needs both its screenshot artifact and review check. Imported historical receipts remain provenance-only and are not retroactively treated as Codex verification.

Wire validateCompletionEvidence into completeStep before receipt creation. harness-state.mjs derives pluginRoot from its own installed module path and never accepts a caller-supplied plugin root. A failed contract check records no completion receipt and does not advance state.

- [ ] **Step 4: Run the representative tests**

Run: node --test codex/tests/representative-steps.test.mjs codex/tests/workflow.test.mjs codex/tests/cli.test.mjs

Expected: PASS for Steps 1, 16, 30, 38, 45, and 50, including the negative artifact/evidence cases.

- [ ] **Step 5: Add the 50-step and interruption simulations**

~~~js
test("Claude 1 through 17 import continues with Codex 18 through 50", async () => {
  const pluginRoot = await makePluginFixture({ steps: 50 });
  await writeClaudeCompletedPrefix(root, 17);
  let state = (await importClaudeProgress({ workspaceRoot: root, pluginRoot, now, idFactory })).state;
  assert.equal(state.current_step, 18);
  for (let step = 18; step <= 50; step += 1) {
    const started = await beginFromCurrentContinuation(root, step);
    state = await completeStep({
      workspaceRoot: root,
      pluginRoot,
      step,
      attemptId: started.attempt.id,
      summary: `fixture step ${step}`,
      evidence: [{ acceptance_id: "state-transition", kind: "check", detail: "state-only fixture", ok: true }],
      now
    });
    if (step < 50) {
      await runHook("stop", {
        hook_event_name: "Stop",
        cwd: root,
        turn_id: `turn-${step}`,
        stop_hook_active: false,
        last_assistant_message: null
      });
    }
  }
  assert.equal(state.status, "completed");
  assert.equal((await readReceipts(root)).length, 50);
});
~~~

makePluginFixture() declares one required state-transition check per tiny step, keeping this test explicitly state-only. Define beginFromCurrentContinuation() inside simulation.test.mjs by reading state.continuation and calling beginStep with its exact marker. Add a native 1-through-50 state run plus interruption, compact context, application restart, duplicate owner, pause/resume, Stop replay, and receipt/state crash simulations.

Run: node --test codex/tests/simulation.test.mjs

Expected: PASS for both 50/50 paths and all lifecycle interruptions.

- [ ] **Step 6: Add isolated Claude regressions and cross-platform CI**

~~~yaml
name: test

on:
  push:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  codex-and-claude-regressions:
    name: ${{ matrix.os }} / Node 22
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node --test codex/tests
      - if: runner.os == 'Windows'
        shell: powershell
        run: powershell -NoProfile -ExecutionPolicy Bypass -File codex/tests/claude-regression-copy.ps1 -SourceRoot .
      - if: runner.os != 'Windows'
        shell: bash
        run: bash codex/tests/claude-regression-copy.sh .
~~~

Both regression-copy scripts create a unique system-temp directory, resolve it, prove it is a strict child of the system temp root, copy the source without .git, step_archive, node_modules, or ignored hook logs, run the platform's existing tests/security-regression script only in the copy, and delete only that verified copy. The POSIX script uses mktemp -d plus a trap with the same containment assertion. Neither suite executes against the active tree.

- [ ] **Step 7: Run the complete automated suite locally**

Run: node --test codex/tests

Expected: PASS all Codex tests.

Run: powershell -NoProfile -ExecutionPolicy Bypass -File codex/tests/claude-regression-copy.ps1 -SourceRoot .

Expected: PASS and the protected-file hashes in the active worktree remain unchanged. On a POSIX host, also run bash codex/tests/claude-regression-copy.sh . and require PASS.

- [ ] **Step 8: Commit acceptance, simulation, and CI**

~~~powershell
git add -- codex/scripts/lib/acceptance.mjs codex/scripts/lib/workflow.mjs codex/scripts/harness-state.mjs codex/tests/helpers/workspace.mjs codex/tests/representative-steps.test.mjs codex/tests/simulation.test.mjs codex/tests/claude-regression-copy.ps1 codex/tests/claude-regression-copy.sh .github/workflows/test.yml
git commit -m "test: enforce acceptance and simulate cross-platform completion"
~~~

### Task 21: Synchronize Metadata and Document Dual-Host Usage

**Files:**
- Create: codex/README.md
- Modify: README.md
- Modify: .claude-plugin/plugin.json
- Modify: .claude-plugin/marketplace.json
- Modify: .gitattributes
- Modify: codex/tests/package.test.mjs

**Interfaces:**
- Consumes: verified runtime and skills
- Produces: synchronized 2.1.0 metadata, installation guide, explicit safety and migration limitations

- [ ] **Step 1: Add failing metadata and documentation assertions**

~~~js
test("Claude, Codex, and marketplace versions are synchronized", async () => {
  const claude = await readJson(".claude-plugin/plugin.json");
  const codex = await readJson(".codex-plugin/plugin.json");
  const market = await readJson(".claude-plugin/marketplace.json");
  assert.equal(claude.version, "2.1.0");
  assert.equal(codex.version, "2.1.0");
  assert.equal(market.metadata.version, "2.1.0");
  assert.equal(market.plugins[0].version, "2.1.0");
});
~~~

Also assert README contains $webapp resume, one-way import, normal Codex permissions, /hooks trust review, and no claim that Codex has a /webapp command.

- [ ] **Step 2: Run package test and verify version/doc failure**

Run: node --test codex/tests/package.test.mjs

Expected: FAIL because Claude/marketplace are still 2.0.0 and Codex docs are absent.

- [ ] **Step 3: Update metadata and documentation**

~~~text
Claude Code: /webapp <topic>
Codex: $webapp <topic>
Continue Claude work in Codex: $webapp resume
Pause automatic continuation: $webapp pause
Inspect hooks before trust: /hooks
Safety: Codex never auto-approves commands; ordinary commands use normal permissions.
State direction: Claude progress may be imported once; Codex does not write back.
~~~

Update only metadata in the non-dirty .claude-plugin files. Do not edit the protected Claude hook or test files. Add *.mjs text eol=lf to .gitattributes.

- [ ] **Step 4: Run static and full tests**

Run: node --test codex/tests

Expected: PASS.

Run: git diff --check

Expected: no whitespace or line-ending errors in new/modified tracked files.

- [ ] **Step 5: Commit release metadata and docs**

~~~powershell
git add -- codex/README.md README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json .gitattributes codex/tests/package.test.mjs
git commit -m "docs: document Claude and Codex support"
~~~

### Task 22: Install Locally and Run the Trusted-Host Smoke Test

**Files:**
- Create: codex/tests/install-smoke.ps1
- Test: installed plugin cache and a fresh temporary Git workspace
- External local state: existing personal marketplace/config, modified only after inspection and backup

**Interfaces:**
- Consumes: complete local plugin, Codex CLI via codex.cmd, user hook trust action, one native smoke workspace, one import smoke workspace, and the pre-run Claude progress hash
- Produces: locally installed harness50 plugin and a machine-readable preflight or after-trust smoke report

- [ ] **Step 1: Write the non-mutating preflight smoke script**

~~~powershell
param(
  [Parameter(Mandatory = $true)][string]$PluginRoot,
  [ValidateSet("Preflight", "AfterTrust")][string]$Mode = "Preflight",
  [string]$NativeWorkspace,
  [string]$ImportWorkspace,
  [string]$ExpectedClaudeProgressSha256,
  [string]$ReportPath
)

$resolvedPluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $resolvedPluginRoot ".codex-plugin/plugin.json") | ConvertFrom-Json
if ($manifest.name -ne "harness50" -or $manifest.version -ne "2.1.0") {
  throw "Unexpected harness50 manifest"
}
if ($manifest.hooks -ne "./codex/hooks/hooks.json") {
  throw "Codex hook isolation is not configured"
}
~~~

In Preflight mode the script verifies files, versions, exact hook path, synchronous handlers, three skills, and 50 indexed steps. It does not trust hooks, edit Codex config, or install by itself. In AfterTrust mode all four additional arguments are mandatory. It resolves and validates both workspaces, refuses to write ReportPath inside the plugin or either workspace, and writes the report atomically.

- [ ] **Step 2: Run preflight before any profile mutation**

Run: powershell -NoProfile -ExecutionPolicy Bypass -File codex/tests/install-smoke.ps1 -PluginRoot . -Mode Preflight

Expected: PASS package preflight.

- [ ] **Step 3: Inspect, back up, and merge the local marketplace**

Use the plugin-creator workflow for its cachebuster/reinstall path. First resolve the exact personal marketplace and plugin-cache paths, read existing JSON/config, and create a timestamped backup beside the exact file. Merge one harness50 entry pointing to the current plugin root or supported Git source; preserve every unrelated entry. Validate JSON before the host reads it. If merge or install validation fails, restore the backup.

Do not use --dangerously-bypass-hook-trust. Do not overwrite the marketplace wholesale.

- [ ] **Step 4: Verify pending-trust behavior**

Start a fresh Codex session, confirm $webapp, $harness50-status, and $harness50-reset are visible, and open /hooks. Confirm only codex/hooks/hooks.json is proposed and the hook does not run before trust.

Expected: plugin visible; Codex adapter hooks pending explicit trust; Claude auto-approve hook absent.

- [ ] **Step 5: Pause for the user's normal hook review**

Ask the user to review and trust the exact definitions through /hooks. Continue only after that explicit host action. Do not simulate or bypass it.

- [ ] **Step 6: Run the trusted-host scenario**

In a newly created temporary Git repository:

~~~text
$webapp 작은 정적 카운터 튜토리얼
$harness50-status
$webapp pause
$webapp resume
~~~

Before opening the sessions, seed the import workspace's Claude 1-through-17 fixture and compute SHA-256 for its progress.json. In the native workspace, observe one Stop-generated follow-up pass through UserPromptSubmit, pause it, attempt one replay of the captured marker, confirm a covered destructive command is denied, and confirm a benign command is not approved by the hook and remains subject to normal Codex permissions. In the separate import workspace, run $webapp resume, observe that Step 18 is selected, and pause before further work.

The runtime records sanitized event kinds needed for the smoke check without recording prompts, commands, secrets, or transcript content: session_context_loaded, continuation_issued, continuation_consumed, continuation_replay_rejected, workflow_paused, workflow_resumed, guard_denied, guard_deferred, and claude_imported with selected_step. AfterTrust mode requires those native/import events, validates Codex state and receipt provenance, re-hashes progress.json, requires the imported selection to be Step 18, and fails unless the hash is unchanged. Seeing actual lifecycle and guard events from the installed copy is the black-box proof that the user-trusted hooks ran; the script does not read or edit Codex's private trust registry.

Run after the interactive checks:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File codex/tests/install-smoke.ps1 `
  -PluginRoot $installedPluginRoot `
  -Mode AfterTrust `
  -NativeWorkspace $nativeSmokeRoot `
  -ImportWorkspace $importSmokeRoot `
  -ExpectedClaudeProgressSha256 $claudeProgressHash `
  -ReportPath $smokeReportPath
~~~

Expected: PASS only when installed package identity/path checks, trusted lifecycle execution, one-step continuation evidence, pause/resume, replay rejection, destructive denial, benign deferral, Step 18 import selection, provenance, and source preservation all succeed.

- [ ] **Step 7: Save the smoke result and commit only the script**

The script prints the same JSON report it atomically saves to the explicit ReportPath. The report contains mode, timestamp, Codex version, installed plugin root, manifest/version checks, skill and step counts, exact hook source, observed sanitized event booleans, imported/native receipt counts, before/after Claude progress hashes, and overall passed. Do not commit machine-specific paths, hashes, profile data, or the report.

~~~powershell
git add -- codex/tests/install-smoke.ps1
git commit -m "test(codex): add local install smoke check"
~~~

### Task 23: Final Verification and Handoff

**Files:**
- Verify: all files created or modified by Tasks 1 through 22
- Verify: protected user-owned files remain byte-for-byte unchanged
- Verify: no staged unrelated changes

**Interfaces:**
- Consumes: completed implementation and trusted-host report
- Produces: evidence-backed completion report and local commit range ready for user-directed integration

- [ ] **Step 1: Run all Codex tests**

Run: node --test codex/tests

Expected: PASS with zero skipped required tests.

- [ ] **Step 2: Run full step validation**

Run: node codex/scripts/validate-steps.mjs

Expected: PASS 50/50 with current source hashes.

- [ ] **Step 3: Run isolated Claude regressions**

Run: powershell -NoProfile -ExecutionPolicy Bypass -File codex/tests/claude-regression-copy.ps1 -SourceRoot .

Expected: PASS and no active-tree mutation.

Run on POSIX (or require the corresponding Ubuntu CI job): bash codex/tests/claude-regression-copy.sh .

Expected: PASS from the verified temporary copy, with no active-tree mutation.

- [ ] **Step 4: Verify repository hygiene**

Run: git diff --check

Expected: no whitespace errors.

Run: git status --short

Then compare the retained external report against the original worktree, not the clean implementation worktree:

~~~powershell
$protectedReportPath = '<PROTECTED_REPORT_PATH>'
if ($protectedReportPath -eq '<PROTECTED_REPORT_PATH>' -or -not [IO.Path]::IsPathFullyQualified($protectedReportPath)) {
  throw 'Replace PROTECTED_REPORT_PATH with the retained absolute path printed by the pre-execution setup'
}
$baseline = Get-Content -Raw -Encoding UTF8 -LiteralPath $protectedReportPath | ConvertFrom-Json
if ($baseline.schema_version -ne 1 -or @($baseline.entries).Count -ne 16) {
  throw "Invalid protected-file baseline report"
}
$resolvedOriginalRoot = (Resolve-Path -LiteralPath $baseline.original_root).Path
foreach ($entry in $baseline.entries) {
  $resolvedPath = (Resolve-Path -LiteralPath $entry.absolute_path).Path
  if (-not $resolvedPath.StartsWith($resolvedOriginalRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Baseline path escaped original worktree: $($entry.relative_path)"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedPath).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) {
    throw "Protected file changed: $($entry.relative_path)"
  }
}
~~~

Expected: the implementation worktree is clean, the original working tree contains only the user's pre-existing protected modifications, and all 16 original-worktree SHA-256 values match.

Run: git log --oneline 5c0f520..HEAD

Expected: task-scoped local commits only.

- [ ] **Step 5: Verify installed behavior one final time**

Rerun install-smoke.ps1 in Mode AfterTrust with the installed plugin root, both retained smoke workspaces, the original Claude progress SHA-256, and a fresh external ReportPath. Parse the emitted JSON and require passed=true; compare its installed plugin root and hook source with the prior smoke report.

Expected: same-package identity harness50, version 2.1.0, three Codex skills, exact Codex hook path, trusted-hook active behavior, 50-step parity, and successful Claude-to-Codex import.

- [ ] **Step 6: Hand off without pushing**

Report the implementation branch/worktree, commit range, automated test counts, local installation result, hook trust status, protected-file hash result, and any host-only limitation. Do not push or open a pull request without a separate user request.

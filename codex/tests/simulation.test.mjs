import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importClaudeProgress } from "../scripts/lib/importer.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { readReceipts } from "../scripts/lib/receipts.mjs";
import { readState } from "../scripts/lib/state-store.mjs";
import {
  beginStep,
  completeStep,
  initWorkflow,
  resumeWorkflow
} from "../scripts/lib/workflow.mjs";
import { runHook } from "./helpers/run-hook.mjs";
import {
  hashFile,
  makePluginFixture,
  makeWorkspace,
  writeClaudeCompletedPrefix
} from "./helpers/workspace.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const protectedClaudePaths = [
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
];

function ids(prefix) {
  let offset = 0;
  return () => `${prefix}-${++offset}`;
}

function fixtureEvidence(step) {
  return [{
    acceptance_id: "state-transition",
    kind: "check",
    detail: `state-only fixture step ${step}`,
    ok: true
  }];
}

async function beginFromCurrentContinuation(workspaceRoot, step, sessionId = null) {
  const state = await readState(workspaceRoot);
  assert.equal(state.current_step, step);
  assert.notEqual(state.continuation, null);
  return beginStep({
    workspaceRoot,
    step,
    sessionId,
    marker: { ...state.continuation },
    idFactory: ids(`attempt-${step}`)
  });
}

async function events(workspaceRoot) {
  const raw = await readFile(pathsFor(workspaceRoot).eventsPath, "utf8");
  return raw.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

// GitHub Actions runs this test through pwsh -> Node -> powershell.exe. Remove the
// inherited PS7 module path so the isolated Windows PowerShell test child rebuilds
// its own defaults; the protected Claude runtime files remain byte-for-byte intact.
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7
function powershellChildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== "psmodulepath")
  );
}

async function runProcess(executable, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.once("error", reject);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("close", code => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

test("PowerShell child environment omits PSModulePath without mutating the runner environment", () => {
  const runnerEnvironment = {
    Path: "C:\\Windows\\System32",
    PsMoDuLePaTh: "C:\\Program Files\\PowerShell\\Modules",
    HARNESS50_FIXTURE: "preserved"
  };

  assert.deepEqual(powershellChildEnvironment(runnerEnvironment), {
    Path: "C:\\Windows\\System32",
    HARNESS50_FIXTURE: "preserved"
  });
  assert.deepEqual(runnerEnvironment, {
    Path: "C:\\Windows\\System32",
    PsMoDuLePaTh: "C:\\Program Files\\PowerShell\\Modules",
    HARNESS50_FIXTURE: "preserved"
  });
});

test("the state-only fixture gives every one of fifty steps one required check", async () => {
  const pluginRoot = await makePluginFixture();
  const index = JSON.parse(await readFile(`${pluginRoot}/codex/assets/steps/index.json`, "utf8"));
  assert.equal(index.steps.length, 50);
  for (let offset = 0; offset < 50; offset += 1) {
    assert.deepEqual(index.steps[offset].acceptance, [{
      id: "state-transition",
      kind: "check",
      required: true,
      description: "Confirms the isolated fixture state transition."
    }]);
  }
});

test("a native workflow completes exactly fifty Codex-verified receipts", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  let state = await initWorkflow({
    workspaceRoot: root,
    topic: "Native fifty-step simulation",
    idFactory: ids("native-init")
  });
  for (let step = 1; step <= 50; step += 1) {
    const started = await beginFromCurrentContinuation(root, step);
    state = await completeStep({
      workspaceRoot: root,
      pluginRoot,
      step,
      attemptId: started.attempt.id,
      summary: `native fixture step ${step}`,
      evidence: fixtureEvidence(step)
    });
  }

  assert.equal(state.status, "completed");
  assert.equal(state.current_step, null);
  assert.equal(state.completed_steps.length, 50);
  assert.deepEqual(state.completed_steps, Array.from({ length: 50 }, (_, offset) => offset + 1));
  const receipts = await readReceipts(root);
  assert.equal(receipts.length, 50);
  assert.ok(receipts.every(receipt => receipt.provenance === "codex-verified"));
  assert.ok(receipts.every(receipt => receipt.evidence[0].acceptance_id === "state-transition"));
});

test("Claude 1 through 17 import stays read-only and resumes with Codex 18 through 50", async () => {
  const root = await makeWorkspace();
  const pluginRoot = await makePluginFixture();
  await writeClaudeCompletedPrefix(root, 17, { topic: "Claude handoff simulation\n" });
  const progressPath = `${root}/step_archive/progress.json`;
  const topicPath = `${root}/step_archive/TOPIC/TOPIC.md`;
  const progressHash = await hashFile(progressPath);
  const topicHash = await hashFile(topicPath);

  let state = (await importClaudeProgress({
    workspaceRoot: root,
    pluginRoot,
    idFactory: ids("import")
  })).state;
  assert.equal(state.current_step, 18);
  assert.equal(state.continuation, null);
  assert.equal(await hashFile(progressPath), progressHash);
  assert.equal(await hashFile(topicPath), topicHash);

  state = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "handoff-session",
    idFactory: ids("handoff-resume")
  });
  assert.equal(state.current_step, 18);
  assert.notEqual(state.continuation, null);
  for (let step = 18; step <= 50; step += 1) {
    const started = await beginFromCurrentContinuation(root, step, "handoff-session");
    state = await completeStep({
      workspaceRoot: root,
      pluginRoot,
      step,
      attemptId: started.attempt.id,
      summary: `handoff fixture step ${step}`,
      evidence: fixtureEvidence(step)
    });
  }

  assert.equal(state.status, "completed");
  assert.equal(state.current_step, null);
  assert.equal(await hashFile(progressPath), progressHash);
  assert.equal(await hashFile(topicPath), topicHash);
  const receipts = await readReceipts(root);
  assert.equal(receipts.length, 50);
  assert.equal(receipts.filter(receipt => receipt.provenance === "claude-progress-import").length, 17);
  assert.equal(receipts.filter(receipt => receipt.provenance === "codex-verified").length, 33);
});

test("separate hook processes survive startup compact replay stale Stop pause and resume", async () => {
  const root = await makeWorkspace();
  const initialized = await initWorkflow({
    workspaceRoot: root,
    topic: "Lifecycle restart simulation",
    idFactory: ids("hook-init")
  });

  for (const source of ["startup", "resume", "compact"]) {
    const session = await runHook("session-start", {
      hook_event_name: "SessionStart",
      cwd: root,
      source
    });
    assert.equal(session.code, 0);
    assert.match(session.output.hookSpecificOutput.additionalContext, /Next: Step 001/);
  }

  const stopEvent = {
    hook_event_name: "Stop",
    cwd: root,
    turn_id: "simulation-old-stop",
    stop_hook_active: false,
    last_assistant_message: null
  };
  const firstStop = await runHook("stop", stopEvent);
  assert.equal(firstStop.output.decision, "block");
  assert.equal((firstStop.output.reason.match(/\[HARNESS50_CONTINUE /g) ?? []).length, 1);
  const eventsAfterFirst = await events(root);
  const replay = await runHook("stop", stopEvent);
  assert.deepEqual(replay.output, firstStop.output);
  assert.deepEqual(await events(root), eventsAfterFirst);

  const accepted = await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "simulation-marker-submit",
    prompt: firstStop.output.reason
  });
  assert.deepEqual(accepted.output, {});
  const started = await beginStep({
    workspaceRoot: root,
    step: 1,
    sessionId: "simulation-session",
    marker: (await readState(root)).continuation,
    idFactory: ids("simulation-attempt")
  });

  const beforeStale = await readState(root);
  assert.deepEqual((await runHook("stop", stopEvent)).output, {});
  assert.deepEqual(await readState(root), beforeStale);
  assert.equal(started.attempt.failure_recorded, false);

  const ordinary = await runHook("user-prompt-submit", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    turn_id: "simulation-human-prompt",
    prompt: "pause and inspect this application"
  });
  assert.deepEqual(ordinary.output, {});
  assert.equal((await readState(root)).status, "paused");
  const pausedStop = await runHook("stop", {
    ...stopEvent,
    turn_id: "simulation-paused-stop"
  });
  assert.deepEqual(pausedStop.output, {});

  const resumed = await resumeWorkflow({
    workspaceRoot: root,
    sessionId: "simulation-session-restarted",
    idFactory: ids("simulation-resume")
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.current_step, initialized.current_step);
  assert.equal(resumed.current_attempt, null);
  assert.notEqual(resumed.continuation, null);
  const beforeDuplicateOwner = await readState(root);
  await assert.rejects(
    () => beginStep({
      workspaceRoot: root,
      step: 1,
      sessionId: "duplicate-owner",
      marker: resumed.continuation,
      idFactory: ids("duplicate-owner-attempt")
    }),
    error => error.code === "OWNER_CONFLICT"
  );
  assert.deepEqual(await readState(root), beforeDuplicateOwner);
  const restarted = await runHook("session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
    source: "resume"
  });
  assert.match(restarted.output.hookSpecificOutput.additionalContext, /Next: Step 001/);
});

test("the platform Claude regression wrapper runs only in an isolated copy", async () => {
  const before = Object.fromEntries(await Promise.all(protectedClaudePaths.map(async path => [
    path,
    await hashFile(join(repoRoot, ...path.split("/")))
  ])));
  const result = process.platform === "win32"
    ? await runProcess("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", join(repoRoot, "codex", "tests", "claude-regression-copy.ps1"),
        "-SourceRoot", repoRoot
      ], powershellChildEnvironment(process.env))
    : await runProcess("bash", [
        join(repoRoot, "codex", "tests", "claude-regression-copy.sh"),
        repoRoot
      ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CLAUDE_REGRESSION_COPY_OK/);
  const after = Object.fromEntries(await Promise.all(protectedClaudePaths.map(async path => [
    path,
    await hashFile(join(repoRoot, ...path.split("/")))
  ])));
  assert.deepEqual(after, before);
});

test("the Windows wrapper executes a BOM-normalized copy and preserves the protected staged script", {
  skip: process.platform !== "win32"
}, async () => {
  const fixtureRoot = await makeWorkspace();
  for (const relativePath of protectedClaudePaths) {
    const path = join(fixtureRoot, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    if (relativePath !== "tests/security-regression.ps1") {
      await writeFile(path, `fixture for ${relativePath}\n`, "utf8");
    }
  }

  const protectedRegression = join(fixtureRoot, "tests", "security-regression.ps1");
  await writeFile(protectedRegression, [
    '$ErrorActionPreference = "Stop"',
    '$runningPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)',
    '$protectedPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "security-regression.ps1"))',
    'if ([string]::Equals($runningPath, $protectedPath, [System.StringComparison]::OrdinalIgnoreCase)) { throw "PROTECTED_SCRIPT_EXECUTED" }',
    '$runningBytes = [System.IO.File]::ReadAllBytes($runningPath)',
    '$protectedBytes = [System.IO.File]::ReadAllBytes($protectedPath)',
    'if ($runningBytes.Length -ne ($protectedBytes.Length + 3)) { throw "EXECUTION_COPY_LENGTH" }',
    'if ($runningBytes[0] -ne 0xEF -or $runningBytes[1] -ne 0xBB -or $runningBytes[2] -ne 0xBF) { throw "EXECUTION_COPY_BOM" }',
    'for ($index = 0; $index -lt $protectedBytes.Length; $index++) {',
    '  if ($runningBytes[$index + 3] -ne $protectedBytes[$index]) { throw "PROTECTED_COPY_BYTES" }',
    '}',
    "if ([int][char]'한' -ne 0xD55C) { throw \"UTF8_DECODE\" }",
    'Write-Output "UTF8_EXECUTION_COPY_OK"',
    ''
  ].join("\n"), "utf8");
  const before = await readFile(protectedRegression);
  assert.notDeepEqual([...before.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);

  const result = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", join(repoRoot, "codex", "tests", "claude-regression-copy.ps1"),
    "-SourceRoot", fixtureRoot
  ], powershellChildEnvironment(process.env));

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /UTF8_EXECUTION_COPY_OK/);
  assert.match(result.stdout, /CLAUDE_REGRESSION_COPY_OK/);
  assert.deepEqual(await readFile(protectedRegression), before);
});

test("the POSIX regression wrapper rejects copied aliases and verifies the active tree during cleanup", async () => {
  const script = await readFile(
    join(repoRoot, "codex", "tests", "claude-regression-copy.sh"),
    "utf8"
  );
  assert.match(script, /find "\$stage_real" -type l -print -quit/);
  const cleanup = /cleanup\(\) \{(?<body>[\s\S]*?)\n\}/.exec(script)?.groups?.body ?? "";
  assert.match(cleanup, /verify_active_tree/);
});

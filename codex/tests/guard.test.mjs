import test from "node:test";
import assert from "node:assert/strict";
import {
  link,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { handlePreToolUse } from "../hooks/pre-tool-use.mjs";
import { inspectPreToolUse } from "../scripts/lib/guard.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { EVENT_LOG_LIMIT, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import { initWorkflow } from "../scripts/lib/workflow.mjs";
import { runHook } from "./helpers/run-hook.mjs";
import { makeDirectoryLink, makeWorkspace, readJson } from "./helpers/workspace.mjs";

const now = "2026-09-02T00:00:00.000Z";
const fixtureRoot = new URL("./fixtures/hooks/", import.meta.url);
const expectedDeny = ruleId => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `Harness50 blocked this operation (rule: ${ruleId}).`
  }
});

function ids(prefix = "guard") {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function eventFor(command, toolName = "Bash") {
  return {
    hook_event_name: "PreToolUse",
    cwd: "ignored-by-direct-inspection",
    session_id: "guard-session",
    transcript_path: null,
    permission_mode: "default",
    model: "gpt-5.6-codex",
    turn_id: "guard-turn",
    tool_name: toolName,
    tool_use_id: "guard-tool-use",
    tool_input: { command }
  };
}

async function inspect(command, { workspaceRoot, active = true } = {}) {
  return inspectPreToolUse(eventFor(command), {
    workspaceRoot: workspaceRoot ?? process.cwd(),
    active
  });
}

async function inspectPatch(command, { workspaceRoot, active = true } = {}) {
  return inspectPreToolUse(eventFor(command, "apply_patch"), {
    workspaceRoot: workspaceRoot ?? process.cwd(),
    active
  });
}

async function init(root, prefix = "guard") {
  return initWorkflow({
    workspaceRoot: root,
    topic: "Guard fixture",
    now,
    idFactory: ids(prefix)
  });
}

async function events(root) {
  const raw = await readFile(pathsFor(root).eventsPath, "utf8").catch(error => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map(line => JSON.parse(line));
}

async function fixture(name, root) {
  const value = await readJson(new URL(name, fixtureRoot));
  value.cwd = root;
  return value;
}

test("guard denies destructive commands but never approves benign commands", async () => {
  const root = await makeWorkspace();
  const mustDeny = [
    ["rm -rf /", "protected-root"],
    ["Remove-Item -Recurse -Force C:/", "protected-root"],
    ["cmd /c rd /s /q C:\\", "protected-root"],
    ["git reset --hard", "git-destructive"],
    ["git clean -fdx", "git-destructive"],
    ["git push --force origin main", "git-destructive"],
    ["shutdown /s /t 0", "system-destructive"]
  ];
  for (const [command, rule] of mustDeny) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
  for (const command of [
    "npm run build",
    "npx playwright test",
    "Remove-Item -Recurse -Force ./dist",
    "rm -rf ./dist",
    "git status"
  ]) {
    const output = await inspect(command, { workspaceRoot: root });
    assert.deepEqual(output, {}, command);
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "allow");
  }
});

test("canonical shell and patch fixtures use exact fields and deny containment breaches", async () => {
  const root = await makeWorkspace();
  const required = [
    "hook_event_name", "cwd", "session_id", "transcript_path", "permission_mode",
    "model", "turn_id", "tool_name", "tool_use_id", "tool_input"
  ].sort();
  for (const name of ["bash", "powershell", "cmd", "apply-patch"]) {
    const event = await fixture(`pre-tool-use-${name}.json`, root);
    assert.deepEqual(Object.keys(event).sort(), required);
    assert.ok(event.tool_name === "Bash" || event.tool_name === "apply_patch");
    assert.equal(typeof event.tool_input.command, "string");
    assert.equal((await inspectPreToolUse(event, { workspaceRoot: root, active: true }))
      .hookSpecificOutput.permissionDecision, "deny");
  }
  assert.deepEqual(
    await inspect("rm -rf \"./build/../..\"", { workspaceRoot: root }),
    expectedDeny("protected-root")
  );
});

test("rule precedence is stable and supported malformed inputs fail closed", async () => {
  const root = await makeWorkspace();
  const cases = [
    [{ ...eventFor("ignored"), tool_input: {} }, "malformed-input"],
    [{ ...eventFor("ignored"), tool_input: { command: "   " } }, "malformed-input"],
    [{ ...eventFor("ignored"), tool_input: null }, "malformed-input"],
    [eventFor("pwsh -EncodedCommand UwBodQB0AGQAbwB3AG4AIAAvAHMA"), "encoded-command"],
    [eventFor("shutdown /s /t 0 && git reset --hard"), "system-destructive"],
    [eventFor("git reset --hard && rm -rf /"), "git-destructive"],
    [eventFor("rm -rf .git && rm -rf /"), "protected-root"],
    [eventFor("rm -rf .git"), "sensitive-path"],
    [eventFor("rm -rf $TARGET"), "dynamic-target"],
    [eventFor("echo ok"), "no-match"]
  ];
  for (const [event, rule] of cases) {
    const output = await inspectPreToolUse(event, { workspaceRoot: root, active: true });
    assert.deepEqual(output, rule === "no-match" ? {} : expectedDeny(rule), rule);
  }
  assert.deepEqual(
    await inspectPreToolUse({ ...eventFor("echo ok"), tool_name: "OtherTool", tool_input: 7 }, {
      workspaceRoot: root,
      active: true
    }),
    {}
  );
});

test("nested, chained, and encoded shell forms cannot hide destructive operations", async () => {
  const root = await makeWorkspace();
  const cases = [
    ["echo safe && rm -rf /", "protected-root"],
    ["printf safe; bash -c 'rm -rf /'", "protected-root"],
    ["sh -c \"git clean -fdx\"", "git-destructive"],
    ["cmd.exe /d /c \"echo safe & rd /s /q C:/\"", "protected-root"],
    ["powershell.exe -NoLogo -Command \"Remove-Item -LiteralPath '$HOME' -Recurse\"", "dynamic-target"],
    ["pwsh -enc ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["powershell -EncodedCommand ZQBjAGgAbwAgAG8AawA=", "encoded-command"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
});

test("bounded shell wrappers and grouping preserve destructive target semantics", async () => {
  const root = await makeWorkspace();
  const cases = [
    ["bash -lc 'rm -rf /'", "protected-root"],
    ["(rm -rf /)", "protected-root"],
    ["{ rm -rf /; }", "protected-root"],
    ["cmd /c \"(rd /s /q C:\\\\)\"", "protected-root"],
    ["sudo -u root rm -rf /", "protected-root"],
    ["pwsh -Command \"& { Remove-Item -Recurse -Force C:/ }\"", "protected-root"],
    ["rm -rf \"$1\"", "dynamic-target"],
    ["cmd /c \"rd /s /q !TARGET!\"", "dynamic-target"],
    ["PoWeRsHeLl -e ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["pwsh -EncodedCommand:ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["pwsh -EncodedCommand=ZQBjAGgAbwAgAG8AawA=", "encoded-command"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
  for (const command of [
    "(rm -rf \"./dist (cached)\")",
    "cmd /c \"(rd /s /q ./dist)\""
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), {}, command);
  }
});

test("PowerShell and cmd attached switch forms retain their nested command", async () => {
  const root = await makeWorkspace();
  const windowsRoot = "C:\\";
  const cases = [
    ["powershell.exe /EncodedCommand ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["pwsh /ENCODEDCOMMAND:ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["PowerShell -Ec=ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["powershell.exe /Command \"Remove-Item -Recurse -Force C:/\"", "protected-root"],
    ["pwsh -co \"Remove-Item -Recurse -Force C:/\"", "protected-root"],
    [`cmd.exe /Crd /s /q ${windowsRoot}`, "protected-root"],
    [`cmd.exe /c\"rd /s /q ${windowsRoot}\"`, "protected-root"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
  for (const command of [
    "powershell -ErrorAction Stop -Command \"Write-Output ok\"",
    "pwsh -ErrorVariable captured -Command \"Write-Output ok\""
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), {}, command);
  }
});

test("escaped executable names, assignments, and execution wrappers cannot hide destructive commands", async () => {
  const root = await makeWorkspace();
  const cases = [
    ["r\\m -rf /", "protected-root"],
    ["g\\it reset --hard", "git-destructive"],
    ["shut\\down /s /t 0", "system-destructive"],
    ["r^d /s /q C:/", "protected-root"],
    ["Remove-`Item -Recurse -Force C:/", "protected-root"],
    ["FOO=bar rm -rf /", "protected-root"],
    ["sudo FOO=bar rm -rf /", "protected-root"],
    ["exec rm -rf /", "protected-root"],
    ["builtin rm -rf /", "protected-root"],
    ["env -u NAME rm -rf /", "protected-root"],
    ["exec -a custom rm -rf /", "protected-root"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
  assert.deepEqual(
    await inspect("C:\\Windows\\System32\\cmd.exe /c \"echo ok\"", { workspaceRoot: root }),
    {}
  );
  assert.deepEqual(await inspect("env -u NAME npm test", { workspaceRoot: root }), {});
});

test("dynamic substitutions and implicit pipeline targets fail closed without blocking explicit safe paths", async () => {
  const root = await makeWorkspace();
  for (const command of [
    "rm -rf $(printf /)",
    "Remove-Item -Recurse -Force $(Get-Location)",
    "Remove-Item -Recurse -Force @targets",
    "'C:/' | Remove-Item -Recurse -Force",
    "Write-Output C:/ | Remove-Item -Recurse -Force",
    "Write-Output C:/ | (Remove-Item -Recurse -Force)",
    "rm -rf ./build/{one,two}"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("dynamic-target"), command);
  }
  for (const command of [
    "Write-Output value | Set-Content -Path ./notes.txt",
    "Write-Output '$HOME' | Set-Content -LiteralPath './notes with spaces.txt'",
    "(rm -rf \"./dist (cached)\")"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), {}, command);
  }
});

test("nested command substitutions and cmd call wrappers cannot hide destructive invocations", async context => {
  const root = await makeWorkspace();
  const cases = [
    ["echo $(rm -rf /)", "protected-root"],
    ["X=$(rm -rf /)", "protected-root"],
    ["echo `rm -rf /`", "protected-root"],
    ["echo \"$(git reset --hard)\"", "git-destructive"],
    ["RESULT=`git clean -fdx`", "git-destructive"],
    ["cmd /c call rd /s /q C:/", "protected-root"]
  ];
  for (const [command, rule] of cases) {
    await context.test(command, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule));
    });
  }
  for (const command of [
    "echo '$(rm -rf /)'",
    "echo '`rm -rf /`'",
    "echo \"$(printf safe)\"",
    "cmd /c call echo ok"
  ]) {
    await context.test(`safe: ${command}`, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), {});
    });
  }
});

test("ANSI-C quotes and escaped or globbed metadata targets retain shell semantics", async context => {
  const root = await makeWorkspace();
  const cases = [
    ["rm -rf $'/'", "protected-root"],
    ["rm -rf $'\\x2f'", "protected-root"],
    ["rm -rf $'\\057'", "protected-root"],
    ["rm -rf .g\\it", "sensitive-path"],
    ["rm -rf .G\\IT/config", "sensitive-path"],
    ["rm -rf .g^it/config", "sensitive-path"],
    ["rm -rf .g[i]t", "dynamic-target"],
    ["rm -rf .g?t", "dynamic-target"],
    ["FOO=bar rm -rf $TARGET", "dynamic-target"],
    ["FOO=bar rm -rf .g[i]t", "dynamic-target"],
    ["sudo rm -rf $TARGET", "dynamic-target"]
  ];
  for (const [command, rule] of cases) {
    await context.test(command, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule));
    });
  }
  for (const command of [
    "rm -rf '$HOME'",
    "rm -rf '.g[i]t'",
    "rm -rf \"./dist [cached]\"",
    "FOO=bar rm -rf '$TARGET'",
    "sudo rm -rf '$HOME'",
    "exec rm -rf '.g[i]t'"
  ]) {
    await context.test(`safe: ${command}`, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), {});
    });
  }
});

test("git worktree replacement and force variants deny without treating ordinary branch switches as path checkout", async () => {
  const root = await makeWorkspace();
  for (const command of [
    "git restore .",
    "git restore README.md",
    "git checkout HEAD README.md",
    "git checkout .",
    "git checkout -f feature",
    "git checkout --force feature",
    "git checkout --pathspec-from-file paths.txt",
    "git checkout --pathspec-from-file=paths.txt",
    "git checkout -B branch",
    "git push -fu origin main",
    "git push -uf origin main",
    "git branch -D obsolete",
    "git switch -f main",
    "git switch --force main",
    "git switch --discard-changes main"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("git-destructive"), command);
  }
  for (const command of [
    "git status",
    "git checkout feature",
    "git checkout -b feature",
    "git switch feature"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), {}, command);
  }
});

test("git force-ref forms and existing extensionless checkout paths cannot replace data", async context => {
  const root = await makeWorkspace();
  const missingRoot = await makeWorkspace();
  await writeFile(join(root, "Makefile"), "all:\n\t@true\n");
  await writeFile(join(root, "LICENSE"), "test license\n");
  await writeFile(join(root, "release-notes"), "tracked extensionless file\n");
  for (const command of [
    "git branch -f main HEAD~1",
    "git branch --force main HEAD~1",
    "git switch -C main HEAD~1",
    "git switch -Cmain HEAD~1",
    "git switch --force-create main HEAD~1",
    "git switch --force-create=main HEAD~1",
    "git checkout Makefile",
    "git checkout LICENSE",
    "git checkout release-notes"
  ]) {
    await context.test(command, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("git-destructive"));
    });
  }
  for (const command of ["git checkout Makefile", "git checkout LICENSE"]) {
    await context.test(`missing worktree entry: ${command}`, async () => {
      assert.deepEqual(
        await inspect(command, { workspaceRoot: missingRoot }),
        expectedDeny("git-destructive")
      );
    });
  }
  for (const command of [
    "git branch feature",
    "git branch --list",
    "git branch -d merged-feature",
    "git switch -c feature",
    "git switch feature",
    "git checkout -b feature",
    "git checkout feature"
  ]) {
    await context.test(`safe: ${command}`, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), {});
    });
  }
});

test("PowerShell content data is not classified as a path while explicit targets remain protected", async () => {
  const root = await makeWorkspace();
  for (const command of [
    "Add-Content -Path ./notes.txt -Value *",
    "Set-Content -Path ./notes.txt -Value $HOME",
    "Set-Content -LiteralPath './notes with spaces.txt' -Value '@targets'"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), {}, command);
  }
  const cases = [
    ["Set-Content -Path .git/config -Value x", "sensitive-path"],
    ["Add-Content -Path C:/danger.txt -Value x", "protected-root"],
    ["Remove-Item -LiteralPath .git/config -Force", "sensitive-path"],
    ["Copy-Item ./safe.txt .git/config", "sensitive-path"],
    ["Move-Item ./safe.txt ../outside.txt", "protected-root"],
    ["Rename-Item ./safe.txt .git/config", "sensitive-path"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
});

test("PowerShell write aliases resolve paths without treating executable tools or values as targets", async context => {
  const root = await makeWorkspace();
  const cases = [
    ["sc .git/config x", "sensitive-path"],
    ["ac .git/config x", "sensitive-path"],
    ["clc .git/config", "sensitive-path"],
    ["cpi ./safe .git/config", "sensitive-path"],
    ["mi ./safe .git/config", "sensitive-path"],
    ["rni ./safe .git/config", "sensitive-path"],
    ["Write-Output x | Tee-Object -FilePath .git/config", "sensitive-path"],
    ["New-Item -Path .git/config -ItemType File", "sensitive-path"],
    ["SC -Path:.GIT/config -Value x", "sensitive-path"],
    ["a\\c -LiteralPath .git/config -Value x", "sensitive-path"],
    ["tee -FilePath:.git/config", "sensitive-path"],
    ["ni .git/config -ItemType File", "sensitive-path"]
  ];
  for (const [command, rule] of cases) {
    await context.test(command, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule));
    });
  }
  for (const command of [
    "sc.exe query",
    "C:\\Windows\\System32\\sc.exe query",
    "sc ./notes.txt '$HOME'",
    "ac -Path ./notes.txt -Value *",
    "cpi ./safe ./copy",
    "Write-Output x | Tee-Object -FilePath ./notes.txt",
    "New-Item -Path ./scratch -ItemType Directory"
  ]) {
    await context.test(`safe: ${command}`, async () => {
      assert.deepEqual(await inspect(command, { workspaceRoot: root }), {});
    });
  }
});

test("new guard parser branches publish their exact active wire rule IDs", async () => {
  const root = await makeWorkspace();
  await init(root, "parser-wire");
  const cases = [
    ["powershell /EncodedCommand ZQBjAGgAbwAgAG8AawA=", "encoded-command"],
    ["cmd /Crd /s /q C:/", "protected-root"],
    ["rm -rf $(printf /)", "dynamic-target"],
    ["git restore README.md", "git-destructive"],
    ["Set-Content -Path .git/config -Value x", "sensitive-path"],
    ["echo $(rm -rf /)", "protected-root"],
    ["rm -rf .g[i]t", "dynamic-target"],
    ["git switch -C main HEAD~1", "git-destructive"],
    ["sc .git/config x", "sensitive-path"]
  ];
  for (const [index, [command, rule]] of cases.entries()) {
    const result = await runHook("pre-tool-use", {
      hook_event_name: "PreToolUse",
      cwd: root,
      turn_id: `parser-wire-turn-${index}`,
      tool_name: "Bash",
      tool_use_id: `parser-wire-tool-${index}`,
      tool_input: { command }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${JSON.stringify(expectedDeny(rule))}\n`);
    assert.deepEqual(result.output, expectedDeny(rule));
  }
  const tail = (await events(root)).slice(-cases.length);
  assert.deepEqual(tail.map(event => ({
    kind: event.kind,
    tool_name: event.tool_name,
    rule_id: event.rule_id
  })), cases.map(([, rule]) => ({
    kind: "guard_denied",
    tool_name: "Bash",
    rule_id: rule
  })));
});

test("bounded shell inspection fails closed when command fan-out exceeds its limit", async () => {
  const root = await makeWorkspace();
  const command = "echo ok;".repeat(1100);
  assert.deepEqual(
    await inspect(command, { workspaceRoot: root }),
    expectedDeny("malformed-input")
  );
});

test("destructive targets protect roots, home, workspace boundaries, metadata, and secrets", async () => {
  const root = await makeWorkspace();
  const parent = dirname(root);
  const outside = join(parent, "outside target");
  const quotedRoot = `\"${root}\"`;
  const protectedCases = [
    `rm -rf ${quotedRoot}`,
    `rm -rf \"${parent}\"`,
    `rm -rf \"${outside}\"`,
    `rm -rf \"${homedir()}\"`,
    "rm -rf ./nested/../../outside",
    "Remove-Item -Recurse -Force ."
  ];
  for (const command of protectedCases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("protected-root"), command);
  }

  const sensitiveCases = [
    "rm -rf .git/objects",
    "del .git\\config",
    "Remove-Item -Force .codex/config.toml",
    "rm -f .env",
    "rm -f credentials.json",
    "rm -f id_ed25519",
    "rm -f .bashrc",
    "rm -f Microsoft.PowerShell_profile.ps1"
  ];
  for (const command of sensitiveCases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("sensitive-path"), command);
  }

  for (const command of [
    "rm -rf $TARGET",
    "rm -rf ${TARGET}",
    "rm -rf %TEMP%",
    "rm -rf ./build/*",
    "rm -rf C:relative",
    "rm -rf \\\\?\\C:\\workspace",
    "rm -rf C:\\workspace\\file.txt:stream",
    "rm -rf ./CON",
    "rm -rf ./folder. ",
    "rm -rf ./PROGRA~1"
  ]) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny("dynamic-target"), command);
  }
});

test("path and git edge syntax cannot bypass the documented precedence", async () => {
  const root = await makeWorkspace();
  const cases = [
    ["rm -rf /s", "protected-root"],
    ["rm -rf .git/*", "sensitive-path"],
    ["rm -f ./src/file.txt:stream", "dynamic-target"],
    ["rm -rf \\\\server\\share\\folder", "protected-root"],
    ["rm -rf \"./folder \"", "dynamic-target"],
    ["git push origin +main", "git-destructive"],
    ["pwsh -EncodedCommand:ZQBjAGgAbwAgAG8AawA=", "encoded-command"]
  ];
  for (const [command, rule] of cases) {
    assert.deepEqual(await inspect(command, { workspaceRoot: root }), expectedDeny(rule), command);
  }
});

test("filesystem aliases and hard links are denied while an ordinary local cleanup defers", async () => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();
  const outsideFile = join(outside, "outside.txt");
  await writeFile(outsideFile, "outside\n");
  const linkPath = join(root, "linked-outside");
  await makeDirectoryLink(outside, linkPath);
  assert.deepEqual(
    await inspect("rm -rf ./linked-outside", { workspaceRoot: root }),
    expectedDeny("protected-root")
  );
  const groupedLinkPath = join(root, "grouped-link");
  await makeDirectoryLink(outside, groupedLinkPath);
  assert.deepEqual(
    await inspect("(rm -rf ./grouped-link)", { workspaceRoot: root }),
    expectedDeny("protected-root")
  );

  const localFile = join(root, "ordinary.txt");
  const aliasFile = join(root, "ordinary-alias.txt");
  await writeFile(localFile, "ordinary\n");
  await link(localFile, aliasFile);
  assert.deepEqual(
    await inspect("rm -f ./ordinary.txt", { workspaceRoot: root }),
    expectedDeny("sensitive-path")
  );
  await mkdir(join(root, "dist"));
  assert.deepEqual(await inspect("rm -rf ./dist", { workspaceRoot: root }), {});
});

test("apply_patch parses only structural directives and rejects malformed, outside, sensitive, and alias targets", async () => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();
  const linkPath = join(root, "linked-outside");
  await makeDirectoryLink(outside, linkPath);
  const bodyOnly = [
    "*** Begin Patch",
    "*** Update File: src/message.txt",
    "@@",
    "+rm -rf / && git reset --hard",
    "*** End Patch"
  ].join("\n");
  assert.deepEqual(await inspectPatch(bodyOnly, { workspaceRoot: root }), {});

  const cases = [
    ["*** Begin Patch\n*** Update File: ../outside.txt\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Delete File: .git/config\n*** End Patch", "patch-sensitive-path"],
    ["*** Begin Patch\n*** Update File: linked-outside/file.txt\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Update File: C:relative.txt\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Update File: src/file.txt:stream\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Update File: .git/config\n*** Delete File: ../outside.txt\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Update File: src/a.txt\n*** Move to: ../a.txt\n*** End Patch", "patch-outside-workspace"],
    ["*** Begin Patch\n*** Update File: src/a.txt", "malformed-input"],
    ["not a patch", "malformed-input"]
  ];
  for (const [patch, rule] of cases) {
    assert.deepEqual(await inspectPatch(patch, { workspaceRoot: root }), expectedDeny(rule), patch);
  }
});

test("inactive, completed, missing, and corrupt workflows defer without creating metadata", async () => {
  const roots = [];
  const missing = await makeWorkspace();
  roots.push(missing);

  for (const status of ["paused", "blocked", "completed"]) {
    const root = await makeWorkspace();
    const state = await init(root, `inactive-${status}`);
    if (status === "completed") {
      await writeStateAtomic(root, {
        ...state,
        status,
        current_step: null,
        completed_steps: Array.from({ length: 50 }, (_, index) => index + 1),
        continuation: null,
        stop_delivery: null,
        completed_at: now
      });
    } else {
      await writeStateAtomic(root, {
        ...state,
        status,
        continuation: null,
        stop_delivery: null,
        blocked_reason: status === "blocked" ? "TEST_BLOCK" : null
      });
    }
    roots.push(root);
  }

  const corrupt = await makeWorkspace();
  await mkdir(pathsFor(corrupt).codexDir, { recursive: true });
  await writeFile(pathsFor(corrupt).statePath, "{secret=corrupt-state\n");
  roots.push(corrupt);

  for (const [index, root] of roots.entries()) {
    const before = await events(root);
    const result = await runHook("pre-tool-use", {
      hook_event_name: "PreToolUse",
      cwd: root,
      turn_id: `inactive-turn-${index}`,
      tool_name: "Bash",
      tool_use_id: `inactive-tool-${index}`,
      tool_input: { command: "rm -rf /" }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "{}\n");
    assert.deepEqual(result.output, {});
    assert.deepEqual(await events(root), before);
  }
});

test("active workflows append only sanitized deny or defer telemetry", async () => {
  const root = await makeWorkspace();
  await init(root, "telemetry");
  const secret = "sk-proj-never-store-this-secret";
  const denied = await handlePreToolUse(eventFor(`rm -rf / # ${secret}`), {
    workspaceRoot: root,
    eventNow: () => new Date("2026-09-02T12:00:00.000Z")
  });
  assert.deepEqual(denied, expectedDeny("protected-root"));
  assert.deepEqual(await handlePreToolUse(eventFor(`echo ${secret}`), {
    workspaceRoot: root,
    eventNow: () => new Date("2026-09-02T12:00:01.000Z")
  }), {});
  const tail = (await events(root)).slice(-2);
  assert.deepEqual(tail, [
    {
      kind: "guard_denied",
      tool_name: "Bash",
      rule_id: "protected-root",
      timestamp: "2026-09-02T12:00:00.000Z"
    },
    {
      kind: "guard_deferred",
      tool_name: "Bash",
      rule_id: "no-match",
      timestamp: "2026-09-02T12:00:01.000Z"
    }
  ]);
  const raw = await readFile(pathsFor(root).eventsPath, "utf8");
  assert.doesNotMatch(raw, /sk-proj|never-store|secret|rm -rf|echo /i);
});

test("telemetry failure cannot change a deny or defer decision", async () => {
  const root = await makeWorkspace();
  const running = await init(root, "telemetry-failure");
  const boom = async () => {
    throw new Error("secret telemetry path");
  };
  assert.deepEqual(await handlePreToolUse(eventFor("rm -rf /"), {
    workspaceRoot: root,
    readStateFn: async () => running,
    appendEventFn: boom
  }), expectedDeny("protected-root"));
  assert.deepEqual(await handlePreToolUse(eventFor("npm test"), {
    workspaceRoot: root,
    readStateFn: async () => running,
    appendEventFn: boom
  }), {});
});

test("a real full telemetry ledger leaves wire decisions unchanged", async () => {
  const root = await makeWorkspace();
  await init(root, "full-telemetry");
  const fullLedger = Buffer.alloc(EVENT_LOG_LIMIT, 0x20);
  await writeFile(pathsFor(root).eventsPath, fullLedger);
  for (const [command, expected] of [
    ["rm -rf /", expectedDeny("protected-root")],
    ["npm test", {}]
  ]) {
    const result = await runHook("pre-tool-use", {
      hook_event_name: "PreToolUse",
      cwd: root,
      turn_id: `full-ledger-${command.length}`,
      tool_name: "Bash",
      tool_use_id: `full-ledger-tool-${command.length}`,
      tool_input: { command, ignored_metadata: { secret: "never-store" } }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.deepEqual(result.output, expected);
    assert.ok(Buffer.from(await readFile(pathsFor(root).eventsPath)).equals(fullLedger));
  }
});

test("wire validation accepts arbitrary tool_input then explicitly denies supported malformed input", async () => {
  const root = await makeWorkspace();
  await init(root, "wire-malformed");
  for (const toolInput of [null, [], {}, { command: "" }, { arbitrary: { nested: true } }]) {
    const result = await runHook("pre-tool-use", {
      hook_event_name: "PreToolUse",
      cwd: root,
      turn_id: "wire-malformed-turn",
      tool_name: "Bash",
      tool_use_id: "wire-malformed-tool",
      tool_input: toolInput
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(expectedDeny("malformed-input"))}\n`);
    assert.deepEqual(result.output, expectedDeny("malformed-input"));
  }
});

test("wire rejects missing or extra envelope fields as one sanitized JSON document", async () => {
  const root = await makeWorkspace();
  await init(root, "wire-schema");
  const base = {
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: "schema-session",
    transcript_path: null,
    permission_mode: "default",
    model: "gpt-5.6-codex",
    turn_id: "schema-turn",
    tool_name: "Bash",
    tool_use_id: "schema-tool",
    tool_input: { command: "rm -rf /" }
  };
  const cases = [
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== "tool_use_id")),
    { ...base, extra: "secret-extra-field" },
    { ...base, tool_name: 7 },
    { ...base, tool_use_id: null }
  ];
  for (const event of cases) {
    const result = await runHook("pre-tool-use", event, { rawEvent: true });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, '{"error":{"code":"HOOK_EVENT_INVALID","message":"hook event rejected"}}\n');
  }
});

test("wire emits exactly one LF-terminated decision and never legacy permission fields", async () => {
  const root = await makeWorkspace();
  await init(root, "wire-output");
  for (const [command, expected] of [
    ["rm -rf /", expectedDeny("protected-root")],
    ["npm test", {}]
  ]) {
    const result = await runHook("pre-tool-use", {
      hook_event_name: "PreToolUse",
      cwd: root,
      turn_id: `wire-${command.length}`,
      tool_name: "Bash",
      tool_use_id: `wire-tool-${command.length}`,
      tool_input: { command }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.deepEqual(result.output, expected);
    assert.doesNotMatch(result.stdout, /updatedInput|permissionDecision"\s*:\s*"(?:allow|ask)|continue|suppressOutput/);
  }
});

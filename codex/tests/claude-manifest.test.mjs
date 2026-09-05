import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeWorkspace } from './helpers/workspace.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dispatcher = path.join(repo, 'hooks/run-hook.mjs');
const expected = {
  SessionStart: [['', 'step-progress-loader', 30]],
  UserPromptSubmit: [['', 'webapp-trigger', 10], ['', 'step-obedience-guard', 5]],
  PreToolUse: [['Bash', 'destructive-guard', 5], ['Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch', 'auto-approve', 3]],
  PermissionRequest: [['Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch', 'permission-request-guard', 5]],
  PostToolUse: [['Write|Edit', 'mx-tag-validator', 10], ['Write|Edit', 'lsp-autofix', 30]],
  Stop: [['', 'step-progress-writer', 30], ['', 'spec-generator', 15], ['', 'trust5-validator', 60], ['', 'step-auto-continue', 10]],
};
test('Claude manifest has a hooks envelope and one dispatcher per preserved registration', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(config), ['hooks']);
  assert.deepEqual(Object.keys(config.hooks).sort(), Object.keys(expected).sort());
  for (const [event, registrations] of Object.entries(expected)) {
    const actual = config.hooks[event].flatMap(group => group.hooks.map(hook => {
      assert.equal(hook.type, 'command');
      const match = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run-hook\.mjs" ([a-z0-9-]+)$/.exec(hook.command);
      assert.ok(match, hook.command);
      return [group.matcher || '', match[1], hook.timeout];
    }));
    assert.deepEqual(actual, registrations);
  }
});
test('dispatcher rejects missing, unknown, traversal, and extra hook arguments', () => {
  for (const args of [[], ['unknown'], ['../webapp-trigger'], ['webapp-trigger', 'extra']]) {
    const result = spawnSync(process.execPath, [dispatcher, ...args], { encoding: 'utf8', input: '{}', timeout: 5000 });
    assert.equal(result.status, 64, result.stderr);
    assert.equal(result.stdout, '');
  }
});
test('dispatcher runs only native shell and preserves stdin, output, and exit code', async () => {
  const root = await makeWorkspace();
  fs.copyFileSync(dispatcher, path.join(root, 'run-hook.mjs'));
  const windows = process.platform === 'win32';
  // Only the native counterpart exists; attempting the other platform fails.
  fs.writeFileSync(path.join(root, windows ? 'step-auto-continue.ps1' : 'step-auto-continue.sh'), windows
    ? "$ErrorActionPreference = 'Stop'\n$raw = [Console]::In.ReadToEnd()\n[Console]::Out.Write($raw)\n[Console]::Error.Write('fixture stderr')\nexit 2\n"
    : "#!/usr/bin/env bash\ncat\nprintf 'fixture stderr' >&2\nexit 2\n");
  const event = '{"stop_hook_active":true}';
  const result = spawnSync(process.execPath, [path.join(root, 'run-hook.mjs'), 'step-auto-continue'], { input: event, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, event);
  assert.equal(result.stderr, 'fixture stderr');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const bashOnWindows = windows && process.env.H50_TEST_BASH === '1';
const active = { current_step: 1, total_steps: 50, completed_steps: [] };
function fixture(t, state = active) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h50-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'step_archive'));
  if (state !== null) fs.writeFileSync(path.join(root, 'step_archive/progress.json'), typeof state === 'string' ? state : JSON.stringify(state));
  return root;
}
function run(root, hook, event, env = {}, cwd = root) {
  const script = path.join(repo, 'hooks', hook + (windows && !bashOnWindows ? '.ps1' : '.sh'));
  const shell = bashOnWindows ? 'C:/Program Files/Git/bin/bash.exe' : windows ? 'powershell.exe' : 'bash';
  const args = bashOnWindows ? ['-c', 'uname(){ echo Linux; }; python3(){ python "$@" | tr -d "\\r"; }; export -f uname python3; bash "$1"', 'fixture', script.replaceAll('\\', '/')] : windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
  const result = spawnSync(shell, args, {
    cwd, input: JSON.stringify(event), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_PROJECT_DIR: root, ...env },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '', result.stderr);
  return { status: result.status, output: result.stdout.trim() };
}
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'example' } });
test('shipping hook allows an ordinary project write in bootstrap state', t => {
  const root = fixture(t);
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
});
for (const [name, state] of Object.entries({ missing: null, malformed: '{', empty: {}, completed: { ...active, current_step: 50, completed_steps: Array.from({ length: 50 }, (_, i) => i + 1) }, paused: { ...active, paused: true }, statusPaused: { ...active, status: 'paused' }, gap: { ...active, current_step: 3, completed_steps: [2] }, inconsistent: { ...active, current_step: 2 }, strings: { ...active, current_step: '1' } })) {
  test(`autoapproval defers for ${name} state`, t => {
    assert.equal(run(fixture(t, state), 'auto-approve', write('src/app.js')).output, '');
  });
}
for (const target of ['.claude/subdir/../settings.json', '/cache/harness50/2.1.0/hooks/auto-approve.ps1', path.join(repo, 'hooks/auto-approve.ps1')]) {
  test(`protect canonical target ${target}`, t => {
    const root = fixture(t);
    assert.equal(run(root, 'auto-approve', write(target)).output, '');
    const guard = run(root, 'permission-request-guard', write(target));
    assert.equal(guard.status, 2);
    assert.match(guard.output, /"deny"/);
  });
}
test('arbitrary shell and out-of-project writes require normal permission', t => {
  const root = fixture(t);
  assert.equal(run(root, 'auto-approve', { tool_name: 'Bash', tool_input: { command: 'echo hello' } }).output, '');
  assert.equal(run(root, 'auto-approve', write('../outside.txt')).output, '');
});
test('existing destructive command denial remains (payload never executed)', t => {
  const root = fixture(t);
  const event = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };
  assert.equal(run(root, 'auto-approve', event).output, '');
  assert.equal(run(root, 'permission-request-guard', event).status, 2);
});
test('event cwd is used when project environment is absent', t => {
  const root = fixture(t);
  assert.match(run(root, 'auto-approve', { ...write('src/app.js'), cwd: root }, { CLAUDE_PROJECT_DIR: '' }, repo).output, /"allow"/);
});
test('Unicode event cwd survives the PowerShell to Node pipe', t => {
  const parent = fixture(t);
  const root = path.join(parent, '프로젝트');
  fs.mkdirSync(path.join(root, 'step_archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'step_archive/progress.json'), JSON.stringify(active));
  assert.match(run(root, 'auto-approve', { ...write('src/app.js'), cwd: root }, { CLAUDE_PROJECT_DIR: '' }, repo).output, /"allow"/);
});
test('hard links to protected files do not grant write approval', t => {
  const root = fixture(t);
  const privatePath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(privatePath));
  fs.writeFileSync(privatePath, '{}');
  fs.linkSync(privatePath, path.join(root, 'innocent.json'));
  assert.equal(run(root, 'auto-approve', write('innocent.json')).output, '');
});
test('parent traversal after a directory link cannot hide its protected target', t => {
  const root = fixture(t);
  const protectedChild = path.join(root, '.claude', 'child');
  fs.mkdirSync(protectedChild, { recursive: true });
  fs.symlinkSync(protectedChild, path.join(root, 'alias'), windows ? 'junction' : 'dir');
  const event = write('alias/../settings.json');
  assert.equal(run(root, 'auto-approve', event).output, '');
  assert.equal(run(root, 'permission-request-guard', event).status, 2);
});
test('canonical linked directories cannot escape project scope or plugin protection', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'outside'), windows ? 'junction' : 'dir');
  fs.symlinkSync(path.join(repo, 'hooks'), path.join(root, 'plugin'), windows ? 'junction' : 'dir');
  assert.equal(run(root, 'auto-approve', write('outside/file.txt')).output, '');
  assert.equal(run(root, 'auto-approve', write('plugin/auto-approve.ps1')).output, '');
  assert.equal(run(root, 'permission-request-guard', write('plugin/auto-approve.ps1')).status, 2);
});
test('WebSearch and middle workflow project edits are eligible; WebFetch defers', t => {
  const root = fixture(t, { ...active, current_step: 3, completed_steps: [1, 2] });
  assert.match(run(root, 'auto-approve', write('src/app.js')).output, /"allow"/);
  assert.match(run(root, 'auto-approve', { tool_name: 'WebSearch', tool_input: { query: 'css' } }).output, /"allow"/);
  assert.equal(run(root, 'auto-approve', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }).output, '');
  assert.equal(run(root, 'auto-approve', write('step_archive/progress.json')).output, '');
});
test('dangling directory links cannot grant project write approval', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'), windows ? 'junction' : 'dir');
  assert.equal(run(root, 'auto-approve', write('dangling/file.txt')).output, '');
});
test('missing Node runtime cannot grant approval', t => {
  const root = fixture(t);
  const script = path.join(repo, 'hooks', windows ? 'auto-approve.ps1' : 'auto-approve.sh');
  const executable = windows ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash';
  const result = spawnSync(executable, windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script], {
    cwd: root, input: JSON.stringify(write('src/app.js')), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: root, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

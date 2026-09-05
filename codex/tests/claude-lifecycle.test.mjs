import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const windows = process.platform === 'win32';
const bashOnWindows = windows && process.env.H50_TEST_BASH === '1';
const shell = bashOnWindows ? 'C:/Program Files/Git/bin/bash.exe' : windows ? 'powershell.exe' : 'bash';
const ext = bashOnWindows || !windows ? 'sh' : 'ps1';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'h50-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, 'cache', 'plugin', '2.2');
  cpSync(join(repo, 'hooks'), join(plugin, 'hooks'), { recursive: true });
  cpSync(join(repo, 'assets'), join(plugin, 'assets'), { recursive: true });
  const project = join(root, 'project'); const other = join(root, 'other');
  mkdirSync(project); mkdirSync(other);
  const run = (name, event = {}, envRoot = '', cwd = other) => {
    const path = join(plugin, 'hooks', `${name}.${ext}`);
    const args = bashOnWindows ? ['-c', 'uname(){ echo Linux; }; python3(){ python "$@"; }; export -f uname python3; bash "$1"', 'fixture', path.replaceAll('\\', '/')] : windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path] : [path];
    const result = spawnSync(shell, args, { cwd, input: JSON.stringify(event), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_PROJECT_DIR: envRoot } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stderr.trim(), '', result.stderr);
    return result.stdout.trim();
  };
  const state = (completed = [], current = 1) => {
    mkdirSync(join(project, 'step_archive', 'archived'), { recursive: true });
    for (let n = 1; n <= 3; n++) writeFileSync(join(project, 'step_archive', 'archived', `step00${n}.md`), '# Test\n## Task\n');
    writeFileSync(join(project, 'step_archive', 'progress.json'), JSON.stringify({ last_updated: '', total_steps: 3, current_step: current, completed_steps: completed, failed_steps: [], metrics: { total_sessions: 0 }, session_history: [] }));
  };
  return { plugin, project, other, run, state };
}
test('exact installed startup bytes use event cwd and environment precedence', t => {
  const f = fixture(t);
  f.run('webapp-trigger', { cwd: f.project, prompt: '/webapp fractions' });
  assert.ok(existsSync(join(f.project, 'step_archive', 'progress.json')));
  assert.ok(!existsSync(join(f.other, 'step_archive')));
  f.run('webapp-trigger', { cwd: f.project, prompt: '/webapp fractions' }, f.other);
  assert.ok(existsSync(join(f.other, 'step_archive', 'progress.json')));
});
test('writer preserves first unfinished step; loader and Stop agree', t => {
  const f = fixture(t); f.state();
  f.run('step-progress-writer', { cwd: f.project, last_assistant_message: 'Step 003/3 완료' });
  const p = JSON.parse(readFileSync(join(f.project, 'step_archive', 'progress.json'), 'utf8'));
  assert.deepEqual(p.completed_steps, [3]); assert.equal(p.current_step, 1);
  assert.match(f.run('step-progress-loader', { cwd: f.project }), /step001/);
  assert.match(JSON.parse(f.run('step-auto-continue', { cwd: f.project })).reason, /step001/);
  f.run('spec-generator', { cwd: f.project });
  assert.ok(existsSync(join(f.project, 'step_archive', 'specs', 'SPEC-001.md')));
});
test('Stop is project scoped, bounded, sticky on stall, and resets after progress', t => {
  const f = fixture(t); f.state();
  const event = { cwd: f.project, session_id: 'same-session', stop_hook_active: true };
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse(f.run('step-auto-continue', event)).decision, 'block');
  assert.equal(f.run('step-auto-continue', event), '');
  assert.equal(f.run('step-auto-continue', event), '');
  cpSync(join(f.project, 'step_archive'), join(f.other, 'step_archive'), { recursive: true });
  // Remove only copied runtime state, so this is an independent project.
  for (const name of ['step-auto-continue.same-session.state']) rmSync(join(f.other, 'step_archive', name), { force: true });
  assert.equal(JSON.parse(f.run('step-auto-continue', { ...event, cwd: f.other })).decision, 'block');
  f.state([1], 2);
  assert.match(JSON.parse(f.run('step-auto-continue', event)).reason, /step002/);
  f.state([1, 2, 3], 3); assert.equal(f.run('step-auto-continue', event), '');
});
test('Stop uses process cwd fallback and releases missing, paused, malformed state', t => {
  const f = fixture(t);
  assert.equal(f.run('step-auto-continue', { cwd: f.project }), '');
  f.state([3], 3);
  assert.match(JSON.parse(f.run('step-auto-continue', {}, '', f.project)).reason, /step001/);
  const path = join(f.project, 'step_archive', 'progress.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...state, paused: true }));
  assert.equal(f.run('step-auto-continue', { cwd: f.project }), '');
  writeFileSync(path, '{broken');
  assert.equal(f.run('step-auto-continue', { cwd: f.project }), '');
});

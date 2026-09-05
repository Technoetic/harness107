import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const bashFixture = windows && process.env.H50_TEST_BASH === '1';
const active = { total_steps: 50, current_step: 39, completed_steps: Array.from({ length: 38 }, (_, i) => i + 1) };
function fixture(t, state = active) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'h50-quality-hook-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, '프로젝트');
  const plugin = path.join(base, 'cache', 'plugin', '2.2');
  fs.mkdirSync(path.join(project, 'step_archive'), { recursive: true });
  fs.cpSync(path.join(repo, 'hooks'), path.join(plugin, 'hooks'), { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), path.join(plugin, 'scripts'), { recursive: true });
  if (state !== null) fs.writeFileSync(path.join(project, 'step_archive/progress.json'), JSON.stringify(state));
  // This must never be executed by the inspection-only Stop hook.
  fs.writeFileSync(path.join(project, 'harness50.quality.json'), JSON.stringify({
    schema_version: 1,
    checks: Object.fromEntries(['test', 'lint', 'typecheck', 'security'].map(name => [name, { command: [process.execPath, '-e', 'process.exit(99)'] }])),
    coverage: { path: 'coverage/coverage-summary.json', minimum: 85 },
  }));
  const run = (event = {}) => {
    const script = path.join(plugin, 'hooks', windows && !bashFixture ? 'trust5-validator.ps1' : 'trust5-validator.sh');
    const shell = bashFixture ? 'C:/Program Files/Git/bin/bash.exe' : windows ? 'powershell.exe' : 'bash';
    const args = bashFixture ? ['-c', 'uname(){ echo Linux; }; export -f uname; bash "$1"', 'fixture', script.replaceAll('\\', '/')]
      : windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
    const result = spawnSync(shell, args, { cwd: base, input: JSON.stringify({ cwd: project, ...event }), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stderr, '');
    return result.stdout.trim();
  };
  return { project, run };
}
for (const [name, state] of Object.entries({ missing: null, paused: { ...active, paused: true }, cancelled: { ...active, status: 'cancelled' }, invalidCurrent: { ...active, current_step: 1 }, malformedCurrent: { ...active, current_step: '39' }, wrongTotal: { ...active, total_steps: 100 }, nullCompleted: { ...active, completed_steps: null } })) {
  test(`quality hook releases ${name} workflow without writing a verdict`, t => {
    const f = fixture(t, state);
    assert.equal(f.run(), '');
    assert.equal(fs.existsSync(path.join(f.project, 'step_archive/outputs')), false);
  });
}
test('exact shipping quality hook supports Unicode cwd and blocks incomplete milestone only once', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.run()).decision, 'block');
  const output = path.join(f.project, 'step_archive/outputs/trust5_r1.md');
  assert.match(fs.readFileSync(output, 'utf8'), /Verdict: INCOMPLETE/);
  assert.equal(f.run({ stop_hook_active: true }), '');
  assert.match(fs.readFileSync(output, 'utf8'), /Verdict: INCOMPLETE/);
  assert.equal(fs.existsSync(path.join(f.project, 'step_archive/outputs/quality-gate.json')), false);
});
for (const [completed, current, round] of [[44, 45, 'r2'], [50, 50, 'r3'], [50, 51, 'r3']]) {
  test(`quality hook retains ${round} milestone at cursor ${current}`, t => {
    const f = fixture(t, { ...active, current_step: current, completed_steps: Array.from({ length: completed }, (_, i) => i + 1) });
    assert.equal(JSON.parse(f.run()).decision, 'block');
    assert.match(fs.readFileSync(path.join(f.project, `step_archive/outputs/trust5_${round}.md`), 'utf8'), /Verdict: INCOMPLETE/);
  });
}

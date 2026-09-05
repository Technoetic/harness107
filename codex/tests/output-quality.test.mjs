import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeWorkspace } from './helpers/workspace.mjs';
import { validateHtmlBytes } from '../../scripts/lib/html-document.mjs';
import { runQualityGate, inspectQualityReport } from '../../scripts/lib/quality.mjs';

test('HTML evidence rejects empty, binary, invalid UTF-8 and incomplete documents', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe]), Buffer.from('<html>'), Buffer.from('plain text'), Buffer.from('<html>\0</html>'),
    Buffer.from('<!-- <html></html> -->'), Buffer.from('<script>const fake = "<html></html>";</script>'),
    Buffer.from('<div title="<html></html>">Not a document</div>'), Buffer.from('</html><html>')]) {
    assert.throws(() => validateHtmlBytes(bytes), /HTML|UTF-8/);
  }
  assert.equal(validateHtmlBytes(Buffer.from('<!doctype html><html lang="en"><head><title>Demo</title></head><body>Demo</body></html>')).includes('Demo'), true);
});

async function fixture() {
  const root = await makeWorkspace();
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'coverage'));
  await writeFile(join(root, 'src', 'app.js'), 'export const answer = 42;');
  return root;
}

async function configure(root, command, { fresh = true, total = 10, covered = 9 } = {}) {
  const summary = JSON.stringify({total:
    Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map(name => [name, {total, covered, skipped: 0, pct: 90}]))
  });
  const checks = Object.fromEntries(['test', 'lint', 'typecheck', 'security'].map(name => [name, { command: command ?? [process.execPath, '-e', 'process.exit(0)'] }]));
  if (command === undefined && fresh) {
    checks.test.command = [process.execPath, '-e', `require('node:fs').writeFileSync('coverage/coverage-summary.json', ${JSON.stringify(summary)})`];
  }
  await writeFile(join(root, 'harness50.quality.json'), JSON.stringify({
    schema_version: 1,
    checks,
    coverage: { path: 'coverage/coverage-summary.json', minimum: 85 }
  }));
  await writeFile(join(root, 'coverage', 'coverage-summary.json'), summary);
}

test('successful commands cannot reuse coverage left by a previous test run', async () => {
  const root = await fixture();
  await configure(root, undefined, { fresh: false });
  const result = await runQualityGate(root);
  assert.equal(result.checks.test.exit_code, 0);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.error, /coverage|ENOENT/i);
});

test('coverage created by lint cannot stand in for missing test coverage', async () => {
  const root = await fixture();
  await configure(root, undefined, { fresh: false });
  const path = join(root, 'harness50.quality.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.checks.lint.command = [process.execPath, '-e', `require('node:fs').writeFileSync('coverage/coverage-summary.json', ${JSON.stringify(await readFile(join(root, 'coverage', 'coverage-summary.json'), 'utf8'))})`];
  await writeFile(path, JSON.stringify(config));
  assert.equal((await runQualityGate(root)).verdict, 'FAIL');
});

test('later commands cannot change the coverage captured from the test invocation', async () => {
  const root = await fixture();
  await configure(root);
  const path = join(root, 'harness50.quality.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.checks.lint.command = [process.execPath, '-e', `const fs=require('node:fs'); const p='coverage/coverage-summary.json'; fs.appendFileSync(p,' ');`];
  await writeFile(path, JSON.stringify(config));
  assert.equal((await runQualityGate(root)).verdict, 'FAIL');
});

test('coverage cleanup refuses source files outside the generated coverage directory', async () => {
  const root = await fixture();
  await configure(root);
  const path = join(root, 'harness50.quality.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.coverage.path = 'src/app.js';
  await writeFile(path, JSON.stringify(config));
  assert.equal((await runQualityGate(root)).verdict, 'FAIL');
  assert.equal(await readFile(join(root, 'src/app.js'), 'utf8'), 'export const answer = 42;');
});

test('empty src and coverage directories can never manufacture quality PASS', async () => {
  const root = await fixture();
  assert.notEqual((await inspectQualityReport(root)).verdict, 'PASS');
  const result = await runQualityGate(root);
  assert.equal(result.verdict, 'FAIL');
  assert.match(JSON.stringify(result), /harness50\.quality\.json/i);
});

test('quality gate records real exit status and rejects stale, edited and malformed evidence', async () => {
  const root = await fixture();
  await configure(root);
  const pass = await runQualityGate(root);
  assert.equal(pass.verdict, 'PASS');
  assert.equal((await inspectQualityReport(root)).verdict, 'PASS');
  await writeFile(join(root, 'src', 'app.js'), 'throw Error("changed");');
  assert.notEqual((await inspectQualityReport(root)).verdict, 'PASS');
  await configure(root, [process.execPath, '-e', 'console.log("0 findings"); process.exit(7)']);
  const fail = await runQualityGate(root);
  assert.equal(fail.verdict, 'FAIL');
  assert.equal(fail.checks.security.exit_code, 7);
  const reportPath = join(root, 'step_archive', 'outputs', 'quality-gate.json');
  const edited = JSON.parse(await readFile(reportPath, 'utf8'));
  edited.verdict = 'PASS';
  await writeFile(reportPath, JSON.stringify(edited));
  assert.notEqual((await inspectQualityReport(root)).verdict, 'PASS');
  await writeFile(reportPath, '{broken');
  assert.notEqual((await inspectQualityReport(root)).verdict, 'PASS');
});

test('quality commands time out and zero-denominator coverage cannot pass', async () => {
  const root = await fixture();
  await configure(root, [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  const result = await runQualityGate(root, { timeoutMs: 150 });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.checks.test.timed_out, true);
  await configure(root, undefined, { total: 0, covered: 0 });
  assert.equal((await runQualityGate(root)).verdict, 'FAIL');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeWorkspace } from '../codex/tests/helpers/workspace.mjs';
import { verifyOutput } from '../scripts/verify-output.mjs';

test('browser CLI invoked through a directory alias rejects a missing artifact', async () => {
  const root = await makeWorkspace();
  const alias = join(root, 'cli');
  await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(promisify(execFile)(process.execPath, [join(alias, 'verify-output.mjs'), '--workspace', root]),
    error => error.code === 1 && JSON.parse(error.stdout).verdict === 'FAIL');
});

const document = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Interactive example</title><style>body{margin:24px;background:#fff;color:#111;font:18px Arial}button{font:inherit;padding:12px}</style></head><body><main><h1>Interactive example</h1>${body}</main></body></html>`;
async function fixture(body) {
  const root = await makeWorkspace();
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.html'), document(body));
  return root;
}

test('Chromium validates a working document at desktop and mobile sizes', async () => {
  const root = await fixture('<p>Explore an accessible interactive example.</p><button onclick="this.textContent=\'Activated\'">Activate</button>');
  const report = await verifyOutput(root);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report));
  assert.equal(report.viewports.length, 2);
  for (const viewport of report.viewports) assert.ok((await readFile(join(root, viewport.screenshot))).length > 100);
  assert.match(report.artifact_sha256, /^[a-f0-9]{64}$/);
});

test('runtime errors, inaccessible controls and unavailable network dependencies fail', async () => {
  const root = await fixture('<button></button><script>throw new Error("fixture failure")</script><script src="https://example.invalid/dependency.js"></script>');
  const report = await verifyOutput(root);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.viewports.some(view => view.errors.length > 0));
  assert.ok(report.viewports.some(view => view.violations.some(item => item.id === 'button-name')));
  assert.ok(report.viewports.some(view => view.blocked_requests > 0));
});

test('mobile overflow is a measurable failure', async () => {
  const root = await fixture('<p style="width:1000px">Overflow</p>');
  const report = await verifyOutput(root);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.viewports.find(item => item.name === 'mobile').horizontal_overflow, true);
});

test('a nonterminating page is closed by the verification deadline', { timeout: 20000 }, async () => {
  const root = await fixture('<script>while (true) {}</script>');
  const started = Date.now();
  const report = await verifyOutput(root, { timeoutMs: 1000 });
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.error);
  assert.ok(Date.now() - started < 15000, 'browser deadline did not bound the stalled page');
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowed = new Set([
  'step-progress-loader', 'webapp-trigger', 'step-obedience-guard',
  'destructive-guard', 'auto-approve', 'permission-request-guard',
  'mx-tag-validator', 'lsp-autofix', 'step-progress-writer',
  'spec-generator', 'trust5-validator', 'step-auto-continue',
]);
const args = process.argv.slice(2);
if (args.length !== 1 || !allowed.has(args[0])) {
  console.error('Harness50: expected one registered hook name');
  process.exitCode = 64;
} else {
  const windows = process.platform === 'win32';
  const script = join(dirname(fileURLToPath(import.meta.url)), args[0] + (windows ? '.ps1' : '.sh'));
  const child = spawn(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
    : [script], { stdio: 'inherit', shell: false, windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.once('error', error => {
    console.error(`Harness50: could not start registered hook (${error.code || 'spawn error'})`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
  });
}

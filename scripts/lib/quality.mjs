import { spawn, execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { physicalWorkspace, safePath, readSafe, writeSafe, sourceFingerprint, sha256 } from './quality-files.mjs';

export const REPORT_PATH = 'step_archive/outputs/quality-gate.json';
const CONFIG_PATH = 'harness50.quality.json';
const CHECKS = ['test', 'lint', 'typecheck', 'security'];
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const MAX_TIMEOUT = 120000;

function parseConfig(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (value?.schema_version !== 1 || !value.checks || CHECKS.some(name => {
    const command = value.checks[name]?.command;
    return !Array.isArray(command) || command.length === 0 || command.length > 64 || command.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0') || arg.length > 8192);
  }) || typeof value.coverage?.path !== 'string' || !value.coverage.path.startsWith('coverage/') || !Number.isFinite(value.coverage.minimum) || value.coverage.minimum < 85 || value.coverage.minimum > 100) {
    throw new Error('Invalid quality config: four check argv arrays, a coverage/ report path and coverage minimum >= 85 required');
  }
  return value;
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    let child, timer, finished = false, outputBytes = 0;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ command, exit_code: null, timed_out: false, output_limit: false, ...result });
    };
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    try {
      // No shell expansion. Windows .cmd files must be replaced with their Node CLI entry point.
      child = spawn(command[0] === 'node' ? process.execPath : command[0], command.slice(1), {
        cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
      const count = bytes => {
        outputBytes += bytes.length;
        if (outputBytes > 1024 * 1024) { kill(); finish({ output_limit: true }); }
      };
      child.stdout.on('data', count); child.stderr.on('data', count);
      child.on('error', error => finish({ error: error.code ?? 'COMMAND_ERROR' }));
      child.on('close', (code, signal) => finish({ exit_code: code, signal }));
      timer = setTimeout(() => { kill(); finish({ timed_out: true }); }, timeoutMs);
    } catch (error) { finish({ error: error.code ?? 'COMMAND_ERROR' }); }
  });
}

function commandPass(check) {
  return check?.exit_code === 0 && check.timed_out === false && check.output_limit === false && !check.error && !check.signal;
}

function coverageResult(bytes, minimum) {
  const summary = JSON.parse(bytes.toString('utf8'));
  const metrics = {};
  for (const name of METRICS) {
    const item = summary?.total?.[name];
    if (!Number.isInteger(item?.total) || !Number.isInteger(item?.covered) || item.total <= 0 || item.covered < 0 || item.covered > item.total) throw new Error(`Coverage ${name} lacks real measured totals`);
    // Compute from counts; never trust a supplied percentage alone.
    metrics[name] = 100 * item.covered / item.total;
  }
  return { generated_by: 'test', minimum, metrics, pass: METRICS.every(name => metrics[name] >= minimum), sha256: sha256(bytes) };
}

export async function runQualityGate(workspaceRoot, { timeoutMs = MAX_TIMEOUT } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) throw new Error('Invalid command timeout');
  const root = await physicalWorkspace(workspaceRoot);
  const report = { schema_version: 1, generated_at: new Date().toISOString(), verdict: 'FAIL', checks: {}, coverage: null };
  try {
    const configBytes = await readSafe(root, CONFIG_PATH, 65536);
    const config = parseConfig(configBytes);
    report.config_sha256 = sha256(configBytes);
    const before = await sourceFingerprint(root);
    // A previous run's report cannot establish what this test invocation covered.
    // Only generated files under coverage/ are eligible for this cleanup.
    const coveragePath = await safePath(root, config.coverage.path, { createParents: true });
    await unlink(coveragePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const name of CHECKS) {
      report.checks[name] = await runCommand(config.checks[name].command, root, timeoutMs);
      if (name === 'test') {
        try { report.coverage = coverageResult(await readSafe(root, config.coverage.path), config.coverage.minimum); }
        catch (error) { report.error = `Test did not produce valid fresh coverage: ${error.message}`; }
      }
    }
    report.source = await sourceFingerprint(root);
    if (before.sha256 !== report.source.sha256) throw new Error('Source changed during quality checks; rerun on stable input');
    if (report.coverage && sha256(await readSafe(root, config.coverage.path)) !== report.coverage.sha256) throw new Error('Coverage changed after the test invocation');
    if (!report.error && CHECKS.every(name => commandPass(report.checks[name])) && report.coverage?.pass) report.verdict = 'PASS';
  } catch (error) { report.error = error.message; }
  await writeSafe(root, REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function inspectQualityReport(workspaceRoot) {
  try {
    const root = await physicalWorkspace(workspaceRoot);
    const report = JSON.parse((await readSafe(root, REPORT_PATH)).toString('utf8'));
    const configBytes = await readSafe(root, CONFIG_PATH, 65536);
    const config = parseConfig(configBytes);
    if (report.schema_version !== 1 || report.verdict !== 'PASS' || report.error || report.config_sha256 !== sha256(configBytes) || !Number.isFinite(Date.parse(report.generated_at)) || CHECKS.some(name => !commandPass(report.checks?.[name]) || JSON.stringify(report.checks[name].command) !== JSON.stringify(config.checks[name].command))) throw new Error('Quality report does not contain four successful configured checks');
    const current = await sourceFingerprint(root);
    if (current.sha256 !== report.source?.sha256 || current.files !== report.source?.files) throw new Error('Quality report is stale: source fingerprint changed');
    const coverage = coverageResult(await readSafe(root, config.coverage.path), config.coverage.minimum);
    if (!coverage.pass || JSON.stringify(coverage) !== JSON.stringify(report.coverage)) throw new Error('Coverage evidence failed or changed');
    return report;
  } catch (error) { return { schema_version: 1, verdict: 'INCOMPLETE', error: error.message }; }
}

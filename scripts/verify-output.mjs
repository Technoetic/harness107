#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { physicalWorkspace, readSafe, writeSafe, sha256 } from './lib/quality-files.mjs';
import { validateHtmlBytes } from './lib/html-document.mjs';

const ENTRY = 'http://harness50.local/index.html';
const ARTIFACT = 'dist/index.html';
const REPORT = 'step_archive/outputs/browser-output.json';

export async function verifyOutput(workspaceRoot, { timeoutMs = 60000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid browser timeout');
  const root = await physicalWorkspace(workspaceRoot);
  const report = { schema_version: 1, generated_at: new Date().toISOString(), artifact_path: ARTIFACT, verdict: 'FAIL', viewports: [] };
  let browser, deadline;
  try {
    const bytes = await readSafe(root, ARTIFACT);
    validateHtmlBytes(bytes);
    report.artifact_sha256 = sha256(bytes);
    const [{ chromium }, { default: AxeBuilder }] = await Promise.all([import('playwright'), import('@axe-core/playwright')]);
    browser = await chromium.launch({ headless: true, timeout: Math.min(timeoutMs, 15000) });
    deadline = setTimeout(() => { report.error = 'Browser verification exceeded its deadline'; browser.close().catch(() => {}); }, timeoutMs);
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' });
      const errors = [];
      let blockedRequests = 0;
      const recordError = kind => { if (errors.length < 100) errors.push(kind); };
      await context.route('**/*', async route => {
        if (route.request().url() === ENTRY && route.request().isNavigationRequest()) await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bytes });
        else { blockedRequests++; await route.abort('blockedbyclient'); }
      });
      await context.routeWebSocket('**/*', socket => { blockedRequests++; socket.close(); });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', () => recordError('pageerror'));
      page.on('console', message => { if (message.type() === 'error') recordError('console.error'); });
      page.on('crash', () => recordError('crash'));
      page.on('dialog', dialog => { recordError('unexpected-dialog'); dialog.dismiss().catch(() => {}); });
      page.on('popup', popup => { recordError('unexpected-popup'); popup.close().catch(() => {}); });
      page.on('requestfailed', () => recordError('requestfailed'));
      await page.goto(ENTRY, { waitUntil: 'load', timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('body').waitFor({ state: 'visible' });
      const metrics = await page.evaluate(() => ({
        horizontal_overflow: document.documentElement.scrollWidth > innerWidth + 1,
        visible_text_length: document.body.innerText.trim().length,
        dom_content_loaded_ms: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? null,
        focusable_elements: [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0).length
      }));
      await page.keyboard.press('Tab');
      const keyboardFocus = await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== document.documentElement);
      const analysis = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const screenshot = `step_archive/screenshots/verified-${viewport.name}.png`;
      await writeSafe(root, screenshot, await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 10000 }));
      const violations = analysis.violations.map(item => ({ id: item.id, impact: item.impact, affected_nodes: item.nodes.length }));
      const result = { ...viewport, ...metrics, keyboard_focus: keyboardFocus, errors, blocked_requests: blockedRequests, violations, accessibility_incomplete: analysis.incomplete.map(item => item.id), screenshot };
      result.pass = errors.length === 0 && blockedRequests === 0 && violations.length === 0 && !metrics.horizontal_overflow && metrics.visible_text_length > 0 && (metrics.focusable_elements === 0 || keyboardFocus);
      report.viewports.push(result);
      await context.close();
    }
    if (sha256(await readSafe(root, ARTIFACT)) !== report.artifact_sha256) throw new Error('HTML changed during browser verification');
    if (!report.error && report.viewports.length === 2 && report.viewports.every(view => view.pass)) report.verdict = 'PASS';
  } catch (error) { report.error = error.code === 'ERR_MODULE_NOT_FOUND' ? 'Browser tools missing: run npm ci in the plugin checkout, then npx playwright install chromium' : error.message; }
  finally { clearTimeout(deadline); await browser?.close().catch(() => {}); }
  await writeSafe(root, REPORT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const offset = args.indexOf('--workspace');
  const root = offset === -1 ? process.cwd() : args[offset + 1];
  if (!root) { console.error('--workspace requires a directory'); process.exitCode = 1; }
  else verifyOutput(root).then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.verdict === 'PASS' ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

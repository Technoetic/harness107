// Validate the verifier's measured fields, without executing a browser at completion.
export function validateBrowserReportBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024) throw new Error('Browser report exceeds its size limit');
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Browser report must be valid UTF-8 JSON'); }
  if (report?.schema_version !== 1 || report.verdict !== 'PASS' || report.error ||
    report.artifact_path !== 'dist/index.html' || !/^[a-f0-9]{64}$/.test(report.artifact_sha256 ?? '') ||
    typeof report.generated_at !== 'string' || !Number.isFinite(Date.parse(report.generated_at)) ||
    !Array.isArray(report.viewports) || report.viewports.length !== 2) throw new Error('Browser report is missing a passing artifact-bound result');
  for (const expected of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    const view = report.viewports.find(item => item?.name === expected.name);
    if (!view || view.width !== expected.width || view.height !== expected.height || view.pass !== true ||
      !Array.isArray(view.errors) || view.errors.length !== 0 || view.blocked_requests !== 0 ||
      !Array.isArray(view.violations) || view.violations.length !== 0 || !Array.isArray(view.accessibility_incomplete) ||
      view.horizontal_overflow !== false || !Number.isInteger(view.visible_text_length) || view.visible_text_length <= 0 ||
      !Number.isInteger(view.focusable_elements) || view.focusable_elements < 0 || typeof view.keyboard_focus !== 'boolean' ||
      (view.focusable_elements > 0 && view.keyboard_focus !== true) ||
      view.screenshot !== `step_archive/screenshots/verified-${expected.name}.png`) throw new Error('Browser report viewport did not pass measured checks');
  }
  return report.artifact_sha256;
}

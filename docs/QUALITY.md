# Measured quality checks

Harness50 2.2 replaces the old Trust5 directory-presence score with measured checks. Missing tools, nonzero exits, timeouts, missing coverage and changed source never earn partial credit or PASS. These checks do not measure teaching effectiveness or visual taste.

## Project checks

Create `harness50.quality.json` in the generated project. Each command is an executable/argument array, run without shell expansion from the project root. Configure already installed tools. On Windows use Node entry points instead of `.cmd` wrappers.

```json
{
  "schema_version": 1,
  "checks": {
    "test": { "command": ["node", "node_modules/c8/bin/c8.js", "--reporter=json-summary", "node", "--test", "tests/app.test.mjs"] },
    "lint": { "command": ["node", "node_modules/@biomejs/biome/bin/biome", "check", "src"] },
    "typecheck": { "command": ["node", "node_modules/typescript/bin/tsc", "--noEmit", "-p", "jsconfig.json"] },
    "security": { "command": ["semgrep", "scan", "--config", "security-rules.yml", "--error", "--strict", "src"] }
  },
  "coverage": { "path": "coverage/coverage-summary.json", "minimum": 85 }
}
```

The example expects a project-specific test file, type configuration and reviewed local Semgrep rules; it does not install them. Security checks must use meaningful rules. An empty test or `exit 0` does not establish quality. Coverage is calculated from measured covered/total counts for lines, statements, functions and branches, each at least 85%; zero denominators are incomplete. The test command must generate fresh coverage evidence.

Run explicitly with normal host permissions:

```text
node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>"
node "<plugin-root>/scripts/quality-gate.mjs" --inspect --workspace "<project-root>"
```

Each command is bounded to two minutes and 1 MiB output. The report records exit codes without storing raw command output that could contain secrets. Diagnose failures in a normal foreground invocation. Source fingerprints exclude dependencies, Git metadata, coverage and `step_archive`; they include project configuration and final dist files. Changes require another run. Reports go to `step_archive/outputs/quality-gate.json`.

Claude Stop hooks inspect saved evidence at steps 38, 44 and 50 and write `trust5_r1.md`, `trust5_r2.md` and `trust5_r3.md`. They neither execute configured commands nor download tools. Missing or failed evidence requests a repair once; an already active Stop turn is not recursively blocked. Incomplete gates must not be presented as product completion. Codex steps explicitly run the same checks through normal permissions.

## Final browser output

Install the optional browser verifier in a separate checkout, outside the plugin cache:

```text
git clone https://github.com/Technoetic/harness50.git
cd harness50
npm ci
npx playwright install chromium
node scripts/verify-output.mjs --workspace "<project-root>"
```

No hook installs browser packages. The verifier loads the exact `dist/index.html` bytes in fresh Chromium contexts at 1440×900 and 390×844. It blocks network dependencies and WebSockets, reports JavaScript/console errors, detects horizontal overflow, checks initial keyboard focus and runs axe WCAG A/AA checks. It records measured load timing without converting it to a Lighthouse score. The single-file output must include required styles, scripts and assets.

The JSON report is `step_archive/outputs/browser-output.json`, bound to the HTML SHA-256; screenshots are `step_archive/screenshots/verified-desktop.png` and `verified-mobile.png`. Failures return exit code 1. Review axe `accessibility_incomplete` items manually. This smoke check does not exercise every application state: retain application-specific E2E, keyboard, mouse and visual review steps.

Codex completion independently validates final HTML structure and UTF-8 from the same stable handle it hashes. Submitted command results, quality reports and human inspection claims are local evidence, not signed attestations against a process that can rewrite its own project. Do not describe them as independent live-model benchmark results.

## Release verification and product evaluation

`npm test` covers adapter/state/security contracts. `npm run test:browser` checks working and deliberately broken HTML fixtures in a real browser. Rating real generated tutorials also requires multiple topics, repeated full runs, cost/latency records and user evaluation. This release does not fabricate those results.

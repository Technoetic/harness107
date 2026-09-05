# Changelog

## 2.2.0

- Repair Windows PowerShell 5.1 parsing by shipping compatible bytes; test installed scripts without encoding repair copies.
- Register Claude hooks using the native envelope schema and dispatch only the current operating system's shell.
- Resolve Claude project roots from host context, isolate Stop retries by project/session, and consistently use the first unfinished step.
- Limit Claude automatic approval to eligible project edits and WebSearch in valid active workflows. Shell commands and WebFetch retain host permission handling. Protect canonical sensitive paths and versioned plugin cache locations.
- Isolate Codex parent control from subagent prompts, recognize qualified plugin skill names and recover stale empty locks with generation checks.
- Replace directory-presence Trust5 scores with bounded command outcomes, measured coverage and source fingerprints.
- Validate final HTML and provide a Chromium/axe verifier with desktop/mobile reports and screenshots.
- Test Node 22/24 across Windows, Linux and macOS, and pin validation dependencies and CI actions.
- Run CLI entry points through physical path aliases correctly; exercise crash gaps using deterministic fault injection.

This release validates software behavior and deliberately broken output fixtures. It does not claim a live-model tutorial benchmark or guaranteed aesthetic/learning-quality rating.

---
name: harness50-status
description: Use when a user invokes $harness50-status or asks to inspect a Harness50 Codex workflow without changing it.
---

# Harness50 Status

Status is a single observation. It never repairs, imports, resumes, resets, or advances work.

## Resources

Resolve `../../scripts/harness-state.mjs` relative to this SKILL.md, not from the current working directory. Pass the current project directory as the workspace.

## Status operation

For `$harness50-status`, Call only `show` through the state manager. Treat the result as strictly read-only and report it without a follow-up state operation.

## Report

Report the returned fields without inference:

- Always include `active` and `claude_progress_found`.
- For active Codex work, include `status`, `current_step`, `completions.imported`, `completions.codex_verified`, `completions.total`, and `diagnostics` as distinct values.
- Imported historical completion is not Codex verification. Never combine or relabel the two provenance counts.
- When present, surface `import_error.code`, `source_preserved`, and `action`. Explain that the source remains preserved and advise exactly: "repair the Claude state or use a separate workspace".
- No follow-up workflow operation, step execution, or continuation is part of this status request.

Do not infer progress from conversation text or inspect workflow storage directly. The state-manager result is the status authority.

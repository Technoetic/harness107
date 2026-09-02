---
name: harness50-reset
description: Use when a user invokes $harness50-reset or asks to stop the current Harness50 Codex workflow in a recoverable way.
---

# Harness50 Reset

Reset ends Codex control of the current workflow without disturbing the work the workflow produced.

## Resources

Resolve `../../scripts/harness-state.mjs` relative to this SKILL.md, not from the current working directory. Pass the current project directory as the workspace.

## Reset operation

For `$harness50-reset`, Call only `reset` through the state manager to recoverably deactivate only Codex control metadata. If the manager returns an error, report it and stop without a filesystem fallback.

## Preserved data and result

- Report the returned `backupPath` so the deactivated Codex metadata remains recoverable.
- Preserve Claude `step_archive/progress.json`, `TOPIC`, all shared outputs, and all project and application source.
- Leave the workspace contents and Claude-owned progress unchanged; the state manager alone handles Codex control metadata.
- No workflow starts automatically after reset. End the request and report what was preserved. The user chooses the next action explicitly.

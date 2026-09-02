---
name: webapp
description: Use when a user invokes $webapp to start, resume, pause, or advance a Harness50 workflow in Codex.
---

# Harness50 Webapp

Harness50 advances only through the state manager and exactly one manager-selected step per turn.

## Resources

Resolve these installed resources relative to this SKILL.md, not from the current working directory:

- State manager: `../../scripts/harness-state.mjs`
- Codex step selected by the manager: `../../assets/steps/stepNNN.md`

Use the state manager for every workflow mutation. Pass the current project directory as the workspace. Do not derive package paths from environment variables or user-supplied flags.

## `$webapp <topic>`

Run `show` first, then apply this decision table in order. Treat topics as different only when existing state proves the mismatch; do not infer it from wording alone.

| First matching condition | Mutation after `show` | Response |
|---|---|---|
| Existing Codex or Claude work is proven to have a different topic | None | Leave existing work unchanged and advise a separate workspace. |
| No different-topic proof and an active Codex workflow exists | None | Leave it unchanged; do not call `init`; report `$webapp resume`. |
| No different-topic proof, no Codex workflow, and detected Claude progress exists | None | Leave it unchanged; do not call `init`; report `$webapp resume`. |
| No different-topic proof, neither exists, and the supplied topic is a nonempty topic | `init` | Call `init` with that topic, then follow One-step execution. |

An empty topic is not an initialization request. Never pause, reset, reinterpret, or replace existing work to make room for a new topic.

## `$webapp resume`

Run `show`, then apply the first matching branch:

1. When a valid Codex state exists, use it first. Call `reconcile` only when diagnostics indicate receipt recovery is needed, then call `resume` and follow One-step execution for the returned current step.
2. Only if no Codex state exists and Claude progress exists, call `import-claude`, report `imported` historical completions separately from `codex_verified` completions, then call `resume` and follow One-step execution.
3. If import fails, preserve the returned error. Report `import_error.code`, `source_preserved`, and its action; stop without another mutation and advise: "repair the Claude state or use a separate workspace".
4. When neither exists, report that there is nothing to resume and suggest `$webapp <topic>`.

Imported historical completion is not Codex verification. Never merge later Claude changes into an existing Codex workflow.

## `$webapp pause`

Call only `pause`. Report the returned paused status and current step. End the turn without any continuation operation.

## One-step execution

1. Take exactly `state.current_step` from the state-manager result; do not infer or scan for another step.
2. Call `begin` for that step with the manager-issued continuation marker.
3. Read only the exact Codex `../../assets/steps/stepNNN.md` selected by that number, never a Claude source step.
4. Perform that one step and evaluate each required acceptance ID using its declared acceptance kind.
5. On evidenced success, call `complete` with a summary and structured evidence whose IDs and kinds match the step acceptance contract.
6. Otherwise call `fail` with a reason and evidence. Report the failure; do not invent completion.
7. End the handoff. Always execute one step only and never start the next step in the same turn.

## Boundaries and handoff

- Preserve the current Codex sandbox and normal Codex permission confirmations for every tool call. Never loosen, disable, or change the sandbox or approval settings.
- Treat the state-manager result as the workflow authority. Never inspect, open, read, write, or edit workflow state, receipt, event, import, or progress storage directly.
- Session startup may surface context, but it does not execute a step. Explicit start or resume selects the first handoff.
- After one attempted step, only the already-trusted Stop hook may request one next-step marker for a later turn. The manager may use it to advance after success; a failed step may be selected again only in a later turn.
- When the Stop hook is inactive or untrusted, the chain stops safely. Tell the user to invoke `$webapp resume` later.
- This skill must never change or bypass hook trust. A continuation marker changes scheduling, not permissions.

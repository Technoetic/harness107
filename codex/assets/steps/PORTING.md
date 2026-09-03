# Harness50 Codex Step-Porting Contract

This index is a two-phase contract. Every row records the immutable Claude
source path and SHA-256 digest before its Codex target is written. A source
digest mismatch requires review; it never authorizes copying or overwriting a
Codex target.

## Required transformations

- Replace provider and model names with provider-neutral role language.
- Replace Claude tool names with the action or capability being requested.
- Replace `.claude` paths with approved shared `step_archive/` paths or the
  Codex-only `step_archive/.harness50-codex/` path as appropriate.
- Do not use transcripts as completion evidence or derive completion by
  parsing transcripts.
- Do not directly chain to the next step; continuation is owned by Codex
  workflow state and receipts.
- Remove stale references to steps 69, 81, 84, 104, and 107.
- Do not depend on retired validator or checker scripts. Express validation
  as a current command, artifact, or deterministic check instead.

## Index phases

An entry starts as `ported: false` with its identity, source digest, title,
phase, and exact successor. It becomes `ported: true` only when the Codex
target exists and has complete input, output, dependency, network, visual
review, and acceptance metadata.

Acceptance entries use unique stable ids. Each has `kind` (`command`,
`artifact`, or `check`), a boolean `required`, and a deterministic
description. Artifacts declare workspace-relative paths; commands declare a
successful command or command pattern. A required visual review declares both
a screenshot artifact and an inspection check, and remains blocked whenever
visual inspection is unavailable.

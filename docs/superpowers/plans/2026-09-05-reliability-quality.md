# Harness50 Reliability and Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Repair the audited adapter failures and publish reproducible output validation.

**Architecture:** Keep independent Claude and Codex state models. Repair their lifecycle boundaries separately, use shared Node validation for objective quality checks, and retain strict artifact hashing in Codex receipts.

**Tech Stack:** Node.js standard library, PowerShell 5.1, Bash, Chromium/Playwright and axe-core for explicit browser checks.

**Spec:** docs/superpowers/specs/2026-09-05-reliability-quality.md

## Global Constraints

Node.js 22 and 24; Windows PowerShell 5.1; Linux and macOS Bash.
No global configuration edits, model calls or automatic hook trust.
No execution of security regression payloads or arbitrary submitted evidence commands.
Root coordinates commits, integration, versioning and publication; workers own disjoint files.

### Task 1: Claude approval boundaries

**Files:** hooks/auto-approve.{ps1,sh}, hooks/permission-request-guard.{ps1,sh}, related security tests and new shared security helpers as needed.
**Interface:** JSON hook input and existing permission output schema. Defer approval with an empty response whenever active state cannot be established.

- [x] Add regressions for completed, malformed and paused progress, versioned cache paths, and `.claude/subdir/../settings.json`.
- [x] Run the hook subprocess tests and observe the old unsafe approval.
- [x] Validate state and canonical protected paths without executing any payload.
- [x] Run focused security regressions, preserving existing denials.

### Task 2: Installed Claude lifecycle

**Files:** nonsecurity hooks except trust5-validator, codex/tests/claude-regression-copy.{ps1,sh}, new codex/tests/claude-lifecycle.test.mjs.
**Interface:** project root precedence defined in the spec; stdin Stop event; progress.json existing schema. Root owns Trust5 and normalizes any remaining PowerShell encoding after workers finish.

- [x] Reproduce parsing failures from exact shipping bytes and Stop invocation from an unrelated plugin-cache path.
- [x] Repair project resolution, PowerShell encoding and POSIX stop_hook_active handling; scope continuation state to the project.
- [x] Test startup, progress and Stop subprocess behavior without BOM-rewriting execution copies.
- [x] Run lifecycle and existing adapter regressions.

### Task 3: Codex prompt isolation and orphan locks

**Files:** codex/hooks/user-prompt-submit.mjs and shared hook helpers if necessary, codex/scripts/lib/lock.mjs, related hook and lock tests.
**Interface:** existing native hook event fields agent_id/agent_type; existing acquire/release lock API. Keep lock ownership/fencing and receipt format unchanged.

- [x] Add a worker prompt regression and interrupted empty-lock recovery tests.
- [x] Confirm worker prompt currently pauses its parent and orphan directory times out.
- [x] Ignore worker prompts for parent control, recognize qualified skill names, and implement conservative identity-checked orphan reclamation.
- [x] Run all hook and lock race regressions.

### Task 4: Objective quality and final artifact checks

**Files:** scripts/quality-gate.mjs, scripts/verify-output.mjs, scripts/lib validation helpers, hooks/trust5-validator.{ps1,sh}, codex/scripts/lib/acceptance.mjs, package.json/package-lock.json, tests and step instructions.
**Interfaces:** explicit command-line workspace argument; JSON result with schema_version, verdict, checked file hashes and per-check exit/result data. Hooks consume/produce evidence without downloading tooling. Codex HTML acceptance validates the same stable bytes it hashes.

- [x] Add failing tests for empty/invalid final HTML and bogus quality reports/directories.
- [x] Replace proxy scoring with strict measured status and bounded explicit checks.
- [x] Add explicit Chromium verifier and good/bad HTML fixtures; assert runtime/accessibility failures cannot pass.
- [x] Run the browser fixtures and update both adapters' instructions with the actual commands and limitations.

### Task 5: Integration, review and release

**Files:** .github/workflows/test.yml, README.md, codex/README.md, plugin manifests, changelog and release evidence.

- [x] Extend CI to Windows/Linux/macOS and Node 22/24, including exact-byte Claude tests and browser checks.
- [ ] Run complete tests and an independent code review, fixing substantive findings.
- [x] Update install documentation and synchronized version metadata.
- [ ] Push a reviewable PR, wait for remote CI, merge and publish the release with archive checksum.
- [ ] Verify remote package discovery without changing global trust; record actual results and remaining product-evaluation limits.

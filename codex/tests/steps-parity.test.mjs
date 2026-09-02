import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../scripts/lib/errors.mjs";
import * as stepValidator from "../scripts/validate-steps.mjs";

const runFile = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const validatorPath = join(repoRoot, "codex", "scripts", "validate-steps.mjs");

async function fixtureRoot(t, { includeCli = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness50-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "codex", "assets"), { recursive: true });
  await cp(join(repoRoot, "assets", "steps"), join(root, "assets", "steps"), { recursive: true });
  await cp(join(repoRoot, "codex", "assets", "steps"), join(root, "codex", "assets", "steps"), {
    recursive: true
  });
  if (includeCli) {
    await mkdir(join(root, "codex", "scripts", "lib"), { recursive: true });
    await cp(validatorPath, join(root, "codex", "scripts", "validate-steps.mjs"));
    await cp(
      join(repoRoot, "codex", "scripts", "lib", "errors.mjs"),
      join(root, "codex", "scripts", "lib", "errors.mjs")
    );
  }
  return root;
}

async function loadFixtureIndex(root) {
  return JSON.parse(await readFile(join(root, "codex", "assets", "steps", "index.json"), "utf8"));
}

async function writeFixtureIndex(root, index) {
  await writeFile(
    join(root, "codex", "assets", "steps", "index.json"),
    `${JSON.stringify(index)}\n`
  );
}

async function assertIndexMutationRejected(root, base, mutate, expected) {
  const index = structuredClone(base);
  mutate(index);
  await writeFixtureIndex(root, index);
  await assert.rejects(() => stepValidator.validateRepositoryParity(root), expected);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("repository parity validates the complete checked-in fifty-step map", async () => {
  assert.equal(typeof stepValidator.validateRepositoryParity, "function");
  const report = await stepValidator.validateRepositoryParity(repoRoot);
  assert.deepEqual(
    report.steps.map((step) => step.number),
    Array.from({ length: 50 }, (_, offset) => offset + 1)
  );
  assert.ok(report.steps.every((step) => step.ported === true));
});

test("closed index schemas reject unknown, missing, and kind-inappropriate fields", async (t) => {
  const root = await fixtureRoot(t);
  const base = await loadFixtureIndex(root);
  const cases = [
    ["top-level extra key", (index) => { index.generated = true; }, /top-level.*keys/i],
    ["top-level missing key", (index) => { delete index.schema_version; }, /top-level.*keys|schema_version/i],
    ["row extra key", (index) => { index.steps[0].legacy = true; }, /step001.*keys/i],
    ["row missing key", (index) => { delete index.steps[0].network; }, /step001.*keys|network/i],
    ["acceptance extra key", (index) => { index.steps[0].acceptance[0].legacy = true; }, /acceptance.*keys/i],
    ["artifact missing path", (index) => { delete index.steps[0].acceptance[0].path; }, /acceptance.*keys|path/i],
    ["check with path", (index) => { index.steps[0].acceptance.at(-1).path = "step_archive/x"; }, /acceptance.*keys/i],
    ["command with both declarations", (index) => {
      index.steps[0].acceptance[2].command_pattern = "^node --version$";
    }, /exactly one|acceptance.*keys/i],
    ["command without a declaration", (index) => { delete index.steps[0].acceptance[2].command; }, /command.*(?:declaration|keys)/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => assertIndexMutationRejected(root, base, mutate, expected));
  }
});

test("row order, canonical identities, next pointers, and phase boundaries are exact", async (t) => {
  const root = await fixtureRoot(t);
  const base = await loadFixtureIndex(root);
  const cases = [
    ["out-of-order rows", (index) => { [index.steps[0], index.steps[1]] = [index.steps[1], index.steps[0]]; }, /position|order/i],
    ["noncanonical id", (index) => { index.steps[0].id = "step01"; }, /canonical id/i],
    ["noncanonical source", (index) => { index.steps[0].source = "assets/steps/step002.md"; }, /source.*canonical/i],
    ["noncanonical target", (index) => { index.steps[0].target = "codex/assets/steps/step002.md"; }, /target.*canonical/i],
    ["wrong next", (index) => { index.steps[20].next = "step023"; }, /next/i],
    ["wrong phase boundary", (index) => { index.steps[20].phase = "planning"; }, /phase/i],
    ["not ported", (index) => { index.steps[49].ported = false; }, /step050.*ported/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => assertIndexMutationRejected(root, base, mutate, expected));
  }
});

test("source and target directories contain exactly the canonical regular step files", async (t) => {
  await t.test("extra source step", async (st) => {
    const root = await fixtureRoot(st);
    await writeFile(join(root, "assets", "steps", "step051.md"), "extra\n");
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /unexpected.*step051/i);
  });
  await t.test("extra target file", async (st) => {
    const root = await fixtureRoot(st);
    await writeFile(join(root, "codex", "assets", "steps", "rogue.md"), "extra\n");
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /unexpected.*rogue/i);
  });
  await t.test("missing source", async (st) => {
    const root = await fixtureRoot(st);
    await rm(join(root, "assets", "steps", "step021.md"));
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /missing.*step021/i);
  });
  await t.test("missing target", async (st) => {
    const root = await fixtureRoot(st);
    await rm(join(root, "codex", "assets", "steps", "step022.md"));
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /missing.*step022/i);
  });
  await t.test("directory in place of target", async (st) => {
    const root = await fixtureRoot(st);
    const target = join(root, "codex", "assets", "steps", "step023.md");
    await rm(target);
    await mkdir(target);
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /regular file.*step023|step023.*regular file/i);
  });
  await t.test("symbolic link in place of source", async (st) => {
    const root = await fixtureRoot(st);
    const target = join(root, "assets", "steps", "step024.md");
    await rm(target);
    try {
      await symlink("step025.md", target, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        const junctionTarget = join(root, "junction-target");
        await mkdir(junctionTarget);
        await symlink(junctionTarget, target, "junction");
      } else {
        throw error;
      }
    }
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    await assert.rejects(() => stepValidator.validateRepositoryParity(root), /symbolic link.*step024|step024.*symbolic link/i);
  });
});

test("target frontmatter and sole H1 exactly match index identity, phase, and title", async (t) => {
  const cases = [
    ["frontmatter name", "name: step021", "name: step020", /step021.*frontmatter.*name/i],
    ["frontmatter phase", "phase: research", "phase: review", /step021.*frontmatter.*phase/i],
    ["extra frontmatter field", "phase: research", "phase: research\nlegacy: true", /frontmatter.*keys/i],
    ["duplicate frontmatter key", "phase: research", "phase: research\nphase: research", /duplicate.*frontmatter|frontmatter.*duplicate/i],
    ["H1 number", "# Step 21 - 의존성 게이트 검증", "# Step 20 - 의존성 게이트 검증", /step021.*H1/i],
    ["H1 title", "# Step 21 - 의존성 게이트 검증", "# Step 21 - 다른 제목", /step021.*H1/i],
    ["second H1", "## 목표", "# Unexpected heading\n\n## 목표", /exactly one H1/i]
  ];
  for (const [name, from, to, expected] of cases) {
    await t.test(name, async (st) => {
      const root = await fixtureRoot(st);
      const target = join(root, "codex", "assets", "steps", "step021.md");
      const original = await readFile(target, "utf8");
      const mutation = original.replace(from, to);
      assert.notEqual(mutation, original);
      await writeFile(target, mutation);
      await assert.rejects(() => stepValidator.validateRepositoryParity(root), expected);
    });
  }
});

test("declared paths are portable, normalized, and collision-free", async (t) => {
  const root = await fixtureRoot(t);
  const base = await loadFixtureIndex(root);
  const invalidPaths = [
    ["parent traversal", "../escape.md"],
    ["POSIX absolute", "/escape.md"],
    ["Windows absolute", "C:/escape.md"],
    ["backslash", "step_archive\\escape.md"],
    ["empty segment", "step_archive//escape.md"],
    ["dot segment", "step_archive/./escape.md"],
    ["non-NFC", "step_archive/cafe\u0301.md"],
    ["Windows-invalid colon", "step_archive/bad:name.md"],
    ["Windows-invalid wildcard", "step_archive/bad*.md"],
    ["Windows-invalid trailing dot", "step_archive/bad./report.md"]
  ];
  for (const [name, value] of invalidPaths) {
    await t.test(name, () => assertIndexMutationRejected(root, base, (index) => {
      index.steps[0].outputs[0] = value;
    }, /portable|normalized|path/i));
  }
  await t.test("case-folded collision", () => assertIndexMutationRejected(root, base, (index) => {
    index.steps[1].outputs.push("STEP_ARCHIVE/STEP001_PREFLIGHT.MD");
  }, /collision/i));
  await t.test("duplicate input within one list", () => assertIndexMutationRejected(root, base, (index) => {
    index.steps[0].inputs.push(index.steps[0].inputs[0]);
  }, /duplicate/i));
  await t.test("duplicate output within one row", () => assertIndexMutationRejected(root, base, (index) => {
    index.steps[0].outputs.push(index.steps[0].outputs[0]);
  }, /duplicate/i));
  await t.test("artifact path portability", () => assertIndexMutationRejected(root, base, (index) => {
    index.steps[0].acceptance[0].path = "..\\outside.md";
  }, /portable|path/i));
});

test("the dependency graph has unique owners and direct, used, prior dependencies", async (t) => {
  const root = await fixtureRoot(t);
  const base = await loadFixtureIndex(root);
  const cases = [
    ["duplicate output owner", (index) => { index.steps[1].outputs[0] = index.steps[0].outputs[0]; }, /output.*owner|duplicate output/i],
    ["reserved topic output", (index) => { index.steps[0].outputs[0] = "step_archive/TOPIC/TOPIC.md"; }, /reserved.*initial|initial.*output/i],
    ["reserved package output", (index) => { index.steps[0].outputs[0] = "package.json"; }, /reserved.*initial|initial.*output/i],
    ["unapproved initial input", (index) => { index.steps[0].inputs.push("README.md"); }, /input.*(?:unresolved|initial)/i],
    ["future input", (index) => { index.steps[1].inputs.push(index.steps[2].outputs[0]); }, /future.*input|input.*future/i],
    ["missing direct owner", (index) => { index.steps[1].requires = []; }, /directly require|owner/i],
    ["unused required dependency", (index) => { index.steps[3].requires.push("step001"); }, /unused|required.*input/i],
    ["future required dependency", (index) => { index.steps[0].requires.push("step002"); }, /requires.*prior/i],
    ["current optional dependency", (index) => { index.steps[0].optional_requires.push("step001"); }, /optional.*prior/i],
    ["future optional dependency", (index) => { index.steps[0].optional_requires.push("step002"); }, /optional.*prior/i],
    ["duplicate optional dependency", (index) => { index.steps[15].optional_requires.push("step011"); }, /optional_requires.*duplicate/i],
    ["required and optional overlap", (index) => { index.steps[15].requires.push("step011"); }, /disjoint|both required and optional/i],
    ["unknown dependency id", (index) => { index.steps[1].optional_requires.push("step999"); }, /optional.*canonical|dependency/i],
    ["output without artifact acceptance", (index) => { index.steps[0].acceptance[1].path = "step_archive/other.md"; }, /output.*artifact acceptance/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => assertIndexMutationRejected(root, base, mutate, expected));
  }
});

test("acceptance evidence rejects duplicate ids, unsafe patterns, and fake visual review", async (t) => {
  const root = await fixtureRoot(t);
  const base = await loadFixtureIndex(root);
  const cases = [
    ["duplicate acceptance id", (index) => { index.steps[0].acceptance[1].id = index.steps[0].acceptance[0].id; }, /acceptance ids.*unique/i],
    ["unanchored command pattern", (index) => { index.steps[5].acceptance[0].command_pattern = "npm test"; }, /anchored/i],
    ["invalid command pattern", (index) => { index.steps[5].acceptance[0].command_pattern = "^(unterminated$"; }, /valid regular expression|pattern.*invalid/i],
    ["escaped final dollar", (index) => { index.steps[5].acceptance[0].command_pattern = "^npm test\\$"; }, /anchored/i],
    ["top-level alternation", (index) => { index.steps[5].acceptance[0].command_pattern = "^npm test$|^pnpm test$"; }, /top-level alternation/i],
    ["fake visual flag", (index) => {
      index.steps[20].visual_review = true;
      index.steps[20].outputs.push("step_archive/screenshots/fake.png");
      index.steps[20].acceptance.push({
        id: "visual-inspection",
        kind: "artifact",
        required: true,
        description: "Stores a fake visual inspection screenshot.",
        path: "step_archive/screenshots/fake.png"
      });
    }, /visual_review.*exact|visual.*set/i],
    ["missing visual screenshot", (index) => {
      index.steps[21].acceptance.find((item) => item.id === "awwwards-screenshot-primary").required = false;
    }, /visual_review.*screenshot/i],
    ["missing visual inspection", (index) => {
      const item = index.steps[21].acceptance.find((entry) => entry.id === "visual-capture-inspection");
      item.id = "ordinary-check";
      item.description = "Confirms ordinary deterministic evidence.";
    }, /visual_review.*inspection/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => assertIndexMutationRejected(root, base, mutate, expected));
  }
});

test("source drift raises a structured review-required error without rewriting index or target", async (t) => {
  const root = await fixtureRoot(t);
  const source = join(root, "assets", "steps", "step021.md");
  const indexPath = join(root, "codex", "assets", "steps", "index.json");
  const target = join(root, "codex", "assets", "steps", "step021.md");
  const indexBefore = await readFile(indexPath);
  const targetBefore = await readFile(target);
  const sourceAfter = Buffer.concat([await readFile(source), Buffer.from("\nsource drift\n")]);
  await writeFile(source, sourceAfter);

  await assert.rejects(
    () => stepValidator.validateRepositoryParity(root),
    (error) => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, "SOURCE_CHANGED_REVIEW_REQUIRED");
      assert.deepEqual(error.details, {
        source: "assets/steps/step021.md",
        expected: "c36004a40bd93ed6bc79043cd7120629f2f71e6582feb89ca3e3a6d20cc7da54",
        actual: sha256(sourceAfter)
      });
      return true;
    }
  );
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.deepEqual(await readFile(target), targetBefore);
});

test("visual set and representative boundary contracts stay repository-executable", async () => {
  const { steps } = await stepValidator.validateRepositoryParity(repoRoot);
  assert.deepEqual(
    steps.filter((step) => step.visual_review).map((step) => step.number),
    [22, 23, 24, 29, 37, 39, 40, 43, 46, 47, 48, 49]
  );
  const summarize = (number) => {
    const step = steps[number - 1];
    return {
      number: step.number,
      phase: step.phase,
      network: step.network,
      visual_review: step.visual_review,
      next: step.next,
      acceptance_ids: step.acceptance.map((item) => item.id)
    };
  };
  assert.deepEqual(
    [1, 16, 21, 22, 30, 38, 45, 50].map((number) => summarize(number)),
    [
      { number: 1, phase: "preflight", network: true, visual_review: false, next: "step002", acceptance_ids: ["topic-contract", "preflight-report", "node-runtime-version", "npm-cli-version", "required-tool-inventory", "optional-tool-disposition"] },
      { number: 16, phase: "research", network: true, visual_review: false, next: "step017", acceptance_ids: ["research-chunk-1", "research-raw-primary", "research-screenshot-primary", "research-attribution", "research-chunks-bounded", "code-baseline-disposition", "tokei-baseline"] },
      { number: 21, phase: "research", network: false, visual_review: false, next: "step022", acceptance_ids: ["step001-preflight-artifact", "dependency-gate-status", "step001-receipt-and-artifact", "project-conditional-prerequisites", "optional-step-deps"] },
      { number: 22, phase: "research", network: true, visual_review: true, next: "step023", acceptance_ids: ["awwwards-collection-chunk-1", "awwwards-raw-primary", "awwwards-screenshot-primary", "selected-url-input", "capture-attribution", "visual-capture-inspection", "bounded-capture-scope"] },
      { number: 30, phase: "planning", network: false, visual_review: false, next: "step031", acceptance_ids: ["design-alternatives", "design-selection", "layout-design-chunk-1", "overall-design-chunk-1", "final-design-verification", "structured-brainstorming-first", "independent-selector", "class-architecture-contract", "async-lifecycle-contract", "responsive-accessibility-contract", "design-chunks-bounded", "pass-verdict"] },
      { number: 38, phase: "implementation", network: false, visual_review: false, next: "step039", acceptance_ids: ["build-smoke-report", "implementation-milestone", "dist-index-html", "project-build-command", "dist-html-boundary", "zero-cycle-gate", "advisory-diagnostics", "pass-only-build-gate"] },
      { number: 45, phase: "e2e", network: true, visual_review: false, next: "step046", acceptance_ids: ["e2e-test-report", "project-e2e-command", "local-playwright-only", "bounded-browser-readiness", "dynamic-scenario-coverage", "edge-case-coverage", "independent-e2e-verifier", "bounded-pass-loop"] },
      { number: 50, phase: "e2e", network: false, visual_review: false, next: null, acceptance_ids: ["console-error-report", "final-quality-milestone", "final-dist-index-html", "console-errors-zero", "final-build", "final-dist-html-boundary", "reachable-state-manifest", "warning-classification", "bounded-settle-no-fixed-sleep", "secret-redaction", "independent-console-verifier", "receipt-first-completion", "pass-only-final-milestone"] }
    ]
  );
  const step50 = steps[49];
  assert.deepEqual(
    step50.acceptance.filter((item) => ["console-errors-zero", "final-build"].includes(item.id))
      .map((item) => [item.id, item.kind, item.required]),
    [["console-errors-zero", "check", true], ["final-build", "command", true]]
  );
});

test("CLI defaults to the full gate, keeps range batching, and rejects every extra argument", async (t) => {
  const defaultRun = await runFile(process.execPath, [validatorPath], { cwd: repoRoot });
  assert.equal(defaultRun.stdout, "validated 50 indexed step(s)\n");
  const rangeRun = await runFile(process.execPath, [validatorPath, "--range", "21:22"], { cwd: repoRoot });
  assert.equal(rangeRun.stdout, "validated 2 indexed step(s)\n");

  for (const args of [
    ["--unknown"],
    ["--write"],
    ["--refresh-hashes"],
    ["--range", "1:2", "extra"],
    ["--range", "1:2", "--range", "3:4"],
    ["--range"]
  ]) {
    await t.test(`rejects ${args.join(" ")}`, async () => {
      await assert.rejects(
        () => runFile(process.execPath, [validatorPath, ...args], { cwd: repoRoot }),
        (error) => error.code !== 0 && /argument|usage|range/i.test(error.stderr)
      );
    });
  }
});

test("default CLI requires 50/50 while range validates only its selected porting batch", async (t) => {
  const root = await fixtureRoot(t, { includeCli: true });
  const index = await loadFixtureIndex(root);
  index.steps[49].ported = false;
  await writeFixtureIndex(root, index);
  const script = join(root, "codex", "scripts", "validate-steps.mjs");

  await assert.rejects(
    () => runFile(process.execPath, [script], { cwd: root }),
    (error) => error.code !== 0 && /step050.*ported/i.test(error.stderr)
  );
  const rangeRun = await runFile(process.execPath, [script, "--range", "1:1"], { cwd: root });
  assert.equal(rangeRun.stdout, "validated 1 indexed step(s)\n");
});

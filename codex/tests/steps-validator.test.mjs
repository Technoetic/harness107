import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadIndex,
  recordSourceHashes,
  scanForbiddenTokens,
  validateIndex,
  validateStepBatch
} from "../scripts/validate-steps.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function entry(number, overrides = {}) {
  const id = `step${String(number).padStart(3, "0")}`;
  return {
    number,
    id,
    title: `Step ${number}`,
    phase: "preflight",
    source: `assets/steps/${id}.md`,
    target: `codex/assets/steps/${id}.md`,
    source_sha256: "a".repeat(64),
    ported: false,
    next: number === 50 ? null : `step${String(number + 1).padStart(3, "0")}`,
    ...overrides
  };
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "harness50-steps-"));
  await mkdir(join(root, "assets", "steps"), { recursive: true });
  return root;
}

async function portedFixture({ acceptance, visualReview = false } = {}) {
  const root = await fixtureRoot();
  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  const steps = Array.from({ length: 50 }, (_, offset) => entry(offset + 1, {
    inputs: [],
    outputs: [],
    requires: [],
    optional_requires: [],
    network: false,
    visual_review: visualReview,
    acceptance: acceptance ?? [{
      id: "completion-check",
      kind: "check",
      required: true,
      description: "Records deterministic completion evidence."
    }],
    ported: true
  }));
  for (const step of steps) {
    await writeFile(join(root, step.source), `source ${step.number}\n`);
    await writeFile(join(root, step.target), "Use available capabilities.\n");
  }
  const hashes = await recordSourceHashes(root, steps);
  for (const step of steps) step.source_sha256 = hashes[step.id];
  return { root, index: { schema_version: 1, steps } };
}

function parseStepDocument(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  const frontmatterMatch = /^---\n([^]*?)\n---(?:\n|$)/.exec(normalized);
  assert.ok(frontmatterMatch, "step document is missing frontmatter");
  const frontmatter = Object.fromEntries(frontmatterMatch[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const titleMatches = [...normalized.matchAll(/^# Step (\d+) - (.+)$/gm)];

  return {
    frontmatter,
    titles: titleMatches.map((match) => ({
      number: Number(match[1]),
      title: match[2]
    })),
    referencedSteps: [...normalized.matchAll(/\bStep\s+(\d+)\b/g)].map((match) => Number(match[1]))
  };
}

test("map covers every source step with canonical boundaries", async () => {
  const index = await loadIndex(repoRoot);
  const report = validateIndex(index, { repoRoot, requirePorted: false });

  assert.deepEqual(
    report.steps.map((step) => step.number),
    Array.from({ length: 50 }, (_, offset) => offset + 1)
  );
  assert.equal(report.steps[0].source, "assets/steps/step001.md");
  assert.equal(report.steps[0].target, "codex/assets/steps/step001.md");
  assert.equal(report.steps.at(-1).next, null);
  assert.ok(report.steps.every((step) => typeof step.ported === "boolean"));
});

test("index records SHA-256 digests of the unmodified Claude source bytes", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(0, 5));

  assert.deepEqual(hashes, {
    step001: "e7fbe24200dee3a8435b87cb16fed16e056be8c75c329bb635adec1df3e31849",
    step002: "3138e7a161fe488b3c1777da7e72820d1c5d3faa992380f1cbd73a74103b3e89",
    step003: "403cd2247bdde3081e1e07b4dbb066760365a175847c782fb169f170151ab929",
    step004: "a262f19f844065a166f179983ff4a6e8414c3b6e347265434bd0626939d9af10",
    step005: "2d7d31b3e3b0390c58c3d0aac01ea96a697eb6bc18a84fdc981363eba35e1a30"
  });
});

test("preflight batch declares the exact Codex-native step contracts", async () => {
  const report = await validateStepBatch(repoRoot, [1, 2, 3, 4, 5]);

  assert.deepEqual(report.steps, [
    {
      number: 1,
      id: "step001",
      title: "하네스 프리플라이트 체크",
      phase: "preflight",
      source: "assets/steps/step001.md",
      target: "codex/assets/steps/step001.md",
      source_sha256: "e7fbe24200dee3a8435b87cb16fed16e056be8c75c329bb635adec1df3e31849",
      inputs: ["step_archive/TOPIC/TOPIC.md"],
      outputs: ["step_archive/step001_preflight.md"],
      requires: [],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "topic-contract",
          kind: "artifact",
          required: true,
          description: "Verifies the existing immutable tutorial topic input has required fields and matches the stated topic and constraints without modification.",
          path: "step_archive/TOPIC/TOPIC.md"
        },
        {
          id: "preflight-report",
          kind: "artifact",
          required: true,
          description: "Records required and optional tool availability without storing secrets.",
          path: "step_archive/step001_preflight.md"
        },
        {
          id: "node-runtime-version",
          kind: "command",
          required: true,
          description: "Confirms that the Node.js runtime is available.",
          command: "node --version"
        },
        {
          id: "npm-cli-version",
          kind: "command",
          required: true,
          description: "Confirms that the npm CLI is available.",
          command: "npm --version"
        },
        {
          id: "required-tool-inventory",
          kind: "check",
          required: true,
          description: "Confirms every required tool is available after at most three permitted attempts; diagnostic failures never satisfy this acceptance."
        },
        {
          id: "optional-tool-disposition",
          kind: "check",
          required: true,
          description: "Records each optional tool as OK or an explicit safe SKIP with a reason."
        }
      ],
      ported: true,
      next: "step002"
    },
    {
      number: 2,
      id: "step002",
      title: "프로젝트 분석 및 Context 전략 수립",
      phase: "preflight",
      source: "assets/steps/step002.md",
      target: "codex/assets/steps/step002.md",
      source_sha256: "3138e7a161fe488b3c1777da7e72820d1c5d3faa992380f1cbd73a74103b3e89",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step001_preflight.md"
      ],
      outputs: ["step_archive/step002_context전략_chunk1.md"],
      requires: ["step001"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        {
          id: "context-strategy-chunk-1",
          kind: "artifact",
          required: true,
          description: "Stores the first bounded context-strategy chunk and a manifest for any additional chunks.",
          path: "step_archive/step002_context전략_chunk1.md"
        },
        {
          id: "project-scale-recorded",
          kind: "check",
          required: true,
          description: "Records project scale, relevant file counts, and the largest relevant files."
        },
        {
          id: "context-chunks-bounded",
          kind: "check",
          required: true,
          description: "Confirms every declared context-strategy chunk is at most 500 lines."
        }
      ],
      ported: true,
      next: "step003"
    },
    {
      number: 3,
      id: "step003",
      title: "Playwright 환경 테스트",
      phase: "preflight",
      source: "assets/steps/step003.md",
      target: "codex/assets/steps/step003.md",
      source_sha256: "403cd2247bdde3081e1e07b4dbb066760365a175847c782fb169f170151ab929",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: [
        "step_archive/step003_playwright_test.md",
        "step_archive/screenshots/step003_playwright_smoke.png"
      ],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "playwright-chromium-smoke",
          kind: "command",
          required: true,
          description: "Captures a Chromium smoke screenshot of a blank page.",
          command: "npx playwright screenshot --browser chromium about:blank step_archive/screenshots/step003_playwright_smoke.png"
        },
        {
          id: "playwright-smoke-screenshot",
          kind: "artifact",
          required: true,
          description: "Stores the Chromium smoke-test screenshot.",
          path: "step_archive/screenshots/step003_playwright_smoke.png"
        },
        {
          id: "playwright-environment-report",
          kind: "artifact",
          required: true,
          description: "Records Playwright and Chromium availability plus the smoke-command outcome.",
          path: "step_archive/step003_playwright_test.md"
        }
      ],
      ported: true,
      next: "step004"
    },
    {
      number: 4,
      id: "step004",
      title: "@axe-core/playwright 환경 설치",
      phase: "preflight",
      source: "assets/steps/step004.md",
      target: "codex/assets/steps/step004.md",
      source_sha256: "a262f19f844065a166f179983ff4a6e8414c3b6e347265434bd0626939d9af10",
      inputs: ["step_archive/step003_playwright_test.md"],
      outputs: ["step_archive/step004_axe_core_test.md"],
      requires: ["step003"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "axe-package-resolves",
          kind: "command",
          required: true,
          description: "Confirms that the accessibility package resolves from the project.",
          command: "node -e \"require.resolve('@axe-core/playwright')\""
        },
        {
          id: "axe-environment-report",
          kind: "artifact",
          required: true,
          description: "Records accessibility-package availability and compatibility findings.",
          path: "step_archive/step004_axe_core_test.md"
        },
        {
          id: "axe-playwright-compatibility",
          kind: "check",
          required: true,
          description: "Confirms compatibility with the detected Playwright environment."
        }
      ],
      ported: true,
      next: "step005"
    },
    {
      number: 5,
      id: "step005",
      title: "c8 코드 커버리지 환경 설치",
      phase: "preflight",
      source: "assets/steps/step005.md",
      target: "codex/assets/steps/step005.md",
      source_sha256: "2d7d31b3e3b0390c58c3d0aac01ea96a697eb6bc18a84fdc981363eba35e1a30",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step005_c8_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "c8-version",
          kind: "command",
          required: true,
          description: "Confirms that the c8 CLI is available.",
          command: "npx c8 --version"
        },
        {
          id: "c8-environment-report",
          kind: "artifact",
          required: true,
          description: "Records c8 availability and the version-command outcome.",
          path: "step_archive/step005_c8_test.md"
        }
      ],
      ported: true,
      next: "step006"
    }
  ]);
});

test("preflight outputs have required artifact evidence and safe step instructions", async () => {
  const report = await validateStepBatch(repoRoot, [1, 2, 3, 4, 5]);

  for (const step of report.steps) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }

    const instructions = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(instructions), []);
    assert.doesNotMatch(instructions, /(?:progress|state)\.json|\.harness50-codex/i);
    assert.doesNotMatch(instructions, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(instructions, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
  }
});

test("preflight documents bind exact frontmatter and titles to only their current step", async () => {
  const expected = [
    { name: "step001", phase: "preflight", number: 1, title: "하네스 프리플라이트 체크" },
    { name: "step002", phase: "preflight", number: 2, title: "프로젝트 분석 및 Context 전략 수립" },
    { name: "step003", phase: "preflight", number: 3, title: "Playwright 환경 테스트" },
    { name: "step004", phase: "preflight", number: 4, title: "@axe-core/playwright 환경 설치" },
    { name: "step005", phase: "preflight", number: 5, title: "c8 코드 커버리지 환경 설치" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: item.phase },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("step001 treats the topic artifact as immutable and fails closed when it is inadequate", async () => {
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step001.md"),
    "utf8"
  );
  const topicSection = /## 1\. 튜토리얼 주제 점검\n([^]*?)\n## 2\./.exec(content)?.[1];

  assert.ok(topicSection, "step001 is missing its topic-input section");
  assert.match(topicSection, /읽기 전용\s+입력/);
  assert.match(topicSection, /절대 수정하지 않는다/);
  assert.match(topicSection, /누락되었거나[^]*불충분[^]*단계를 실패로 처리/);
  assert.match(topicSection, /파일 바이트를 변경하지 않은 채[^]*보고서/);
  assert.doesNotMatch(
    topicSection,
    /(?:기록한다|작성한다|생성한다|수정한다|보완한다|정규화한다|갱신한다|덮어쓴다)/
  );
  assert.doesNotMatch(
    topicSection,
    /\b(?:create|write|edit|amend|update|normalize|overwrite)\b/i
  );
  assert.doesNotMatch(
    topicSection,
    /(?:기록|작성|생성|보완|정규화|갱신|덮어쓰|업데이트)(?:한다|하라|하세요|해라|하십시오)/
  );
  assert.doesNotMatch(topicSection, /수정(?!하지|\s*금지)/);
});

test("step001 never accepts a diagnostic failure as required-tool evidence", async () => {
  const index = await loadIndex(repoRoot);
  const requiredInventory = index.steps[0].acceptance.find(
    (item) => item.id === "required-tool-inventory"
  );
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step001.md"),
    "utf8"
  );

  assert.deepEqual(requiredInventory, {
    id: "required-tool-inventory",
    kind: "check",
    required: true,
    description: "Confirms every required tool is available after at most three permitted attempts; diagnostic failures never satisfy this acceptance."
  });
  assert.match(content, /필수 도구가 모두\s+실제로 사용 가능/);
  assert.match(content, /하나라도 사용할 수\s+없으면[^]*`required-tool-inventory`[^]*`ok: true`[^]*제출하지\s+않는다/);
  assert.match(content, /차단 또는 실패 보고서는 진단 자료일 뿐[^]*수락 증거가 아니다/);
  assert.match(content, /`SKIP`은 선택 도구에만 허용/);
  assert.doesNotMatch(
    content,
    /`required-tool-inventory`:[^\n]*(?:차단|실패)(?:\s|.){0,80}(?:충족|수락|완료)/
  );
});

test("validator rejects provider-specific and stale runtime tokens", () => {
  const diagnostics = scanForbiddenTokens(
    "Use Haiku, WebFetch, .claude/state and then read step081.md"
  );

  assert.deepEqual(diagnostics.map((item) => item.code), [
    "MODEL_SPECIFIC",
    "TOOL_SPECIFIC",
    "CLAUDE_PATH",
    "STALE_STEP"
  ]);
  assert.deepEqual(
    scanForbiddenTokens("run build-validator.ps1").map((item) => item.code),
    ["RETIRED_VALIDATOR"]
  );
  assert.deepEqual(
    scanForbiddenTokens("use read to inspect Step 81 and steps 69").map((item) => item.code),
    ["TOOL_SPECIFIC", "STALE_STEP"]
  );
});

test("index rejects invalid phases", () => {
  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: Array.from({ length: 50 }, (_, offset) => entry(offset + 1, {
      phase: offset === 0 ? "unknown" : "preflight"
    }))
  }, { repoRoot, requirePorted: false }), /phase/);
});

test("index reports the missing number in a 50-row duplicate-number map", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps[1] = structuredClone(invalid.steps[2]);

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /index has a gap at step 2/
  );
});

test("index rejects an invalid final next pointer", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps.at(-1).next = "step001";

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /step050.next must be null/
  );
});

test("index rejects source drift without changing a Codex target", async () => {
  const index = await loadIndex(repoRoot);
  const invalid = structuredClone(index);
  invalid.steps[0].source_sha256 = "0".repeat(64);
  const targetPath = join(repoRoot, invalid.steps[0].target);
  const before = await readFile(targetPath);

  assert.throws(
    () => validateIndex(invalid, { repoRoot, requirePorted: false }),
    /SOURCE_CHANGED_REVIEW_REQUIRED/
  );
  assert.deepEqual(await readFile(targetPath), before);
});

test("unported entries do not require targets but ported entries require complete metadata", async () => {
  const root = await fixtureRoot();
  const source = join(root, "assets", "steps", "step001.md");
  await writeFile(source, "source bytes\n");
  const hash = (await recordSourceHashes(root, [entry(1)])).step001;
  const base = entry(1, {
    source_sha256: hash
  });
  const steps = Array.from({ length: 50 }, (_, offset) => {
    const number = offset + 1;
    return entry(number, number === 1 ? base : { source_sha256: hash });
  });
  for (const step of steps.slice(1)) {
    await writeFile(join(root, step.source), "source bytes\n");
  }

  assert.doesNotThrow(() => validateIndex({ schema_version: 1, steps }, {
    repoRoot: root,
    requirePorted: false
  }));

  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: steps.map((step, index) => index === 0 ? { ...step, ported: true } : step)
  }, { repoRoot: root, requirePorted: true }), /missing Codex step/);

  await mkdir(join(root, "codex", "assets", "steps"), { recursive: true });
  for (const step of steps) {
    await writeFile(join(root, step.target), "safe Codex instructions\n");
  }
  assert.throws(() => validateIndex({
    schema_version: 1,
    steps: steps.map((step) => ({ ...step, ported: true }))
  }, { repoRoot: root, requirePorted: true }), /step001.inputs/);
});

test("ported entries require targets and final metadata even when requirePorted is false", async () => {
  const { root, index } = await portedFixture();
  await rm(join(root, index.steps[0].target));

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /missing Codex step/
  );

  await writeFile(join(root, index.steps[0].target), "Use available capabilities.\n");
  index.steps[0].inputs = undefined;

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /step001.inputs/
  );
});

test("ported artifact paths are constrained to the selected repository root", async () => {
  const { root, index } = await portedFixture({
    acceptance: [{
      id: "outside-artifact",
      kind: "artifact",
      required: true,
      description: "Stores a deterministic artifact.",
      path: "../outside-artifact.md"
    }]
  });

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /artifact path escapes the workspace/
  );
});

test("visual review requires a required screenshot artifact and required check", async () => {
  const { root, index } = await portedFixture({
    visualReview: true,
    acceptance: [
      {
        id: "screenshot-artifact",
        kind: "artifact",
        required: false,
        description: "Stores a screenshot.",
        path: "step_archive/screenshots/step001.png"
      },
      {
        id: "visual-check",
        kind: "check",
        required: false,
        description: "Records the inspection outcome."
      }
    ]
  });

  assert.throws(
    () => validateIndex(index, { repoRoot: root, requirePorted: false }),
    /required screenshot artifact and required check/
  );
});

test("ported batch validation rejects missing Codex files", async () => {
  const { root, index } = await portedFixture();
  await writeFile(
    join(root, "codex", "assets", "steps", "index.json"),
    `${JSON.stringify(index)}\n`
  );
  await rm(join(root, index.steps[0].target));

  await assert.rejects(
    () => validateStepBatch(root, [1]),
    /missing Codex step/
  );
});

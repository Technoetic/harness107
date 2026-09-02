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

test("tooling batch declares the exact portable capability contracts", async () => {
  const report = await validateStepBatch(repoRoot, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    inputs: step.inputs,
    outputs: step.outputs,
    requires: step.requires,
    optional_requires: step.optional_requires,
    network: step.network,
    visual_review: step.visual_review,
    acceptance: step.acceptance.map((item) => ({
      id: item.id,
      kind: item.kind,
      required: item.required,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 6,
      id: "step006",
      title: "Vitest/Jest 유닛 테스트 러너 환경 설치",
      phase: "tooling",
      source: "assets/steps/step006.md",
      target: "codex/assets/steps/step006.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step006_test_runner_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "test-runner-version",
          kind: "command",
          required: true,
          command_pattern: "^npx (?:vitest|jest) --version$"
        },
        {
          id: "test-runner-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step006_test_runner_test.md"
        },
        {
          id: "test-runner-selection",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step007"
    },
    {
      number: 7,
      id: "step007",
      title: "번들 분석 도구 환경 설치",
      phase: "tooling",
      source: "assets/steps/step007.md",
      target: "codex/assets/steps/step007.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step007_bundle_analyzer_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "bundle-analyzer-version",
          kind: "command",
          required: true,
          command_pattern: "^npm ls (?:rollup-plugin-visualizer|webpack-bundle-analyzer|source-map-explorer) --depth=0$"
        },
        {
          id: "bundle-analyzer-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step007_bundle_analyzer_test.md"
        },
        {
          id: "bundle-analyzer-selection",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step008"
    },
    {
      number: 8,
      id: "step008",
      title: "jscpd 코드 중복 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step008.md",
      target: "codex/assets/steps/step008.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step008_jscpd_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "jscpd-version",
          kind: "command",
          required: false,
          command: "npx jscpd --version"
        },
        {
          id: "jscpd-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step008_jscpd_test.md"
        },
        {
          id: "jscpd-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step009"
    },
    {
      number: 9,
      id: "step009",
      title: "Semgrep 정적 분석 환경 설치",
      phase: "tooling",
      source: "assets/steps/step009.md",
      target: "codex/assets/steps/step009.md",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step009_semgrep_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "semgrep-version",
          kind: "command",
          required: false,
          command: "semgrep --version"
        },
        {
          id: "semgrep-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step009_semgrep_test.md"
        },
        {
          id: "semgrep-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step010"
    },
    {
      number: 10,
      id: "step010",
      title: "knip 미사용 코드 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step010.md",
      target: "codex/assets/steps/step010.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step010_knip_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "knip-version",
          kind: "command",
          required: true,
          command: "npx knip --version"
        },
        {
          id: "knip-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step010_knip_test.md"
        },
        {
          id: "knip-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step011"
    },
    {
      number: 11,
      id: "step011",
      title: "tokei 코드 통계 환경 설치",
      phase: "tooling",
      source: "assets/steps/step011.md",
      target: "codex/assets/steps/step011.md",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step011_tokei_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "tokei-version",
          kind: "command",
          required: false,
          command: "tokei --version"
        },
        {
          id: "tokei-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step011_tokei_test.md"
        },
        {
          id: "tokei-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step012"
    },
    {
      number: 12,
      id: "step012",
      title: "Lighthouse CI 웹 성능 감사 환경 설치",
      phase: "tooling",
      source: "assets/steps/step012.md",
      target: "codex/assets/steps/step012.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step012_lhci_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "lhci-version",
          kind: "command",
          required: true,
          command: "npx lhci --version"
        },
        {
          id: "lhci-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step012_lhci_test.md"
        },
        {
          id: "lhci-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step013"
    },
    {
      number: 13,
      id: "step013",
      title: "stylelint CSS 린팅 환경 설치",
      phase: "tooling",
      source: "assets/steps/step013.md",
      target: "codex/assets/steps/step013.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step013_stylelint_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "stylelint-version",
          kind: "command",
          required: true,
          command: "npx stylelint --version"
        },
        {
          id: "stylelint-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step013_stylelint_test.md"
        },
        {
          id: "stylelint-installation-verified",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step014"
    },
    {
      number: 14,
      id: "step014",
      title: "Biome 포매팅/린팅 환경 설치",
      phase: "tooling",
      source: "assets/steps/step014.md",
      target: "codex/assets/steps/step014.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step014_biome_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "biome-version",
          kind: "command",
          required: true,
          command: "npx biome --version"
        },
        {
          id: "biome-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step014_biome_test.md"
        },
        {
          id: "biome-configuration",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step015"
    },
    {
      number: 15,
      id: "step015",
      title: "madge 순환 의존성 탐지 환경 설치",
      phase: "tooling",
      source: "assets/steps/step015.md",
      target: "codex/assets/steps/step015.md",
      inputs: ["package.json", "step_archive/step001_preflight.md"],
      outputs: ["step_archive/step015_madge_test.md"],
      requires: ["step001"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        {
          id: "madge-version",
          kind: "command",
          required: false,
          command: "npx madge --version"
        },
        {
          id: "madge-environment-report",
          kind: "artifact",
          required: true,
          path: "step_archive/step015_madge_test.md"
        },
        {
          id: "madge-disposition",
          kind: "check",
          required: true
        }
      ],
      ported: true,
      next: "step016"
    }
  ]);
});

test("tooling source hashes bind the untouched Claude steps 006 through 015", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(5, 15));

  assert.deepEqual(hashes, {
    step006: "373e5961bc9a6906f4ef921d0c542824a9ee419a3d0ac2f55ab18e05253c3f0f",
    step007: "53209e43a2145950d76a9eac0e36e11ffb71b99350cbd466d8072c98ad22bca5",
    step008: "14976722eba206b66ad917115ddac28413fb31dfc8e49c1f7128e1fa4a2a984d",
    step009: "3c2f99310df7c9690ffaf22f4174882b29563b64e6c6ecc026e83f99f7cbf06c",
    step010: "dc6fb1cec685b10b315f4fa77cc85e9dfbbd00aaa4442f114d950a947eb08ea0",
    step011: "f4c6f789452c1a4920e8ea69ce6ad1cee1871400234c73d5d240bac2eef0a948",
    step012: "bf5dd150944bc2774679d6a04a366ed77386446ca5823e62cd3d10a1259f5735",
    step013: "2245a7a78b2a21c546ab12b78849b3a7c2c85f54c8ea69a8b142de69f33a9f2e",
    step014: "5bf9523b046adac78fbd28872c4388aeeca32220a541719884abf208c8b99075",
    step015: "46c4a588eceb39df1b1dcdd798b4d3b3d5d2a818d6063bb98e558a13fd6be23b"
  });
});

test("tooling documents bind exact frontmatter titles and current-step references", async () => {
  const expected = [
    { name: "step006", number: 6, title: "Vitest/Jest 유닛 테스트 러너 환경 설치" },
    { name: "step007", number: 7, title: "번들 분석 도구 환경 설치" },
    { name: "step008", number: 8, title: "jscpd 코드 중복 탐지 환경 설치" },
    { name: "step009", number: 9, title: "Semgrep 정적 분석 환경 설치" },
    { name: "step010", number: 10, title: "knip 미사용 코드 탐지 환경 설치" },
    { name: "step011", number: 11, title: "tokei 코드 통계 환경 설치" },
    { name: "step012", number: 12, title: "Lighthouse CI 웹 성능 감사 환경 설치" },
    { name: "step013", number: 13, title: "stylelint CSS 린팅 환경 설치" },
    { name: "step014", number: 14, title: "Biome 포매팅/린팅 환경 설치" },
    { name: "step015", number: 15, title: "madge 순환 의존성 탐지 환경 설치" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "tooling" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("tooling outputs and instructions preserve safe one-step boundaries", async () => {
  const report = await validateStepBatch(repoRoot, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

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
    assert.match(
      instructions,
      /버전 또는 smoke 명령이 종료 코드 0으로 성공한 경우에만[^]*`설치됨`/
    );
  }
});

test("required tooling capabilities block while optional capabilities record an explicit skip", async () => {
  const required = [6, 7, 10, 12, 13, 14];
  const optional = [8, 9, 11, 15];

  for (const number of required) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /기능 분류:\s*필수/);
    assert.match(content, /사용할 수 없으면[^]*이 단계를 완료하지 않는다/);
    assert.doesNotMatch(content, /필수 기능[^]*`SKIP`[^]*(?:완료|수락 증거)/);
  }

  for (const number of optional) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /기능 분류:\s*선택/);
    assert.match(content, /사용할 수 없으면[^]*`SKIP`[^]*이유[^]*대체/);
    assert.match(content, /`SKIP`[^]*수락 증거/);
  }
});

test("tooling steps retain bounded provider-neutral worker and reviewer roles", async () => {
  const expected = [
    { name: "step006", focus: "테스트 러너 선택·설치·버전 확인" },
    { name: "step007", focus: "번들 분석 패키지 선택·설치·버전 확인" },
    { name: "step008", focus: "jscpd 설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step009", focus: "Semgrep 환경 점검·설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step010", focus: "knip 설치·버전 확인" },
    { name: "step011", focus: "tokei 설치 시도·버전 확인 또는 SKIP 근거 수집" },
    { name: "step012", focus: "Lighthouse CI 설치·버전 확인" },
    { name: "step013", focus: "stylelint 설치·버전 확인·기존 구성 보존" },
    { name: "step014", focus: "Biome 설치·버전 확인·구성 보존 또는 초기화" },
    { name: "step015", focus: "madge 설치 시도·버전 확인 또는 SKIP 근거 수집" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];

    assert.ok(roleSection, `${item.name} is missing its provider-neutral role contract`);
    assert.match(roleSection, new RegExp(item.focus));
    assert.match(roleSection, /현재 단계 범위[^]*도구 준비 작업자 역할[^]*위임/);
    assert.match(roleSection, /검증자 역할[^]*작업자 결과를 그대로 수락하지 않고/);
    assert.match(roleSection, /위임 기능을 사용할 수 없으면 현재 실행자가[^]*순서대로 수행/);
    assert.match(roleSection, /별도 작업자를 사용했다고 기록하지 않는다/);
    assert.match(roleSection, /정상 권한 확인/);
    assert.doesNotMatch(content, /\b(?:Claude|Haiku|Sonnet)\b/i);
  }
});

test("step015 preserves the recommended MX note severity without making it acceptance", async () => {
  const content = await readFile(
    join(repoRoot, "codex", "assets", "steps", "step015.md"),
    "utf8"
  );
  const annotationSection = /## 이후 소스 주석 계약\n([^]*?)(?=\n## )/.exec(content)?.[1];

  assert.ok(annotationSection, "step015 is missing its source-annotation contract");
  assert.match(annotationSection, /태그를 사용할 때[^]*정식 형식/);
  assert.match(annotationSection, /@MX:ANCHOR:[^\n]*fan_in\s*>=\s*3/);
  assert.match(annotationSection, /`@MX:NOTE`[^]*(?:권장|권고)/);
  assert.doesNotMatch(
    annotationSection,
    /`@MX:NOTE`[^]{0,100}(?:반드시|필수|의무|최소 하나 둔다)/
  );

  const index = await loadIndex(repoRoot);
  assert.ok(index.steps[14].acceptance.every((item) => !/mx|note/i.test(item.id)));
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

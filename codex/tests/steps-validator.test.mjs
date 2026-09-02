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

test("research batch declares the exact Codex-native evidence contracts", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);
  const projected = report.steps.map((step) => ({
    number: step.number,
    id: step.id,
    title: step.title,
    phase: step.phase,
    source: step.source,
    target: step.target,
    source_sha256: step.source_sha256,
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
      ...(item.path === undefined ? {} : { path: item.path })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 16,
      id: "step016",
      title: "전체 조사",
      phase: "research",
      source: "assets/steps/step016.md",
      target: "codex/assets/steps/step016.md",
      source_sha256: "3c27c6e77a062a5ae9134d87bcb24d237a4d0d3aa315fc2f113111b20e2ad4bb",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step001_preflight.md",
        "step_archive/step002_context전략_chunk1.md"
      ],
      outputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/research-raw-step016-primary.txt",
        "step_archive/screenshots/research/step016-primary.png"
      ],
      requires: ["step001", "step002"],
      optional_requires: ["step011"],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "research-chunk-1", kind: "artifact", required: true, path: "step_archive/step016_조사결과_chunk1.md" },
        { id: "research-raw-primary", kind: "artifact", required: true, path: "step_archive/research-raw-step016-primary.txt" },
        { id: "research-screenshot-primary", kind: "artifact", required: true, path: "step_archive/screenshots/research/step016-primary.png" },
        { id: "research-attribution", kind: "check", required: true },
        { id: "research-chunks-bounded", kind: "check", required: true },
        { id: "code-baseline-disposition", kind: "check", required: true },
        { id: "tokei-baseline", kind: "artifact", required: false, path: "step_archive/tokei-baseline.json" }
      ],
      ported: true,
      next: "step017"
    },
    {
      number: 17,
      id: "step017",
      title: "GitHub 조사",
      phase: "research",
      source: "assets/steps/step017.md",
      target: "codex/assets/steps/step017.md",
      source_sha256: "34b3d7400582a87c8c98bb288ca20d5921ecb2ba832030be34079bd319dc3fe2",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "github-research-chunk-1", kind: "artifact", required: true, path: "step_archive/step017_조사결과_chunk1.md" },
        { id: "github-api-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step017-github-api.json" },
        { id: "github-api-response", kind: "check", required: true },
        { id: "github-attribution", kind: "check", required: true },
        { id: "github-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step018"
    },
    {
      number: 18,
      id: "step018",
      title: "API 계약 문서 조사",
      phase: "research",
      source: "assets/steps/step018.md",
      target: "codex/assets/steps/step018.md",
      source_sha256: "d9f419671463c41d66e4261352d56743a053b13436f82ca9966697b118650014",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step018_조사결과_chunk1.md",
        "step_archive/research-raw-step018-api-contract.txt"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "api-contract-chunk-1", kind: "artifact", required: true, path: "step_archive/step018_조사결과_chunk1.md" },
        { id: "api-contract-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step018-api-contract.txt" },
        { id: "concrete-contract-subject", kind: "check", required: true },
        { id: "api-contract-attribution", kind: "check", required: true },
        { id: "api-contract-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step019"
    },
    {
      number: 19,
      id: "step019",
      title: "참고 레포지토리 클론 및 코드 분석",
      phase: "research",
      source: "assets/steps/step019.md",
      target: "codex/assets/steps/step019.md",
      source_sha256: "4e4d86c80ddc68d368f06da37d6be6e90e71abc4c31684fe5b7c73623df5536f",
      inputs: [
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      outputs: [
        "step_archive/step019_조사결과_chunk1.md",
        "step_archive/references/clone-manifest.md"
      ],
      requires: ["step017"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "repository-analysis-chunk-1", kind: "artifact", required: true, path: "step_archive/step019_조사결과_chunk1.md" },
        { id: "clone-manifest", kind: "artifact", required: true, path: "step_archive/references/clone-manifest.md" },
        { id: "bounded-shallow-clones", kind: "check", required: true },
        { id: "cloned-code-quarantine", kind: "check", required: true },
        { id: "repository-analysis-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step020"
    },
    {
      number: 20,
      id: "step020",
      title: "Awwwards 사이트 선정",
      phase: "research",
      source: "assets/steps/step020.md",
      target: "codex/assets/steps/step020.md",
      source_sha256: "eb729885309aaa07e489bc2a1a2987606161fba43e3b6a996a552e15298d425b",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md"
      ],
      outputs: [
        "step_archive/step020_선정URL.md",
        "step_archive/research-raw-step020-awwwards.txt"
      ],
      requires: ["step016"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "selected-awwwards-urls", kind: "artifact", required: true, path: "step_archive/step020_선정URL.md" },
        { id: "awwwards-listing-raw", kind: "artifact", required: true, path: "step_archive/research-raw-step020-awwwards.txt" },
        { id: "evidence-derived-selection", kind: "check", required: true },
        { id: "selected-url-attribution", kind: "check", required: true },
        { id: "bounded-site-set", kind: "check", required: true }
      ],
      ported: true,
      next: "step021"
    },
    {
      number: 21,
      id: "step021",
      title: "의존성 게이트 검증",
      phase: "research",
      source: "assets/steps/step021.md",
      target: "codex/assets/steps/step021.md",
      source_sha256: "c36004a40bd93ed6bc79043cd7120629f2f71e6582feb89ca3e3a6d20cc7da54",
      inputs: ["step_archive/step001_preflight.md"],
      outputs: ["step_archive/step021_gate_status.md"],
      requires: ["step001"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "step001-preflight-artifact", kind: "artifact", required: true, path: "step_archive/step001_preflight.md" },
        { id: "dependency-gate-status", kind: "artifact", required: true, path: "step_archive/step021_gate_status.md" },
        { id: "step001-receipt-and-artifact", kind: "check", required: true },
        { id: "project-conditional-prerequisites", kind: "check", required: true },
        { id: "optional-step-deps", kind: "check", required: true }
      ],
      ported: true,
      next: "step022"
    },
    {
      number: 22,
      id: "step022",
      title: "Awwwards 데이터 수집",
      phase: "research",
      source: "assets/steps/step022.md",
      target: "codex/assets/steps/step022.md",
      source_sha256: "d385a1cb3bd07e10d5dacf9fb47fc2a8c00399e4b8489228f75173e7558c2410",
      inputs: [
        "step_archive/step020_선정URL.md",
        "step_archive/research-raw-step020-awwwards.txt"
      ],
      outputs: [
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png"
      ],
      requires: ["step020"],
      optional_requires: [],
      network: true,
      visual_review: true,
      acceptance: [
        { id: "awwwards-collection-chunk-1", kind: "artifact", required: true, path: "step_archive/step022_수집결과_chunk1.md" },
        { id: "awwwards-raw-primary", kind: "artifact", required: true, path: "step_archive/awwwards-step022-primary.txt" },
        { id: "awwwards-screenshot-primary", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "selected-url-input", kind: "check", required: true },
        { id: "capture-attribution", kind: "check", required: true },
        { id: "visual-capture-inspection", kind: "check", required: true },
        { id: "bounded-capture-scope", kind: "check", required: true }
      ],
      ported: true,
      next: "step023"
    },
    {
      number: 23,
      id: "step023",
      title: "Awwwards 디자인 패턴 분석",
      phase: "research",
      source: "assets/steps/step023.md",
      target: "codex/assets/steps/step023.md",
      source_sha256: "6efdd52549990ea26e16968a6da65c576edcf46e5e914f8a6708292c81b8c461",
      inputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png"
      ],
      outputs: ["step_archive/step023_조사결과_chunk1.md"],
      requires: ["step016", "step022"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "design-pattern-chunk-1", kind: "artifact", required: true, path: "step_archive/step023_조사결과_chunk1.md" },
        { id: "research-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "all-captures-traced", kind: "check", required: true },
        { id: "named-aesthetic-axes", kind: "check", required: true },
        { id: "visual-pattern-inspection", kind: "check", required: true },
        { id: "design-analysis-chunks-bounded", kind: "check", required: true }
      ],
      ported: true,
      next: "step024"
    },
    {
      number: 24,
      id: "step024",
      title: "Awwwards 조사 충분성 검증",
      phase: "research",
      source: "assets/steps/step024.md",
      target: "codex/assets/steps/step024.md",
      source_sha256: "e7946951a1cbeecc506ec7954a30f6b366e438b7a305e4bab51b187e7c348ff1",
      inputs: [
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md"
      ],
      outputs: ["step_archive/outputs/step024_검증_r1.md"],
      requires: ["step016", "step022", "step023"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "sufficiency-verification-round-1", kind: "artifact", required: true, path: "step_archive/outputs/step024_검증_r1.md" },
        { id: "verification-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "independent-verifier", kind: "check", required: true },
        { id: "bounded-verification-rounds", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true },
        { id: "visual-sufficiency-inspection", kind: "check", required: true }
      ],
      ported: true,
      next: "step025"
    }
  ]);
});

test("research source hashes bind the untouched Claude steps 016 through 024", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(15, 24));

  assert.deepEqual(hashes, {
    step016: "3c27c6e77a062a5ae9134d87bcb24d237a4d0d3aa315fc2f113111b20e2ad4bb",
    step017: "34b3d7400582a87c8c98bb288ca20d5921ecb2ba832030be34079bd319dc3fe2",
    step018: "d9f419671463c41d66e4261352d56743a053b13436f82ca9966697b118650014",
    step019: "4e4d86c80ddc68d368f06da37d6be6e90e71abc4c31684fe5b7c73623df5536f",
    step020: "eb729885309aaa07e489bc2a1a2987606161fba43e3b6a996a552e15298d425b",
    step021: "c36004a40bd93ed6bc79043cd7120629f2f71e6582feb89ca3e3a6d20cc7da54",
    step022: "d385a1cb3bd07e10d5dacf9fb47fc2a8c00399e4b8489228f75173e7558c2410",
    step023: "6efdd52549990ea26e16968a6da65c576edcf46e5e914f8a6708292c81b8c461",
    step024: "e7946951a1cbeecc506ec7954a30f6b366e438b7a305e4bab51b187e7c348ff1"
  });
});

test("research documents bind exact frontmatter titles and current-step references", async () => {
  const expected = [
    { name: "step016", number: 16, title: "전체 조사" },
    { name: "step017", number: 17, title: "GitHub 조사" },
    { name: "step018", number: 18, title: "API 계약 문서 조사" },
    { name: "step019", number: 19, title: "참고 레포지토리 클론 및 코드 분석" },
    { name: "step020", number: 20, title: "Awwwards 사이트 선정" },
    { name: "step021", number: 21, title: "의존성 게이트 검증" },
    { name: "step022", number: 22, title: "Awwwards 데이터 수집" },
    { name: "step023", number: 23, title: "Awwwards 디자인 패턴 분석" },
    { name: "step024", number: 24, title: "Awwwards 조사 충분성 검증" }
  ];

  for (const item of expected) {
    const content = await readFile(
      join(repoRoot, "codex", "assets", "steps", `${item.name}.md`),
      "utf8"
    );
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "research" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("research outputs have required artifacts and an upstream dependency graph", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);
  const byId = new Map((await loadIndex(repoRoot)).steps.map((step) => [step.id, step]));

  for (const step of report.steps) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const dependency of step.requires) {
      assert.ok(byId.get(dependency).number < step.number, `${step.id} has a non-upstream dependency`);
    }
  }

  assert.deepEqual(report.steps.map((step) => ({
    id: step.id,
    requires: step.requires,
    optional_requires: step.optional_requires
  })), [
    { id: "step016", requires: ["step001", "step002"], optional_requires: ["step011"] },
    { id: "step017", requires: ["step016"], optional_requires: [] },
    { id: "step018", requires: ["step016"], optional_requires: [] },
    { id: "step019", requires: ["step017"], optional_requires: [] },
    { id: "step020", requires: ["step016"], optional_requires: [] },
    { id: "step021", requires: ["step001"], optional_requires: [] },
    { id: "step022", requires: ["step020"], optional_requires: [] },
    { id: "step023", requires: ["step016", "step022"], optional_requires: [] },
    { id: "step024", requires: ["step016", "step022", "step023"], optional_requires: [] }
  ]);
});

test("research instructions block missing mandatory evidence and trace every factual claim", async () => {
  const networkSteps = [16, 17, 18, 19, 20, 22];

  for (const number of networkSteps) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.match(content, /네트워크 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
    assert.match(content, /최대 세 번/);
    assert.match(content, /(?:URL|요청 URL)[^]*(?:출처|원본)[^]*(?:수집 시각|응답 시각)/);
    assert.match(content, /사실 주장[^]*(?:URL|출처)[^]*(?:원본|캡처)/);
    assert.match(content, /증거를 (?:발명|꾸며)/);
  }

  const step18 = await readFile(join(repoRoot, "codex", "assets", "steps", "step018.md"), "utf8");
  assert.match(step18, /주제 입력과 프로젝트 증거[^]*계약 대상을 도출/);
  assert.match(step18, /구체적인 계약 출처[^]*식별할 수 없으면[^]*완료하지 않는다/);
  assert.doesNotMatch(step18, /임의(?:의|로)[^]*(?:API|계약)/);
});

test("research instructions use safe one-step provider-neutral contracts", async () => {
  const report = await validateStepBatch(repoRoot, [16, 17, 18, 19, 20, 21, 22, 23, 24]);

  for (const step of report.steps) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assert.doesNotMatch(content, /별도 (?:작업자|검증자)를 사용했다고 (?:기록|주장)/);
  }
});

test("every research step defines concrete independent roles and an honest sequential fallback", async () => {
  const roleContracts = [
    {
      number: 16,
      worker: /조사 질문별 수집 역할/,
      reviewer: /수집 결과를 원본과 대조하는 독립 검토\s*역할/
    },
    {
      number: 17,
      worker: /API 수집 역할/,
      reviewer: /응답 원본으로 확인하는 독립 검토\s*역할/
    },
    {
      number: 18,
      worker: /계약 문서별 수집 역할/,
      reviewer: /계약 항목을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 19,
      worker: /저장소별 수집 역할/,
      reviewer: /정적 분석을 원본 파일에 대조하는 독립 검토\s*역할/
    },
    {
      number: 20,
      worker: /특성별 후보 수집 역할/,
      reviewer: /등재·관련성을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 21,
      worker: /결정적 의존성 검사 작업자/,
      reviewer: /보고서를\s*수정하지 않는 독립 검증자/
    },
    {
      number: 22,
      worker: /선정 사이트별 수집 역할/,
      reviewer: /원본·스크린샷을 실제로 확인하는 독립 검토\s*역할/
    },
    {
      number: 23,
      worker: /수집 증거를 축별로 분석하는 역할/,
      reviewer: /결론을 원본에 대조하는 독립 검토\s*역할/
    },
    {
      number: 24,
      worker: /23단계 분석을 만든 역할/,
      reviewer: /구분된 독립 검증자 역할/
    }
  ];

  for (const { number, worker, reviewer } of roleContracts) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];
    assert.ok(roleSection, `${id} is missing its provider-neutral role contract`);
    const normalizedRole = roleSection.replace(/\s+/g, " ").trim();
    assert.match(normalizedRole, worker, `${id} is missing its concrete worker role`);
    assert.match(normalizedRole, reviewer, `${id} is missing its independent reviewer role`);
    assert.match(normalizedRole, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*순서대로 수행/);
    assert.match(normalizedRole, /별도 역할을 위임했다고 기록하지 않는다/);
    assert.match(normalizedRole, /정상 권한 확인/);
  }

  const step21 = await readFile(join(repoRoot, "codex", "assets", "steps", "step021.md"), "utf8");
  const step21RoleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(step21)?.[1];
  assert.ok(step21RoleSection, "step021 role checks must stay inside its role section");
  const step21Roles = step21RoleSection.replace(/\s+/g, " ").trim();
  assert.match(step21Roles, /동일한 입력[^]*1단계 완료 영수증[^]*프로젝트 manifest[^]*독립적으로 재확인/);
  assert.match(step21Roles, /결정적 명령[^]*독립적으로 재실행/);
  assert.match(step21Roles, /독립 검증자[^]*(?:상태 )?보고서[^]*수정하지 않/);
  assert.match(step21Roles, /병렬 실행[^]*위임 기능을 사용할 수 없으면[^]*역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(step21Roles, /자동 승인[^]*권한 우회[^]*금지/);
});

test("step017 persists one successful API response and closes step019 provenance", async () => {
  const report = await validateStepBatch(repoRoot, [17, 19]);
  const [githubResearch] = report.steps;
  const step17 = await readFile(join(repoRoot, "codex", "assets", "steps", "step017.md"), "utf8");
  const step19 = await readFile(join(repoRoot, "codex", "assets", "steps", "step019.md"), "utf8");
  const persistedRaw = "step_archive/research-raw-step017-github-api.json";

  assert.deepEqual(githubResearch.outputs.filter((path) => path.includes("github-api")), [persistedRaw]);
  assert.match(step17, /최대 세 개의[^.\n]*검색어 후보[^]*우선순위/);
  assert.match(step17, /한 번에 하나씩[^]*각 후보당 최대 한 번[^]*총 최대 세 번/);
  assert.match(step17, /첫 HTTP 성공 응답[^]*수정하지 않은 JSON 바이트[^]*저장[^]*즉시[^]*추가 API\s*요청[^]*중단/);
  assert.match(step17, /성공 응답은 정확히 하나만[^]*보존/);
  assert.match(step17, /후보 선정과 모든 사실 주장[^]*오직[^]*보존된 성공 응답/);
  assert.match(step17, /실패 시도[^]*요청 URL[^]*HTTP 상태[^]*rate-limit[^]*공개 metadata[^]*manifest/);
  assert.match(step17, /실패 응답[^]*(?:사실|후보)[^]*사용하지 않는다/);
  assert.match(step17, /성공 응답이 없으면[^]*최대 세 번[^]*완료하지 않는다/);
  assert.doesNotMatch(step17, /각 검색어[^]*공개 검색 API에 실제로\s*요청한다/);

  assert.match(step19, /오직 `step_archive\/research-raw-step017-github-api\.json`에 보존된[^]*성공 응답[^]*후보만[^]*복제/);
  assert.match(step19, /실패 시도 metadata[^]*보존되지 않은 응답[^]*(?:후보|클론)[^]*사용하지 않는다/);
});

test("visual research requires screenshots and actual inspection for steps 022 through 024", async () => {
  const report = await validateStepBatch(repoRoot, [22, 23, 24]);

  for (const step of report.steps) {
    assert.equal(step.visual_review, true);
    assert.ok(step.acceptance.some((item) => (
      item.kind === "artifact" && item.required && /screenshot/i.test(`${item.id} ${item.path}`)
    )));
    assert.ok(step.acceptance.some((item) => item.kind === "check" && item.required));

    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
    assert.match(content, /실제로[^]*(?:열어|검사)/);
  }
});

test("step019 confines untrusted clones and never executes their code", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step019.md"), "utf8");

  assert.match(content, /최대 5개/);
  assert.match(content, /`git clone --depth 1`/);
  assert.match(content, /검증된 `step_archive\/references\/[a-z0-9][a-z0-9._-]*`/);
  assert.match(content, /실패[^]*manifest[^]*기록/);
  assert.match(content, /클론한 코드[^]*(?:실행|설치|빌드|스크립트)[^]*금지/);
  assert.match(content, /심볼릭 링크[^]*경계 밖[^]*완료하지 않는다/);
});

test("step021 is a local deterministic gate over the step001 receipt and artifact", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step021.md"), "utf8");

  assert.match(content, /1단계 완료 영수증[^]*`step_archive\/step001_preflight\.md`/);
  assert.match(content, /로컬[^]*결정적/);
  assert.match(content, /네트워크[^]*사용하지 않는다/);
  assert.match(content, /설치[^]*수행하지 않는다/);
  assert.match(content, /`step_archive\/step-deps\.json`[^]*선택 입력/);
  assert.match(content, /`package\.json`[^]*`node_modules`[^]*프로젝트 조건부/);
  assert.match(content, /선언된[^]*선행 파일[^]*누락[^]*완료하지 않는다/);
  assert.match(content, /`step_archive\/step021_gate_status\.md`[^]*기록/);
});

test("step022 consumes the selected URLs and blocks incomplete visual collection", async () => {
  const report = await validateStepBatch(repoRoot, [20, 22]);
  const [selection, collection] = report.steps;
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step022.md"), "utf8");

  assert.ok(selection.outputs.includes("step_archive/research-raw-step020-awwwards.txt"));
  assert.ok(collection.inputs.includes("step_archive/research-raw-step020-awwwards.txt"));
  assert.match(content, /`step_archive\/step020_선정URL\.md`[^]*URL만/);
  assert.match(content, /선정 목록 밖의 URL[^]*수집하지 않는다/);
  assert.match(content, /원본 텍스트[^]*스크린샷[^]*둘 다/);
  assert.match(content, /URL별 최대 10개 페이지/);
  assert.match(content, /반응형[^]*1920×1080[^]*768×1024[^]*390×844/);
  assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
});

test("step023 preserves every named source axis without inventing the numeric mismatch", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step023.md"), "utf8");

  for (const axis of [
    "Brutalism", "Glassmorphism", "Minimalism", "Dark OLED Luxury", "Neumorphism", "Cyberpunk"
  ]) {
    assert.match(content, new RegExp(axis));
  }
  assert.match(content, /원본에 이름이 명시된 여섯 미학 축/);
  assert.doesNotMatch(content, /11가지 미학 축/);
  assert.match(content, /레이아웃[^]*색상[^]*간격[^]*타이포그래피[^]*인터랙션/);
  assert.match(content, /각 대안[^]*최소 2개[^]*장단점/);
});

test("step024 keeps every bounded verification round inside its declared artifact", async () => {
  const report = await validateStepBatch(repoRoot, [24]);
  const step = report.steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");
  const mentionedRoundArtifacts = [...new Set(
    [...content.matchAll(/`(step_archive\/outputs\/step024_검증_r\d+\.md)`/g)]
      .map((match) => match[1])
  )];

  assert.deepEqual(step.outputs, ["step_archive/outputs/step024_검증_r1.md"]);
  assert.ok(step.inputs.includes("step_archive/awwwards-step022-primary.txt"));
  assert.deepEqual(mentionedRoundArtifacts, step.outputs);
  assert.doesNotMatch(content, /step024_검증_r[2-5]\.md/);
  assert.match(content, /모든 라운드[^]*동일한 선언 산출물[^]*라운드별 섹션/);
  assert.match(content, /라운드 1[^]*라운드 5/);
});

test("step024 requires a bounded independent PASS and never auto-routes a FAIL", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step024.md"), "utf8");

  assert.match(content, /독립 검증자 역할/);
  assert.match(content, /최대 5라운드/);
  assert.match(content, /`PASS`[^]*경우에만[^]*완료/);
  assert.match(content, /`FAIL`[^]*완료 증거[^]*될 수 없다/);
  assert.match(content, /`FAIL`[^]*자동으로[^]*(?:이동|실행|전환)[^]*않는다/);
  assert.match(content, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
  assert.doesNotMatch(content, /스킵 처리[^]*(?:완료|종료)/);
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

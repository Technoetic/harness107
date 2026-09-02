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

function extractMarkdownSection(content, heading) {
  const normalized = content.replaceAll("\r\n", "\n");
  const headings = [...normalized.matchAll(/^## ([^\n]+)$/gm)];
  const matches = headings.filter((match) => match[1] === heading);
  assert.equal(matches.length, 1, `expected exactly one ## ${heading} section`);
  const match = matches[0];
  const next = headings.find((candidate) => candidate.index > match.index);
  return normalized.slice(match.index + match[0].length, next?.index ?? normalized.length).trim();
}

function extractOrderedMarkdownSections(content, expectedHeadings) {
  const normalized = content.replaceAll("\r\n", "\n");
  const headings = [...normalized.matchAll(/^## ([^\n]+)$/gm)];
  const sections = {};
  let previousIndex = -1;

  for (const expectedHeading of expectedHeadings) {
    const matches = headings.filter((match) => match[1] === expectedHeading);
    assert.equal(matches.length, 1, `expected exactly one ## ${expectedHeading} section`);
    const match = matches[0];
    assert.ok(match.index > previousIndex, `## ${expectedHeading} is out of order`);
    const next = headings.find((candidate) => candidate.index > match.index);
    sections[expectedHeading] = normalized
      .slice(match.index + match[0].length, next?.index ?? normalized.length)
      .trim();
    previousIndex = match.index;
  }

  return sections;
}

function assertPlanningPermissionContract(content) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, /정상 권한 확인을 유지/);
  assert.match(roleSection, /자동 승인이나 권한 우회를 금지/);

  assert.doesNotMatch(
    content,
    /(?:안전|일반|모든)(?:한)?\s*명령(?:은|을)?[^.\n]{0,120}자동\s*승인/i
  );
  assert.doesNotMatch(
    content,
    /권한\s*확인(?:\s*절차)?(?:을|를)?\s*우회/i
  );
  assert.doesNotMatch(
    content,
    /\bpermissionDecision\b["']?\s*(?::|=)\s*["']?(?:allow|ask)\b/i
  );
  assert.doesNotMatch(content, /\b(?:safe|ordinary|normal)\s+commands?[^.\n]{0,80}\bauto[- ]?approve/i);
  assert.doesNotMatch(content, /\bauto[- ]?approve[^.\n]{0,80}\b(?:safe|ordinary|normal)\s+commands?\b/i);
  assert.doesNotMatch(content, /\bbypass(?:ing)?\s+(?:the\s+)?permission\s+checks?\b/i);
  assert.doesNotMatch(content, /\bdangerously[-_ ]?bypass(?:[-_ ][a-z]+)*\b/i);
}

function assertStep30SectionContract(content) {
  const expectedOrder = [
    "주제와 기획 확인",
    "첫 설계 활동: 구조화된 대안 탐색",
    "독립 선택",
    "Class 설계 계약",
    "비동기와 성능 계약",
    "레이아웃·상호작용·접근성 계약",
    "최종 독립 검증",
    "완료 조건"
  ];
  const sections = extractOrderedMarkdownSections(content, expectedOrder);
  const goal = extractMarkdownSection(content, "목표").replace(/\s+/g, " ");
  const topic = sections["주제와 기획 확인"].replace(/\s+/g, " ");
  const exploration = sections["첫 설계 활동: 구조화된 대안 탐색"].replace(/\s+/g, " ");
  const selection = sections["독립 선택"].replace(/\s+/g, " ");
  const classDesign = sections["Class 설계 계약"].replace(/\s+/g, " ");
  const asyncDesign = sections["비동기와 성능 계약"].replace(/\s+/g, " ");
  const accessibility = sections["레이아웃·상호작용·접근성 계약"].replace(/\s+/g, " ");
  const verification = sections["최종 독립 검증"].replace(/\s+/g, " ");
  const completion = sections["완료 조건"].replace(/\s+/g, " ");

  assert.match(goal, /실제 구현이나 패키지 설치는 수행하지 않는다/);

  assert.match(topic, /가장 먼저 `step_archive\/TOPIC\/TOPIC\.md`/);
  assert.match(topic, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(topic, /29단계[^]*기획[^]*검증 보고서[^]*`PASS`/);

  assert.match(exploration, /첫 설계 활동은 구조화된 브레인스토밍과 대안 탐색/);
  assert.match(exploration, /외부 기능의 특정 이름[^]*의존하지 않는다/);
  assert.match(exploration, /사용자에게 옵션을 질문하지 않고[^]*주제 제약 안에서/);
  assert.match(exploration, /설계안 A[^]*설계안 B[^]*설계안 C/);
  assert.match(exploration, /레이아웃 구조[^]*아키텍처[^]*반응형 전략[^]*실질적으로 달라야/);
  assert.doesNotMatch(exploration, /\b(?:superpowers:|Skill\s*\(|skill\s*=|plugin:)/i);
  assert.doesNotMatch(exploration, /사용자에게[^.\n]{0,80}옵션(?:을)?\s*질문(?:한다|하라)/);

  assert.match(selection, /독립 선택자는 대안을 수정하지 않고 정확히 하나만 선택/);
  assert.match(selection, /유지보수성[^]*반응형 구현 난이도[^]*조사 적합성[^]*접근성/);
  assert.match(
    selection,
    /선택된 안만[^]*`step_archive\/step030_레이아웃설계_chunk1\.md`[^]*`step_archive\/step030_전체설계_chunk1\.md`/
  );

  assert.match(classDesign, /단일 책임[^]*합성[^]*생성자 주입[^]*전역 상태[^]*public[^]*private/i);
  assert.match(classDesign, /클래스 다이어그램[^]*의존 관계도[^]*public async 시그니처[^]*시퀀스 다이어그램[^]*라이프사이클/);

  assert.match(asyncDesign, /`async init\(\)`[^]*`async start\(\)`/);
  assert.match(asyncDesign, /I\/O[^]*DOM[^]*애니메이션[^]*취소[^]*오류[^]*병렬[^]*성능/);
  assert.match(asyncDesign, /부분 실패 복구/);

  for (const required of [/키보드/, /포커스/, /reduced-motion/i, /터치/, /(?:명암|contrast)/i]) {
    assert.match(accessibility, required);
  }
  assert.match(accessibility, /반응형 breakpoint[^]*화면 상태/);
  assert.match(accessibility, /loading[^]*empty[^]*error[^]*disabled/);

  const reportReferences = [...new Set(
    [...verification.matchAll(/`(step_archive\/outputs\/step030_최종검증(?:_r\d+)?\.md)`/g)]
      .map((match) => match[1])
  )];
  assert.deepEqual(reportReferences, ["step_archive/outputs/step030_최종검증.md"]);
  assert.match(verification, /동일한 선언 보고서[^]*라운드별 섹션[^]*최대 5라운드/);
  assert.match(verification, /`PASS`[^]*경우에만 완료/);
  assert.match(verification, /`FAIL`[^]*완료 증거가 될 수 없다/);
  assert.match(verification, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
  assert.doesNotMatch(verification, /최종검증_r[2-5]\.md|스킵[^]*(?:완료|종료)/);

  for (const acceptanceId of [
    "design-alternatives",
    "design-selection",
    "layout-design-chunk-1",
    "overall-design-chunk-1",
    "final-design-verification",
    "class-architecture-contract",
    "async-lifecycle-contract",
    "responsive-accessibility-contract",
    "pass-verdict"
  ]) {
    assert.match(completion, new RegExp("`" + acceptanceId + "`"));
  }

  return sections;
}

const EXPECTED_PLANNING_ACCEPTANCE_DESCRIPTIONS = {
  step025: {
    "base-planning-snapshot": "Stores the topic-complete base planning snapshot with a bounded manifest.",
    "planning-verification-report": "Stores every bounded independent review round in one report.",
    "topic-fidelity": "Confirms every topic, audience, interaction, application, and constraint field is reflected.",
    "general-research-provenance": "Traces every factual claim and planning decision to persisted general-research evidence.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step026: {
    "github-planning-snapshot": "Stores a complete planning snapshot enriched only by persisted GitHub evidence.",
    "github-planning-verification": "Stores every bounded independent GitHub-evidence review round in one report.",
    "persisted-github-response-only": "Confirms only the one persisted successful API response supplies candidates and facts.",
    "decision-provenance": "Traces every architecture and pattern decision to an exact response item and research section.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step027: {
    "api-contract-planning-snapshot": "Stores a complete planning snapshot enriched by the persisted official API contract.",
    "api-contract-planning-verification": "Stores every bounded independent contract review round in one report.",
    "concrete-contract-provenance": "Traces the concrete subject, version, and every contract decision to the official source.",
    "schema-contract-completeness": "Confirms structures, fields, authentication, rates, errors, retries, and limits are covered without invention.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step028: {
    "repository-planning-snapshot": "Stores a complete planning snapshot enriched by quarantined static repository evidence.",
    "repository-planning-verification": "Stores every bounded independent repository-evidence review round in one report.",
    "static-analysis-only": "Confirms cloned code was never executed, installed, built, tested, or automated.",
    "decision-provenance": "Traces structures, patterns, and constraints to a commit and exact cloned-file lines.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step029: {
    "visual-planning-snapshot": "Stores the complete integrated visual and interaction planning snapshot.",
    "visual-planning-verification": "Stores every bounded independent visual-evidence review round in one report.",
    "planning-screenshot-input": "Requires the primary screenshot used during visual planning inspection.",
    "evidence-axis-fidelity": "Confirms only evidence-named axes and alternatives informed planning decisions.",
    "interaction-accessibility-contracts": "Confirms responsive, interaction, state, keyboard, focus, touch, motion, and contrast contracts.",
    "visual-evidence-inspection": "Confirms required screenshots were actually opened and compared with the capture manifest.",
    "planning-chunks-bounded": "Confirms the declared planning manifest matches a snapshot of at most 500 lines.",
    "bounded-independent-review": "Confirms an independent reviewer used no more than five evidence-first rounds.",
    "pass-verdict": "Requires a fully evidenced PASS; FAIL and skipped findings never satisfy completion."
  },
  step030: {
    "design-alternatives": "Stores three materially distinct layout, architecture, and responsive alternatives.",
    "design-selection": "Stores the independent selector's one evidence-based choice without modifying alternatives.",
    "layout-design-chunk-1": "Stores the bounded final layout and interaction design selected from the alternatives.",
    "overall-design-chunk-1": "Stores the bounded final class architecture and asynchronous design.",
    "final-design-verification": "Stores every bounded final independent verification round in one report.",
    "structured-brainstorming-first": "Confirms structured brainstorming and alternative exploration was the first design activity.",
    "independent-selector": "Confirms a separate selector chose exactly one alternative without editing it.",
    "class-architecture-contract": "Confirms SRP classes, composition, constructor injection, state ownership, and public/private APIs.",
    "async-lifecycle-contract": "Confirms asynchronous initialization, start, I/O, cancellation, errors, parallelism, and performance contracts.",
    "responsive-accessibility-contract": "Confirms responsive breakpoints, states, keyboard, focus, reduced motion, touch, and contrast contracts.",
    "design-chunks-bounded": "Confirms design manifests match declared chunks of at most 500 lines.",
    "pass-verdict": "Requires the final independent verifier to record an evidenced PASS."
  }
};

function assertPlanningAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_PLANNING_ACCEPTANCE_DESCRIPTIONS);
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

test("planning batch declares the exact Codex-native artifact contracts", async () => {
  const report = await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30]);
  assertPlanningAcceptanceDescriptions(report.steps);
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
      number: 25,
      id: "step025",
      title: "기획: 전체 조사결과 기반 (독립 검증 루프)",
      phase: "planning",
      source: "assets/steps/step025.md",
      target: "codex/assets/steps/step025.md",
      source_sha256: "18cce8b074c319963e1467c1680658f261dda92db9289ad62b5e3d3f855b47fd",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step016_조사결과_chunk1.md",
        "step_archive/research-raw-step016-primary.txt",
        "step_archive/screenshots/research/step016-primary.png",
        "step_archive/outputs/step024_검증_r1.md"
      ],
      outputs: [
        "step_archive/step025_planning_chunk1.md",
        "step_archive/outputs/step025_검증.md"
      ],
      requires: ["step016", "step024"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "base-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step025_planning_chunk1.md" },
        { id: "planning-verification-report", kind: "artifact", required: true, path: "step_archive/outputs/step025_검증.md" },
        { id: "topic-fidelity", kind: "check", required: true },
        { id: "general-research-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step026"
    },
    {
      number: 26,
      id: "step026",
      title: "기획 보강: GitHub 조사결과",
      phase: "planning",
      source: "assets/steps/step026.md",
      target: "codex/assets/steps/step026.md",
      source_sha256: "d926b3c2829ecbd7b8db282f4c8dcc6da4be9312066a0cf6ee33577f1ce3617c",
      inputs: [
        "step_archive/step025_planning_chunk1.md",
        "step_archive/outputs/step025_검증.md",
        "step_archive/step017_조사결과_chunk1.md",
        "step_archive/research-raw-step017-github-api.json"
      ],
      outputs: [
        "step_archive/step026_planning_chunk1.md",
        "step_archive/outputs/step026_검증.md"
      ],
      requires: ["step017", "step025"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "github-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step026_planning_chunk1.md" },
        { id: "github-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step026_검증.md" },
        { id: "persisted-github-response-only", kind: "check", required: true },
        { id: "decision-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step027"
    },
    {
      number: 27,
      id: "step027",
      title: "기획 보강: API 계약 문서 조사결과",
      phase: "planning",
      source: "assets/steps/step027.md",
      target: "codex/assets/steps/step027.md",
      source_sha256: "d992b464654670c3e42d53c5faf1df062f7d2afb2563cd1449ac9631757b2b76",
      inputs: [
        "step_archive/step026_planning_chunk1.md",
        "step_archive/outputs/step026_검증.md",
        "step_archive/step018_조사결과_chunk1.md",
        "step_archive/research-raw-step018-api-contract.txt"
      ],
      outputs: [
        "step_archive/step027_planning_chunk1.md",
        "step_archive/outputs/step027_검증.md"
      ],
      requires: ["step018", "step026"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "api-contract-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step027_planning_chunk1.md" },
        { id: "api-contract-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step027_검증.md" },
        { id: "concrete-contract-provenance", kind: "check", required: true },
        { id: "schema-contract-completeness", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step028"
    },
    {
      number: 28,
      id: "step028",
      title: "기획 보강: 참고 레포 코드 분석",
      phase: "planning",
      source: "assets/steps/step028.md",
      target: "codex/assets/steps/step028.md",
      source_sha256: "458b2d51af051b4cd608895c6a8c6e435fcab45b37ee5c1bbccb34b93733ae09",
      inputs: [
        "step_archive/step027_planning_chunk1.md",
        "step_archive/outputs/step027_검증.md",
        "step_archive/step019_조사결과_chunk1.md",
        "step_archive/references/clone-manifest.md"
      ],
      outputs: [
        "step_archive/step028_planning_chunk1.md",
        "step_archive/outputs/step028_검증.md"
      ],
      requires: ["step019", "step027"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "repository-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step028_planning_chunk1.md" },
        { id: "repository-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step028_검증.md" },
        { id: "static-analysis-only", kind: "check", required: true },
        { id: "decision-provenance", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step029"
    },
    {
      number: 29,
      id: "step029",
      title: "기획 보강: Awwwards UX/UI·레이아웃 조사결과",
      phase: "planning",
      source: "assets/steps/step029.md",
      target: "codex/assets/steps/step029.md",
      source_sha256: "6c4955cfc3cdce6473c667d56b9f1e9b7bc0a019ef5ec3c843958428d38a83e2",
      inputs: [
        "step_archive/step028_planning_chunk1.md",
        "step_archive/outputs/step028_검증.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md",
        "step_archive/outputs/step024_검증_r1.md"
      ],
      outputs: [
        "step_archive/step029_planning_chunk1.md",
        "step_archive/outputs/step029_검증.md"
      ],
      requires: ["step022", "step023", "step024", "step028"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "visual-planning-snapshot", kind: "artifact", required: true, path: "step_archive/step029_planning_chunk1.md" },
        { id: "visual-planning-verification", kind: "artifact", required: true, path: "step_archive/outputs/step029_검증.md" },
        { id: "planning-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "evidence-axis-fidelity", kind: "check", required: true },
        { id: "interaction-accessibility-contracts", kind: "check", required: true },
        { id: "visual-evidence-inspection", kind: "check", required: true },
        { id: "planning-chunks-bounded", kind: "check", required: true },
        { id: "bounded-independent-review", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step030"
    },
    {
      number: 30,
      id: "step030",
      title: "통합 설계 (레이아웃 + 전체)",
      phase: "planning",
      source: "assets/steps/step030.md",
      target: "codex/assets/steps/step030.md",
      source_sha256: "0a94d262268fca28ea8cfaa808244910267ab2be03a587ca973aeedf1220dec5",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step029_planning_chunk1.md",
        "step_archive/outputs/step029_검증.md"
      ],
      outputs: [
        "step_archive/outputs/step030_설계대안.md",
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/outputs/step030_최종검증.md"
      ],
      requires: ["step029"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "design-alternatives", kind: "artifact", required: true, path: "step_archive/outputs/step030_설계대안.md" },
        { id: "design-selection", kind: "artifact", required: true, path: "step_archive/outputs/step030_설계선택.md" },
        { id: "layout-design-chunk-1", kind: "artifact", required: true, path: "step_archive/step030_레이아웃설계_chunk1.md" },
        { id: "overall-design-chunk-1", kind: "artifact", required: true, path: "step_archive/step030_전체설계_chunk1.md" },
        { id: "final-design-verification", kind: "artifact", required: true, path: "step_archive/outputs/step030_최종검증.md" },
        { id: "structured-brainstorming-first", kind: "check", required: true },
        { id: "independent-selector", kind: "check", required: true },
        { id: "class-architecture-contract", kind: "check", required: true },
        { id: "async-lifecycle-contract", kind: "check", required: true },
        { id: "responsive-accessibility-contract", kind: "check", required: true },
        { id: "design-chunks-bounded", kind: "check", required: true },
        { id: "pass-verdict", kind: "check", required: true }
      ],
      ported: true,
      next: "step031"
    }
  ]);
});

test("planning source hashes bind the untouched source steps 025 through 030", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(24, 30));

  assert.deepEqual(hashes, {
    step025: "18cce8b074c319963e1467c1680658f261dda92db9289ad62b5e3d3f855b47fd",
    step026: "d926b3c2829ecbd7b8db282f4c8dcc6da4be9312066a0cf6ee33577f1ce3617c",
    step027: "d992b464654670c3e42d53c5faf1df062f7d2afb2563cd1449ac9631757b2b76",
    step028: "458b2d51af051b4cd608895c6a8c6e435fcab45b37ee5c1bbccb34b93733ae09",
    step029: "6c4955cfc3cdce6473c667d56b9f1e9b7bc0a019ef5ec3c843958428d38a83e2",
    step030: "0a94d262268fca28ea8cfaa808244910267ab2be03a587ca973aeedf1220dec5"
  });
});

test("planning acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(24, 30));
  for (const step of mutated) {
    for (const item of step.acceptance) item.description = "x";
  }

  assert.throws(() => assertPlanningAcceptanceDescriptions(mutated));
});

test("planning documents bind exact frontmatter titles and only their current Step heading", async () => {
  const expected = [
    { name: "step025", number: 25, title: "기획: 전체 조사결과 기반 (독립 검증 루프)" },
    { name: "step026", number: 26, title: "기획 보강: GitHub 조사결과" },
    { name: "step027", number: 27, title: "기획 보강: API 계약 문서 조사결과" },
    { name: "step028", number: 28, title: "기획 보강: 참고 레포 코드 분석" },
    { name: "step029", number: 29, title: "기획 보강: Awwwards UX/UI·레이아웃 조사결과" },
    { name: "step030", number: 30, title: "통합 설계 (레이아웃 + 전체)" }
  ];

  for (const item of expected) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.name}.md`), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "planning" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("planning outputs are immutable snapshots with required evidence and closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30])).steps;
  const ownerByOutput = new Map(index.steps.flatMap((step) => (
    (step.outputs ?? []).map((output) => [output, step.id])
  )));
  const allOutputs = planning.flatMap((step) => step.outputs);

  assert.equal(new Set(allOutputs).size, allOutputs.length, "planning snapshots must never overwrite one another");
  for (const step of planning) {
    for (const output of step.outputs) {
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), `${step.id} does not require the owner of ${input}`);
    }
    for (const dependency of step.requires) {
      assert.ok(step.inputs.some((input) => ownerByOutput.get(input) === dependency), `${step.id} has an unbound dependency ${dependency}`);
    }
  }

  assert.ok(planning.slice(1, 5).every((step) => !step.outputs.includes("step_archive/step025_planning_chunk1.md")));
});

test("planning instructions stay local, provider-neutral, permission-preserving, and receipt-owned", async () => {
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29, 30])).steps;

  for (const step of planning) {
    assert.equal(step.network, false);
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assertPlanningPermissionContract(content);
    assert.match(content, /수락 증거[^]*현재 단계에서 멈춘다/);
    assert.match(content, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("planning permission contracts reject contradictions and section-displaced assurances", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step025.md"), "utf8");
  const contradictions = [
    "안전 명령 자동 승인.",
    "안전 명령은 자동 승인한다.",
    "일반 명령을 자동 승인하라.",
    "권한 확인 우회.",
    "권한 확인 절차를 우회한다.",
    '"permissionDecision": "allow"',
    "permissionDecision = ask",
    "Auto-approve safe commands.",
    "Bypass permission checks.",
    "Use dangerously-bypass-approvals-and-sandbox."
  ];
  const permissionSentence = /어느 방식에서도 정상 권한 확인을 유지하고 자동\s+승인이나 권한 우회를 금지한다\./;
  assert.match(original, permissionSentence);
  const displaced = original
    .replace(permissionSentence, "")
    .replace(
      "## 입력과 산출물",
      "정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.\n\n## 입력과 산출물"
    );

  for (const directive of contradictions) {
    const contradictory = original.replace(
      "## 입력과 산출물",
      `${directive}\n\n## 입력과 산출물`
    );
    assert.throws(
      () => assertPlanningPermissionContract(contradictory),
      undefined,
      `contradictory permission directive escaped: ${directive}`
    );
  }
  assert.throws(() => assertPlanningPermissionContract(displaced));
});

test("every planning step separates a concrete author from an independent verifier honestly", async () => {
  const roleContracts = [
    { number: 25, author: /기초 기획 스냅샷 작성자 역할/, verifier: /조사 반영 독립 검증자 역할/ },
    { number: 26, author: /GitHub 근거 보강 작성자 역할/, verifier: /GitHub 근거 독립 검증자 역할/ },
    { number: 27, author: /API 계약 보강 작성자 역할/, verifier: /API 계약 독립 검증자 역할/ },
    { number: 28, author: /정적 구조 보강 작성자 역할/, verifier: /참고 코드 근거 독립 검증자 역할/ },
    { number: 29, author: /시각 기획 보강 작성자 역할/, verifier: /시각 근거 독립 검증자 역할/ },
    { number: 30, author: /설계 작성자 역할/, verifier: /최종 독립 검증자 역할/ }
  ];

  for (const { number, author, verifier } of roleContracts) {
    const id = `step${String(number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const roleSection = /## 실행 역할\n([^]*?)(?=\n## )/.exec(content)?.[1];
    assert.ok(roleSection, `${id} is missing its role contract`);
    const normalized = roleSection.replace(/\s+/g, " ").trim();
    assert.match(normalized, author);
    assert.match(normalized, verifier);
    assert.match(normalized, /독립 검증자[^]*작성 산출물을 수정하지 않는다/);
    assert.match(normalized, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*역할을 명확히 분리[^]*순서대로 수행/);
    assert.match(normalized, /별도 역할을 위임했다고 기록하지 않는다/);
  }
});

test("steps 025 through 029 keep bounded PASS-only review rounds in one declared report each", async () => {
  const planning = (await validateStepBatch(repoRoot, [25, 26, 27, 28, 29])).steps;

  for (const step of planning) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    const report = `step_archive/outputs/${step.id}_검증.md`;
    const mentionedReports = [...new Set(
      [...content.matchAll(/`(step_archive\/outputs\/step0(?:25|26|27|28|29)_검증(?:_r\d+)?\.md)`/g)]
        .map((match) => match[1])
    )].filter((path) => path.includes(`/outputs/${step.id}_검증`));
    assert.deepEqual(mentionedReports, [report]);
    assert.match(content, /모든 라운드[^]*동일한 선언 보고서[^]*라운드별 섹션/);
    assert.match(content, /최대 5라운드/);
    assert.match(content, /`PASS`[^]*경우에만[^]*완료/);
    assert.match(content, /`FAIL`[^]*완료 증거[^]*될 수 없다/);
    assert.match(content, /5라운드[^]*`PASS`[^]*없으면[^]*차단/);
    assert.doesNotMatch(content, /_검증_r[2-5]\.md/);
  }
});

test("step025 bases a bounded, topic-complete snapshot on persisted general research", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step025.md"), "utf8");

  assert.match(content, /가장 먼저[^]*`step_archive\/TOPIC\/TOPIC\.md`/);
  assert.match(content, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(content, /step016_조사결과_chunk1\.md[^]*research-raw-step016-primary\.txt[^]*step016-primary\.png[^]*step024_검증_r1\.md/);
  assert.match(content, /데이터 반영[^]*누락[^]*왜곡[^]*출처 추적/);
  assert.match(content, /주제 일치[^]*타깃 적합성[^]*인터랙티브 충족[^]*사례 반영/);
  assert.match(content, /첫 청크 manifest[^]*500줄 이하/);
  assert.match(content, /실패와 해결[^]*`step_archive\/outputs\/step025_검증\.md`에만/);
  assert.doesNotMatch(content, /failure_patterns|스킵[^]*(?:완료|종료)/i);
});

test("steps 026 through 028 preserve source-specific evidence without rerunning untrusted work", async () => {
  const step26 = await readFile(join(repoRoot, "codex", "assets", "steps", "step026.md"), "utf8");
  const step27 = await readFile(join(repoRoot, "codex", "assets", "steps", "step027.md"), "utf8");
  const step28 = await readFile(join(repoRoot, "codex", "assets", "steps", "step028.md"), "utf8");

  assert.match(step26, /보존된 단일 성공 API 응답[^]*후보와 사실만/);
  assert.match(step26, /새 API 요청[^]*금지/);
  assert.match(step26, /아키텍처[^]*패턴 결정[^]*출처 경로[^]*응답 항목/);

  assert.match(step27, /구체적인 계약 대상[^]*버전[^]*(?:endpoint|message)[^]*data schema/i);
  assert.match(step27, /필수 필드[^]*선택 필드[^]*인증[^]*rate limit[^]*오류[^]*재시도[^]*제한/);
  assert.match(step27, /원본에 없는 필드[^]*발명하지 않는다/);

  assert.match(step28, /격리 복제[^]*정적 분석/);
  assert.match(step28, /코드[^]*(?:실행|설치|빌드|테스트|자동화)[^]*금지/);
  assert.match(step28, /구조[^]*패턴[^]*제약[^]*복제 파일 경로[^]*줄 범위/);
});

test("step029 turns only inspected visual evidence into responsive accessible planning", async () => {
  const step = (await validateStepBatch(repoRoot, [29])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");

  assert.equal(step.visual_review, true);
  assert.ok(step.acceptance.some((item) => (
    item.kind === "artifact" && item.required && item.path === "step_archive/screenshots/research/step022-primary-desktop.png"
  )));
  assert.ok(step.acceptance.some((item) => item.id === "visual-evidence-inspection" && item.required));
  assert.match(content, /실제로 열어[^]*manifest[^]*비교/);
  assert.match(content, /시각 검사 기능[^]*사용할 수 없으면[^]*완료하지 않는다/);
  assert.match(content, /실제로 이름이 붙은 조사 축[^]*근거 있는 대안만/);
  assert.match(content, /레이아웃[^]*UX\/UI[^]*인터랙션[^]*반응형[^]*텍스트 와이어프레임/);
  assert.match(content, /키보드[^]*포커스[^]*터치[^]*reduced-motion[^]*명암/);
});

test("step030 separates three alternatives, independent selection, final design, and verification", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  assertStep30SectionContract(content);
});

test("step030 preserves class, async lifecycle, performance, and accessibility contracts", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  const sections = assertStep30SectionContract(content);

  assert.ok(sections["Class 설계 계약"].length > 0);
  assert.ok(sections["비동기와 성능 계약"].length > 0);
  assert.ok(sections["레이아웃·상호작용·접근성 계약"].length > 0);
});

test("step030 rejects displaced, reordered, contradictory, and incomplete section semantics", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step030.md"), "utf8");
  const explorationHeading = "## 첫 설계 활동: 구조화된 대안 탐색";
  const explorationBody = extractMarkdownSection(original, "첫 설계 활동: 구조화된 대안 탐색");
  const archived = original.replace(
    explorationHeading,
    "## 보관된 비규범 참고 메모"
  );
  const deletedHeading = original.replace(`${explorationHeading}\n`, "");
  const displacedBody = original
    .replace(explorationBody, "규범적 대안 탐색 내용은 이 섹션에 없다.")
    .replace("## 완료 조건", `## 보관된 비규범 참고 메모\n\n${explorationBody}\n\n## 완료 조건`);
  const outOfOrder = original
    .replace("## 독립 선택", "## __TEMP_SELECTION__")
    .replace("## Class 설계 계약", "## 독립 선택")
    .replace("## __TEMP_SELECTION__", "## Class 설계 계약");
  const withoutContrast = original.replaceAll("명암", "시각적 구분");
  const namedExternalSkill = original.replace(
    explorationHeading,
    `${explorationHeading}\n\n먼저 Skill(skill="superpowers:brainstorming")에 의존한다.`
  );
  const asksUserOptions = original.replace(
    "사용자에게 옵션을 질문하지 않고",
    "사용자에게 옵션을 질문한다. 그런 뒤"
  );
  const performsImplementation = original.replace(
    /실제 구현이나\s+패키지 설치는 수행하지 않는다\./,
    "실제 구현과 패키지 설치를 수행한다."
  );
  const selectsMany = original.replace("정확히 하나만 선택", "여러 안을 선택");
  const splitVerificationReports = original.replaceAll(
    "step_archive/outputs/step030_최종검증.md",
    "step_archive/outputs/step030_최종검증_r2.md"
  );
  const unboundedVerification = original.replace(
    "최대 5라운드만 수행한다.",
    "필요한 만큼 반복한다."
  );

  for (const [name, mutation] of Object.entries({
    archived,
    deletedHeading,
    displacedBody,
    outOfOrder,
    withoutContrast,
    namedExternalSkill,
    asksUserOptions,
    performsImplementation,
    selectsMany,
    splitVerificationReports,
    unboundedVerification
  })) {
    assert.notEqual(mutation, original, `mutation did not change the document: ${name}`);
    assert.throws(
      () => assertStep30SectionContract(mutation),
      undefined,
      `step030 section mutation escaped: ${name}`
    );
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

const EXPECTED_IMPLEMENTATION_ACCEPTANCE_DESCRIPTIONS = {
  step031: {
    "environment-preparation-report": "Stores the selected-design, project-manifest, dependency, version, and smoke-check evidence.",
    "selected-design-and-manifests": "Confirms the selected Step 30 design and every present project manifest and lockfile were inspected.",
    "required-dependencies-only": "Confirms only dependencies required by the selected design were considered for installation.",
    "bounded-resolution-smoke": "Confirms every required dependency resolved, reported a version, and passed a bounded smoke check.",
    "permission-preservation": "Confirms conditional installation kept the normal permission flow and never auto-approved a command."
  },
  step032: {
    "implementation-file-index": "Stores the bounded file, Class, function, ownership, and dependency-order implementation map.",
    "selected-design-traceability": "Traces every planned file and symbol to the selected Step 30 design.",
    "bounded-file-ownership": "Confirms every work unit owns one to three files and each declared chunk is at most 500 lines.",
    "optional-tokei-disposition": "Records local tokei evidence or an explicit safe SKIP with deterministic fallback measurements.",
    "dependency-order": "Confirms new and modified files are ordered by their concrete implementation dependencies."
  },
  step033: {
    "jscpd-baseline-summary": "Stores the pre-implementation duplication baseline, tool disposition, and fallback evidence.",
    "jscpd-raw-report": "Stores raw JSON only when the already-local jscpd command succeeds.",
    "local-jscpd-command": "Runs only the already-local jscpd executable with network-disabled package execution.",
    "preimplementation-duplication-snapshot": "Confirms the baseline was captured before implementation changes.",
    "optional-jscpd-disposition": "Records either measured jscpd results or an explicit safe SKIP with a reason.",
    "duplication-fallback": "Records deterministic local fallback measurements when jscpd is unavailable."
  },
  step034: {
    "knip-baseline-summary": "Stores the pre-implementation unused-code baseline, tool disposition, and fallback evidence.",
    "knip-raw-report": "Stores raw JSON only when the already-local knip command succeeds.",
    "local-knip-command": "Runs only the already-local knip executable with network-disabled package execution.",
    "preimplementation-unused-code-snapshot": "Confirms the baseline was captured before implementation changes.",
    "optional-knip-disposition": "Records either measured knip results or an explicit safe SKIP with a reason.",
    "unused-code-fallback": "Records deterministic manifest and import-graph fallback evidence when knip is unavailable."
  },
  step035: {
    "context-policy": "Stores the bounded read, work-unit, checkpoint, and handoff policy used by later implementation.",
    "partial-inspection-policy": "Confirms large files use targeted discovery and bounded partial reads without blind rereads.",
    "small-work-units": "Confirms implementation work is divided into independently checkable one-to-three-file units.",
    "minimal-handoff": "Confirms each checkpoint and handoff contains only paths, decisions, evidence, blockers, and next work.",
    "no-token-balance-claim": "Confirms the policy never invents or claims observation of a hidden token balance."
  },
  step036: {
    "encoding-policy": "Stores the UTF-8-no-BOM, LF, final-newline audit and configuration-preservation evidence.",
    "utf8-lf-final-newline": "Confirms every touched text file is UTF-8 without BOM, uses LF, and ends with a newline.",
    "configuration-preservation": "Confirms existing encoding configuration was preserved and only minimally merged when needed.",
    "byte-level-verification": "Confirms encoding and line endings were verified from file bytes rather than display output.",
    "no-blind-rewrite": "Confirms only changed text files were corrected and binary or unrelated files were not rewritten."
  },
  step037: {
    "implementation-manifest": "Stores implemented files, digests, owners, tests, and traceability to the selected design and topic.",
    "implementation-screenshot-input": "Requires the persisted Step 22 Awwwards screenshot inspected for CSS evidence.",
    "topic-field-fidelity": "Confirms topic, audience, interactive, real-world application, and constraint fields are reflected without modifying TOPIC.",
    "selected-design-only": "Confirms implementation follows only the selected Step 30 design without reopening selection.",
    "class-async-accessibility": "Confirms Class boundaries, asynchronous lifecycle, interactions, and accessibility contracts are implemented.",
    "incremental-test-evidence": "Confirms each owned module was implemented through a failing-test, minimal-change, passing-test cycle.",
    "visual-evidence-inspection": "Confirms the required screenshot was actually opened and CSS decisions trace to observed regions.",
    "independent-implementation-verifier": "Confirms a non-modifying independent verification pass checked the implementation and manifest."
  },
  step038: {
    "build-smoke-report": "Stores the exact build, dist HTML, zero-cycle, and advisory diagnostic results.",
    "implementation-milestone": "Stores the first 38-step quality milestone only after both mandatory gates pass.",
    "dist-index-html": "Requires the build-produced dist/index.html artifact.",
    "project-build-command": "Runs the exact non-optional build script declared by the project manifest.",
    "dist-html-boundary": "Confirms dist/index.html is a regular nonempty file with opening and closing HTML boundaries.",
    "zero-cycle-gate": "Confirms a declared local cycle tool or deterministic local fallback reports zero cycles.",
    "advisory-diagnostics": "Records lint, formatting, and type diagnostics without substituting for either mandatory gate.",
    "pass-only-build-gate": "Confirms both mandatory gates passed before the report and milestone count as completion evidence."
  }
};

function assertImplementationAcceptanceDescriptions(steps) {
  const actual = Object.fromEntries(steps.map((step) => [
    step.id,
    Object.fromEntries(step.acceptance.map((item) => [item.id, item.description]))
  ]));
  assert.deepEqual(actual, EXPECTED_IMPLEMENTATION_ACCEPTANCE_DESCRIPTIONS);
}

const IMPLEMENTATION_ROLE_CONTRACTS = [
  { number: 31, worker: /환경 준비 실행자 역할/, verifier: /환경 준비 독립 검증자 역할/ },
  { number: 32, worker: /파일 인덱스 작성자 역할/, verifier: /파일 인덱스 독립 검증자 역할/ },
  { number: 33, worker: /중복 베이스라인 실행자 역할/, verifier: /중복 베이스라인 독립 검증자 역할/ },
  { number: 34, worker: /미사용 코드 베이스라인 실행자 역할/, verifier: /미사용 코드 베이스라인 독립 검증자 역할/ },
  { number: 36, worker: /인코딩 정책 작성자 역할/, verifier: /인코딩 독립 검증자 역할/ },
  { number: 37, worker: /모듈 구현자 역할/, verifier: /구현 독립 검증자 역할/ },
  { number: 38, worker: /빌드 게이트 실행자 역할/, verifier: /빌드 게이트 독립 검증자 역할/ }
];

function assertImplementationRoleContract(content, { worker, verifier }) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, worker);
  assert.match(roleSection, verifier);
  assert.match(roleSection, /독립 검증자[^]*산출물을 수정하지 않는다/);
  assert.match(roleSection, /위임 기능을 사용할 수 없으면[^]*현재 실행자가[^]*두 역할을 명확히 분리[^]*순서대로 수행/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

function assertStep35RoleContract(content) {
  const roleSection = extractMarkdownSection(content, "실행 역할").replace(/\s+/g, " ");
  assert.match(roleSection, /이 단계에서는 외부 역할에 위임하지 않는다/);
  assert.match(roleSection, /현재 실행자가 정책 수립 패스[^]*분리된 검증 패스[^]*순서대로 수행/);
  assert.match(roleSection, /검증 패스[^]*정책 산출물을 수정하지 않는다/);
  assert.match(roleSection, /별도 역할을 위임했다고 기록하지 않는다/);
  assertPlanningPermissionContract(content);
}

function optionalRemoteToolContradictionRules(tool) {
  return [
    {
      label: `${tool} remote download when the local tool is absent (Korean)`,
      pattern: new RegExp(
        String.raw`(?:로컬|local)[^.!?]{0,40}\b${tool}\b[^.!?]{0,70}(?:없(?:으면|어도)|부재|찾지 못(?:하면)?|미설치)[^.!?]{0,140}(?:(?:원격|네트워크|registry|remote|network)[^.!?]{0,80}(?:다운로드해|다운로드하여|다운로드한다|받아|설치해|설치하여|설치한다|가져와)|(?:다운로드해|다운로드하여|다운로드한다|받아|설치해|설치하여|설치한다|가져와)[^.!?]{0,80}(?:원격|네트워크|registry|remote|network))`,
        "i"
      )
    },
    {
      label: `${tool} remote download when the local tool is absent (English)`,
      pattern: new RegExp(
        String.raw`\blocal\b[^.!?]{0,30}\b${tool}\b[^.!?]{0,70}\b(?:is\s+)?(?:absent|missing|unavailable|not (?:found|installed|available))\b[^.!?]{0,160}(?:(?:\bdownload\b|\bfetch\b|\binstall\b)[^.!?]{0,80}\b(?:network|internet|remote|registry)\b|\b(?:network|internet|remote|registry)\b[^.!?]{0,80}\b(?:download|fetch|install)\b)`,
        "i"
      ),
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:download|fetch|install)\b/i
    }
  ];
}

const IMPLEMENTATION_CONTRADICTION_RULES = new Map([
  [31, [
    {
      label: "failed resolve/version/smoke accepted as PASS (Korean)",
      pattern: /(?:resolve|version|smoke)[^.!?]{0,180}(?:실패|누락|미확인|검증되지)[^.!?]{0,80}(?:해도|하여도|했어도|했는데도|이더라도|인데도|상관없이|무관하게)[^.!?]{0,100}(?:PASS|성공|완료)/i
    },
    {
      label: "failed resolve/version/smoke accepted as PASS (English concession)",
      pattern: /\b(?:even (?:if|when)|despite|regardless of)\b[^.!?]{0,200}\b(?:resolve|version|smoke)\b[^.!?]{0,100}\b(?:fail(?:s|ed)?|failure|missing|unverified)\b[^.!?]{0,140}\b(?:pass|success(?:ful)?|complete(?:d|tion)?)\b/i
    },
    {
      label: "failed resolve/version/smoke accepted as PASS (English still)",
      pattern: /\b(?:resolve|version|smoke)\b[^.!?]{0,120}\b(?:fail(?:s|ed)?|failure|missing|unverified)\b[^.!?]{0,80}\b(?:but|yet|still|anyway)\b[^.!?]{0,80}\b(?:pass(?:es|ed)?|complete(?:s|d)?|success(?:ful)?)\b/i
    },
    {
      label: "PASS recorded despite a failed resolve/version/smoke check (English reverse)",
      pattern: /\b(?:mark|record|treat|declare|count)\b[^.!?]{0,80}\b(?:pass|success(?:ful)?|complete(?:d)?)\b[^.!?]{0,100}\bdespite\b[^.!?]{0,80}\b(?:failed|failing|missing|unverified)\b[^.!?]{0,60}\b(?:resolve|version|smoke)\b/i
    }
  ]],
  [32, [
    {
      label: "overlapping ownership or unclosed dependency order accepted as PASS (Korean)",
      pattern: /(?:(?:파일\s*)?소유권[^.!?]{0,100}(?:겹치|중복|충돌)|의존성\s*순서[^.!?]{0,100}(?:닫히지|미완성|열려))[^.!?]{0,180}(?:않아도|해도|하여도|이어도|여도|인데도|허용하고도|허용해도|상관없이|무관하게)[^.!?]{0,100}(?:PASS|완료|성공)/i
    },
    {
      label: "overlapping ownership or unclosed dependency order accepted as PASS (English concession)",
      pattern: /\b(?:even (?:if|when)|despite|regardless of)\b[^.!?]{0,220}(?:\bfile ownership\b[^.!?]{0,70}\b(?:overlap(?:s|ped|ping)?|conflict(?:s|ed|ing)?)\b|\bdependency order\b[^.!?]{0,70}\b(?:unclosed|open|incomplete)\b)[^.!?]{0,150}\b(?:pass(?:es|ed)?|complete(?:s|d)?|success(?:ful)?)\b/i
    },
    {
      label: "overlapping ownership or unclosed dependency order accepted as PASS (English still)",
      pattern: /(?:\bfile ownership\b[^.!?]{0,70}\b(?:overlap(?:s|ped|ping)?|conflict(?:s|ed|ing)?)\b|\bdependency order\b[^.!?]{0,70}\b(?:unclosed|open|incomplete)\b)[^.!?]{0,120}\bstill\b[^.!?]{0,70}\b(?:pass(?:es|ed)?|complete(?:s|d)?|success(?:ful)?)\b/i
    },
    {
      label: "overlapping ownership declared acceptable (English)",
      pattern: /\b(?:overlapping|conflicting)\s+(?:file\s+)?ownership\b[^.!?]{0,60}\b(?:is|remains)\s+(?:acceptable|allowed)\b/i
    }
  ]],
  [33, optionalRemoteToolContradictionRules("jscpd")],
  [34, optionalRemoteToolContradictionRules("knip")],
  [35, [
    {
      label: "hidden token balance observation claim (Korean)",
      pattern: /(?:숨겨진|관찰할 수 없는)[^.!?]{0,80}(?:토큰|token)[^.!?]{0,50}(?:잔량|balance|한계)[^.!?]{0,100}(?:관찰했다고|확인했다고|측정했다고|알고 있다고)[^.!?]{0,60}(?:주장한다|보고한다|기록한다|공언한다)/i
    },
    {
      label: "hidden token balance observation claim (English)",
      pattern: /\b(?:claim|report|state|assert|pretend)\b[^.!?]{0,100}\bhidden\b[^.!?]{0,50}\btoken\b[^.!?]{0,50}\b(?:balance|remaining|remainder|budget)\b[^.!?]{0,90}\b(?:observed|measured|known|visible)\b/i,
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:claim|report|state|assert|pretend)\b/i
    },
    {
      label: "hidden token balance observation reported (English reverse)",
      pattern: /\b(?:observed|measured|know|knew)\b[^.!?]{0,100}\bhidden\b[^.!?]{0,60}\b(?:token|context)\b[^.!?]{0,50}\b(?:balance|remaining|remainder|budget)\b[^.!?]{0,100}\b(?:claim|report|state)\b/i,
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:claim|report|state)\b/i
    }
  ]],
  [36, [
    {
      label: "BOM or CRLF explicitly allowed (Korean)",
      pattern: /(?:BOM|CRLF)[^.!?]{0,60}(?:허용한다|허용해도 된다|허용하고|사용한다|유지한다)/i
    },
    {
      label: "whole tree or all files bulk rewritten (Korean)",
      pattern: /(?:(?:모든|전체)[^.!?]{0,50}(?:파일|tree)[^.!?]{0,60}(?:일괄|한꺼번에)|(?:일괄|한꺼번에)[^.!?]{0,60}(?:모든|전체)[^.!?]{0,50}(?:파일|tree))[^.!?]{0,50}(?:재작성한다|변환한다|덮어쓴다)/i
    },
    {
      label: "BOM or CRLF explicitly allowed (English)",
      pattern: /\b(?:allow|accept|permit|keep|use)\b[^.!?]{0,60}\b(?:BOM|CRLF)\b/i,
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:allow|accept|permit|keep|use)\b/i
    },
    {
      label: "BOM or CRLF declared acceptable (English reverse)",
      pattern: /\b(?:BOM|CRLF)\b[^.!?]{0,60}\b(?:is|are)\s+(?:allowed|acceptable|permitted)\b/i
    },
    {
      label: "whole tree or all files bulk rewritten (English)",
      pattern: /(?:\bbulk\b[^.!?]{0,40}\brewrite\b[^.!?]{0,60}\b(?:all|every|entire)\b|\b(?:rewrite|convert|overwrite)\b[^.!?]{0,60}\b(?:all|every|entire)\b[^.!?]{0,40}\b(?:file|tree|repository)\b)/i,
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:bulk\s+)?(?:rewrite|convert|overwrite)\b/i
    }
  ]],
  [37, [
    {
      label: "screenshot not actually opened but accepted as PASS (Korean)",
      pattern: /(?:스크린샷|screenshot)[^.!?]{0,100}(?:실제로\s*)?(?:열지|검사하지|확인하지)[^.!?]{0,50}(?:않아도|못해도|않고도|없이도)[^.!?]{0,100}(?:PASS|완료|성공)/i
    },
    {
      label: "PASS without opening or inspecting the screenshot (English)",
      pattern: /\b(?:mark|record|declare|count|treat)\b[^.!?]{0,60}\b(?:pass|complete(?:d)?)\b[^.!?]{0,80}\bwithout\b[^.!?]{0,60}\b(?:actually\s+)?(?:opening|inspecting|viewing)\b[^.!?]{0,50}\b(?:the\s+)?screenshot\b/i
    },
    {
      label: "PASS even without opening or inspecting the screenshot (English reverse)",
      pattern: /\b(?:pass|complete(?:d)?)\b[^.!?]{0,60}\b(?:even\s+)?without\b[^.!?]{0,60}\b(?:actually\s+)?(?:opening|inspecting|viewing)\b[^.!?]{0,50}\b(?:the\s+)?screenshot\b/i
    },
    {
      label: "unopened screenshot still accepted as PASS (English)",
      pattern: /\bscreenshot\b[^.!?]{0,80}\b(?:need not|does not need to|was not|is not|isn't)\b[^.!?]{0,50}\b(?:open(?:ed)?|inspect(?:ed)?|view(?:ed)?)\b[^.!?]{0,100}\b(?:still|yet|anyway|can|may)\b[^.!?]{0,70}\b(?:pass|complete(?:d)?)\b/i
    }
  ]],
  [38, [
    {
      label: "failed build or cycle gate accepted as PASS/milestone (Korean)",
      pattern: /(?:빌드|build|순환\s*의존성|cycle)[^.!?]{0,160}(?:실패|0개가 아니|남아 있|검증하지 못)[^.!?]{0,80}(?:해도|하여도|했어도|했는데도|인데도|이더라도)[^.!?]{0,120}(?:PASS|milestone|마일스톤|완료|기록)/i
    },
    {
      label: "failed build or cycle gate accepted as PASS/milestone (English concession)",
      pattern: /\b(?:even (?:if|when)|despite|regardless of)\b[^.!?]{0,200}\b(?:build|cycle(?:\s+(?:check|gate|scan))?)\b[^.!?]{0,100}\b(?:fail(?:s|ed)?|failure|nonzero|broken)\b[^.!?]{0,150}\b(?:record|write|emit|create|mark)\b[^.!?]{0,80}\b(?:pass|milestone|complete(?:d)?)\b/i
    },
    {
      label: "PASS/milestone recorded despite a failed build or cycle gate (English reverse)",
      pattern: /\b(?:record|write|emit|create|mark)\b[^.!?]{0,80}\b(?:pass|milestone|complete(?:d)?)\b[^.!?]{0,100}\bdespite\b[^.!?]{0,80}\b(?:failed|failing|broken|nonzero)\b[^.!?]{0,60}\b(?:build|cycle)\b/i,
      unless: /\b(?:do not|don't|never|must not|cannot|can't|may not)\s+(?:record|write|emit|create|mark)\b/i
    },
    {
      label: "failed build or cycle gate still records PASS/milestone (English)",
      pattern: /\b(?:build|cycle(?:\s+(?:check|gate|scan))?)\b[^.!?]{0,100}\b(?:fail(?:s|ed)?|failure|nonzero|broken)\b[^.!?]{0,80}\b(?:but|yet|still|anyway)\b[^.!?]{0,100}\b(?:record|write|emit|create|mark)\b[^.!?]{0,80}\b(?:pass|milestone|complete(?:d)?)\b/i
    }
  ]]
]);

function assertNoImplementationContradictions(content, number) {
  const rules = IMPLEMENTATION_CONTRADICTION_RULES.get(number);
  assert.ok(rules, `missing implementation contradiction rules for step${String(number).padStart(3, "0")}`);
  const statements = content.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").split(/(?<=[.!?。])\s+/u);

  for (const statement of statements) {
    for (const { label, pattern, unless } of rules) {
      if (pattern.test(statement) && !(unless?.test(statement))) {
        assert.fail(`step${String(number).padStart(3, "0")} contradiction: ${label}`);
      }
    }
  }
}

const IMPLEMENTATION_CONTRADICTION_MUTATIONS = [
  {
    number: 31,
    contradictions: [
      ["ko", "resolve/version/smoke가 실패해도 PASS로 완료한다."],
      ["ko-general", "smoke 검증에 실패했는데도 성공으로 처리한다."],
      ["en", "Even if resolve, version, or smoke fails, still mark the step PASS and complete."],
      ["en-still", "The smoke check failed, yet the environment step still passes."],
      ["en-reverse", "Mark the step complete despite a failed smoke check."]
    ],
    safeControls: [
      "resolve/version/smoke 중 하나라도 실패하면 PASS로 완료하지 않는다.",
      "If resolve, version, or smoke fails, do not mark PASS or complete."
    ]
  },
  {
    number: 32,
    contradictions: [
      ["ko", "파일 소유권이 겹치거나 의존성 순서가 닫히지 않아도 PASS로 완료한다."],
      ["ko-general", "파일 소유권 충돌을 허용하고도 완료로 처리한다."],
      ["en", "Even if file ownership overlaps or dependency order remains unclosed, still mark PASS and complete."],
      ["en-still", "File ownership overlaps but the index still passes."],
      ["en-acceptable", "Overlapping file ownership is acceptable."]
    ],
    safeControls: [
      "파일 소유권이 겹치거나 의존성 순서가 닫히지 않으면 PASS로 완료하지 않는다.",
      "If file ownership overlaps or dependency order remains unclosed, do not mark PASS or complete."
    ]
  },
  {
    number: 33,
    contradictions: [
      ["ko", "로컬 jscpd가 없으면 원격에서 다운로드해 실행한다."],
      ["ko-general", "로컬 jscpd가 부재하면 registry에서 받아 실행한다."],
      ["en", "If local jscpd is absent, download it from the network and run it."],
      ["en-general", "Local jscpd is unavailable; fetch it from the registry."]
    ],
    safeControls: [
      "로컬 jscpd가 없으면 원격 다운로드하지 않고 SKIP과 fallback을 기록한다.",
      "If local jscpd is absent, do not download it; record SKIP and the fallback."
    ]
  },
  {
    number: 34,
    contradictions: [
      ["ko", "로컬 knip이 없으면 원격에서 다운로드해 실행한다."],
      ["ko-general", "로컬 knip이 부재하면 registry에서 받아 실행한다."],
      ["en", "If local knip is absent, download it from the network and run it."],
      ["en-general", "Local knip is unavailable; fetch it from the registry."]
    ],
    safeControls: [
      "로컬 knip이 없으면 원격 다운로드하지 않고 SKIP과 fallback을 기록한다.",
      "If local knip is absent, do not download it; record SKIP and the fallback."
    ]
  },
  {
    number: 35,
    contradictions: [
      ["ko", "숨겨진 토큰 잔량을 관찰했다고 주장한다."],
      ["ko-general", "숨겨진 token balance를 측정했다고 보고한다."],
      ["en", "Claim that the hidden token balance was observed."],
      ["en-reverse", "We observed the hidden token balance and report it as known."]
    ],
    safeControls: [
      "숨겨진 토큰 잔량을 관찰했다고 주장하지 않는다.",
      "Never claim that a hidden token balance was observed."
    ]
  },
  {
    number: 36,
    contradictions: [
      ["ko", "BOM과 CRLF를 허용하고 모든 파일을 일괄 재작성한다."],
      ["ko-crlf", "CRLF를 허용한다."],
      ["ko-bulk", "전체 repository 파일을 일괄 재작성한다."],
      ["en", "Allow BOM and CRLF, then bulk rewrite every file."],
      ["en-reverse", "CRLF is acceptable."],
      ["en-bulk", "Bulk rewrite every file in the repository."]
    ],
    safeControls: [
      "BOM과 CRLF를 허용하지 않으며 모든 파일을 일괄 재작성하지 않는다.",
      "Do not allow BOM or CRLF, and never bulk rewrite every file."
    ]
  },
  {
    number: 37,
    contradictions: [
      ["ko", "스크린샷을 실제로 열지 않아도 PASS로 완료한다."],
      ["ko-general", "screenshot을 확인하지 않고도 성공으로 처리한다."],
      ["en", "Mark PASS without actually opening or inspecting the screenshot."],
      ["en-general", "The screenshot need not be opened; the step can still PASS."],
      ["en-reverse", "The step can PASS even without inspecting the screenshot."]
    ],
    safeControls: [
      "스크린샷을 실제로 열지 못하면 PASS로 완료하지 않는다.",
      "Do not mark PASS when the screenshot was not actually opened or inspected."
    ]
  },
  {
    number: 38,
    contradictions: [
      ["ko", "빌드나 순환 의존성 검사가 실패해도 PASS로 milestone을 기록한다."],
      ["ko-general", "cycle gate가 실패했는데도 완료로 기록한다."],
      ["en", "Even if the build or cycle check fails, record PASS and the milestone."],
      ["en-reverse", "Record the milestone despite a failed cycle gate."],
      ["en-still", "The build failed, yet we still record PASS."]
    ],
    safeControls: [
      "빌드나 순환 의존성 검사가 실패하면 PASS나 milestone을 기록하지 않는다.",
      "If the build or cycle check fails, do not record PASS or the milestone."
    ]
  }
];

test("implementation batch declares the exact Codex-native evidence contracts", async () => {
  const report = await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38]);
  assertImplementationAcceptanceDescriptions(report.steps);
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
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.command_pattern === undefined ? {} : { command_pattern: item.command_pattern })
    })),
    ported: step.ported,
    next: step.next
  }));

  assert.deepEqual(projected, [
    {
      number: 31,
      id: "step031",
      title: "환경 준비",
      phase: "implementation",
      source: "assets/steps/step031.md",
      target: "codex/assets/steps/step031.md",
      source_sha256: "f825f56718e9399018639a61c4d09e6a4726639b0561976436976ca42372c094",
      inputs: [
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md"
      ],
      outputs: ["step_archive/step031_환경준비.md"],
      requires: ["step030"],
      optional_requires: [],
      network: true,
      visual_review: false,
      acceptance: [
        { id: "environment-preparation-report", kind: "artifact", required: true, path: "step_archive/step031_환경준비.md" },
        { id: "selected-design-and-manifests", kind: "check", required: true },
        { id: "required-dependencies-only", kind: "check", required: true },
        { id: "bounded-resolution-smoke", kind: "check", required: true },
        { id: "permission-preservation", kind: "check", required: true }
      ],
      ported: true,
      next: "step032"
    },
    {
      number: 32,
      id: "step032",
      title: "구현 파일 인덱싱 (tokei)",
      phase: "implementation",
      source: "assets/steps/step032.md",
      target: "codex/assets/steps/step032.md",
      source_sha256: "1ca75809d8fec4aeabe496dfbe412d22f551abc2004b2fff0f82f55b4cd40f5f",
      inputs: [
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/step031_환경준비.md"
      ],
      outputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      requires: ["step030", "step031"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "implementation-file-index", kind: "artifact", required: true, path: "step_archive/step032_파일인덱스_chunk1.md" },
        { id: "selected-design-traceability", kind: "check", required: true },
        { id: "bounded-file-ownership", kind: "check", required: true },
        { id: "optional-tokei-disposition", kind: "check", required: true },
        { id: "dependency-order", kind: "check", required: true }
      ],
      ported: true,
      next: "step033"
    },
    {
      number: 33,
      id: "step033",
      title: "jscpd 코드 중복 베이스라인 수집",
      phase: "implementation",
      source: "assets/steps/step033.md",
      target: "codex/assets/steps/step033.md",
      source_sha256: "1d92fd81e2ecf485817a5a78f8846b5376e40e3ab58cb45fad606c09a2a74659",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step033_jscpd베이스라인.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "jscpd-baseline-summary", kind: "artifact", required: true, path: "step_archive/step033_jscpd베이스라인.md" },
        { id: "jscpd-raw-report", kind: "artifact", required: false, path: "step_archive/jscpd-baseline/jscpd-report.json" },
        { id: "local-jscpd-command", kind: "command", required: false, command_pattern: "^npm exec --offline -- jscpd src/ --reporters json --output step_archive/jscpd-baseline/$" },
        { id: "preimplementation-duplication-snapshot", kind: "check", required: true },
        { id: "optional-jscpd-disposition", kind: "check", required: true },
        { id: "duplication-fallback", kind: "check", required: true }
      ],
      ported: true,
      next: "step034"
    },
    {
      number: 34,
      id: "step034",
      title: "knip 미사용 코드 베이스라인 수집",
      phase: "implementation",
      source: "assets/steps/step034.md",
      target: "codex/assets/steps/step034.md",
      source_sha256: "f82ed6a8cd582b740d39d53e75b8b31b75b4b9b759b48d8d63add97cd24f4671",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step034_knip베이스라인.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "knip-baseline-summary", kind: "artifact", required: true, path: "step_archive/step034_knip베이스라인.md" },
        { id: "knip-raw-report", kind: "artifact", required: false, path: "step_archive/knip-baseline.json" },
        { id: "local-knip-command", kind: "command", required: false, command_pattern: "^npm exec --offline -- knip --reporter json$" },
        { id: "preimplementation-unused-code-snapshot", kind: "check", required: true },
        { id: "optional-knip-disposition", kind: "check", required: true },
        { id: "unused-code-fallback", kind: "check", required: true }
      ],
      ported: true,
      next: "step035"
    },
    {
      number: 35,
      id: "step035",
      title: "컨텍스트 윈도우 제한 방지",
      phase: "implementation",
      source: "assets/steps/step035.md",
      target: "codex/assets/steps/step035.md",
      source_sha256: "664d663cc7ed8cbb8605e3c5c5d2653fb139421eb469e81d1f08201fbf284acd",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md"],
      outputs: ["step_archive/step035_컨텍스트정책.md"],
      requires: ["step032"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "context-policy", kind: "artifact", required: true, path: "step_archive/step035_컨텍스트정책.md" },
        { id: "partial-inspection-policy", kind: "check", required: true },
        { id: "small-work-units", kind: "check", required: true },
        { id: "minimal-handoff", kind: "check", required: true },
        { id: "no-token-balance-claim", kind: "check", required: true }
      ],
      ported: true,
      next: "step036"
    },
    {
      number: 36,
      id: "step036",
      title: "인코딩 규칙 (모지바케 방지)",
      phase: "implementation",
      source: "assets/steps/step036.md",
      target: "codex/assets/steps/step036.md",
      source_sha256: "27787a5adeff811a6ce6b1f8c58fe9afc0703139f049e88a705b6e911b2fcec0",
      inputs: ["step_archive/step032_파일인덱스_chunk1.md", "step_archive/step035_컨텍스트정책.md"],
      outputs: ["step_archive/step036_인코딩정책.md"],
      requires: ["step032", "step035"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "encoding-policy", kind: "artifact", required: true, path: "step_archive/step036_인코딩정책.md" },
        { id: "utf8-lf-final-newline", kind: "check", required: true },
        { id: "configuration-preservation", kind: "check", required: true },
        { id: "byte-level-verification", kind: "check", required: true },
        { id: "no-blind-rewrite", kind: "check", required: true }
      ],
      ported: true,
      next: "step037"
    },
    {
      number: 37,
      id: "step037",
      title: "구현",
      phase: "implementation",
      source: "assets/steps/step037.md",
      target: "codex/assets/steps/step037.md",
      source_sha256: "dbfc0b0c5f6412dbb13615bb1b7e60140a084ff8eab0254eb67c6c582378b82e",
      inputs: [
        "step_archive/TOPIC/TOPIC.md",
        "step_archive/step022_수집결과_chunk1.md",
        "step_archive/awwwards-step022-primary.txt",
        "step_archive/screenshots/research/step022-primary-desktop.png",
        "step_archive/step023_조사결과_chunk1.md",
        "step_archive/outputs/step030_설계선택.md",
        "step_archive/step030_레이아웃설계_chunk1.md",
        "step_archive/step030_전체설계_chunk1.md",
        "step_archive/step031_환경준비.md",
        "step_archive/step032_파일인덱스_chunk1.md",
        "step_archive/step035_컨텍스트정책.md",
        "step_archive/step036_인코딩정책.md"
      ],
      outputs: ["step_archive/step037_구현manifest.md"],
      requires: ["step022", "step023", "step030", "step031", "step032", "step035", "step036"],
      optional_requires: [],
      network: false,
      visual_review: true,
      acceptance: [
        { id: "implementation-manifest", kind: "artifact", required: true, path: "step_archive/step037_구현manifest.md" },
        { id: "implementation-screenshot-input", kind: "artifact", required: true, path: "step_archive/screenshots/research/step022-primary-desktop.png" },
        { id: "topic-field-fidelity", kind: "check", required: true },
        { id: "selected-design-only", kind: "check", required: true },
        { id: "class-async-accessibility", kind: "check", required: true },
        { id: "incremental-test-evidence", kind: "check", required: true },
        { id: "visual-evidence-inspection", kind: "check", required: true },
        { id: "independent-implementation-verifier", kind: "check", required: true }
      ],
      ported: true,
      next: "step038"
    },
    {
      number: 38,
      id: "step038",
      title: "빌드 스모크 테스트 (구현 완료 게이트)",
      phase: "implementation",
      source: "assets/steps/step038.md",
      target: "codex/assets/steps/step038.md",
      source_sha256: "a582363f00adf1a81f0a55471ac5bce95b2819bb4cc096e43cb4decc2118565e",
      inputs: [
        "step_archive/step031_환경준비.md",
        "step_archive/step033_jscpd베이스라인.md",
        "step_archive/step034_knip베이스라인.md",
        "step_archive/step037_구현manifest.md"
      ],
      outputs: ["step_archive/step038_smoke_test.md", "step_archive/outputs/trust5_r1.md"],
      requires: ["step031", "step033", "step034", "step037"],
      optional_requires: [],
      network: false,
      visual_review: false,
      acceptance: [
        { id: "build-smoke-report", kind: "artifact", required: true, path: "step_archive/step038_smoke_test.md" },
        { id: "implementation-milestone", kind: "artifact", required: true, path: "step_archive/outputs/trust5_r1.md" },
        { id: "dist-index-html", kind: "artifact", required: true, path: "dist/index.html" },
        { id: "project-build-command", kind: "command", required: true, command_pattern: "^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run) (?:build|[A-Za-z0-9][A-Za-z0-9:_-]*build[A-Za-z0-9:_-]*)$" },
        { id: "dist-html-boundary", kind: "check", required: true },
        { id: "zero-cycle-gate", kind: "check", required: true },
        { id: "advisory-diagnostics", kind: "check", required: true },
        { id: "pass-only-build-gate", kind: "check", required: true }
      ],
      ported: true,
      next: "step039"
    }
  ]);
});

test("implementation source hashes bind the untouched source steps 031 through 038", async () => {
  const index = await loadIndex(repoRoot);
  const hashes = await recordSourceHashes(repoRoot, index.steps.slice(30, 38));

  assert.deepEqual(hashes, {
    step031: "f825f56718e9399018639a61c4d09e6a4726639b0561976436976ca42372c094",
    step032: "1ca75809d8fec4aeabe496dfbe412d22f551abc2004b2fff0f82f55b4cd40f5f",
    step033: "1d92fd81e2ecf485817a5a78f8846b5376e40e3ab58cb45fad606c09a2a74659",
    step034: "f82ed6a8cd582b740d39d53e75b8b31b75b4b9b759b48d8d63add97cd24f4671",
    step035: "664d663cc7ed8cbb8605e3c5c5d2653fb139421eb469e81d1f08201fbf284acd",
    step036: "27787a5adeff811a6ce6b1f8c58fe9afc0703139f049e88a705b6e911b2fcec0",
    step037: "dbfc0b0c5f6412dbb13615bb1b7e60140a084ff8eab0254eb67c6c582378b82e",
    step038: "a582363f00adf1a81f0a55471ac5bce95b2819bb4cc096e43cb4decc2118565e"
  });
});

test("implementation acceptance descriptions reject placeholder-wide mutation", async () => {
  const index = await loadIndex(repoRoot);
  const mutated = structuredClone(index.steps.slice(30, 38));
  for (const step of mutated) {
    for (const item of step.acceptance ?? []) item.description = "x";
  }

  assert.throws(() => assertImplementationAcceptanceDescriptions(mutated));
});

test("implementation documents bind exact frontmatter titles and only their current Step heading", async () => {
  const expected = [
    { name: "step031", number: 31, title: "환경 준비" },
    { name: "step032", number: 32, title: "구현 파일 인덱싱 (tokei)" },
    { name: "step033", number: 33, title: "jscpd 코드 중복 베이스라인 수집" },
    { name: "step034", number: 34, title: "knip 미사용 코드 베이스라인 수집" },
    { name: "step035", number: 35, title: "컨텍스트 윈도우 제한 방지" },
    { name: "step036", number: 36, title: "인코딩 규칙 (모지바케 방지)" },
    { name: "step037", number: 37, title: "구현" },
    { name: "step038", number: 38, title: "빌드 스모크 테스트 (구현 완료 게이트)" }
  ];

  for (const item of expected) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.name}.md`), "utf8");
    assert.deepEqual(parseStepDocument(content), {
      frontmatter: { name: item.name, phase: "implementation" },
      titles: [{ number: item.number, title: item.title }],
      referencedSteps: [item.number]
    });
  }
});

test("implementation outputs are unique required artifacts with closed direct dependencies", async () => {
  const index = await loadIndex(repoRoot);
  const implementation = (await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38])).steps;
  const ownersByOutput = new Map();
  for (const step of index.steps) {
    for (const output of step.outputs ?? []) {
      const owners = ownersByOutput.get(output) ?? [];
      owners.push(step.id);
      ownersByOutput.set(output, owners);
    }
  }
  const ownerByOutput = new Map(
    [...ownersByOutput].map(([output, owners]) => [output, owners.length === 1 ? owners[0] : null])
  );
  const allOutputs = implementation.flatMap((step) => step.outputs);

  assert.equal(new Set(allOutputs).size, allOutputs.length);
  for (const step of implementation) {
    for (const output of step.outputs) {
      assert.deepEqual(ownersByOutput.get(output), [step.id], `${output} must have exactly one canonical owner`);
      assert.ok(step.acceptance.some((item) => (
        item.kind === "artifact" && item.required && item.path === output
      )), `${step.id} output lacks required artifact evidence: ${output}`);
    }
    for (const input of step.inputs) {
      const owner = ownerByOutput.get(input);
      if (owner) assert.ok(step.requires.includes(owner), `${step.id} does not require the owner of ${input}`);
    }
    for (const dependency of step.requires) {
      assert.ok(step.inputs.some((input) => ownerByOutput.get(input) === dependency), `${step.id} has an unbound dependency ${dependency}`);
    }
  }
});

test("implementation instructions stay provider-neutral, permission-preserving, and receipt-owned", async () => {
  const implementation = (await validateStepBatch(repoRoot, [31, 32, 33, 34, 35, 36, 37, 38])).steps;

  for (const step of implementation) {
    const content = await readFile(join(repoRoot, step.target), "utf8");
    assertNoImplementationContradictions(content, step.number);
    assert.deepEqual(scanForbiddenTokens(content), []);
    assert.doesNotMatch(content, /(?:progress|state)\.json|\.harness50-codex|transcript/i);
    assert.doesNotMatch(content, /\/(?:webapp|harness-status|harness-reset)\b|\$(?:webapp|harness50-status|harness50-reset)\b/i);
    assert.doesNotMatch(content, /\b(?:SessionStart|UserPromptSubmit|PreToolUse|Stop)\b|\bhooks?\b/i);
    assert.doesNotMatch(content, /(?:다음|후속)\s*(?:Step|단계)|\bnext\s+step\b/i);
    assertPlanningPermissionContract(content);
    const normalized = content.replace(/\s+/g, " ");
    assert.match(normalized, /수락 증거[^]*현재 단계에서 멈춘다/);
    assert.match(normalized, /workflow 상태와 영수증[^]*진행을 소유/);
  }
});

test("implementation contracts reject appended Korean and English semantic contradictions", async () => {
  const escaped = [];

  for (const { number, contradictions, safeControls } of IMPLEMENTATION_CONTRADICTION_MUTATIONS) {
    const id = `step${String(number).padStart(3, "0")}`;
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assert.doesNotThrow(
      () => assertNoImplementationContradictions(original, number),
      `${id} baseline must remain valid`
    );

    for (const safeControl of safeControls) {
      assert.doesNotThrow(
        () => assertNoImplementationContradictions(`${original}\n\n${safeControl}\n`, number),
        `${id} rejected safe negative language: ${safeControl}`
      );
    }

    for (const [language, contradiction] of contradictions) {
      try {
        assertNoImplementationContradictions(`${original}\n\n${contradiction}\n`, number);
        escaped.push(`${id}:${language}`);
      } catch (error) {
        assert.match(error.message, new RegExp(`^${id} contradiction:`));
      }
    }
  }

  assert.deepEqual(escaped, []);
});

test("implementation roles are concrete, independently verified, and truthfully fall back", async () => {
  for (const contract of IMPLEMENTATION_ROLE_CONTRACTS) {
    const id = `step${String(contract.number).padStart(3, "0")}`;
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    assertImplementationRoleContract(content, contract);
  }

  const step35 = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  assertStep35RoleContract(step35);
});

test("implementation role and permission checks reject per-step removals and contradictions", async () => {
  for (const contract of IMPLEMENTATION_ROLE_CONTRACTS) {
    const id = `step${String(contract.number).padStart(3, "0")}`;
    const original = await readFile(join(repoRoot, "codex", "assets", "steps", `${id}.md`), "utf8");
    const workerRemoved = original.replace(contract.worker, "삭제된 실행 역할");
    const verifierRemoved = original.replace(contract.verifier, "삭제된 검증 역할");
    const fallbackRemoved = original.replace(/위임 기능을\s*사용할 수 없으면[^.]+\./, "위임할 수 없으면 그대로 완료한다.");
    const contradiction = original.replace("## 입력과 산출물", "안전 명령은 자동 승인한다.\n\n## 입력과 산출물");

    for (const [name, mutation] of Object.entries({ workerRemoved, verifierRemoved, fallbackRemoved, contradiction })) {
      assert.notEqual(mutation, original, `${id} mutation did not change content: ${name}`);
      assert.throws(
        () => assertImplementationRoleContract(mutation, contract),
        undefined,
        `${id} role mutation escaped: ${name}`
      );
    }
  }

  const step35 = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  for (const [name, mutation] of Object.entries({
    delegated: step35.replace("이 단계에서는 외부 역할에 위임하지 않는다", "이 단계는 외부 역할에 위임한다"),
    mergedPass: step35.replace(/분리된\s*검증 패스/, "같은 정책 수립 패스"),
    contradiction: step35.replace("## 입력과 산출물", "권한 확인 절차를 우회한다.\n\n## 입력과 산출물")
  })) {
    assert.notEqual(mutation, step35, `step035 mutation did not change content: ${name}`);
    assert.throws(() => assertStep35RoleContract(mutation), undefined, `step035 mutation escaped: ${name}`);
  }
});

test("step031 installs only required dependencies through bounded normal-permission checks", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step031.md"), "utf8");
  const section = extractMarkdownSection(content, "환경 확인과 설치").replace(/\s+/g, " ");

  assert.match(section, /설계선택[^]*레이아웃설계[^]*전체설계/);
  assert.match(section, /manifest[^]*lockfile/i);
  assert.match(section, /선택된 설계에 필수인 프로젝트 의존성만/);
  assert.match(section, /최대 3회/);
  assert.match(section, /resolve[^]*version[^]*smoke/i);
  assert.match(section, /실패[^]*차단/);
  assert.doesNotMatch(content, /dependency-checker|자동 설치|설치 없이[^]*완료/i);
});

test("step032 creates a bounded dependency-ordered file and symbol ownership map", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step032.md"), "utf8");
  const section = extractMarkdownSection(content, "파일 인덱스 작성").replace(/\s+/g, " ");

  assert.match(section, /파일[^]*Class[^]*함수/);
  assert.match(section, /신규[^]*수정/);
  assert.match(section, /의존성 순서/);
  assert.match(section, /1~3개 파일/);
  assert.match(section, /500줄 이하/);
  assert.match(section, /로컬 `tokei`[^]*선택 사항/);
  assert.match(section, /없으면[^]*`SKIP`[^]*안전한 파일 열거[^]*줄 수/);
  assert.doesNotMatch(section, /(?:설치|다운로드)[^]*(?:tokei)|npx/i);
});

test("steps033 and 034 keep optional baselines local and preserve mandatory summaries", async () => {
  const cases = [
    {
      id: "step033",
      heading: "선택적 jscpd 베이스라인",
      tool: "jscpd",
      summary: "step_archive/step033_jscpd베이스라인.md",
      raw: "step_archive/jscpd-baseline/jscpd-report.json",
      fallback: /중복[^]*fallback/i
    },
    {
      id: "step034",
      heading: "선택적 knip 베이스라인",
      tool: "knip",
      summary: "step_archive/step034_knip베이스라인.md",
      raw: "step_archive/knip-baseline.json",
      fallback: /manifest[^]*import[^]*fallback/i
    }
  ];

  for (const item of cases) {
    const content = await readFile(join(repoRoot, "codex", "assets", "steps", `${item.id}.md`), "utf8");
    const section = extractMarkdownSection(content, item.heading).replace(/\s+/g, " ");
    assert.match(section, /구현 변경 전/);
    assert.match(section, new RegExp(`로컬[^]*${item.tool}`));
    assert.match(section, /네트워크[^]*사용하지 않는다/);
    assert.match(section, /없으면[^]*`SKIP`[^]*이유/);
    assert.match(section, item.fallback);
    assert.match(section, new RegExp(item.summary.replaceAll("/", "\\/")));
    assert.match(section, new RegExp(item.raw.replaceAll("/", "\\/")));
    assert.match(section, /원시 JSON[^]*성공한 경우에만[^]*선택적/);
    assert.doesNotMatch(content, /\bnpx\b|(?:설치|다운로드)[^]*(?:jscpd|knip)/i);
  }
});

test("step035 defines bounded reads, small work units, checkpoints, and honest handoffs", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step035.md"), "utf8");
  const section = extractMarkdownSection(content, "컨텍스트 정책").replace(/\s+/g, " ");

  assert.match(section, /필요한 범위만 부분적으로 읽/);
  assert.match(section, /읽은 범위[^]*다시 읽지 않는다/);
  assert.match(section, /1~3개 파일/);
  assert.match(section, /체크포인트/);
  assert.match(section, /경로[^]*결정[^]*증거[^]*차단 요인[^]*다음 작업/);
  assert.match(section, /토큰 잔량[^]*관찰했다고 주장하지 않는다/);
  assert.doesNotMatch(section, /토큰[^]*(?:\d+%|남았다|확인했다|측정했다)/);
});

test("step036 enforces byte-verified UTF-8 LF without destructive configuration rewrites", async () => {
  const content = await readFile(join(repoRoot, "codex", "assets", "steps", "step036.md"), "utf8");
  const section = extractMarkdownSection(content, "인코딩 정책").replace(/\s+/g, " ");

  assert.match(section, /UTF-8[^]*BOM 없음[^]*LF[^]*마지막 줄바꿈/);
  assert.match(section, /바이트[^]*검증/);
  assert.match(section, /\.editorconfig[^]*\.gitattributes[^]*보존[^]*병합/);
  assert.match(section, /변경한 텍스트 파일만[^]*바이너리[^]*재작성하지 않는다/);
  assert.doesNotMatch(content, /Set-Content[^\n]*-Encoding\s+UTF8|무조건[^]*(?:덮어쓰|재작성)/i);
});

function assertStep37ImplementationContract(content) {
  const section = extractMarkdownSection(content, "선택 설계 구현").replace(/\s+/g, " ");
  assert.match(section, /TOPIC\.md[^]*수정하지 않는다/);
  assert.match(section, /`topic`[^]*`audience`[^]*`interactive`[^]*`real_world_apps`[^]*`constraints`/);
  assert.match(section, /선택된 30단계 설계만[^]*다시 선택하지 않는다/);
  assert.match(section, /파일\/모듈 소유권[^]*1~3개 파일/);
  assert.match(section, /실패하는 테스트[^]*최소 구현[^]*통과[^]*리팩터링/);
  assert.match(section, /Class[^]*async[^]*접근성/);
  assert.match(section, /step022-primary-desktop\.png[^]*실제로 열어[^]*CSS[^]*화면 영역/);
  assert.match(section, /시각 검사 기능[^]*사용할 수 없으면[^]*차단/);
  assert.match(section, /구현manifest\.md[^]*파일[^]*digest[^]*요구 추적/);
  assert.doesNotMatch(section, /(?:브레인스토밍|brainstorm)|대안을 새로|선택을 변경/i);
}

test("step037 implements only the selected topic-complete design with real visual inspection", async () => {
  const step = (await validateStepBatch(repoRoot, [37])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");

  assert.equal(step.visual_review, true);
  assert.ok(step.acceptance.some((item) => (
    item.kind === "artifact" && item.required && item.path === "step_archive/screenshots/research/step022-primary-desktop.png"
  )));
  assert.ok(step.acceptance.some((item) => item.id === "visual-evidence-inspection" && item.required));
  assertStep37ImplementationContract(content);
});

test("step037 section checks reject missing topic fields, reselection, fake inspection, and missing manifest traceability", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step037.md"), "utf8");
  const mutations = {
    missingAudience: original.replace("`audience`", "`target_group`"),
    reselection: original.replace("다시 선택하지 않는다", "필요하면 선택을 변경한다"),
    fakeInspection: original.replace("실제로 열어", "파일명만 확인해"),
    missingDigest: original.replace("digest", "파일 크기"),
    noVisualBlock: original.replace("시각 검사 기능을 사용할 수 없으면", "시각 검사 기능을 사용할 수 없어도")
  };

  assertStep37ImplementationContract(original);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(mutation, original, `step037 mutation did not change content: ${name}`);
    assert.throws(() => assertStep37ImplementationContract(mutation), undefined, `step037 mutation escaped: ${name}`);
  }
});

function assertStep38GateContract(content) {
  const section = extractMarkdownSection(content, "필수 빌드와 순환 의존성 게이트").replace(/\s+/g, " ");
  assert.match(section, /project manifest[^]*선언된[^]*build[^]*정확한 명령/);
  assert.match(section, /exit code 0[^]*실패[^]*차단/i);
  assert.match(section, /dist\/index\.html[^]*일반 파일[^]*0바이트보다 크[^]*<html[^]*<\/html>/i);
  assert.match(section, /순환 의존성이 0개인지 별도 필수 gate로 확인한다/);
  assert.match(section, /로컬[^]*(?:cycle|madge)[^]*결정적 정적 import graph fallback/i);
  assert.match(section, /두 필수 게이트[^]*`PASS`[^]*trust5_r1\.md/);
  assert.match(section, /lint[^]*format[^]*type[^]*경고[^]*필수 게이트를 대체하지 않는다/i);
  assert.doesNotMatch(content, /--if-present|\bnpx\b|html-bundler|step\s*0?81|스킵[^]*(?:빌드|순환)/i);
}

test("step038 is a non-skippable declared-build and zero-cycle PASS gate", async () => {
  const step = (await validateStepBatch(repoRoot, [38])).steps[0];
  const content = await readFile(join(repoRoot, step.target), "utf8");
  const commandItems = step.acceptance.filter((item) => item.kind === "command");

  assertStep38GateContract(content);
  assert.equal(commandItems.length, 1);
  assert.equal(commandItems[0].required, true);
  assert.match(commandItems[0].command_pattern, /^\^/);
  assert.match(commandItems[0].command_pattern, /\$$/);
  assert.doesNotThrow(() => new RegExp(commandItems[0].command_pattern));
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run build"), true);
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run test"), false);
  assert.equal(new RegExp(commandItems[0].command_pattern).test("npm run build --if-present"), false);
});

test("optional tooling command patterns are anchored, offline, and cannot accept implicit downloads", async () => {
  const steps = (await validateStepBatch(repoRoot, [33, 34])).steps;

  for (const step of steps) {
    const item = step.acceptance.find((acceptance) => acceptance.kind === "command");
    assert.equal(item.required, false);
    assert.match(item.command_pattern, /^\^/);
    assert.match(item.command_pattern, /\$$/);
    assert.match(item.command_pattern, /--offline/);
    assert.doesNotMatch(item.command_pattern, /\bnpx\b|--yes/);
    assert.doesNotThrow(() => new RegExp(item.command_pattern));
  }
});

test("step038 section checks reject optional builds, empty HTML, skipped cycles, stale bundlers, and premature milestones", async () => {
  const original = await readFile(join(repoRoot, "codex", "assets", "steps", "step038.md"), "utf8");
  const mutations = {
    optionalBuild: original.replace("정확한 명령", "--if-present를 붙인 명령"),
    emptyHtml: original.replace("0바이트보다 크고", "0바이트여도 되고"),
    skippedCycles: original.replace("순환 의존성이 0개", "순환 의존성은 스킵"),
    staleBundler: original.replace("## 완료 조건", "html-bundler.ps1을 실행한다.\n\n## 완료 조건"),
    prematureMilestone: original.replace("두 필수 게이트가 모두 `PASS`인 뒤에만", "빌드 전에도")
  };

  assertStep38GateContract(original);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(mutation, original, `step038 mutation did not change content: ${name}`);
    assert.throws(() => assertStep38GateContract(mutation), undefined, `step038 mutation escaped: ${name}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SKILL_URL = new URL("../skills/", import.meta.url);

async function readSkill(name) {
  return readFile(new URL(`${name}/SKILL.md`, SKILL_URL), "utf8");
}

function parseSkill(text) {
  const match = /^---\n([^]*?)\n---\n([^]*)$/.exec(text);
  assert.ok(match, "skill must have one LF-delimited frontmatter block");
  const fields = match[1].split("\n").map(line => {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  });
  assert.deepEqual(fields.map(([key]) => key), ["name", "description"]);
  return { frontmatter: Object.fromEntries(fields), body: match[2] };
}

function section(body, heading) {
  const marker = `## ${heading}\n`;
  const start = body.indexOf(marker);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const contentStart = start + marker.length;
  const next = body.indexOf("\n## ", contentStart);
  return body.slice(contentStart, next === -1 ? body.length : next);
}

function requiredText(errors, content, values, scope) {
  for (const value of values) {
    if (!content.includes(value)) errors.push(`${scope} missing ${value}`);
  }
}

function mutationRejected(validator, text) {
  try {
    return validator(text).length > 0;
  } catch {
    return true;
  }
}

function webappContractErrors(text) {
  const errors = [];
  let skill;
  try {
    skill = parseSkill(text);
  } catch (error) {
    return [error.message];
  }
  if (skill.frontmatter.name !== "webapp") errors.push("frontmatter name must be webapp");
  if (!skill.frontmatter.description.startsWith("Use when ")) {
    errors.push("description must start with Use when");
  }

  const resources = section(skill.body, "Resources");
  requiredText(errors, resources, [
    "../../scripts/harness-state.mjs",
    "../../assets/steps/stepNNN.md",
    "relative to this SKILL.md"
  ], "resources");

  const topic = section(skill.body, "`$webapp <topic>`");
  requiredText(errors, topic, [
    "`show` first",
    "active Codex workflow",
    "detected Claude progress",
    "`$webapp resume`",
    "different topic",
    "separate workspace",
    "neither exists",
    "nonempty topic",
    "`init`"
  ], "topic");
  if (!/active Codex workflow[^\n]*do not call `init`/i.test(topic)) {
    errors.push("topic must not overwrite active Codex work");
  }
  if (!/detected Claude progress[^\n]*do not call `init`/i.test(topic)) {
    errors.push("topic must not overwrite detected Claude progress");
  }

  const resume = section(skill.body, "`$webapp resume`");
  requiredText(errors, resume, [
    "valid Codex state",
    "`reconcile`",
    "`resume`",
    "no Codex state",
    "Claude progress exists",
    "`import-claude`",
    "imported",
    "codex_verified",
    "import_error.code",
    "source_preserved",
    "repair the Claude state or use a separate workspace",
    "`$webapp <topic>`"
  ], "resume");
  if (!/only if no Codex state[^\n]*Claude progress exists[^\n]*`import-claude`/i.test(resume)) {
    errors.push("resume import predicate is not exclusive");
  }

  const pause = section(skill.body, "`$webapp pause`");
  requiredText(errors, pause, ["only `pause`", "paused", "current step"], "pause");
  if (/`(?:begin|complete|resume|reconcile|import-claude|init)`/.test(pause)) {
    errors.push("pause section contains a continuation operation");
  }

  const execution = section(skill.body, "One-step execution");
  requiredText(errors, execution, [
    "exactly `state.current_step`",
    "`begin`",
    "../../assets/steps/stepNNN.md",
    "acceptance ID",
    "acceptance kind",
    "structured evidence",
    "`complete`",
    "`fail`",
    "reason and evidence",
    "do not invent completion",
    "never start the next step in the same turn"
  ], "execution");

  const handoff = section(skill.body, "Boundaries and handoff");
  requiredText(errors, handoff, [
    "normal Codex permission confirmations",
    "already-trusted Stop hook",
    "one next-step marker",
    "a failed step may be selected again only in a later turn",
    "inactive or untrusted",
    "chain stops",
    "never change or bypass hook trust"
  ], "handoff");

  if (/(?:^|\s)\/(?:webapp|harness-status|harness-reset)\b/m.test(text)) {
    errors.push("Claude slash invocation found");
  }
  if (/PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|--plugin-root/.test(text)) {
    errors.push("ambient plugin root found");
  }
  if (/dangerously-bypass|permissionDecision\s*:\s*allow|auto[- ]?approv|disable[^\n]*sandbox|change[^\n]*approval|trust (?:the )?hooks?/i.test(text)) {
    errors.push("permission or trust bypass found");
  }
  if (/\b(?:read|write|edit|modify|delete|move|archive)\b[^\n`]*(?:state|receipt|event|import|progress)[^\n`]*\.json(?:l)?/i.test(text)) {
    errors.push("direct workflow JSON operation found");
  }
  if (/\b(?:all remaining|every remaining|steps? 1 through 50)\b/i.test(execution)) {
    errors.push("multi-step execution found");
  }
  return errors;
}

function statusContractErrors(text) {
  const errors = [];
  let skill;
  try {
    skill = parseSkill(text);
  } catch (error) {
    return [error.message];
  }
  if (skill.frontmatter.name !== "harness50-status") {
    errors.push("frontmatter name must be harness50-status");
  }
  if (!skill.frontmatter.description.startsWith("Use when ")) {
    errors.push("description must start with Use when");
  }

  const resources = section(skill.body, "Resources");
  requiredText(errors, resources, [
    "../../scripts/harness-state.mjs",
    "relative to this SKILL.md"
  ], "resources");

  const operation = section(skill.body, "Status operation");
  requiredText(errors, operation, [
    "`$harness50-status`",
    "Call only `show`",
    "strictly read-only"
  ], "operation");
  const mutatingOperations = [
    "init", "import-claude", "begin", "complete", "fail",
    "pause", "resume", "reconcile", "reset"
  ];
  for (const name of mutatingOperations) {
    if (skill.body.includes(`\`${name}\``)) errors.push(`status skill contains ${name}`);
  }

  const report = section(skill.body, "Report");
  requiredText(errors, report, [
    "`active`",
    "`claude_progress_found`",
    "`status`",
    "`current_step`",
    "`completions.imported`",
    "`completions.codex_verified`",
    "`completions.total`",
    "`diagnostics`",
    "`import_error.code`",
    "`source_preserved`",
    "`action`",
    "repair the Claude state or use a separate workspace",
    "Imported historical completion is not Codex verification",
    "No follow-up workflow operation"
  ], "report");

  if (/(?:^|\s)\/(?:webapp|harness-status|harness-reset)\b/m.test(text)) {
    errors.push("Claude slash invocation found");
  }
  if (/\$(?:webapp|harness50-reset)\b/.test(text)) {
    errors.push("unrelated Codex skill invocation found");
  }
  if (/PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|--plugin-root/.test(text)) {
    errors.push("ambient plugin root found");
  }
  if (/dangerously-bypass|permissionDecision\s*:\s*allow|auto[- ]?approv|disable[^\n]*sandbox|trust (?:the )?hooks?/i.test(text)) {
    errors.push("permission or trust bypass found");
  }
  if (/\b(?:read|write|edit|modify|delete|move|archive)\b[^\n`]*(?:state|receipt|event|import|progress)[^\n`]*\.json(?:l)?/i.test(text)) {
    errors.push("direct workflow JSON operation found");
  }
  if (/imported historical completion is Codex verification/i.test(text)) {
    errors.push("imported completion mislabeled as verified");
  }
  return errors;
}

function resetContractErrors(text) {
  const errors = [];
  let skill;
  try {
    skill = parseSkill(text);
  } catch (error) {
    return [error.message];
  }
  if (skill.frontmatter.name !== "harness50-reset") {
    errors.push("frontmatter name must be harness50-reset");
  }
  if (!skill.frontmatter.description.startsWith("Use when ")) {
    errors.push("description must start with Use when");
  }

  const resources = section(skill.body, "Resources");
  requiredText(errors, resources, [
    "../../scripts/harness-state.mjs",
    "relative to this SKILL.md"
  ], "resources");

  const operation = section(skill.body, "Reset operation");
  requiredText(errors, operation, [
    "`$harness50-reset`",
    "Call only `reset`",
    "recoverably deactivate only Codex control metadata"
  ], "operation");
  for (const name of [
    "init", "show", "import-claude", "begin", "complete",
    "fail", "pause", "resume", "reconcile"
  ]) {
    if (skill.body.includes(`\`${name}\``)) errors.push(`reset skill contains ${name}`);
  }

  const result = section(skill.body, "Preserved data and result");
  requiredText(errors, result, [
    "returned `backupPath`",
    "Claude `step_archive/progress.json`",
    "`TOPIC`",
    "shared outputs",
    "project and application source",
    "No workflow starts automatically",
    "user chooses the next action"
  ], "result");

  if (/(?:^|\s)\/(?:webapp|harness-status|harness-reset)\b/m.test(text)) {
    errors.push("Claude slash invocation found");
  }
  if (/\$(?:webapp|harness50-status)\b/.test(text)) {
    errors.push("unrelated Codex skill invocation found");
  }
  if (/PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|--plugin-root/.test(text)) {
    errors.push("ambient plugin root found");
  }
  if (/dangerously-bypass|permissionDecision\s*:\s*allow|auto[- ]?approv|disable[^\n]*sandbox|trust (?:the )?hooks?/i.test(text)) {
    errors.push("permission or trust bypass found");
  }
  if (/(?:^|[\s`])(?:rm|rmdir|Remove-Item|delete|move|archive)(?:[\s`]|$)/i.test(text)) {
    errors.push("direct destructive file operation found");
  }
  if (/\b(?:read|write|edit|modify|delete|move|archive)\b[^\n`]*(?:state|receipt|event|import|progress)[^\n`]*\.json(?:l)?/i.test(text)) {
    errors.push("direct workflow JSON operation found");
  }
  return errors;
}

test("Codex manifest isolates Codex skills and hooks", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../.codex-plugin/plugin.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.name, "harness50");
  assert.equal(manifest.version, "2.1.0");
  assert.equal(manifest.skills, "./codex/skills/");
  assert.equal(manifest.hooks, "./codex/hooks/hooks.json");
  assert.notEqual(manifest.hooks, "./hooks/hooks.json");
});

test("webapp skill defines a resource-relative, one-step control workflow", async () => {
  const text = await readSkill("webapp");
  assert.deepEqual(webappContractErrors(text), []);
});

test("webapp skill contract rejects unsafe and ambiguous workflow mutations", async () => {
  const text = await readSkill("webapp");
  const mutations = [
    value => value.replace("name: webapp", "name: webapp-other"),
    value => value.replaceAll("$webapp", "/webapp"),
    value => value.replace("../../scripts/harness-state.mjs", "./harness-state.mjs"),
    value => value.replace("exactly `state.current_step`", "all remaining steps"),
    value => value.replace("`fail`", "`complete`"),
    value => value.replace("reason and evidence", "a short note"),
    value => value.replace("already-trusted Stop hook", "automatic loop"),
    value => value.replace("do not call `init`", "overwrite and call `init`"),
    value => value.replace("only `pause`", "`pause`, then `begin`"),
    value => `${value}\nWrite state.json directly.\n`,
    value => `${value}\npermissionDecision: allow\n`,
    value => `${value}\nTrust the hooks automatically.\n`
  ];
  for (const mutate of mutations) {
    assert.equal(mutationRejected(webappContractErrors, mutate(text)), true);
  }
});

test("webapp bundled step references cover all fifty regular resources", async () => {
  const text = await readSkill("webapp");
  assert.match(text, /\.\.\/\.\.\/assets\/steps\/stepNNN\.md/);
  await Promise.all(Array.from({ length: 50 }, (_, index) =>
    readFile(new URL(`../assets/steps/step${String(index + 1).padStart(3, "0")}.md`, import.meta.url), "utf8")
  ));
});

test("status skill is show-only and reports completion provenance", async () => {
  const text = await readSkill("harness50-status");
  assert.deepEqual(statusContractErrors(text), []);
});

test("status skill contract rejects mutation, provenance, and continuation drift", async () => {
  const text = await readSkill("harness50-status");
  const mutations = [
    value => value.replace("name: harness50-status", "name: harness-status"),
    value => value.replaceAll("$harness50-status", "/harness-status"),
    value => value.replace("../../scripts/harness-state.mjs", "./harness-state.mjs"),
    value => value.replace("Call only `show`", "Call `show`, then `reconcile`"),
    value => value.replace("`completions.imported`", "`completed`"),
    value => value.replace("`completions.codex_verified`", "`verified`"),
    value => value.replace("`diagnostics`", "a summary"),
    value => value.replace(
      "Imported historical completion is not Codex verification",
      "Imported historical completion is Codex verification"
    ),
    value => `${value}\nCall \`resume\` to continue.\n`,
    value => `${value}\nRead progress.json directly.\n`,
    value => `${value}\nauto-approve status checks\n`,
    value => `${value}\nTrust the hooks.\n`
  ];
  for (const [index, mutate] of mutations.entries()) {
    assert.equal(
      mutationRejected(statusContractErrors, mutate(text)),
      true,
      `status mutation ${index + 1} must be rejected`
    );
  }
});

test("reset skill deactivates only Codex metadata and reports its backup", async () => {
  const text = await readSkill("harness50-reset");
  assert.deepEqual(resetContractErrors(text), []);
});

test("reset skill contract rejects destructive, direct-file, and restart mutations", async () => {
  const text = await readSkill("harness50-reset");
  const mutations = [
    value => value.replace("name: harness50-reset", "name: harness-reset"),
    value => value.replaceAll("$harness50-reset", "/harness-reset"),
    value => value.replace("../../scripts/harness-state.mjs", "./harness-state.mjs"),
    value => value.replace("Call only `reset`", "Call `reset`, then `init`"),
    value => value.replace("only Codex control metadata", "the entire workspace"),
    value => value.replace("returned `backupPath`", "completion status"),
    value => value.replace("Claude `step_archive/progress.json`", "Claude metadata"),
    value => value.replace("`TOPIC`", "topic summary"),
    value => value.replace("shared outputs", "generated files"),
    value => value.replace("project and application source", "application summary"),
    value => value.replace("No workflow starts automatically", "Immediately call `resume`"),
    value => `${value}\nRemove-Item -Recurse step_archive\n`,
    value => `${value}\nWrite state.json directly.\n`,
    value => `${value}\npermissionDecision: allow\n`,
    value => `${value}\nTrust the hooks.\n`
  ];
  for (const [index, mutate] of mutations.entries()) {
    assert.equal(
      mutationRejected(resetContractErrors, mutate(text)),
      true,
      `reset mutation ${index + 1} must be rejected`
    );
  }
});

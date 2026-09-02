import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const temporaryRoot = resolve(tmpdir());
const workspaces = new Set();

function cleanupPath(path) {
  const target = resolve(path);
  const pathFromTemporaryRoot = relative(temporaryRoot, target);
  if (
    pathFromTemporaryRoot === "" ||
    pathFromTemporaryRoot === ".." ||
    pathFromTemporaryRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromTemporaryRoot) ||
    !pathFromTemporaryRoot.startsWith("harness50-codex-")
  ) {
    throw new Error(`refusing to clean up path outside the test temporary directory: ${target}`);
  }
  return target;
}

process.once("exit", () => {
  for (const workspace of workspaces) {
    rmSync(cleanupPath(workspace), { recursive: true, force: true });
  }
});

export async function makeWorkspace() {
  const workspace = cleanupPath(mkdtempSync(join(temporaryRoot, "harness50-codex-")));
  workspaces.add(workspace);
  return workspace;
}

export async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function makePluginFixture({ missingStep = null } = {}) {
  const pluginRoot = await makeWorkspace();
  const stepsRoot = join(pluginRoot, "codex", "assets", "steps");
  await mkdir(stepsRoot, { recursive: true });
  const steps = Array.from({ length: 50 }, (_, offset) => {
    const number = offset + 1;
    const id = `step${String(number).padStart(3, "0")}`;
    return {
      number,
      id,
      title: `Fixture step ${number}`,
      target: `codex/assets/steps/${id}.md`,
      acceptance: [38, 44, 50].includes(number)
        ? [{ id: `quality-milestone-${number}`, kind: "check", required: true }]
        : []
    };
  });
  await writeFile(
    join(stepsRoot, "index.json"),
    `${JSON.stringify({ schema_version: 1, steps }, null, 2)}\n`,
    "utf8"
  );
  for (const step of steps) {
    if (step.number === missingStep) continue;
    await writeFile(join(pluginRoot, step.target), `# ${step.title}\n`, "utf8");
  }
  return pluginRoot;
}

export async function writeClaudeFixture(workspaceRoot, progress, {
  bom = false,
  raw = null,
  topic = "Fixture topic\n"
} = {}) {
  const archiveRoot = join(workspaceRoot, "step_archive");
  await mkdir(join(archiveRoot, "TOPIC"), { recursive: true });
  if (topic !== null) await writeFile(join(archiveRoot, "TOPIC", "TOPIC.md"), topic, "utf8");
  const json = raw ?? `${JSON.stringify(progress, null, 2)}\n`;
  const bytes = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")])
    : Buffer.from(json, "utf8");
  await writeFile(join(archiveRoot, "progress.json"), bytes);
  return bytes;
}

export async function writeClaudeCompletedPrefix(workspaceRoot, length, options = {}) {
  const completedSteps = Array.from({ length }, (_, offset) => offset + 1);
  return writeClaudeFixture(workspaceRoot, {
    total_steps: 50,
    current_step: length === 50 ? 50 : length + 1,
    completed_steps: completedSteps
  }, options);
}

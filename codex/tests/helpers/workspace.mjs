import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

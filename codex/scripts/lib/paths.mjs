import { isAbsolute, relative, resolve, sep, join } from "node:path";

import { HarnessError } from "./errors.mjs";

function workspaceRootFor(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new HarnessError("WORKSPACE_REQUIRED", "workspace root is required");
  }
  return resolve(workspaceRoot);
}

export function assertInside(workspaceRoot, candidatePath) {
  const root = workspaceRootFor(workspaceRoot);
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    throw new HarnessError("PATH_REQUIRED", "candidate path is required");
  }

  const candidate = resolve(candidatePath);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new HarnessError("PATH_OUTSIDE_WORKSPACE", "path escapes the selected workspace", {
      workspace_root: root,
      path: candidate
    });
  }
  return candidate;
}

export function pathsFor(workspaceRoot) {
  const root = workspaceRootFor(workspaceRoot);
  const codexDir = assertInside(root, join(root, "step_archive", ".harness50-codex"));
  return {
    workspaceRoot: root,
    codexDir,
    statePath: assertInside(root, join(codexDir, "state.json")),
    receiptsDir: assertInside(root, join(codexDir, "receipts")),
    importsDir: assertInside(root, join(codexDir, "imports")),
    eventsPath: assertInside(root, join(codexDir, "events.jsonl")),
    lockPath: assertInside(root, join(codexDir, "run.lock")),
    backupsDir: assertInside(root, join(codexDir, "backups")),
    importErrorPath: assertInside(root, join(codexDir, "import-error.json"))
  };
}

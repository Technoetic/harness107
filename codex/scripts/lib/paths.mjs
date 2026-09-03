import * as nativePath from "node:path";
import { win32 } from "node:path";

import { HarnessError } from "./errors.mjs";

function usesWindowsPathFlavor(value) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value);
}

function workspaceRootFor(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new HarnessError("WORKSPACE_REQUIRED", "workspace root is required");
  }
  const path = usesWindowsPathFlavor(workspaceRoot) ? win32 : nativePath;
  return { path, root: path.resolve(workspaceRoot) };
}

export function assertInside(workspaceRoot, candidatePath) {
  const { path, root } = workspaceRootFor(workspaceRoot);
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    throw new HarnessError("PATH_REQUIRED", "candidate path is required");
  }

  if (path !== win32 && usesWindowsPathFlavor(candidatePath)) {
    throw new HarnessError("PATH_OUTSIDE_WORKSPACE", "path uses a different path flavor than the selected workspace", {
      workspace_root: root,
      path: candidatePath
    });
  }
  const candidate = path.resolve(candidatePath);
  const pathFromRoot = path.relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromRoot)) {
    throw new HarnessError("PATH_OUTSIDE_WORKSPACE", "path escapes the selected workspace", {
      workspace_root: root,
      path: candidate
    });
  }
  return candidate;
}

export function pathsFor(workspaceRoot) {
  const { path, root } = workspaceRootFor(workspaceRoot);
  const codexDir = assertInside(root, path.join(root, "step_archive", ".harness50-codex"));
  return {
    workspaceRoot: root,
    codexDir,
    statePath: assertInside(root, path.join(codexDir, "state.json")),
    receiptsDir: assertInside(root, path.join(codexDir, "receipts")),
    importsDir: assertInside(root, path.join(codexDir, "imports")),
    eventsPath: assertInside(root, path.join(codexDir, "events.jsonl")),
    lockPath: assertInside(root, path.join(codexDir, "run.lock")),
    backupsDir: assertInside(root, path.join(codexDir, "backups")),
    importErrorPath: assertInside(root, path.join(codexDir, "import-error.json"))
  };
}

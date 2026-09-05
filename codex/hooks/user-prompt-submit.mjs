import { acceptStopDelivery, pauseWorkflow } from "../scripts/lib/workflow.mjs";
import {
  assertHookStorageGuard,
  captureHookStorageGuard,
  isDirectEntrypoint,
  runHookDirect
} from "../scripts/lib/hook-io.mjs";

const CONTROL_PROMPT = /^(?:\$(?:harness50:)?harness50-(?:status|reset)|\$harness50:(?:status|reset)|\$(?:harness50:)?webapp(?: [^\r\n]+)?)$/;

function unsafe(error) {
  return error?.code === "WORKSPACE_PATH_UNSAFE" || error?.code === "HOOK_WORKSPACE_UNSAFE";
}

export async function handleUserPromptSubmit(event, { workspaceRoot, eventNow } = {}) {
  // Native Codex omits these fields for the primary agent. Subagent types are
  // arbitrary role names, not a fixed "worker" enum (rust-v0.150.1 hook_runtime.rs).
  if (typeof event.agent_id === "string" || typeof event.agent_type === "string") return {};
  const storage = await captureHookStorageGuard(workspaceRoot);
  if (!storage.identities.has(storage.paths.codexDir)) {
    await assertHookStorageGuard(storage);
    return {};
  }
  const prompt = event.prompt;
  const observedNow = typeof eventNow === "function" ? eventNow() : eventNow;
  await assertHookStorageGuard(storage, [storage.paths.statePath, storage.paths.eventsPath]);
  if (CONTROL_PROMPT.test(prompt)) return {};
  try {
    if (await acceptStopDelivery({
      workspaceRoot,
      prompt,
      now: observedNow
    })) return {};
    await pauseWorkflow({
      workspaceRoot,
      reason: "USER_REQUEST",
      now: observedNow
    });
  } catch (error) {
    if (unsafe(error)) throw error;
    // Human prompts are never blocked by lifecycle bookkeeping failures.
  }
  return {};
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("UserPromptSubmit", handleUserPromptSubmit);
}

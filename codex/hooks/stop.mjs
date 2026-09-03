import { processStop } from "../scripts/lib/workflow.mjs";
import {
  assertHookStorageGuard,
  captureHookStorageGuard,
  continuationMarker,
  isDirectEntrypoint,
  runHookDirect
} from "../scripts/lib/hook-io.mjs";

const QUIET_STOP_ERRORS = new Set([
  "EVENT_LOG_LIMIT",
  "STATE_INVALID",
  "STATE_PARSE_ERROR",
  "STOP_INVALID",
  "WORKFLOW_NOT_FOUND"
]);

export async function handleStop(event, { workspaceRoot, eventNow } = {}) {
  const storage = await captureHookStorageGuard(workspaceRoot);
  if (!storage.identities.has(storage.paths.codexDir)) {
    await assertHookStorageGuard(storage);
    return {};
  }
  const observed = {
    turnId: event.turn_id,
    stopHookActive: event.stop_hook_active,
    now: typeof eventNow === "function" ? eventNow() : eventNow
  };
  await assertHookStorageGuard(storage, [storage.paths.statePath, storage.paths.eventsPath]);
  let result;
  try {
    result = await processStop({
      workspaceRoot,
      turnId: observed.turnId,
      stopHookActive: observed.stopHookActive,
      now: observed.now
    });
  } catch (error) {
    if (QUIET_STOP_ERRORS.has(error?.code)) return {};
    throw error;
  }
  if (result.decision !== "block" || result.continuation === null) return {};
  return {
    decision: "block",
    reason: continuationMarker(result.continuation)
  };
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("Stop", handleStop);
}

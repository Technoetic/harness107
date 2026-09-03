import { classifyPreToolUse, deny } from "../scripts/lib/guard.mjs";
import {
  appendPinnedHookEvent,
  assertHookStorageGuard,
  captureHookStorageGuard,
  guardedHookOperation,
  isDirectEntrypoint,
  runHookDirect,
  withHookStorageLock
} from "../scripts/lib/hook-io.mjs";
import { readState } from "../scripts/lib/state-store.mjs";

function unsafe(error) {
  return error?.code === "WORKSPACE_PATH_UNSAFE" || error?.code === "HOOK_WORKSPACE_UNSAFE";
}

export async function handlePreToolUse(event, {
  workspaceRoot,
  eventNow,
  readStateFn = readState,
  appendEventFn = appendPinnedHookEvent
} = {}) {
  const observed = await captureHookStorageGuard(workspaceRoot, { includeLock: false });
  if (!observed.identities.has(observed.paths.codexDir)) {
    await assertHookStorageGuard(observed);
    return {};
  }

  let decision;
  try {
    return await withHookStorageLock(workspaceRoot, async guard => {
      let state;
      try {
        state = await guardedHookOperation(
          guard,
          [guard.paths.statePath],
          () => readStateFn(workspaceRoot)
        );
      } catch (error) {
        if (unsafe(error)) throw error;
        return {};
      }
      if (state === null || state.status !== "running") return {};

      const result = await classifyPreToolUse(event, { workspaceRoot, active: true });
      decision = result.denied ? deny(result.ruleId) : {};
      if (!result.supported) return decision;
      try {
        await guardedHookOperation(
          guard,
          [guard.paths.eventsPath],
          () => appendEventFn(guard, {
            kind: result.denied ? "guard_denied" : "guard_deferred",
            tool_name: event.tool_name,
            rule_id: result.ruleId
          }, { now: eventNow })
        );
      } catch {
        // Telemetry is best-effort and can never weaken or strengthen the decision.
      }
      return decision;
    });
  } catch (error) {
    if (decision !== undefined) return decision;
    throw error;
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("PreToolUse", handlePreToolUse);
}

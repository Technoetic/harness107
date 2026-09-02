import { classifyPreToolUse, deny } from "../scripts/lib/guard.mjs";
import {
  isDirectEntrypoint,
  runHookDirect
} from "../scripts/lib/hook-io.mjs";
import { appendEvent, readState } from "../scripts/lib/state-store.mjs";

export async function handlePreToolUse(event, {
  workspaceRoot,
  eventNow,
  readStateFn = readState,
  appendEventFn = appendEvent
} = {}) {
  let state;
  try {
    state = await readStateFn(workspaceRoot);
  } catch {
    return {};
  }
  if (state === null || state.status !== "running") return {};

  const result = await classifyPreToolUse(event, { workspaceRoot, active: true });
  const output = result.denied ? deny(result.ruleId) : {};
  if (!result.supported) return output;
  try {
    await appendEventFn(workspaceRoot, {
      kind: result.denied ? "guard_denied" : "guard_deferred",
      tool_name: event.tool_name,
      rule_id: result.ruleId
    }, { now: eventNow });
  } catch {
    // Telemetry is best-effort and can never weaken or strengthen the decision.
  }
  return output;
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("PreToolUse", handlePreToolUse);
}

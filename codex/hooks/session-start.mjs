import { appendEvent, readState } from "../scripts/lib/state-store.mjs";
import {
  guardedHookOperation,
  isDirectEntrypoint,
  runHookDirect,
  withHookStorageLock
} from "../scripts/lib/hook-io.mjs";

function contextOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  };
}

export async function handleSessionStart(_event, { workspaceRoot }) {
  return withHookStorageLock(workspaceRoot, async guard => {
    let state;
    try {
      state = await guardedHookOperation(
        guard,
        [guard.paths.statePath],
        () => readState(workspaceRoot)
      );
    } catch (error) {
      if (error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
      return contextOutput(
        "Harness50 state is unreadable. Run $harness50-status, then repair or reset the Codex workflow."
      );
    }
    if (state === null || state.status === "completed") return {};

    const step = String(state.current_step).padStart(3, "0");
    const context = [
      `Harness50: ${state.status}, ${state.completed_steps.length}/50 complete.`,
      `Topic: ${state.topic_path}.`,
      `Next: Step ${step}.`,
      "Continue with $webapp resume."
    ].join(" ");
    try {
      await guardedHookOperation(
        guard,
        [guard.paths.eventsPath],
        () => appendEvent(workspaceRoot, {
          kind: "session_context_loaded",
          workflow_id: state.workflow_id,
          step: state.current_step,
          status: state.status,
          completed_count: state.completed_steps.length
        })
      );
    } catch {
      // Context loading remains useful when safe observation storage is unavailable.
    }
    return contextOutput(context);
  });
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("SessionStart", handleSessionStart);
}

import { appendEvent, readState } from "../scripts/lib/state-store.mjs";
import { isDirectEntrypoint, runHookDirect } from "../scripts/lib/hook-io.mjs";

function contextOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  };
}

export async function handleSessionStart(_event, { workspaceRoot }) {
  let state;
  try {
    state = await readState(workspaceRoot);
  } catch {
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
    await appendEvent(workspaceRoot, {
      kind: "session_context_loaded",
      workflow_id: state.workflow_id,
      step: state.current_step,
      status: state.status,
      completed_count: state.completed_steps.length
    });
  } catch {
    // Context loading remains read-only and useful when observation storage is unavailable.
  }
  return contextOutput(context);
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("SessionStart", handleSessionStart);
}

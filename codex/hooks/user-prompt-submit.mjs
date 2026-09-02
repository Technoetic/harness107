import { appendEvent, readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import { withRunLock } from "../scripts/lib/lock.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import {
  continuationMarker,
  isDirectEntrypoint,
  readLifecycleEvents,
  runHookDirect,
  stopTurnWasAccepted,
  stopTurnWasRequested
} from "../scripts/lib/hook-io.mjs";

const CONTROL_PROMPT = /^(?:\$harness50-status|\$harness50-reset|\$webapp(?: [^\r\n]+)?)$/;

function mutationTime(state) {
  return new Date(Math.max(Date.now(), Date.parse(state.updated_at))).toISOString();
}

function currentMarkerPrompt(state, prompt, lifecycleEvents) {
  return state.continuation !== null &&
    state.last_stop_turn_id !== null &&
    prompt === continuationMarker(state.continuation) &&
    stopTurnWasRequested(lifecycleEvents, state.workflow_id, state.last_stop_turn_id) &&
    !stopTurnWasAccepted(lifecycleEvents, state);
}

export async function handleUserPromptSubmit(event, { workspaceRoot }) {
  let observed;
  try {
    observed = await readState(workspaceRoot);
  } catch {
    return {};
  }
  if (observed === null || observed.status !== "running") return {};
  if (CONTROL_PROMPT.test(event.prompt)) return {};

  const { lockPath } = pathsFor(workspaceRoot);
  try {
    await withRunLock(lockPath, async () => {
      let state = await readState(workspaceRoot);
      if (state === null || state.status !== "running") return;
      let lifecycleEvents;
      try {
        lifecycleEvents = await readLifecycleEvents(workspaceRoot);
      } catch {
        lifecycleEvents = [];
      }
      const acceptedMarker = currentMarkerPrompt(state, event.prompt, lifecycleEvents);
      const updatedAt = mutationTime(state);
      if (acceptedMarker) {
        try {
          await appendEvent(workspaceRoot, {
            kind: "continuation_prompt_accepted",
            workflow_id: state.workflow_id,
            step: state.current_step,
            turn_id: state.last_stop_turn_id,
            baseline_receipt_count: state.completed_steps.length
          });
          return;
        } catch {
          // If acceptance cannot be recorded, pause instead of permitting replay.
        }
      }
      state = {
        ...state,
        status: "paused",
        continuation: null,
        updated_at: updatedAt
      };
      state = await writeStateAtomic(workspaceRoot, state);
      try {
        await appendEvent(workspaceRoot, {
          kind: "workflow_paused",
          workflow_id: state.workflow_id,
          step: state.current_step,
          status: "paused",
          turn_id: event.turn_id,
          reason_code: "USER_REQUEST"
        });
      } catch {
        // The locked state transition is authoritative when observation storage fails.
      }
    });
  } catch (error) {
    if (error?.code === "WORKSPACE_PATH_UNSAFE") throw error;
    // A human prompt must never be blocked by lifecycle bookkeeping failure.
  }
  return {};
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("UserPromptSubmit", handleUserPromptSubmit);
}

import { readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import {
  appendPinnedHookEvent,
  assertHookStorageGuard,
  captureHookStorageGuard,
  continuationMarker,
  guardedHookOperation,
  isDirectEntrypoint,
  readLifecycleEvents,
  runHookDirect,
  stopTurnWasAccepted,
  stopTurnWasRequested,
  withHookStorageLock
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

export async function handleUserPromptSubmit(event, { workspaceRoot, eventNow }) {
  const observed = await captureHookStorageGuard(workspaceRoot, { includeLock: false });
  if (!observed.identities.has(observed.paths.codexDir)) {
    await assertHookStorageGuard(observed);
    return {};
  }
  try {
    await withHookStorageLock(workspaceRoot, async guard => {
      const prompt = event.prompt;
      const turnId = event.turn_id;
      await assertHookStorageGuard(guard);
      let state;
      try {
        state = await guardedHookOperation(
          guard,
          [guard.paths.statePath],
          () => readState(workspaceRoot)
        );
      } catch (error) {
        if (error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
        return;
      }
      if (state === null || state.status !== "running") return;
      if (CONTROL_PROMPT.test(prompt)) return;
      let lifecycleEvents;
      try {
        lifecycleEvents = await guardedHookOperation(
          guard,
          [guard.paths.eventsPath],
          () => readLifecycleEvents(workspaceRoot)
        );
      } catch (error) {
        if (error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
        lifecycleEvents = [];
      }
      const acceptedMarker = currentMarkerPrompt(state, prompt, lifecycleEvents);
      const updatedAt = mutationTime(state);
      if (acceptedMarker) {
        try {
          await guardedHookOperation(
            guard,
            [guard.paths.eventsPath],
            () => appendPinnedHookEvent(guard, {
              kind: "continuation_prompt_accepted",
              workflow_id: state.workflow_id,
              step: state.current_step,
              turn_id: state.last_stop_turn_id,
              baseline_receipt_count: state.completed_steps.length
            }, { now: eventNow })
          );
          return;
        } catch (error) {
          if (error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
          // If acceptance cannot be recorded, pause instead of permitting replay.
        }
      }
      state = {
        ...state,
        status: "paused",
        continuation: null,
        updated_at: updatedAt
      };
      state = await guardedHookOperation(
        guard,
        [guard.paths.statePath],
        () => writeStateAtomic(workspaceRoot, state),
        { allowReplacement: true }
      );
      try {
        await guardedHookOperation(
          guard,
          [guard.paths.eventsPath],
          () => appendPinnedHookEvent(guard, {
            kind: "workflow_paused",
            workflow_id: state.workflow_id,
            step: state.current_step,
            status: "paused",
            turn_id: turnId,
            reason_code: "USER_REQUEST"
          }, { now: eventNow })
        );
      } catch (error) {
        if (error?.code === "HOOK_WORKSPACE_UNSAFE") throw error;
        // The locked state transition is authoritative when observation storage fails.
      }
    });
  } catch (error) {
    if (error?.code === "WORKSPACE_PATH_UNSAFE" || error?.code === "HOOK_WORKSPACE_UNSAFE") {
      throw error;
    }
    // A human prompt must never be blocked by lifecycle bookkeeping failure.
  }
  return {};
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("UserPromptSubmit", handleUserPromptSubmit);
}

import { appendEvent, readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import { withRunLock } from "../scripts/lib/lock.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { failStep, reconcileWorkflow } from "../scripts/lib/workflow.mjs";
import {
  continuationMarker,
  isDirectEntrypoint,
  readLifecycleEvents,
  runHookDirect,
  stopTurnWasAccepted,
  stopTurnWasRequested
} from "../scripts/lib/hook-io.mjs";

function mutationTime(state) {
  return new Date(Math.max(Date.now(), Date.parse(state.updated_at))).toISOString();
}

function safelyReleasable(error) {
  if (error?.code === "WORKSPACE_PATH_UNSAFE") return false;
  return true;
}

async function readUsableState(workspaceRoot) {
  try {
    return await readState(workspaceRoot);
  } catch {
    return null;
  }
}

async function claimContinuation(workspaceRoot, turnId) {
  const { lockPath } = pathsFor(workspaceRoot);
  return withRunLock(lockPath, async () => {
    let state;
    try {
      state = await readState(workspaceRoot);
    } catch {
      return null;
    }
    if (state === null) return null;
    let lifecycleEvents;
    try {
      lifecycleEvents = await readLifecycleEvents(workspaceRoot);
    } catch {
      return null;
    }
    if (stopTurnWasRequested(lifecycleEvents, state.workflow_id, turnId)) return null;
    const priorRequestPending = state.last_stop_turn_id !== null &&
      stopTurnWasRequested(lifecycleEvents, state.workflow_id, state.last_stop_turn_id) &&
      !stopTurnWasAccepted(lifecycleEvents, state);
    if (
      state.status !== "running" ||
      state.current_step === null ||
      state.continuation === null ||
      priorRequestPending ||
      state.continuation.workflow_id !== state.workflow_id ||
      state.continuation.step !== state.current_step ||
      state.continuation.baseline_receipt_count !== state.completed_steps.length
    ) {
      return null;
    }
    state = await writeStateAtomic(workspaceRoot, {
      ...state,
      last_stop_turn_id: turnId,
      updated_at: mutationTime(state)
    });
    await appendEvent(workspaceRoot, {
      kind: "stop_continuation_requested",
      workflow_id: state.workflow_id,
      step: state.current_step,
      turn_id: turnId,
      baseline_receipt_count: state.completed_steps.length
    });
    return state.continuation;
  });
}

export async function handleStop(event, { workspaceRoot }) {
  let state = await readUsableState(workspaceRoot);
  if (state === null) return {};
  try {
    state = await reconcileWorkflow({ workspaceRoot });
  } catch (error) {
    if (!safelyReleasable(error)) throw error;
    return {};
  }
  if (state.status !== "running") return {};

  let lifecycleEvents;
  try {
    lifecycleEvents = await readLifecycleEvents(workspaceRoot);
  } catch {
    return {};
  }
  if (stopTurnWasRequested(lifecycleEvents, state.workflow_id, event.turn_id)) return {};

  if (state.current_attempt !== null && !state.current_attempt.failure_recorded) {
    try {
      state = await failStep({
        workspaceRoot,
        step: state.current_attempt.step,
        attemptId: state.current_attempt.id,
        reason: "STOP_NO_PROGRESS",
        evidence: []
      });
    } catch (error) {
      if (!safelyReleasable(error)) throw error;
      state = await readUsableState(workspaceRoot);
      if (state === null) return {};
    }
  }
  if (state.status !== "running" || state.continuation === null) return {};

  let continuation;
  try {
    continuation = await claimContinuation(workspaceRoot, event.turn_id);
  } catch (error) {
    if (!safelyReleasable(error)) throw error;
    return {};
  }
  if (continuation === null) return {};
  return {
    decision: "block",
    reason: continuationMarker(continuation)
  };
}

if (isDirectEntrypoint(import.meta.url)) {
  void runHookDirect("Stop", handleStop);
}

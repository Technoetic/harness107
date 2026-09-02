import { appendEvent, readState, writeStateAtomic } from "../scripts/lib/state-store.mjs";
import { failStep, reconcileWorkflow } from "../scripts/lib/workflow.mjs";
import {
  assertHookStorageGuard,
  continuationMarker,
  guardedHookOperation,
  isDirectEntrypoint,
  readLifecycleEvents,
  runHookDirect,
  stopTurnWasAccepted,
  stopTurnWasRequested,
  withHookStorageLock
} from "../scripts/lib/hook-io.mjs";

function mutationTime(state) {
  return new Date(Math.max(Date.now(), Date.parse(state.updated_at))).toISOString();
}

function safelyReleasable(error) {
  if (error?.code === "WORKSPACE_PATH_UNSAFE" || error?.code === "HOOK_WORKSPACE_UNSAFE") return false;
  return true;
}

async function readUsableState(workspaceRoot) {
  try {
    return await withHookStorageLock(workspaceRoot, guard => guardedHookOperation(
      guard,
      [guard.paths.statePath],
      () => readState(workspaceRoot)
    ));
  } catch (error) {
    if (!safelyReleasable(error)) throw error;
    return null;
  }
}

function currentGenerationRequest(lifecycleEvents, state) {
  if (state.last_stop_turn_id === null || state.continuation === null) return null;
  return lifecycleEvents.findLast(item =>
    item.kind === "stop_continuation_requested" &&
    item.workflow_id === state.workflow_id &&
    item.turn_id === state.last_stop_turn_id &&
    item.step === state.current_step &&
    item.baseline_receipt_count === state.completed_steps.length
  ) ?? null;
}

function durableProgressSinceRequest(lifecycleEvents, state) {
  const latest = lifecycleEvents.findLast(item =>
    item.kind === "stop_continuation_requested" &&
    item.workflow_id === state.workflow_id
  );
  return latest !== undefined && (
    state.completed_steps.length > latest.baseline_receipt_count ||
    state.current_step !== latest.step
  );
}

async function claimContinuation(workspaceRoot, turnId) {
  return withHookStorageLock(workspaceRoot, async guard => {
    let state;
    try {
      state = await guardedHookOperation(
        guard,
        [guard.paths.statePath],
        () => readState(workspaceRoot)
      );
    } catch (error) {
      if (!safelyReleasable(error)) throw error;
      return null;
    }
    if (state === null) return null;
    let lifecycleEvents;
    try {
      lifecycleEvents = await guardedHookOperation(
        guard,
        [guard.paths.eventsPath],
        () => readLifecycleEvents(workspaceRoot)
      );
    } catch (error) {
      if (!safelyReleasable(error)) throw error;
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
    state = await guardedHookOperation(
      guard,
      [guard.paths.statePath],
      () => writeStateAtomic(workspaceRoot, {
        ...state,
        last_stop_turn_id: turnId,
        updated_at: mutationTime(state)
      }),
      { allowReplacement: true }
    );
    await guardedHookOperation(
      guard,
      [guard.paths.eventsPath],
      () => appendEvent(workspaceRoot, {
        kind: "stop_continuation_requested",
        workflow_id: state.workflow_id,
        step: state.current_step,
        turn_id: turnId,
        baseline_receipt_count: state.completed_steps.length
      })
    );
    return state.continuation;
  });
}

export async function handleStop(event, { workspaceRoot }) {
  const observedEvent = await withHookStorageLock(workspaceRoot, async guard => {
    const value = {
      turnId: event.turn_id,
      stopHookActive: event.stop_hook_active
    };
    await assertHookStorageGuard(guard);
    return value;
  });
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
    lifecycleEvents = await withHookStorageLock(workspaceRoot, guard => guardedHookOperation(
      guard,
      [guard.paths.eventsPath],
      () => readLifecycleEvents(workspaceRoot)
    ));
  } catch (error) {
    if (!safelyReleasable(error)) throw error;
    return {};
  }
  const pendingRequest = currentGenerationRequest(lifecycleEvents, state);
  if (pendingRequest !== null && !stopTurnWasAccepted(lifecycleEvents, state, pendingRequest.turn_id)) {
    if (observedEvent.stopHookActive) return {};
    return {
      decision: "block",
      reason: continuationMarker(state.continuation)
    };
  }
  if (stopTurnWasRequested(lifecycleEvents, state.workflow_id, observedEvent.turnId)) return {};

  if (
    observedEvent.stopHookActive &&
    !durableProgressSinceRequest(lifecycleEvents, state) &&
    (state.current_attempt === null || state.current_attempt.failure_recorded)
  ) {
    return {};
  }

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
    continuation = await claimContinuation(workspaceRoot, observedEvent.turnId);
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

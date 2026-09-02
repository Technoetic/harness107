import { readState } from "../scripts/lib/state-store.mjs";
import { failStep, reconcileWorkflow } from "../scripts/lib/workflow.mjs";
import {
  appendPreparedPinnedHookEvent,
  assertHookStorageGuard,
  captureHookStorageGuard,
  continuationMarker,
  currentContinuationLedgerGeneration,
  guardedHookOperation,
  isDirectEntrypoint,
  preparePinnedHookEvent,
  readLifecycleEvents,
  runHookDirect,
  withHookStorageLock
} from "../scripts/lib/hook-io.mjs";

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

function durableProgressSinceRequest(lifecycleEvents, state, generation) {
  const latestRequestIndex = lifecycleEvents.findLastIndex(item =>
    item.kind === "stop_continuation_requested" &&
    item.workflow_id === state.workflow_id
  );
  return latestRequestIndex >= 0 && generation.boundaryIndex > latestRequestIndex;
}

async function claimContinuation(workspaceRoot, turnId, eventNow) {
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
    const generation = currentContinuationLedgerGeneration(lifecycleEvents, state);
    if (
      typeof turnId !== "string" ||
      turnId.length === 0 ||
      state.status !== "running" ||
      state.current_step === null ||
      state.continuation === null ||
      generation === null ||
      generation.request !== null
    ) {
      return null;
    }
    const preparedRequest = preparePinnedHookEvent({
      kind: "stop_continuation_requested",
      workflow_id: state.workflow_id,
      step: state.current_step,
      turn_id: turnId,
      baseline_receipt_count: state.completed_steps.length
    }, { now: eventNow });
    await guardedHookOperation(
      guard,
      [guard.paths.eventsPath],
      () => appendPreparedPinnedHookEvent(guard, preparedRequest)
    );
    return state.continuation;
  });
}

export async function handleStop(event, { workspaceRoot, eventNow }) {
  const storage = await captureHookStorageGuard(workspaceRoot, { includeLock: false });
  if (!storage.identities.has(storage.paths.codexDir)) {
    await assertHookStorageGuard(storage);
    return {};
  }
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
  const generation = currentContinuationLedgerGeneration(lifecycleEvents, state);
  if (generation === null) return {};
  const generationRequest = generation.request;
  const generationAccepted = generation.accepted;
  if (generationRequest !== null && !generation.closed) {
    if (state.continuation === null) return {};
    if (observedEvent.stopHookActive) return {};
    return {
      decision: "block",
      reason: continuationMarker(state.continuation)
    };
  }
  if (
    generationAccepted &&
    (state.current_attempt === null || state.current_attempt.failure_recorded)
  ) {
    return {};
  }
  if (generationRequest?.turn_id === observedEvent.turnId) return {};

  if (
    observedEvent.stopHookActive &&
    !durableProgressSinceRequest(lifecycleEvents, state, generation) &&
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
    continuation = await claimContinuation(workspaceRoot, observedEvent.turnId, eventNow);
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

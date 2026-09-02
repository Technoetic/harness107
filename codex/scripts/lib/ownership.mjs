import { HarnessError } from "./errors.mjs";
import { validateState } from "./schema.mjs";

/** Five minutes: long enough for a step transition, bounded for safe takeover. */
export const OWNER_LEASE_MS = 5 * 60 * 1000;

function fail(code, message, details = {}) {
  throw new HarnessError(code, message, details);
}

function timestamp(value, field = "now") {
  const resolved = typeof value === "function" ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (Number.isNaN(date.getTime())) {
    fail("CLOCK_INVALID", `${field} must identify a valid time`);
  }
  return date.toISOString();
}

function session(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    fail("SESSION_INVALID", "sessionId must be null or a non-empty string");
  }
  return value;
}

export function ownerLeaseExpired(owner, now, leaseMs = OWNER_LEASE_MS) {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    fail("OWNER_LEASE_INVALID", "owner lease duration must be a positive finite number");
  }
  if (owner === null) return true;
  if (owner === undefined || typeof owner !== "object" || Array.isArray(owner)) {
    fail("OWNER_INVALID", "owner must be null or an owner record");
  }
  const leaseUpdatedAt = Date.parse(owner.lease_updated_at);
  if (Number.isNaN(leaseUpdatedAt)) {
    fail("OWNER_INVALID", "owner lease_updated_at must be a valid timestamp");
  }
  return Date.parse(timestamp(now)) - leaseUpdatedAt >= leaseMs;
}

export function assertOwner(rawState, { sessionId = null, now } = {}) {
  const state = validateState(rawState);
  const requestedSession = session(sessionId);
  if (state.owner === null) {
    if (requestedSession === null) return state;
    fail("OWNER_NOT_CLAIMED", "the workflow has no claimed owner");
  }
  if (state.owner.session_id !== requestedSession) {
    fail("OWNER_CONFLICT", "the workflow is owned by another session", {
      owner_session_id: state.owner.session_id
    });
  }
  if (ownerLeaseExpired(state.owner, now)) {
    fail("OWNER_LEASE_EXPIRED", "the workflow owner lease has expired");
  }
  return state;
}

export function claimOwner(rawState, { sessionId = null, now } = {}) {
  const state = validateState(rawState);
  const requestedSession = session(sessionId);
  if (requestedSession === null) return state;
  if (state.owner !== null) {
    if (state.owner.session_id !== requestedSession) {
      fail("OWNER_CONFLICT", "the workflow is owned by another session", {
        owner_session_id: state.owner.session_id
      });
    }
    return assertOwner(state, { sessionId: requestedSession, now });
  }
  return validateState({
    ...state,
    owner: {
      session_id: requestedSession,
      lease_updated_at: timestamp(now)
    }
  });
}

export function renewOwner(rawState, { sessionId = null, now } = {}) {
  const state = assertOwner(rawState, { sessionId, now });
  if (state.owner === null) return state;
  return validateState({
    ...state,
    owner: {
      ...state.owner,
      lease_updated_at: timestamp(now)
    }
  });
}

export function transferOwner(rawState, {
  sessionId = null,
  now,
  nonce
} = {}) {
  const state = validateState(rawState);
  const requestedSession = session(sessionId);
  if (typeof nonce !== "string" || nonce.trim() === "") {
    fail("CONTINUATION_INVALID", "a fresh continuation nonce is required for transfer");
  }
  if (state.continuation?.nonce === nonce) {
    fail("CONTINUATION_NONCE_REUSED", "owner transfer must invalidate the previous nonce");
  }
  if (state.status === "completed" || state.current_step === null) {
    fail("WORKFLOW_STATE", "a completed workflow cannot transfer ownership");
  }
  const issuedAt = timestamp(now);
  return validateState({
    ...state,
    current_attempt: null,
    owner: requestedSession === null
      ? null
      : { session_id: requestedSession, lease_updated_at: issuedAt },
    continuation: {
      workflow_id: state.workflow_id,
      step: state.current_step,
      nonce,
      issued_at: issuedAt,
      baseline_receipt_count: state.completed_steps.length
    }
  });
}

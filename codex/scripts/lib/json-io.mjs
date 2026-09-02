import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";

import { HarnessError } from "./errors.mjs";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT_TIMEOUT_MS = 1000;
const outputControllers = new WeakMap();

function fail(code, message) {
  throw new HarnessError(code, message);
}

function hasOutputListener(stream, event, listener) {
  try {
    return EventEmitter.prototype.listeners.call(stream, event).includes(listener);
  } catch {
    return false;
  }
}

function addOutputListener(stream, event, listener) {
  if (hasOutputListener(stream, event, listener)) return true;
  try {
    EventEmitter.prototype.on.call(stream, event, listener);
  } catch {
    // Verification below detects partial or rejected registration.
  }
  return hasOutputListener(stream, event, listener);
}

function removeOutputListener(stream, event, listener) {
  if (!hasOutputListener(stream, event, listener)) return true;
  try {
    EventEmitter.prototype.removeListener.call(stream, event, listener);
  } catch {
    // Verification below detects removal that did not complete.
  }
  return !hasOutputListener(stream, event, listener);
}

function getOutputController(stream) {
  let controller = outputControllers.get(stream);
  if (controller !== undefined) return controller;

  controller = {
    stream,
    requests: new Set(),
    quarantined: false,
    onError: null,
    onClose: null,
    onDrain: null
  };
  const notify = method => {
    for (const request of [...controller.requests]) {
      try {
        request[method]();
      } catch {
        // Event delivery must never surface a caller or cleanup exception.
      }
    }
  };
  controller.onError = () => notify("onError");
  controller.onClose = () => notify("onClose");
  controller.onDrain = () => notify("onDrain");
  outputControllers.set(stream, controller);
  return controller;
}

function ensureQuarantine(controller) {
  controller.quarantined = true;
  return addOutputListener(controller.stream, "error", controller.onError);
}

function ensureControllerListeners(controller) {
  return (
    addOutputListener(controller.stream, "error", controller.onError) &&
    addOutputListener(controller.stream, "close", controller.onClose) &&
    addOutputListener(controller.stream, "drain", controller.onDrain)
  );
}

function releaseOutputRequest(controller, request) {
  if (request.released) return;
  request.released = true;
  controller.requests.delete(request);
  if (controller.requests.size !== 0) return;

  const closeRemoved = removeOutputListener(controller.stream, "close", controller.onClose);
  const drainRemoved = removeOutputListener(controller.stream, "drain", controller.onDrain);
  if (controller.quarantined) {
    ensureQuarantine(controller);
    return;
  }
  const errorRemoved = removeOutputListener(controller.stream, "error", controller.onError);
  if (!closeRemoved || !drainRemoved || !errorRemoved) ensureQuarantine(controller);
}

function decodeJson(chunks) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail("INPUT_UTF8", "input must be valid UTF-8");
  }
  if (text.trim() === "") fail("INPUT_EMPTY", "input must contain one JSON object");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("INPUT_JSON", "input must contain valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INPUT_OBJECT", "input JSON must be an object");
  }
  return value;
}

export async function readJsonInput(stream, maxBytes, {
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (
    stream === null || typeof stream !== "object" ||
    typeof stream.on !== "function" || typeof stream.once !== "function"
  ) {
    fail("INPUT_STREAM", "input stream is unavailable");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("INPUT_OPTIONS", "input byte limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("INPUT_OPTIONS", "input timeout must be a positive safe integer");
  }

  const chunks = await new Promise((resolve, reject) => {
    const collected = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const finish = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const rejectWith = (code, message, { destroy = false } = {}) => {
      if (destroy) stream.pause?.();
      finish(() => reject(new HarnessError(code, message)));
      if (destroy) stream.destroy?.();
    };
    const onData = chunk => {
      let bytes;
      try {
        bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      } catch {
        rejectWith("INPUT_STREAM", "input stream failed", { destroy: true });
        return;
      }
      byteLength += bytes.length;
      if (byteLength > maxBytes) {
        rejectWith("INPUT_TOO_LARGE", "input exceeds the byte limit", { destroy: true });
        return;
      }
      collected.push(bytes);
    };
    const onEnd = () => finish(() => resolve(collected));
    const onError = () => rejectWith("INPUT_STREAM", "input stream failed");
    const timer = setTimeout(() => {
      rejectWith("INPUT_TIMEOUT", "input stream timed out", { destroy: true });
    }, timeoutMs);

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume?.();
  });

  return decodeJson(chunks);
}

export async function writeOutput(stream, value, {
  timeoutMs = DEFAULT_OUTPUT_TIMEOUT_MS
} = {}) {
  let invalidStream = false;
  try {
    invalidStream = !(stream instanceof EventEmitter) || typeof stream.write !== "function";
  } catch {
    invalidStream = true;
  }
  if (invalidStream) {
    fail("OUTPUT_STREAM", "output stream failed");
  }
  if (typeof value !== "string") fail("OUTPUT_STREAM", "output stream failed");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("OUTPUT_STREAM", "output stream failed");
  }
  let unavailable = false;
  try {
    unavailable = stream.destroyed || stream.writableEnded || stream.writable === false;
  } catch {
    unavailable = true;
  }
  if (unavailable) {
    fail("OUTPUT_STREAM", "output stream failed");
  }

  await new Promise((resolve, reject) => {
    const controller = getOutputController(stream);
    let callerSettled = false;
    let writeReturned = false;
    let callbackComplete = false;
    let needsDrain = false;
    let drained = false;
    let callbackFailure = null;
    let timeoutTimer = null;

    const request = {
      released: false,
      onError: () => {
        settleCaller(new Error("output error"));
        cleanup();
      },
      onClose: () => {
        settleCaller(new Error("output closed"));
        cleanup();
      },
      onDrain: () => {
        drained = true;
        maybeFinish();
      }
    };
    const cleanup = () => {
      if (callbackFailure !== null) clearImmediate(callbackFailure);
      callbackFailure = null;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      releaseOutputRequest(controller, request);
    };
    const settleCaller = error => {
      if (callerSettled) return;
      callerSettled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (error === null) resolve();
      else reject(new HarnessError("OUTPUT_STREAM", "output stream failed"));
    };
    const maybeFinish = () => {
      if (callerSettled) return;
      if (!writeReturned || !callbackComplete || (needsDrain && !drained)) return;
      settleCaller(null);
      cleanup();
    };
    const onWrite = error => {
      if (callerSettled) return;
      if (error) {
        settleCaller(error);
        callbackFailure = setImmediate(() => {
          callbackFailure = null;
          cleanup();
        });
        return;
      }
      callbackComplete = true;
      maybeFinish();
    };

    controller.requests.add(request);
    if (controller.quarantined) ensureQuarantine(controller);
    if (!ensureControllerListeners(controller)) {
      ensureQuarantine(controller);
      settleCaller(new Error("output listener registration"));
      cleanup();
      return;
    }

    timeoutTimer = setTimeout(() => {
      if (callerSettled) return;
      ensureQuarantine(controller);
      settleCaller(new Error("output timeout"));
      cleanup();
    }, timeoutMs);

    try {
      needsDrain = stream.write(value, onWrite) === false;
      writeReturned = true;
      maybeFinish();
    } catch (error) {
      settleCaller(error);
      cleanup();
    }
  });
}

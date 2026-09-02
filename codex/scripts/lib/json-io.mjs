import { TextDecoder } from "node:util";

import { HarnessError } from "./errors.mjs";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT_TIMEOUT_MS = 1000;

function fail(code, message) {
  throw new HarnessError(code, message);
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
  if (
    stream === null || typeof stream !== "object" ||
    typeof stream.write !== "function" ||
    typeof stream.once !== "function" ||
    typeof stream.removeListener !== "function"
  ) {
    fail("OUTPUT_STREAM", "output stream failed");
  }
  if (typeof value !== "string") fail("OUTPUT_STREAM", "output stream failed");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("OUTPUT_STREAM", "output stream failed");
  }
  if (stream.destroyed || stream.writableEnded || stream.writable === false) {
    fail("OUTPUT_STREAM", "output stream failed");
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackComplete = false;
    let needsDrain = false;
    let drained = false;
    let callbackFailure = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (callbackFailure !== null) clearImmediate(callbackFailure);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      stream.removeListener("drain", onDrain);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === null) resolve();
      else reject(new HarnessError("OUTPUT_STREAM", "output stream failed"));
    };
    const maybeFinish = () => {
      if (writeReturned && callbackComplete && (!needsDrain || drained)) finish(null);
    };
    const onError = () => finish(new Error("output error"));
    const onClose = () => finish(new Error("output closed"));
    const onDrain = () => {
      drained = true;
      maybeFinish();
    };
    const onWrite = error => {
      if (settled) return;
      if (error) {
        callbackFailure = setImmediate(() => finish(error));
        return;
      }
      callbackComplete = true;
      maybeFinish();
    };
    const timer = setTimeout(() => finish(new Error("output timeout")), timeoutMs);

    stream.once("error", onError);
    stream.once("close", onClose);
    stream.once("drain", onDrain);
    try {
      needsDrain = stream.write(value, onWrite) === false;
      writeReturned = true;
      maybeFinish();
    } catch (error) {
      finish(error);
    }
  });
}

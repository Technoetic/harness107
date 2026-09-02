import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookRoot = fileURLToPath(new URL("../../hooks/", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const INPUT_CHUNK_SIZE = 16 * 1024;
const CLOSED_PIPE_CODES = new Set([
  "EOF",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END"
]);
const HOOK_NAMES = new Set(["session-start", "user-prompt-submit", "stop"]);

function chunksFor(value) {
  const values = Array.isArray(value)
    ? value
    : [Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value)];
  const chunks = [];
  for (const item of values) {
    const bytes = Buffer.from(item);
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_SIZE) {
      chunks.push(bytes.subarray(offset, offset + INPUT_CHUNK_SIZE));
    }
  }
  return chunks;
}

function parseOutput(bytes, { allowMissingOutput }) {
  if (bytes.length === 0 && allowMissingOutput) return null;
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.endsWith("\n\n") || text.includes("\r")) {
    throw new Error("hook output must be exactly one LF-terminated JSON document");
  }
  const line = text.slice(0, -1);
  const value = JSON.parse(line);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hook output must be a JSON object");
  }
  return value;
}

export async function runHook(name, event, {
  env = {},
  cwd = typeof event?.cwd === "string" ? event.cwd : process.cwd(),
  input = event,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  closeStdout = false
} = {}) {
  if (!HOOK_NAMES.has(name)) throw new TypeError("runHook name is not recognized");
  if (typeof cwd !== "string" || cwd === "") throw new TypeError("runHook cwd must be a string");
  const inputChunks = chunksFor(input);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${hookRoot}${name}.mjs`], {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let inputStopped = false;
    let inputIndex = 0;
    let pendingDrain = null;

    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingDrain !== null) child.stdin.removeListener("drain", pendingDrain);
      callback();
    };
    const fail = error => {
      if (child.exitCode === null) child.kill();
      finish(() => reject(error));
    };
    const collect = (target, streamName, chunk) => {
      const bytes = Buffer.from(chunk);
      if (streamName === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > outputLimit || stderrBytes > outputLimit) {
        fail(new Error(`hook ${streamName} exceeded the test output limit`));
        return;
      }
      target.push(bytes);
    };
    const stopInput = () => {
      inputStopped = true;
      if (pendingDrain !== null) {
        child.stdin.removeListener("drain", pendingDrain);
        pendingDrain = null;
      }
    };
    const onStdinError = error => {
      if (settled) return;
      stopInput();
      if (!CLOSED_PIPE_CODES.has(error?.code)) fail(error);
    };
    const pumpInput = () => {
      if (settled || inputStopped) return;
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        stopInput();
        return;
      }
      if (inputIndex === inputChunks.length) {
        stopInput();
        try {
          child.stdin.end();
        } catch (error) {
          if (!CLOSED_PIPE_CODES.has(error?.code)) fail(error);
        }
        return;
      }

      const chunk = inputChunks[inputIndex];
      let writeReturned = false;
      let callbackComplete = false;
      let needsDrain = false;
      let drained = false;
      const advance = () => {
        if (!writeReturned || !callbackComplete || (needsDrain && !drained)) return;
        if (pendingDrain !== null) child.stdin.removeListener("drain", pendingDrain);
        pendingDrain = null;
        inputIndex += 1;
        setImmediate(pumpInput);
      };
      pendingDrain = () => {
        drained = true;
        advance();
      };
      child.stdin.once("drain", pendingDrain);
      try {
        needsDrain = child.stdin.write(chunk, error => {
          if (error) {
            onStdinError(error);
            return;
          }
          callbackComplete = true;
          advance();
        }) === false;
        writeReturned = true;
        if (!needsDrain) {
          child.stdin.removeListener("drain", pendingDrain);
          pendingDrain = null;
        }
        advance();
      } catch (error) {
        onStdinError(error);
      }
    };
    const timer = setTimeout(() => fail(new Error(`hook exceeded the ${timeoutMs}ms test timeout`)), timeoutMs);

    child.once("error", error => finish(() => reject(error)));
    child.stdin.on("error", onStdinError);
    child.stdout.on("data", chunk => collect(stdout, "stdout", chunk));
    child.stderr.on("data", chunk => collect(stderr, "stderr", chunk));
    if (closeStdout) child.stdout.destroy();
    child.once("close", code => finish(() => {
      try {
        const stdoutBuffer = Buffer.concat(stdout);
        resolve({
          code: code ?? 1,
          output: parseOutput(stdoutBuffer, { allowMissingOutput: closeStdout }),
          stdout: stdoutBuffer.toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      } catch (error) {
        reject(error);
      }
    }));

    pumpInput();
  });
}

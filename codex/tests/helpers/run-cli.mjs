import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../scripts/harness-state.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const INPUT_CHUNK_SIZE = 16 * 1024;
const CLOSED_PIPE_CODES = new Set(["EOF", "EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

function inputChunks(input) {
  if (input === null) return [];
  const values = Array.isArray(input)
    ? input
    : [Buffer.isBuffer(input) || typeof input === "string" ? input : JSON.stringify(input)];
  const chunks = [];
  for (const value of values) {
    const bytes = Buffer.from(value);
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_SIZE) {
      chunks.push(bytes.subarray(offset, offset + INPUT_CHUNK_SIZE));
    }
  }
  return chunks;
}

export async function runCli(args, {
  input = null,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT
} = {}) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
    throw new TypeError("runCli args must be an array of strings");
  }
  const chunks = inputChunks(input);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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
    const collect = (chunks, streamName, chunk) => {
      const bytes = Buffer.from(chunk);
      if (streamName === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > outputLimit || stderrBytes > outputLimit) {
        fail(new Error(`CLI ${streamName} exceeded the test output limit`));
        return;
      }
      chunks.push(bytes);
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
      if (inputIndex === chunks.length) {
        inputStopped = true;
        try {
          child.stdin.end();
        } catch (error) {
          if (!CLOSED_PIPE_CODES.has(error?.code)) fail(error);
        }
        return;
      }

      const chunk = chunks[inputIndex];
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
    const timer = setTimeout(() => {
      fail(new Error(`CLI exceeded the ${timeoutMs}ms test timeout`));
    }, timeoutMs);

    child.once("error", error => finish(() => reject(error)));
    child.stdin.on("error", onStdinError);
    child.stdout.on("data", chunk => collect(stdout, "stdout", chunk));
    child.stderr.on("data", chunk => collect(stderr, "stderr", chunk));
    child.once("close", code => finish(() => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    })));

    pumpInput();
  });
}

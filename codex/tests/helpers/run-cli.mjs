import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../scripts/harness-state.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

function inputChunks(input) {
  if (input === null) return [];
  if (Array.isArray(input)) return input;
  if (Buffer.isBuffer(input) || typeof input === "string") return [input];
  return [JSON.stringify(input)];
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

    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      fail(new Error(`CLI exceeded the ${timeoutMs}ms test timeout`));
    }, timeoutMs);

    child.once("error", error => finish(() => reject(error)));
    child.stdout.on("data", chunk => collect(stdout, "stdout", chunk));
    child.stderr.on("data", chunk => collect(stderr, "stderr", chunk));
    child.once("close", code => finish(() => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    })));

    for (const chunk of inputChunks(input)) child.stdin.write(chunk);
    child.stdin.end();
  });
}

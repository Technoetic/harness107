import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withRunLock } from "../scripts/lib/lock.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { createInitialState } from "../scripts/lib/schema.mjs";
import {
  appendEvent,
  archiveActiveState,
  mutateState,
  readState,
  writeStateAtomic
} from "../scripts/lib/state-store.mjs";
import { makeWorkspace } from "./helpers/workspace.mjs";

const childMutatePath = fileURLToPath(new URL("./helpers/child-mutate.mjs", import.meta.url));
const baseTime = "2026-09-02T00:00:00.000Z";

function initialState(workflowId = "wf-1") {
  return createInitialState({
    workflowId,
    workspaceRoot: "C:/fixture",
    topicSha256: "a".repeat(64),
    now: baseTime
  });
}

function nextMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before the expected message: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function runConcurrentMutators({ root, count }) {
  const children = Array.from({ length: count }, () => fork(childMutatePath, [root], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  const exits = children.map(child => once(child, "exit"));
  try {
    await Promise.all(children.map(child => nextMessage(child, message => message?.type === "ready")));
    const results = children.map(child => nextMessage(child, message => message?.type === "result"));
    for (const child of children) child.send({ type: "start" });
    const settled = await Promise.all(results);
    const winner = children[settled.findIndex(result => result.acquired)];
    if (winner) winner.send({ type: "release" });
    await Promise.all(exits);
    return settled;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

async function writeLock(lockPath, record) {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(record)}\n`, "utf8");
}

test("only one child process acquires the same lock", async () => {
  const root = await makeWorkspace();
  await writeStateAtomic(root, initialState());

  const results = await runConcurrentMutators({ root, count: 4 });

  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.deepEqual(results.filter(result => !result.acquired).map(result => result.code), [
    "LOCK_TIMEOUT",
    "LOCK_TIMEOUT",
    "LOCK_TIMEOUT"
  ]);
  assert.equal((await readState(root)).updated_at, "2026-09-02T00:00:01.000Z");
});

test("an occupied lock reaches its bounded wait without entering the callback", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);
  let entered = false;

  await withRunLock(lockPath, async () => {
    await assert.rejects(
      () => withRunLock(lockPath, () => {
        entered = true;
      }, { waitMs: 0 }),
      error => error.code === "LOCK_TIMEOUT"
    );
  });

  assert.equal(entered, false);
  assert.equal(existsSync(lockPath), false);
});

test("a lock record identifies its owner and release token", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);

  await withRunLock(lockPath, async () => {
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(record.pid, process.pid);
    assert.equal(record.hostname, hostname());
    assert.match(record.acquired_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.token, /^[a-f0-9-]{16,}$/);
  });
});

test("an old same-host lock is reclaimed only after its owner is provably absent", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);
  const pid = await exitedPid();
  await writeLock(lockPath, {
    pid,
    hostname: hostname(),
    acquired_at: "2026-09-01T23:00:00.000Z",
    token: "dead-owner-token"
  });
  let acquired = false;

  await withRunLock(lockPath, () => {
    acquired = true;
  }, {
    waitMs: 0,
    staleMs: 30_000,
    now: () => new Date(baseTime)
  });

  assert.equal(acquired, true);
  assert.equal(existsSync(lockPath), false);
  const archived = (await readdir(dirname(lockPath))).filter(name => name.startsWith("run.lock.stale-"));
  assert.equal(archived.length, 1);
});

test("foreign-host and live-owner locks are never reclaimed", async t => {
  const cases = [
    {
      name: "foreign host",
      record: {
        pid: await exitedPid(),
        hostname: `${hostname()}-other`,
        acquired_at: "2026-09-01T23:00:00.000Z",
        token: "foreign-host-token"
      }
    },
    {
      name: "live owner",
      record: {
        pid: process.pid,
        hostname: hostname(),
        acquired_at: "2026-09-01T23:00:00.000Z",
        token: "live-owner-token"
      }
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await makeWorkspace();
      const { lockPath } = pathsFor(root);
      await writeLock(lockPath, fixture.record);

      await assert.rejects(
        () => withRunLock(lockPath, () => {}, {
          waitMs: 0,
          staleMs: 30_000,
          now: () => new Date(baseTime)
        }),
        error => error.code === "LOCK_TIMEOUT"
      );

      assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), fixture.record);
    });
  }
});

test("a failed replacement preserves the previous valid state and removes its temporary file", async () => {
  const root = await makeWorkspace();
  const state1 = initialState("wf-before");
  const state2 = initialState("wf-after");
  await writeStateAtomic(root, state1);

  await assert.rejects(() => writeStateAtomic(root, state2, {
    beforeRename: () => {
      throw new Error("simulated crash");
    }
  }), /simulated crash/);

  assert.deepEqual(await readState(root), state1);
  const names = await readdir(pathsFor(root).codexDir);
  assert.equal(names.some(name => name.startsWith(".state.json.")), false);
});

test("state mutations validate the callback result before atomically replacing state", async () => {
  const root = await makeWorkspace();
  const before = initialState();
  await writeStateAtomic(root, before);

  const after = await mutateState(root, state => ({
    ...state,
    status: "paused",
    updated_at: "2026-09-02T00:00:01.000Z"
  }));
  assert.equal(after.status, "paused");
  assert.deepEqual(await readState(root), after);

  await assert.rejects(() => mutateState(root, state => ({ ...state, current_step: 9 })));
  assert.deepEqual(await readState(root), after);
});

test("event append keeps only sanctioned scalar metadata", async () => {
  const root = await makeWorkspace();

  await appendEvent(root, {
    kind: "guard_denied",
    timestamp: baseTime,
    workflow_id: "wf-1",
    tool_name: "Bash",
    rule_id: "protected-root",
    command: "echo TOP_SECRET",
    prompt: "TOP_SECRET",
    evidence: { raw: "TOP_SECRET" }
  });
  await appendEvent(root, {
    kind: "step_completed",
    timestamp: "2026-09-02T00:00:01.000Z",
    workflow_id: "wf-1",
    step: 1,
    completed_count: 1
  });

  const raw = await readFile(pathsFor(root).eventsPath, "utf8");
  assert.equal(raw.includes("TOP_SECRET"), false);
  assert.deepEqual(raw.trimEnd().split("\n").map(line => JSON.parse(line)), [
    {
      kind: "guard_denied",
      timestamp: baseTime,
      workflow_id: "wf-1",
      tool_name: "Bash",
      rule_id: "protected-root"
    },
    {
      kind: "step_completed",
      timestamp: "2026-09-02T00:00:01.000Z",
      workflow_id: "wf-1",
      step: 1,
      completed_count: 1
    }
  ]);
});

test("active metadata is archived under backups with a sanitized directory name", async () => {
  const root = await makeWorkspace();
  const state = initialState();
  await writeStateAtomic(root, state);
  await appendEvent(root, { kind: "workflow_paused", timestamp: baseTime, workflow_id: "wf-1" });

  const archivePath = await archiveActiveState(root, {
    reason: "../../manual reset",
    now: () => new Date(baseTime)
  });

  assert.equal(existsSync(pathsFor(root).statePath), false);
  assert.equal(existsSync(pathsFor(root).eventsPath), false);
  assert.equal(dirname(archivePath), pathsFor(root).backupsDir);
  assert.match(archivePath.split(/[\\/]/).at(-1), /^2026-09-02T00-00-00-000Z-manual-reset-[a-f0-9-]+$/);
  assert.deepEqual(JSON.parse(await readFile(join(archivePath, "state.json"), "utf8")), state);
  assert.equal((await readFile(join(archivePath, "events.jsonl"), "utf8")).includes("workflow_paused"), true);
});

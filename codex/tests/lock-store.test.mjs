import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRunLockHeld,
  sameRunLockIdentity,
  withRunLock,
  withRunLockEventWrite
} from "../scripts/lib/lock.mjs";
import { pathsFor } from "../scripts/lib/paths.mjs";
import { createInitialState } from "../scripts/lib/schema.mjs";
import {
  appendEvent,
  archiveActiveState,
  mutateState,
  prepareEventBatch,
  readState,
  withPinnedEventBatch,
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

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayForTest(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function nextMessage(child, predicate, timeoutMs = 3000) {
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
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("child did not reach the expected synchronization point"));
    }, timeoutMs);
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function startLockActor(root, mode) {
  const child = fork(childMutatePath, [root, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  return { child, exited: once(child, "exit") };
}

async function stopLockActor(actor) {
  if (actor.child.connected) {
    actor.child.send({ type: "release" });
  }
  await actor.exited;
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
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, `owner-${record.token}.json`), `${JSON.stringify(record)}\n`, "utf8");
}

async function readLockRecord(lockPath) {
  const records = (await readdir(lockPath)).filter(name => name.endsWith(".json"));
  assert.equal(records.length, 1);
  return JSON.parse(await readFile(join(lockPath, records[0]), "utf8"));
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
    const record = await readLockRecord(lockPath);
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
    token: "44444444-4444-4444-8444-444444444444"
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
        token: "55555555-5555-4555-8555-555555555555"
      }
    },
    {
      name: "live owner",
      record: {
        pid: process.pid,
        hostname: hostname(),
        acquired_at: "2026-09-01T23:00:00.000Z",
        token: "66666666-6666-4666-8666-666666666666"
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

      assert.deepEqual(await readLockRecord(lockPath), fixture.record);
    });
  }
});

test("two stale reclaimers cannot remove the successor acquired by the first", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);
  await writeLock(lockPath, {
    pid: await exitedPid(),
    hostname: hostname(),
    acquired_at: "2026-09-01T23:00:00.000Z",
    token: "11111111-1111-4111-8111-111111111111"
  });
  const first = startLockActor(root, "paused-reclaimer");
  const second = startLockActor(root, "paused-reclaimer");
  try {
    await Promise.all([
      nextMessage(first.child, message => message?.type === "ready"),
      nextMessage(second.child, message => message?.type === "ready")
    ]);
    const firstObserved = nextMessage(first.child, message => message?.type === "stale-observed");
    const secondObserved = nextMessage(second.child, message => message?.type === "stale-observed");
    first.child.send({ type: "start" });
    second.child.send({ type: "start" });
    await Promise.all([firstObserved, secondObserved]);

    const firstResult = nextMessage(first.child, message => message?.type === "result");
    first.child.send({ type: "continue-reclaim" });
    assert.equal((await firstResult).acquired, true);

    const secondResult = nextMessage(second.child, message => message?.type === "result");
    second.child.send({ type: "continue-reclaim" });
    assert.deepEqual(await secondResult, {
      type: "result",
      acquired: false,
      code: "LOCK_TIMEOUT",
      message: "timed out waiting for the workflow lock"
    });
    const record = await readLockRecord(lockPath);
    assert.equal(record.pid, first.child.pid);
  } finally {
    await Promise.all([stopLockActor(first), stopLockActor(second)]);
  }
});

test("a paused stale reclaimer cannot remove a fresh owner generation", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);
  await writeLock(lockPath, {
    pid: await exitedPid(),
    hostname: hostname(),
    acquired_at: "2026-09-01T23:00:00.000Z",
    token: "22222222-2222-4222-8222-222222222222"
  });
  const stale = startLockActor(root, "paused-reclaimer-watch-transition");
  let fresh;
  try {
    await nextMessage(stale.child, message => message?.type === "ready");
    const observed = nextMessage(stale.child, message => message?.type === "stale-observed");
    stale.child.send({ type: "start" });
    await observed;

    await rename(lockPath, `${lockPath}.retired-by-test`);
    fresh = startLockActor(root, "lock-owner");
    await nextMessage(fresh.child, message => message?.type === "ready");
    const freshResult = nextMessage(fresh.child, message => message?.type === "result");
    fresh.child.send({ type: "start" });
    assert.equal((await freshResult).acquired, true);

    const staleResult = nextMessage(stale.child, message =>
      message?.type === "result" || message?.type === "successor-moved");
    stale.child.send({ type: "continue-reclaim" });
    const staleOutcome = await staleResult;
    if (staleOutcome.type === "successor-moved") {
      stale.child.send({ type: "continue-transition" });
      assert.fail("the stale contender moved the fresh successor generation");
    }
    assert.equal(staleOutcome.code, "LOCK_TIMEOUT");
    assert.equal((await readLockRecord(lockPath)).pid, fresh.child.pid);
  } finally {
    await Promise.all([stopLockActor(stale), ...(fresh ? [stopLockActor(fresh)] : [])]);
  }
});

test("release never removes a successor installed before old-owner cleanup", async () => {
  const root = await makeWorkspace();
  const { lockPath } = pathsFor(root);
  const successor = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: baseTime,
    token: "33333333-3333-4333-8333-333333333333"
  };
  let interleaved = false;

  await withRunLock(lockPath, () => {}, {
    beforeRelease: async () => {
      interleaved = true;
      await rename(lockPath, `${lockPath}.retired-before-release`);
      await writeLock(lockPath, successor);
    }
  });

  assert.equal(interleaved, true);
  assert.deepEqual(await readLockRecord(lockPath), successor);
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

test("Windows replacement retries transient rename failures before succeeding", async () => {
  const root = await makeWorkspace();
  const before = initialState("wf-before-retry");
  const after = initialState("wf-after-retry");
  await writeStateAtomic(root, before);
  let attempts = 0;

  await writeStateAtomic(root, after, {
    platform: "win32",
    retryDelay: async () => {},
    renameFile: async (sourcePath, destinationPath) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("transient rename failure"), { code: "EPERM" });
      await rename(sourcePath, destinationPath);
    }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(await readState(root), after);
});

test("terminal Windows replacement failure surfaces and preserves old state", async () => {
  const root = await makeWorkspace();
  const before = initialState("wf-before-terminal");
  const after = initialState("wf-after-terminal");
  await writeStateAtomic(root, before);
  let attempts = 0;

  await assert.rejects(() => writeStateAtomic(root, after, {
    platform: "win32",
    retryDelay: async () => {},
    renameFile: async () => {
      attempts += 1;
      throw Object.assign(new Error("terminal rename failure"), { code: "EPERM" });
    }
  }), /terminal rename failure/);

  assert.equal(attempts, 9);
  assert.deepEqual(await readState(root), before);
  assert.equal((await readdir(pathsFor(root).codexDir)).some(name => name.startsWith(".state.json.")), false);
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
  }, { now: () => new Date(baseTime) });
  await appendEvent(root, {
    kind: "step_completed",
    timestamp: "2026-09-02T00:00:01.000Z",
    workflow_id: "wf-1",
    step: 1,
    completed_count: 1
  }, { now: () => new Date("2026-09-02T00:00:01.000Z") });

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

test("prepared event batches use exact UTF-8 bytes and permit an exact 1 MiB fit", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "stop_continuation_requested",
    workflow_id: "workflow-한글",
    step: 1,
    turn_id: "turn-🙂",
    generation_id: "generation-한글",
    baseline_receipt_count: 0
  }], { now: () => new Date(baseTime) });
  const expected = `${JSON.stringify({
    kind: "stop_continuation_requested",
    workflow_id: "workflow-한글",
    step: 1,
    turn_id: "turn-🙂",
    generation_id: "generation-한글",
    baseline_receipt_count: 0,
    timestamp: baseTime
  })}\n`;
  assert.equal(prepared.bytes.length, Buffer.byteLength(expected, "utf8"));

  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  await writeFile(paths.eventsPath, prefix + "a".repeat(paddingLength) + suffix);
  let mutationCalls = 0;
  await withPinnedEventBatch(root, prepared, async () => {
    mutationCalls += 1;
  });
  assert.equal(mutationCalls, 1);
  assert.equal((await readFile(paths.eventsPath)).length, 1024 * 1024);
  assert.equal((await readFile(paths.eventsPath, "utf8")).endsWith(expected), true);
});

test("prepared event batches replace caller timestamps with one canonical timestamp", () => {
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-time-one",
    timestamp: "2020-01-01T00:00:00.000Z"
  }, {
    kind: "workflow_blocked",
    workflow_id: "wf-time-two",
    timestamp: "2030-01-01T00:00:00.000Z"
  }], { now: () => new Date(baseTime) });
  assert.deepEqual(prepared.events.map(event => event.timestamp), [baseTime, baseTime]);
});

test("prepared event batches reject one byte over before mutation and loop short writes", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-short-write",
    status: "paused"
  }], { now: () => new Date(baseTime) });
  await writeFile(paths.eventsPath, Buffer.alloc((1024 * 1024) - prepared.bytes.length + 1, 0x20));
  let mutationCalls = 0;
  await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {
    mutationCalls += 1;
  }), error => error.code === "EVENT_LOG_LIMIT");
  assert.equal(mutationCalls, 0);

  await writeFile(paths.eventsPath, "");
  let writeCalls = 0;
  await withPinnedEventBatch(root, prepared, async () => {}, {
    writeChunk: async (handle, buffer, offset, length, position) => {
      writeCalls += 1;
      return handle.write(buffer, offset, Math.min(length, 3), position);
    }
  });
  assert.ok(writeCalls > 1);
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(prepared.bytes));
});

test("pinned writes reject an impossible bytesWritten count without changing the ledger", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const original = Buffer.from('{"kind":"original"}\n');
  await writeFile(paths.eventsPath, original);
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-impossible-write-count",
    status: "paused"
  }], { now: () => new Date(baseTime) });

  await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {}, {
    writeChunk: async (_handle, _buffer, _offset, length) => ({ bytesWritten: length + 1 })
  }), error => error.code === "EVENT_WRITE_INTEGRITY");
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(original));
});

test("invalid write counts are integrity failures while integer zero is no progress", async t => {
  for (const [name, bytesWritten, code] of [
    ["negative", -1, "EVENT_WRITE_INTEGRITY"],
    ["fractional", 0.5, "EVENT_WRITE_INTEGRITY"],
    ["NaN", Number.NaN, "EVENT_WRITE_INTEGRITY"],
    ["zero", 0, "EVENT_WRITE_FAILED"]
  ]) {
    await t.test(name, async () => {
      const root = await makeWorkspace();
      const paths = pathsFor(root);
      await mkdir(paths.codexDir, { recursive: true });
      const original = Buffer.from('{"kind":"original"}\n');
      await writeFile(paths.eventsPath, original);
      const prepared = prepareEventBatch([{
        kind: "workflow_paused",
        workflow_id: `wf-${name}`,
        status: "paused"
      }], { now: () => new Date(baseTime) });

      await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {}, {
        writeChunk: async () => ({ bytesWritten })
      }), error => error.code === code);
      assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(original));
    });
  }
});

test("public append rolls back prepared bytes written before the first write rejection", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const original = Buffer.from('{"kind":"original"}\n');
  await writeFile(paths.eventsPath, original);
  const event = {
    kind: "workflow_paused",
    workflow_id: "wf-public-first-throw",
    status: "paused"
  };
  const eventNow = () => new Date(baseTime);
  const prepared = prepareEventBatch([event], { now: eventNow });
  const probe = await open(paths.eventsPath, "r+");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalWrite = fileHandlePrototype.write;
  await probe.close();
  let intercepted = false;
  fileHandlePrototype.write = async function (buffer, offset, length, position) {
    if (!intercepted && Buffer.from(buffer).equals(prepared.bytes)) {
      intercepted = true;
      await originalWrite.call(this, buffer, offset, Math.min(length, 3), position);
      throw Object.assign(new Error("fixture first write rejection"), { code: "EIO" });
    }
    return originalWrite.call(this, buffer, offset, length, position);
  };
  try {
    await assert.rejects(
      () => appendEvent(root, event, { now: eventNow }),
      error => error.code === "EIO"
    );
  } finally {
    fileHandlePrototype.write = originalWrite;
  }
  assert.equal(intercepted, true);
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(original));
});

test("rollback truncate and sync failures remain non-tolerable integrity errors", async t => {
  for (const mode of ["truncate", "sync"]) {
    await t.test(mode, async () => {
      const root = await makeWorkspace();
      const paths = pathsFor(root);
      await mkdir(paths.codexDir, { recursive: true });
      const original = Buffer.from('{"kind":"original"}\n');
      await writeFile(paths.eventsPath, original);
      const prepared = prepareEventBatch([{
        kind: "workflow_paused",
        workflow_id: `wf-rollback-${mode}`,
        status: "paused"
      }], { now: () => new Date(baseTime) });
      const probe = await open(paths.eventsPath, "r+");
      const fileHandlePrototype = Object.getPrototypeOf(probe);
      const originalTruncate = fileHandlePrototype.truncate;
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let writes = 0;

      try {
        await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {}, {
          writeChunk: async (handle, buffer, offset, length, position) => {
            writes += 1;
            if (writes === 1) return handle.write(buffer, offset, Math.min(length, 3), position);
            if (mode === "truncate") {
              fileHandlePrototype.truncate = async () => {
                throw Object.assign(new Error("fixture truncate failure"), { code: "EIO" });
              };
            } else {
              fileHandlePrototype.sync = async () => {
                throw Object.assign(new Error("fixture sync failure"), { code: "EIO" });
              };
            }
            throw Object.assign(new Error("fixture append failure"), { code: "EIO" });
          }
        }), error => error.code === "EVENT_ROLLBACK_FAILED");
      } finally {
        fileHandlePrototype.truncate = originalTruncate;
        fileHandlePrototype.sync = originalSync;
      }
      assert.equal(writes, 2);
      const final = await readFile(paths.eventsPath);
      assert.equal(final.length, original.length + (mode === "truncate" ? 3 : 0));
    });
  }
});

test("pinned batches reject same-inode growth without overwriting at a stale offset", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-pinned-growth",
    status: "paused"
  }], { now: () => new Date(baseTime) });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  const original = Buffer.from(prefix + "p".repeat(paddingLength) + suffix);
  const external = Buffer.from('{"kind":"external_growth"}\n');
  await writeFile(paths.eventsPath, original);
  let mutationCalls = 0;

  await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {
    mutationCalls += 1;
  }, {
    beforeAppend: () => writeFile(paths.eventsPath, external, { flag: "a" })
  }), error => error.code === "WORKSPACE_PATH_UNSAFE");

  assert.equal(mutationCalls, 1);
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(Buffer.concat([original, external])));
  assert.doesNotMatch(await readFile(paths.eventsPath, "utf8"), /wf-pinned-growth/);
});

test("pinned batches reject same-inode truncation without writing the batch", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-pinned-truncate",
    status: "paused"
  }], { now: () => new Date(baseTime) });
  await writeFile(paths.eventsPath, '{"kind":"original"}\n');
  let mutationCalls = 0;

  await assert.rejects(() => withPinnedEventBatch(root, prepared, async () => {
    mutationCalls += 1;
  }, {
    beforeAppend: () => writeFile(paths.eventsPath, "")
  }), error => error.code === "WORKSPACE_PATH_UNSAFE");

  assert.equal(mutationCalls, 1);
  assert.equal(await readFile(paths.eventsPath, "utf8"), "");
});

test("concurrent appendEvent callers serialize the exact boundary", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const event = {
    kind: "workflow_paused",
    workflow_id: "w".repeat(256 * 1024),
    status: "paused"
  };
  const eventNow = () => new Date(baseTime);
  const prepared = prepareEventBatch([event], { now: eventNow });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  await writeFile(paths.eventsPath, prefix + "p".repeat(paddingLength) + suffix);

  const settled = await Promise.allSettled(
    Array.from({ length: 8 }, () => appendEvent(root, event, { now: eventNow }))
  );
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  for (const result of settled.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.code, "EVENT_LOG_LIMIT");
  }
  const final = await readFile(paths.eventsPath);
  assert.equal(final.length, 1024 * 1024);
  assert.ok(final.subarray(-prepared.bytes.length).equals(prepared.bytes));
  assert.doesNotThrow(() => {
    for (const line of final.toString("utf8").trimEnd().split("\n")) JSON.parse(line);
  });
});

test("same-owner appendEvent siblings serialize the exact boundary", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const event = {
    kind: "workflow_paused",
    workflow_id: "o".repeat(256 * 1024),
    status: "paused"
  };
  const eventNow = () => new Date(baseTime);
  const prepared = prepareEventBatch([event], { now: eventNow });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  const original = Buffer.from(prefix + "p".repeat(paddingLength) + suffix);
  await writeFile(paths.eventsPath, original);

  const settled = await withRunLock(paths.lockPath, () => Promise.allSettled(
    Array.from({ length: 8 }, () => appendEvent(root, event, { now: eventNow }))
  ));

  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  for (const result of settled.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.code, "EVENT_LOG_LIMIT");
  }
  const final = await readFile(paths.eventsPath);
  assert.equal(final.length, 1024 * 1024);
  assert.ok(final.subarray(0, original.length).equals(original));
  assert.ok(final.subarray(-prepared.bytes.length).equals(prepared.bytes));
  assert.doesNotThrow(() => {
    for (const line of final.toString("utf8").trimEnd().split("\n")) JSON.parse(line);
  });
});

test("same-owner pinned batch siblings serialize mutation and exact capacity", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "b".repeat(128 * 1024),
    status: "paused"
  }], { now: () => new Date(baseTime) });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  const original = Buffer.from(prefix + "p".repeat(paddingLength) + suffix);
  await writeFile(paths.eventsPath, original);
  let mutationCalls = 0;

  const settled = await withRunLock(paths.lockPath, () => Promise.allSettled(
    Array.from({ length: 4 }, () => withPinnedEventBatch(root, prepared, async () => {
      mutationCalls += 1;
    }))
  ));

  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  for (const result of settled.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.code, "EVENT_LOG_LIMIT");
  }
  assert.equal(mutationCalls, 1);
  const final = await readFile(paths.eventsPath);
  assert.equal(final.length, 1024 * 1024);
  assert.ok(final.subarray(0, original.length).equals(original));
  assert.ok(final.subarray(-prepared.bytes.length).equals(prepared.bytes));
  assert.doesNotThrow(() => {
    for (const line of final.toString("utf8").trimEnd().split("\n")) JSON.parse(line);
  });
});

test("a nested event writer fails fast without mutating the ledger", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const original = Buffer.from('{"kind":"original"}\n');
  await writeFile(paths.eventsPath, original);
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "wf-outer",
    status: "paused"
  }], { now: () => new Date(baseTime) });

  await assert.rejects(
    () => withRunLock(paths.lockPath, () => withPinnedEventBatch(root, prepared, () => (
      appendEvent(root, {
        kind: "workflow_paused",
        workflow_id: "wf-inner",
        status: "paused"
      }, { now: () => new Date(baseTime) })
    ))),
    error => error.code === "EVENT_WRITE_REENTRANT"
  );
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(original));
});

test("Windows case-equivalent lock identities retain the current owner", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await makeWorkspace();
  const lockPath = pathsFor(root).lockPath;
  const differentlyCased = lockPath.toUpperCase();

  await withRunLock(lockPath, async () => {
    assert.equal(isRunLockHeld(differentlyCased), true);
    await withRunLockEventWrite(differentlyCased, async () => {});
  });
});

test("Windows-flavor lock identity normalization is host-portable", () => {
  assert.equal(
    sameRunLockIdentity(
      "C:\\Workspace\\Project\\.harness50-codex\\run.lock",
      "c:/workspace/project/.HARNESS50-CODEX/RUN.LOCK"
    ),
    true
  );
  assert.equal(
    sameRunLockIdentity(
      "C:\\Workspace\\Project\\.harness50-codex\\run.lock",
      "C:\\Workspace\\Sibling\\.harness50-codex\\run.lock"
    ),
    false
  );
  assert.equal(sameRunLockIdentity("/tmp/Case/run.lock", "/tmp/case/run.lock"), false);
});

test("a run-lock owner drains queued event writers before another owner enters", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "q".repeat(128 * 1024),
    status: "paused"
  }], { now: () => new Date(baseTime) });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  await writeFile(paths.eventsPath, prefix + "p".repeat(paddingLength) + suffix);
  const appendGate = deferred();
  const firstAtGate = deferred();
  let launchedSettled;
  const lateStart = deferred();
  let lateSettled;

  const outer = withRunLock(paths.lockPath, async () => {
    const first = withPinnedEventBatch(root, prepared, async () => {}, {
      beforeAppend: async () => {
        firstAtGate.resolve();
        await appendGate.promise;
      }
    });
    await firstAtGate.promise;
    const second = withPinnedEventBatch(root, prepared, async () => {});
    launchedSettled = Promise.allSettled([first, second]);
    lateSettled = Promise.allSettled([(async () => {
      await lateStart.promise;
      return appendEvent(root, {
        kind: "workflow_paused",
        workflow_id: "wf-too-late",
        status: "paused"
      }, { now: () => new Date(baseTime) });
    })()]);
  });
  await firstAtGate.promise;
  let contenderEntered = false;
  const contender = withRunLock(paths.lockPath, async () => {
    contenderEntered = true;
  }, { waitMs: 3000 });
  await delayForTest(100);
  const overlapped = contenderEntered;
  lateStart.resolve();
  await delayForTest(25);
  appendGate.resolve();

  const settled = await launchedSettled;
  const late = await lateSettled;
  await outer;
  await contender;
  assert.equal(overlapped, false);
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[1].reason.code, "EVENT_LOG_LIMIT");
  assert.equal(late[0].status, "rejected");
  assert.equal(late[0].reason.code, "EVENT_WRITE_LOCK_CLOSING");
  assert.equal((await readFile(paths.eventsPath)).length, 1024 * 1024);
  await writeFile(paths.eventsPath, "");
  await withRunLock(paths.lockPath, () => appendEvent(root, {
    kind: "workflow_paused",
    workflow_id: "wf-after-drain",
    status: "paused"
  }, { now: () => new Date(baseTime) }));
  assert.match(await readFile(paths.eventsPath, "utf8"), /wf-after-drain/);
});

test("independent appendEvent processes serialize the exact boundary", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  const prepared = prepareEventBatch([{
    kind: "workflow_paused",
    workflow_id: "w".repeat(256 * 1024),
    status: "paused"
  }], { now: () => new Date(baseTime) });
  const prefix = '{"kind":"padding","value":"';
  const suffix = '"}\n';
  const paddingLength = (1024 * 1024) - prepared.bytes.length - Buffer.byteLength(prefix + suffix);
  await writeFile(paths.eventsPath, prefix + "p".repeat(paddingLength) + suffix);
  const children = Array.from({ length: 4 }, () => fork(childMutatePath, [root, "append-event"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  }));
  const exits = children.map(child => once(child, "exit"));
  try {
    await Promise.all(children.map(child => nextMessage(child, message => message?.type === "ready")));
    const results = children.map(child => nextMessage(child, message => message?.type === "result"));
    for (const child of children) child.send({ type: "start" });
    const settled = await Promise.all(results);
    assert.equal(settled.filter(result => result.acquired).length, 1);
    for (const result of settled.filter(result => !result.acquired)) {
      assert.equal(result.code, "EVENT_LOG_LIMIT");
    }
    await Promise.all(exits);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  }
  const final = await readFile(paths.eventsPath);
  assert.equal(final.length, 1024 * 1024);
  assert.ok(final.subarray(-prepared.bytes.length).equals(prepared.bytes));
});

test("ordinary event appends cannot grow a ledger beyond 1 MiB", async () => {
  const root = await makeWorkspace();
  const paths = pathsFor(root);
  await mkdir(paths.codexDir, { recursive: true });
  await writeFile(paths.eventsPath, Buffer.alloc(1024 * 1024, 0x20));
  const before = await readFile(paths.eventsPath);
  await assert.rejects(
    () => appendEvent(root, { kind: "workflow_paused", workflow_id: "wf-full" }),
    error => error.code === "EVENT_LOG_LIMIT"
  );
  assert.ok(Buffer.from(await readFile(paths.eventsPath)).equals(before));
});

test("active metadata is archived under backups with a sanitized directory name", async () => {
  const root = await makeWorkspace();
  const state = initialState();
  await writeStateAtomic(root, state);
  await appendEvent(root, { kind: "workflow_paused", timestamp: baseTime, workflow_id: "wf-1" });

  const archivePath = await withRunLock(pathsFor(root).lockPath, () => archiveActiveState(root, {
    reason: "../../manual reset",
    now: () => new Date(baseTime)
  }));

  assert.equal(existsSync(pathsFor(root).statePath), false);
  assert.equal(existsSync(pathsFor(root).eventsPath), false);
  assert.equal(dirname(archivePath), pathsFor(root).backupsDir);
  assert.match(archivePath.split(/[\\/]/).at(-1), /^2026-09-02T00-00-00-000Z-manual-reset-[a-f0-9-]+$/);
  assert.deepEqual(JSON.parse(await readFile(join(archivePath, "state.json"), "utf8")), state);
  assert.equal((await readFile(join(archivePath, "events.jsonl"), "utf8")).includes("workflow_paused"), true);
});

test("archive requires the workspace run lock", async () => {
  const root = await makeWorkspace();
  await writeStateAtomic(root, initialState());

  await assert.rejects(
    () => archiveActiveState(root),
    error => error.code === "ARCHIVE_LOCK_REQUIRED"
  );
  assert.notEqual(await readState(root), null);
});

test("archive rejects an inherited async context after its lock is released", async () => {
  const root = await makeWorkspace();
  await writeStateAtomic(root, initialState());
  const { lockPath } = pathsFor(root);
  let resumeArchive;
  const releaseGate = new Promise(resolve => {
    resumeArchive = resolve;
  });
  let delayedArchive;

  await withRunLock(lockPath, () => {
    delayedArchive = (async () => {
      await releaseGate;
      return archiveActiveState(root);
    })();
  });
  resumeArchive();

  await assert.rejects(delayedArchive, error => error.code === "ARCHIVE_LOCK_REQUIRED");
  assert.notEqual(await readState(root), null);
});

test("archive move failure rolls every moved item back to active storage", async () => {
  const root = await makeWorkspace();
  const state = initialState();
  await writeStateAtomic(root, state);
  await appendEvent(root, { kind: "workflow_paused", timestamp: baseTime, workflow_id: "wf-1" });
  const { codexDir, lockPath } = pathsFor(root);

  await assert.rejects(() => withRunLock(lockPath, () => archiveActiveState(root, {
    renameFile: async (sourcePath, destinationPath) => {
      if (sourcePath === join(codexDir, "events.jsonl")) throw new Error("archive move failed");
      await rename(sourcePath, destinationPath);
    }
  })), /archive move failed/);

  assert.deepEqual(await readState(root), state);
  assert.equal((await readFile(join(codexDir, "events.jsonl"), "utf8")).includes("workflow_paused"), true);
});

test("archive reports rollback failures instead of hiding split-state integrity loss", async () => {
  const root = await makeWorkspace();
  await writeStateAtomic(root, initialState());
  await appendEvent(root, { kind: "workflow_paused", timestamp: baseTime, workflow_id: "wf-1" });
  const { codexDir, lockPath } = pathsFor(root);

  await assert.rejects(() => withRunLock(lockPath, () => archiveActiveState(root, {
    renameFile: async (sourcePath, destinationPath) => {
      if (sourcePath === join(codexDir, "events.jsonl")) throw new Error("archive move failed");
      if (destinationPath === join(codexDir, "state.json")) throw new Error("archive rollback failed");
      await rename(sourcePath, destinationPath);
    }
  })), error => {
    assert.equal(error.code, "ARCHIVE_INTEGRITY_ERROR");
    assert.equal(error.details.cause, "archive move failed");
    assert.deepEqual(error.details.rollback_errors, [{
      name: "state.json",
      message: "archive rollback failed"
    }]);
    assert.equal(typeof error.details.archive_path, "string");
    assert.equal(dirname(error.details.archive_path), pathsFor(root).backupsDir);
    assert.deepEqual(error.details.archived_items, ["state.json"]);
    return true;
  });
});

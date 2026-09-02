import { once } from "node:events";

import { mutateState } from "../../scripts/lib/state-store.mjs";
import { withRunLock } from "../../scripts/lib/lock.mjs";
import { pathsFor } from "../../scripts/lib/paths.mjs";

const [workspaceRoot, mode = "mutate"] = process.argv.slice(2);

function send(message) {
  if (process.connected) process.send(message);
}

send({ type: "ready" });
await once(process, "message");

try {
  let release;
  const released = new Promise(resolve => {
    release = resolve;
  });
  const onMessage = message => {
    if (message?.type === "release") release();
  };
  process.on("message", onMessage);

  if (mode.startsWith("paused-reclaimer")) {
    let continueReclaim;
    const reclaimContinued = new Promise(resolve => {
      continueReclaim = resolve;
    });
    const onReclaimMessage = message => {
      if (message?.type === "continue-reclaim") continueReclaim();
    };
    let continueTransition;
    const transitionContinued = new Promise(resolve => {
      continueTransition = resolve;
    });
    const onTransitionMessage = message => {
      if (message?.type === "continue-transition") continueTransition();
    };
    process.on("message", onReclaimMessage);
    process.on("message", onTransitionMessage);
    await withRunLock(pathsFor(workspaceRoot).lockPath, async () => {
      send({ type: "result", acquired: true, pid: process.pid });
      await released;
    }, {
      waitMs: 0,
      staleMs: 30_000,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      beforeReclaim: async record => {
        send({ type: "stale-observed", token: record.token, pid: process.pid });
        await reclaimContinued;
      },
      afterReclaimTransition: async record => {
        if (mode !== "paused-reclaimer-watch-transition") return;
        send({ type: "successor-moved", token: record.token, pid: process.pid });
        await transitionContinued;
      }
    });
    process.off("message", onReclaimMessage);
    process.off("message", onTransitionMessage);
  } else if (mode === "lock-owner") {
    await withRunLock(pathsFor(workspaceRoot).lockPath, async () => {
      send({ type: "result", acquired: true, pid: process.pid });
      await released;
    }, { waitMs: 0 });
  } else {
    await mutateState(workspaceRoot, async state => {
      send({ type: "result", acquired: true, pid: process.pid });
      await released;
      return {
        ...state,
        updated_at: "2026-09-02T00:00:01.000Z"
      };
    }, { waitMs: 0 });
  }

  process.off("message", onMessage);
  send({ type: "done" });
} catch (error) {
  send({
    type: "result",
    acquired: false,
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  });
}

process.disconnect();

import { once } from "node:events";

import { mutateState } from "../../scripts/lib/state-store.mjs";

const [workspaceRoot] = process.argv.slice(2);

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

  await mutateState(workspaceRoot, async state => {
    send({ type: "result", acquired: true, pid: process.pid });
    await released;
    return {
      ...state,
      updated_at: "2026-09-02T00:00:01.000Z"
    };
  }, { waitMs: 0 });

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

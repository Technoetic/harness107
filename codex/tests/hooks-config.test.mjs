import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

const configUrl = new URL("../hooks/hooks.json", import.meta.url);
const expectedScripts = new Map([
  ["SessionStart", "session-start.mjs"],
  ["UserPromptSubmit", "user-prompt-submit.mjs"],
  ["Stop", "stop.mjs"]
]);

function allCommandHandlers(config) {
  return Object.entries(config.hooks).flatMap(([eventName, groups]) =>
    groups.flatMap(group => group.hooks.map(handler => ({ eventName, group, handler })))
  );
}

function expandRoot(command, pluginRoot) {
  return command.replaceAll("${PLUGIN_ROOT}", pluginRoot);
}

function quotedScript(command) {
  const match = /^node "([^"]+)"$/.exec(command);
  assert.ok(match, `command is not one quoted node script: ${command}`);
  return match[1];
}

function assertResolvedScript(command, pluginRoot, flavor, expectedScript) {
  const expanded = expandRoot(command, pluginRoot);
  const script = quotedScript(expanded);
  const expected = flavor.resolve(pluginRoot, "codex", "hooks", expectedScript);
  assert.equal(flavor.resolve(script), expected);
  const relative = flavor.relative(flavor.resolve(pluginRoot), flavor.resolve(script));
  assert.ok(relative !== "" && relative !== ".." && !relative.startsWith(`..${flavor.sep}`));
}

test("hook config contains exactly the three synchronous lifecycle commands", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.deepEqual(Object.keys(config), ["hooks"]);
  assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(allCommandHandlers(config).length, 3);

  for (const [eventName, groups] of Object.entries(config.hooks)) {
    assert.equal(groups.length, 1);
    assert.deepEqual(Object.keys(groups[0]), ["hooks"]);
    assert.equal(groups[0].hooks.length, 1);
    const handler = groups[0].hooks[0];
    const target = expectedScripts.get(eventName);
    assert.deepEqual(handler, {
      type: "command",
      command: `node "${"${PLUGIN_ROOT}"}/codex/hooks/${target}"`,
      commandWindows: `node "${"${PLUGIN_ROOT}"}/codex/hooks/${target}"`,
      timeout: 10
    });
    assert.notEqual(handler.async, true);
  }
});

test("POSIX and Windows command fields resolve exactly inside realistic installed roots", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const posixRoot = "/opt/Harness50 packages/release;safe-root";
  const windowsRoot = "C:\\Program Files\\Harness50 & adapters\\release";
  for (const { eventName, handler } of allCommandHandlers(config)) {
    const target = expectedScripts.get(eventName);
    assertResolvedScript(handler.command, posixRoot, posix, target);
    assertResolvedScript(handler.commandWindows, windowsRoot, win32, target);
  }
});

test("PLUGIN_ROOT appears once as quoted trusted package metadata and cannot add a command separator", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  for (const { handler } of allCommandHandlers(config)) {
    for (const field of ["command", "commandWindows"]) {
      assert.equal((handler[field].match(/\$\{PLUGIN_ROOT\}/g) ?? []).length, 1);
      assert.match(handler[field], /^node "\$\{PLUGIN_ROOT\}\/codex\/hooks\/[a-z-]+\.mjs"$/);
      const expanded = expandRoot(handler[field], "/installed/root;echo-inert");
      assert.equal(quotedScript(expanded).includes(";echo-inert/codex/hooks/"), true);
      assert.equal(expanded.split('"').length, 3);
    }
  }
});

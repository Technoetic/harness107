import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Codex manifest isolates Codex skills and hooks", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../.codex-plugin/plugin.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.name, "harness50");
  assert.equal(manifest.version, "2.1.0");
  assert.equal(manifest.skills, "./codex/skills/");
  assert.equal(manifest.hooks, "./codex/hooks/hooks.json");
  assert.notEqual(manifest.hooks, "./hooks/hooks.json");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration, saveConfiguration } from "../src/config.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-config-"));
  const repo = path.join(root, "source with spaces");
  await mkdir(repo);
  return { root, repo, env: { LOCAL_CODE_LINK_HOME: path.join(root, "private state") } };
}
test("fresh setup stores private configuration outside the package", async () => {
  const { repo, env } = await fixture();
  const result = await loadConfiguration(repo, env);
  assert.equal(result.loaded, false);
  assert.equal(result.file, path.join(env.LOCAL_CODE_LINK_HOME, "config.env"));
  await saveConfiguration(result.file, { TELEGRAM_BOT_TOKEN: "test-only", LOCAL_CODE_LINK_HOME: env.LOCAL_CODE_LINK_HOME });
  assert.equal((await stat(result.file)).mode & 0o777, 0o600);
  const next = { LOCAL_CODE_LINK_HOME: env.LOCAL_CODE_LINK_HOME };
  const loaded = await loadConfiguration(repo, next);
  assert.equal(loaded.legacy, false);
  assert.equal(next.TELEGRAM_BOT_TOKEN, "test-only");
});
test("configuration does not execute shell expressions or override environment values", async () => {
  const { repo, env } = await fixture();
  await mkdir(env.LOCAL_CODE_LINK_HOME);
  await writeFile(path.join(env.LOCAL_CODE_LINK_HOME, "config.env"),
    'TELEGRAM_BOT_TOKEN=$(do-not-execute)\nCODEX_BIN=/tmp/with spaces/codex\nNODE_OPTIONS=unsafe\n', { mode: 0o600 });
  env.TELEGRAM_BOT_TOKEN = "explicit";
  await loadConfiguration(repo, env);
  assert.equal(env.TELEGRAM_BOT_TOKEN, "explicit");
  assert.equal(env.CODEX_BIN, "/tmp/with spaces/codex");
  assert.equal(env.NODE_OPTIONS, undefined);
});
test("legacy configuration remains readable until explicit setup saves the new file", async () => {
  const { repo, env } = await fixture();
  await writeFile(path.join(repo, ".env"), "TELEGRAM_BOT_TOKEN=legacy\n", { mode: 0o600 });
  const result = await loadConfiguration(repo, env);
  assert.equal(result.legacy, true);
  assert.equal(env.LOCAL_CODE_LINK_ENV_FILE, path.join(repo, ".env"));
  assert.equal(result.file, path.join(env.LOCAL_CODE_LINK_HOME, "config.env"));
  await saveConfiguration(result.file, { TELEGRAM_BOT_TOKEN: "new" });
  const next = { LOCAL_CODE_LINK_HOME: env.LOCAL_CODE_LINK_HOME };
  await loadConfiguration(repo, next);
  assert.equal(next.TELEGRAM_BOT_TOKEN, "new");
});
test("explicit config path never silently falls back to a different bot", async () => {
  const { root, repo, env } = await fixture();
  await writeFile(path.join(repo, ".env"), "TELEGRAM_BOT_TOKEN=wrong-bot\n", { mode: 0o600 });
  env.LOCAL_CODE_LINK_ENV_FILE = path.join(root, "explicit.env");
  const result = await loadConfiguration(repo, env);
  assert.equal(result.loaded, false);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
});
test("loaded config remains the active file even when it names another state directory", async () => {
  const { root, repo, env } = await fixture();
  const file = path.join(env.LOCAL_CODE_LINK_HOME, "config.env");
  await mkdir(env.LOCAL_CODE_LINK_HOME);
  await writeFile(file, `LOCAL_CODE_LINK_HOME=${path.join(root, "redirected")}\n`, { mode: 0o600 });
  // Default config location is selected before loading the redirected root.
  const loaded = await loadConfiguration(repo, env);
  assert.equal(loaded.activeFile, file);
  assert.equal(env.LOCAL_CODE_LINK_ENV_FILE, file);
});
test("unsafe permissions and multiline configuration fail without exposing values", async () => {
  const { root, repo, env } = await fixture();
  const file = path.join(root, "public.env");
  await writeFile(file, "TELEGRAM_BOT_TOKEN=PRIVATE_VALUE\n", { mode: 0o644 });
  env.LOCAL_CODE_LINK_ENV_FILE = file;
  await assert.rejects(loadConfiguration(repo, env), (e) => /not private/.test(e.message) && !e.message.includes("PRIVATE_VALUE"));
  await assert.rejects(saveConfiguration(file, { TELEGRAM_BOT_TOKEN: "PRIVATE\nEVIL=value" }), /Invalid/);
  assert.ok((await readFile(file, "utf8")).includes("PRIVATE_VALUE"));
});

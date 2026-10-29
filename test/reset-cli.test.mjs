import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state.mjs";
import { loadTerminalPty } from "../src/terminal-pty.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "lcl-reset-cli-"));
  const home = path.join(base, "home");
  const copy = path.join(base, "installed package");
  await mkdir(home);
  await mkdir(copy);
  await cp(path.join(repo, "src"), path.join(copy, "src"), { recursive: true });
  await cp(path.join(repo, "bin"), path.join(copy, "bin"), { recursive: true });
  await symlink(path.join(repo, "node_modules"), path.join(copy, "node_modules"));
  const root = path.join(home, "bridge");
  const store = await new StateStore(root).init();
  store.state.telegram = { botId: 1, chatId: "-1001", controlTopicId: 2 };
  store.state.projects.demo = { id: "demo", cwd: copy, provider: "codex", topicId: 9 };
  await store.save();
  const configFile = path.join(root, "config.env");
  await writeFile(configFile,
    "TELEGRAM_BOT_TOKEN=fixture-old-secret\nTELEGRAM_CHAT_ID=-1001\nTELEGRAM_ALLOWED_USER_IDS=42\n",
    { mode: 0o600 });
  const env = { ...process.env, HOME: home, NODE_NO_WARNINGS: "1",
    LOCAL_CODE_LINK_DIR: copy, LOCAL_CODE_LINK_NODE_BIN: process.execPath,
    LOCAL_CODE_LINK_HOME: root, LOCAL_CODE_LINK_ENV_FILE: configFile,
    TELEGRAM_BOT_TOKEN: "fixture-exported-secret", TELEGRAM_CHAT_ID: "-1001",
    TELEGRAM_ALLOWED_USER_IDS: "42", CODEX_BIN: "/nonexistent/fixture", CLAUDE_BIN: "/nonexistent/fixture" };
  const pty = await loadTerminalPty();
  const terminal = pty.spawn("/bin/sh", [path.join(copy, "bin/local-code-link"), "reset"],
    { env, cwd: copy, cols: 120, rows: 30 });
  let output = "";
  let exited;
  terminal.onData((chunk) => { output += chunk; });
  const exit = new Promise((resolve) => terminal.onExit((event) => { exited = event; resolve(event); }));
  const wait = async (condition) => {
    const deadline = Date.now() + 15_000;
    while (!condition()) {
      if (exited || Date.now() > deadline) throw new Error("Reset CLI fixture did not reach the expected terminal prompt.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await wait(() => output.includes("Reset LocalCodeLink? Yes or No"));
  return { home, root, store, configFile, terminal, exit, wait, output: () => output };
}

test("real terminal reset No leaves state/configuration byte-for-byte unchanged", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.store.file, "utf8");
    const config = await readFile(f.configFile, "utf8");
    f.terminal.write("No\r");
    assert.equal((await f.exit).exitCode, 0);
    assert.match(f.output(), /Cancelled\. Nothing was changed/);
    assert.equal(await readFile(f.store.file, "utf8"), original);
    assert.equal(await readFile(f.configFile, "utf8"), config);
    assert.ok(!f.output().includes("fixture-old-secret"));
    assert.ok(!f.output().includes("fixture-exported-secret"));
  } finally { f.terminal.kill(); }
});

test("real terminal reset Yes starts hidden fresh-token input without reusing loaded/exported credentials", async () => {
  const f = await fixture();
  try {
    f.terminal.write("Yes\r");
    await f.wait(() => f.output().includes("Bot token (hidden):"));
    const fresh = JSON.parse(await readFile(f.store.file, "utf8"));
    assert.deepEqual(fresh.telegram, {});
    assert.deepEqual(fresh.projects, {});
    assert.deepEqual(fresh.approvals, []);
    await assert.rejects(stat(f.configFile), { code: "ENOENT" });
    const backups = (await readdir(f.home)).filter((name) => name.startsWith(".local-code-link-reset-backup-"));
    assert.equal(backups.length, 1);
    assert.match(f.output(), /Starting fresh Telegram setup/);
    assert.ok(!f.output().includes("fixture-old-secret"));
    assert.ok(!f.output().includes("fixture-exported-secret"));
    // No real Bot API request is made; the fixture stops at hidden input.
    f.terminal.write("\x03");
    await f.exit;
    await assert.rejects(stat(f.configFile), { code: "ENOENT" });
  } finally { f.terminal.kill(); }
});

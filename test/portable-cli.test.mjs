import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
const execute = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-portable-"));
  const copy = path.join(root, "installed package with spaces");
  await mkdir(copy);
  await cp(path.join(repo, "bin"), path.join(copy, "bin"), { recursive: true });
  await cp(path.join(repo, "src"), path.join(copy, "src"), { recursive: true });
  await symlink(path.join(repo, "node_modules"), path.join(copy, "node_modules"));
  const env = { ...process.env, NODE_NO_WARNINGS: "1", LOCAL_CODE_LINK_DIR: copy,
    LOCAL_CODE_LINK_NODE_BIN: process.execPath, LOCAL_CODE_LINK_HOME: path.join(root, "state"),
    LOCAL_CODE_LINK_ENV_FILE: path.join(root, "config.env"), TELEGRAM_BOT_TOKEN: "test-only",
    TELEGRAM_ALLOWED_USER_IDS: "123" };
  const command = path.join(copy, "bin", "local-code-link");
  return { root, copy, env, command };
}
test("symlinked launcher resolves an installed package with spaces and never sources shell config", async () => {
  const { root, copy, env, command } = await fixture();
  delete env.LOCAL_CODE_LINK_DIR;
  delete env.LOCAL_CODE_LINK_ENV_FILE;
  const marker = path.join(root, "must-not-exist");
  await writeFile(path.join(copy, ".env"), `IGNORED=$(touch "${marker}")\n`, { mode: 0o600 });
  const link = path.join(root, "linked command");
  await symlink(command, link);
  const { stdout, stderr } = await execute("/bin/sh", [link, "help"], { env });
  assert.match(stdout, /LocalCodeLink/);
  assert.equal(stderr, "");
  await assert.rejects(stat(marker), { code: "ENOENT" });
});
for (const provider of ["claude", "codex"]) {
  test(`${provider} link-only reuses the project without starting any provider`, async () => {
    const { root, env, command } = await fixture();
    const project = path.join(root, "project with spaces");
    await mkdir(project);
    const s = await new StateStore(env.LOCAL_CODE_LINK_HOME).init();
    s.state.telegram = { chatId: "-1001", botId: 1, controlTopicId: 2 };
    s.state.projects.demo = { id: "demo", name: "demo", cwd: await realpath(project),
      provider, linkId: "test-link", topicId: 9, status: "idle", sessionIds: {} };
    await s.save();
    env.CLAUDE_BIN = env.CODEX_BIN = "/nonexistent/must-not-spawn";
    const { stdout, stderr } = await execute("/bin/sh", [command, provider, "--link-only"], { env, cwd: project });
    assert.match(stdout, /already maps to Telegram topic 9/);
    assert.match(stdout, /Mapping saved/);
    assert.equal(stderr, "");
    await s.reload();
    assert.equal(s.state.projects.demo.localSession, undefined);
  });
}
test("missing Node produces a clear portable launcher error", async () => {
  const { command, env } = await fixture();
  env.LOCAL_CODE_LINK_NODE_BIN = "/nonexistent/node";
  await assert.rejects(execute("/bin/sh", [command, "help"], { env }), (error) =>
    error.code === 127 && /requires Node.js on PATH/.test(error.stderr));
});

test("a noninteractive first provider launch gives guided setup instructions without opening a session", async () => {
  const { root, env, command } = await fixture();
  delete env.TELEGRAM_BOT_TOKEN;
  const project = path.join(root, "project");
  await mkdir(project);
  env.CLAUDE_BIN = env.CODEX_BIN = "/nonexistent/must-not-spawn";
  await assert.rejects(execute("/bin/sh", [command, "codex"], { env, cwd: project }), (error) =>
    /First-time setup needs an interactive terminal/.test(error.stderr)
    && /Run local-code-link in your project folder/.test(error.stderr));
});

test("no arguments in noninteractive mode show help without calling Telegram or providers", async () => {
  const { env, command } = await fixture();
  env.CLAUDE_BIN = env.CODEX_BIN = "/nonexistent/must-not-spawn";
  const { stdout, stderr } = await execute("/bin/sh", [command], { env });
  assert.match(stdout, /guided setup and project launch/);
  assert.equal(stderr, "");
});

test("reset without a terminal refuses before creating state or contacting Telegram", async () => {
  const { env, command } = await fixture();
  await assert.rejects(execute("/bin/sh", [command, "reset"], { env }), (error) =>
    /interactive terminal and Yes\/No confirmation/.test(error.stderr));
  await assert.rejects(stat(env.LOCAL_CODE_LINK_HOME), { code: "ENOENT" });
});

test("old reset --confirm cannot bypass the required Yes/No confirmation", async () => {
  const { env, command } = await fixture();
  await assert.rejects(execute("/bin/sh", [command, "reset", "--confirm"], { env }), (error) =>
    /without flags.*Yes or No/.test(error.stderr));
  await assert.rejects(stat(env.LOCAL_CODE_LINK_HOME), { code: "ENOENT" });
});

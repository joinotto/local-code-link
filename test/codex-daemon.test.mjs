import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSharedCodexServer } from "../src/codex-daemon.mjs";

test("shared Codex startup uses the selected executable, strips Telegram token and bounds the wait", async () => {
  const env = { PATH: "/fixture/bin", TELEGRAM_BOT_TOKEN: "never-pass-to-provider", OPENAI_API_KEY: "provider-fixture" };
  let called = false;
  await startSharedCodexServer("/fixture with spaces/codex", {
    env,
    execute: async (executable, args, options) => {
      called = true;
      assert.equal(executable, "/fixture with spaces/codex");
      assert.deepEqual(args, ["app-server", "daemon", "start"]);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.env.PATH, env.PATH);
      assert.equal(options.env.OPENAI_API_KEY, env.OPENAI_API_KEY);
      assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(called, true);
  assert.equal(env.TELEGRAM_BOT_TOKEN, "never-pass-to-provider");
});

test("missing Codex reports actionable ENOENT guidance even with no subprocess output", async () => {
  await assert.rejects(startSharedCodexServer("codex", {
    execute: async () => ({ error: { code: "ENOENT" }, stdout: "", stderr: "" }),
  }), (error) => /executable not found \(codex\)/.test(error.message)
    && /command -v codex/.test(error.message) && /CODEX_BIN/.test(error.message));
});

test("inaccessible Codex and startup timeout have distinct errors", async () => {
  for (const [error, expected] of [
    [{ code: "EACCES" }, /not accessible or executable/],
    [{ killed: true, signal: "SIGTERM" }, /timed out after 30 seconds/],
    [{ code: "ETIMEDOUT" }, /timed out after 30 seconds/],
  ]) {
    await assert.rejects(startSharedCodexServer("/fixture/codex", {
      socketPath: "/nonexistent/local-code-link-fixture/socket",
      execute: async () => ({ error, stdout: "", stderr: "" }),
    }), expected);
  }
});

test("timeout diagnoses a dangling Codex socket without stopping or restarting the daemon", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-codex-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = path.join(root, "app-server-control");
  await mkdir(control);
  const socketPath = path.join(control, "app-server-control.sock");
  await symlink("../missing.sock", socketPath);
  for (const settings of [
    { socketPath },
    { env: { CODEX_APP_SERVER_SOCKET: socketPath } },
    { env: { CODEX_HOME: root } },
  ]) {
    const calls = [];
    await assert.rejects(startSharedCodexServer("/fixture/codex", {
      ...settings,
      execute: async (_executable, args) => {
        calls.push(args);
        return { error: { killed: true }, stdout: "", stderr: "" };
      },
    }), (error) => /socket link points to a missing file/.test(error.message)
      && /Finish or save work in all shared Codex sessions/.test(error.message)
      && /Restarting can interrupt/.test(error.message)
      && !error.message.includes(root));
    assert.deepEqual(calls, [["app-server", "daemon", "start"]]);
  }
});

test("other socket states retain the generic timeout guidance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-codex-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  await writeFile(target, "");
  const link = path.join(root, "link");
  await symlink(target, link);
  for (const socketPath of [path.join(root, "absent"), target, link]) {
    await assert.rejects(startSharedCodexServer("/fixture/codex", {
      socketPath,
      execute: async () => ({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }),
    }), (error) => /codex app-server daemon version/.test(error.message)
      && !/socket link points|daemon restart/.test(error.message));
  }
});

test("silent startup failures retain exit codes or signals, never a blank message", async () => {
  for (const [error, expected] of [
    [{ code: 1 }, /exit\/code 1/],
    [{ code: "ENOBUFS" }, /exit\/code ENOBUFS/],
    [{ signal: "SIGABRT" }, /terminated by SIGABRT/],
    [{}, /process launch failed/],
  ]) {
    await assert.rejects(startSharedCodexServer("/fixture/codex", {
      execute: async () => ({ error, stdout: "", stderr: "" }),
    }), expected);
  }
});

test("excessive startup output is not incorrectly reported as a timeout", async () => {
  await assert.rejects(startSharedCodexServer("/fixture/codex", {
    execute: async () => ({
      error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
      stdout: "private diagnostic output", stderr: "",
    }),
  }), (error) => /exceeded the safe limit/.test(error.message)
    && !/timed out|private diagnostic output/.test(error.message));
});

test("Codex's own startup explanation takes precedence over an empty-code fallback", async () => {
  await assert.rejects(startSharedCodexServer("/fixture/codex", {
    execute: async () => ({
      error: { code: 2 }, stderr: "unsupported daemon command\n", stdout: "",
    }),
  }), /unsupported daemon command/);
});

test("real missing executable produces the same actionable startup error", async () => {
  await assert.rejects(startSharedCodexServer("/nonexistent/local-code-link-fixture/codex"),
    /executable not found.*command -v codex.*CODEX_BIN/);
});

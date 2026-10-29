import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { resetLocalSetup, resetWithConfirmation } from "../src/reset.mjs";
import { StateStore } from "../src/state.mjs";
import { acquireProcessLease } from "../src/process-lease.mjs";
import { buildLaunchAgent } from "../src/launch-agent.mjs";

async function fixture() {
  const base = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "lcl-reset-"));
  const home = path.join(base, "home with spaces");
  const root = path.join(home, "bridge-state");
  const projectRoot = path.join(base, "installed-package");
  await mkdir(root, { recursive: true });
  await mkdir(projectRoot);
  const store = await new StateStore(root).init();
  store.state.telegram = { botId: 1, chatId: "-1001", controlTopicId: 2 };
  store.state.projects.demo = { id: "demo", provider: "codex", cwd: projectRoot,
    topicId: 9, status: "idle", localSession: { status: "stopped" } };
  await store.save();
  const configFile = path.join(root, "config.env");
  await writeFile(configFile, "TELEGRAM_BOT_TOKEN=private-fixture\n", { mode: 0o600 });
  return { base, home, root, projectRoot, configFile, store, platform: "linux" };
}
const missing = async (file) => assert.rejects(stat(file), { code: "ENOENT" });

test("reset No/default/invalid answers cancel without invoking filesystem reset or setup", async () => {
  for (const answers of [["No"], [""], ["maybe", "NO"]]) {
    const f = await fixture();
    const original = await readFile(f.store.file, "utf8");
    const result = await resetWithConfirmation({
      interactive: true, ask: async () => answers.shift(), log() {},
      reset() { assert.fail("must not reset"); }, setup() { assert.fail("must not set up"); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(await readFile(f.store.file, "utf8"), original);
    assert.equal(await readFile(f.configFile, "utf8"), "TELEGRAM_BOT_TOKEN=private-fixture\n");
  }
});

test("reset refuses noninteractive execution without bypassing confirmation", async () => {
  await assert.rejects(resetWithConfirmation({
    interactive: false, ask() { assert.fail(); }, reset() { assert.fail(); }, setup() { assert.fail(); },
  }), /interactive terminal and Yes\/No/);
});

test("reset Yes clears configuration before invoking fresh setup once", async () => {
  const f = await fixture();
  const order = [];
  const result = await resetWithConfirmation({
    interactive: true, ask: async () => " Yes ", log() {},
    reset: async () => { order.push("reset"); return resetLocalSetup(f); },
    setup: async () => {
      order.push("setup");
      await missing(f.configFile);
      await missing(f.store.file);
      const fresh = await new StateStore(f.root).init();
      assert.deepEqual(fresh.state.projects, {});
      assert.deepEqual(fresh.state.telegram, {});
      assert.deepEqual(fresh.state.approvals, []);
    },
  });
  assert.deepEqual(order, ["reset", "setup"]);
  assert.equal(result.cancelled, false);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o700);
});

test("only known history/config/log files move; custom-root neighbours and native histories survive", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "telegram.log"), "old log");
  await writeFile(path.join(f.root, "unrelated.txt"), "keep");
  await mkdir(path.join(f.home, ".codex/sessions"), { recursive: true });
  await writeFile(path.join(f.home, ".codex/sessions/history.jsonl"), "native");
  await writeFile(path.join(f.projectRoot, "source.txt"), "project");
  const before = await readFile(f.store.file, "utf8");
  const result = await resetLocalSetup(f);
  await missing(f.configFile);
  await missing(f.store.file);
  await missing(path.join(f.root, "telegram.log"));
  const manifest = JSON.parse(await readFile(path.join(result.backup, "manifest.json"), "utf8"));
  const record = manifest.archived.find((item) => item.source === f.store.file);
  assert.equal(await readFile(record.destination, "utf8"), before);
  assert.equal(await readFile(path.join(f.root, "unrelated.txt"), "utf8"), "keep");
  assert.equal(await readFile(path.join(f.home, ".codex/sessions/history.jsonl"), "utf8"), "native");
  assert.equal(await readFile(path.join(f.projectRoot, "source.txt"), "utf8"), "project");
});

test("explicit external and source legacy configuration are archived, not silently reused", async () => {
  const f = await fixture();
  const external = path.join(f.home, "explicit.env");
  await writeFile(external, "TELEGRAM_BOT_TOKEN=old-external\n", { mode: 0o600 });
  await writeFile(path.join(f.projectRoot, ".env"), "TELEGRAM_BOT_TOKEN=old-legacy\n", { mode: 0o600 });
  await resetLocalSetup({ ...f, configFile: external, newConfigFile: f.configFile });
  await missing(external);
  await missing(f.configFile);
  await missing(path.join(f.projectRoot, ".env"));
});

test("owned interrupted-write histories are archived without touching unrelated temporary files", async () => {
  const f = await fixture();
  const owned = path.join(f.root, "state.json.12.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp");
  await writeFile(owned, "old temporary history");
  await writeFile(path.join(f.root, "unrelated.tmp"), "keep");
  const result = await resetLocalSetup(f);
  await missing(owned);
  assert.equal(await readFile(path.join(f.root, "unrelated.tmp"), "utf8"), "keep");
  assert.ok((await readdir(result.backup)).some((name) => name.endsWith(path.basename(owned))));
});

test("owned Codex/Claude hooks are removed while unrelated hooks and provider settings survive", async () => {
  const f = await fixture();
  for (const provider of ["codex", "claude"]) {
    await mkdir(path.join(f.home, `.${provider}`));
    const script = provider === "codex" ? "codex-permission-hook.mjs" : "claude-session-hook.mjs";
    const config = { env: { nativeProvider: "keep" }, permissions: { ask: ["Bash"] }, hooks: {
      Stop: [{ matcher: "*", hooks: [
        { type: "command", command: `node '${path.join(f.projectRoot, "src", script)}'` },
        { type: "command", command: `node '/unrelated/src/${script}'` },
      ] }],
    } };
    const file = path.join(f.home, `.${provider}`, provider === "codex" ? "hooks.json" : "settings.json");
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  }
  const result = await resetLocalSetup(f);
  assert.equal(result.hooksRemoved, 2);
  for (const provider of ["codex", "claude"]) {
    const file = path.join(f.home, `.${provider}`, provider === "codex" ? "hooks.json" : "settings.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(config.permissions, { ask: ["Bash"] });
    assert.equal(config.env.nativeProvider, "keep");
    assert.equal(config.hooks.Stop[0].hooks.length, 1);
    assert.match(config.hooks.Stop[0].hooks[0].command, /unrelated/);
    assert.equal((await stat(path.join(result.backup, `${provider}-hooks.json`))).mode & 0o777, 0o600);
  }
});

test("pending approvals, queued results and live native/relay PIDs block reset before clearing files", async () => {
  for (const kind of ["approval", "queue", "outbox", "local", "relay", "background"]) {
    const f = await fixture();
    const project = f.store.state.projects.demo;
    if (kind === "approval") f.store.state.approvals.push({ id: "approval", status: "pending" });
    if (kind === "queue") project.telegramRequests = [{ id: "queued" }];
    if (kind === "outbox") project.claudeOutbox = [{ id: "outbox" }];
    if (kind === "local") project.localSession.pid = process.pid;
    if (kind === "relay") project.localSession.claudeBridgePid = process.pid;
    if (kind === "background") project.backgroundTask = { pid: 2147483647 };
    await f.store.save();
    const original = await readFile(f.store.file, "utf8");
    await assert.rejects(resetLocalSetup(f), /Finish pending/);
    assert.equal(await readFile(f.store.file, "utf8"), original);
    assert.ok(await stat(f.configFile));
  }
});

test("stale stopped PIDs do not prevent reset", async () => {
  const f = await fixture();
  f.store.state.projects.demo.localSession = { status: "active", pid: 2147483647, approvalProxyPid: 2147483647 };
  await f.store.save();
  await resetLocalSetup(f);
  await missing(f.store.file);
});

test("a foreground service lease is refused, never killed", async () => {
  const f = await fixture();
  const release = await acquireProcessLease(path.join(f.root, "telegram-service.lock"));
  try { await assert.rejects(resetLocalSetup(f), /foreground.*serve/); }
  finally { await release(); }
  assert.ok(await stat(f.configFile));
});

test("matching launchd service is stopped before archival; stopped lease and plist are cleared", async () => {
  const f = await fixture();
  const directory = path.join(f.home, "Library/LaunchAgents");
  await mkdir(directory, { recursive: true });
  const plist = path.join(directory, "com.local-code-link.telegram.plist");
  await writeFile(plist, buildLaunchAgent({ projectRoot: f.projectRoot, stateRoot: f.root, configFile: f.configFile }));
  await writeFile(path.join(f.root, "telegram-service.lock"), "2147483647:stale");
  const calls = [];
  const result = await resetLocalSetup({ ...f, platform: "darwin", run: async (_command, args) => {
    calls.push(args[0]);
    return { code: 0, stdout: args[0] === "print" ? "pid = 2147483647\n" : "" };
  } });
  assert.deepEqual(calls, ["print", "bootout"]);
  assert.equal(result.serviceStopped, true);
  await missing(plist);
  await missing(path.join(f.root, "telegram-service.lock"));
});

test("failed service stop preserves configuration/history and never starts fresh setup", async () => {
  const f = await fixture();
  const directory = path.join(f.home, "Library/LaunchAgents");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "com.local-code-link.telegram.plist"),
    buildLaunchAgent({ projectRoot: f.projectRoot, stateRoot: f.root, configFile: f.configFile }));
  await assert.rejects(resetLocalSetup({ ...f, platform: "darwin",
    run: async (_command, args) => ({ code: args[0] === "bootout" ? 1 : 0, stdout: "" }),
  }), /Could not stop.*Nothing was cleared/);
  assert.ok(await stat(f.configFile));
  assert.ok(await stat(f.store.file));
});

test("another setup's launchd service is left untouched", async () => {
  const f = await fixture();
  const directory = path.join(f.home, "Library/LaunchAgents");
  await mkdir(directory, { recursive: true });
  const plist = path.join(directory, "com.local-code-link.telegram.plist");
  await writeFile(plist, buildLaunchAgent({
    projectRoot: f.projectRoot, stateRoot: path.join(f.home, "other-state"), configFile: path.join(f.home, "other.env"),
  }));
  await resetLocalSetup({ ...f, platform: "darwin", run() { assert.fail("must not control another setup"); } });
  assert.ok(await stat(plist));
});

test("filesystem/home roots and symlink configuration targets are refused", async () => {
  const f = await fixture();
  for (const root of ["/", f.home]) await assert.rejects(resetLocalSetup({ ...f, root }), /dedicated/);
  const external = path.join(f.home, "unrelated.env");
  await writeFile(external, "keep");
  const link = path.join(f.root, "linked.env");
  await symlink(external, link);
  await assert.rejects(resetLocalSetup({ ...f, configFile: link }), /Unexpected configuration/);
  assert.equal(await readFile(external, "utf8"), "keep");
  assert.ok(await stat(f.store.file));
});

test("corrupt history fails closed instead of clearing unknown active-work records", async () => {
  const f = await fixture();
  await writeFile(f.store.file, "{invalid");
  await assert.rejects(resetLocalSetup(f), /Cannot safely check/);
  assert.equal(await readFile(f.store.file, "utf8"), "{invalid");
  assert.ok(await stat(f.configFile));
});

test("live relay sockets block reset even when metadata claims the session stopped", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "tui"));
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(path.join(f.root, "tui", `${"a".repeat(20)}.sock`), resolve));
  try { await assert.rejects(resetLocalSetup(f), /relay is still running/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  assert.ok(await stat(f.configFile));
});

test("reset guard blocks both new stores and existing writers without resurrecting history", async () => {
  const f = await fixture();
  const original = await readFile(f.store.file, "utf8");
  const release = await acquireProcessLease(path.join(f.root, "reset.lock"));
  try {
    await assert.rejects(new StateStore(f.root).init(), /reset is in progress/);
    f.store.state.projects.demo.name = "must-not-write";
    await assert.rejects(f.store.save(), /reset is in progress/);
    assert.equal(await readFile(f.store.file, "utf8"), original);
  } finally { await release(); }
});

test("failed fresh setup retains private recovery backup and does not restore old credentials", async () => {
  const f = await fixture();
  let backup;
  await assert.rejects(resetWithConfirmation({
    interactive: true, ask: async () => "Yes", log() {},
    reset: async () => { const result = await resetLocalSetup(f); backup = result.backup; return result; },
    setup: async () => { throw new Error("owner cancelled token entry"); },
  }), /cancelled token/);
  await missing(f.configFile);
  await missing(f.store.file);
  assert.ok((await readdir(backup)).some((file) => file.endsWith("config.env")));
});

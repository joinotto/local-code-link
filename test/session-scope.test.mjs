import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
import { codexInteractiveArgs, selectCodexSession } from "../src/session-scope.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-session-scope-"));
  const cwd = path.join(root, "current-project");
  const otherCwd = path.join(root, "other-project");
  await mkdir(cwd);
  await mkdir(otherCwd);
  const store = await new StateStore(path.join(root, "state")).init();
  const project = {
    id: "current", name: "current", linkId: "link-current", topicId: 10,
    cwd, status: "idle", provider: "codex",
    sessionIds: { codex: "thread-current", claude: "claude-current" },
    transcriptPaths: { codex: "/old-transcript", claude: "/claude-transcript" },
  };
  store.state.projects.current = project;
  store.state.projects.other = {
    id: "other", linkId: "link-other", topicId: 20, cwd: otherCwd,
    status: "idle", sessionIds: { codex: "thread-other" },
  };
  await store.save();
  const calls = [];
  const client = {
    connect: async () => calls.push({ method: "connect" }),
    request: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: params.threadId, cwd } };
    },
  };
  return { root, cwd, otherCwd, store, project, client, calls };
}

test("resume uses only the linked session after checking its exact project folder", async () => {
  const f = await fixture();
  const selected = await selectCodexSession(f.store, f.project, f.client, f.cwd);
  assert.equal(selected.sessionId, "thread-current");
  assert.deepEqual(f.calls[1], {
    method: "thread/read", params: { threadId: "thread-current", includeTurns: false },
  });
  assert.deepEqual(codexInteractiveArgs(f.project, "unix:///relay.sock", selected.sessionId),
    ["--remote", "unix:///relay.sock", "--cd", f.cwd, "resume", "thread-current"]);
});

test("fresh project starts explicitly in the current folder without selecting a global recent session", async () => {
  const f = await fixture();
  f.project.sessionIds = {};
  await f.store.save();
  const selected = await selectCodexSession(f.store, f.project, f.client, f.cwd);
  assert.equal(selected.sessionId, null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(codexInteractiveArgs(f.project, "unix:///relay.sock", selected.sessionId),
    ["--remote", "unix:///relay.sock", "--cd", f.cwd]);
});

test("wrong-folder binding is discarded without changing the other project or native session", async () => {
  const f = await fixture();
  const otherBefore = structuredClone(f.store.state.projects.other);
  f.client.request = async (method, params) => {
    f.calls.push({ method, params });
    return { thread: { id: params.threadId, cwd: f.otherCwd } };
  };
  const selected = await selectCodexSession(f.store, f.project, f.client, f.cwd);
  assert.deepEqual(selected, { sessionId: null, reason: "different folder" });
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, undefined);
  assert.equal(f.store.state.projects.current.transcriptPaths.codex, undefined);
  assert.equal(f.store.state.projects.current.sessionIds.claude, "claude-current");
  assert.deepEqual(f.store.state.projects.other, otherBefore);
  assert.deepEqual(f.calls.map((call) => call.method), ["connect", "thread/read"]);
});

test("missing saved session starts fresh in this project only", async () => {
  const f = await fixture();
  f.client.request = async () => { throw new Error("thread thread-current not found"); };
  assert.deepEqual(await selectCodexSession(f.store, f.project, f.client, f.cwd),
    { sessionId: null, reason: "missing session" });
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, undefined);
});

test("connection failure does not clear the binding or fall back to another session", async () => {
  const f = await fixture();
  f.client.request = async () => { throw new Error("Shared Codex connection closed"); };
  await assert.rejects(selectCodexSession(f.store, f.project, f.client, f.cwd), /connection closed/);
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, "thread-current");
});

test("canonical symlink paths to the same project can resume", async () => {
  const f = await fixture();
  const alias = path.join(f.root, "project-alias");
  await symlink(f.cwd, alias);
  f.client.request = async () => ({ thread: { id: "thread-current", cwd: alias } });
  assert.equal((await selectCodexSession(f.store, f.project, f.client, alias)).sessionId, "thread-current");
});

test("a nested folder is not treated as the same project just because it shares a prefix", async () => {
  const f = await fixture();
  const nested = path.join(f.cwd, "nested-project");
  await mkdir(nested);
  f.client.request = async () => ({ thread: { id: "thread-current", cwd: nested } });
  assert.equal((await selectCodexSession(f.store, f.project, f.client, f.cwd)).sessionId, null);
});

test("wrong invoking directory is rejected before contacting Codex", async () => {
  const f = await fixture();
  await assert.rejects(selectCodexSession(f.store, f.project, f.client, f.otherCwd), /different folder/);
  assert.deepEqual(f.calls, []);
});

test("unexpected returned session id is rejected without modifying the mapping", async () => {
  const f = await fixture();
  f.client.request = async () => ({ thread: { id: "thread-other", cwd: f.cwd } });
  await assert.rejects(selectCodexSession(f.store, f.project, f.client, f.cwd), /unexpected session metadata/);
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, "thread-current");
});

test("a concurrent relink cannot be overwritten by session validation", async () => {
  const f = await fixture();
  f.client.request = async () => {
    const otherStore = await new StateStore(f.store.root).init();
    otherStore.state.projects.current.linkId = "replacement-link";
    otherStore.state.projects.current.sessionIds.codex = "replacement-thread";
    await otherStore.save();
    return { thread: { id: "thread-current", cwd: f.otherCwd } };
  };
  await assert.rejects(selectCodexSession(f.store, f.project, f.client, f.cwd), /session changed/);
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, "replacement-thread");
});

test("pending Telegram work is not silently moved from an invalid session to a new session", async () => {
  const f = await fixture();
  f.project.telegramRequests = [{ id: "queued-request", sessionId: "thread-current" }];
  await f.store.save();
  f.client.request = async () => ({ thread: { id: "thread-current", cwd: f.otherCwd } });
  await assert.rejects(selectCodexSession(f.store, f.project, f.client, f.cwd), /Telegram work is pending/);
  await f.store.reload();
  assert.equal(f.store.state.projects.current.sessionIds.codex, "thread-current");
});

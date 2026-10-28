import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodingRuntime } from "../src/runtime.mjs";
import { StateStore } from "../src/state.mjs";
import { TelegramClient } from "../src/telegram.mjs";

async function fixture(onDeleteTopic = async () => true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-purge-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.telegram = { chatId: "-1001", controlTopicId: 4, botId: 99 };
  store.state.projects.demo = {
    id: "demo", name: "demo", cwd: root, provider: "claude", topicId: 9,
    linkId: "original-link", status: "idle", sessionIds: { claude: "native-session" },
    localSession: { status: "active", pid: 1234 },
    telegramRequests: [{ id: "request-demo", status: "queued" }],
  };
  store.state.projects.other = {
    id: "other", name: "other", cwd: path.dirname(root),
    provider: "claude", topicId: 10, status: "idle",
  };
  store.state.approvals = [
    { id: "pending-demo", projectId: "demo", topicId: 9, status: "pending" },
    { id: "approved-demo", projectId: "demo", topicId: 9, status: "approved" },
    { id: "pending-other", projectId: "other", topicId: 10, status: "pending" },
  ];
  await store.save();
  const runtime = new CodingRuntime(store, { onDeleteTopic });
  return { root, store, runtime };
}

test("successful unlink purges only the selected project's bridge history", async () => {
  const deleted = [];
  const f = await fixture(async (project) => {
    assert.equal(project.status, "unlinked");
    deleted.push(project.topicId);
  });
  const source = path.join(f.root, "source.txt");
  const nativeHistory = path.join(f.root, "native-history.json");
  await writeFile(source, "Project source stays");
  await writeFile(nativeHistory, "Native provider history stays");
  try {
    await f.runtime.unlink("demo", { confirmed: true });
    await f.store.reload();
    assert.equal(f.store.state.projects.demo, undefined);
    assert.equal(f.store.state.projects.other.status, "idle");
    assert.deepEqual(f.store.state.approvals.map((item) => item.id), ["pending-other"]);
    assert.equal(f.store.state.telegram.botId, 99);
    assert.deepEqual(deleted, [9]);
    const disk = await readFile(f.store.file, "utf8");
    for (const value of ["original-link", "native-session", "request-demo", "pending-demo", "approved-demo"]) {
      assert.equal(disk.includes(value), false);
    }
    assert.equal(await readFile(source, "utf8"), "Project source stays");
    assert.equal(await readFile(nativeHistory, "utf8"), "Native provider history stays");
  } finally { f.runtime.stop(); }
});

test("unlink requires explicit confirmation before revocation or deletion", async () => {
  let deletions = 0;
  const f = await fixture(async () => { deletions++; });
  try {
    await assert.rejects(() => f.runtime.unlink("demo"), /confirmation is required/);
    assert.equal(f.store.state.projects.demo.status, "idle");
    assert.equal(deletions, 0);
  } finally { f.runtime.stop(); }
});

test("Telegram deletion failure revokes access, retains retry state, and can be retried", async () => {
  let fail = true;
  const f = await fixture(async () => {
    if (fail) throw new Error("Bot requires Delete Messages permission");
  });
  try {
    await assert.rejects(() => f.runtime.unlink("demo", { confirmed: true }), /cleanup is incomplete/);
    await f.store.reload();
    assert.equal(f.store.state.projects.demo.status, "unlinked");
    assert.equal(f.runtime.projectByTopic(9), undefined);
    assert.equal(f.store.state.approvals.find((item) => item.id === "pending-demo").status, "denied");
    fail = false;
    await f.runtime.unlink("demo", { confirmed: true });
    assert.equal(f.store.state.projects.demo, undefined);
    assert.deepEqual(f.store.state.approvals.map((item) => item.id), ["pending-other"]);
  } finally { f.runtime.stop(); }
});

test("unlink refuses the control topic and a topic shared with another project", async () => {
  let deletions = 0;
  const f = await fixture(async () => { deletions++; });
  try {
    f.store.state.projects.demo.topicId = 4;
    await f.store.save();
    await assert.rejects(() => f.runtime.unlink("demo", { confirmed: true }), /Refusing/);
    f.store.state.projects.demo.topicId = 10;
    await f.store.save();
    await assert.rejects(() => f.runtime.unlink("demo", { confirmed: true }), /Refusing/);
    assert.equal(deletions, 0);
  } finally { f.runtime.stop(); }
});

test("a stale writer cannot restore a purged project or its approvals", async () => {
  const f = await fixture();
  const stale = await new StateStore(f.store.root).init();
  try {
    await f.runtime.unlink("demo", { confirmed: true });
    stale.state.projects.demo.status = "busy";
    stale.state.projects.demo.sessionIds.claude = "late-session";
    stale.state.approvals[0].notifiedAt = "late";
    stale.state.approvals.push({ id: "late-approval", projectId: "demo", topicId: 9, status: "pending" });
    await stale.save();
    await f.store.reload();
    assert.equal(f.store.state.projects.demo, undefined);
    assert.deepEqual(f.store.state.approvals.map((item) => item.id), ["pending-other"]);
  } finally { f.runtime.stop(); }
});

test("a stale writer cannot overwrite a newly linked project with the same name", async () => {
  const f = await fixture();
  const stale = await new StateStore(f.store.root).init();
  try {
    await f.runtime.unlink("demo", { confirmed: true });
    f.store.state.projects.demo = {
      id: "demo", linkId: "new-link", topicId: 77, cwd: f.root,
      provider: "claude", status: "idle", sessionIds: {},
    };
    await f.store.save();
    stale.state.projects.demo.sessionIds.claude = "old-session-completed";
    stale.state.approvals.push({ id: "late-approval", projectId: "demo", topicId: 9, status: "pending" });
    await stale.save();
    await f.store.reload();
    assert.equal(f.store.state.projects.demo.linkId, "new-link");
    assert.deepEqual(f.store.state.projects.demo.sessionIds, {});
    assert.equal(f.store.state.approvals.some((item) => item.id === "late-approval"), false);
  } finally { f.runtime.stop(); }
});

test("Telegram topic deletion treats an already-deleted topic as cleaned, not permission failures", async () => {
  const calls = [];
  let description = "Bad Request: TOPIC_ID_INVALID";
  let code = 400;
  const client = new TelegramClient("unused", {
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: false, error_code: code, description }), {
        status: code, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(await client.deleteForumTopic("-1001", 9), true);
  assert.deepEqual(calls[0].body, { chat_id: "-1001", message_thread_id: 9 });
  assert.match(calls[0].url, /deleteForumTopic$/);
  code = 403;
  description = "Forbidden: not enough rights";
  await assert.rejects(() => client.deleteForumTopic("-1001", 9), /not enough rights/);
});

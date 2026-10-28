import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import { TelegramService } from "../src/telegram-service.mjs";
import { CodingRuntime } from "../src/runtime.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-recovery-"));
  const store = await new StateStore(root).init();
  store.state.projects.demo = { id: "demo", name: "demo", cwd: root, provider: "claude",
    topicId: 9, linkId: "one", status: "idle", sessionIds: {} };
  await store.save();
  return store;
}

test("orphaned Claude background requests cannot be answered after a service restart", async () => {
  const store = await fixture();
  store.state.approvals.push({
    id: "orphan", projectId: "demo", topicId: 9, provider: "claude",
    source: "claude-stream", type: "command", status: "pending",
    expiresAt: new Date(Date.now() + 60000).toISOString(), canReply: true,
  });
  await store.save();
  const runtime = new CodingRuntime(store);
  await assert.rejects(runtime.decideApproval("orphan", "approve", 10, 9), /disconnected/);
  store.state.approvals[0].type = "question";
  await store.save();
  await assert.rejects(runtime.answerQuestion("orphan", "yes", 10, 9), /disconnected/);
  await store.reload();
  assert.equal(store.state.approvals[0].status, "pending");
  runtime.stop();
});

test("Telegram acknowledges updates only after acceptance and checkpoint", async () => {
  const client = new TelegramClient("test");
  const events = [];
  client.request = async () => [{ update_id: 5 }, { update_id: 6 }];
  client.onOffset = async (offset) => events.push(`saved:${offset}`);
  await client.poll(async (update) => {
    assert.equal(client.offset, update.update_id === 5 ? 0 : 6);
    events.push(`accepted:${update.update_id}`);
    if (update.update_id === 6) client.stop();
  });
  assert.deepEqual(events, ["accepted:5", "saved:6", "accepted:6", "saved:7"]);
});

test("a conflicting Telegram poller fails visibly instead of repeatedly fighting for updates", async () => {
  const client = new TelegramClient("test");
  client.request = async () => { throw Object.assign(new Error("conflict"), { telegramCode: 409 }); };
  await assert.rejects(client.poll(async () => {}), /Another process/);
});

test("inactive Claude messages are durable and duplicate inbound updates are not run twice", async () => {
  const store = await fixture();
  const runtime = new CodingRuntime(store);
  runtime.stop(); // Inspect durable acceptance without running an actual model.
  await runtime.queueToLocalSession(store.state.projects.demo, "hi", { updateId: 42 });
  await runtime.queueToLocalSession(store.state.projects.demo, "hi", { updateId: 42 });
  await store.reload();
  assert.equal(store.state.projects.demo.telegramRequests.length, 1);
  assert.equal(store.state.projects.demo.telegramRequests[0].dispatch, "stream");
  assert.deepEqual(store.state.projects.demo.telegramUpdateIds, [42]);
});

test("restart reports interrupted background work, restores update offset and does not replay it", async () => {
  const store = await fixture();
  const project = store.state.projects.demo;
  project.status = "busy";
  project.backgroundTask = { pid: 2147483647 };
  project.telegramRequests = [{ id: "task-1", provider: "claude", dispatch: "stream", status: "active", prompt: "do not replay" }];
  store.state.telegram.updateOffset = 12;
  await store.save();
  const client = { getMe: async () => ({}), poll: async () => {}, sendMessage: async () => {} };
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10", client });
  await service.start();
  await store.reload();
  assert.equal(client.offset, 12);
  assert.equal(project.telegramRequests[0].status, "interrupted");
  assert.match(project.claudeOutbox[0].text, /not replayed/);
  assert.equal(project.backgroundTask, undefined);
  assert.equal(service.runtime.running.size, 0);
});

test("restart preserves busy state for a still-running owned terminal", async () => {
  const store = await fixture();
  const project = store.state.projects.demo;
  project.status = "busy";
  project.localSession = { pid: process.pid, status: "active" };
  await store.save();
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10",
    client: { getMe: async () => ({}), poll: async () => {} } });
  await service.start();
  await store.reload();
  assert.equal(project.status, "busy");
});

test("failed Telegram output remains in durable outbox until delivery recovers", async () => {
  const store = await fixture();
  const project = store.state.projects.demo;
  project.telegramRequests = [{ id: "result-1", status: "active" }];
  project.claudeOutbox = [{ id: "result-1", text: "completed once" }];
  await store.save();
  let offline = true;
  let delivered = 0;
  const runtime = new CodingRuntime(store, { onOutput: async () => {
    if (offline) throw new Error("offline");
    delivered++;
  } });
  await runtime.deliverClaudeOutbox();
  await store.reload();
  assert.equal(project.claudeOutbox.length, 1);
  assert.equal(project.claudeOutbox[0].delivery.state, "retrying");
  offline = false;
  project.claudeOutbox[0].delivery.nextAttemptAt = new Date(0).toISOString();
  await store.save();
  await runtime.deliverClaudeOutbox();
  await store.reload();
  assert.equal(delivered, 1);
  assert.equal(project.claudeOutbox.length, 0);
  assert.equal(project.telegramRequests.length, 0);
  runtime.stop();
});

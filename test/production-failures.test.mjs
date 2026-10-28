import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { TelegramClient, splitTelegramText } from "../src/telegram.mjs";
import { TelegramService } from "../src/telegram-service.mjs";
import { deliveryFailure, deliveryReady, retryDelivery } from "../src/delivery.mjs";

const reply = (status, payload) => new Response(JSON.stringify(payload), { status });
async function fixture(provider = "claude") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-production-"));
  const store = await new StateStore(root).init();
  store.state.projects.demo = { id: "demo", name: "demo", cwd: root, provider,
    topicId: 9, linkId: "one", status: "idle", sessionIds: {} };
  await store.save();
  return store;
}

test("Telegram honors retry_after and safely retries an explicitly rejected write", async () => {
  let calls = 0;
  const delays = [];
  const client = new TelegramClient("not-a-token", {
    wait: async (ms) => delays.push(ms),
    fetch: async () => ++calls === 1
      ? reply(429, { ok: false, error_code: 429, parameters: { retry_after: 7 } })
      : reply(200, { ok: true, result: { message_id: 1 } }),
  });
  await client.sendMessage("-1001", "hi");
  assert.equal(calls, 2);
  assert.ok(delays.some((ms) => ms > 6000 && ms <= 7000));
});

for (const method of ["sendMessage", "createForumTopic"]) {
  test(`a lost ${method} response is uncertain, never blindly retried or sent through curl`, async () => {
    let calls = 0;
    const client = new TelegramClient("PRIVATE_TOKEN", {
      wait: async () => {},
      fetch: async () => { calls++; throw new Error("PRIVATE_TOKEN lost response"); },
      fallback: async () => assert.fail("An uncertain write must not be repeated"),
    });
    await assert.rejects(client.request(method, {}), (error) =>
      error.telegramAmbiguous === true && !error.message.includes("PRIVATE_TOKEN") && !error.cause);
    assert.equal(calls, 1);
  });
}

test("safe Telegram reads recover through fallback and service shutdown aborts fallback polling", async () => {
  let calls = 0;
  const client = new TelegramClient("unused", {
    wait: async () => {},
    fetch: async () => { calls++; throw new Error("network down"); },
    fallback: async (_url, _body, _timeout, signal) => {
      assert.ok(signal);
      client.stop();
      throw new Error("aborted");
    },
  });
  assert.deepEqual(await client.getUpdates(), []);
  assert.equal(calls, 3);
});

test("a working safe-read fallback becomes the primary transport for subsequent writes", async () => {
  let fetches = 0;
  const fallbackMethods = [];
  const client = new TelegramClient("unused", {
    wait: async () => {},
    fetch: async () => { fetches++; throw new Error("node transport unavailable"); },
    fallback: async (url) => {
      fallbackMethods.push(url.split("/").pop());
      return reply(200, { ok: true, result: { message_id: 1 } });
    },
  });
  await client.getMe();
  await client.sendMessage("-1001", "hi");
  assert.equal(fetches, 3);
  assert.deepEqual(fallbackMethods, ["getMe", "sendMessage"]);
});

test("Telegram access expiry fails visibly instead of polling forever", async () => {
  const client = new TelegramClient("expired");
  client.request = async () => { throw Object.assign(new Error("Unauthorized"), { telegramCode: 401 }); };
  await assert.rejects(client.poll(async () => {}), /access was rejected/);
});

test("partially sent multi-chunk output is held instead of automatically duplicating acknowledged chunks", async () => {
  let calls = 0;
  const client = new TelegramClient("unused", {
    fetch: async () => ++calls === 1
      ? reply(200, { ok: true, result: { message_id: 1 } })
      : reply(403, { ok: false, error_code: 403, description: "Forbidden" }),
  });
  await assert.rejects(client.sendMessage("-1001", "x".repeat(5000)),
    (error) => error.telegramAmbiguous && error.telegramCode === 403);
  assert.equal(calls, 2);
});

test("Telegram chunk boundaries preserve full Unicode code points", () => {
  const text = "x".repeat(3999) + "😀" + "y".repeat(5000);
  const chunks = splitTelegramText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000
    && !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
});

test("delivery backoff survives long time jumps while uncertainty still requires a user decision", () => {
  const record = {};
  deliveryFailure(record, { telegramRetryAfter: 20 }, 1000);
  assert.equal(deliveryReady(record, 1001), false);
  assert.equal(deliveryReady(record, 60 * 60 * 1000), true);
  deliveryFailure(record, { telegramAmbiguous: true }, 1000);
  assert.equal(deliveryReady(record, 24 * 60 * 60 * 1000), false);
  retryDelivery(record);
  assert.equal(deliveryReady(record), true);
});

test("one uncertain Claude delivery does not block other projects and never replays work", async () => {
  const store = await fixture();
  const demo = store.state.projects.demo;
  demo.claudeOutbox = [{ id: "held", text: "saved result" }];
  store.state.projects.other = { ...demo, id: "other", topicId: 10,
    claudeOutbox: [{ id: "good", text: "other result" }] };
  await store.save();
  const sent = [];
  const runtime = new CodingRuntime(store, { onOutput: async (project) => {
    sent.push(project.id);
    if (project.id === "demo") throw Object.assign(new Error("uncertain"), { telegramAmbiguous: true });
  } });
  runtime.run = async () => assert.fail("Delivery retries must never rerun coding work");
  await runtime.deliverClaudeOutbox();
  await runtime.deliverClaudeOutbox();
  await store.reload();
  assert.deepEqual(sent, ["demo", "other"]);
  assert.equal(demo.claudeOutbox[0].delivery.state, "uncertain");
  assert.deepEqual(store.state.projects.other.claudeOutbox, []);
  runtime.stop();
});

test("Codex results remain durable across uncertain delivery and resume without rereading or rerunning", async () => {
  const store = await fixture("codex");
  const project = store.state.projects.demo;
  project.telegramRequests = [{ id: "result", status: "delivering", output: "completed", sessionId: "exact-thread" }];
  await store.save();
  let calls = 0;
  const runtime = new CodingRuntime(store, { onOutput: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("lost response"), { telegramAmbiguous: true });
  } });
  await assert.rejects(runtime.deliverCodexResult(project, project.telegramRequests[0]), /lost response/);
  await runtime.deliverCodexResult(project, project.telegramRequests[0]);
  assert.equal(calls, 1);
  retryDelivery(project.telegramRequests[0]);
  await store.save();
  await runtime.deliverCodexResult(project, project.telegramRequests[0]);
  await store.reload();
  assert.equal(calls, 2);
  assert.deepEqual(project.telegramRequests, []);
  assert.equal(project.lastTelegramResult.sessionId, "exact-thread");
  runtime.stop();
});

test("Telegram retry commands are project-scoped and only release delivery, not approval or execution", async () => {
  const store = await fixture();
  store.state.projects.demo.claudeOutbox = [{ id: "held", text: "result", delivery: { state: "uncertain" } }];
  store.state.approvals.push({ id: "other-approval", projectId: "other", topicId: 10, status: "pending" });
  store.state.projects.other = { id: "other", provider: "claude", status: "idle", topicId: 10 };
  await store.save();
  const sent = [];
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10",
    client: { sendMessage: async (_chat, text) => sent.push(text) } });
  service.runtime.run = async () => assert.fail("Not a coding prompt");
  const message = (text) => service.handle({ message: { text, message_thread_id: 9,
    chat: { id: -1001 }, from: { id: 10 } } });
  await message("/delivery");
  assert.match(sent[0], /held: uncertain/);
  await message("/retry-delivery other-approval");
  assert.match(sent[1], /No held delivery/);
  await message("/retry-delivery held");
  await store.reload();
  assert.equal(store.state.projects.demo.claudeOutbox[0].delivery.state, "retrying");
  assert.equal(store.state.approvals[0].status, "pending");
  service.runtime.stop();
});

test("approval message uncertainty pauses automatic retries but leaves native decisions available", async () => {
  const store = await fixture();
  const approval = { id: "approval-1", projectId: "demo", topicId: 9, provider: "claude",
    source: "claude-stream", type: "command", status: "pending", summary: "harmless",
    details: { command: "printf test" }, expiresAt: new Date(Date.now() + 60000).toISOString() };
  store.state.approvals.push(approval);
  await store.save();
  let calls = 0;
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10",
    client: { sendMessage: async () => {
      calls++; throw Object.assign(new Error("lost response"), { telegramAmbiguous: true });
    } } });
  await assert.rejects(service.sendApproval(store.state.projects.demo, approval), /lost response/);
  await service.syncApprovalMessages();
  await store.reload();
  assert.equal(calls, 1);
  assert.equal(store.state.approvals[0].status, "pending");
  assert.equal(store.state.approvals[0].delivery.state, "uncertain");
  service.runtime.stop();
});

test("corrupt or unsupported state fails closed without overwriting the original", async () => {
  const store = await fixture();
  for (const text of ["{bad json", JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, telegram: {}, projects: [], approvals: [] })]) {
    await writeFile(store.file, text);
    await assert.rejects(new StateStore(store.root).init());
    await assert.rejects(store.save());
    assert.equal(await readFile(store.file, "utf8"), text);
  }
});

test("atomic durable saves leave private state and no plaintext temporary files", async () => {
  const store = await fixture();
  for (let index = 0; index < 5; index++) {
    store.state.telegram.updateOffset = index;
    await store.save();
  }
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(store.root), ["state.json"]);
});

test("same-store reloads cannot erase approvals inserted by an overlapping durable save", async () => {
  const store = await fixture();
  const writer = async () => {
    for (let index = 0; index < 20; index++) {
      store.state.approvals.push({ id: `request-${index}`, projectId: "demo", topicId: 9,
        status: "pending" });
      await store.save();
    }
  };
  const reader = async () => {
    for (let index = 0; index < 40; index++) await store.reload();
  };
  await Promise.all([writer(), reader()]);
  await store.reload();
  assert.equal(store.state.approvals.length, 20);
  assert.equal(new Set(store.state.approvals.map((item) => item.id)).size, 20);
});

test("invalid retention configuration cannot accidentally archive every project", async () => {
  const store = await fixture();
  let closed = 0;
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10",
    client: { closeForumTopic: async () => { closed++; } } });
  for (const days of [0, -1, NaN, Infinity, 1.5, 36501]) {
    await assert.rejects(service.cleanupInactiveProjects(days), /No topics were archived/);
  }
  assert.equal(closed, 0);
  service.runtime.stop();
});

test("retention preserves invalid records, the control topic and a busy native turn", async () => {
  const store = await fixture();
  const old = new Date(0).toISOString();
  store.state.telegram.controlTopicId = 2;
  store.state.projects = {
    invalid: { id: "invalid", topicId: 9, status: "idle", lastActiveAt: "invalid" },
    control: { id: "control", topicId: 2, status: "idle", lastActiveAt: old },
    busy: { id: "busy", topicId: 10, status: "idle", lastActiveAt: old,
      localSession: { turnStatus: "busy" } },
    eligible: { id: "eligible", topicId: 11, status: "idle", lastActiveAt: old },
  };
  await store.save();
  const closed = [];
  const service = new TelegramService(store, { chatId: "-1001", allowedUsers: "10",
    client: { closeForumTopic: async (_chat, topic) => closed.push(topic) } });
  await service.cleanupInactiveProjects();
  assert.deepEqual(closed, [11]);
  await store.reload();
  assert.equal(store.state.projects.eligible.status, "archived");
  assert.equal(store.state.projects.busy.status, "idle");
  service.runtime.stop();
});

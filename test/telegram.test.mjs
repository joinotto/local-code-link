import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodingRuntime } from "../src/runtime.mjs";
import { StateStore } from "../src/state.mjs";
import {
  approvalKeyboard,
  splitTelegramText,
  TelegramClient,
  waitForTelegramConnect,
  validateTelegramGroup,
} from "../src/telegram.mjs";
import { TelegramService } from "../src/telegram-service.mjs";

test("Telegram client validates API responses and sends topic messages", async () => {
  const calls = [];
  const client = new TelegramClient("secret", {
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.sendMessage("-1001", "hello", {
    topicId: 42,
    replyMarkup: approvalKeyboard("approval-id"),
  });
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, "approval:approval-id:approve");
});

test("Telegram text is split below the platform limit", () => {
  const chunks = splitTelegramText("x".repeat(9000));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4000, 4000, 1000]);
});

test("Telegram setup discovers the forum and user from a fresh /connect command", async () => {
  const challenge = "a".repeat(32);
  const batches = [
    [{ update_id: 4, message: { text: "/old" } }],
    [{
      update_id: 5,
      message: {
        text: `/connect ${challenge}`,
        chat: { id: -100123, type: "supergroup", is_forum: true, title: "Coding" },
        from: { id: 42, username: "owner" },
      },
    }],
  ];
  const client = {
    getWebhookInfo: async () => ({ url: "" }),
    deleteWebhook: async () => true,
    getUpdates: async () => batches.shift() || [],
    getChat: async () => ({ id: -100123, type: "supergroup", is_forum: true, title: "Coding" }),
    getChatMember: async () => ({
      status: "administrator",
      can_manage_topics: true,
      can_delete_messages: true,
    }),
  };
  const pairing = await waitForTelegramConnect(client, { id: 99 }, { timeoutMs: 1000, challenge });
  assert.deepEqual(pairing, {
    chatId: "-100123",
    chatTitle: "Coding",
    userId: "42",
    userName: "owner",
    updateOffset: 6,
  });
});

test("first setup ignores wrong nonces and accepts the owner's fast valid response", async () => {
  const challenge = "b".repeat(32);
  const message = { chat: { id: -1001 }, from: { id: 1 } };
  let polls = 0;
  const client = {
    getWebhookInfo: async () => ({ url: "" }),
    deleteWebhook: async () => true,
    getUpdates: async () => {
      polls++;
      return [{ update_id: 1, message: { ...message, text: `/connect ${"c".repeat(32)}` } },
        { update_id: 2, message: { ...message, text: `/connect ${challenge}` } }];
    },
    getChat: async () => ({ id: -1001, type: "supergroup", is_forum: true }),
    getChatMember: async (_chat, id) => id === 99
      ? { status: "administrator", can_manage_topics: true, can_delete_messages: true }
      : { status: "creator" },
  };
  const pairing = await waitForTelegramConnect(client, { id: 99 }, { challenge });
  assert.equal(pairing.userId, "1");
  assert.equal(pairing.updateOffset, 3);
  assert.equal(polls, 1);
  await assert.rejects(waitForTelegramConnect(client, { id: 99 }), /fresh pairing challenge/);
});

test("onboarding rejects public groups and missing topic-deletion permissions", async () => {
  const client = { getChat: async () => ({ id: -1001, type: "supergroup", is_forum: true, username: "public" }),
    getChatMember: async () => ({ status: "administrator", can_manage_topics: true }) };
  await assert.rejects(validateTelegramGroup(client, { id: 99 }, -1001), /private/);
  client.getChat = async () => ({ id: -1001, type: "supergroup", is_forum: true, active_usernames: ["public"] });
  await assert.rejects(validateTelegramGroup(client, { id: 99 }, -1001), /private/);
  client.getChat = async () => ({ id: -1001, type: "supergroup", is_forum: true });
  await assert.rejects(validateTelegramGroup(client, { id: 99 }, -1001), /Delete Messages/);
});

test("setup never displaces another app's existing webhook", async () => {
  let deleted = false;
  const client = { getWebhookInfo: async () => ({ url: "https://private.example/hidden" }),
    deleteWebhook: async () => { deleted = true; } };
  await assert.rejects(waitForTelegramConnect(client, { id: 99 }, { challenge: "a".repeat(32) }),
    (error) => /existing webhook/.test(error.message) && !error.message.includes("private.example"));
  assert.equal(deleted, false);
});

test("approval decisions are project scoped and single use", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-state-"));
  const projectDir = path.join(root, "project");
  await mkdir(projectDir);
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.projects.demo = {
    id: "demo",
    name: "demo",
    cwd: projectDir,
    provider: "claude",
    topicId: 9,
    status: "idle",
  };
  await store.save();
  const runtime = new CodingRuntime(store, { onApproval: async () => {} });
  const approval = await runtime.createApproval(store.state.projects.demo, {
    provider: "claude",
    type: "command",
    summary: "npm test",
    details: { command: "npm test" },
  });
  const decided = await runtime.decideApproval(approval.id, "approve", "123");
  assert.equal(decided.status, "approved");
  await assert.rejects(() => runtime.decideApproval(approval.id, "deny", "123"), /no longer pending/);
});

test("Telegram service rejects users outside both chat and user allowlists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-auth-"));
  const store = await new StateStore(path.join(root, "state")).init();
  const fakeClient = {
    sendMessage: async () => {},
    getMe: async () => ({}),
    poll: async () => {},
  };
  const service = new TelegramService(store, {
    token: "unused",
    chatId: "-1001",
    allowedUsers: "10,20",
    client: fakeClient,
  });
  assert.equal(service.authorize(10, -1001), true);
  assert.equal(service.authorize(30, -1001), false);
  assert.equal(service.authorize(10, -1002), false);
});

test("Telegram service reloads project mappings created after the daemon started", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-reload-"));
  const stateRoot = path.join(root, "state");
  const daemonStore = await new StateStore(stateRoot).init();
  const writerStore = await new StateStore(stateRoot).init();
  const sent = [];
  const fakeClient = {
    sendMessage: async (...args) => sent.push(args),
    getMe: async () => ({}),
    poll: async () => {},
  };
  const service = new TelegramService(daemonStore, {
    token: "unused",
    chatId: "-1001",
    allowedUsers: "10",
    client: fakeClient,
  });
  writerStore.state.projects.demo = {
    id: "demo",
    name: "demo",
    cwd: root,
    provider: "codex",
    topicId: 77,
    status: "idle",
  };
  await writerStore.save();
  let started = false;
  service.runtime.queueToLocalSession = async () => false;
  service.runtime.run = async () => { started = true; };

  await service.handle({
    message: {
      text: "hello",
      message_thread_id: 77,
      chat: { id: -1001 },
      from: { id: 10 },
    },
  });

  assert.equal(started, true);
  assert.match(sent[0][1], /Sending to codex/);
});

test("Codex denial uses one of the server's available decisions", async () => {
  const { CodexAppServerClient } = await import("../src/codex-app-server.mjs");
  const client = new CodexAppServerClient({
    command: "unused",
    cwd: process.cwd(),
    onApproval: async () => "deny",
  });
  let response;
  client.write = (message) => { response = message; };
  await client.handle({
    id: 12,
    method: "item/commandExecution/requestApproval",
    params: { availableDecisions: ["accept", "cancel"] },
  });
  assert.deepEqual(response, { id: 12, result: { decision: "cancel" } });
});

test("Codex transcript watcher returns only the queued Telegram turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-transcript-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.projects.demo = {
    id: "demo",
    name: "demo",
    cwd: root,
    provider: "codex",
    topicId: 9,
    telegramRequests: [{ id: "request-1", status: "queued" }],
  };
  await store.save();
  const transcript = path.join(root, "session.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "response_item", payload: { text: "local-only response" } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed", turn_id: "telegram-turn",
        item: { type: "UserMessage", content: [{ text: "[LocalCodeLink Telegram request request-1]" }] },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "local-turn", last_agent_message: "Local response" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "telegram-turn", last_agent_message: "Telegram response" },
    }),
    "",
  ].join("\n"));
  const outputs = [];
  const runtime = new CodingRuntime(store, {
    onOutput: async (_project, output) => outputs.push(output),
  });
  await runtime.watchCodexTranscript("demo", "request-1", transcript, 0);
  assert.deepEqual(outputs, ["Telegram response"]);
  assert.deepEqual(store.state.projects.demo.telegramRequests, []);
});

test("unlink revokes prompts and pending approvals without stopping a local-only session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-unlink-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.projects.demo = {
    id: "demo", name: "demo", cwd: root, provider: "codex", topicId: 9,
    status: "idle", sessionIds: { codex: "saved-session" },
    localSession: { status: "active", pid: 1234 },
  };
  await store.save();
  const deleted = [];
  const runtime = new CodingRuntime(store, {
    onApproval: async () => {},
    onDeleteTopic: async (project) => deleted.push(project.topicId),
  });
  const approval = await runtime.createApproval(store.state.projects.demo, {
    provider: "codex-local", type: "command", summary: "test",
  });
  const local = store.state.projects.demo.localSession;
  const result = await runtime.unlink("demo", { confirmed: true });
  assert.deepEqual(result.warnings, []);
  assert.equal(runtime.projectByTopic(9), undefined);
  assert.deepEqual(runtime.listProjects(), []);
  assert.equal(local.status, "active");
  assert.equal(store.state.projects.demo, undefined);
  assert.deepEqual(deleted, [9]);
  assert.equal(store.state.approvals.find((item) => item.id === approval.id), undefined);
  await assert.rejects(() => runtime.run("demo", "hello"), /not linked/i);
  await assert.rejects(() => runtime.decideApproval(approval.id, "approve", "10"), /no longer pending/);
  runtime.stop();
});

test("Telegram unlink confirmation is scoped, expiring, and single-use", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-unlink-confirm-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.projects.demo = {
    id: "demo", name: "demo", cwd: root, provider: "claude", topicId: 9, status: "idle",
  };
  await store.save();
  const sent = [];
  const answered = [];
  const deleted = [];
  const service = new TelegramService(store, {
    chatId: "-1001", allowedUsers: "10",
    client: {
      sendMessage: async (...args) => sent.push(args),
      answerCallbackQuery: async (...args) => answered.push(args),
      deleteForumTopic: async (...args) => deleted.push(args),
    },
  });
  await service.handle({ message: {
    text: "/unlink", message_thread_id: 9, chat: { id: -1001 }, from: { id: 10 },
  } });
  assert.equal(store.state.projects.demo.status, "idle");
  const callback = {
    id: "callback", from: { id: 10 },
    message: { chat: { id: -1001 }, message_thread_id: 9 },
    data: sent[0][2].replyMarkup.inline_keyboard[0][0].callback_data,
  };
  await service.handle({ callback_query: {
    ...callback, message: { chat: { id: -1001 }, message_thread_id: 99 },
  } });
  assert.equal(store.state.projects.demo.status, "idle");
  await service.handle({ callback_query: callback });
  assert.equal(store.state.projects.demo, undefined);
  assert.deepEqual(deleted, [["-1001", 9]]);
  assert.notEqual(sent.at(-1)[2].topicId, 9);
  await service.handle({ callback_query: callback });
  assert.match(answered.at(-1)[1], /expired/);
  service.runtime.stop();
});

test("task completion after an external unlink does not re-enable or send output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-unlink-completion-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.projects.demo = {
    id: "demo", name: "demo", cwd: root, provider: "claude", topicId: 9, status: "idle",
  };
  await store.save();
  let finish;
  let started;
  const beginning = new Promise((resolve) => { started = resolve; });
  const outputs = [];
  const runtime = new CodingRuntime(store, { onOutput: async (...args) => outputs.push(args) });
  runtime.runClaude = async () => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  };
  const task = runtime.run("demo", "hello");
  await beginning;
  const otherStore = await new StateStore(store.root).init();
  const unlinker = new CodingRuntime(otherStore, { onDeleteTopic: async () => true });
  await unlinker.unlink("demo", { confirmed: true });
  finish({ sessionId: "saved-session", text: "Must not be delivered" });
  await task;
  await store.reload();
  assert.equal(store.state.projects.demo, undefined);
  assert.deepEqual(outputs, []);
  runtime.stop();
  unlinker.stop();
});

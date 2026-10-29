import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { TelegramService } from "../src/telegram-service.mjs";

const eventually = async (condition) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition was not reached");
};

async function fixture(initialStatus = "idle") {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-shared-"));
  const transcript = path.join(root, "session.jsonl");
  await writeFile(transcript, "");
  const store = await new StateStore(path.join(root, "state")).init();
  const project = {
    id: "demo", name: "demo", cwd: root, provider: "codex",
    topicId: 9, status: "idle", sessionIds: { codex: "thread-1" },
  };
  store.state.projects.demo = project;
  await store.save();
  let status = initialStatus;
  const queue = [];
  const calls = [];
  const shared = {
    connect: async () => {},
    close: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return {
        thread: { id: "thread-1", cwd: root, path: transcript, status: { type: status } },
      };
      if (method === "thread/resume") {
        if (status === "notLoaded") status = "idle";
        return {};
      }
      if (method === "thread/queue/add") {
        const queuedSubmission = { id: `queued-${queue.length}`, input: params.input,
          clientUserMessageId: params.clientUserMessageId };
        queue.push(queuedSubmission);
        return { queuedSubmission };
      }
      if (method === "thread/queue/list") return { data: [...queue], nextCursor: null };
      if (method === "thread/queue/start") {
        assert.equal(status, "idle");
        assert.equal(params.queuedSubmissionId, queue[0].id);
        queue.shift();
        status = "active";
        return { turn: { id: "turn-1" } };
      }
      if (method === "thread/queue/delete") {
        const index = queue.findIndex((item) => item.id === params.queuedSubmissionId);
        queue.splice(index, 1);
        return {};
      }
      if (method === "thread/turns/list") return { data: [] };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const outputs = [];
  const runtime = new CodingRuntime(store, {
    codexShared: shared, pollMs: 10,
    onOutput: async (_project, text) => outputs.push(text),
    onDeleteTopic: async () => true,
  });
  return { root, transcript, store, project, shared, runtime, calls, outputs, queue,
    setStatus: (value) => { status = value; } };
}

test("idle Codex session starts Telegram's queued message without a second process", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.runtime.queueToLocalSession(f.project, "Hi"), true);
    await eventually(() => f.calls.some((call) => call.method === "thread/queue/start"));
    const request = f.project.telegramRequests[0];
    assert.equal(f.runtime.running.size, 0);
    await appendFile(f.transcript, [
      JSON.stringify({ type: "event_msg", payload: {
        type: "item_completed", turn_id: "turn-1",
        item: { type: "UserMessage", content: [{ text: `[LocalCodeLink Telegram request ${request.id}]\nHi` }] },
      } }),
      JSON.stringify({ type: "event_msg", payload: {
        type: "task_complete", turn_id: "turn-1", last_agent_message: "Hi from the same session",
      } }), "",
    ].join("\n"));
    await eventually(() => f.outputs.length === 1);
    assert.deepEqual(f.outputs, ["Hi from the same session"]);
  } finally { f.runtime.stop(); }
});

test("native automatic queue delivery returns the correlated result without duplicate turn dispatch", async () => {
  const f = await fixture();
  try {
    const previous = f.shared.request;
    f.shared.request = async (method, params) => {
      const result = await previous(method, params);
      if (method === "thread/queue/add") {
        f.queue.shift();
        await appendFile(f.transcript, [
          JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: "auto-turn",
            item: { type: "UserMessage", content: params.input } } }),
          JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "auto-turn",
            last_agent_message: "Automatic native result" } }), "",
        ].join("\n"));
      }
      return result;
    };
    await f.runtime.queueToLocalSession(f.project, "Hi");
    await eventually(() => f.outputs.length === 1);
    assert.deepEqual(f.outputs, ["Automatic native result"]);
    assert.equal(f.calls.some((call) => call.method === "thread/queue/start"), false);
    assert.equal(f.calls.filter((call) => call.method === "thread/queue/add").length, 1);
    assert.equal(f.runtime.running.size, 0);
  } finally { f.runtime.stop(); }
});

test("a fresh Codex project starts in the shared daemon and keeps its exact project directory", async () => {
  const f = await fixture();
  try {
    f.project.sessionIds = {};
    await f.store.save();
    const previous = f.shared.request;
    f.shared.request = async (method, params) => {
      if (method === "thread/start") {
        f.calls.push({ method, params });
        return { thread: { id: "thread-1", cwd: f.root } };
      }
      return previous(method, params);
    };
    assert.equal(await f.runtime.queueToLocalSession(f.project, "fresh"), true);
    await eventually(() => f.calls.some((call) => call.method === "thread/queue/start"));
    assert.equal(f.project.sessionIds.codex, "thread-1");
    assert.equal(f.calls.find((call) => call.method === "thread/start").params.cwd, f.root);
    assert.equal(f.calls.find((call) => call.method === "thread/start").params.historyMode, "legacy");
    assert.equal(f.runtime.running.size, 0);
  } finally { f.runtime.stop(); }
});

test("a saved Codex turn waiting for input explains blocked Telegram work without interrupting it", async () => {
  const f = await fixture("active");
  const previous = f.shared.request;
  f.shared.request = async (method, params) => {
    const result = await previous(method, params);
    if (method === "thread/read") result.thread.status.activeFlags = ["waitingOnUserInput"];
    return result;
  };
  try {
    assert.equal(await f.runtime.startQueuedRequest(f.project), false);
    await f.store.reload();
    assert.match(f.project.lastQueueError, /waiting for input/);
    assert.match(f.project.lastQueueError, /interrupt/);
    assert.ok(!f.calls.some((call) => ["turn/interrupt", "thread/queue/start"].includes(call.method)));
    assert.equal(f.runtime.running.size, 0);
  } finally { f.runtime.stop(); }
});

test("daemon-owned Codex questions accept exact answers without an open terminal", async () => {
  const f = await fixture();
  const responses = [];
  f.shared.respond = (id, result) => responses.push({ id, result });
  try {
    await f.runtime.handleSharedCodexMessage({ id: "question-1", method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
        questions: [{ id: "framework", header: "Framework", question: "Choose a framework",
          options: [{ label: "React", description: "Use React" }], isOther: false }] } });
    await f.store.reload();
    const approval = f.store.state.approvals[0];
    await f.runtime.answerQuestion(approval.id, "React", { id: 10 }, 9);
    assert.deepEqual(responses, [{ id: "question-1", result: { answers: { framework: { answers: ["React"] } } } }]);
    await f.runtime.handleSharedCodexMessage({ method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "question-1" } });
    await f.store.reload();
    assert.equal(f.store.state.approvals[0].status, "approved");
  } finally { f.runtime.stop(); }
});

test("busy Codex session queues and starts only after it becomes idle", async () => {
  const f = await fixture("active");
  try {
    await f.runtime.queueToLocalSession(f.project, "Next task");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.calls.some((call) => call.method === "thread/queue/start"), false);
    f.setStatus("idle");
    await eventually(() => f.calls.some((call) => call.method === "thread/queue/start"));
  } finally { f.runtime.stop(); }
});

test("stopped Codex session resumes in the shared daemon, not a competing writer", async () => {
  const f = await fixture("notLoaded");
  try {
    await f.runtime.queueToLocalSession(f.project, "Resume");
    await eventually(() => f.calls.some((call) => call.method === "thread/queue/start"));
    assert.deepEqual(f.calls.find((call) => call.method === "thread/resume").params,
      { threadId: "thread-1", excludeTurns: true });
  } finally { f.runtime.stop(); }
});

test("wrong-folder session mapping is rejected before submitting the prompt", async () => {
  const f = await fixture();
  const original = f.shared.request;
  f.shared.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/read") result.thread.cwd = path.dirname(f.root);
    return result;
  };
  try {
    await assert.rejects(() => f.runtime.queueToLocalSession(f.project, "Wrong project"), /another folder/);
    assert.equal(f.calls.some((call) => call.method === "thread/queue/add"), false);
  } finally { f.runtime.stop(); }
});

test("shared connection failure reports an error instead of starting another Codex writer", async () => {
  const f = await fixture();
  const sent = [];
  const service = new TelegramService(f.store, {
    chatId: "-1001", allowedUsers: "10",
    client: { sendMessage: async (...args) => sent.push(args) },
  });
  service.runtime.stop();
  service.runtime = f.runtime;
  f.shared.connect = async () => { throw new Error("Shared server offline"); };
  let fallbackStarted = false;
  f.runtime.run = async () => { fallbackStarted = true; };
  try {
    await service.handle({ message: {
      text: "Hi", message_thread_id: 9, chat: { id: -1001 }, from: { id: 10 },
    } });
    assert.equal(fallbackStarted, false);
    assert.match(sent[0][1], /Shared server offline/);
  } finally { f.runtime.stop(); }
});

test("unlink deletes bridge records and only this project's Telegram queue", async () => {
  const f = await fixture("active");
  try {
    await f.runtime.queueToLocalSession(f.project, "Do not run after unlink");
    f.queue.push({ id: "local-queued", input: [{ text: "Locally queued instruction" }] });
    f.project.localSession = { status: "active", pid: 1234 };
    await f.store.save();
    const { warnings } = await f.runtime.unlink("demo", { confirmed: true });
    assert.deepEqual(warnings, []);
    assert.deepEqual(f.queue.map((item) => item.id), ["local-queued"]);
    assert.equal(f.project.status, "unlinked");
    assert.equal(f.project.localSession.status, "active");
    assert.equal(f.store.state.projects.demo, undefined);
  } finally { f.runtime.stop(); }
});

test("service restart recovers queued request without resubmitting it", async () => {
  const f = await fixture();
  try {
    const id = "recovered-request";
    f.queue.push({ id: "recovered-queued", input: [
      { type: "text", text: `[LocalCodeLink Telegram request ${id}]\nHi` },
    ] });
    f.project.telegramRequests = [{ id, transcriptPath: f.transcript, transcriptOffset: 0,
      queuedSubmissionId: "recovered-queued", status: "queued" }];
    await f.store.save();
    await f.runtime.recoverCodexRequests();
    await eventually(() => f.calls.some((call) => call.method === "thread/queue/start"));
    assert.equal(f.calls.some((call) => call.method === "thread/queue/add"), false);
  } finally { f.runtime.stop(); }
});

test("an existing ephemeral thread is rejected before subscribing or recording a prompt", async () => {
  const f = await fixture();
  try {
    const previous = f.shared.request;
    f.shared.request = async (method, params) => {
      const result = await previous(method, params);
      if (method === "thread/read") {
        result.thread.ephemeral = true;
        result.thread.path = null;
      }
      return result;
    };
    await assert.rejects(f.runtime.queueToLocalSession(f.project, "do not submit", { updateId: 7 }),
      /memory-only.*\/new/);
    await f.store.reload();
    assert.equal(f.project.sessionIds.codex, "thread-1");
    assert.equal(f.project.telegramRequests?.length || 0, 0);
    assert.equal(f.project.telegramUpdateIds?.includes(7) || false, false);
    assert.deepEqual(f.calls.map((call) => call.method), ["thread/read"]);
  } finally { f.runtime.stop(); }
});

test("an existing paginated thread is preserved and receives no unsupported Telegram submission", async () => {
  const f = await fixture();
  try {
    const previous = f.shared.request;
    f.shared.request = async (method, params) => {
      const result = await previous(method, params);
      if (method === "thread/read") result.thread.historyMode = "paginated";
      return result;
    };
    await assert.rejects(f.runtime.queueToLocalSession(f.project, "test"), /paginated history/);
    assert.equal(f.project.sessionIds.codex, "thread-1");
    assert.equal(f.project.telegramRequests?.length || 0, 0);
    assert.deepEqual(f.calls.map((call) => call.method), ["thread/read"]);
  } finally { f.runtime.stop(); }
});
for (const rejected of [true, false]) {
  test(`queue submission ${rejected ? "rejection is removed" : "timeout stays uncertain"} without replay`, async () => {
    const f = await fixture();
    try {
      const previous = f.shared.request;
      f.shared.request = async (method, params) => {
        if (method === "thread/queue/add") {
          f.calls.push({ method, params });
          const error = new Error(rejected ? "Codex rejected input" : "Codex thread/queue/add timed out");
          if (rejected) error.codexRejected = true;
          throw error;
        }
        return previous(method, params);
      };
      await assert.rejects(f.runtime.queueToLocalSession(f.project, "test", { updateId: 8 }), /Codex/);
      if (!rejected) await eventually(() => f.calls.some((call) => call.method === "thread/queue/list"));
      await f.store.reload();
      assert.equal(f.project.telegramRequests.length, rejected ? 0 : 1);
      if (!rejected) assert.equal(f.project.telegramRequests[0].status, "submission_uncertain");
      assert.equal(f.calls.filter((call) => call.method === "thread/queue/add").length, 1);
      assert.equal(f.calls.some((call) => call.method === "thread/queue/start"), false);
      assert.equal(f.project.telegramUpdateIds.includes(8), true);
      assert.equal(f.runtime.running.size, 0);
      if (rejected) {
        assert.equal(f.runtime.transcriptWatchers.size, 0);
        assert.equal(f.runtime.codexPumps.size, 0);
        assert.match(f.project.lastQueueError, /rejected/);
      }
    } finally { f.runtime.stop(); }
  });
}

test("restart clears only legacy definite ephemeral queue rejections and never replays them", async () => {
  const f = await fixture("active");
  try {
    const lastError = "ephemeral thread does not support queued submissions: thread-1";
    f.project.telegramRequests = [
      { id: "rejected", status: "submission_uncertain", lastError },
      { id: "uncertain", status: "submission_uncertain", lastError: "Connection closed" },
      { id: "accepted", status: "submission_uncertain", lastError, queuedSubmissionId: "queued-1" },
    ];
    await f.store.save();
    await f.runtime.recoverCodexRequests();
    await f.store.reload();
    assert.deepEqual(f.project.telegramRequests.map((request) => request.id), ["uncertain", "accepted"]);
    assert.equal(f.project.sessionIds.codex, "thread-1");
    assert.equal(f.calls.some((call) => call.method === "thread/queue/add"), false);
  } finally { f.runtime.stop(); }
});

test("Telegram can decide a daemon-owned approval with no open terminal", async () => {
  const f = await fixture();
  const responses = [];
  f.shared.respond = (id, result) => responses.push({ id, result });
  try {
    await f.runtime.handleSharedCodexMessage({
      id: "approval-request", method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
        command: "printf test", availableDecisions: ["accept", "cancel"],
      },
    });
    const approval = f.store.state.approvals[0];
    await f.runtime.decideApproval(approval.id, "approve", "10", 9);
    assert.deepEqual(responses, [{ id: "approval-request", result: { decision: "accept" } }]);
    await f.runtime.handleSharedCodexMessage({
      method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "approval-request" },
    });
    await f.store.reload();
    assert.equal(f.store.state.approvals[0].status, "approved");
  } finally { f.runtime.stop(); }
});

test("an active native relay owns approval tracking instead of duplicate daemon messages", async () => {
  const f = await fixture();
  try {
    f.project.localSession = { approvalProxyPid: process.pid };
    await f.store.save();
    await f.runtime.handleSharedCodexMessage({
      id: "approval-request", method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    });
    assert.deepEqual(f.store.state.approvals, []);
  } finally { f.runtime.stop(); }
});

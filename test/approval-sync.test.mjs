import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, WebSocket } from "undici";
import { WebSocketServer } from "ws";
import { StateStore } from "../src/state.mjs";
import { CodexTuiProxy } from "../src/codex-tui-proxy.mjs";
import { TelegramService } from "../src/telegram-service.mjs";
import {
  claimCodexApproval, codexDecisionResult, decisionFromCodexResult,
  codexQuestionResult,
  approvalAction, localApprovalActor,
} from "../src/approval-sync.mjs";

const eventually = async (condition) => {
  for (let index = 0; index < 200; index++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected condition not reached");
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-approval-"));
  const store = await new StateStore(path.join(root, "state")).init();
  store.state.telegram = { chatId: "-1001", controlTopicId: 4 };
  const project = {
    id: "demo", linkId: "link-1", topicId: 9, name: "demo", cwd: root,
    provider: "codex", status: "idle", sessionIds: { codex: "thread-1" },
  };
  store.state.projects.demo = project;
  await store.save();
  const backend = createServer();
  const wss = new WebSocketServer({ server: backend });
  const backendPath = path.join(root, "backend.sock");
  await new Promise((resolve) => backend.listen(backendPath, resolve));
  const providerReplies = [];
  const providerRequests = [];
  let provider;
  wss.on("connection", (socket) => {
    provider = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.method) {
        providerRequests.push(message);
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
        if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
          socket.send(JSON.stringify({ id: message.id, result: { thread: {
            id: message.method === "thread/start" ? "thread-new" : message.params.threadId,
            cwd: message.params.cwd,
          } } }));
        }
      }
      if (message.id !== undefined && !message.method) {
        providerReplies.push(message);
        socket.send(JSON.stringify({ method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: message.id } }));
      }
    });
  });
  let threadCwd = root;
  const proxy = new CodexTuiProxy(store, project, {
    socketPath: path.join(root, "proxy.sock"), upstreamPath: backendPath, pollMs: 10,
    metadata: {
      connect: async () => {},
      request: async () => ({ thread: { id: "thread-1", cwd: threadCwd } }),
      close: () => {},
    },
  });
  await proxy.start();
  const agent = new Agent({ connect: { socketPath: proxy.socketPath } });
  const frontend = new WebSocket("ws://localhost/", { dispatcher: agent });
  const nativeMessages = [];
  frontend.addEventListener("message", (event) => nativeMessages.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    frontend.addEventListener("open", resolve, { once: true });
    frontend.addEventListener("error", reject, { once: true });
  });
  await eventually(() => provider);
  const sent = [];
  const edits = [];
  const answers = [];
  const service = new TelegramService(store, {
    chatId: "-1001", allowedUsers: "10",
    client: {
      sendMessage: async (...args) => { sent.push(args); return { message_id: 99 }; },
      editMessageText: async (...args) => edits.push(args),
      answerCallbackQuery: async (...args) => answers.push(args),
      deleteForumTopic: async () => true,
    },
  });
  const approvalMessage = {
    id: "provider-request-1", method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
      command: "printf test", availableDecisions: ["accept", "cancel"],
    },
  };
  const request = async () => {
    provider.send(JSON.stringify(approvalMessage));
    await eventually(() => nativeMessages.some((message) => message.method === approvalMessage.method));
    await eventually(async () => {
      await store.reload();
      return store.state.approvals.length === 1;
    });
    return store.state.approvals[0];
  };
  const sync = async () => {
    await service.syncApprovalMessages();
    await eventually(() => !service.notifyingApprovals.size && !service.editingApprovals.size);
  };
  const callback = (approval, decision) => ({
    id: "callback-1", from: { id: 10, username: "test_user" },
    message: { chat: { id: -1001 }, message_thread_id: 9 },
    data: `approval:${approval.id}:${decision}`,
  });
  const stop = async () => {
    service.runtime.stop();
    frontend.close();
    await agent.destroy();
    await proxy.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  };
  return { root, store, project, providerReplies, providerRequests, nativeMessages, frontend,
    service, approvalMessage, sent, edits, answers, request, sync, callback, stop,
    setThreadCwd: (cwd) => { threadCwd = cwd; }, provider: () => provider };
}

for (const origin of ["cli", "telegram"]) {
  test(`Codex structured question answered through ${origin} resolves once and cleans the other interface`, async () => {
    const f = await fixture();
    try {
      f.approvalMessage.method = "item/tool/requestUserInput";
      f.approvalMessage.params.questions = [{ id: "framework", header: "Framework",
        question: "Choose a framework", isOther: true,
        options: [{ label: "React", description: "Use React" }, { label: "Vue", description: "Use Vue" }] }];
      const question = await f.request();
      await f.sync();
      const result = { answers: { framework: { answers: ["React"] } } };
      if (origin === "cli") f.frontend.send(JSON.stringify({ id: f.approvalMessage.id, result }));
      else await f.service.handleCallback({
        ...f.callback(question, "approve"), data: `question:${question.id}:0`,
      });
      await eventually(() => f.providerReplies.length === 1);
      assert.deepEqual(f.providerReplies[0].result, result);
      await eventually(async () => { await f.store.reload(); return f.store.state.approvals[0].status === "approved"; });
      await f.sync();
      assert.deepEqual(f.edits.at(-1)[3].inline_keyboard, []);
      assert.equal(f.store.state.approvals[0].decidedVia, origin);
      await assert.rejects(f.service.runtime.answerQuestion(question.id, "Vue", { id: 10 }, 9), /no longer pending/);
    } finally { await f.stop(); }
  });
}

test("Codex multiple questions preserve IDs and reject incomplete or invalid answers", () => {
  const approval = { details: { questions: [
    { id: "framework", options: [{ label: "React" }], isOther: false },
    { id: "description", options: null },
  ] } };
  assert.deepEqual(codexQuestionResult(approval, '{"framework":"React","description":"custom"}'),
    { answers: { framework: { answers: ["React"] }, description: { answers: ["custom"] } } });
  assert.throws(() => codexQuestionResult(approval, '{"framework":"Vue","description":"custom"}'), /listed options/);
  assert.throws(() => codexQuestionResult(approval, '{"framework":"React"}'), /required/);
  approval.details.questions[0].isSecret = true;
  assert.throws(() => codexQuestionResult(approval, "{}"), /Sensitive questions/);
  assert.equal(decisionFromCodexResult({ answers: {} }), "deny");
  assert.equal(decisionFromCodexResult({ answers: { framework: { answers: [] } } }), "deny");
});

test("secret Codex questions stay in the terminal and do not persist answers", async () => {
  const f = await fixture();
  try {
    f.approvalMessage.method = "item/tool/requestUserInput";
    f.approvalMessage.params.questions = [{ id: "secret", question: "Password", isSecret: true }];
    const question = await f.request();
    assert.equal(question.canReply, false);
    assert.deepEqual(question.details, {});
    f.frontend.send(JSON.stringify({ id: f.approvalMessage.id,
      result: { answers: { secret: { answers: ["private-value"] } } } }));
    await eventually(() => f.providerReplies.length === 1);
    await eventually(async () => { await f.store.reload(); return f.store.state.approvals[0].status === "resolved"; });
    assert.ok(!JSON.stringify(f.store.state).includes("private-value"));
  } finally { await f.stop(); }
});

test("file-change approval includes the original proposal before Telegram can grant it", async () => {
  const f = await fixture();
  try {
    f.approvalMessage.method = "item/fileChange/requestApproval";
    const changes = [{ path: path.join(f.root, "test.txt"), diff: "+test", kind: { type: "add" } }];
    f.provider().send(JSON.stringify({ method: "item/started", params: {
      threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "fileChange", changes },
    } }));
    const approval = await f.request();
    assert.deepEqual(approval.details.proposedChanges, changes);
    assert.notEqual(approval.canReply, false);
    assert.match(approvalAction(approval), /\+test/);
    await f.service.handleCallback(f.callback(approval, "approve"));
    await eventually(() => f.providerReplies.length === 1);
    assert.equal(f.providerReplies[0].result.decision, "accept");
  } finally { await f.stop(); }
});

test("missing file-change preview stays native-only and network approvals identify the destination", async () => {
  const f = await fixture();
  try {
    f.approvalMessage.method = "item/fileChange/requestApproval";
    const approval = await f.request();
    assert.equal(approval.canReply, false);
    await assert.rejects(f.service.runtime.decideApproval(approval.id, "approve", 10, 9), /Full request details/);
    assert.match(approvalAction({ details: { command: "opaque",
      networkApprovalContext: { host: "example.test", protocol: "https", port: 443 } } }),
    /https:\/\/example.test:443/);
  } finally { await f.stop(); }
});

test("native thread/start is pinned to the current project even if the remote client omits cwd", async () => {
  const f = await fixture();
  try {
    f.frontend.send(JSON.stringify({ id: 101, method: "thread/start", params: {} }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 101 && message.result));
    assert.equal(f.providerRequests.find((message) => message.id === 101).params.cwd, f.root);
    assert.equal(f.providerRequests.find((message) => message.id === 101).params.ephemeral, false);
    assert.equal(f.providerRequests.find((message) => message.id === 101).params.historyMode, "legacy");
    await eventually(async () => {
      await f.store.reload();
      return f.store.state.projects.demo.sessionIds.codex === "thread-new";
    });
  } finally { await f.stop(); }
});

test("native relay negotiates the explicit history format without replacing client identity or other capabilities", async () => {
  const f = await fixture();
  try {
    f.frontend.send(JSON.stringify({ id: 100, method: "initialize", params: {
      clientInfo: { name: "fixture-native", version: "1" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: ["fixture/event"] },
    } }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 100 && message.result));
    const params = f.providerRequests.find((message) => message.id === 100).params;
    assert.equal(params.clientInfo.name, "fixture-native");
    assert.equal(params.capabilities.experimentalApi, true);
    assert.deepEqual(params.capabilities.optOutNotificationMethods, ["fixture/event"]);
  } finally { await f.stop(); }
});

for (const method of ["thread/start", "thread/fork"]) {
  test(`native ${method} overrides memory-only requests without changing permission settings`, async () => {
    const f = await fixture();
    try {
      f.frontend.send(JSON.stringify({
        id: 106, method, params: { threadId: "thread-1", ephemeral: true,
          approvalPolicy: "untrusted", sandbox: "read-only" },
      }));
      await eventually(() => f.nativeMessages.some((message) => message.id === 106 && message.result));
      const request = f.providerRequests.find((message) => message.id === 106);
      assert.equal(request.params.ephemeral, false);
      assert.equal(request.params.historyMode, method === "thread/start" ? "legacy" : undefined);
      assert.equal(request.params.cwd, f.root);
      assert.equal(request.params.approvalPolicy, "untrusted");
      assert.equal(request.params.sandbox, "read-only");
    } finally { await f.stop(); }
  });
}

test("native resume is allowed only for this project's verified session", async () => {
  const f = await fixture();
  try {
    f.frontend.send(JSON.stringify({
      id: 102, method: "thread/resume", params: { threadId: "thread-1" },
    }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 102 && message.result));
    assert.equal(f.providerRequests.find((message) => message.id === 102).params.cwd, f.root);
    assert.equal("ephemeral" in f.providerRequests.find((message) => message.id === 102).params, false);
  } finally { await f.stop(); }
});

test("native resume of a foreign session is rejected before reaching the provider", async () => {
  const f = await fixture();
  try {
    f.setThreadCwd(path.dirname(f.root));
    f.frontend.send(JSON.stringify({
      id: 103, method: "thread/resume", params: { threadId: "thread-1" },
    }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 103 && message.error));
    assert.match(f.nativeMessages.find((message) => message.id === 103).error.message, /another project's/);
    assert.equal(f.providerRequests.some((message) => message.id === 103), false);
    await f.store.reload();
    assert.equal(f.store.state.projects.demo.sessionIds.codex, "thread-1");
  } finally { await f.stop(); }
});

test("native thread/start cannot switch the scoped project to another cwd", async () => {
  const f = await fixture();
  try {
    f.frontend.send(JSON.stringify({
      id: 104, method: "thread/start", params: { cwd: path.dirname(f.root) },
    }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 104 && message.error));
    assert.equal(f.providerRequests.some((message) => message.id === 104), false);
  } finally { await f.stop(); }
});

test("native fork cannot import another project's session history", async () => {
  const f = await fixture();
  try {
    f.setThreadCwd(path.dirname(f.root));
    f.frontend.send(JSON.stringify({
      id: 105, method: "thread/fork", params: { threadId: "thread-1" },
    }));
    await eventually(() => f.nativeMessages.some((message) => message.id === 105 && message.error));
    assert.equal(f.providerRequests.some((message) => message.id === 105), false);
  } finally { await f.stop(); }
});

for (const decision of ["approve", "deny"]) {
  test(`Codex CLI ${decision} resolves the same request and clears Telegram buttons`, async () => {
    const f = await fixture();
    try {
      const approval = await f.request();
      await f.sync();
      assert.equal(f.sent[0][2].replyMarkup.inline_keyboard[0].length, 2);
      f.frontend.send(JSON.stringify({
        id: f.approvalMessage.id, result: { decision: decision === "approve" ? "accept" : "cancel" },
      }));
      await eventually(async () => {
        await f.store.reload();
        return f.store.state.approvals[0]?.status === (decision === "approve" ? "approved" : "denied");
      });
      await f.sync();
      assert.equal(f.providerReplies.length, 1);
      assert.equal(f.store.state.approvals[0].decidedVia, "cli");
      assert.match(f.edits.at(-1)[2], /By: /);
      assert.match(f.edits.at(-1)[2], decision === "approve" ? /Approved in Codex CLI/ : /Denied in Codex CLI/);
      await eventually(() => f.nativeMessages.some((message) => message.method === "warning"
        && message.params.message.includes(`via Codex CLI by ${localApprovalActor()}`)));
      assert.deepEqual(f.edits.at(-1)[3], { inline_keyboard: [] });
      await f.service.handle({ callback_query: f.callback(approval, "approve") });
      assert.match(f.answers.at(-1)[1], /no longer pending/);
      assert.equal(f.providerReplies.length, 1);
    } finally { await f.stop(); }
  });

  test(`Telegram ${decision} reaches Codex and resolves its native prompt`, async () => {
    const f = await fixture();
    try {
      const approval = await f.request();
      await f.sync();
      await f.service.handle({ callback_query: f.callback(approval, decision) });
      await eventually(() => f.nativeMessages.some((message) =>
        message.method === "serverRequest/resolved" && message.params.requestId === f.approvalMessage.id));
      await eventually(async () => {
        await f.store.reload();
        return f.store.state.approvals[0]?.status === (decision === "approve" ? "approved" : "denied");
      });
      await f.sync();
      assert.equal(f.providerReplies.length, 1);
      assert.equal(f.providerReplies[0].result.decision, decision === "approve" ? "accept" : "cancel");
      assert.equal(f.store.state.approvals[0].decidedVia, "telegram");
      assert.match(f.edits.at(-1)[2], decision === "approve" ? /Approved in Telegram/ : /Denied in Telegram/);
      assert.match(f.edits.at(-1)[2], /By: @test_user \(Telegram user 10\)/);
      await eventually(() => f.nativeMessages.some((message) => message.method === "warning"
        && message.params.message.includes("via Telegram by @test_user (user 10)")));
      // A native keypress already in flight can arrive after the prompt closes.
      // It must not become a second answer after the tracking entry is removed.
      await new Promise((resolve) => setTimeout(resolve, 30));
      f.frontend.send(JSON.stringify({
        id: f.approvalMessage.id, result: { decision: decision === "approve" ? "cancel" : "accept" },
      }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(f.providerReplies.length, 1);
    } finally { await f.stop(); }
  });
}

test("simultaneous CLI and Telegram decisions produce exactly one provider response", async () => {
  const f = await fixture();
  try {
    const approval = await f.request();
    const otherStore = await new StateStore(f.store.root).init();
    const claims = await Promise.allSettled([
      claimCodexApproval(f.store, approval.id, "approve", "10", "telegram"),
      claimCodexApproval(otherStore, approval.id, "deny", "local-user", "cli"),
    ]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    await eventually(() => f.providerReplies.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.providerReplies.length, 1);
  } finally { await f.stop(); }
});

test("native approval labels survive unavailable OS username lookup without changing authority", () => {
  assert.equal(localApprovalActor(() => "fixture-user"), "fixture-user");
  assert.equal(localApprovalActor(() => { throw new Error("passwd lookup unavailable"); }), "local terminal user");
  assert.equal(localApprovalActor(() => null), "local terminal user");
});
test("unlink purges approval history while direct native approval remains usable", async () => {
  const f = await fixture();
  try {
    await f.request();
    await f.service.runtime.unlink("demo", { confirmed: true });
    assert.equal(f.store.state.approvals.length, 0);
    f.frontend.send(JSON.stringify({ id: f.approvalMessage.id, result: { decision: "accept" } }));
    await eventually(() => f.providerReplies.length === 1);
    await f.store.reload();
    assert.equal(f.store.state.projects.demo, undefined);
    assert.equal(f.store.state.approvals.length, 0);
  } finally { await f.stop(); }
});

test("failed Telegram cleanup revokes Telegram but does not block native approval", async () => {
  const f = await fixture();
  try {
    await f.request();
    f.service.runtime.onDeleteTopic = async () => { throw new Error("Missing topic deletion permission"); };
    await assert.rejects(f.service.runtime.unlink("demo", { confirmed: true }), /cleanup is incomplete/);
    f.frontend.send(JSON.stringify({ id: f.approvalMessage.id, result: { decision: "accept" } }));
    await eventually(() => f.providerReplies.length === 1);
    assert.equal(f.providerReplies[0].result.decision, "accept");
    await f.store.reload();
    assert.equal(f.store.state.projects.demo.status, "unlinked");
  } finally { await f.stop(); }
});

test("native approval remains actionable while Telegram delivery is stalled", async () => {
  const f = await fixture();
  let releaseDelivery;
  try {
    const approval = await f.request();
    f.service.client.sendMessage = (...args) => {
      f.sent.push(args);
      return new Promise((resolve) => {
        releaseDelivery = () => resolve({ message_id: 99 });
      });
    };
    await f.service.syncApprovalMessages();
    await eventually(() => releaseDelivery);
    f.frontend.send(JSON.stringify({ id: f.approvalMessage.id, result: { decision: "accept" } }));
    await eventually(async () => {
      await f.store.reload();
      return f.store.state.approvals[0]?.status === "approved";
    });
    assert.equal(f.providerReplies.length, 1);
    releaseDelivery();
    await eventually(() => !f.service.notifyingApprovals.size);
    await f.sync();
    assert.match(f.edits.at(-1)[2], /Approved in Codex CLI/);
    assert.deepEqual(f.edits.at(-1)[3], { inline_keyboard: [] });
    await f.service.handle({ callback_query: f.callback(approval, "deny") });
    assert.match(f.answers.at(-1)[1], /no longer pending/);
  } finally {
    releaseDelivery?.();
    await f.stop();
  }
});

test("restarting the Telegram interface does not disconnect native approvals", async () => {
  const f = await fixture();
  try {
    const approval = await f.request();
    await f.sync();
    f.service.runtime.stop();
    const restarted = new TelegramService(f.store, {
      chatId: "-1001", allowedUsers: "10", client: f.service.client,
    });
    try {
      await restarted.handle({ callback_query: f.callback(approval, "deny") });
      await eventually(() => f.nativeMessages.some((message) => message.method === "serverRequest/resolved"));
      await eventually(async () => {
        await f.store.reload();
        return f.store.state.approvals[0]?.status === "denied";
      });
      await restarted.syncApprovalMessages();
      await eventually(() => !restarted.editingApprovals.size);
      assert.equal(f.providerReplies.length, 1);
      assert.match(f.edits.at(-1)[2], /Denied in Telegram/);
    } finally { restarted.runtime.stop(); }
  } finally { await f.stop(); }
});

test("unrelated resumed thread is not mirrored into another project's Telegram topic", async () => {
  const f = await fixture();
  try {
    f.setThreadCwd(path.dirname(f.root));
    f.provider().send(JSON.stringify(f.approvalMessage));
    await eventually(() => f.nativeMessages.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await f.store.reload();
    assert.equal(f.store.state.approvals.length, 0);
    f.frontend.send(JSON.stringify({ id: f.approvalMessage.id, result: { decision: "cancel" } }));
    await eventually(() => f.providerReplies.length === 1);
  } finally { await f.stop(); }
});

test("permissions are approve-once and empty/null grants count as denial", () => {
  const approval = {
    method: "item/permissions/requestApproval",
    details: { permissions: { network: { enabled: true } } },
  };
  assert.deepEqual(codexDecisionResult(approval, "approve"), {
    permissions: { network: { enabled: true } }, scope: "turn",
  });
  assert.deepEqual(codexDecisionResult(approval, "deny"), { permissions: {}, scope: "turn" });
  assert.equal(decisionFromCodexResult({ permissions: { network: null, fileSystem: null } }), "deny");
});

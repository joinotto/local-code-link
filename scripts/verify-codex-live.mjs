// Real shared Codex server and production relay. No provider events or
// Telegram callbacks are fabricated. Optional --telegram needs human answers.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateStore, now } from "../src/state.mjs";
import { CodexSharedClient } from "../src/codex-shared.mjs";
import { CodexTuiProxy } from "../src/codex-tui-proxy.mjs";
import { codexQuestionResult, CODEX_REQUEST_METHODS } from "../src/approval-sync.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import { loadConfiguration } from "../src/config.mjs";
import { fileURLToPath } from "node:url";

const telegram = process.argv.includes("--telegram");
const restartService = process.argv.includes("--restart-service");
const liveBridge = telegram || restartService;
const execute = promisify(execFile);
if (liveBridge) {
  await loadConfiguration(fileURLToPath(new URL("..", import.meta.url)));
}
const parent = await realpath(await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "lcl-codex-live-")));
const cwd = path.join(parent, "project");
await mkdir(cwd);
const store = await new StateStore(liveBridge ? undefined : path.join(parent, "state")).init();
const id = `codex-e2e-${randomUUID().slice(0, 8)}`;
const tg = liveBridge ? new TelegramClient(process.env.TELEGRAM_BOT_TOKEN) : null;
if (tg) await tg.getMe();
const topic = liveBridge ? (await tg.createForumTopic(store.state.telegram.chatId, id)).message_thread_id : 9;
const project = { id, name: id, cwd, linkId: randomUUID(), topicId: topic,
  provider: "codex", status: "idle", sessionIds: {}, createdAt: now(), lastActiveAt: now(),
  localSession: { status: "active", approvalProxyPid: process.pid } };
store.state.projects[id] = project;
await store.save();
const proxy = new CodexTuiProxy(store, project);
await proxy.start();
let frontend;
const messages = [];
const received = [];
const wait = async (condition, label, timeout = 180_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const attach = async () => {
  frontend = new CodexSharedClient({ socketPath: proxy.socketPath });
  frontend.onMessage = (message) => {
    if (CODEX_REQUEST_METHODS.has(message.method)) received.push(message);
    messages.push(message);
  };
  await frontend.connect();
};
const complete = async (turnId, statuses = ["completed"]) => {
  await wait(() => messages.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId),
    "real provider completion");
  const completed = messages.find((m) => m.method === "turn/completed" && m.params.turn.id === turnId);
  assert.ok(statuses.includes(completed.params.turn.status),
    `Unexpected provider status: ${completed.params.turn.status}`);
};
const pending = async (turnId, type) => {
  await wait(async () => {
    await store.reload();
    if (store.state.approvals.some((a) => a.turnId === turnId && a.type === type)) return true;
    if (messages.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId)) {
      throw new Error(`The provider completed without a ${type} request. This is not a passing approval test.`);
    }
    return false;
  }, `real ${type} request`);
  return store.state.approvals.find((a) => a.turnId === turnId && a.type === type);
};
const settled = async (approval, via) => {
  await wait(async () => {
    await store.reload();
    const a = store.state.approvals.find((item) => item.id === approval.id);
    return ["approved", "denied"].includes(a?.status);
  }, "request resolution", telegram ? 600_000 : 30_000);
  const saved = store.state.approvals.find((a) => a.id === approval.id);
  assert.equal(saved.decidedVia, via);
  if (liveBridge) await wait(async () => {
    await store.reload();
    return store.state.approvals.find((a) => a.id === approval.id).telegramDisplayStatus === saved.status;
  }, "actual Telegram button cleanup");
  return saved;
};
try {
  await attach();
  const { thread, model } = await frontend.request("thread/start", {
    cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
  });
  assert.equal(await realpath(thread.cwd), cwd);
  project.sessionIds.codex = thread.id;
  await store.save();
  const models = await frontend.request("model/list", {});
  const modelId = model || models.data.find((m) => m.isDefault)?.id || models.data[0].id;
  if (telegram) {
    console.log(`Open Telegram topic ${id}. Select React for the question, then explicitly approve once or deny the harmless command test.`);
    await tg.sendMessage(store.state.telegram.chatId,
      "Live Codex test: choose React in the upcoming question. Then approve once OR deny the harmless Python print command. The test checks whichever decision you actually make.",
      { topicId: topic });
  }
  const questionTurn = await frontend.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Do not read or change any files. Use request_user_input exactly once to ask which framework to use, with question id framework and options React and Vue. After the answer, reply QUESTION_OK followed by the chosen framework. Do not use other tools." }],
    collaborationMode: { mode: "plan", settings: { model: modelId, reasoning_effort: "low", developer_instructions: null } },
  });
  const question = await pending(questionTurn.turn.id, "question");
  if (!telegram) frontend.respond(question.serverRequestId, codexQuestionResult(question, "React"));
  const answered = await settled(question, telegram ? "telegram" : "cli");
  assert.deepEqual(Object.values(answered.response.answers)[0].answers, ["React"]);
  await complete(questionTurn.turn.id);
  assert.ok(messages.some((m) => m.method === "item/completed"
    && m.params.item.type === "agentMessage" && /QUESTION_OK.*React/s.test(m.params.item.text)));
  console.log("PASS: actual Codex structured question, exact response and shared decision resolution.");

  const permissionTurn = await frontend.request("turn/start", {
    threadId: thread.id, approvalPolicy: "untrusted", approvalsReviewer: "user",
    input: [{ type: "text", text: "This is an owner-authorized approval bridge test. Do not read or change any files. Use exec_command exactly once to run /usr/bin/python3 -c 'print(\"LOCAL_CODE_LINK_DENY\")'. Set sandbox_permissions to require_escalated and justification to LocalCodeLink harmless print approval test. The owner will explicitly decide. After denial reply DENIED_OK. Never retry or use other tools." }],
    collaborationMode: { mode: "default", settings: { model: modelId, reasoning_effort: "low", developer_instructions: null } },
  });
  const permission = await pending(permissionTurn.turn.id, "command");
  assert.ok(JSON.stringify(permission.details).includes("LOCAL_CODE_LINK_DENY"), "Only the harmless test command may be requested");
  if (restartService) {
    assert.equal(process.platform, "darwin", "The deployed launch service is macOS-only");
    await wait(async () => {
      await store.reload();
      return store.state.approvals.find((item) => item.id === permission.id)?.telegramMessageId;
    }, "actual Telegram approval delivery before restart");
    await store.reload();
    assert.ok(!store.state.approvals.some((a) => a.projectId !== id && ["pending", "responding"].includes(a.status)),
      "Do not restart while another project has a pending approval");
    assert.ok(Object.values(store.state.projects).every((p) => p.id === id
      || (!p.backgroundTask && !p.telegramRequests?.length)),
    "Do not restart while unrelated background work is running");
    const lease = path.join(store.root, "telegram-service.lock");
    const oldPid = Number((await readFile(lease, "utf8")).split(":")[0]);
    process.kill(oldPid, 0);
    await execute("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.local-code-link.telegram`]);
    await wait(async () => {
      try {
        const pid = Number((await readFile(lease, "utf8")).split(":")[0]);
        process.kill(pid, 0);
        return pid !== oldPid;
      } catch { return false; }
    }, "new deployed Telegram daemon PID");
    await store.reload();
    assert.equal(store.state.approvals.find((a) => a.id === permission.id).status, "pending");
    await frontend.request("thread/read", { threadId: thread.id });
    console.log("PASS: real deployed daemon restart preserves the native connection and pending approval.");
  }
  if (!telegram) frontend.respond(permission.serverRequestId, { decision: "cancel" });
  const decided = await settled(permission, telegram ? "telegram" : "cli");
  if (!telegram) assert.equal(decided.status, "denied");
  await complete(permissionTurn.turn.id, decided.status === "approved" ? ["completed"] : ["completed", "interrupted"]);
  const execution = messages.find((m) => m.method === "item/completed" && m.params.turnId === permissionTurn.turn.id
    && m.params.item.type === "commandExecution");
  if (decided.status === "denied") {
    assert.notEqual(execution?.params.item.exitCode, 0, "Denied command must not execute successfully");
  } else {
    assert.equal(execution?.params.item.exitCode, 0, "Approved harmless command must execute");
    assert.match(execution.params.item.aggregatedOutput, /LOCAL_CODE_LINK_DENY/);
  }
  console.log(`PASS: actual Codex command ${decided.status}, matching execution outcome and resolution cleanup.`);

  frontend.close();
  await attach();
  const resumed = await frontend.request("thread/resume", { threadId: thread.id, cwd, excludeTurns: true });
  assert.equal(resumed.thread.id, thread.id);
  const replyTurn = await frontend.request("turn/start", { threadId: thread.id,
    input: [{ type: "text", text: "Do not use tools. Reply exactly RESUMED_OK." }] });
  await complete(replyTurn.turn.id);
  assert.ok(messages.some((m) => m.method === "item/completed"
    && m.params.item.type === "agentMessage" && /RESUMED_OK/.test(m.params.item.text)));
  console.log("PASS: shared Codex reconnect, exact project/session resume and authenticated inference.");
} finally {
  // A failed human-interaction test must not leave its own provider turn
  // waiting forever. Never interrupt an unrelated project or thread.
  if (frontend && project.sessionIds.codex) {
    const active = messages.findLast((m) => m.method === "turn/started"
      && m.params.threadId === project.sessionIds.codex
      && !messages.some((done) => done.method === "turn/completed"
        && done.params.turn.id === m.params.turn.id));
    if (active) {
      try { await frontend.request("turn/interrupt", {
        threadId: project.sessionIds.codex, turnId: active.params.turn.id,
      }); } catch { /* Closing the owned relay also cancels its pending requests. */ }
    }
  }
  frontend?.close();
  await proxy.stop();
  await store.reload();
  if (store.state.projects[id]) {
    store.state.projects[id].localSession = { status: "stopped", stoppedAt: now() };
    await store.save();
  }
  if (liveBridge) console.log(`Test topic retained. Optional cleanup: local-code-link unlink ${id}`);
}

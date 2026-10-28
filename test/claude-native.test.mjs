import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { StateStore } from "../src/state.mjs";
import { ClaudeNativeBridge } from "../src/claude-native-bridge.mjs";
import { claudeRequest, claudeSocketPath } from "../src/claude-ipc.mjs";
import { selectClaudeSession } from "../src/claude-session.mjs";
import { assertClaudeChannelProvider, claudeInteractiveArgs } from "../src/claude-terminal.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { TelegramService } from "../src/telegram-service.mjs";

const sid = "11111111-1111-4111-8111-111111111111";
const wait = async (condition) => {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected Claude protocol event did not arrive");
};
async function fixture(t, channel = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-cl-"));
  const store = await new StateStore(path.join(root, "s")).init();
  const project = { id: "demo", name: "demo", cwd: root, linkId: "link-1",
    provider: "claude", topicId: 9, status: "idle", sessionIds: {} };
  store.state.projects.demo = project;
  await store.save();
  let interrupts = 0;
  const bridge = new ClaudeNativeBridge(store, project, { interrupt: () => { interrupts++; return true; } });
  await bridge.start();
  const request = (method, params) => claudeRequest(store.root, project, method, params);
  const hook = (event, fields = {}) => request("hook", {
    hook_event_name: event, session_id: sid, cwd: root, ...fields,
  });
  await hook("SessionStart", { transcript_path: path.join(root, `${sid}.jsonl`) });
  const sent = [], edits = [], answers = [];
  const service = new TelegramService(await new StateStore(store.root).init(), {
    chatId: "-1001", allowedUsers: "10", client: {
      sendMessage: async (...args) => { sent.push(args); return { message_id: sent.length }; },
      editMessageText: async (...args) => edits.push(args),
      answerCallbackQuery: async (...args) => answers.push(args),
    },
  });
  let mcp;
  const inbound = [], permissions = [];
  if (channel) {
    mcp = new Client({ name: "claude-fixture", version: "1" });
    mcp.setNotificationHandler(z.object({
      method: z.literal("notifications/claude/channel"), params: z.object({
        content: z.string(), meta: z.record(z.string(), z.string()),
      }),
    }), ({ params }) => inbound.push(params));
    mcp.setNotificationHandler(z.object({
      method: z.literal("notifications/claude/channel/permission"), params: z.object({
        request_id: z.string(), behavior: z.enum(["allow", "deny"]),
      }),
    }), ({ params }) => permissions.push(params));
    await mcp.connect(new StdioClientTransport({ command: process.execPath,
      args: [new URL("../src/claude-channel.mjs", import.meta.url).pathname, store.root, project.id, project.linkId] }));
    await wait(async () => (await request("status")).connected);
  }
  t.after(async () => { service.runtime.stop(); await mcp?.close(); await bridge.stop(); });
  const permission = async () => {
    await hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "tool-1",
      tool_input: { command: "printf approval-test" } });
    const params = { request_id: "abcde", tool_name: "Bash", description: "Print marker",
      input_preview: '{"command":"printf approval-test"}' };
    if (mcp) {
      await mcp.notification({ method: "notifications/claude/channel/permission_request", params });
      await wait(async () => { await store.reload(); return store.state.approvals.length; });
    } else await request("permission", params);
    await store.reload();
    return store.state.approvals.at(-1);
  };
  return { root, store, project, bridge, request, hook, service, mcp, inbound, permissions,
    sent, edits, answers, permission, interrupts: () => interrupts };
}

test("Claude launch declares a scoped channel and non-blocking hooks without disabling permissions", () => {
  const args = claudeInteractiveArgs({ root: "/tmp/state" },
    { id: "demo", linkId: "one", accessMode: "edit" }, "/tmp/repo", sid, "channel");
  assert.deepEqual(args.slice(0, 4), ["--resume", sid, "--permission-mode", "default"]);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(config.mcpServers["local-code-link"].args.slice(-3), ["/tmp/state", "demo", "one"]);
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 5);
  assert.equal(settings.permissions, undefined);
});

test("Claude third-party provider restrictions are detected without changing user settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-env-"));
  const settings = JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", PRIVATE_VALUE: "secret" } });
  await writeFile(path.join(root, "settings.json"), settings);
  await assert.rejects(() => assertClaudeChannelProvider(root, {}, root), /unavailable with Bedrock/);
  assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "settings.json"), "utf8")), settings);
  await assertClaudeChannelProvider(root, { CLAUDE_CODE_USE_BEDROCK: "0" }, root);
});

test("native Claude session and full permission input are captured without granting permission", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.state.projects.demo.sessionIds.claude, sid);
  const approval = await f.permission();
  assert.equal(approval.canReply, true);
  assert.equal(approval.details.input.command, "printf approval-test");
  assert.equal(approval.status, "pending");
  assert.equal((await stat(claudeSocketPath(f.store.root, f.project))).mode & 0o777, 0o600);
});

test("real MCP channel sends Telegram prompts to the same native session and returns only scoped replies", async (t) => {
  const f = await fixture(t, true);
  const runtime = f.service.runtime;
  assert.equal(await runtime.queueToLocalSession(runtime.project("demo"), "Reply hello"), true);
  await wait(() => f.inbound.length === 1);
  assert.equal(f.inbound[0].content, "Reply hello");
  const requestId = f.inbound[0].meta.requestId;
  await wait(async () => { await f.store.reload(); return f.store.state.projects.demo.telegramRequests[0].status === "active"; });
  const response = await f.mcp.callTool({ name: "reply", arguments: { requestId, text: "hello" } });
  assert.equal(response.isError, undefined);
  await runtime.deliverClaudeOutbox();
  assert.equal(f.sent[0][1], "hello");
  await f.hook("Stop", { last_assistant_message: "different CLI text" });
  await runtime.deliverClaudeOutbox();
  assert.equal(f.sent.length, 1);
  await assert.rejects(() => f.mcp.callTool({ name: "reply",
    arguments: { requestId: "foreign", text: "leak" } }), /active Telegram request/);
});

for (const [decision, behavior] of [["approve", "allow"], ["deny", "deny"]]) {
  test(`Telegram ${decision} produces one native Claude notification and removes buttons`, async (t) => {
    const f = await fixture(t, true);
    const approval = await f.permission();
    await f.service.syncApprovalMessages();
    await wait(() => f.sent.length === 1);
    await f.service.handleCallback({ id: "callback", from: { id: 10, username: "owner" },
      message: { chat: { id: "-1001" }, message_thread_id: 9 },
      data: `approval:${approval.id}:${decision}` });
    await wait(() => f.permissions.length === 1);
    assert.deepEqual(f.permissions[0], { request_id: "abcde", behavior });
    await assert.rejects(() => f.service.runtime.decideApproval(approval.id, decision, 10, 9), /no longer pending/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.permissions.length, 1);
    if (decision === "approve") await f.hook("PostToolUse", {
      tool_name: "Bash", tool_use_id: "tool-1", tool_input: { command: "printf approval-test" },
    });
    await f.hook("Stop");
    await f.service.syncApprovalMessages();
    await wait(() => f.edits.some((item) => item[3]?.inline_keyboard?.length === 0));
    await f.store.reload();
    assert.equal(f.store.state.approvals[0].status, decision === "approve" ? "approved" : "resolved");
  });
}

test("a terminal-approved tool closes Telegram's request; late remote decisions are rejected", async (t) => {
  const f = await fixture(t);
  const approval = await f.permission();
  await f.hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tool-1",
    tool_input: { command: "printf approval-test" } });
  await f.store.reload();
  assert.equal(f.store.state.approvals[0].status, "approved");
  assert.equal(f.store.state.approvals[0].decidedVia, "cli");
  await assert.rejects(() => f.service.runtime.decideApproval(approval.id, "approve", 10, 9), /no longer pending/);
});

test("truncated or ambiguous native approval previews cannot authorize an unknown action", async (t) => {
  const f = await fixture(t);
  const id = await f.request("permission", { request_id: "abcde", tool_name: "Bash",
    description: "Run command", input_preview: "truncated" });
  await f.request("next");
  await f.service.syncApprovalMessages();
  await wait(() => f.sent.length === 1);
  assert.deepEqual(f.sent[0][2].replyMarkup.inline_keyboard, []);
  await assert.rejects(() => f.service.runtime.decideApproval(id, "approve", 10, 9), /Full Claude/);
});

test("busy local Claude work holds Telegram prompts until Stop and does not broadcast local results", async (t) => {
  const f = await fixture(t);
  await f.request("next");
  await f.hook("UserPromptSubmit");
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "queued");
  assert.equal(await f.request("next"), null);
  await f.hook("Stop", { last_assistant_message: "private CLI result" });
  assert.equal((await f.request("next")).content, "queued");
  await f.service.runtime.deliverClaudeOutbox();
  assert.equal(f.sent.length, 0);
});

test("Telegram interruption targets only its project's owned native terminal", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.runtime.interrupt("demo"), false);
  await f.hook("UserPromptSubmit");
  assert.equal(await f.service.runtime.interrupt("demo"), true);
  assert.equal(f.interrupts(), 1);
});

test("stale generations, foreign session hooks and cross-topic decisions are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => claudeRequest(f.store.root, { ...f.project, linkId: "wrong" }, "status"), /ENOENT/);
  await assert.rejects(() => f.hook("Stop", { session_id: "foreign" }), /another session/);
  const approval = await f.permission();
  await assert.rejects(() => f.service.runtime.decideApproval(approval.id, "approve", 10, 77), /another project/);
  f.store.state.projects.demo.status = "unlinked";
  await f.store.save();
  await assert.rejects(() => f.request("next"), /no longer valid/);
});

test("one project cannot launch a second Claude bridge", async (t) => {
  const f = await fixture(t);
  const second = new ClaudeNativeBridge(await new StateStore(f.store.root).init(), f.project);
  await assert.rejects(() => second.start(), /already has an active/);
  assert.ok(await f.request("status"));
});

test("Claude resumes only verified transcript metadata for the exact project; /new stays fresh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-cs-"));
  const transcripts = path.join(root, "transcripts");
  await mkdir(path.join(transcripts, "lossy-project-name"), { recursive: true });
  const own = { cwd: root, sessionId: sid };
  await writeFile(path.join(transcripts, "lossy-project-name", `${sid}.jsonl`), `${JSON.stringify(own)}\n`);
  const store = await new StateStore(path.join(root, "state")).init();
  const project = { id: "demo", topicId: 9, linkId: "one", cwd: root, status: "idle", sessionIds: {} };
  store.state.projects.demo = project;
  await store.save();
  assert.equal((await selectClaudeSession(store, project, transcripts)).sessionId, sid);
  project.sessionIds.claude = "99999999-9999-4999-8999-999999999999";
  await store.save();
  assert.equal((await selectClaudeSession(store, project, transcripts)).sessionId, null);
  project.freshSession = true;
  await store.save();
  assert.equal((await selectClaudeSession(store, project, transcripts)).sessionId, null);
});

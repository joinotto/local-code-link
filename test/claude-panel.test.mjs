import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StateStore } from "../src/state.mjs";
import { ClaudePanelBridge, safePrompt, telegramMarker } from "../src/claude-panel-bridge.mjs";
import { ClaudeApprovalPanel, terminalText } from "../src/claude-approval-panel.mjs";
import { claudeRequest } from "../src/claude-ipc.mjs";
import { claudeInteractiveArgs } from "../src/claude-terminal.mjs";
import { TelegramService } from "../src/telegram-service.mjs";

const sid = "11111111-1111-4111-8111-111111111111";
const wait = async (condition) => {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected panel condition did not arrive");
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-p-"));
  const store = await new StateStore(path.join(root, "s")).init();
  const project = { id: "demo", name: "demo", cwd: root, linkId: "one",
    provider: "claude", topicId: 9, status: "idle", sessionIds: {} };
  store.state.projects.demo = project;
  await store.save();
  const submissions = [], panels = [], sent = [], edits = [], callbacks = [];
  let interruptions = 0;
  const bridge = new ClaudePanelBridge(store, project, {
    onPanel: (...args) => panels.push(args),
    submit: async (text) => submissions.push(text),
    interrupt: () => { interruptions++; return true; },
  });
  await bridge.start();
  const request = (method, params) => claudeRequest(store.root, project, method, params);
  const input = (event, fields = {}) => ({
    hook_event_name: event, cwd: root, session_id: sid, ...fields,
  });
  const hook = (event, fields) => request("hook", input(event, fields));
  await hook("SessionStart", { transcript_path: path.join(root, `${sid}.jsonl`) });
  bridge.notBefore = 0;
  const service = new TelegramService(await new StateStore(store.root).init(), {
    chatId: "-1001", allowedUsers: "10", client: {
      sendMessage: async (...args) => { sent.push(args); return { message_id: sent.length }; },
      editMessageText: async (...args) => edits.push(args),
      answerCallbackQuery: async (...args) => callbacks.push(args),
      deleteForumTopic: async () => true,
    },
  });
  t.after(async () => { service.runtime.stop(); await bridge.stop(); });
  const runHook = (event, fields = {}) => {
    const child = spawn(process.execPath, [
      new URL("../src/claude-session-hook.mjs", import.meta.url).pathname,
      store.root, project.id, project.linkId,
    ], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stdin.end(JSON.stringify(input(event, fields)));
    t.after(() => child.kill());
    return { child, output: () => output, result: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        try { assert.equal(code, 0); resolve(JSON.parse(output)); } catch (error) { reject(error); }
      });
    }) };
  };
  const permission = async () => {
    const result = await hook("PermissionRequest", { tool_name: "Bash",
      tool_input: { command: "printf safe-test" }, tool_use_id: "tool-1" });
    await store.reload();
    return { result, approval: store.state.approvals.find((item) => item.id === result._localCodeLinkWait[0]) };
  };
  return { root, store, project, bridge, request, hook, service, permission, runHook,
    submissions, panels, sent, edits, callbacks, interruptions: () => interruptions };
}

test("default Claude terminal uses provider-neutral hooks, not development channels or permission bypasses", () => {
  const args = claudeInteractiveArgs({ root: "/tmp/state" }, { id: "demo", linkId: "one" }, "/tmp/repo", sid);
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.some((arg) => arg.includes("dangerously")));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 960);
});

for (const via of ["cli", "telegram"]) {
  for (const decision of ["approve", "deny"]) {
    test(`shared ${via} ${decision} returns an exact single-use native hook decision and clears Telegram buttons`, async (t) => {
      const f = await fixture(t);
      const run = f.runHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "printf safe-test" } });
      await wait(async () => { await f.store.reload(); return f.store.state.approvals.length === 1; });
      const id = f.store.state.approvals[0].id;
      await f.service.syncApprovalMessages();
      await wait(() => f.sent.length === 1);
      if (via === "cli") await f.request("panel-decide", { id, decision });
      else await f.service.handleCallback({ id: "tg-click", from: { id: 10, username: "owner" },
        message: { chat: { id: "-1001" }, message_thread_id: 9 }, data: `approval:${id}:${decision}` });
      const output = await run.result;
      assert.equal(output.hookSpecificOutput.hookEventName, "PermissionRequest");
      assert.equal(output.hookSpecificOutput.decision.behavior, decision === "approve" ? "allow" : "deny");
      assert.equal(output.hookSpecificOutput.decision.updatedPermissions, undefined);
      assert.equal(output.hookSpecificOutput.decision.updatedInput, undefined);
      assert.match(output.systemMessage, via === "cli" ? /Claude CLI/ : /Telegram.*@owner/);
      await f.service.syncApprovalMessages();
      await wait(() => f.edits.length);
      assert.deepEqual(f.edits.at(-1)[3].inline_keyboard, []);
      await assert.rejects(() => f.request("panel-decide", { id, decision }), /no longer pending/);
      await assert.rejects(() => f.service.runtime.decideApproval(id, decision, 10, 9), /no longer pending/);
    });
  }
}

test("simultaneous CLI and Telegram responses share a first-writer claim", async (t) => {
  const f = await fixture(t);
  const { approval } = await f.permission();
  const results = await Promise.allSettled([
    f.request("panel-decide", { id: approval.id, decision: "approve" }),
    f.service.runtime.decideApproval(approval.id, "deny", { id: 10, username: "owner" }, 9),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const result = await f.request("panel-result", { id: approval.id });
  assert.equal(result.done, true);
  assert.ok(["allow", "deny"].includes(result.behavior));
  await f.store.reload();
  assert.ok(["approved", "denied"].includes(f.store.state.approvals[0].status));
});

test("terminal panel accepts deliberate single keys, not paste or buffered approval text", async (t) => {
  const f = await fixture(t);
  const { approval } = await f.permission();
  const text = [];
  const panel = new ClaudeApprovalPanel(f.store.root, f.project, { write: (value) => text.push(value) });
  panel.show(approval);
  assert.equal(panel.handle("\x1b[200~a\x1b[201~"), true);
  await f.store.reload();
  assert.equal(f.store.state.approvals[0].status, "pending");
  panel.handle("a");
  await wait(async () => { await f.store.reload(); return f.store.state.approvals[0].status === "responding"; });
  assert.match(text.join(""), /printf safe-test/);
});

test("idle Telegram prompts enter the owned terminal and only their Stop result returns to Telegram", async (t) => {
  const f = await fixture(t);
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "hello");
  await wait(() => f.submissions.length === 1);
  await f.store.reload();
  const id = f.store.state.projects.demo.telegramRequests[0].id;
  assert.equal(f.submissions[0], `${telegramMarker(id)}\nhello`);
  await f.hook("UserPromptSubmit", { prompt: f.submissions[0] });
  await f.hook("Stop", { last_assistant_message: "hello back" });
  await f.service.runtime.deliverClaudeOutbox();
  assert.equal(f.sent[0][1], "hello back");
  await f.hook("UserPromptSubmit", { prompt: "local private prompt" });
  await f.hook("Stop", { last_assistant_message: "local private output" });
  await f.service.runtime.deliverClaudeOutbox();
  assert.equal(f.sent.length, 1);
});

test("local busy turns and draft text prevent remote prompt injection until idle", async (t) => {
  const f = await fixture(t);
  f.bridge.noteInput("a local draft");
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "queued");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.submissions.length, 0);
  f.bridge.noteInput("\r");
  await f.hook("UserPromptSubmit", { prompt: "a local draft" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.submissions.length, 0);
  await f.hook("Stop", { last_assistant_message: "done" });
  await wait(() => f.submissions.length === 1);
});

test("iTerm focus, cursor and capability responses do not block queued Telegram prompts", async (t) => {
  const f = await fixture(t);
  for (const response of ["\x1b[I", "\x1b[O", "\x1b[1;2R", "\x1b[?1;2c",
    "\x1b[?1u", "\x1b[>0;95;0c", "\x1b]10;rgb:ffff/ffff/ffff\x07"]) {
    for (const character of response) f.bridge.noteInput(character);
    assert.equal(f.bridge.draft, false);
    assert.equal(f.bridge.busy, false);
  }
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "hi");
  await wait(() => f.submissions.length === 1);
  assert.match(f.submissions[0], /\nhi$/);
});

test("terminal protocol preserves actual typed and pasted drafts and reports why work is queued", async (t) => {
  const f = await fixture(t);
  f.bridge.noteInput("\x1b[97u");
  assert.equal(f.bridge.draft, true);
  for (const character of "\x1b[I\x1b[1;2R") f.bridge.noteInput(character);
  assert.equal(f.bridge.draft, true);
  f.bridge.noteInput("\x15");
  assert.equal(f.bridge.draft, false);
  f.bridge.noteInput("\x1b[200~draft");
  f.bridge.noteInput("\rcontinued");
  f.bridge.noteInput("\x1b[201~");
  assert.equal(f.bridge.draft, true);
  assert.equal(f.bridge.busy, false);
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "hi");
  const status = await f.request("status");
  assert.equal(status.waitingFor, "local draft");
  assert.equal(status.queued, 1);
  f.bridge.noteInput("\r");
  assert.equal(f.bridge.busy, true);
});

test("history navigation blocks queued injection and Escape cannot discard an unfinished draft", async (t) => {
  const f = await fixture(t);
  f.bridge.noteInput("\x1b[A");
  assert.equal(f.bridge.draft, true);
  f.bridge.noteInput("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.bridge.draft, true);
  f.bridge.noteInput("\x15");
  assert.equal(f.bridge.draft, false);
});

test("queued prompts survive a Telegram service restart without duplicate submission", async (t) => {
  const f = await fixture(t);
  await f.hook("UserPromptSubmit", { prompt: "busy" });
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("demo"), "queued");
  f.service.runtime.stop();
  await f.hook("Stop");
  await wait(() => f.submissions.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.submissions.length, 1);
});

test("Telegram questions and custom terminal answers return native AskUserQuestion updatedInput", async (t) => {
  const f = await fixture(t);
  const questions = [{ question: "Choose framework", options: [
    { label: "React", description: "UI" }, { label: "Vue", description: "UI" },
  ], multiSelect: false }, { question: "Name?", options: [], multiSelect: false }];
  const run = f.runHook("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions } });
  await wait(async () => { await f.store.reload(); return f.store.state.approvals.length === 2; })
    .catch((error) => {
      throw new Error(`${error.message}: hook=${run.output()}, approvals=${f.store.state.approvals.length}`);
    });
  const [first, second] = f.store.state.approvals;
  await f.service.syncApprovalMessages();
  await wait(() => f.sent.length === 2);
  await f.service.handleCallback({ id: "q-click", from: { id: 10 }, message: {
    chat: { id: "-1001" }, message_thread_id: 9,
  }, data: `question:${first.id}:1` });
  await f.request("panel-decide", { id: second.id, answer: "ledger" });
  const output = await run.result;
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(output.hookSpecificOutput.updatedInput.answers, { "Choose framework": "Vue", "Name?": "ledger" });
  assert.deepEqual(output.hookSpecificOutput.updatedInput.questions, questions);
});

test("questions and approval buttons reject other users and project topics", async (t) => {
  const f = await fixture(t);
  const { result } = await f.hook("PreToolUse", {
    tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Name?", options: [] }] },
  }).then((result) => ({ result }));
  const id = result._localCodeLinkWait[0];
  await assert.rejects(() => f.service.runtime.answerQuestion(id, "leak", 10, 77), /another project/);
  await f.service.handle({ message: {
    from: { id: 99 }, chat: { id: "-1001" }, message_thread_id: 9, text: `/answer ${id} leak`,
  } });
  await f.store.reload();
  assert.equal(f.store.state.approvals[0].status, "pending");
});

test("unlink releases an unanswered shared panel back to native CLI without granting permission", async (t) => {
  const f = await fixture(t);
  const run = f.runHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "printf safe-test" } });
  await wait(async () => { await f.store.reload(); return f.store.state.approvals.length === 1; });
  await f.service.runtime.unlink("demo", { confirmed: true });
  const result = await run.result;
  assert.equal(result.hookSpecificOutput, undefined);
  assert.ok(!JSON.stringify(result).includes('"allow"'));
  assert.equal(f.store.state.projects.demo, undefined);
});

test("interrupt cancels shared pending approval, clears buttons and never grants permissions", async (t) => {
  const f = await fixture(t);
  const run = f.runHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "printf safe-test" } });
  await wait(async () => { await f.store.reload(); return f.store.state.approvals.length === 1; });
  assert.equal(await f.service.runtime.interrupt("demo"), true);
  const output = await run.result;
  assert.equal(output.hookSpecificOutput.decision.behavior, "deny");
  assert.equal(f.interruptions(), 1);
});

test("remote prompt and terminal display control characters cannot escape the paste/display boundary", () => {
  assert.throws(() => safePrompt("test\x1b[201~"), /control characters/);
  assert.equal(safePrompt("hello\r\nworld"), "hello\nworld");
  assert.equal(terminalText("\x1b[31mhello\x07"), "[31mhello");
});

test("different projects have independent native panels and queues", async (t) => {
  const f = await fixture(t);
  const otherRoot = path.join(f.root, "other");
  await mkdir(otherRoot);
  f.store.state.projects.other = { ...f.project, id: "other", cwd: otherRoot, topicId: 77, linkId: "other" };
  await f.store.save();
  const submitted = [];
  const other = new ClaudePanelBridge(f.store, f.store.state.projects.other, {
    submit: async (text) => submitted.push(text),
  });
  await other.start();
  t.after(() => other.stop());
  await claudeRequest(f.store.root, f.store.state.projects.other, "hook", {
    hook_event_name: "SessionStart", cwd: otherRoot, session_id: "other-session",
  });
  other.notBefore = 0;
  await f.permission();
  await f.service.store.reload();
  await f.service.runtime.queueToLocalSession(f.service.runtime.project("other"), "other only");
  await wait(() => submitted.length === 1);
  assert.match(submitted[0], /other only/);
  assert.equal(f.submissions.length, 0);
});

test("complete large tool arguments are delivered before buttons, without duplicate concurrent sends", async (t) => {
  const f = await fixture(t);
  const content = "x".repeat(7000) + "END_OF_FILE";
  const result = await f.hook("PermissionRequest", {
    tool_name: "Write", tool_input: { file_path: "demo.txt", content },
  });
  await f.store.reload();
  const approval = f.store.state.approvals.find((item) => item.id === result._localCodeLinkWait[0]);
  await Promise.all([
    f.service.sendApproval(f.project, approval),
    f.service.sendApproval(f.project, approval),
  ]);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0][1], /END_OF_FILE/);
  assert.equal(f.sent[0][2].replyMarkup, undefined);
  assert.equal(f.sent[1][2].replyMarkup.inline_keyboard[0].length, 2);
});

test("headless Claude follow-ups queue and run sequentially, rather than starting parallel writers", async (t) => {
  const f = await fixture(t);
  await f.bridge.stop();
  const runtime = f.service.runtime;
  runtime.pollMs = 10;
  const seen = [];
  let release;
  runtime.runClaude = async (_project, prompt) => {
    seen.push(prompt);
    if (prompt === "first") await new Promise((resolve) => { release = resolve; });
    return { sessionId: null, text: prompt };
  };
  const first = runtime.run("demo", "first");
  await wait(() => release);
  assert.equal(await runtime.queueToLocalSession(runtime.project("demo"), "second"), true);
  assert.deepEqual(seen, ["first"]);
  release();
  await first;
  await wait(() => seen.length === 2);
  await wait(async () => {
    await f.store.reload();
    return f.store.state.projects.demo.telegramRequests.length === 0;
  });
  assert.deepEqual(seen, ["first", "second"]);
});

test("simultaneous terminal launches have only one owner and cannot remove the winning socket", async (t) => {
  const f = await fixture(t);
  await f.bridge.stop();
  const first = new ClaudePanelBridge(await new StateStore(f.store.root).init(), f.project);
  const second = new ClaudePanelBridge(await new StateStore(f.store.root).init(), f.project);
  const results = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
  t.after(async () => { await first.stop(); await second.stop(); });
  assert.ok(await f.request("status"));
});

test("closing the native session cancels pending buttons without recording approval", async (t) => {
  const f = await fixture(t);
  const { approval } = await f.permission();
  await f.hook("SessionEnd");
  await f.store.reload();
  assert.equal(f.store.state.approvals.find((item) => item.id === approval.id).status, "cancelled");
  await assert.rejects(() => f.service.runtime.decideApproval(approval.id, "approve", 10, 9), /no longer pending/);
});

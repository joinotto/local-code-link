// Human-in-the-loop live test. Uses the existing daemon, real Bot API and native
// Claude. No fabricated Telegram updates, callbacks, or automatic approvals.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateStore, now } from "../src/state.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { claudeInteractiveArgs, runClaudeTerminal } from "../src/claude-terminal.mjs";
import { claudeRequest } from "../src/claude-ipc.mjs";
import { loadConfiguration } from "../src/config.mjs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
await loadConfiguration(repo);
const store = await new StateStore().init();
const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
const chatId = store.state.telegram.chatId;
assert.ok(chatId, "Telegram must already be configured");
// Establish a working read-only transport before an unsafe topic/message write.
await client.getMe();
const reuse = process.argv[2] === "--reuse-id" ? process.argv[3] : null;
const id = reuse || `claude-e2e-${randomUUID().slice(0, 8)}`;
let project = reuse ? store.state.projects[id] : null;
if (reuse) {
  assert.ok(project && id.startsWith("claude-e2e-")
    && path.basename(project.cwd).startsWith("lcl-tg-live-")
    && project.localSession?.status !== "active", "Only an inactive, previously generated test fixture may be reused");
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-tg-live-"));
  const topic = await client.createForumTopic(chatId, `Claude bridge E2E (${id.slice(-8)})`);
  project = { id, name: id, cwd: root, provider: "claude", linkId: randomUUID(),
    topicId: topic.message_thread_id, telegramChatId: chatId, status: "idle",
    sessionIds: {}, createdAt: now(), lastActiveAt: now() };
}
store.state.projects[id] = project;
await store.save();
const runtime = new CodingRuntime(await new StateStore(store.root).init(), {
  onDeleteTopic: (item) => client.deleteForumTopic(chatId, item.topicId),
});
const args = claudeInteractiveArgs(store, project, repo, null);
const index = args.indexOf("--settings") + 1;
args[index] = JSON.stringify({ ...JSON.parse(args[index]), permissions: { ask: ["Bash"] } });
let terminal;
const startArg = process.argv.indexOf("--start-at");
const cliDecisions = process.argv.includes("--cli-decisions");
const restartService = process.argv.includes("--restart-service");
const execute = promisify(execFile);
let restarted = false;
const startPhase = startArg === -1 ? 0 : Number(process.argv[startArg + 1]);
assert.ok([0, 1, 2].includes(startPhase), "start-at must be 0, 1 or 2");
let phase = startPhase;
let checking = false;
let activeRequest;
let submitted = false;
let failed;
const observed = [];
const startedAt = Date.now();
await client.sendMessage(chatId, [
  "🧪 Temporary native Claude bridge test. Your existing project sessions are unchanged.",
  ...(cliDecisions ? ["CLI-side test: please do not click its Telegram buttons; decisions will be entered in the temporary terminal."]
    : ["1. Click Approve once for printf hello.", "2. Click Deny for printf goodbye.",
      "3. Answer the framework question with its Telegram button."]),
  "Then this test will close its own Claude session. This topic remains until you /unlink it.",
].join("\n"), { topicId: project.topicId });
console.log(`Live Telegram test topic: ${project.name} (${project.topicId}). ${cliDecisions ? "Controlled CLI decisions enabled." : "Human clicks are required."}`);
const prompts = [
  "The account owner requested this harmless local bridge integration test. Use Bash exactly once "
    + "to run printf hello in this temporary project. Do not use other tools or retry. Report the result normally. "
    + "Keep the tool permission check; the owner will decide in Telegram.",
  "This is the second harmless local bridge integration test. Use Bash exactly once to run printf goodbye. "
    + "Do not use other tools or retry. If permission is denied, report that normally.",
  "Use AskUserQuestion to ask which framework to use: React or Vue. "
    + "Do not use other tools. After the answer reply QUESTION_TEST_OK and the selected framework.",
];
const timer = setInterval(async () => {
  if (checking || failed) return;
  checking = true;
  try {
    if (Date.now() - startedAt > 10 * 60_000) throw new Error("Live test timed out waiting for human Telegram clicks");
    const status = await claudeRequest(store.root, project, "status");
    if (!status.connected) return;
    await runtime.store.reload();
    const current = runtime.project(id);
    if (!submitted) {
      submitted = true;
      await client.sendMessage(chatId, cliDecisions ? `🧪 CLI-side step ${phase + 1}: please leave Telegram buttons untouched.` : phase === 0
        ? "🧪 Step: click APPROVE ONCE on the upcoming printf hello request."
        : phase === 1 ? "🧪 DENIAL TEST: click DENY (not Approve) on the upcoming printf goodbye request."
          : "🧪 QUESTION TEST: choose React or Vue using the upcoming answer button.",
      { topicId: project.topicId });
      await runtime.queueToLocalSession(current, prompts[phase]);
      await runtime.store.reload();
      activeRequest = runtime.project(id).telegramRequests.at(-1).id;
      return;
    }
    const approval = runtime.store.state.approvals.find((item) =>
      item.projectId === id && item.sessionId === current.sessionIds.claude
      && !observed.some((entry) => entry.id === item.id));
    if (!approval || !["approved", "denied"].includes(approval.status)
      || !current.claudeLastTelegramTurn
      || Date.parse(current.claudeLastTelegramTurn.finishedAt) < Date.parse(approval.resolvedAt)
      || current.telegramRequests?.length) return;
    assert.equal(approval.decidedVia, cliDecisions ? "cli" : "telegram", "The selected real interface must win this phase");
    assert.equal(approval.telegramDisplayStatus, approval.status, "Actual Bot API edit must remove resolved buttons");
    assert.equal(approval.status, phase === 1 ? "denied" : "approved");
    if (phase === 0) assert.equal(approval.toolOutcome, "succeeded", "Native Claude must actually execute the approved command");
    if (phase === 1) assert.equal(approval.providerObservedAt, undefined, "Denied command must not execute");
    if (phase === 2) assert.ok(["React", "Vue"].includes(approval.response.answer));
    observed.push({ id: approval.id, status: approval.status, via: approval.decidedVia, type: approval.type });
    phase++;
    if (phase === prompts.length) {
      await client.sendMessage(chatId, `✅ Live ${startPhase ? "remaining " : ""}tests passed: native result delivery and Telegram button cleanup. Send /unlink to remove this temporary topic and its test history.`, { topicId: project.topicId });
      console.log(`\nPASS: live ${cliDecisions ? "CLI decisions" : "human Telegram callbacks"} → native Bedrock Claude → results and button cleanup (${prompts.length - startPhase} phases).`);
      clearInterval(timer);
      terminal.write("/exit");
      setTimeout(() => terminal.write("\r"), 200);
    } else submitted = false;
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return;
    failed = error;
    clearInterval(timer);
    console.error(`Live test did not complete: ${error.message}`);
    terminal?.kill();
  } finally { checking = false; }
}, 250);
try {
  await runClaudeTerminal(store, project, process.env.CLAUDE_BIN || "claude", args, async (pid) => {
    project.localSession = { status: "active", pid, claudeBridgePid: process.pid, startedAt: now() };
    await store.save();
  }, {
    onTerminal: (value) => { terminal = value; },
    onPanel: (approval, panel) => {
      if (!cliDecisions || !approval) return;
      if (restartService && !restarted) {
        restarted = true;
        void (async () => {
          try {
            assert.equal(process.platform, "darwin");
            await store.reload();
            assert.ok(!store.state.approvals.some((a) => a.projectId !== id
              && ["pending", "responding"].includes(a.status)), "Another project has a pending approval");
            assert.ok(Object.values(store.state.projects).every((p) => p.id === id
              || (!p.backgroundTask && !p.telegramRequests?.length)), "Another project has background work");
            const lease = path.join(store.root, "telegram-service.lock");
            const oldPid = Number((await readFile(lease, "utf8")).split(":")[0]);
            await execute("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.local-code-link.telegram`]);
            const deadline = Date.now() + 60_000;
            let alive = false;
            while (Date.now() < deadline) {
              try {
                const pid = Number((await readFile(lease, "utf8")).split(":")[0]);
                process.kill(pid, 0);
                if (pid !== oldPid) { alive = true; break; }
              } catch { /* Wait for the new process lease. */ }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.ok(alive, "The restarted daemon must own a new lease");
            process.kill(terminal.pid, 0);
            const status = await claudeRequest(store.root, project, "status");
            assert.ok(status.connected && status.busy, "Actual native terminal must survive the daemon restart");
            await store.reload();
            assert.equal(store.state.approvals.find((item) => item.id === approval.id).status, "pending");
            assert.ok(["printf hello", "printf goodbye"].includes(approval.details.input.command));
            panel.handle(phase === 0 ? "a" : "d");
            console.log("\nPASS: actual native Claude terminal and pending approval survive the deployed daemon restart.");
          } catch (error) { failed = error; clearInterval(timer); terminal?.kill(); }
        })();
        return;
      }
      // Exercise the actual terminal-panel input handler, never native y/n
      // keystrokes or fabricated provider/Telegram responses. Auto-decisions
      // are limited to this explicitly requested harmless test fixture.
      if (approval.type === "question") {
        assert.ok(approval.details.question.options.some((option) => option.label === "React"));
        panel.handle("1\r");
      } else {
        assert.ok(["printf hello", "printf goodbye"].includes(approval.details.input.command),
          "The CLI test must never auto-approve an unexpected command");
        panel.handle(phase === 0 ? "a" : "d");
      }
    },
  });
  await store.reload();
  const current = store.state.projects[id];
  if (current) { current.localSession = { status: "stopped", stoppedAt: now() }; await store.save(); }
  if (failed) throw failed;
  assert.equal(observed.length, prompts.length - startPhase, "All selected human-in-the-loop phases must finish");
} finally {
  clearInterval(timer);
  runtime.stop();
  console.log(`Temporary test topic retained. To remove it: local-code-link unlink ${id}`);
}

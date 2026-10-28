// Manual real hardware sleep, not SIGSTOP or a simulated clock jump. Never
// invoke system sleep without a human present to wake the machine.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StateStore } from "../src/state.mjs";
import { CodexSharedClient } from "../src/codex-shared.mjs";
import { CodexTuiProxy } from "../src/codex-tui-proxy.mjs";
import { readPowerEvents } from "./power-events.mjs";
import { isBoundedSleepCommand, SLEEP_TEST_COMMAND } from "./sleep-fixture.mjs";
import { writeAcceptanceEvidence } from "./acceptance-evidence.mjs";

assert.equal(process.platform, "darwin", "This verifies macOS hardware power events");
const phase = process.argv[process.argv.indexOf("--phase") + 1];
assert.ok(["idle", "active", "approval"].includes(phase), "Use --phase idle|active|approval");
const root = await realpath(await mkdtemp("/tmp/lcl-sleep-live-"));
const evidenceFile = path.join(process.env.LCL_SLEEP_EVIDENCE_DIR || root, `${phase}.json`);
const evidence = { provider: "codex", phase, status: "preparing", startedAt: new Date().toISOString(),
  nodeVersion: process.versions.node };
await writeAcceptanceEvidence(evidenceFile, evidence);
const cwd = path.join(root, "project");
await mkdir(cwd);
const store = await new StateStore(path.join(root, "state")).init();
const project = { id: "sleep-test", name: "sleep-test", cwd, provider: "codex", linkId: "sleep-fixture",
  topicId: 9, status: "idle", sessionIds: {}, localSession: { status: "active" } };
store.state.projects[project.id] = project;
await store.save();
const proxy = new CodexTuiProxy(store, project);
await proxy.start();
const events = [];
const frontend = new CodexSharedClient({ socketPath: proxy.socketPath });
frontend.onMessage = (message) => events.push({ ...message, receivedAt: Date.now() });
let threadId;
let turnId;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; });
const wait = async (condition, label, timeout = 240_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Hardware test cancelled; cleaning up only its owned native turn.");
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}. This is not a passing hardware test.`);
};
try {
  await frontend.connect();
  const { thread } = await frontend.request("thread/start", { cwd, approvalPolicy: "untrusted",
    approvalsReviewer: "user", sandbox: "workspace-write" });
  assert.equal(await realpath(thread.cwd), cwd);
  threadId = thread.id;
  project.sessionIds.codex = threadId;
  await store.save();
  let approval;
  if (phase === "idle") {
    // thread/read/resume address persisted history, not an unused empty thread.
    // Complete a real no-tools turn before testing an idle conversation.
    const seeded = await frontend.request("turn/start", { threadId,
      input: [{ type: "text", text: "Do not use any tools or read/write files. Reply exactly SLEEP_IDLE_READY." }] });
    turnId = seeded.turn.id;
    await wait(() => events.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId),
      "idle fixture's real seed turn");
    const finished = events.find((m) => m.method === "turn/completed" && m.params.turn.id === turnId);
    assert.equal(finished.params.turn.status, "completed");
    assert.ok(events.some((m) => m.method === "item/completed" && m.params.turnId === turnId
      && m.params.item.type === "agentMessage" && /SLEEP_IDLE_READY/.test(m.params.item.text)));
    const stored = await frontend.request("thread/read", { threadId });
    assert.equal(stored.thread.id, threadId);
    turnId = undefined;
  } else {
    const prompt = phase === "active"
      ? `Owner-authorized sleep recovery test. Do not read/write files. Use exec_command exactly once for ${SLEEP_TEST_COMMAND}, with sandbox_permissions require_escalated and a sleep recovery justification. The test harness will interrupt this harmless command after the owner wakes the Mac. You may use write_stdin only to wait for that command. Never start another command.`
      : "Owner-authorized sleep recovery test. Do not read/write files. Use exec_command exactly once for /usr/bin/python3 -c 'print(\"LOCAL_CODE_LINK_SLEEP\")', with sandbox_permissions require_escalated and a sleep recovery justification. The owner will DENY after waking. Do not retry.";
    const started = await frontend.request("turn/start", { threadId,
      input: [{ type: "text", text: prompt }] });
    turnId = started.turn.id;
    await wait(async () => {
      await store.reload();
      approval = store.state.approvals.find((a) => a.turnId === turnId && a.status === "pending");
      return approval;
    }, "real native permission request");
    const command = approval.details?.command;
    if (phase === "active") {
      assert.ok(isBoundedSleepCommand(command), "Only the exact bounded sleep command may be approved");
      frontend.respond(approval.serverRequestId, { decision: "accept" });
      await wait(async () => {
        await store.reload();
        return store.state.approvals.find((a) => a.id === approval.id)?.status === "approved";
      }, "native acknowledgement of the bounded command approval");
      await wait(() => events.some((m) => m.method === "item/started"
        && m.params.turnId === turnId && m.params.item.type === "commandExecution"), "actual running command");
    } else {
      assert.ok(JSON.stringify(approval.details).includes("LOCAL_CODE_LINK_SLEEP"),
        "Only the harmless print request may be used");
    }
  }
  const baseline = new Set((await readPowerEvents()).map((event) => event.key));
  const readyAt = Date.now();
  Object.assign(evidence, { status: "ready", readyAt: new Date(readyAt).toISOString(), sessionId: threadId });
  await writeAcceptanceEvidence(evidenceFile, evidence);
  console.log(`READY FOR REAL SLEEP: ${phase}. Sleep this Mac for about 30 seconds, then manually wake it.`);
  let sleepEvent, wakeEvent;
  await wait(async () => {
    const fresh = (await readPowerEvents()).filter((event) => !baseline.has(event.key)
      && event.timestamp >= readyAt - 1000);
    sleepEvent = fresh.find((event) => event.type === "Sleep");
    wakeEvent = sleepEvent && fresh.find((event) => event.type === "Wake" && event.timestamp > sleepEvent.timestamp);
    return wakeEvent;
  }, "new real system Sleep and Wake events", 3_600_000);
  assert.ok(wakeEvent.timestamp - sleepEvent.timestamp >= 15_000, "Sleep at least 15 seconds; display sleep alone is not sufficient");
  if (phase === "active") {
    assert.ok(!events.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId
      && m.receivedAt < sleepEvent.timestamp + 1000),
    "The test command completed before sleep; this is not an active-turn sleep pass");
  }
  await frontend.connect();
  const saved = await frontend.request("thread/read", { threadId });
  assert.equal(saved.thread.id, threadId);
  assert.equal(await realpath(saved.thread.cwd), cwd);
  if (phase === "approval") {
    await store.reload();
    assert.equal(store.state.approvals.find((a) => a.id === approval.id).status, "pending");
    frontend.respond(approval.serverRequestId, { decision: "cancel" });
    await wait(async () => {
      await store.reload();
      return store.state.approvals.find((a) => a.id === approval.id)?.status === "denied";
    }, "native denial after hardware wake");
  }
  if (phase === "active" && !events.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId)) {
    // Do not make the owner wait for the long preparation grace command.
    // Exercise native interruption after wake, scoped to this exact test turn.
    await frontend.request("turn/interrupt", { threadId, turnId });
  }
  if (turnId) await wait(() => events.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId),
    "owned native turn completion");
  if (phase === "active") {
    assert.equal(events.filter((m) => m.method === "item/started" && m.params.turnId === turnId
      && m.params.item.type === "commandExecution").length, 1, "The command must not be replayed");
    const completion = events.find((m) => m.method === "turn/completed"
      && m.params.turn.id === turnId).params.turn.status;
    assert.ok(["completed", "interrupted"].includes(completion), "Native turn must recover or acknowledge scoped interruption");
    if (completion === "completed") {
      const execution = events.find((m) => m.method === "item/completed"
        && m.params.turnId === turnId && m.params.item.type === "commandExecution");
      assert.equal(execution?.params.item.exitCode, 0, "A naturally completed command must succeed");
    }
  } else if (phase === "approval") {
    const execution = events.find((m) => m.method === "item/completed"
      && m.params.turnId === turnId && m.params.item.type === "commandExecution");
    assert.notEqual(execution?.params.item.exitCode, 0, "The denied print command must not run successfully");
  }
  const resumed = await frontend.request("thread/resume", { threadId, cwd, excludeTurns: true });
  assert.equal(resumed.thread.id, threadId);
  Object.assign(evidence, { status: "passed", finishedAt: new Date().toISOString(),
    sleepAt: new Date(sleepEvent.timestamp).toISOString(), wakeAt: new Date(wakeEvent.timestamp).toISOString(),
    sameSession: true, sameProject: true,
    ...(phase === "active" ? { noReplay: true, activeDuringSleep: true } : {}),
    ...(phase === "approval" ? { pendingSurvived: true, deniedAfterWake: true } : {}) });
  await writeAcceptanceEvidence(evidenceFile, evidence);
  console.log(`PASS: actual hardware sleep/wake during ${phase}; ${Math.round((wakeEvent.timestamp - sleepEvent.timestamp) / 1000)} seconds; same native session${phase === "approval" ? " and shared denial" : ""}.`);
  console.log(`Evidence saved: ${evidenceFile}`);
} catch (error) {
  Object.assign(evidence, { status: "failed", finishedAt: new Date().toISOString() });
  await writeAcceptanceEvidence(evidenceFile, evidence);
  throw error;
} finally {
  if (threadId && turnId && !events.some((m) => m.method === "turn/completed" && m.params.turn.id === turnId)) {
    try {
      await frontend.connect();
      await frontend.request("turn/interrupt", { threadId, turnId });
    } catch { console.error("Owned sleep-test turn cleanup could not be confirmed; inspect this temporary fixture before retrying."); }
  }
  frontend.close();
  await proxy.stop();
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexHistoryBoundary, codexRequestMarker, findCodexHistoryResult } from "../src/codex-history.mjs";
import { StateStore } from "../src/state.mjs";
import { CodingRuntime } from "../src/runtime.mjs";

const user = (id) => ({ type: "userMessage", clientId: id,
  content: [{ type: "text", text: `${codexRequestMarker(id)}\nfixture prompt` }] });
const answer = (text, phase = "final_answer") => ({ type: "agentMessage", text, phase });
const entry = (turnId, item) => ({ turnId, item });
const request = { id: "request-1", sessionId: "thread-1", historyAfterTurnId: "boundary" };

test("paginated result crosses turn and item pages and excludes tool output and commentary", async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") {
      assert.equal(params.itemsView, "notLoaded");
      return params.cursor
        ? { data: [{ id: "target", status: "completed" }, { id: "boundary" }], nextCursor: null }
        : { data: [{ id: "unrelated", status: "completed" }], nextCursor: "turn-page-2" };
    }
    if (params.turnId === "unrelated") return { data: [entry("unrelated", answer("Wrong result"))] };
    return params.cursor
      ? { data: [entry("target", user(request.id))], nextCursor: null }
      : { data: [entry("target", answer("commentary", "commentary")),
        entry("target", { type: "commandExecution", aggregatedOutput: "private tool output" }),
        entry("target", answer("Correct final result"))], nextCursor: "item-page-2" };
  } };
  assert.deepEqual(await findCodexHistoryResult(client, request),
    { turnId: "target", output: "Correct final result" });
  assert.equal(calls.some(c => c.params.turnId === "boundary"), false);
  assert.ok(calls.every(c => c.params.threadId === request.sessionId));
});

test("a quoted marker in unrelated input cannot replace the actual request's client ID", async () => {
  const client = { request: async (method) => method === "thread/turns/list"
    ? { data: [{ id: "boundary", status: "completed" }], nextCursor: "older" }
    : { data: [entry("boundary", { ...user(request.id), clientId: "different-request" }),
      entry("boundary", answer("Do not deliver"))] } };
  assert.equal(await findCodexHistoryResult(client, request), null);
});

test("marker fallback supports missing client IDs and includes the active boundary turn", async () => {
  const client = { request: async (method) => method === "thread/turns/list"
    ? { data: [{ id: "boundary", status: "inProgress" }] }
    : { data: [entry("boundary", { ...user(request.id), clientId: null })] } };
  assert.deepEqual(await findCodexHistoryResult(client, request), { turnId: "boundary" });
});

for (const [status, expected] of [
  ["interrupted", /interrupted/], ["failed", /task failed/], ["completed", /^Completed\.$/],
]) {
  test(`paginated ${status} result is correlated and cannot leak intermediate output`, async () => {
    const client = { request: async (method) => method === "thread/turns/list"
      ? { data: [{ id: "target", status }] }
      : { data: [entry("target", user(request.id)),
        entry("target", answer("partial", "partial_answer"))] } };
    assert.match((await findCodexHistoryResult(client, request)).output, expected);
  });
}

test("invalid history pages and cross-turn items fail without returning a result", async () => {
  for (const mode of ["invalid", "cross-turn", "repeated-cursor"]) {
    const client = { request: async (method) => {
      if (mode === "invalid") return { data: null };
      if (method === "thread/turns/list") return { data: [{ id: "target", status: "completed" }] };
      return mode === "cross-turn" ? { data: [entry("another-turn", user(request.id))] }
        : { data: [], nextCursor: "same-cursor" };
    } };
    await assert.rejects(findCodexHistoryResult(client, request),
      /invalid history|unexpected turn|did not advance/);
  }
});

test("history capability check uses only a bounded page and tolerates an unmaterialized thread", async () => {
  const methods = [];
  const client = { request: async (method, params) => {
    methods.push(method);
    assert.equal(params.limit, 1);
    return { data: method === "thread/turns/list" ? [{ id: "boundary" }] : [] };
  } };
  assert.equal(await codexHistoryBoundary(client, request.sessionId), "boundary");
  assert.deepEqual(methods, ["thread/turns/list", "thread/items/list"]);
  client.request = async () => {
    throw Object.assign(new Error("thread is not materialized yet; thread/turns/list is unavailable before first user message"),
      { codexRejected: true });
  };
  assert.equal(await codexHistoryBoundary(client, request.sessionId), null);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-paginated-"));
  const store = await new StateStore(path.join(root, "state")).init();
  const project = { id: "fixture", linkId: "generation-1", topicId: 9,
    cwd: root, provider: "codex", status: "idle", sessionIds: { codex: "thread-1" } };
  store.state.projects[project.id] = project;
  await store.save();
  const queue = [], turns = [], calls = [], outputs = [];
  let turnStatus = "idle";
  const shared = { connect: async () => {}, close: () => {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread-1", cwd: root,
      historyMode: "paginated", ephemeral: false, path: null, status: { type: turnStatus } } };
    if (method === "thread/resume") return {};
    if (method === "thread/turns/list") return { data: turns.map(({ id, status }) => ({ id, status })) };
    if (method === "thread/items/list") {
      const turn = turns.find(x => x.id === params.turnId);
      return { data: turn ? turn.items.map(item => entry(turn.id, item)) : [] };
    }
    if (method === "thread/queue/add") {
      const queuedSubmission = { id: "queue-1", input: params.input, clientUserMessageId: params.clientUserMessageId };
      queue.push(queuedSubmission);
      return { queuedSubmission };
    }
    if (method === "thread/queue/list") return { data: [...queue] };
    if (method === "thread/queue/start") {
      const item = queue.shift();
      const turn = { id: "target", status: "inProgress", items: [user(item.clientUserMessageId)] };
      turns.unshift(turn);
      turnStatus = "active";
      return { turn };
    }
    throw new Error(`Unexpected method: ${method}`);
  } };
  const runtimes = [];
  const makeRuntime = () => {
    const runtime = new CodingRuntime(store, { codexShared: shared, pollMs: 10,
      onOutput: async (_p, text) => outputs.push(text) });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) runtime.stop();
    await Promise.allSettled(runtimes.flatMap(r => [...r.transcriptWatchers.values(), ...r.codexPumps.values()]));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, project, shared, calls, outputs, queue, turns, makeRuntime,
    complete: () => { turns[0].status = "completed"; turns[0].items.unshift(answer("Existing conversation reply")); turnStatus = "idle"; } };
}

async function eventually(condition) {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Condition was not reached");
}

test("existing paginated conversation accepts a prompt and returns its reply without a rollout or replacement", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime();
  await runtime.queueToLocalSession(f.project, "fixture prompt");
  await eventually(() => f.turns.length);
  assert.equal(f.project.telegramRequests[0].historyMode, "paginated");
  assert.equal(f.project.telegramRequests[0].transcriptPath, undefined);
  f.complete();
  await eventually(() => f.outputs.length);
  assert.deepEqual(f.outputs, ["Existing conversation reply"]);
  assert.equal(f.project.sessionIds.codex, "thread-1");
  assert.equal(f.calls.filter(x => x.method === "thread/queue/add").length, 1);
  assert.equal(f.calls.some(x => ["thread/start", "thread/fork"].includes(x.method)), false);
  assert.deepEqual(f.calls.find(x => x.method === "thread/resume").params, { threadId: "thread-1", excludeTurns: true });
});

test("paginated result recovery survives restart and history disconnect without replaying the prompt", async (t) => {
  const f = await fixture(t), first = f.makeRuntime();
  await first.queueToLocalSession(f.project, "fixture prompt");
  await eventually(() => f.turns.length);
  first.stop();
  await Promise.allSettled([...first.transcriptWatchers.values(), ...first.codexPumps.values()]);
  f.complete();
  const next = f.makeRuntime();
  const previous = f.shared.request;
  let failed = false;
  f.shared.request = async (method, params) => {
    if (method === "thread/items/list" && !failed) { failed = true; throw new Error("Disconnected fixture"); }
    return previous(method, params);
  };
  await next.recoverCodexRequests();
  await eventually(() => f.outputs.length);
  assert.equal(failed, true);
  assert.deepEqual(f.outputs, ["Existing conversation reply"]);
  assert.equal(f.calls.filter(x => x.method === "thread/queue/add").length, 1);
});

test("a native client can consume the paginated queue before queue/add returns", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime(), previous = f.shared.request;
  f.shared.request = async (method, params) => {
    const result = await previous(method, params);
    if (method === "thread/queue/add") {
      f.queue.shift();
      f.turns.unshift({ id: "native-turn", status: "completed",
        items: [answer("Native reply"), user(params.clientUserMessageId)] });
    }
    return result;
  };
  await runtime.queueToLocalSession(f.project, "fixture prompt");
  await eventually(() => f.outputs.length);
  assert.deepEqual(f.outputs, ["Native reply"]);
  assert.equal(f.calls.some(x => x.method === "thread/queue/start"), false);
});

test("uncertain paginated submission is recovered by client ID instead of resubmission", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime(), previous = f.shared.request;
  f.shared.request = async (method, params) => {
    const result = await previous(method, params);
    if (method === "thread/queue/add") {
      f.queue.shift();
      f.turns.unshift({ id: "accepted-turn", status: "completed",
        items: [answer("Accepted before disconnect"), user(params.clientUserMessageId)] });
      throw new Error("Disconnected after acceptance");
    }
    return result;
  };
  await assert.rejects(runtime.queueToLocalSession(f.project, "fixture prompt"), /Disconnected/);
  await eventually(() => f.outputs.length);
  assert.deepEqual(f.outputs, ["Accepted before disconnect"]);
  assert.equal(f.calls.filter(x => x.method === "thread/queue/add").length, 1);
});

test("a session change during paginated preflight is rejected before queue/add", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime(), previous = f.shared.request;
  f.shared.request = async (method, params) => {
    const result = await previous(method, params);
    if (method === "thread/items/list") {
      f.project.sessionIds.codex = "replacement";
      await f.store.save();
    }
    return result;
  };
  await assert.rejects(runtime.queueToLocalSession(f.project, "do not send"), /unexpected session|session changed/);
  assert.equal(f.calls.some(x => x.method === "thread/queue/add"), false);
});

test("changing a request's project binding prevents delivery of its old result", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime();
  await runtime.queueToLocalSession(f.project, "fixture prompt");
  await eventually(() => f.turns.length);
  f.project.sessionIds.codex = "replacement";
  await f.store.save();
  f.complete();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(f.outputs, []);
  assert.equal(f.project.telegramRequests.length, 1);
});

test("uncertain Telegram delivery retains the paginated result without resending or rerunning it", async (t) => {
  const f = await fixture(t), runtime = f.makeRuntime();
  let deliveries = 0;
  runtime.onOutput = async () => {
    deliveries++;
    throw Object.assign(new Error("Lost Telegram response"), { telegramAmbiguous: true });
  };
  await runtime.queueToLocalSession(f.project, "fixture prompt");
  await eventually(() => f.turns.length);
  f.complete();
  await eventually(() => f.project.telegramRequests[0]?.delivery?.state === "uncertain");
  await runtime.recoverCodexRequests();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(deliveries, 1);
  assert.equal(f.project.telegramRequests[0].output, "Existing conversation reply");
  assert.equal(f.calls.filter(x => x.method === "thread/queue/add").length, 1);
});

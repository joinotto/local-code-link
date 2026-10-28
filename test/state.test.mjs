import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.mjs";

test("concurrent project writers preserve mappings and unrelated approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-concurrent-"));
  const first = await new StateStore(root).init();
  const second = await new StateStore(root).init();
  first.state.projects.a = { id: "a", status: "idle" };
  second.state.projects.b = { id: "b", status: "idle" };
  first.state.approvals.push({ id: "approval-a", status: "pending" });
  second.state.approvals.push({ id: "approval-b", status: "pending" });
  await Promise.all([first.save(), second.save()]);
  await first.reload();
  assert.deepEqual(Object.keys(first.state.projects).sort(), ["a", "b"]);
  assert.deepEqual(first.state.approvals.map((item) => item.id).sort(), ["approval-a", "approval-b"]);
});

test("stale hook save cannot overwrite unlink or another approval decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-stale-hook-"));
  const main = await new StateStore(root).init();
  main.state.projects.a = { id: "a", status: "idle", localSession: { pid: 1 } };
  main.state.approvals.push({ id: "approval-a", status: "pending" });
  await main.save();
  const hook = await new StateStore(root).init();
  main.state.projects.a.status = "unlinked";
  main.state.approvals[0].status = "denied";
  await main.save();
  hook.state.projects.a.localSession.pid = 2;
  hook.state.approvals[0].notifiedAt = "now";
  await hook.save();
  await main.reload();
  assert.equal(main.state.projects.a.status, "unlinked");
  assert.equal(main.state.approvals[0].status, "denied");
  assert.equal(main.state.approvals[0].notifiedAt, "now");
});

test("completed request removal preserves requests added by another writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-requests-"));
  const first = await new StateStore(root).init();
  first.state.projects.a = { id: "a", telegramRequests: [{ id: "first", status: "queued" }] };
  await first.save();
  const second = await new StateStore(root).init();
  first.state.projects.a.telegramRequests = [];
  second.state.projects.a.telegramRequests.push({ id: "second", status: "queued" });
  await Promise.all([first.save(), second.save()]);
  await first.reload();
  assert.deepEqual(first.state.projects.a.telegramRequests.map((item) => item.id), ["second"]);
});

test("reload removes deleted fields without replacing live project references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-reload-fields-"));
  const first = await new StateStore(root).init();
  first.state.projects.a = { id: "a", lastError: "old error" };
  await first.save();
  const ref = first.state.projects.a;
  const second = await new StateStore(root).init();
  delete second.state.projects.a.lastError;
  await second.save();
  await first.reload();
  assert.equal(first.state.projects.a, ref);
  assert.equal("lastError" in ref, false);
});

test("unlink wins over a stale in-flight task completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-unlink-race-"));
  const first = await new StateStore(root).init();
  first.state.projects.a = { id: "a", status: "busy" };
  await first.save();
  const second = await new StateStore(root).init();
  first.state.projects.a.status = "unlinked";
  await first.save();
  second.state.projects.a.status = "idle";
  await second.save();
  await first.reload();
  assert.equal(first.state.projects.a.status, "unlinked");
});

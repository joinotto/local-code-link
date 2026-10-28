// Read-only monitor. The user sends real Telegram messages; the actual daemon
// must resume each inactive fixture and acknowledge a delivered result.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const file = path.join(process.env.LOCAL_CODE_LINK_HOME || path.join(os.homedir(), ".local-code-link"), "state.json");
const ids = process.argv.slice(2);
assert.ok(ids.length && ids.every((id) => /^(claude|codex)-e2e-[0-9a-f]{8}$/.test(id)),
  "Specify only the temporary test-project IDs");
const baseline = JSON.parse(await readFile(file, "utf8"));
for (const id of ids) {
  const project = baseline.projects[id];
  assert.ok(project, "Test fixture must exist");
  assert.equal(project.localSession?.status, "stopped", "Close the test terminal before testing inactive resume");
}
console.log(`Send hi in each Telegram test topic: ${ids.join(", ")}. No sessions are opened by this monitor.`);
const passed = new Set();
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline && passed.size < ids.length) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const state = JSON.parse(await readFile(file, "utf8"));
  for (const id of ids) {
    if (passed.has(id)) continue;
    const project = state.projects[id];
    const result = project?.lastTelegramResult;
    if (!result || result.requestId === baseline.projects[id].lastTelegramResult?.requestId) continue;
    assert.equal(result.provider, project.provider);
    assert.equal(result.sessionId, baseline.projects[id].sessionIds[project.provider],
      "Inactive prompt must resume the exact saved project session");
    assert.ok(!project.telegramRequests?.some((item) => item.id === result.requestId));
    assert.ok(!project.claudeOutbox?.some((item) => item.id === result.requestId));
    assert.notEqual(project.status, "error", "An error message is not a successful inference result");
    passed.add(id);
    console.log(`PASS: actual Telegram prompt → inactive ${project.provider} same-session resume → acknowledged Telegram result (${id}).`);
  }
}
assert.equal(passed.size, ids.length, "Not all inactive-session flows were exercised");

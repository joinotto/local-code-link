// Real-provider smoke test; no Telegram callbacks are fabricated. Native mode
// uses an isolated project/state and leaves consent/tool choices to the user.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeStreamClient } from "../src/claude-stream.mjs";
import { StateStore } from "../src/state.mjs";
import { claudeInteractiveArgs, runClaudeTerminal } from "../src/claude-terminal.mjs";
import { claudeRequest } from "../src/claude-ipc.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { PROVIDER_ENV_KEYS, resolveProviderEnvironment } from "../src/provider-environment.mjs";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "lcl-live-"));
const command = process.env.CLAUDE_BIN || "claude";
const native = process.argv.includes("--native");
let env = process.env;
if (process.argv.includes("--background-env")) {
  const launchdEnvironment = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete launchdEnvironment[key];
  env = await resolveProviderEnvironment({ env: launchdEnvironment });
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, process.env.CLAUDE_CODE_USE_BEDROCK,
    "Background provider must match the terminal provider");
}
if (!native) {
  let requests = 0;
  const client = new ClaudeStreamClient({
    command, env, cwd: root, timeoutMs: 90_000,
    extraArgs: ["--settings", JSON.stringify({ permissions: { ask: ["Bash"] } })],
    onApproval: async (request) => {
      assert.equal(request.tool_name, "Bash");
      assert.match(request.input.command, /LOCAL_CODE_LINK_SMOKE/);
      requests++;
      return "deny";
    },
  });
  const result = await client.run(
    "Use Bash exactly once to run printf LOCAL_CODE_LINK_SMOKE. Do not use any other tools. "
    + "If permission is denied, do not retry. Respond DENIED when denied."
  );
  assert.equal(requests, 1, "Real Claude must request permission over stdio");
  assert.match(result.text, /DENIED/i);
  assert.ok(result.sessionId);
  const resumed = await new ClaudeStreamClient({
    command, env, cwd: root, sessionId: result.sessionId, timeoutMs: 90_000,
    onApproval: async () => "deny",
  }).run("Do not use any tools. Reply exactly RESUMED.");
  assert.equal(resumed.sessionId, result.sessionId);
  assert.match(resumed.text, /RESUMED/);
  console.log(`PASS: real Claude stdio permission denial and exact-session resume${process.argv.includes("--background-env") ? " from a credential-free launchd-like environment" : ""}.`);
} else {
  const store = await new StateStore(path.join(root, "state")).init();
  const project = { id: "smoke", name: "smoke", cwd: root, topicId: 9,
    linkId: "isolated-smoke", provider: "claude", status: "idle", sessionIds: {} };
  store.state.projects.smoke = project;
  await store.save();
  const args = claudeInteractiveArgs(store, project,
    fileURLToPath(new URL("..", import.meta.url)), null);
  const settingsIndex = args.indexOf("--settings") + 1;
  args[settingsIndex] = JSON.stringify({
    ...JSON.parse(args[settingsIndex]), permissions: { ask: ["Bash"] },
  });
  console.log("Isolated native terminal-panel smoke test. Review this project's LocalCodeLink hooks if prompted.");
  console.log("A harmless bridge message will be sent once ready. Close Claude with /exit after it replies.");
  const runtime = new CodingRuntime(await new StateStore(store.root).init(), {
    onOutput: async (_project, text) => console.log(`\nTERMINAL BRIDGE RESULT: ${text}\n`),
  });
  let submitted = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const status = await claudeRequest(store.root, project, "status");
      if (status.connected && !submitted) {
        submitted = true;
        await runtime.queueToLocalSession(runtime.project("smoke"),
          "Do not use tools. Reply exactly NATIVE_PANEL_OK.");
      }
      await runtime.deliverClaudeOutbox();
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) console.error(error.message);
    } finally { checking = false; }
  }, 500);
  try {
    await runClaudeTerminal(store, project, command, args, async () => {});
    await store.reload();
    console.log(`Native session tracked: ${Boolean(store.state.projects.smoke.sessionIds.claude)}`);
  } finally { clearInterval(timer); runtime.stop(); }
}

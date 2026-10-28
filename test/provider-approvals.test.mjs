import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ClaudeStreamClient } from "../src/claude-stream.mjs";
import { CodexAppServerClient } from "../src/codex-app-server.mjs";

function captureWrites(client) {
  const writes = [];
  client.child = {
    stdin: {
      write(line) {
        writes.push(JSON.parse(line));
      },
    },
  };
  return writes;
}

test("legacy Codex PermissionRequest hook returns immediately without initializing bridge state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-hook-no-block-"));
  const blockedState = path.join(root, "not-a-directory");
  await writeFile(blockedState, "fixture");
  const script = new URL("../src/codex-permission-hook.mjs", import.meta.url);
  const child = spawn(process.execPath, [script.pathname], {
    env: { ...process.env, LOCAL_CODE_LINK_HOME: blockedState },
    timeout: 2000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", cwd: root }));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {});
});

test("Codex approval callbacks return approve-once and never persistent approval", async () => {
  const client = new CodexAppServerClient({
    command: "codex",
    cwd: "/tmp",
    onApproval: async () => "approve",
  });
  const writes = captureWrites(client);

  await client.handle({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: { command: "npm publish" },
  });

  assert.deepEqual(writes, [{ id: 41, result: { decision: "accept" } }]);
});

test("Codex permission denial grants no extra permissions", async () => {
  const client = new CodexAppServerClient({
    command: "codex",
    cwd: "/tmp",
    onApproval: async () => "deny",
  });
  const writes = captureWrites(client);

  await client.handle({
    id: "permission-1",
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  });

  assert.deepEqual(writes, [{
    id: "permission-1",
    result: { permissions: {}, scope: "turn" },
  }]);
});

test("Claude permission callbacks return allow-once without persistent rules", async () => {
  const client = new ClaudeStreamClient({
    command: "claude",
    cwd: "/tmp",
    onApproval: async () => "approve",
  });
  const writes = captureWrites(client);

  await client.handle({
    type: "control_request",
    request_id: "request-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "npm test" },
    },
  });

  assert.deepEqual(writes, [{
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "request-1",
      response: {
        behavior: "allow",
        updatedInput: { command: "npm test" },
        updatedPermissions: [],
      },
    },
  }]);
});

test("Codex app-server transport starts a thread and returns its final message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-codex-server-"));
  const executable = path.join(root, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  }
});
`);
  await chmod(executable, 0o755);
  const client = new CodexAppServerClient({
    command: executable,
    cwd: root,
    onApproval: async () => "deny",
  });

  const result = await client.run("test", null, "edit");

  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.text, "done");
});

test("Claude streaming transport returns its final result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-code-link-claude-stream-"));
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  if (!process.argv.includes("--verbose") || !process.argv.includes("--permission-prompt-tool")
    || !process.argv.includes("stdio")) process.exit(2);
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session-1",
    result: "done"
  }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const client = new ClaudeStreamClient({
    command: executable,
    cwd: root,
    onApproval: async () => "deny",
  });

  const result = await client.run("test", "edit");

  assert.equal(result.sessionId, "claude-session-1");
  assert.equal(result.text, "done");
});

test("Claude zero-code exit without a result fails immediately instead of hanging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-claude-empty-"));
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(executable, 0o755);
  const client = new ClaudeStreamClient({ command: executable, cwd: root, timeoutMs: 2000 });
  await assert.rejects(() => client.run("test"), /before returning a result|EPIPE/);
});

test("Claude interruption uses the protocol instead of terminating the session process", () => {
  const client = new ClaudeStreamClient({ command: "claude", cwd: "/tmp" });
  const writes = captureWrites(client);
  client.child.exitCode = null;
  assert.equal(client.interrupt(), true);
  assert.equal(writes[0].request.subtype, "interrupt");
});

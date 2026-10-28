// Bounded tests against real providers/Telegram. No global credentials or network
// settings are changed. The HTTP CONNECT outage affects only this test process.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClaudeStreamClient } from "../src/claude-stream.mjs";
import { resolveProviderEnvironment, exportedClaudeProvider } from "../src/provider-environment.mjs";
import { StateStore } from "../src/state.mjs";
import { CodingRuntime } from "../src/runtime.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import { retryDelivery } from "../src/delivery.mjs";
import { loadConfiguration } from "../src/config.mjs";
import { fileURLToPath } from "node:url";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const credentials = process.argv.includes("--credentials");
const network = process.argv.includes("--network");
assert.ok(credentials || network, "Specify --credentials and/or --network");
await loadConfiguration(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(path.join(os.tmpdir(), "lcl-operational-"));
const environment = await resolveProviderEnvironment();
const command = process.env.CLAUDE_BIN || "claude";
const run = (env, sessionId) => new ClaudeStreamClient({
  command, cwd: root, env, sessionId, timeoutMs: 90_000,
  onApproval: async () => "deny",
});
const first = await run(environment).run("Do not use any tools. Reply exactly OPERATIONAL_OK.");
assert.match(first.text, /OPERATIONAL_OK/);
assert.ok(first.sessionId);
if (credentials) {
  assert.equal(exportedClaudeProvider(environment), "bedrock",
    "Credential fault injection is implemented only for this deployment's Bedrock mode");
  const invalid = { ...environment, AWS_ACCESS_KEY_ID: "ASIALCLINVALID0000000",
    AWS_SECRET_ACCESS_KEY: "LOCAL_CODE_LINK_INVALID_TEST_SECRET",
    AWS_SESSION_TOKEN: "LOCAL_CODE_LINK_INVALID_TEST_SESSION",
    AWS_BEARER_TOKEN_BEDROCK: "LOCAL_CODE_LINK_INVALID_TEST_BEARER",
    // Installed CLI's retry control: only the deliberately invalid test child
    // disables retries. Never wait ten retries to classify an auth rejection.
    CLAUDE_CODE_MAX_RETRIES: "0" };
  const failed = run(invalid, first.sessionId);
  let rejection;
  try { await failed.run("Do not use any tools. Reply exactly AUTH_SHOULD_REJECT."); }
  catch (error) { rejection = error; }
  assert.ok(rejection, "Native provider did not reject injected invalid credentials; this is not an auth recovery pass");
  assert.ok(/expired|invalid|security token|unauthori[sz]ed|access.?denied|authentication|credential|403/i.test(rejection.message),
    "The failure must be authentication-related, not an unrelated transport error");
  const refreshed = await resolveProviderEnvironment();
  const restored = await run(refreshed, first.sessionId).run(
    "Do not use any tools. Reply exactly AUTH_RECOVERED.");
  assert.equal(restored.sessionId, first.sessionId);
  assert.match(restored.text, /AUTH_RECOVERED/);
  console.log("PASS: real Bedrock credential rejection followed by trusted-shell refresh and exact-session resume.");
  console.log("This injects invalid credentials only in the test child; it does not claim natural token expiry or rotate real credentials.");
}

if (network) {
  const settings = process.env;
  const deployed = await new StateStore().init();
  const direct = new TelegramClient(settings.TELEGRAM_BOT_TOKEN);
  await direct.getMe();
  const topic = await direct.createForumTopic(deployed.state.telegram.chatId, "LocalCodeLink network acceptance");
  assert.notEqual(Number(topic.message_thread_id), Number(deployed.state.telegram.controlTopicId));
  const originalProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const original = Object.fromEntries(["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]
    .map((key) => [key, process.env[key]]));
  const sockets = new Set();
  let offline = false;
  const upstream = () => new Promise((resolve, reject) => {
    if (!originalProxy) {
      const socket = connect(443, "api.telegram.org", () => resolve({ socket, head: Buffer.alloc(0) }));
      socket.once("error", reject);
      socket.setTimeout(15_000, () => socket.destroy(new Error("Test upstream connection timed out")));
      return;
    }
    const url = new URL(originalProxy);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: "CONNECT", path: "api.telegram.org:443",
      headers: url.username || url.password ? {
        "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`,
      } : {},
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error("Test upstream proxy rejected connection")); }
      else resolve({ socket, head });
    });
    request.once("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("Test upstream proxy timed out")));
    request.end();
  });
  const proxy = createServer((_req, res) => res.writeHead(404).end());
  proxy.on("connect", async (req, client, head) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    if (offline || req.url !== "api.telegram.org:443") {
      client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const next = await upstream();
      if (client.destroyed || offline) { next.socket.destroy(); return; }
      sockets.add(next.socket);
      next.socket.on("error", () => client.destroy());
      next.socket.on("close", () => sockets.delete(next.socket));
      client.on("close", () => next.socket.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (next.head.length) client.write(next.head);
      if (head.length) next.socket.write(head);
      client.pipe(next.socket).pipe(client);
    } catch { client.destroy(); }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  process.env.HTTPS_PROXY = process.env.https_proxy = proxyUrl;
  process.env.NO_PROXY = process.env.no_proxy = "";
  const client = new TelegramClient(settings.TELEGRAM_BOT_TOKEN);
  const store = await new StateStore(path.join(root, "state")).init();
  const project = { id: "network-test", name: "network-test", cwd: root, provider: "claude",
    topicId: topic.message_thread_id, status: "idle", sessionIds: { claude: first.sessionId },
    telegramRequests: [{ id: "network-result", status: "active" }],
    claudeOutbox: [{ id: "network-result", text: `Network recovery test: ${first.text}` }] };
  store.state.projects[project.id] = project;
  await store.save();
  let deliveries = 0;
  const runtime = new CodingRuntime(store, { onOutput: async (_project, text) => {
    deliveries++;
    return client.sendMessage(deployed.state.telegram.chatId, text, { topicId: project.topicId });
  } });
  runtime.run = async () => assert.fail("Transport recovery must not rerun provider work");
  try {
    await client.getMe();
    offline = true;
    for (const socket of sockets) socket.destroy();
    await assert.rejects(client.getMe(), /Could not reach Telegram/);
    await runtime.deliverClaudeOutbox();
    await store.reload();
    assert.equal(project.claudeOutbox[0].delivery.state, "uncertain");
    console.log("Temporary test transport is offline for 60 seconds; your real bridge/network is unchanged.");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { await wait(1000); await runtime.deliverClaudeOutbox(); }
    assert.equal(deliveries, 1, "Uncertain writes must not retry during the outage");
    offline = false;
    await client.getMe();
    retryDelivery(project.claudeOutbox[0]);
    await store.save();
    await runtime.deliverClaudeOutbox();
    await store.reload();
    assert.equal(deliveries, 2);
    assert.equal(project.claudeOutbox.length, 0);
    assert.equal(project.telegramRequests.length, 0);
    assert.equal(project.lastTelegramResult.sessionId, first.sessionId);
    console.log("PASS: real Telegram network isolation, 60-second outage, held native result and acknowledged delivery recovery without rerunning work.");
  } finally {
    runtime.stop();
    client.stop();
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await direct.deleteForumTopic(deployed.state.telegram.chatId, topic.message_thread_id);
    direct.stop();
    console.log("Removed only the temporary network acceptance topic and its messages.");
  }
}

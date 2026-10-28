import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CodexSharedClient } from "../src/codex-shared.mjs";

test("shared Codex client distinguishes a received RPC rejection from an uncertain timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-rpc-"));
  const socketPath = path.join(root, "backend.sock");
  const backend = createServer();
  const wss = new WebSocketServer({ server: backend });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data);
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      } else if (request.method === "thread/queue/add" && request.params.threadId === "ephemeral") {
        socket.send(JSON.stringify({ id: request.id, error: {
          code: -32600, message: "ephemeral thread does not support queued submissions: ephemeral",
        } }));
      }
      // Intentionally leave the other queue request unanswered.
    });
  });
  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(socketPath, resolve);
  });
  const client = new CodexSharedClient({ socketPath, timeoutMs: 2000 });
  try {
    await client.connect();
    await assert.rejects(client.request("thread/queue/add", { threadId: "ephemeral" }),
      (error) => error.codexRejected === true && error.code === -32600);
    client.timeoutMs = 50;
    await assert.rejects(client.request("thread/queue/add", { threadId: "unknown" }),
      (error) => error.codexRejected !== true && /timed out/.test(error.message));
  } finally {
    client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  }
});

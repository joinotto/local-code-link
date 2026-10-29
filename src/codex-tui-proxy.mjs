import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, WebSocket as UpstreamWebSocket } from "undici";
import { WebSocketServer } from "ws";
import { CodexSharedClient } from "./codex-shared.mjs";
import { sameProjectDirectory } from "./session-scope.mjs";
import {
  approvalDecisionNotice, claimCodexApproval, CODEX_REQUEST_METHODS, decisionFromCodexResult,
  localApprovalActor, registerCodexApproval, resolveCodexApproval,
} from "./approval-sync.mjs";

export function tuiSocketPath(root, project) {
  const key = createHash("sha256")
    .update(`${project.linkId || project.topicId}:${process.pid}`).digest("hex").slice(0, 20);
  return path.join(root, "tui", `${key}.sock`);
}

// Per-terminal relay: a Telegram daemon restart does not disconnect the TUI.
// The relay never approves on its own or suppresses the native approval dialog.
export class CodexTuiProxy {
  constructor(store, project, options = {}) {
    this.store = store;
    this.project = project;
    this.projectCwd = project.cwd;
    this.socketPath = options.socketPath || tuiSocketPath(store.root, project);
    this.upstreamPath = options.upstreamPath || process.env.CODEX_APP_SERVER_SOCKET
      || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "app-server-control", "app-server-control.sock");
    this.pollMs = options.pollMs || 150;
    this.connections = new Set();
    this.metadata = options.metadata || new CodexSharedClient({ socketPath: this.upstreamPath });
  }

  async start() {
    if (Buffer.byteLength(this.socketPath) > 100) {
      throw new Error("LocalCodeLink's Unix socket path is too long. Use a shorter LOCAL_CODE_LINK_HOME directory.");
    }
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this.server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.server.on("upgrade", (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (client) => this.bridge(client));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
    return this.socketPath;
  }

  bridge(client) {
    const agent = new Agent({ connect: { socketPath: this.upstreamPath } });
    const upstream = new UpstreamWebSocket("ws://localhost/", { dispatcher: agent });
    const entries = new Map();
    const threadRequests = new Map();
    const startedItems = new Map();
    const resolvedApprovalRequests = new Set();
    const outgoing = [];
    let open = false;
    let closed = false;
    const send = (message) => {
      if (upstream.readyState === UpstreamWebSocket.OPEN) upstream.send(JSON.stringify(message));
    };
    const connection = { client, upstream };
    this.connections.add(connection);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      this.connections.delete(connection);
      upstream.close();
      client.close();
      void agent.destroy();
    };
    const respond = (entry, message) => {
      // A poll can forward a stored decision while the native response is
      // awaiting its disk claim. Recheck here, after all awaits, so both paths
      // share one synchronous send guard.
      if (entry.resolved || entry.responded
        || upstream.readyState !== UpstreamWebSocket.OPEN) return;
      entry.responded = true;
      try { send(message); }
      catch (error) {
        entry.responded = false;
        throw error;
      }
    };
    const answer = async (entry, message) => {
      await entry.ready;
      if (entry.resolved || entry.responded) return;
      await this.store.reload();
      const approval = this.store.state.approvals.find((item) => item.id === entry.approvalId);
      const linkedProject = approval && this.store.state.projects[approval.projectId];
      if (!approval || approval.canReply === false || !linkedProject || ["unlinked", "archived"].includes(linkedProject.status)) {
        // Unlink revokes Telegram access, not direct native CLI approval.
        respond(entry, message);
        return;
      }
      try {
        await claimCodexApproval(this.store, approval.id,
          decisionFromCodexResult(message.result), localApprovalActor(), "cli", message.result);
        respond(entry, message);
      } catch {
        // Telegram won. Its exact response is sent on this same provider channel.
        await forwardClaim(entry);
      }
    };
    const forwardClaim = async (entry) => {
      if (entry.resolved || entry.responded) return;
      const approval = this.store.state.approvals.find((item) => item.id === entry.approvalId);
      if (approval?.status !== "responding" || !approval.response) return;
      respond(entry, { id: entry.requestId, result: approval.response });
    };
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || closed || !entries.size) return;
      checking = true;
      try {
        await this.store.reload();
        for (const entry of entries.values()) {
          await entry.ready;
          await forwardClaim(entry);
        }
      } catch (error) {
        console.error(`LocalCodeLink approval relay: ${error.message}`);
      } finally { checking = false; }
    }, this.pollMs);
    timer.unref();
    upstream.addEventListener("open", () => {
      open = true;
      for (const message of outgoing.splice(0)) upstream.send(message);
    });
    upstream.addEventListener("message", (event) => {
      if (client.readyState !== client.OPEN) return;
      const raw = String(event.data);
      let message;
      try { message = JSON.parse(raw); } catch { client.send(raw); return; }
      const threadRequest = !message.method && threadRequests.get(String(message.id));
      if (threadRequest) {
        threadRequests.delete(String(message.id));
        if (message.result?.thread) {
          void this.trackThread(message.result.thread).catch((error) =>
            console.error(`LocalCodeLink session tracking: ${error.message}`));
        }
      }
      if (message.method === "item/started" && message.params?.item?.id) {
        const key = `${message.params.threadId}:${message.params.turnId}:${message.params.item.id}`;
        startedItems.set(key, message.params.item);
        if (startedItems.size > 512) startedItems.delete(startedItems.keys().next().value);
      }
      if (message.id !== undefined && CODEX_REQUEST_METHODS.has(message.method)) {
        resolvedApprovalRequests.delete(String(message.id));
        const entry = { requestId: message.id, responded: false, resolved: false };
        entries.set(String(message.id), entry);
        const key = `${message.params.threadId}:${message.params.turnId}:${message.params.itemId}`;
        const item = startedItems.get(key);
        const tracked = item?.type === "fileChange"
          ? { ...message, params: { ...message.params, proposedChanges: item.changes } } : message;
        entry.ready = this.register(tracked)
          .then((approval) => { entry.approvalId = approval?.id; })
          .catch((error) => console.error(`LocalCodeLink approval tracking: ${error.message}`));
      }
      if (message.method === "serverRequest/resolved") {
        const entry = entries.get(String(message.params?.requestId));
        if (entry) {
          entry.resolved = true;
          resolvedApprovalRequests.add(String(entry.requestId));
          if (resolvedApprovalRequests.size > 1024) {
            resolvedApprovalRequests.delete(resolvedApprovalRequests.values().next().value);
          }
          void entry.ready.then(() => resolveCodexApproval(this.store, entry.approvalId))
            .then((approval) => {
              const notice = approvalDecisionNotice(approval);
              if (notice && client.readyState === client.OPEN) {
                // Bridge-local display notice only: never sent to the provider,
                // never injected into the model's conversation or user input.
                client.send(JSON.stringify({ method: "warning", params: {
                  threadId: message.params.threadId, message: notice,
                } }));
              }
            })
            .catch(console.error).finally(() => entries.delete(String(entry.requestId)));
        }
      }
      // Show the original request/resolution in Codex immediately, not after a
      // Telegram API call or a disk write.
      client.send(raw);
    });
    client.on("message", (data) => {
      const raw = data.toString();
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.id !== undefined && !message.method
        && resolvedApprovalRequests.has(String(message.id))) return;
      const entry = message.id !== undefined && !message.method
        ? entries.get(String(message.id)) : null;
      if (entry) {
        void answer(entry, message).catch(console.error);
      } else if (message.method === "initialize") {
        // The bridge uses explicit historyMode for JSONL/TUI compatibility.
        // This opts this private connection into protocol fields, not broader
        // tool permissions; native approval/sandbox policy remains untouched.
        const initialized = JSON.stringify({ ...message, params: {
          ...message.params,
          capabilities: { ...message.params?.capabilities, experimentalApi: true },
        } });
        if (open) upstream.send(initialized);
        else outgoing.push(initialized);
      } else if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
        void this.scopeThreadRequest(message).then((scoped) => {
          if (closed) return;
          threadRequests.set(String(scoped.id), scoped.method);
          const scopedRaw = JSON.stringify(scoped);
          if (open) upstream.send(scopedRaw);
          else outgoing.push(scopedRaw);
        }).catch((error) => {
          if (client.readyState === client.OPEN) client.send(JSON.stringify({
            id: message.id, error: { code: -32602, message: error.message },
          }));
        });
      } else if (open) {
        upstream.send(raw);
      } else {
        outgoing.push(raw);
      }
    });
    client.on("close", close);
    client.on("error", close);
    upstream.addEventListener("close", close);
    upstream.addEventListener("error", close);
  }

  async scopeThreadRequest(message) {
    const params = message.params || {};
    if (params.cwd && !await sameProjectDirectory(params.cwd, this.projectCwd)) {
      throw new Error("This LocalCodeLink session is scoped to its project folder. Open the other project separately.");
    }
    if (["thread/resume", "thread/fork"].includes(message.method)) {
      await this.metadata.connect();
      const { thread } = await this.metadata.request("thread/read", {
        threadId: params.threadId, includeTurns: false,
      });
      if (thread?.id !== params.threadId
        || !await sameProjectDirectory(thread.cwd, this.projectCwd)) {
        throw new Error("Refusing to resume or fork another project's Codex session.");
      }
    }
    // Remote servers can have a different default cwd from the invoking
    // terminal. Set it explicitly even if the native client omitted it.
    return { ...message, params: {
      ...params, cwd: this.projectCwd,
      // Remote TUI clients may request memory-only threads. Linked sessions
      // need durable history and the shared queue used by Telegram. Resuming
      // an existing thread does not change its persistence.
      ...(["thread/start", "thread/fork"].includes(message.method) ? { ephemeral: false } : {}),
      ...(message.method === "thread/start" ? { historyMode: "legacy" } : {}),
    } };
  }

  async trackThread(thread) {
    if (!thread.id || !await sameProjectDirectory(thread.cwd, this.projectCwd)) return;
    await this.store.reload();
    const project = this.store.state.projects[this.project.id];
    if (!project || project.linkId !== this.project.linkId
      || project.topicId !== this.project.topicId
      || ["unlinked", "archived"].includes(project.status)) return;
    project.sessionIds ||= {};
    project.sessionIds.codex = thread.id;
    if (project.localSession) project.localSession.sessionId = thread.id;
    await this.store.save();
  }

  async register(message) {
    await this.store.reload();
    const project = this.store.state.projects[this.project.id];
    if (!project || project.topicId !== this.project.topicId
      || ["unlinked", "archived"].includes(project.status)) return null;
    await this.metadata.connect();
    let threadId = message.params.threadId;
    for (let depth = 0; depth < 10 && threadId; depth++) {
      const { thread } = await this.metadata.request("thread/read", { threadId });
      if (path.resolve(thread.cwd) === path.resolve(project.cwd)) {
        return registerCodexApproval(this.store, project, message, "codex-proxy",
          { relayPid: process.pid, relaySocket: this.socketPath });
      }
      // Subagents may have their own thread id/cwd but belong to the linked
      // session tree. An unrelated resumed project must never be mirrored here.
      threadId = thread.parentThreadId;
    }
    return null;
  }

  async stop() {
    this.metadata.close?.();
    for (const { client, upstream } of this.connections) {
      client.close();
      upstream.close();
    }
    this.wss?.close();
    if (this.server?.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    await this.store.reload();
    for (const approval of this.store.state.approvals) {
      if (approval.source === "codex-proxy" && approval.relaySocket === this.socketPath
        && approval.status === "pending") {
        approval.status = "cancelled";
        approval.resolvedAt = new Date().toISOString();
      }
    }
    await this.store.save();
  }
}

import net from "node:net";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claudeRequest, claudeSocketPath } from "./claude-ipc.mjs";
import { now } from "./state.mjs";
import { sameProjectDirectory } from "./session-scope.mjs";

const linked = (project) => project && !["unlinked", "archived"].includes(project.status);

export class ClaudeNativeBridge {
  constructor(store, project, options = {}) {
    this.store = store;
    this.projectId = project.id;
    this.linkId = project.linkId || project.topicId;
    this.cwd = project.cwd;
    this.socketPath = claudeSocketPath(store.root, project);
    this.interrupt = options.interrupt || (() => false);
    this.permissionInputs = [];
    this.lastChannelSeen = 0;
    this.serial = Promise.resolve();
    this.clients = new Set();
  }

  async start() {
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this.lockPath = `${this.socketPath}.lock`;
    this.lockOwner = `${process.pid}:${randomUUID()}`;
    try {
      await writeFile(this.lockPath, this.lockOwner, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(this.lockPath, "utf8");
      const pid = Number(owner.split(":")[0]);
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (cause) { if (cause.code === "ESRCH") alive = false; }
      }
      if (alive) throw new Error("This project already has an active linked Claude terminal. Use it or Telegram.");
      if (await readFile(this.lockPath, "utf8") !== owner) throw new Error("Claude terminal ownership changed; retry");
      await unlink(this.lockPath);
      await writeFile(this.lockPath, this.lockOwner, { flag: "wx", mode: 0o600 });
    }
    this.lockHeld = true;
    try {
    try {
      const status = await claudeRequest(this.store.root, this.store.state.projects[this.projectId], "status");
      if (status) throw new Error("This project already has an active linked Claude terminal. Use that terminal or Telegram.");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      await unlink(this.socketPath).catch((cause) => { if (cause.code !== "ENOENT") throw cause; });
    }
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => this.clients.delete(socket));
      socket.setTimeout(10_000, () => socket.destroy());
      let buffer = "";
      let received = false;
      socket.on("data", (chunk) => {
        if (received) return;
        buffer += chunk;
        if (buffer.length > 2_000_000) return socket.destroy();
        if (!buffer.includes("\n")) return;
        received = true;
        this.serial = this.serial.catch(() => {}).then(async () => {
          try {
            const request = JSON.parse(buffer.split("\n")[0]);
            const result = await this.handle(request);
            socket.end(`${JSON.stringify({ result })}\n`);
          } catch (error) {
            socket.end(`${JSON.stringify({ error: error.message })}\n`);
          }
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
    return this.socketPath;
    } catch (error) {
      if (await readFile(this.lockPath, "utf8").catch(() => null) === this.lockOwner) {
        await unlink(this.lockPath);
      }
      this.lockHeld = false;
      throw error;
    }
  }

  async current(request) {
    await this.store.reload();
    const project = this.store.state.projects[this.projectId];
    if (!linked(project) || request.projectId !== this.projectId
      || request.linkId !== this.linkId || (project.linkId || project.topicId) !== this.linkId) {
      throw new Error("Claude project link is no longer valid");
    }
    if (!await sameProjectDirectory(project.cwd, this.cwd)) throw new Error("Claude project folder changed");
    return project;
  }

  async handle(request) {
    const project = await this.current(request);
    const params = request.params || {};
    switch (request.method) {
      case "status":
        return { connected: Date.now() - this.lastChannelSeen < 5000,
          busy: Boolean(this.busy), sessionId: project.sessionIds?.claude || null };
      case "next": {
        this.lastChannelSeen = Date.now();
        const approval = this.store.state.approvals.find((item) =>
          item.projectId === project.id && item.source === "claude-channel"
          && item.status === "responding" && !item.sentAt);
        if (approval) {
          // The native provider is authoritative: a notification is not an
          // acknowledgement that Telegram beat the terminal response.
          return { kind: "permission", approvalId: approval.id,
            request_id: approval.serverRequestId,
            behavior: approval.decision === "approve" ? "allow" : "deny" };
        }
        const active = project.telegramRequests?.some((item) => item.status === "active");
        const queued = project.telegramRequests?.find((item) => item.status === "queued");
        if (!this.busy && !active && queued) return { kind: "prompt", id: queued.id, content: queued.prompt };
        return null;
      }
      case "ack": {
        if (params.kind === "permission") {
          const approval = this.store.state.approvals.find((item) =>
            item.id === params.approvalId && item.projectId === project.id && item.status === "responding");
          if (approval) approval.sentAt = now();
        } else if (params.kind === "prompt") {
          const item = project.telegramRequests?.find((value) => value.id === params.id && value.status === "queued");
          if (item) { item.status = "active"; item.startedAt = now(); this.busy = true; }
        }
        await this.store.save();
        return true;
      }
      case "permission": {
        if (!/^[a-km-z]{5}$/.test(params.request_id) || typeof params.tool_name !== "string") {
          throw new Error("Invalid native Claude permission request");
        }
        const candidates = this.permissionInputs.filter((item) => !item.claimed
          && item.tool_name === params.tool_name);
        const input = candidates.length === 1 ? candidates[0] : null;
        if (input) input.claimed = true;
        const id = randomUUID().replaceAll("-", "");
        const approval = {
          id, projectId: project.id, topicId: project.topicId, linkId: this.linkId,
          provider: "claude", source: "claude-channel", type: "tool",
          status: "pending", serverRequestId: params.request_id,
          toolUseId: input?.tool_use_id, toolName: params.tool_name,
          summary: params.description || `${params.tool_name} request`,
          details: { input: input?.tool_input, input_preview: params.input_preview },
          // Older Claude builds truncate the preview. Never enable remote
          // approval unless a hook captured the full unambiguous arguments.
          canReply: Boolean(input),
          createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        };
        const duplicate = this.store.state.approvals.find((item) =>
          item.projectId === project.id && item.source === "claude-channel"
          && item.serverRequestId === params.request_id && ["pending", "responding"].includes(item.status));
        if (duplicate) return duplicate.id;
        this.store.state.approvals.push(approval);
        project.lastActiveAt = now();
        await this.store.save();
        return id;
      }
      case "reply": {
        const item = project.telegramRequests?.find((value) =>
          value.id === params.requestId && value.status === "active");
        if (!item) throw new Error("Reply does not belong to an active Telegram request in this project");
        if (typeof params.text !== "string" || !params.text.trim() || params.text.length > 100_000) {
          throw new Error("Reply must contain text (maximum 100,000 characters)");
        }
        this.completeRequest(project, item, params.text);
        await this.store.save();
        return true;
      }
      case "interrupt": {
        if (!this.busy) return false;
        if (!this.interrupt()) throw new Error("Claude terminal cannot be interrupted");
        for (const item of project.telegramRequests || []) {
          if (item.status === "active") this.completeRequest(project, item, "⏹ Telegram request interrupted.");
        }
        await this.resolveRemaining(project, "interrupted");
        await this.store.save();
        return true;
      }
      case "hook":
        return this.handleHook(project, params);
      default:
        throw new Error("Unknown Claude bridge command");
    }
  }

  completeRequest(project, request, text) {
    project.claudeOutbox ||= [];
    if (!project.claudeOutbox.some((item) => item.id === request.id)) {
      project.claudeOutbox.push({ id: request.id, text, createdAt: now() });
    }
    request.status = "completed";
  }

  async resolveRemaining(project, status = "resolved") {
    for (const item of this.store.state.approvals) {
      if (item.projectId !== project.id || item.source !== "claude-channel"
        || !["pending", "responding"].includes(item.status)) continue;
      item.status = status;
      item.decidedVia = "claude";
      item.resolvedAt = now();
    }
    this.permissionInputs = [];
  }

  async handleHook(project, input) {
    if (input.agent_id) return {}; // Subagent lifecycle must not close the main session.
    if (!await sameProjectDirectory(project.cwd, input.cwd)) {
      throw new Error("Claude hook belongs to another project");
    }
    const event = input.hook_event_name;
    if (event === "SessionStart") {
      project.sessionIds ||= {};
      project.sessionIds.claude = input.session_id;
      project.transcriptPaths ||= {};
      project.transcriptPaths.claude = input.transcript_path;
      this.busy = false;
    } else if (input.session_id && project.sessionIds?.claude
      && input.session_id !== project.sessionIds.claude) {
      throw new Error("Claude hook belongs to another session");
    }
    if (event === "UserPromptSubmit") this.busy = true;
    if (event === "PermissionRequest") {
      this.busy = true;
      this.permissionInputs.push({ tool_name: input.tool_name, tool_input: input.tool_input,
        tool_use_id: input.tool_use_id });
      // Bound retention to the current turn; never wait for Telegram in a hook.
      this.permissionInputs = this.permissionInputs.slice(-100);
    }
    if (event === "PreToolUse" && input.tool_name === "mcp__local-code-link__reply") {
      const valid = project.telegramRequests?.some((item) =>
        item.id === input.tool_input?.requestId && item.status === "active");
      if (!valid) return {};
      // This one scoped communication tool has no coding/filesystem powers.
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    }
    if (["PostToolUse", "PostToolUseFailure"].includes(event)) {
      const matches = this.store.state.approvals.filter((item) =>
        item.projectId === project.id && item.source === "claude-channel"
        && ["pending", "responding"].includes(item.status)
        && item.toolName === input.tool_name
        && (item.toolUseId ? item.toolUseId === input.tool_use_id
          : JSON.stringify(item.details.input) === JSON.stringify(input.tool_input)));
      if (matches.length === 1) {
        const item = matches[0];
        // Tool failure after execution still means permission was granted.
        // Native denial often yields no post-tool hook; Stop closes it without
        // guessing whether it was denied or cancelled.
        item.status = "approved";
        if (item.decidedVia !== "telegram") {
          item.decidedVia = "cli"; item.decidedBy = "local user"; item.decidedByLabel = "local user";
        } else {
          item.decidedVia = "claude"; delete item.decidedBy; delete item.decidedByLabel;
        }
        item.resolvedAt = now();
      }
    }
    if (["Stop", "SessionEnd"].includes(event)) {
      this.busy = false;
      const active = project.telegramRequests?.find((item) => item.status === "active");
      if (active) this.completeRequest(project, active,
        input.last_assistant_message || (event === "SessionEnd" ? "Claude session closed." : "Completed."));
      await this.resolveRemaining(project);
    }
    project.lastActiveAt = now();
    await this.store.save();
    return {};
  }

  async stop() {
    clearInterval(this.timer);
    for (const socket of this.clients) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (this.lockHeld) {
      await unlink(this.socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (await readFile(this.lockPath, "utf8").catch(() => null) === this.lockOwner) {
        await unlink(this.lockPath);
      }
      this.lockHeld = false;
    }
  }
}

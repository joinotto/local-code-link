import { randomUUID } from "node:crypto";
import { startSharedCodexServer } from "./codex-daemon.mjs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import path from "node:path";
import { ClaudeStreamClient } from "./claude-stream.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { CodexSharedClient } from "./codex-shared.mjs";
import { now, publicProject, slug } from "./state.mjs";
import { claudeRequest } from "./claude-ipc.mjs";
import { selectClaudeSession } from "./claude-session.mjs";
import { safePrompt } from "./claude-panel-bridge.mjs";
import { checkClaudeProvider, codingEnvironment, resolveProviderEnvironment } from "./provider-environment.mjs";
import { deliveryFailure, deliveryReady } from "./delivery.mjs";
import {
  claimCodexApproval, CODEX_REQUEST_METHODS, codexQuestionResult, registerCodexApproval, resolveCodexApproval,
} from "./approval-sync.mjs";

const APPROVAL_EXPIRY_MS = 15 * 60_000;
const linked = (project) => project && !["unlinked", "archived"].includes(project.status);
const requestMarker = (id) => `[LocalCodeLink Telegram request ${id}]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seenUpdate = (project, updateId) => Number.isSafeInteger(updateId)
  && project.telegramUpdateIds?.includes(updateId);
const rememberUpdate = (project, updateId) => {
  if (Number.isSafeInteger(updateId)) {
    project.telegramUpdateIds = [...(project.telegramUpdateIds || []), updateId].slice(-256);
  }
};

export class CodingRuntime {
  constructor(store, options = {}) {
    this.store = store;
    this.codexBin = options.codexBin || process.env.CODEX_BIN || "codex";
    this.claudeBin = options.claudeBin || process.env.CLAUDE_BIN || "claude";
    this.environmentResolver = options.environmentResolver || resolveProviderEnvironment;
    this.onApproval = options.onApproval || (async () => {});
    this.onOutput = options.onOutput || (async () => {});
    this.onDeleteTopic = options.onDeleteTopic;
    this.running = new Map();
    this.codexShared = options.codexShared || new CodexSharedClient();
    this.codexPumps = new Map();
    this.transcriptWatchers = new Map();
    this.pollMs = options.pollMs || 500;
    this.stopped = false;
    this.sharedApprovalEntries = new Map();
    this.codexStartedItems = new Map();
    this.codexSubscriptions = new Set();
    this.claudeClients = new Map();
    this.claudeTasks = new Set();
    this.claudeQueuePumps = new Map();
    this.codexShared.onMessage = (message) => this.handleSharedCodexMessage(message);
    this.codexShared.onDisconnect = () => {
      this.codexSubscriptions.clear();
      this.sharedApprovalEntries.clear();
    };
  }

  project(value) {
    const id = slug(value);
    const project = this.store.state.projects[id]
      || Object.values(this.store.state.projects).find((item) => item.cwd === value);
    if (!project) throw new Error(`Project is not linked: ${value}`);
    return project;
  }

  projectByTopic(topicId) {
    return Object.values(this.store.state.projects)
      .find((project) => linked(project) && Number(project.topicId) === Number(topicId));
  }

  listProjects() {
    return Object.values(this.store.state.projects).filter(linked).map(publicProject);
  }

  async findCodexTranscript(project) {
    if (project.transcriptPaths?.codex) return project.transcriptPaths.codex;
    const fromApproval = [...this.store.state.approvals].reverse().find(
      (approval) => approval.projectId === project.id && approval.details?.transcript_path,
    )?.details?.transcript_path;
    if (fromApproval) return fromApproval;
    const sessionId = project.sessionIds?.codex;
    if (!sessionId) return null;
    const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
    try {
      const entries = await readdir(sessionsRoot, { recursive: true });
      const match = entries.find((entry) => entry.includes(sessionId) && entry.endsWith(".jsonl"));
      return match ? path.join(sessionsRoot, match) : null;
    } catch {
      return null;
    }
  }

  async watchCodexTranscript(projectId, requestId, transcriptPath, offset) {
    if (!transcriptPath) return;
    let deadline = Date.now() + 30 * 60_000;
    let lastPoll = Date.now();
    let position = offset;
    let remainder = "";
    const decoder = new StringDecoder("utf8");
    let turnId = null;
    while (!this.stopped) {
      await sleep(this.pollMs);
      const tick = Date.now();
      if (tick - lastPoll > 10_000) deadline += tick - lastPoll;
      lastPoll = tick;
      if (tick >= deadline) return;
      await this.store.reload();
      const current = this.store.state.projects[projectId];
      if (!linked(current) || !current.telegramRequests?.some((item) => item.id === requestId)) return;
      let content;
      try {
        const file = await open(transcriptPath, "r");
        try {
          const size = (await file.stat()).size;
          if (size < position) throw new Error("Codex transcript was truncated. Check the session before retrying.");
          if (size === position) continue;
          const buffer = Buffer.alloc(Math.min(size - position, 1024 * 1024));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          position += bytesRead;
          content = remainder + decoder.write(buffer.subarray(0, bytesRead));
        } finally { await file.close(); }
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const lines = content.split("\n");
      remainder = lines.pop();
      if (remainder.length > 16 * 1024 * 1024) throw new Error("Codex transcript entry exceeded the safe size limit.");
      for (const line of lines) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const payload = event.payload || {};
        if (event.type === "event_msg" && payload.type === "item_completed"
          && ["UserMessage", "userMessage"].includes(payload.item?.type)
          && JSON.stringify(payload.item).includes(requestMarker(requestId))) {
          turnId = payload.turn_id;
        }
        // Older rollouts store a user message separately from its turn context.
        if (event.type === "turn_context" && event.payload?.turn_id) {
          this.lastTranscriptTurnId ||= new Map();
          this.lastTranscriptTurnId.set(requestId, event.payload.turn_id);
        }
        if (event.type === "response_item" && payload.role === "user"
          && JSON.stringify(payload).includes(requestMarker(requestId))) {
          turnId ||= this.lastTranscriptTurnId?.get(requestId);
        }
        const completedTurnId = payload.turn_id || payload.root_turn_id;
        if (
          turnId && completedTurnId === turnId
          && event.type === "event_msg"
          && ["task_complete", "turn_aborted"].includes(payload.type)
        ) {
          await this.store.reload();
          const project = this.store.state.projects[projectId];
          const request = project?.telegramRequests?.find((item) => item.id === requestId);
          if (!project || !request) return;
          if (!linked(project)) return;
          request.status = "delivering";
          request.turnId = turnId;
          request.output = payload.type === "turn_aborted"
            ? "⏹ Telegram request interrupted."
            : payload.last_agent_message || "Completed.";
          await this.store.save();
          await this.deliverCodexResult(project, request);
          this.lastTranscriptTurnId?.delete(requestId);
          return;
        }
      }
    }
  }

  watchRequest(project, request) {
    if (this.transcriptWatchers.has(request.id)) return;
    const task = (request.output !== undefined
      ? this.deliverCodexResult(project, request)
      : this.watchCodexTranscript(project.id, request.id,
        request.transcriptPath, request.transcriptOffset || 0))
      .catch((error) => console.error(`Codex transcript watcher: ${error.message}`))
      .finally(() => this.transcriptWatchers.delete(request.id));
    this.transcriptWatchers.set(request.id, task);
  }

  async deliverCodexResult(project, request) {
    await this.store.reload();
    const saved = project.telegramRequests?.find((item) => item.id === request.id);
    if (!linked(project) || !saved || saved.output === undefined || !deliveryReady(saved)) return;
    try { await this.onOutput(project, saved.output); }
    catch (error) {
      await this.store.reload();
      const failed = project.telegramRequests?.find((item) => item.id === request.id);
      if (!linked(project) || !failed) return;
      deliveryFailure(failed, error);
      await this.store.save();
      throw error;
    }
    await this.store.reload();
    if (!linked(project)) return;
    project.telegramRequests = project.telegramRequests.filter((item) => item.id !== request.id);
    project.lastTelegramResult = { requestId: request.id, provider: "codex",
      sessionId: saved.sessionId || project.sessionIds?.codex, completedAt: now() };
    project.status = project.telegramRequests.length ? "busy" : "idle";
    project.lastActiveAt = now();
    await this.store.save();
  }

  async sharedThread(project) {
    await this.connectCodex();
    const { thread } = await this.codexShared.request("thread/read", {
      threadId: project.sessionIds.codex,
    });
    if (await realpath(thread.cwd) !== await realpath(project.cwd)) {
      throw new Error("Saved Codex session belongs to another folder; relink the correct session");
    }
    return thread;
  }

  async connectCodex() {
    if (this.codexShared.socketPath) {
      try { await stat(this.codexShared.socketPath); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        const env = codingEnvironment(await this.environmentResolver());
        await startSharedCodexServer(this.codexBin, { env });
      }
    }
    await this.codexShared.connect();
  }

  proxyIsActive(project) {
    const pid = project.localSession?.approvalProxyPid;
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  }

  async subscribeCodexApprovals(project) {
    const thread = await this.sharedThread(project);
    if (this.codexSubscriptions.has(thread.id)) return;
    await this.codexShared.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    this.codexSubscriptions.add(thread.id);
  }

  async handleSharedCodexMessage(message) {
    if (message.method === "item/started" && message.params?.item?.id) {
      const key = `${message.params.threadId}:${message.params.turnId}:${message.params.item.id}`;
      this.codexStartedItems.set(key, message.params.item);
      if (this.codexStartedItems.size > 512) this.codexStartedItems.delete(this.codexStartedItems.keys().next().value);
      return;
    }
    if (message.id !== undefined && CODEX_REQUEST_METHODS.has(message.method)) {
      await this.store.reload();
      const project = Object.values(this.store.state.projects).find((item) =>
        linked(item) && item.provider === "codex" && item.sessionIds?.codex === message.params.threadId);
      if (!project || this.proxyIsActive(project)) return;
      const key = `${message.params.threadId}:${message.id}`;
      const entry = { requestId: message.id, resolved: false };
      this.sharedApprovalEntries.set(key, entry);
      const item = this.codexStartedItems.get(`${message.params.threadId}:${message.params.turnId}:${message.params.itemId}`);
      const tracked = item?.type === "fileChange"
        ? { ...message, params: { ...message.params, proposedChanges: item.changes } } : message;
      entry.ready = registerCodexApproval(this.store, project, tracked, "codex-shared")
        .then((approval) => { entry.approvalId = approval?.id; });
      await entry.ready;
      const saved = this.store.state.approvals.find((item) => item.id === entry.approvalId);
      if (!entry.resolved && saved?.status === "responding" && saved.response) {
        this.codexShared.respond(entry.requestId, saved.response);
      }
      return;
    }
    if (message.method === "serverRequest/resolved") {
      const key = `${message.params.threadId}:${message.params.requestId}`;
      const entry = this.sharedApprovalEntries.get(key);
      if (!entry) return;
      entry.resolved = true;
      await entry.ready;
      await resolveCodexApproval(this.store, entry.approvalId);
      this.sharedApprovalEntries.delete(key);
    }
  }

  async startQueuedRequest(project) {
    const thread = await this.sharedThread(project);
    if (!this.proxyIsActive(project)) await this.subscribeCodexApprovals(project);
    if (thread.status.type === "notLoaded") {
      // Rejoin the same daemon-owned thread; never create another writer process.
      await this.codexShared.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    } else if (thread.status.type !== "idle") {
      if (thread.status.activeFlags?.includes("waitingOnUserInput")) {
        const message = "Codex is waiting for input in its saved turn. Resolve the question in Codex/Telegram, or use /interrupt before queued instructions can run.";
        if (project.lastQueueError !== message) {
          project.lastQueueError = message;
          await this.store.save();
        }
      }
      return false;
    }
    const queue = await this.codexShared.request("thread/queue/list", { threadId: thread.id });
    const head = queue.data[0];
    if (!head) return false;
    const request = project.telegramRequests?.find((item) =>
      item.queuedSubmissionId === head.id
      || JSON.stringify(head.input).includes(requestMarker(item.id)));
    // Do not start unrelated locally queued instructions.
    if (!request || !linked(project)) return false;
    const { turn } = await this.codexShared.request("thread/queue/start", {
      threadId: thread.id, queuedSubmissionId: head.id,
    });
    await this.store.reload();
    const current = this.store.state.projects[project.id];
    const saved = current?.telegramRequests?.find((item) => item.id === request.id);
    if (saved) {
      saved.status = "active";
      saved.turnId = turn.id;
      current.status = "busy";
      await this.store.save();
    }
    return true;
  }

  ensureQueuePump(projectId) {
    if (this.codexPumps.has(projectId)) return;
    const task = (async () => {
      while (!this.stopped) {
        await this.store.reload();
        const project = this.store.state.projects[projectId];
        if (!linked(project) || project.provider !== "codex" || !project.telegramRequests?.length) return;
        try {
          const progressed = await this.startQueuedRequest(project);
          if (progressed && project.lastQueueError) {
            delete project.lastQueueError;
            await this.store.save();
          }
        } catch (error) {
          // A local turn may start between the idle read and queue/start. Leave
          // the accepted request in the queue and retry, never fork a new writer.
          project.lastQueueError = error.message;
          await this.store.save();
        }
        await sleep(this.pollMs);
      }
    })().catch(console.error).finally(() => this.codexPumps.delete(projectId));
    this.codexPumps.set(projectId, task);
  }

  async queueToLocalSession(project, prompt, options = {}) {
    await this.store.reload();
    if (!linked(project)) throw new Error("Project is not linked");
    if (seenUpdate(project, options.updateId)) return true;
    if (project.provider === "claude") return this.queueToClaude(project, prompt, options);
    if (project.provider !== "codex") {
      return false;
    }
    if (!project.sessionIds?.codex) {
      await this.connectCodex();
      const { thread } = await this.codexShared.request("thread/start", {
        cwd: project.cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandbox: project.accessMode === "read-only" ? "read-only" : "workspace-write", ephemeral: false,
      });
      if (!thread?.id || await realpath(thread.cwd) !== await realpath(project.cwd)) {
        throw new Error("Codex returned an unexpected project directory. No prompt was submitted.");
      }
      await this.store.reload();
      if (!linked(project)) throw new Error("Project was unlinked while starting Codex");
      project.sessionIds ||= {};
      project.sessionIds.codex = thread.id;
      await this.store.save();
    }
    const sessionId = project.sessionIds.codex;
    if (!linked(project)) throw new Error("Project is not linked");
    // Verify the connection and project identity before accepting a message.
    // Connection failures must not silently start a competing Codex process.
    const thread = await this.sharedThread(project);
    if (!this.proxyIsActive(project)) await this.subscribeCodexApprovals(project);
    const requestId = randomUUID();
    const transcriptPath = thread.path || await this.findCodexTranscript(project);
    if (!transcriptPath) throw new Error("Cannot locate Codex session history; message was not submitted");
    let transcriptOffset = 0;
    try { transcriptOffset = (await stat(transcriptPath)).size; } catch {}
    project.telegramRequests ||= [];
    const request = {
      id: requestId,
      status: "queued",
      createdAt: now(),
      sessionId,
      transcriptPath,
      transcriptOffset,
    };
    project.telegramRequests.push(request);
    rememberUpdate(project, options.updateId);
    await this.store.save();
    try {
      const { queuedSubmission } = await this.codexShared.request("thread/queue/add", {
        threadId: sessionId,
        clientUserMessageId: requestId,
        input: [{ type: "text", text: `${requestMarker(requestId)}\n${prompt}` }],
      });
      await this.store.reload();
      const saved = project.telegramRequests?.find((item) => item.id === requestId);
      if (saved) saved.queuedSubmissionId = queuedSubmission.id;
    } catch (error) {
      // Timeout is ambiguous: queue/add may have succeeded. Keep the marker to
      // correlate/recover it rather than retrying through another process.
      await this.store.reload();
      const saved = project.telegramRequests?.find((item) => item.id === requestId);
      if (saved) {
        saved.status = "submission_uncertain";
        saved.lastError = error.message;
      }
      await this.store.save();
      this.watchRequest(project, request);
      this.ensureQueuePump(project.id);
      throw error;
    }
    if (!linked(project)) {
      throw new Error("Project was unlinked while submitting. Check Codex for already accepted work.");
    }
    project.lastActiveAt = now();
    project.status = "busy";
    delete project.lastError;
    await this.store.save();
    this.watchRequest(project, request);
    this.ensureQueuePump(project.id);
    return true;
  }

  async queueToClaude(project, prompt, options = {}) {
    prompt = safePrompt(prompt);
    let status;
    try { status = await claudeRequest(this.store.root, project, "status"); }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      const enqueue = async () => {
        await this.store.reload();
        if (!linked(project)) throw new Error("Project is no longer linked");
        project.telegramRequests ||= [];
        project.telegramRequests.push({ id: randomUUID(), provider: "claude", dispatch: "stream",
          prompt, status: "queued", createdAt: now() });
        rememberUpdate(project, options.updateId);
        await this.store.save();
        this.ensureClaudeQueue(project.id);
        return true;
      };
      if (this.claudeTasks.has(project.id)) return enqueue();
      const pid = project.localSession?.pid;
      if (project.localSession?.status === "active" && pid) {
        try { process.kill(pid, 0); }
        catch (cause) { if (cause.code === "ESRCH") return enqueue(); throw cause; }
        throw new Error("Claude is running without the terminal bridge. Close it and reopen once with local-code-link claude.");
      }
      return enqueue();
    }
    if (!status.connected) throw new Error("Claude's terminal bridge is not ready. Finish startup and review hooks in the terminal, then retry.");
    await this.store.reload();
    const current = this.store.state.projects[project.id];
    if (!linked(current) || (current.linkId || current.topicId) !== (project.linkId || project.topicId)) {
      throw new Error("Project link changed; message was not submitted");
    }
    current.telegramRequests ||= [];
    current.telegramRequests.push({ id: randomUUID(), provider: "claude",
      prompt, status: "queued", createdAt: now() });
    rememberUpdate(current, options.updateId);
    current.lastActiveAt = now();
    await this.store.save();
    return true;
  }

  async deliverClaudeOutbox() {
    if (this.deliveringClaude) return;
    this.deliveringClaude = true;
    try {
      await this.store.reload();
      for (const project of Object.values(this.store.state.projects)) {
        if (!linked(project)) continue;
        if (project.provider === "claude" && project.telegramRequests?.some((item) => item.status === "queued")) {
          this.ensureClaudeQueue(project.id);
        }
        for (const item of [...(project.claudeOutbox || [])]) {
          await this.store.reload();
          if (!linked(project) || !project.claudeOutbox?.some((value) => value.id === item.id)) continue;
          const saved = project.claudeOutbox.find((value) => value.id === item.id);
          if (!deliveryReady(saved)) continue;
          try { await this.onOutput(project, saved.text); }
          catch (error) {
            await this.store.reload();
            const failed = project.claudeOutbox?.find((value) => value.id === item.id);
            if (!linked(project) || !failed) continue;
            deliveryFailure(failed, error);
            await this.store.save();
            // One offline project must not block the other projects' outboxes.
            console.error(`Claude output delivery held (${failed.delivery.state}).`);
            continue;
          }
          await this.store.reload();
          if (!linked(project)) continue;
          project.claudeOutbox = project.claudeOutbox.filter((value) => value.id !== item.id);
          project.telegramRequests = (project.telegramRequests || []).filter((value) => value.id !== item.id);
          project.lastTelegramResult = { requestId: item.id, provider: "claude",
            sessionId: project.sessionIds?.claude, completedAt: now() };
          await this.store.save();
        }
      }
    } finally { this.deliveringClaude = false; }
  }

  ensureClaudeQueue(projectId) {
    if (this.claudeQueuePumps.has(projectId) || this.stopped) return;
    const task = (async () => {
      while (!this.stopped) {
        await sleep(this.pollMs);
        if (this.claudeTasks.has(projectId)) continue;
        await this.store.reload();
        const project = this.store.state.projects[projectId];
        if (!linked(project)) return;
        const item = project.telegramRequests?.find((value) =>
          value.provider === "claude" && value.status === "queued");
        if (!item) return;
        if (project.backgroundTask?.pid) {
          try { process.kill(project.backgroundTask.pid, 0); continue; }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        try {
          await claudeRequest(this.store.root, project, "status");
          return;
        } catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
        }
        if (project.localSession?.status === "active" && project.localSession.pid) {
          try { process.kill(project.localSession.pid, 0); continue; }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        item.status = "active";
        await this.store.save();
        try {
          await this.run(projectId, item.prompt, { queuedRequestId: item.id });
        } finally {
          await this.store.reload();
          if (linked(project)) {
            delete project.backgroundTask;
            await this.store.save();
            await this.deliverClaudeOutbox();
          }
        }
      }
    })().catch((error) => console.error(`Claude queue: ${error.message}`))
      .finally(() => this.claudeQueuePumps.delete(projectId));
    this.claudeQueuePumps.set(projectId, task);
  }

  async recoverCodexRequests() {
    if (this.recoveringCodex || this.stopped) return;
    this.recoveringCodex = true;
    try {
    for (const project of Object.values(this.store.state.projects)) {
      if (!linked(project) || project.provider !== "codex") continue;
      const requests = project.telegramRequests || [];
      const pending = this.store.state.approvals.some((item) => item.projectId === project.id
        && ["pending", "responding"].includes(item.status) && item.source === "codex-shared");
      if (pending && !this.proxyIsActive(project)) await this.subscribeCodexApprovals(project);
      for (const request of requests) {
        request.transcriptPath ||= await this.findCodexTranscript(project);
        request.sessionId ||= project.sessionIds.codex;
        this.watchRequest(project, request);
      }
      await this.store.save();
      this.ensureQueuePump(project.id);
    }
    } finally { this.recoveringCodex = false; }
  }

  stop() {
    this.stopped = true;
    this.codexShared.close?.();
    for (const client of this.claudeClients.values()) client.child?.kill("SIGTERM");
  }

  async run(projectId, prompt, options = {}) {
    await this.store.reload();
    const project = this.project(projectId);
    if (!linked(project)) throw new Error("Project is not linked");
    if (project.status === "busy") throw new Error(`${project.name} is already processing a request`);
    project.status = "busy";
    const provider = project.provider;
    if (provider === "claude") this.claudeTasks.add(project.id);
    project.lastActiveAt = now();
    try {
      await this.store.save();
      const result = provider === "claude"
        ? await this.runClaude(project, prompt)
        : await this.runCodex(project, prompt);
      await this.store.reload();
      project.sessionIds ||= {};
      project.sessionIds[provider] = result.sessionId || project.sessionIds[provider] || null;
      if (linked(project)) project.status = "idle";
      project.lastActiveAt = now();
      await this.store.save();
      if (linked(project)) {
        if (options.queuedRequestId) {
          project.claudeOutbox ||= [];
          project.claudeOutbox.push({ id: options.queuedRequestId, text: result.text || "Completed.", createdAt: now() });
          await this.store.save();
        } else await this.onOutput(project, result.text || "Completed.");
      }
      return result;
    } catch (error) {
      await this.store.reload();
      const stillLinked = linked(project);
      if (stillLinked) project.status = "error";
      project.lastError = error.message;
      project.lastActiveAt = now();
      await this.store.save();
      if (stillLinked) {
        if (options.queuedRequestId) {
          project.claudeOutbox ||= [];
          project.claudeOutbox.push({ id: options.queuedRequestId, text: `❌ ${error.message}`, createdAt: now() });
          await this.store.save();
        } else await this.onOutput(project, `❌ ${error.message}`);
      }
      throw error;
    } finally {
      this.running.delete(project.id);
      this.claudeTasks.delete(project.id);
      if (provider === "claude") this.ensureClaudeQueue(project.id);
    }
  }

  async runCodex(project, prompt) {
    const client = new CodexAppServerClient({
      command: this.codexBin,
      cwd: project.cwd,
      onSpawn: (child) => this.running.set(project.id, child),
      onQuestion: async (message) => {
        const approval = await registerCodexApproval(this.store, project, message, "codex-stream");
        if (!approval || approval.canReply === false) return { answers: {} };
        await this.onApproval(project, approval);
        if (await this.waitForApproval(project.id, approval.id) !== "approved") return { answers: {} };
        await this.store.reload();
        return this.store.state.approvals.find((item) => item.id === approval.id)?.response || { answers: {} };
      },
      onApproval: async (method, params) => {
        const type = method.includes("commandExecution")
          ? "command" : method.includes("fileChange") ? "file_change" : "permissions";
        const approval = await this.createApproval(project, {
          provider: "codex",
          type,
          summary: params.reason || params.command || `Codex ${type} request`,
          details: params,
        });
        return (await this.waitForApproval(project.id, approval.id)) === "approved" ? "approve" : "deny";
      },
    });
    return client.run(prompt, project.sessionIds?.codex || null, project.accessMode || "edit");
  }

  async runClaude(project, prompt) {
    try {
      await claudeRequest(this.store.root, project, "status");
      throw new Error("Claude is already active; submit to its linked terminal instead of starting another writer");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    }
    const environment = await this.environmentResolver();
    checkClaudeProvider(project.claudeCloudProvider, environment);
    const selection = await selectClaudeSession(this.store, project,
      path.join(environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"));
    const client = new ClaudeStreamClient({
      command: this.claudeBin,
      env: environment,
      cwd: project.cwd,
      sessionId: selection.sessionId,
      onSpawn: async (child) => {
        this.running.set(project.id, child);
        await this.store.reload();
        if (linked(project)) {
          project.backgroundTask = { pid: child.pid, provider: "claude", startedAt: now() };
          await this.store.save();
        }
      },
      onApproval: async (request) => {
        const input = request.input || request.tool_input || {};
        if (request.tool_name === "AskUserQuestion" && Array.isArray(input.questions)) {
          const answers = {};
          for (const question of input.questions) {
            const approval = await this.createApproval(project, {
              provider: "claude", source: "claude-stream", type: "question",
              summary: question.question, details: { ...request, input, question },
            });
            if (await this.waitForApproval(project.id, approval.id) !== "approved") return "deny";
            await this.store.reload();
            answers[question.question] = this.store.state.approvals.find((item) =>
              item.id === approval.id)?.response?.answer;
          }
          return { decision: "approve", updatedInput: { ...input, answers } };
        }
        const approval = await this.createApproval(project, {
          provider: "claude",
          source: "claude-stream",
          type: request.tool_name === "Bash" ? "command" : "tool",
          summary: request.description || input.command || `${request.tool_name || "Claude tool"} request`,
          details: request,
        });
        return (await this.waitForApproval(project.id, approval.id)) === "approved" ? "approve" : "deny";
      },
    });
    this.claudeClients.set(project.id, client);
    try { return await client.run(prompt, project.accessMode || "edit"); }
    finally {
      this.claudeClients.delete(project.id);
      await this.store.reload();
      for (const approval of this.store.state.approvals) {
        if (approval.projectId === project.id && approval.source === "claude-stream"
          && ["pending", "responding"].includes(approval.status)) {
          approval.status = "interrupted";
          approval.resolvedAt = now();
        }
      }
      await this.store.save();
    }
  }

  async createApproval(project, request) {
    await this.store.reload();
    if (!linked(project)) throw new Error("Project is no longer linked");
    const approval = {
      id: randomUUID(),
      projectId: project.id,
      topicId: project.topicId,
      status: "pending",
      createdAt: now(),
      expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_MS).toISOString(),
      ...request,
    };
    this.store.state.approvals.push(approval);
    await this.store.save();
    try {
      await this.store.reload();
      if (!linked(project)) throw new Error("Project is no longer linked");
      await this.onApproval(project, approval);
      approval.notifiedAt = now();
      await this.store.save();
    } catch (error) {
      approval.status = "delivery_failed";
      approval.lastError = error.message;
      await this.store.save();
      throw new Error(`Approval could not be delivered to Telegram: ${error.message}`);
    }
    return approval;
  }

  async waitForApproval(projectId, approvalId) {
    while (true) {
      await this.store.reload();
      const approval = this.store.state.approvals.find((item) =>
        item.id === approvalId && item.projectId === projectId);
      if (!approval) return "denied";
      if (!["pending", "responding"].includes(approval.status)) return approval.status;
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        approval.status = "expired";
        approval.decidedAt = now();
        await this.store.save();
        return "expired";
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async decideApproval(approvalId, decision, userId, topicId) {
    await this.store.reload();
    const approval = this.store.state.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== "pending") throw new Error("Approval is no longer pending");
    if (!linked(this.store.state.projects[approval.projectId])) throw new Error("Project is no longer linked");
    if (topicId !== undefined && Number(approval.topicId) !== Number(topicId)) {
      throw new Error("Approval belongs to another project topic");
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) throw new Error("Approval has expired");
    if (approval.type === "question") throw new Error("This request needs an answer, not approval. Use its answer buttons or /answer.");
    if (approval.provider === "codex" && approval.canReply === false) {
      throw new Error("Full request details are unavailable. Decide in the native terminal.");
    }
    if (["claude-channel", "claude-stream", "claude-panel"].includes(approval.source)) {
      if (approval.source === "claude-stream" && !this.claudeClients.has(approval.projectId)) {
        throw new Error("Claude background approval is disconnected. Check the saved session before retrying.");
      }
      if (approval.canReply === false) {
        throw new Error("Full Claude tool arguments could not be captured. Decide in the native CLI.");
      }
      if (["claude-channel", "claude-panel"].includes(approval.source)) {
        const status = await claudeRequest(this.store.root, this.store.state.projects[approval.projectId], "status");
        if (!status.connected) throw new Error("Claude bridge is disconnected; decide in the terminal");
      }
      const claimed = await claimCodexApproval(this.store, approvalId, decision, userId, "telegram",
        { behavior: decision === "approve" ? "allow" : "deny" });
      if (approval.source === "claude-stream") return resolveCodexApproval(this.store, claimed.id);
      return claimed;
    }
    if (["codex-proxy", "codex-shared"].includes(approval.source)) {
      if (approval.source === "codex-proxy" && approval.relayPid) {
        try { process.kill(approval.relayPid, 0); }
        catch { throw new Error("Codex approval relay is disconnected. Check the saved session before retrying."); }
      }
      if (approval.source === "codex-shared") {
        const entry = this.sharedApprovalEntries.get(`${approval.threadId}:${approval.serverRequestId}`);
        if (!entry || entry.resolved) throw new Error("Codex approval is no longer connected; check the session before retrying");
        const claimed = await claimCodexApproval(this.store, approvalId, decision, userId, "telegram");
        if (entry.resolved) throw new Error("Approval was already handled in Codex");
        this.codexShared.respond(entry.requestId, claimed.response);
        return claimed;
      }
      return claimCodexApproval(this.store, approvalId, decision, userId, "telegram");
    }
    approval.status = decision === "approve" ? "approved" : "denied";
    approval.decidedAt = now();
    approval.decidedBy = String(typeof userId === "object" ? userId.id : userId);
    await this.store.save();
    return approval;
  }

  async answerQuestion(id, answer, actor, topicId) {
    await this.store.reload();
    const item = this.store.state.approvals.find((value) => value.id === id);
    if (!item || item.status !== "pending" || item.type !== "question") {
      throw new Error("Question is no longer pending");
    }
    const project = this.store.state.projects[item.projectId];
    if (!linked(project) || Number(topicId) !== Number(item.topicId)) {
      throw new Error("Question belongs to another project topic");
    }
    if (typeof answer !== "string" || !answer.trim() || answer.length > 5000) {
      throw new Error("An answer is required (maximum 5,000 characters)");
    }
    if (item.canReply === false) throw new Error("Answer this sensitive request in the native terminal.");
    if (item.source === "claude-stream" && !this.claudeClients.has(item.projectId)) {
      throw new Error("Claude background question is disconnected. Check the saved session before retrying.");
    }
    if (["codex-proxy", "codex-shared", "codex-stream"].includes(item.source)) {
      if (item.source === "codex-proxy" && item.relayPid) {
        try { process.kill(item.relayPid, 0); }
        catch { throw new Error("Codex question relay is disconnected. Reopen the linked terminal."); }
      }
      const response = codexQuestionResult(item, answer);
      const entry = item.source === "codex-shared"
        ? this.sharedApprovalEntries.get(`${item.threadId}:${item.serverRequestId}`) : null;
      if (item.source === "codex-shared" && (!entry || entry.resolved)) {
        throw new Error("Codex question is disconnected. Check /status before retrying.");
      }
      const claimed = await claimCodexApproval(this.store, id, "approve", actor, "telegram", response);
      if (item.source === "codex-stream") return resolveCodexApproval(this.store, claimed.id);
      if (entry && !entry.resolved) this.codexShared.respond(entry.requestId, response);
      return claimed;
    }
    if (item.source === "claude-panel") {
      const status = await claudeRequest(this.store.root, project, "status");
      if (!status.connected) throw new Error("Claude bridge is disconnected; answer in the terminal");
    }
    const claimed = await claimCodexApproval(this.store, id, "approve", actor, "telegram",
      { answer: answer.trim() });
    if (item.source === "claude-stream") return resolveCodexApproval(this.store, claimed.id);
    return claimed;
  }

  async interrupt(projectId) {
    const project = this.project(projectId);
    if (project.provider === "claude") {
      const client = this.claudeClients.get(project.id);
      if (client) return client.interrupt();
      try { return await claudeRequest(this.store.root, project, "interrupt"); }
      catch (error) { if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return false; throw error; }
    }
    const child = this.running.get(project.id);
    if (!child && project.provider === "codex" && project.sessionIds?.codex) {
      const thread = await this.sharedThread(project);
      if (thread.status.type !== "active") return false;
      const response = await this.codexShared.request("thread/turns/list", {
        threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      });
      const turn = response.data.find((item) => item.status === "inProgress");
      if (!turn) return false;
      await this.codexShared.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    } else if (child) {
      child.kill("SIGINT");
    } else {
      return false;
    }
    project.status = "interrupted";
    project.lastActiveAt = now();
    await this.store.save();
    return true;
  }

  async unlink(projectId, options = {}) {
    if (!options.confirmed) throw new Error("Unlink permanently deletes the Telegram topic and bridge history; confirmation is required");
    if (!this.onDeleteTopic) throw new Error("Telegram topic cleanup is not configured");
    await this.store.reload();
    const project = this.project(projectId);
    const topicId = Number(project.topicId);
    if (!Number.isSafeInteger(topicId) || topicId <= 1
      || topicId === Number(this.store.state.telegram.controlTopicId)
      || Object.values(this.store.state.projects).some((other) =>
        other.id !== project.id && Number(other.topicId) === topicId)) {
      throw new Error("Refusing to delete an invalid, control, or shared Telegram topic");
    }
    const requests = [...(project.telegramRequests || [])];
    project.status = "unlinked";
    project.unlinkedAt = now();
    delete project.unlinkConfirmation;
    project.telegramRequests = [];
    for (const approval of this.store.state.approvals) {
      if (approval.projectId !== project.id || approval.status !== "pending") continue;
      approval.status = "denied";
      approval.decidedAt = now();
      approval.decisionReason = "Project unlinked";
    }
    // Access is revoked before attempting best-effort remote task cancellation.
    await this.store.save();
    const warnings = [];
    const child = this.running.get(project.id);
    if (child) child.kill("SIGINT");
    if (project.provider === "codex" && project.sessionIds?.codex && requests.length) {
      try {
        const thread = await this.sharedThread(project);
        const queue = await this.codexShared.request("thread/queue/list", { threadId: thread.id });
        for (const item of queue.data) {
          if (!requests.some((request) => JSON.stringify(item.input).includes(requestMarker(request.id)))) continue;
          await this.codexShared.request("thread/queue/delete", {
            threadId: thread.id, queuedSubmissionId: item.id,
          });
        }
        const turns = await this.codexShared.request("thread/turns/list", {
          threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "full",
        });
        const active = turns.data.find((turn) => turn.status === "inProgress"
          && requests.some((request) => request.turnId === turn.id
            || JSON.stringify(turn.items).includes(requestMarker(request.id))));
        if (active) await this.codexShared.request("turn/interrupt", { threadId: thread.id, turnId: active.id });
      } catch (error) {
        warnings.push(`Access revoked, but previously submitted work could not be cancelled: ${error.message}`);
      }
    }
    try {
      await this.onDeleteTopic(project);
    } catch (error) {
      await this.store.reload();
      const current = this.store.state.projects[project.id];
      if (current) {
        current.unlinkCleanupError = error.message;
        await this.store.save();
      }
      throw new Error(`Telegram access is revoked, but cleanup is incomplete: ${error.message}. `
        + `Fix Telegram permissions/connectivity and rerun local-code-link unlink ${project.id}.`);
    }
    await this.store.forgetProject(project.id);
    return { project, warnings, deleted: true };
  }
}

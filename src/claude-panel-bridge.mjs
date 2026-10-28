import { randomUUID } from "node:crypto";
import { ClaudeNativeBridge } from "./claude-native-bridge.mjs";
import { claimCodexApproval, resolveCodexApproval } from "./approval-sync.mjs";
import { now } from "./state.mjs";

export const telegramMarker = (id) => `[LocalCodeLink Telegram request ${id}]`;
export const safePrompt = (text) => {
  if (typeof text !== "string" || !text.trim() || text.length > 100_000) {
    throw new Error("Prompt must contain text (maximum 100,000 characters)");
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error("Prompt contains terminal control characters");
  }
  return normalized;
};

export class ClaudePanelBridge extends ClaudeNativeBridge {
  constructor(store, project, options = {}) {
    super(store, project, options);
    this.onPanel = options.onPanel || (() => {});
    this.submit = options.submit || (async () => { throw new Error("Claude terminal is unavailable"); });
    this.ready = false;
    this.draft = false;
    this.inputPending = "";
    this.inputPaste = false;
    this.presented = null;
  }

  async start() {
    await super.start();
    this.timer = setInterval(() => {
      this.serial = this.serial.catch(() => {}).then(() => this.tick())
        .catch((error) => this.onPanel(null, `LocalCodeLink: ${error.message}`));
    }, 100);
    return this.socketPath;
  }

  noteInput(data) {
    // iTerm responds to Claude's focus/cursor/capability probes on stdin.
    // Those bytes are terminal protocol, not a user composing a prompt.
    let input = this.inputPending + data;
    this.inputPending = "";
    clearTimeout(this.inputEscapeTimer);
    const key = (value) => {
      if (value === "\r" && !this.inputPaste) {
        this.draft = false;
        this.busy = true;
      } else if (!this.inputPaste && ["\x03", "\x15"].includes(value)) {
        this.draft = false;
      } else if (!this.inputPaste && ["\x10", "\x0e", "\x12"].includes(value)) {
        this.draft = true;
      } else if (/[\x20-\x7e\u00a0-\uffff]/u.test(value)) {
        this.draft = true;
      }
    };
    while (input.length) {
      if (input.startsWith("\x1b[")) {
        const sequence = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(input);
        if (!sequence) {
          if (input.length < 4096) this.inputPending = input;
          return;
        }
        const [, params, , final] = sequence;
        if (final === "~" && params === "200") this.inputPaste = true;
        else if (final === "~" && params === "201") this.inputPaste = false;
        else if (["A", "B"].includes(final)) this.draft = true; // prompt history, not cursor reports
        // Extended keyboard reports carry real keys; capability replies
        // such as CSI ? ... u do not.
        else if (final === "u" && /^\d/.test(params)) {
          const code = Number(params.split(/[;:]/)[0]);
          if (code > 0 && code <= 0x10ffff) key(String.fromCodePoint(code));
        }
        input = input.slice(sequence[0].length);
      } else if (/^\x1b[\]P_^]/.test(input)) {
        const end = /\x07|\x1b\\/.exec(input.slice(2));
        if (!end) {
          if (input.length < 4096) this.inputPending = input;
          return;
        }
        input = input.slice(2 + end.index + end[0].length);
      } else if (input === "\x1b") {
        this.inputPending = input;
        // A lone Escape key and the beginning of a fragmented terminal
        // response look identical until the next bytes arrive.
        this.inputEscapeTimer = setTimeout(() => {
          if (this.inputPending === "\x1b") {
            this.inputPending = "";
          }
        }, 50);
        return;
      } else {
        key(input[0]);
        input = input.slice(1);
      }
    }
  }

  async tick() {
    await this.store.reload();
    const project = this.store.state.projects[this.projectId];
    if (!project || (project.linkId || project.topicId) !== this.linkId
      || ["unlinked", "archived"].includes(project.status)) {
      if (this.presented) this.onPanel(null, "LocalCodeLink access revoked. Use Claude's native prompt.");
      this.presented = null;
      return;
    }
    const pending = this.store.state.approvals.find((item) =>
      item.projectId === project.id && item.linkId === this.linkId
      && item.source === "claude-panel" && item.status === "pending");
    if (pending && Date.parse(pending.expiresAt) <= Date.now()) {
      pending.status = "expired";
      pending.resolvedAt = now();
      await this.store.save();
    }
    const next = pending?.status === "pending" ? pending : null;
    if (this.presented?.id !== next?.id) {
      const old = this.presented && this.store.state.approvals.find((item) => item.id === this.presented.id);
      this.onPanel(next ? structuredClone(next) : null, old ? structuredClone(old) : null);
      this.presented = next ? structuredClone(next) : null;
    }
    if (!this.ready || this.busy || this.draft || next || Date.now() < this.notBefore) return;
    if (project.telegramRequests?.some((item) => ["active", "submitting"].includes(item.status))) return;
    const queued = project.telegramRequests?.find((item) => item.status === "queued");
    if (!queued) return;
    const prompt = safePrompt(queued.prompt);
    // Persist before touching the terminal. An interrupted submission is
    // ambiguous and must not be silently replayed after a crash.
    queued.status = "submitting";
    queued.sessionId = project.sessionIds.claude;
    queued.submittedAt = now();
    this.busy = true;
    await this.store.save();
    await this.submit(`${telegramMarker(queued.id)}\n${prompt}`);
  }

  async handle(request) {
    if (request.method === "panel-result") {
      await this.store.reload();
      const current = this.store.state.projects[this.projectId];
      if (request.projectId === this.projectId && request.linkId === this.linkId
        && (!current || (current.linkId || current.topicId) !== this.linkId
          || ["unlinked", "archived"].includes(current.status))) return { fallback: true };
    }
    const project = await this.current(request);
    const params = request.params || {};
    if (request.method === "status") return { connected: this.ready, busy: Boolean(this.busy),
      draft: this.draft, queued: (project.telegramRequests || []).filter((item) => item.status === "queued").length,
      waitingFor: !this.ready ? "startup" : this.presented ? "approval" : this.busy ? "active turn"
        : this.draft ? "local draft" : null,
      mode: "panel", sessionId: project.sessionIds?.claude || null };
    if (request.method === "panel-decide") {
      const approval = this.store.state.approvals.find((item) =>
        item.id === params.id && item.projectId === this.projectId && item.linkId === this.linkId);
      if (!approval || approval.source !== "claude-panel"
        || approval.status !== "pending" || Date.parse(approval.expiresAt) <= Date.now()) {
        throw new Error("Request is no longer pending");
      }
      if (approval.type === "question") {
        if (typeof params.answer !== "string" || !params.answer.trim() || params.answer.length > 5000) {
          throw new Error("An answer is required (maximum 5,000 characters)");
        }
      } else if (!["approve", "deny"].includes(params.decision)) throw new Error("Invalid decision");
      const result = approval.type === "question" ? { answer: params.answer.trim() }
        : { behavior: params.decision === "approve" ? "allow" : "deny",
          ...(params.decision === "approve" ? { updatedInput: approval.details.input } : {}) };
      await claimCodexApproval(this.store, approval.id,
        approval.type === "question" ? "approve" : params.decision, "local user", "cli", result);
      return true;
    }
    if (request.method === "panel-result") {
      let approval = this.store.state.approvals.find((item) =>
        item.id === params.id && item.projectId === this.projectId && item.linkId === this.linkId);
      if (!approval) return { fallback: true };
      if (approval.status === "responding") {
        approval = await resolveCodexApproval(this.store, approval.id);
      }
      if (["approved", "denied"].includes(approval.status)) {
        return { done: true, ...approval.response, notice: {
          provider: "claude", id: approval.id, status: approval.status, type: approval.type,
          decidedVia: approval.decidedVia, decidedBy: approval.decidedBy,
          decidedByLabel: approval.decidedByLabel,
        } };
      }
      if (["expired", "interrupted", "cancelled"].includes(approval.status)) {
        return { done: true, behavior: "deny", cancelled: true };
      }
      if (approval.status !== "pending") return { fallback: true };
      return { done: false };
    }
    if (request.method === "interrupt") {
      if (!this.busy) return false;
      for (const approval of this.store.state.approvals) {
        if (approval.projectId === this.projectId && approval.source === "claude-panel"
          && approval.status === "pending") {
          approval.status = "interrupted"; approval.resolvedAt = now();
        }
      }
      await this.store.save();
      if (!this.interrupt()) return false;
      const active = project.telegramRequests?.find((item) => ["active", "submitting"].includes(item.status));
      if (active) this.completeRequest(project, active, "⏹ Telegram request interrupted.");
      this.busy = false;
      this.notBefore = Date.now() + 1500;
      await this.store.save();
      return true;
    }
    return super.handle(request);
  }

  async registerPanel(project, input, question) {
    const id = randomUUID().replaceAll("-", "");
    const approval = {
      id, projectId: project.id, topicId: project.topicId, linkId: this.linkId,
      provider: "claude", source: "claude-panel", status: "pending",
      type: question ? "question" : input.tool_name === "Bash" ? "command" : "tool",
      toolName: input.tool_name, toolUseId: input.tool_use_id, sessionId: input.session_id,
      summary: question?.question || input.tool_input?.description || `${input.tool_name} request`,
      details: { input: input.tool_input, ...(question ? { question } : {}) },
      // The daemon sends complete large arguments separately, before buttons.
      canReply: true,
      createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    this.store.state.approvals.push(approval);
    await this.store.save();
    return id;
  }

  async handleHook(project, input) {
    if (input.hook_event_name === "PermissionRequest"
      || (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion")) {
      // Reuse the base scope/session checks without letting subagent lifecycle
      // events mark the main turn idle.
      await super.handleHook(project, { ...input, agent_id: undefined, hook_event_name: "PreToolUse" });
      this.busy = true;
      if (project.accessMode === "read-only" && ![
        "Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion",
      ].includes(input.tool_name)) {
        return { hookSpecificOutput: { hookEventName: input.hook_event_name,
          ...(input.hook_event_name === "PermissionRequest"
            ? { decision: { behavior: "deny", message: "This project is read-only." } }
            : { permissionDecision: "deny", permissionDecisionReason: "This project is read-only." }) } };
      }
      const questions = input.tool_name === "AskUserQuestion" ? input.tool_input?.questions : null;
      if (questions && (!Array.isArray(questions) || !questions.length || questions.length > 4)) {
        throw new Error("Unsupported Claude question format; use the native CLI");
      }
      const ids = [];
      for (const question of questions || [null]) ids.push(await this.registerPanel(project, input, question));
      return { _localCodeLinkWait: ids, kind: questions ? "question" : "permission" };
    }
    if (input.agent_id) return {};
    if (["PostToolUse", "PostToolUseFailure"].includes(input.hook_event_name)) {
      for (const item of this.store.state.approvals) {
        if (item.projectId === project.id && item.source === "claude-panel" && item.status === "approved"
          && item.toolName === input.tool_name
          && (item.toolUseId ? item.toolUseId === input.tool_use_id
            : JSON.stringify(item.details.input) === JSON.stringify(input.tool_input))) {
          item.providerObservedAt = now();
          item.toolOutcome = input.hook_event_name === "PostToolUse" ? "succeeded" : "failed";
        }
      }
    }
    if (input.hook_event_name === "SessionStart") {
      this.ready = true;
      this.notBefore = Date.now() + 1000;
    }
    if (input.hook_event_name === "UserPromptSubmit") {
      const item = project.telegramRequests?.find((value) =>
        ["submitting", "queued"].includes(value.status) && input.prompt?.includes(telegramMarker(value.id)));
      if (item) { item.status = "active"; item.startedAt = now(); }
    }
    if (input.hook_event_name === "Stop") {
      const item = project.telegramRequests?.find((value) => value.status === "active");
      if (item) project.claudeLastTelegramTurn = { requestId: item.id, finishedAt: now() };
    }
    const result = await super.handleHook(project, input);
    if (project.localSession) {
      project.localSession.turnStatus = this.busy ? "busy" : "idle";
      await this.store.save();
    }
    if (input.hook_event_name === "SessionEnd") {
      this.ready = false;
      await this.cancelPanels();
    }
    return result;
  }

  async cancelPanels() {
    await this.store.reload();
    for (const item of this.store.state.approvals) {
      if (item.projectId === this.projectId && item.linkId === this.linkId
        && item.source === "claude-panel" && ["pending", "responding"].includes(item.status)) {
        item.status = "cancelled";
        item.resolvedAt = now();
      }
    }
    await this.store.save();
  }

  async stop() {
    clearInterval(this.timer);
    clearTimeout(this.inputEscapeTimer);
    await this.serial.catch(() => {});
    if (this.lockHeld) await this.cancelPanels();
    await super.stop();
  }
}

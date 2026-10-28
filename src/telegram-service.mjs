import { approvalKeyboard, TelegramClient } from "./telegram.mjs";
import { CodingRuntime } from "./runtime.mjs";
import { randomUUID } from "node:crypto";
import { approvalAction, approvalText } from "./approval-sync.mjs";
import { claudeRequest } from "./claude-ipc.mjs";
import { deliveryFailure, deliveryReady, retryDelivery } from "./delivery.mjs";

const ids = (value) => new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
const syncedSources = new Set(["codex-proxy", "codex-shared", "codex-stream", "claude-channel", "claude-stream", "claude-panel"]);
const requestKeyboard = (approval) => {
  if (approval.status !== "pending" || approval.canReply === false) return { inline_keyboard: [] };
  if (approval.type !== "question") return approvalKeyboard(approval.id);
  if (approval.details.question.multiSelect || approval.details.questions?.length > 1) return { inline_keyboard: [] };
  return { inline_keyboard: (approval.details.question.options || []).map((option, index) => [{
    text: String(option.label).slice(0, 60), callback_data: `question:${approval.id}:${index}`,
  }]) };
};

export class TelegramService {
  constructor(store, options = {}) {
    this.store = store;
    this.chatId = String(options.chatId || process.env.TELEGRAM_CHAT_ID || "");
    this.allowedUsers = ids(options.allowedUsers || process.env.TELEGRAM_ALLOWED_USER_IDS);
    this.client = options.client || new TelegramClient(options.token || process.env.TELEGRAM_BOT_TOKEN);
    this.runtime = new CodingRuntime(store, {
      onApproval: (project, approval) => this.sendApproval(project, approval),
      onOutput: (project, output) => this.client.sendMessage(this.chatId, output, { topicId: project.topicId }),
      onDeleteTopic: (project) => this.client.deleteForumTopic(
        project.telegramChatId || this.chatId, project.topicId),
    });
    this.notifyingApprovals = new Set();
    this.editingApprovals = new Set();
    this.refreshingApprovals = false;
    this.approvalDeliveries = new Map();
  }

  async refreshApprovalMessage(project, approval) {
    const renderedStatus = approval.status;
    await this.client.editMessageText(this.chatId, approval.telegramMessageId,
      approvalText(project, approval),
      requestKeyboard(approval));
    await this.store.reload();
    const saved = this.store.state.approvals.find((item) => item.id === approval.id);
    if (saved) {
      saved.telegramDisplayStatus = renderedStatus;
      await this.store.save();
    }
  }

  authorize(userId, chatId) {
    return String(chatId) === this.chatId && this.allowedUsers.has(String(userId));
  }

  async sendApproval(project, approval) {
    if (this.approvalDeliveries.has(approval.id)) return this.approvalDeliveries.get(approval.id);
    const task = this.deliverApproval(project, approval).catch(async (error) => {
      await this.store.reload();
      const saved = this.store.state.approvals.find((item) => item.id === approval.id);
      if (saved) { deliveryFailure(saved, error); await this.store.save(); }
      throw error;
    })
      .finally(() => this.approvalDeliveries.delete(approval.id));
    this.approvalDeliveries.set(approval.id, task);
    return task;
  }

  async deliverApproval(project, approval) {
    const renderedStatus = approval.status;
    const action = approvalAction(approval);
    if (approval.type !== "question" && String(action).length > 1800) {
      // Deliver the complete action before enabling any decision buttons.
      await this.client.sendMessage(this.chatId,
        `Full action for request ${approval.id}:\n${action}`, { topicId: project.topicId });
    }
    await this.store.reload();
    const current = this.store.state.projects[project.id];
    if (!current || ["unlinked", "archived"].includes(current.status)
      || current.topicId !== project.topicId) return;
    const message = await this.client.sendMessage(this.chatId, approvalText(project, approval), {
      topicId: project.topicId,
      replyMarkup: requestKeyboard(approval),
    });
    await this.store.reload();
    const saved = this.store.state.approvals.find((item) => item.id === approval.id);
    if (saved) {
      saved.telegramMessageId = message?.message_id;
      saved.notifiedAt = new Date().toISOString();
      saved.telegramDisplayStatus = renderedStatus;
      await this.store.save();
    }
  }

  async syncApprovalMessages() {
    if (this.refreshingApprovals) return;
    this.refreshingApprovals = true;
    try {
      await this.store.reload();
      for (const approval of this.store.state.approvals) {
        if (!syncedSources.has(approval.source)) continue;
        const project = this.store.state.projects[approval.projectId];
        if (!project || ["unlinked", "archived"].includes(project.status)) continue;
        if (approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now()) {
          approval.status = "expired";
          await this.store.save();
        }
        if (!approval.telegramMessageId) {
          if (!deliveryReady(approval)) continue;
          if (this.notifyingApprovals.has(approval.id)) continue;
          this.notifyingApprovals.add(approval.id);
          void this.sendApproval(project, approval).catch((error) => {
            // Native CLI remains available if Telegram delivery fails.
            console.error(`Approval Telegram delivery: ${error.message}`);
          }).finally(() => this.notifyingApprovals.delete(approval.id));
        } else if (approval.telegramDisplayStatus !== approval.status) {
          if (this.editingApprovals.has(approval.id)) continue;
          this.editingApprovals.add(approval.id);
          void this.refreshApprovalMessage(project, approval).catch((error) => {
            // A slow or failed edit must not delay another project's requests.
            console.error(`Approval Telegram update: ${error.message}`);
          }).finally(() => this.editingApprovals.delete(approval.id));
        }
      }
    } finally { this.refreshingApprovals = false; }
  }

  async handle(update) {
    await this.store.reload();
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const message = update.message;
    if (!message?.text || !message.from) return;
    if (!this.authorize(message.from.id, message.chat.id)) return;
    const topicId = message.message_thread_id;
    const text = message.text.trim();
    if (!topicId || String(topicId) === String(this.store.state.telegram.controlTopicId)) {
      return this.handleControl(text);
    }
    const project = this.runtime.projectByTopic(topicId);
    if (!project) {
      await this.client.sendMessage(this.chatId,
        "This topic is not linked. Run local-code-link codex or local-code-link claude in the project folder to link it.",
        { topicId });
      return;
    }
    if (text === "/delivery") {
      const records = [...(project.claudeOutbox || []),
        ...(project.telegramRequests || []).filter((item) => item.output !== undefined),
        ...this.store.state.approvals.filter((item) => item.projectId === project.id && !item.telegramMessageId)];
      const held = records.filter((item) => item.delivery);
      await this.client.sendMessage(this.chatId, held.length
        ? held.map((item) => `${item.id}: ${item.delivery.state} (Telegram ${item.delivery.code || "retry"}).`
          + ` Inspect Telegram before /retry-delivery ${item.id}; a retry may duplicate a message.`).join("\n")
        : "No held Telegram deliveries.", { topicId });
      return;
    }
    const retry = /^\/retry-delivery\s+([0-9a-z-]+)$/i.exec(text);
    if (retry) {
      const record = (project.claudeOutbox || []).find((item) => item.id === retry[1])
        || (project.telegramRequests || []).find((item) => item.id === retry[1] && item.output !== undefined)
        || this.store.state.approvals.find((item) => item.id === retry[1]
          && item.projectId === project.id && !item.telegramMessageId);
      if (!record?.delivery) {
        await this.client.sendMessage(this.chatId, "No held delivery with that ID in this project.", { topicId });
        return;
      }
      retryDelivery(record);
      await this.store.save();
      await this.client.sendMessage(this.chatId,
        "Delivery retry enabled. This only resends a message; it never reruns coding work or approves a request.", { topicId });
      return;
    }
    if (text.startsWith("/retry-delivery")) {
      await this.client.sendMessage(this.chatId, "Use /delivery, then /retry-delivery ID.", { topicId });
      return;
    }
    const answer = /^\/answer\s+([0-9a-f-]+)\s+([\s\S]+)$/.exec(text);
    if (answer) {
      try {
        await this.runtime.answerQuestion(answer[1], answer[2], message.from, topicId);
        await this.syncApprovalMessages();
      } catch (error) {
        await this.client.sendMessage(this.chatId, `❌ ${error.message}`, { topicId });
      }
      return;
    }
    if (text === "/status") {
      let terminalStatus = "";
      if (project.provider === "claude" && project.localSession?.status === "active") {
        try {
          const status = await claudeRequest(this.store.root, project, "status");
          terminalStatus = status.connected
            ? `Terminal: ${status.waitingFor || (status.busy ? "active turn" : "idle")}${status.queued ? `; ${status.queued} message(s) queued` : ""}`
            : "Terminal: waiting for startup";
        } catch {
          terminalStatus = "Terminal bridge unavailable; reopen with local-code-link claude.";
        }
      }
      await this.client.sendMessage(this.chatId, [
        `${project.name}: ${project.status} (${project.provider})`,
        terminalStatus || (project.localSession?.turnStatus ? `Terminal: ${project.localSession.turnStatus}` : ""),
        project.lastQueueError ? `Queue needs attention: ${project.lastQueueError}` : "",
        [...(project.claudeOutbox || []), ...(project.telegramRequests || []),
          ...this.store.state.approvals.filter((item) => item.projectId === project.id && !item.telegramMessageId)]
          .some((item) => ["uncertain", "blocked"].includes(item.delivery?.state))
          ? "Telegram delivery needs attention: use /delivery." : "",
      ].filter(Boolean).join("\n"), { topicId });
      return;
    }
    if (text === "/unlink") {
      project.unlinkConfirmation = {
        id: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await this.store.save();
      await this.client.sendMessage(this.chatId,
        `Permanently unlink ${project.name}? This deletes its Telegram topic and ALL messages, `
          + "plus its LocalCodeLink mapping, approval history, and request records. "
          + "Project files and native Codex/Claude session history are kept. This cannot be undone.",
        {
          topicId,
          replyMarkup: { inline_keyboard: [[
            { text: "Delete topic and unlink", callback_data: `unlink:${project.unlinkConfirmation.id}:confirm` },
            { text: "Cancel", callback_data: `unlink:${project.unlinkConfirmation.id}:cancel` },
          ]] },
        });
      return;
    }
    if (text === "/interrupt") {
      const interrupted = await this.runtime.interrupt(project.id);
      await this.client.sendMessage(this.chatId, interrupted ? "⏹ Interrupted." : "No active task.", { topicId });
      return;
    }
    if (text === "/new") {
      if (project.localSession?.status === "active" || project.telegramRequests?.length
        || this.runtime.running.has(project.id)) {
        await this.client.sendMessage(this.chatId,
          "Close the local session and finish or interrupt pending Telegram work before /new.",
          { topicId });
        return;
      }
      project.sessionIds = {};
      project.freshSession = true;
      project.status = "idle";
      delete project.lastError;
      await this.store.save();
      await this.client.sendMessage(this.chatId, "Started a fresh provider session.", { topicId });
      return;
    }
    try {
      if (await this.runtime.queueToLocalSession(project, text, { updateId: update.update_id })) {
        await this.client.sendMessage(this.chatId,
          `▶️ Sent to your linked ${project.provider === "claude" ? "Claude" : "Codex"} session. If it is busy, this will run next.`, { topicId });
        return;
      }
    } catch (error) {
      await this.client.sendMessage(this.chatId, `❌ ${error.message}`, { topicId });
      return;
    }
    await this.client.sendMessage(this.chatId, `▶️ Sending to ${project.provider}…`, { topicId });
    void this.runtime.run(project.id, text).catch((error) => console.error(error.message));
  }

  async handleControl(text) {
    if (text === "/projects" || text === "/start") {
      const projects = this.runtime.listProjects();
      const body = projects.length
        ? projects.map((project) => `• ${project.name} — ${project.provider} — ${project.status}`).join("\n")
        : "No projects linked. Run local-code-link claude or local-code-link codex inside a project.";
      await this.client.sendMessage(this.chatId, body, { topicId: this.store.state.telegram.controlTopicId });
      return;
    }
    await this.client.sendMessage(this.chatId, "Control commands: /projects", {
      topicId: this.store.state.telegram.controlTopicId,
    });
  }

  async handleCallback(callback) {
    if (!callback.message || !this.authorize(callback.from.id, callback.message.chat.id)) return;
    const unlink = /^unlink:([0-9a-f-]+):(confirm|cancel)$/.exec(callback.data || "");
    if (unlink) {
      const project = this.runtime.projectByTopic(callback.message.message_thread_id);
      const confirmation = project?.unlinkConfirmation;
      if (!confirmation || confirmation.id !== unlink[1]
        || Date.parse(confirmation.expiresAt) <= Date.now()) {
        await this.client.answerCallbackQuery(callback.id, "This confirmation has expired.");
        return;
      }
      if (unlink[2] === "cancel") {
        delete project.unlinkConfirmation;
        await this.store.save();
        await this.client.answerCallbackQuery(callback.id, "Cancelled.");
        return;
      }
      await this.client.answerCallbackQuery(callback.id, "Removing this project and its topic…");
      try {
        const result = await this.runtime.unlink(project.id, { confirmed: true });
        // The project topic no longer exists. Confirm only in the control topic.
        await this.client.sendMessage(this.chatId,
          `🔌 ${project.name}: Telegram topic/messages and LocalCodeLink records removed. `
            + "Project files and native coding sessions are kept."
            + (result.warnings.length ? `\n${result.warnings.join("\n")}` : ""),
          { topicId: this.store.state.telegram.controlTopicId });
      } catch (error) {
        await this.client.sendMessage(this.chatId, `❌ ${error.message}`,
          { topicId: this.store.state.telegram.controlTopicId });
      }
      return;
    }
    const question = /^question:([0-9a-f-]+):(\d+)$/.exec(callback.data || "");
    if (question) {
      try {
        const item = this.store.state.approvals.find((value) => value.id === question[1]);
        const option = item?.details?.question?.options?.[Number(question[2])];
        if (!option || item.details.question.multiSelect) throw new Error("Invalid question option");
        await this.runtime.answerQuestion(item.id, option.label, callback.from, callback.message.message_thread_id);
        await this.client.answerCallbackQuery(callback.id, `Answer sent to ${item.provider}.`);
        await this.syncApprovalMessages();
      } catch (error) { await this.client.answerCallbackQuery(callback.id, error.message); }
      return;
    }
    const match = /^approval:([0-9a-f-]+):(approve|deny)$/.exec(callback.data || "");
    if (!match) return;
    try {
      const approval = await this.runtime.decideApproval(match[1], match[2], callback.from,
        callback.message.message_thread_id);
      await this.client.answerCallbackQuery(callback.id, approval.status === "responding"
        ? `Decision sent to ${approval.provider}.` : `${approval.status}`);
      if (syncedSources.has(approval.source)) {
        await this.syncApprovalMessages();
      } else {
        await this.client.sendMessage(this.chatId, `Approval ${approval.status}.`, {
          topicId: callback.message.message_thread_id,
        });
      }
    } catch (error) {
      await this.client.answerCallbackQuery(callback.id, error.message);
    }
  }

  async start() {
    await this.client.getMe();
    await this.store.reload();
    let recovered = false;
    for (const project of Object.values(this.store.state.projects)) {
      if (project.provider === "claude") {
        const pid = project.backgroundTask?.pid;
        let alive = false;
        if (pid) {
          try { process.kill(pid, 0); alive = true; }
          catch (error) { if (error.code !== "ESRCH") alive = true; }
        }
        if (alive) {
          project.lastQueueError = "Previous background Claude process is still alive. Do not resubmit; inspect or close it before retrying.";
        } else {
          delete project.backgroundTask;
          for (const request of project.telegramRequests || []) {
            if (request.dispatch !== "stream" || request.status !== "active"
              || project.claudeOutbox?.some((item) => item.id === request.id)) continue;
            request.status = "interrupted";
            project.claudeOutbox ||= [];
            project.claudeOutbox.push({ id: request.id,
              text: "⏹ Background Claude task was interrupted by a service restart. It was not replayed; inspect the saved session before retrying.",
              createdAt: new Date().toISOString() });
          }
        }
        recovered = true;
      }
      if (project.status !== "busy") continue;
      const owner = project.backgroundTask?.pid || project.localSession?.pid;
      if (owner) {
        try { process.kill(owner, 0); continue; } catch (error) { if (error.code !== "ESRCH") continue; }
      }
      project.status = "interrupted";
      project.lastError = "Interrupted because the LocalCodeLink service restarted";
      recovered = true;
    }
    if (recovered) await this.store.save();
    this.client.offset = this.store.state.telegram.updateOffset || 0;
    this.client.onOffset = async (offset) => {
      await this.store.reload();
      this.store.state.telegram.updateOffset = Math.max(this.store.state.telegram.updateOffset || 0, offset);
      await this.store.save();
    };
    await this.runtime.recoverCodexRequests();
    await this.cleanupInactiveProjects();
    this.cleanupTimer = setInterval(
      () => this.cleanupInactiveProjects().catch(console.error),
      24 * 60 * 60 * 1000,
    );
    this.cleanupTimer.unref();
    console.log("LocalCodeLink Telegram service is running.");
    this.approvalSyncTimer = setInterval(() =>
      this.syncApprovalMessages().catch((error) => console.error(error.message)), 250);
    this.approvalSyncTimer.unref();
    this.claudeOutputTimer = setInterval(() =>
      this.runtime.deliverClaudeOutbox().catch((error) => console.error(`Claude output: ${error.message}`)), 250);
    this.claudeOutputTimer.unref();
    this.codexRecoveryTimer = setInterval(() =>
      this.runtime.recoverCodexRequests().catch((error) => console.error(`Codex recovery: ${error.message}`)), 5000);
    this.codexRecoveryTimer.unref();
    try { await this.client.poll((update) => this.handle(update)); }
    finally {
      clearInterval(this.cleanupTimer);
      clearInterval(this.approvalSyncTimer);
      clearInterval(this.claudeOutputTimer);
      clearInterval(this.codexRecoveryTimer);
      this.runtime.stop();
    }
  }

  async cleanupInactiveProjects(days = Number(process.env.LOCAL_CODE_LINK_RETENTION_DAYS || 90)) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
      throw new Error("LOCAL_CODE_LINK_RETENTION_DAYS must be an integer from 1 to 36500. No topics were archived.");
    }
    await this.store.reload();
    const cutoff = Date.now() - days * 86_400_000;
    for (const project of Object.values(this.store.state.projects)) {
      const activeAt = Date.parse(project.lastActiveAt);
      if (!Number.isFinite(activeAt) || !Number.isSafeInteger(Number(project.topicId)) || Number(project.topicId) <= 0
        || Number(project.topicId) === Number(this.store.state.telegram.controlTopicId)
        || ["archived", "unlinked", "busy"].includes(project.status)
        || project.telegramRequests?.length || this.runtime.running.has(project.id)
        || project.localSession?.turnStatus === "busy" || activeAt > cutoff) continue;
      await this.client.closeForumTopic(this.chatId, project.topicId);
      project.status = "archived";
      project.archivedAt = new Date().toISOString();
    }
    await this.store.save();
  }
}

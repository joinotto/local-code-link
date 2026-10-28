import { createHash, randomUUID } from "node:crypto";
import { now } from "./state.mjs";

export const CODEX_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
export const CODEX_QUESTION_METHODS = new Set(["item/tool/requestUserInput", "tool/requestUserInput"]);
export const CODEX_REQUEST_METHODS = new Set([...CODEX_APPROVAL_METHODS, ...CODEX_QUESTION_METHODS]);

export function codexQuestionResult(approval, answer) {
  const questions = approval.details.questions;
  if (questions.some((question) => question.isSecret)) {
    throw new Error("Sensitive questions must be answered in the native Codex terminal, not Telegram.");
  }
  let provided = answer;
  if (questions.length > 1) {
    try { provided = JSON.parse(answer); } catch {
      throw new Error("Answer all questions with /answer REQUEST_ID followed by a JSON object keyed by question ID.");
    }
    if (!provided || typeof provided !== "object" || Array.isArray(provided)) throw new Error("Expected answers keyed by question ID.");
    if (Object.keys(provided).some((id) => !questions.some((question) => question.id === id))) {
      throw new Error("Answer contains an unknown question ID.");
    }
  }
  const answers = Object.fromEntries(questions.map((question) => {
    const value = questions.length === 1 ? provided : provided[question.id];
    if (typeof value !== "string" || !value.trim() || value.length > 5000) {
      throw new Error(`An answer is required for question ${question.id}.`);
    }
    const labels = question.options?.map((option) => option.label) || [];
    if (labels.length && !question.isOther && !labels.includes(value.trim())) {
      throw new Error(`Choose one of the listed options for ${question.id}.`);
    }
    return [question.id, { answers: [value.trim()] }];
  }));
  return { answers };
}

export function codexApprovalId(message, project) {
  const params = message.params;
  const key = JSON.stringify([
    project.linkId || project.topicId, message.method, params.threadId,
    params.turnId, params.itemId, params.approvalId, params.networkApprovalContext,
    // One item can ask for approval more than once.
    message.id,
  ]);
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export async function registerCodexApproval(store, project, message, source, owner = {}) {
  await store.reload();
  const currentProject = store.state.projects[project.id];
  if (!currentProject || ["unlinked", "archived"].includes(currentProject.status)
    || Number(currentProject.topicId) !== Number(project.topicId)) return null;
  const id = codexApprovalId(message, project);
  let approval = store.state.approvals.find((item) => item.id === id);
  if (approval) return approval;
  const params = message.params;
  const question = CODEX_QUESTION_METHODS.has(message.method);
  if (question && (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 3
    || params.questions.some((item) => !item.id || typeof item.question !== "string")
    || new Set(params.questions.map((item) => item.id)).size !== params.questions.length)) {
    throw new Error("Unsupported Codex question format; answer in the native terminal.");
  }
  const secret = question && params.questions.some((item) => item.isSecret);
  const type = question ? "question" : message.method.includes("commandExecution")
    ? "command" : message.method.includes("fileChange") ? "file_change" : "permissions";
  approval = {
    id, projectId: project.id, topicId: project.topicId,
    provider: "codex", source, status: "pending", type,
    ...(source === "codex-proxy" ? owner : {}),
    summary: secret ? "Sensitive question: answer in the native Codex terminal."
      : question ? params.questions.map((item) => item.question).join("\n") : params.command || params.reason || `Codex ${type} request`,
    details: secret ? {} : { ...params, ...(question ? { question: params.questions[0] } : {}) },
    ...(secret ? { canReply: false } : {}),
    ...(type === "file_change" && !Array.isArray(params.proposedChanges) ? { canReply: false } : {}),
    linkId: currentProject.linkId,
    method: message.method, serverRequestId: message.id,
    threadId: params.threadId, turnId: params.turnId, itemId: params.itemId,
    createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  store.state.approvals.push(approval);
  await store.save();
  await store.reload();
  return store.state.approvals.find((item) => item.id === id) || null;
}

export function codexDecisionResult(approval, decision) {
  if (approval.method === "item/permissions/requestApproval") {
    return { permissions: decision === "approve" ? approval.details.permissions || {} : {}, scope: "turn" };
  }
  return {
    decision: decision === "approve" ? "accept"
      : approval.details.availableDecisions?.includes("decline") ? "decline" : "cancel",
  };
}

export function decisionFromCodexResult(result) {
  if ("permissions" in (result || {})) {
    const hasGrant = (value) => {
      if (value === null || value === undefined || value === false) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.values(value).some(hasGrant);
      return Boolean(value);
    };
    return hasGrant(result.permissions) ? "approve" : "deny";
  }
  if (result?.answers) {
    return Object.values(result.answers).some((answer) => Array.isArray(answer?.answers)
      && answer.answers.some((value) => typeof value === "string" && value.trim())) ? "approve" : "deny";
  }
  const decision = result?.decision;
  return decision === "accept" || decision === "acceptForSession"
    || (decision && typeof decision === "object") ? "approve" : "deny";
}

// Both the native relay and Telegram use the same disk-backed first-writer
// claim. The provider response is sent only by the winning claim.
export async function claimCodexApproval(store, id, decision, actor, origin, result) {
  await store.reload();
  const approval = store.state.approvals.find((item) => item.id === id);
  if (!approval || (approval.status !== "pending"
    && !(origin === "cli" && approval.status === "expired"))) {
    throw new Error("Approval is no longer pending");
  }
  const project = store.state.projects[approval.projectId];
  if (!project || ["unlinked", "archived"].includes(project.status)) {
    throw new Error("Project is no longer linked");
  }
  if (origin === "telegram" && Date.parse(approval.expiresAt) <= Date.now()) {
    throw new Error("Approval has expired");
  }
  const claimId = randomUUID();
  approval.status = "responding";
  approval.claimId = claimId;
  approval.decision = decision;
  approval.decidedVia = origin;
  approval.decidedBy = String(typeof actor === "object" ? actor.id : actor);
  const label = typeof actor === "object"
    ? actor.username ? `@${actor.username}` : [actor.first_name, actor.last_name].filter(Boolean).join(" ")
    : actor;
  approval.decidedByLabel = String(label || approval.decidedBy)
    .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  approval.decidedAt = now();
  approval.response = result || codexDecisionResult(approval, decision);
  await store.save();
  await store.reload();
  const winner = store.state.approvals.find((item) => item.id === id);
  if (!winner || winner.claimId !== claimId) throw new Error("Approval was already handled in another place");
  return winner;
}

export async function resolveCodexApproval(store, id) {
  await store.reload();
  const approval = store.state.approvals.find((item) => item.id === id);
  if (!approval) return;
  if (approval.status === "responding") {
    approval.status = approval.decision === "approve" ? "approved" : "denied";
  } else if (approval.status === "pending") {
    // External clients/interruption can resolve a request without exposing the
    // decision in serverRequest/resolved. Never invent an approve/deny outcome.
    approval.status = "resolved";
    approval.decidedVia = "codex";
  }
  approval.resolvedAt = now();
  const resolved = structuredClone(approval);
  await store.save();
  // Another local timer can reload this same Store instance during the save.
  // Return the confirmed resolution snapshot, not a later mutable reference.
  return resolved;
}

export function approvalAction(approval) {
  if (approval.details?.networkApprovalContext) {
    const context = approval.details.networkApprovalContext;
    return `Network access: ${context.protocol || "network"}://${context.host || "(unknown host)"}${context.port ? `:${context.port}` : ""}`
      + `\n${JSON.stringify(context)}`;
  }
  if (approval.type === "file_change") return `File changes:\n${JSON.stringify(approval.details.proposedChanges || { previewUnavailable: true })}`;
  if (approval.type === "permissions") return `Requested permissions:\n${JSON.stringify(approval.details.permissions || {})}`;
  return approval.details?.command || approval.details?.input?.command
    || (approval.details?.input ? JSON.stringify(approval.details.input) : approval.details?.input_preview)
    || approval.summary;
}

export function approvalText(project, approval) {
  const action = approval.type === "question" ? approval.summary : approvalAction(approval);
  const provider = approval.provider === "claude" ? "Claude" : "Codex";
  const origin = approval.decidedVia === "cli" ? `${provider} CLI`
    : approval.decidedVia === "telegram" ? "Telegram" : provider;
  const question = approval.type === "question";
  const heading = approval.status === "pending" ? question ? "❓ Answer required" : "🔐 Approval required"
    : approval.status === "approved" ? `✅ ${question ? "Answered" : "Approved"} in ${origin}`
    : approval.status === "denied" ? `❌ Denied in ${origin}`
    : approval.status === "responding" ? `⏳ ${approval.decision === "approve" ? "Approval" : "Denial"} sent from ${origin}`
    : `⏹ Request ${approval.status} in ${origin}`;
  return [`${heading} — ${project.name}`, `Provider: ${approval.provider}`,
    ...(approval.decidedBy ? [`By: ${approval.decidedByLabel || approval.decidedBy}`
      + (approval.decidedVia === "telegram" ? ` (Telegram user ${approval.decidedBy})` : "")] : []),
    `Action: ${String(action).slice(0, 1800)}`,
    ...(String(action).length > 1800
      ? ["Full tool arguments are sent separately above this request."] : []),
    ...(question && approval.canReply !== false ? [
      ...(approval.details.questions || [approval.details.question]).flatMap((item) => [
        `Question${item.id ? ` (${item.id})` : ""}: ${item.question}`,
        ...(item.options || []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
      ]),
      approval.response?.answer ? `Answer: ${approval.response.answer}`
        : approval.response?.answers ? `Answers: ${JSON.stringify(approval.response.answers)}`
        : `Type /answer ${approval.id} ${approval.details.questions?.length > 1
          ? JSON.stringify(Object.fromEntries(approval.details.questions.map((item) => [item.id, "your answer"])))
          : "your answer"}`,
    ] : []),
    ...(approval.canReply === false ? ["Answer in the native CLI. Telegram cannot answer this request."] : []),
    `Request: ${approval.id}`].join("\n").slice(0, 4000);
}

export function approvalDecisionNotice(approval) {
  if (!["approved", "denied"].includes(approval?.status)
    || !["cli", "telegram"].includes(approval.decidedVia)) return null;
  const origin = approval.decidedVia === "telegram" ? "Telegram"
    : approval.provider === "claude" ? "Claude CLI" : "Codex CLI";
  const actor = approval.decidedByLabel || approval.decidedBy || "local user";
  const id = approval.decidedVia === "telegram" ? ` (user ${approval.decidedBy})` : "";
  return `LocalCodeLink: ${approval.status === "approved" ? approval.type === "question" ? "Answered" : "Approved" : "Denied"} `
    + `via ${origin} by ${actor}${id}. Request ${approval.id}.`;
}

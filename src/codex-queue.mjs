// A legacy release recorded this explicit provider rejection as uncertain.
// No queue entry was accepted. Never generalize this to transport failures,
// accepted queue IDs, or results awaiting delivery.
export const rejectedEphemeralSubmission = (request) => request.status === "submission_uncertain"
  && !request.queuedSubmissionId && request.output === undefined
  && /^ephemeral thread does not support queued submissions:/i.test(request.lastError || "");

export function discardRejectedEphemeralSubmissions(project) {
  if (!project.telegramRequests?.some(rejectedEphemeralSubmission)) return false;
  project.telegramRequests = project.telegramRequests.filter((request) => !rejectedEphemeralSubmission(request));
  project.lastQueueError = "A previous Telegram prompt was rejected by a memory-only Codex session and was not queued.";
  return true;
}

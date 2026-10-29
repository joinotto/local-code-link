import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { discardRejectedEphemeralSubmissions } from "./codex-queue.mjs";

export async function sameProjectDirectory(actual, expected) {
  if (typeof actual !== "string" || !path.isAbsolute(actual)) return false;
  try {
    return await realpath(actual) === await realpath(expected);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export async function assertCurrentProject(project, currentDirectory = process.cwd()) {
  if (!await sameProjectDirectory(currentDirectory, project.cwd)) {
    throw new Error("Refusing to open a coding session for a different folder. Run local-code-link inside the intended project.");
  }
}

const sameGeneration = (left, right) => left?.id === right?.id
  && left?.linkId === right?.linkId && left?.topicId === right?.topicId;

const missingThread = (error) => /(?:thread|session).*(?:not found|does not exist)|no (?:saved )?(?:thread|session) (?:found|with)/i
  .test(error.message || "");
const unloadedThread = (error) => /^thread not loaded:\s/i.test(error.message || "");

async function hasResumableRollout(thread, client) {
  if (thread.ephemeral === true) {
    throw new Error("The saved Codex thread is memory-only. Save any needed context, close its terminal and use /new in its Telegram topic before reopening.");
  }
  if (thread.path != null && (typeof thread.path !== "string" || !path.isAbsolute(thread.path))) {
    throw new Error("Codex returned an invalid rollout path; refusing to replace the saved session.");
  }
  if (thread.path) {
    try {
      const file = await stat(thread.path);
      if (!file.isFile()) throw new Error("Codex's saved rollout is not a regular file; inspect it before reopening.");
      if (file.size > 0) {
        if (thread.historyMode === "paginated") {
          throw new Error("The saved Codex thread uses paginated history, which this bridge does not support for Telegram results. Preserve its context and explicitly use /new if you want a fresh managed session.");
        }
        return true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (thread.status?.type === "active") {
    throw new Error("Codex is active but its rollout is not saved yet. Finish the active turn before reopening; no new session was started.");
  }
  // A persistent thread's path may be only a reservation until its first
  // user message. It cannot bootstrap native TUI resume yet. Check metadata
  // only, never read prompts or silently discard existing in-memory history.
  let turns;
  try {
    turns = await client.request("thread/turns/list", {
      threadId: thread.id, itemsView: "notLoaded", limit: 1,
    });
  } catch (error) {
    if (error.codexRejected !== true
      || !/is not materialized yet; thread\/turns\/list is unavailable before first user message/i.test(error.message || "")) throw error;
    return false;
  }
  if (!Array.isArray(turns?.data)) throw new Error("Cannot verify saved Codex turns; the binding was preserved.");
  if (turns.data.length) {
    throw new Error("Codex's rollout is missing but the thread has existing turns. Preserve its context and restore the history or explicitly use /new; no replacement was started.");
  }
  return false;
}

export async function selectCodexSession(store, project, client, currentDirectory = process.cwd()) {
  await assertCurrentProject(project, currentDirectory);
  const generation = { id: project.id, linkId: project.linkId, topicId: project.topicId };
  await store.reload();
  const current = store.state.projects[project.id];
  if (!sameGeneration(generation, current) || ["unlinked", "archived"].includes(current.status)) {
    throw new Error("Project link changed while opening Codex; run the command again.");
  }
  const sessionId = current.sessionIds?.codex;
  if (!sessionId) return { sessionId: null, reason: null };

  await client.connect();
  let reason;
  let valid = false;
  try {
    const { thread } = await client.request("thread/read", { threadId: sessionId, includeTurns: false });
    if (thread?.id !== sessionId) throw new Error("Codex returned unexpected session metadata; refusing to resume.");
    valid = await sameProjectDirectory(thread.cwd, current.cwd);
    if (!valid) reason = "different folder";
    else if (!await hasResumableRollout(thread, client)) {
      valid = false;
      reason = "session has no saved rollout yet";
    }
  } catch (error) {
    if (!missingThread(error) && !unloadedThread(error)) throw error;
    reason = unloadedThread(error) ? "session no longer loaded" : "missing session";
  }

  await store.reload();
  const saved = store.state.projects[project.id];
  if (!sameGeneration(generation, saved) || saved.sessionIds?.codex !== sessionId
    || ["unlinked", "archived"].includes(saved.status)) {
    throw new Error("Project session changed while checking it; run the command again.");
  }
  // CLI recovery must not depend on a Telegram daemon reload. Remove only
  // legacy requests that the provider explicitly rejected before queueing.
  // Real queued work and transport-uncertain submissions still block a switch.
  const discarded = discardRejectedEphemeralSubmissions(saved);
  if (valid) {
    if (discarded) await store.save();
    return { sessionId, reason: null };
  }
  if (saved.telegramRequests?.length || saved.status === "busy") {
    if (discarded) await store.save();
    throw new Error("Saved Codex session is not valid for this folder, but Telegram work is pending. Resolve that work before opening a new session.");
  }
  // Drop the bridge's stale binding only. Never delete or reconfigure the
  // other project's native thread, mapping, transcript, or active process.
  delete saved.sessionIds.codex;
  if (saved.transcriptPaths) delete saved.transcriptPaths.codex;
  if (saved.localSession?.sessionId === sessionId) delete saved.localSession;
  await store.save();
  return { sessionId: null, reason };
}

export function codexInteractiveArgs(project, endpoint, sessionId) {
  return ["--remote", endpoint, "--cd", project.cwd,
    ...(sessionId ? ["resume", sessionId] : [])];
}

import { realpath } from "node:fs/promises";
import path from "node:path";

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
  } catch (error) {
    if (!missingThread(error)) throw error;
    reason = "missing session";
  }

  await store.reload();
  const saved = store.state.projects[project.id];
  if (!sameGeneration(generation, saved) || saved.sessionIds?.codex !== sessionId
    || ["unlinked", "archived"].includes(saved.status)) {
    throw new Error("Project session changed while checking it; run the command again.");
  }
  if (valid) return { sessionId, reason: null };
  if (saved.telegramRequests?.length || saved.status === "busy") {
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

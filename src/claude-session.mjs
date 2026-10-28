import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { sameProjectDirectory } from "./session-scope.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listClaudeSessions(cwd, root = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects")) {
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const results = [];
  // Verify transcript metadata, not the lossy folder-name encoding or a global
  // --continue. Two similarly named projects must never share a session.
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const folder = path.join(root, directory.name);
    for (const file of await readdir(folder)) {
      if (!file.endsWith(".jsonl") || !uuid.test(file.slice(0, -6))) continue;
      const transcriptPath = path.join(folder, file);
      let metadata;
      // Session metadata is near the beginning. Never load every project's
      // complete coding history just to choose one session.
      const stream = createReadStream(transcriptPath, { end: 1024 * 1024, highWaterMark: 4096 });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          try {
            const value = JSON.parse(line);
            if (value.cwd && value.sessionId === file.slice(0, -6)) { metadata = value; break; }
          } catch { /* Incomplete lines are not metadata. */ }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!metadata || !await sameProjectDirectory(cwd, metadata.cwd)) continue;
      results.push({ sessionId: metadata.sessionId, transcriptPath,
        modifiedAt: (await stat(transcriptPath)).mtimeMs });
    }
  }
  return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function selectClaudeSession(store, project, root) {
  const linkId = project.linkId || project.topicId;
  const sessions = await listClaudeSessions(project.cwd, root);
  const saved = project.sessionIds?.claude;
  const match = saved ? sessions.find((session) => session.sessionId === saved)
    : project.freshSession ? null : sessions[0];
  await store.reload();
  const current = store.state.projects[project.id];
  if (!current || (current.linkId || current.topicId) !== linkId
    || ["unlinked", "archived"].includes(current.status)) throw new Error("Project link changed");
  if ((current.sessionIds?.claude || null) !== (saved || null)) {
    throw new Error("Claude session changed; retry with the current project");
  }
  if (saved && !match && current.telegramRequests?.length) {
    throw new Error("Saved Claude session cannot be verified while Telegram requests are pending");
  }
  current.sessionIds ||= {};
  current.sessionIds.claude = match?.sessionId || null;
  delete current.freshSession;
  if (match) {
    current.transcriptPaths ||= {};
    current.transcriptPaths.claude = match.transcriptPath;
  } else if (current.transcriptPaths) delete current.transcriptPaths.claude;
  await store.save();
  return match || { sessionId: null };
}

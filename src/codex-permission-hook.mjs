#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, now } from "./state.mjs";
import { TelegramClient } from "./telegram.mjs";
import { loadConfiguration } from "./config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const readStdin = async () => {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
};

const fallback = () => console.log("{}");

try {
  const input = await readStdin();
  if (input.hook_event_name === "PermissionRequest") {
    // Return immediately so Codex shows its native prompt. The TUI relay mirrors
    // the same JSON-RPC approval and observes decisions from either interface.
    fallback();
    process.exit(0);
  }
  await loadConfiguration(projectRoot);
  const store = await new StateStore(
    process.env.LOCAL_CODE_LINK_HOME || path.join(os.homedir(), ".local-code-link"),
  ).init();
  const sessionCwd = path.resolve(input.cwd);
  const project = Object.values(store.state.projects)
    .filter((item) => path.resolve(item.cwd) === sessionCwd)
    .sort((left, right) => right.cwd.length - left.cwd.length)[0];
  if (!project || ["unlinked", "archived"].includes(project.status)
    || !process.env.TELEGRAM_BOT_TOKEN || !store.state.telegram.chatId) {
    fallback();
    process.exit(0);
  }

  project.sessionIds ||= {};
  if (input.session_id) project.sessionIds.codex = input.session_id;
  project.transcriptPaths ||= {};
  if (input.transcript_path) project.transcriptPaths.codex = input.transcript_path;
  if (input.hook_event_name === "SessionStart") {
    project.localSession = {
      status: "active",
      sessionId: input.session_id || null,
      pid: project.localSession?.pid || null,
      approvalProxyPid: project.localSession?.approvalProxyPid || null,
      startedAt: now(),
    };
    await store.save();
    fallback();
    process.exit(0);
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    const match = /\[LocalCodeLink Telegram request ([0-9a-f-]+)\]/i.exec(input.prompt || "");
    const request = match
      ? project.telegramRequests?.find((item) => item.id === match[1])
      : null;
    if (request) {
      request.status = "active";
      request.turnId = input.turn_id || null;
      request.startedAt = now();
      await store.save();
    }
    fallback();
    process.exit(0);
  }
  if (input.hook_event_name === "Stop") {
    const requestIndex = project.telegramRequests?.findIndex((item) =>
      item.status === "active"
      && (!item.turnId || !input.turn_id || item.turnId === input.turn_id)) ?? -1;
    // Shared-server requests have a durable transcript watcher. Do not race it
    // and deliver the same answer twice from the Stop hook.
    if (requestIndex >= 0 && !project.telegramRequests[requestIndex].transcriptPath
      && input.last_assistant_message) {
      const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
      await client.sendMessage(
        store.state.telegram.chatId,
        input.last_assistant_message,
        { topicId: project.topicId },
      );
      project.telegramRequests.splice(requestIndex, 1);
      await store.save();
    }
    fallback();
    process.exit(0);
  }
  fallback();
} catch (error) {
  console.error(`LocalCodeLink hook: ${error.message}`);
  fallback();
}

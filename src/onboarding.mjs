import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function telegramReady(store, env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && store.state.telegram.botId
    && store.state.telegram.chatId && store.state.telegram.controlTopicId
    && env.TELEGRAM_ALLOWED_USER_IDS);
}

export async function ensureTelegramReady({
  store, env = process.env, interactive, setup, log = console.log,
}) {
  if (telegramReady(store, env)) return false;
  if (!interactive) {
    throw new Error("First-time setup needs an interactive terminal. Run local-code-link in your project folder; it will guide you through Telegram setup.");
  }
  log("First run: let's connect your Telegram bot. Setup is required only once.");
  await setup();
  if (!telegramReady(store, env)) throw new Error("Telegram setup is incomplete; no project was linked or coding session started.");
  return true;
}

export async function projectDirectory(value, cwd, home = os.homedir()) {
  const selected = value === "~" ? home
    : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(cwd, value);
  let canonical;
  try {
    canonical = await realpath(selected);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Error("Project folder does not exist or is not accessible. Choose an existing folder.");
  }
  return canonical;
}

export function providerChoice(answer, providers) {
  const selected = /^[1-9]\d*$/.test(answer) ? providers[Number(answer) - 1] : answer.toLowerCase();
  if (!providers.includes(selected)) throw new Error("Choose one of the installed coding providers shown above.");
  return selected;
}

export async function prepareQuickStart({
  store, env = process.env, interactive, cwd = process.cwd(), ask, discover,
  setup, directory = projectDirectory, log = console.log,
}) {
  if (!interactive) throw new Error("Run local-code-link in an interactive terminal, or use local-code-link help.");
  const providers = await discover();
  if (!providers.length) {
    throw new Error("No coding CLI found. Install and sign in to Claude Code or Codex, then run local-code-link again.");
  }
  log("LocalCodeLink — connect this project to Telegram.");
  const folder = await directory(await ask("Project folder", cwd), cwd);
  const existing = Object.values(store.state.projects).find((project) => project.cwd === folder);
  let provider = providers[0];
  if (providers.length > 1) {
    providers.forEach((name, index) => log(`  ${index + 1}. ${name === "claude" ? "Claude Code" : "Codex"}`));
    const preferred = providers.indexOf(existing?.provider);
    provider = providerChoice(await ask("Coding provider", String(preferred >= 0 ? preferred + 1 : 1)), providers);
  } else log(`Using ${provider === "claude" ? "Claude Code" : "Codex"}.`);
  await ensureTelegramReady({ store, env, interactive, setup, log });
  return { cwd: folder, provider };
}

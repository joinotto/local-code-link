import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const keys = new Set(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS",
  "LOCAL_CODE_LINK_HOME", "LOCAL_CODE_LINK_RETENTION_DAYS", "CLAUDE_BIN", "CODEX_BIN"]);
export const stateDirectory = (env = process.env) =>
  path.resolve(env.LOCAL_CODE_LINK_HOME || path.join(os.homedir(), ".local-code-link"));
export const configurationFile = (env = process.env) =>
  path.resolve(env.LOCAL_CODE_LINK_ENV_FILE || path.join(stateDirectory(env), "config.env"));

async function loadFile(file, env) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("LocalCodeLink configuration must be a small regular file.");
    if (process.platform !== "win32" && (info.mode & 0o077)) {
      throw new Error(`LocalCodeLink configuration is not private. Run chmod 600 on ${file} before continuing.`);
    }
    const text = await readFile(file, "utf8");
    // Configuration is data, never shell code. Environment settings take precedence.
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && keys.has(match[1]) && env[match[1]] === undefined) env[match[1]] = match[2];
    }
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

export async function loadConfiguration(projectRoot, env = process.env) {
  const file = configurationFile(env);
  let loaded = await loadFile(file, env);
  let legacy = false;
  if (!loaded && !env.LOCAL_CODE_LINK_ENV_FILE) {
    legacy = await loadFile(path.join(projectRoot, ".env"), env);
    loaded = legacy;
  }
  const target = configurationFile(env);
  // Existing deployments keep reading their legacy file until setup explicitly
  // saves the new private file. A service must not point to a nonexistent file.
  const activeFile = legacy ? path.join(projectRoot, ".env") : file;
  env.LOCAL_CODE_LINK_ENV_FILE = activeFile;
  return { file: target, activeFile, loaded, legacy };
}

export async function saveConfiguration(file, values) {
  const text = Object.entries(values).map(([key, value]) => {
    if (!keys.has(key) || typeof value !== "string" && typeof value !== "number"
      || /[\r\n\0]/.test(String(value))) throw new Error("Invalid LocalCodeLink configuration value.");
    return `${key}=${value}`;
  }).join("\n") + "\n";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    await chmod(file, 0o600);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

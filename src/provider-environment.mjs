import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Only provider configuration/authentication is copied. Never import Telegram
// tokens, arbitrary executable paths, NODE_OPTIONS, or shell startup output.
export const PROVIDER_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_DIR", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SDK_LOAD_CONFIG",
  "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_SESSION_NAME",
  "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_API_KEY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_APP_SERVER_SOCKET",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
];
export function providerValues(environment) {
  return Object.fromEntries(PROVIDER_ENV_KEYS.filter((key) =>
    typeof environment[key] === "string" && environment[key].length <= 64_000)
    .map((key) => [key, environment[key]]));
}
export function codingEnvironment(environment = process.env) {
  const result = { ...environment };
  // Provider credentials are needed by the agent, the messaging bot token
  // is not. Keep the messaging control plane out of coding child processes.
  delete result.TELEGRAM_BOT_TOKEN;
  return result;
}
export function exportedClaudeProvider(environment) {
  const modes = [["bedrock", "CLAUDE_CODE_USE_BEDROCK"], ["vertex", "CLAUDE_CODE_USE_VERTEX"],
    ["foundry", "CLAUDE_CODE_USE_FOUNDRY"]].filter(([, key]) => ["1", "true"].includes(environment[key]));
  if (modes.length > 1) throw new Error("Multiple Claude cloud providers are enabled. Select one in your shell configuration.");
  return modes[0]?.[0] || null;
}
export function checkClaudeProvider(expected, environment) {
  if (expected && exportedClaudeProvider(environment) !== expected) {
    throw new Error(`This project was linked using ${expected}, but its background provider configuration differs. Configure the same provider in your login shell and relink; no session was started.`);
  }
}
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const captureFile = fileURLToPath(new URL("./provider-environment-export.mjs", import.meta.url));
const execute = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, output) => error ? reject(error) : resolve(output));
});

export async function resolveProviderEnvironment(options = {}) {
  const base = options.env || process.env;
  const shell = base.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  if (!["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash"].includes(shell)) {
    throw new Error("Background provider authentication requires a supported zsh/bash login shell. Run local-code-link serve from your authenticated terminal.");
  }
  const nonce = `LCL_ENV_${randomUUID()}=`;
  const command = `exec ${quote(process.execPath)} ${quote(captureFile)} ${quote(nonce)}`;
  let output;
  try {
    output = await (options.execute || execute)(shell, ["-lic", command], {
      env: codingEnvironment(base), cwd: base.HOME, timeout: options.timeoutMs || 15_000,
      maxBuffer: 256 * 1024, windowsHide: true,
    });
  } catch {
    // Startup output and subprocess errors can contain credentials. Do not
    // expose either, including through Error.cause or structured logs.
    throw new Error("Could not load background provider authentication from your login shell. Check shell startup, or run local-code-link serve from your authenticated terminal.");
  }
  const record = output.split(/\r?\n/).find((line) => line.startsWith(nonce));
  try {
    const values = JSON.parse(record?.slice(nonce.length));
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
    return { ...base, ...providerValues(values) };
  } catch {
    throw new Error("Login shell did not return valid provider configuration. No background coding session was started.");
  }
}

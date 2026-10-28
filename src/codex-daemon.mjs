import { execFile } from "node:child_process";
import { codingEnvironment } from "./provider-environment.mjs";

const execute = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, options, (error, stdout, stderr) => {
    resolve({ error, stdout: stdout || "", stderr: stderr || "" });
  });
});

export async function startSharedCodexServer(executable, options = {}) {
  const result = await (options.execute || execute)(executable,
    ["app-server", "daemon", "start"], {
      env: codingEnvironment(options.env || process.env),
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
  const error = result.error;
  if (!error) return;
  const prefix = "Cannot start the shared Codex server";
  if (error.code === "ENOENT") {
    throw new Error(`${prefix}: executable not found (${executable}). `
      + "Run command -v codex in the terminal where Codex works, then set CODEX_BIN "
      + "to that absolute path when running LocalCodeLink setup.");
  }
  if (error.code === "EACCES") {
    throw new Error(`${prefix}: the Codex executable is not accessible or executable (${executable}). Check its installation and permissions.`);
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    throw new Error(`${prefix}: startup diagnostic output exceeded the safe limit. Check Codex's daemon status before retrying.`);
  }
  if (error.killed || error.code === "ETIMEDOUT") {
    throw new Error(`${prefix}: startup timed out after 30 seconds. Check Codex's daemon status before retrying; LocalCodeLink did not stop or restart it.`);
  }
  // execFile's message includes the command/output. Do not use it as a fallback:
  // empty output must still identify the OS code or process signal.
  const detail = result.stderr.trim() || result.stdout.trim()
    || (error.signal ? `terminated by ${error.signal}`
      : error.code !== undefined ? `exit/code ${error.code}` : "process launch failed");
  throw new Error(`${prefix}: ${detail}`);
}

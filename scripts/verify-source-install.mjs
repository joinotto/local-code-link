// Installs the public GitHub archive into a temporary global prefix, never the user's real prefix.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execute = promisify(execFile);
const source = process.argv[2] || "https://github.com/joinotto/local-code-link/archive/refs/heads/main.tar.gz";
if (!/^https:\/\/github\.com\/joinotto\/local-code-link\/archive\/(?:[a-f0-9]{40}|refs\/heads\/[A-Za-z0-9_./-]+)\.tar\.gz$/.test(source)) {
  throw new Error("Use an HTTPS source archive from joinotto/local-code-link.");
}
const root = await mkdtemp(path.join(os.tmpdir(), "lcl-source-install-"));
const prefix = path.join(root, "global prefix with spaces");
const env = { ...process.env, NODE_NO_WARNINGS: "1" };
for (const key of Object.keys(env)) {
  if (/^(?:TELEGRAM_|ANTHROPIC_|OPENAI_|AWS_|AZURE_|GOOGLE_|CLAUDE_|CODEX_|LOCAL_CODE_LINK_)/.test(key)
    || /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/.test(key)) delete env[key];
}
Object.assign(env, {
  LOCAL_CODE_LINK_HOME: path.join(root, "private-state"),
  LOCAL_CODE_LINK_ENV_FILE: path.join(root, "not-configured.env"),
  LOCAL_CODE_LINK_NODE_BIN: process.execPath,
  npm_config_cache: path.join(root, "npm-cache"),
});
console.log("Installing the real GitHub source archive into an isolated global prefix.");
await execute("npm", ["install", "--global", "--prefix", prefix, source, "--no-audit", "--no-fund"],
  { env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
for (const name of ["local-code-link", "localcodelink"]) {
  const { stdout } = await execute(path.join(prefix, "bin", name), ["help"],
    { env, cwd: root, timeout: 15_000 });
  assert.match(stdout, /guided setup and project launch/);
}
const installed = path.join(prefix, "lib", "node_modules", "local-code-link");
assert.ok((await readFile(path.join(installed, "src/onboarding.mjs"), "utf8")).includes("prepareQuickStart"));
await execute(process.execPath, ["--input-type=module", "-e",
  'import {spawn} from "node-pty";const t=spawn("/bin/sh",["-c","printf SOURCE_PTY_READY"],{cols:80,rows:24});let out="";t.onData(x=>out+=x);t.onExit(e=>{if(e.exitCode!==0||!out.includes("SOURCE_PTY_READY"))process.exitCode=1;});'],
{ env, cwd: installed, timeout: 15_000 });
await assert.rejects(stat(env.LOCAL_CODE_LINK_ENV_FILE), { code: "ENOENT" });
console.log("PASS: public source-archive global installation, both launchers and native PTY; no bot or real user configuration changed.");
console.log(`Isolated installation retained: ${root}`);

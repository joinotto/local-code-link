// A real tarball install; no personal home, bot, hooks, or provider account is changed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const source = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "lcl-package-"));
const install = path.join(root, "clean install with spaces");
const env = { ...process.env, NODE_NO_WARNINGS: "1", LOCAL_CODE_LINK_HOME: path.join(root, "private-state"),
  LOCAL_CODE_LINK_ENV_FILE: path.join(root, "not-configured.env"), LOCAL_CODE_LINK_NODE_BIN: process.execPath };
delete env.LOCAL_CODE_LINK_DIR;
delete env.TELEGRAM_BOT_TOKEN;
delete env.TELEGRAM_CHAT_ID;
delete env.TELEGRAM_ALLOWED_USER_IDS;
const { stdout } = await execute("npm", ["pack", "--json", "--pack-destination", root], { cwd: source, env });
const pack = JSON.parse(stdout)[0];
assert.ok(!pack.files.some((f) => /(^|\/)(?:\.env$|config\.env$|state\.json$)|\.log$/.test(f.path)));
console.log(`Installing the actual release tarball in ${install}.`);
await execute("npm", ["install", "--prefix", install, path.join(root, pack.filename),
  "--no-audit", "--no-fund"], { env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
const installed = path.join(install, "node_modules", "local-code-link");
for (const name of ["local-code-link", "localcodelink"]) {
  const { stdout: help } = await execute(path.join(install, "node_modules", ".bin", name), ["help"],
    { env, cwd: root, timeout: 15_000 });
  assert.match(help, /LocalCodeLink/);
  assert.match(help, /--link-only/);
}
await execute(process.execPath, ["--input-type=module", "-e",
  'import {spawn} from "node-pty";const t=spawn("/bin/sh",["-c","printf PTY_READY"],{cols:80,rows:24});let out="";t.onData(x=>out+=x);t.onExit(e=>{if(e.exitCode!==0||!out.includes("PTY_READY"))process.exitCode=1;});'],
{ env, cwd: installed, timeout: 15_000 });
assert.ok((await readFile(path.join(installed, "integrations/codex/local-code-link/SKILL.md"), "utf8")).includes("--link-only"));
assert.ok((await readFile(path.join(installed, "integrations/claude/local-code-link.md"), "utf8")).includes("--link-only"));
assert.match(await readFile(path.join(installed, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
assert.match(await readFile(path.join(installed, "NOTICE"), "utf8"), /Anurag Patel \(geekfarmer\)/);
for (const name of ["assets/header.svg", "RELEASING.md", "ROADMAP.md", "RELEASE_CHECKLIST.md"]) {
  assert.ok((await stat(path.join(installed, "docs", name))).isFile());
}
assert.ok((await stat(path.join(env.LOCAL_CODE_LINK_HOME, "state.json"))).isFile());
await assert.rejects(stat(env.LOCAL_CODE_LINK_ENV_FILE), { code: "ENOENT" });
console.log("PASS: real clean tarball install, both aliases, spaced paths, native PTY, both integrations, license, notices, and docs.");
console.log(`Isolated install retained for inspection: ${root}`);

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkClaudeProvider, codingEnvironment, exportedClaudeProvider, providerValues, resolveProviderEnvironment } from "../src/provider-environment.mjs";
import { acquireProcessLease } from "../src/process-lease.mjs";
import { StateStore } from "../src/state.mjs";

test("provider environment allowlist excludes messaging credentials and code injection settings", () => {
  assert.deepEqual(providerValues({ AWS_REGION: "test", AWS_SECRET_ACCESS_KEY: "private",
    TELEGRAM_BOT_TOKEN: "other-private", NODE_OPTIONS: "--require evil", SHELL: "evil" }),
  { AWS_REGION: "test", AWS_SECRET_ACCESS_KEY: "private" });
});
test("coding child processes do not receive the Telegram bot's control-plane token", () => {
  const original = { TELEGRAM_BOT_TOKEN: "private", AWS_PROFILE: "native", PATH: "/bin" };
  assert.deepEqual(codingEnvironment(original), { AWS_PROFILE: "native", PATH: "/bin" });
  assert.equal(original.TELEGRAM_BOT_TOKEN, "private");
});

test("background provider environment is refreshed from the user shell without persisting secrets", async () => {
  let invocation;
  const env = await resolveProviderEnvironment({
    env: { HOME: "/tmp/home with spaces", SHELL: "/bin/zsh", PATH: "/bin", TELEGRAM_BOT_TOKEN: "keep" },
    execute: async (shell, args, options) => {
      invocation = { shell, args, options };
      const nonce = /LCL_ENV_[0-9a-f-]{36}=/.exec(args[1])[0];
      return `shell startup noise\n${nonce}${JSON.stringify({ CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "region", AWS_SECRET_ACCESS_KEY: "credential", TELEGRAM_BOT_TOKEN: "replace", NODE_OPTIONS: "evil" })}\n`;
    },
  });
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "credential");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "keep");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(invocation.shell, "/bin/zsh");
  assert.equal(invocation.options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.ok(!JSON.stringify(invocation.args).includes("credential"));
  assert.equal(invocation.options.timeout, 15000);
});

test("shell failures and malformed provider exports never expose credentials", async () => {
  await assert.rejects(resolveProviderEnvironment({ execute: async () => {
    throw new Error("AWS_SECRET_ACCESS_KEY=private-value");
  } }), (error) => !error.message.includes("private-value") && !error.cause);
  await assert.rejects(resolveProviderEnvironment({ execute: async () => "private-value" }),
    /No background coding session was started/);
});

test("only one service owns the process lease and an exited owner is recoverable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-lease-"));
  const file = path.join(root, "service.lock");
  const release = await acquireProcessLease(file);
  await assert.rejects(acquireProcessLease(file), /already running/);
  await release();
  await writeFile(file, "2147483647:dead");
  const releaseNext = await acquireProcessLease(file);
  assert.match(await readFile(file, "utf8"), new RegExp(`^${process.pid}:`));
  await releaseNext();
});
test("concurrent recovery of a dead service owner has exactly one winner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-lease-race-"));
  const file = path.join(root, "service.lock");
  await writeFile(file, "2147483647:dead");
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => acquireProcessLease(file)));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  await winners[0].value();
});
test("broad state directories are rejected instead of becoming destructive reset targets", () => {
  assert.throws(() => new StateStore("/"), /dedicated state directory/);
  assert.throws(() => new StateStore(os.homedir()), /dedicated state directory/);
});
test("background Claude cannot silently switch an explicitly linked cloud provider", () => {
  assert.equal(exportedClaudeProvider({ CLAUDE_CODE_USE_BEDROCK: "1" }), "bedrock");
  assert.throws(() => checkClaudeProvider("bedrock", {}), /no session was started/);
  assert.doesNotThrow(() => checkClaudeProvider("bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }));
  assert.throws(() => exportedClaudeProvider({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }), /Multiple/);
});

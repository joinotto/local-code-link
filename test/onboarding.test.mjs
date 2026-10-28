import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTelegramReady, prepareQuickStart, projectDirectory, providerChoice, telegramReady } from "../src/onboarding.mjs";

function fixture(configured = true) {
  return {
    store: { state: { projects: {}, telegram: configured ? { botId: 1, chatId: "-1001", controlTopicId: 2 } : {} } },
    env: configured ? { TELEGRAM_BOT_TOKEN: "fixture-only", TELEGRAM_ALLOWED_USER_IDS: "123" } : {},
    log() {},
  };
}

test("configured projects reuse setup without prompts, even in noninteractive commands", async () => {
  const f = fixture();
  assert.equal(telegramReady(f.store, f.env), true);
  assert.equal(await ensureTelegramReady({ ...f, interactive: false, setup() { assert.fail("must not run"); } }), false);
});

test("first-time interactive setup runs once and later calls reuse it", async () => {
  const f = fixture(false);
  let calls = 0;
  const setup = async () => {
    calls++;
    Object.assign(f.env, fixture().env);
    Object.assign(f.store.state.telegram, fixture().store.state.telegram);
  };
  assert.equal(await ensureTelegramReady({ ...f, interactive: true, setup }), true);
  assert.equal(await ensureTelegramReady({ ...f, interactive: true, setup }), false);
  assert.equal(calls, 1);
});

test("noninteractive missing configuration fails before reading tokens or calling Telegram", async () => {
  const f = fixture(false);
  await assert.rejects(ensureTelegramReady({ ...f, interactive: false, setup() { assert.fail("must not run"); } }), /interactive terminal/);
});

test("incomplete or failed setup cannot continue to link or launch a session", async () => {
  const f = fixture(false);
  await assert.rejects(ensureTelegramReady({ ...f, interactive: true, setup: async () => {} }), /incomplete/);
  await assert.rejects(ensureTelegramReady({ ...f, interactive: true, setup: async () => { throw new Error("pairing denied"); } }), /pairing denied/);
});

test("quick start prefers this folder's linked provider, not another project's provider", async () => {
  const f = fixture();
  f.store.state.projects = {
    other: { cwd: "/another-project", provider: "claude" },
    current: { cwd: "/chosen-project", provider: "codex" },
  };
  const questions = [];
  const plan = await prepareQuickStart({
    ...f, interactive: true, cwd: "/initial-folder",
    discover: async () => ["claude", "codex"],
    directory: async (value, cwd) => {
      assert.equal(value, "/chosen-project");
      assert.equal(cwd, "/initial-folder");
      return value;
    },
    ask: async (question, fallback) => {
      questions.push({ question, fallback });
      return question === "Project folder" ? "/chosen-project" : fallback;
    },
    setup() { assert.fail("already configured"); },
  });
  assert.deepEqual(plan, { cwd: "/chosen-project", provider: "codex" });
  assert.equal(questions[1].fallback, "2");
});

test("one installed provider is chosen without an unnecessary provider menu", async () => {
  const f = fixture();
  let questions = 0;
  const plan = await prepareQuickStart({
    ...f, interactive: true, cwd: "/project", discover: async () => ["claude"],
    ask: async (question, fallback) => { questions++; assert.equal(question, "Project folder"); return fallback; },
    directory: async (value) => value, setup() { assert.fail("must not run"); },
  });
  assert.equal(questions, 1);
  assert.equal(plan.provider, "claude");
});

test("no installed coding provider fails without asking for a token or changing configuration", async () => {
  const f = fixture(false);
  await assert.rejects(prepareQuickStart({
    ...f, interactive: true, discover: async () => [],
    ask() { assert.fail("must not prompt"); }, setup() { assert.fail("must not run"); },
  }), /No coding CLI found/);
  assert.deepEqual(f.env, {});
});

test("quick start refuses noninteractive use before discovery and invalid choices before setup", async () => {
  const f = fixture(false);
  await assert.rejects(prepareQuickStart({
    ...f, interactive: false, discover() { assert.fail("must not run"); },
  }), /interactive terminal/);
  await assert.rejects(prepareQuickStart({
    ...f, interactive: true, discover: async () => ["claude", "codex"], directory: async () => "/project",
    ask: async (question) => question === "Project folder" ? "/project" : "arbitrary-shell-command",
    setup() { assert.fail("must not run"); },
  }), /installed coding providers/);
});

test("project folders resolve spaces, home shortcuts and symlinks but never shell expressions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-onboarding-"));
  await mkdir(path.join(root, "project with spaces"));
  await symlink(path.join(root, "project with spaces"), path.join(root, "linked folder"));
  const expected = await realpath(path.join(root, "project with spaces"));
  assert.equal(await projectDirectory("project with spaces", root), expected);
  assert.equal(await projectDirectory("~/project with spaces", "/", root), expected);
  assert.equal(await projectDirectory("linked folder", root), expected);
  await writeFile(path.join(root, "not-a-directory"), "fixture");
  await assert.rejects(projectDirectory("not-a-directory", root), /existing folder/);
  const marker = path.join(root, "must-not-exist");
  await assert.rejects(projectDirectory(`$(touch ${marker})`, root), /existing folder/);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("provider choices accept shown names or positions, never uninstalled providers", () => {
  assert.equal(providerChoice("2", ["claude", "codex"]), "codex");
  assert.equal(providerChoice("CODEX", ["claude", "codex"]), "codex");
  assert.throws(() => providerChoice("codex", ["claude"]), /installed coding providers/);
  assert.throws(() => providerChoice("0", ["claude", "codex"]), /installed coding providers/);
});

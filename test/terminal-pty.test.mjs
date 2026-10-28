import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareTerminalPty } from "../src/terminal-pty.mjs";
test("terminal preparation fixes only exact bundled macOS helpers for global-install users", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-pty-prepare-"));
  const dir = path.join(root, "prebuilds", "darwin-arm64");
  await mkdir(dir, { recursive: true });
  const helper = path.join(dir, "spawn-helper");
  const other = path.join(dir, "unrelated");
  await writeFile(helper, "fixture", { mode: 0o600 });
  await writeFile(other, "fixture", { mode: 0o600 });
  await prepareTerminalPty({ platform: "darwin", arch: "arm64", packageRoot: root });
  assert.equal((await stat(helper)).mode & 0o111, 0o111);
  assert.equal((await stat(other)).mode & 0o111, 0);
});
test("terminal preparation rejects helper symlinks instead of changing unrelated permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-pty-symlink-"));
  const dir = path.join(root, "prebuilds", "darwin-arm64");
  await mkdir(dir, { recursive: true });
  const other = path.join(root, "other");
  await writeFile(other, "fixture", { mode: 0o600 });
  await symlink(other, path.join(dir, "spawn-helper"));
  await assert.rejects(prepareTerminalPty({ platform: "darwin", arch: "arm64", packageRoot: root }), /regular bundled/);
  assert.equal((await stat(other)).mode & 0o111, 0);
});

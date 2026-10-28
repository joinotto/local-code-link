import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectRelease } from "../scripts/release-inspection.mjs";
test("release inspection rejects missing license, private files, local paths, and credential-shaped text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-release-check-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/fixture.mjs"),
    'const token="123456789:' + "x".repeat(35) + '";const personal="/Users/' + 'apple/private";');
  const result = await inspectRelease(root, {}, ["src/fixture.mjs", ".env", "config.env"]);
  assert.equal(result.passed, false);
  for (const fragment of ["license", "LICENSE", "Private/local", "Machine-specific", "Possible Telegram"]) {
    assert.ok(result.failures.some((value) => value.includes(fragment)));
  }
  assert.ok(!JSON.stringify(result).includes("x".repeat(35)));
});

test("release inspection requires distributed notices, matching license, and no private scaffold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-release-notices-"));
  const files = [
    "LICENSE", "NOTICE", "npm-shrinkwrap.json",
    "integrations/codex/local-code-link/SKILL.md",
    "integrations/claude/local-code-link.md",
  ];
  for (const name of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), name === "LICENSE"
      ? "Apache License\nVersion 2.0\n" : name === "npm-shrinkwrap.json" ? "{}" : "Fixture");
  }
  assert.equal((await inspectRelease(root, { license: "Apache-2.0" }, files)).passed, true);
  assert.equal((await inspectRelease(root, { license: "MIT" }, files)).passed, false);
  const missing = await inspectRelease(root, { license: "Apache-2.0" }, files.filter((name) => name !== "NOTICE"));
  assert.ok(missing.failures.includes("NOTICE is missing from the archive."));
  const privateFile = ".opensource/scaffold-config.json";
  const privateResult = await inspectRelease(root, { license: "Apache-2.0" }, [...files, privateFile]);
  assert.ok(privateResult.failures.includes(`Private/local file included: ${privateFile}`));
});

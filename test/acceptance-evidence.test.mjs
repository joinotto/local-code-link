import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAcceptanceEvidence } from "../scripts/acceptance-evidence.mjs";

test("acceptance results persist privately and atomically without leaving temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lcl-evidence-"));
  const file = path.join(root, "idle.json");
  await writeAcceptanceEvidence(file, { phase: "idle", status: "ready" });
  await writeAcceptanceEvidence(file, { phase: "idle", status: "failed" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1, phase: "idle", status: "failed" });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["idle.json"]);
});

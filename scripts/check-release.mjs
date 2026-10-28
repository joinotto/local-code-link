import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectRelease } from "./release-inspection.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const { stdout } = await execute("npm", ["pack", "--dry-run", "--json"], { cwd: root });
const pack = JSON.parse(stdout)[0];
const result = await inspectRelease(root, manifest, pack.files);
for (const failure of result.failures) console.error(`✗ ${failure}`);
console.log(result.passed ? `PASS: distributable package inspection (${result.files} files).`
  : "Release blocked: resolve the above package gates; live/hosted acceptance is separate.");
process.exitCode = result.passed ? 0 : 1;

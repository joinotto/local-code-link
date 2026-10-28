// One physical sleep verifies three isolated real native session states.
// Only signal readiness after every child verifier is actually ready.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAcceptanceEvidence } from "./acceptance-evidence.mjs";

const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "lcl-sleep-acceptance-"));
const summaryFile = path.join(evidenceDirectory, "summary.json");
const summary = { provider: "codex", status: "preparing", startedAt: new Date().toISOString(), phases: {} };
await writeAcceptanceEvidence(summaryFile, summary);
console.log(`Durable acceptance evidence: ${evidenceDirectory}`);
const children = [];
const ready = new Set();
const passed = new Set();
let failed = false;
function stop() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  failed = true;
  stop();
});
// Start active last, maximizing its remaining bounded command time.
for (const phase of ["idle", "approval", "active"]) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./verify-sleep-live.mjs", import.meta.url)),
    "--phase", phase], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LCL_SLEEP_EVIDENCE_DIR: evidenceDirectory } });
  children.push(child);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("READY FOR REAL SLEEP:")) {
      ready.add(phase);
      console.log(`Prepared: ${phase}.`);
      if (ready.size === 3 && !failed) {
        console.log("READY FOR REAL SLEEP: all three states. Sleep the Mac NOW for about 30 seconds, then wake and unlock it.");
      }
    } else {
      console.log(`[${phase}] ${line}`);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => console.error(`[${phase}] ${line}`));
  child.on("error", (error) => {
    failed = true;
    console.error(`Could not start ${phase}: ${error.message}`);
    stop();
  });
  child.on("close", (code) => {
    void (async () => {
      let evidence;
      try { evidence = JSON.parse(await readFile(path.join(evidenceDirectory, `${phase}.json`), "utf8")); }
      catch { evidence = { phase, status: "missing" }; }
      summary.phases[phase] = evidence;
      if (code === 0 && evidence.status === "passed" && evidence.provider === "codex" && evidence.phase === phase) passed.add(phase);
      else { failed = true; stop(); }
      if (Object.keys(summary.phases).length === 3) {
        const records = Object.values(summary.phases);
        const sameSleep = records.every((record) =>
          record.sleepAt === records[0].sleepAt && record.wakeAt === records[0].wakeAt);
        if (!sameSleep) failed = true;
        summary.status = !failed && passed.size === 3 ? "passed" : "failed";
        summary.finishedAt = new Date().toISOString();
        await writeAcceptanceEvidence(summaryFile, summary);
        if (summary.status === "passed") console.log("PASS: all three native Codex states recovered after the same real hardware sleep/wake.");
        console.log(`Final acceptance report: ${summaryFile}`);
        process.exitCode = failed ? 1 : 0;
      }
    })().catch((error) => { failed = true; stop(); console.error(`Acceptance report failed: ${error.message}`); process.exitCode = 1; });
  });
}

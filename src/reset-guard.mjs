import { readFile } from "node:fs/promises";
import path from "node:path";

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // An inaccessible process is not evidence that it has stopped.
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function assertResetNotRunning(root) {
  let owner;
  try { owner = await readFile(path.join(root, "reset.lock"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const pid = Number(owner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) {
    throw new Error("LocalCodeLink reset is in progress. Wait for it to finish before starting another command.");
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";

const locked = () => Object.assign(new Error("LocalCodeLink is already running. Stop the foreground serve process or background service before starting another."), { code: "LCL_LOCKED" });

export async function acquireProcessLease(file) {
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, owner, { flag: "wx", mode: 0o600 });
      return async () => {
        try { if (await readFile(file, "utf8") === owner) await unlink(file); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = await readFile(file, "utf8"); }
      catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
      const pid = Number(previous.split(":")[0]);
      if (!previous) throw locked(); // another owner may still be writing
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid service lock. Inspect it before restarting.");
      try { process.kill(pid, 0); }
      catch (ownerError) {
        if (ownerError.code === "ESRCH") {
          const recovery = `${file}.recovery`;
          try { await mkdir(recovery, { mode: 0o700 }); }
          catch (recoveryError) { if (recoveryError.code === "EEXIST") throw locked(); throw recoveryError; }
          try {
            // All stale-owner recovery passes through this exclusive guard.
            // Recheck after acquiring it; never remove a successor's lease.
            try {
              if (await readFile(file, "utf8") !== previous) throw locked();
              await unlink(file);
            } catch (readError) { if (readError.code !== "ENOENT") throw readError; }
            try { await writeFile(file, owner, { flag: "wx", mode: 0o600 }); }
            catch (writeError) { if (writeError.code === "EEXIST") throw locked(); throw writeError; }
            return async () => {
              try { if (await readFile(file, "utf8") === owner) await unlink(file); }
              catch (readError) { if (readError.code !== "ENOENT") throw readError; }
            };
          } finally { await rmdir(recovery); }
        }
      }
      throw locked();
    }
  }
  throw new Error("Another LocalCodeLink service is starting. Please retry.");
}

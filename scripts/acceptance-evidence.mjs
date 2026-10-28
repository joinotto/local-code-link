import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Reports contain assertion outcomes/timestamps, never prompts, outputs or auth.
export async function writeAcceptanceEvidence(file, record) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...record }, null, 2) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

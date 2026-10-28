import { chmod, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

export async function prepareTerminalPty(options = {}) {
  if ((options.platform || process.platform) !== "darwin") return;
  const root = options.packageRoot || path.dirname(require.resolve("node-pty/package.json"));
  const arch = options.arch || process.arch;
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported macOS terminal architecture.");
  for (const relative of [path.join("prebuilds", `darwin-${arch}`, "spawn-helper"),
    path.join("build", "Release", "spawn-helper")]) {
    const helper = path.join(root, relative);
    try {
      const info = await lstat(helper);
      if (!info.isFile()) throw new Error("Native terminal helper must be a regular bundled file.");
      // The helper is intentionally executable by package users, including
      // non-root users of a global installation. Never chmod a broader tree.
      if ((info.mode & 0o111) !== 0o111) await chmod(helper, (info.mode & 0o777) | 0o111);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function loadTerminalPty() {
  await prepareTerminalPty();
  return import("node-pty");
}

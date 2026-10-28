import { readFile } from "node:fs/promises";
import path from "node:path";

export async function inspectRelease(root, manifest, files) {
  const failures = [];
  if (!["Apache-2.0", "MIT"].includes(manifest.license)) failures.push("Select and declare a supported open-source license.");
  let licenseText = "";
  try {
    licenseText = await readFile(path.join(root, "LICENSE"), "utf8");
    if (!licenseText.trim()) failures.push("LICENSE is empty.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    failures.push("LICENSE is missing.");
  }
  const paths = files.map((file) => typeof file === "string" ? file : file.path);
  for (const name of ["LICENSE", "NOTICE"]) {
    if (!paths.includes(name)) failures.push(`${name} is missing from the archive.`);
  }
  if (licenseText && manifest.license === "Apache-2.0"
    && !/Apache License\s+Version 2\.0/.test(licenseText)) failures.push("LICENSE does not match Apache-2.0 metadata.");
  if (licenseText && manifest.license === "MIT"
    && !/Permission is hereby granted, free of charge/.test(licenseText)) failures.push("LICENSE does not match MIT metadata.");
  if (paths.includes("NOTICE") && !(await readFile(path.join(root, "NOTICE"), "utf8")).trim()) failures.push("NOTICE is empty.");
  if (!paths.includes("npm-shrinkwrap.json")) failures.push("The distributable dependency lock is missing.");
  if (!paths.includes("integrations/codex/local-code-link/SKILL.md")
    || !paths.includes("integrations/claude/local-code-link.md")) failures.push("Bundled provider linking commands are missing.");
  for (const name of paths) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Unsafe package file path.");
    if (/node_modules\/|(^|\/)(?:\.env(?:$|\.)|config\.env$|state\.json$|\.local-code-link\/|\.grok-hub\/|\.opensource\/|\.aws\/|\.codex\/|\.npmrc$)|\.log$/.test(name)
      && name !== ".env.example") {
      failures.push(`Private/local file included: ${name}`);
      continue;
    }
    if (!/\.(mjs|js|md|json|sh)$/.test(name) && !name.startsWith("bin/")) continue;
    const text = await readFile(path.join(root, name), "utf8");
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) failures.push(`Machine-specific path included: ${name}`);
    if (/\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b/.test(text)) failures.push(`Possible Telegram credential included: ${name}`);
  }
  return { passed: failures.length === 0, failures, files: paths.length };
}

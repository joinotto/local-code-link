import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireProcessLease } from "./process-lease.mjs";
import { processAlive } from "./reset-guard.mjs";

const inspect = async (file) => {
  try { return await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const execute = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) =>
    resolve({ code: error?.code || 0, stdout: stdout || "", stderr: stderr || "" }));
});
const xmlValue = (text, key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
  .exec(text)?.[1].replaceAll("&quot;", '"').replaceAll("&apos;", "'")
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

async function assertIdle(root, alive) {
  let state;
  try { state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Cannot safely check existing history for active work. Preserve it and inspect the state before resetting.");
  }
  if (!state.projects || typeof state.projects !== "object" || !Array.isArray(state.approvals)) {
    throw new Error("Cannot safely check existing history for active work. Inspect the state before resetting.");
  }
  if (state.approvals.some((item) => ["pending", "responding"].includes(item.status))
    || Object.values(state.projects).some((project) =>
      project.backgroundTask || project.telegramRequests?.length || project.claudeOutbox?.length
      || [project.localSession?.pid, project.localSession?.approvalProxyPid,
        project.localSession?.claudeBridgePid, project.approvalProxyPid, project.claudeBridgePid].some(alive))) {
    throw new Error("Finish pending approvals, queued deliveries and coding work, then close managed sessions before resetting.");
  }
}

async function socketFiles(root) {
  const files = [];
  for (const folder of ["tui", "claude"]) {
    const directory = path.join(root, folder);
    const info = await inspect(directory);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unexpected relay directory; reset refused.");
    for (const entry of await readdir(directory)) {
      if (!/^[a-f0-9]{20}\.sock$/.test(entry)) continue;
      const file = path.join(directory, entry);
      if ((await lstat(file)).isSocket()) files.push(file);
    }
  }
  return files;
}

async function assertSocketStopped(file) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    const finish = (error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(500, () => finish(new Error("Cannot verify a managed relay has stopped. Close managed sessions before resetting.")));
    socket.once("connect", () => finish(new Error("A managed coding relay is still running. Close its session before resetting.")));
    socket.once("error", (error) => finish(["ENOENT", "ECONNREFUSED"].includes(error.code)
      ? null : new Error("Cannot verify a managed relay has stopped. Reset refused.")));
  });
}

async function hookChanges(home, projectRoot) {
  const roots = [...new Set([projectRoot, path.join(home, ".local/lib/node_modules/local-code-link"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/local-code-link")])];
  const changes = [];
  for (const [provider, script] of [["codex", "codex-permission-hook.mjs"], ["claude", "claude-session-hook.mjs"]]) {
    const file = path.join(home, `.${provider}`, provider === "codex" ? "hooks.json" : "settings.json");
    const info = await inspect(file);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unexpected provider hook file; reset refused.");
    const original = await readFile(file, "utf8");
    let config;
    try { config = JSON.parse(original); } catch { throw new Error("Provider hook configuration is invalid. Inspect it before resetting."); }
    let removed = 0;
    for (const [event, groups] of Object.entries(config.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      config.hooks[event] = groups.flatMap((group) => {
        if (!Array.isArray(group.hooks)) return [group];
        const remaining = group.hooks.filter((hook) => {
          const owned = typeof hook.command === "string" && roots.some((root) => {
            const scriptPath = path.join(root, "src", script);
            const index = hook.command.indexOf(scriptPath);
            return index >= 0
              && (index === 0 || /[\s'"]/.test(hook.command[index - 1]))
              && (index + scriptPath.length === hook.command.length
                || /[\s'"]/.test(hook.command[index + scriptPath.length]));
          });
          if (!owned) return true;
          removed++;
          return false;
        });
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
      });
    }
    if (removed) changes.push({ file, original, config, removed, provider });
  }
  return changes;
}

// Only known bridge files are archived. Never rename/delete an entire custom
// state directory: unrelated files may be stored alongside state.json.
export async function resetLocalSetup({
  root, configFile, newConfigFile = configFile, projectRoot,
  home = os.homedir(), platform = process.platform, run = execute, alive = processAlive,
}) {
  root = path.resolve(root);
  home = path.resolve(home);
  if ([path.parse(root).root, home].includes(root)) throw new Error("Reset requires a dedicated LocalCodeLink state directory.");
  const rootInfo = await inspect(root);
  if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) throw new Error("Unexpected state directory; reset refused.");
  await assertIdle(root, alive);
  for (const file of await socketFiles(root)) await assertSocketStopped(file);
  const hooks = await hookChanges(home, projectRoot);
  const targets = [...new Set([
    path.join(root, "state.json"), path.join(root, "config.env"),
    configFile, newConfigFile, path.join(projectRoot, ".env"),
    path.join(root, "telegram.log"), path.join(root, "telegram-error.log"),
  ].filter(Boolean).map((file) => path.resolve(file)))];
  if (rootInfo) {
    for (const name of await readdir(root)) {
      if (/^(?:state\.json|config\.env)\.\d+\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        targets.push(path.join(root, name));
      }
    }
  }
  for (const file of targets) {
    const info = await inspect(file);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unexpected configuration/history target; reset refused.");
  }

  const serviceTarget = `gui/${process.getuid?.()}/com.local-code-link.telegram`;
  const plist = path.join(home, "Library/LaunchAgents/com.local-code-link.telegram.plist");
  let matchingService = false;
  let loaded = false;
  let servicePid;
  if (platform === "darwin" && await inspect(plist)) {
    if (!(await lstat(plist)).isFile()) throw new Error("Unexpected service file; reset refused.");
    const text = await readFile(plist, "utf8");
    matchingService = xmlValue(text, "Label") === "com.local-code-link.telegram"
      && xmlValue(text, "LOCAL_CODE_LINK_HOME") === root;
    if (matchingService) {
      const status = await run("launchctl", ["print", serviceTarget]);
      loaded = status.code === 0;
      servicePid = Number(/^\s*pid = (\d+)/m.exec(status.stdout)?.[1]);
    } else if ([configFile, newConfigFile].includes(xmlValue(text, "LOCAL_CODE_LINK_ENV_FILE"))) {
      throw new Error("Another LocalCodeLink service uses this configuration. Stop it and resolve the shared paths before resetting.");
    }
  }
  const leaseFile = path.join(root, "telegram-service.lock");
  if (await inspect(leaseFile)) {
    const owner = Number((await readFile(leaseFile, "utf8")).split(":")[0]);
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("Invalid service lease. Inspect it before resetting.");
    if (alive(owner) && (!loaded || owner !== servicePid)) {
      throw new Error("Stop this setup's foreground local-code-link serve process before resetting.");
    }
  }

  let stopped = false;
  let backup;
  const releases = [];
  try {
    if (loaded) {
      if ((await run("launchctl", ["bootout", serviceTarget])).code !== 0) {
        throw new Error("Could not stop the LocalCodeLink background service. Nothing was cleared.");
      }
      stopped = true;
      const deadline = Date.now() + 5000;
      while (alive(servicePid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (alive(servicePid)) throw new Error("LocalCodeLink service has not exited yet. Wait and retry.");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    releases.push(await acquireProcessLease(path.join(root, "reset.lock")));
    releases.push(await acquireProcessLease(leaseFile));
    releases.push(await acquireProcessLease(path.join(root, "state.json.lock")));
    await assertIdle(root, alive);
    const sockets = await socketFiles(root);
    for (const file of sockets) await assertSocketStopped(file);
    for (const change of hooks) {
      if (await readFile(change.file, "utf8") !== change.original) throw new Error("Provider hooks changed during reset. Retry after other commands finish.");
    }
    backup = await mkdtemp(path.join(home, ".local-code-link-reset-backup-"));
    await chmod(backup, 0o700);
    const manifest = { at: new Date().toISOString(), root, serviceStopped: stopped, archived: [], hooksRemoved: 0 };
    const saveManifest = () => writeFile(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await saveManifest();
    for (const file of [...targets, ...sockets, ...(matchingService ? [plist] : [])]) {
      if (!await inspect(file)) continue;
      const destination = path.join(backup, `${manifest.archived.length}-${path.basename(file)}`);
      await rename(file, destination);
      manifest.archived.push({ source: file, destination });
      await saveManifest();
    }
    for (const change of hooks) {
      await writeFile(path.join(backup, `${change.provider}-hooks.json`), change.original, { flag: "wx", mode: 0o600 });
      if (await readFile(change.file, "utf8") !== change.original) throw new Error("Provider hooks changed during reset. Their backup is retained.");
      const temporary = `${change.file}.reset-${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(change.config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, change.file);
      manifest.hooksRemoved += change.removed;
      await saveManifest();
    }
    return { backup, archived: manifest.archived.length, hooksRemoved: manifest.hooksRemoved, serviceStopped: stopped };
  } catch (error) {
    const recovery = backup ? ` Recoverable backup: ${backup}.` : "";
    const service = stopped ? " The old LocalCodeLink service is stopped." : "";
    throw new Error(`${error.message}${recovery}${service}`);
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

export async function resetWithConfirmation({ interactive, ask, reset, setup, log = console.log }) {
  if (!interactive) throw new Error("Reset requires an interactive terminal and Yes/No confirmation. Run local-code-link reset in iTerm.");
  log("Reset clears local project mappings, approvals/history, logs and Telegram configuration.");
  log("A private recovery backup is kept. Project files, native Claude/Codex history and Telegram messages are preserved.");
  log("After reset, fresh Telegram setup starts. Enter its token only at the hidden prompt.");
  let answer;
  do {
    answer = (await ask("Reset LocalCodeLink? Yes or No", "No")).trim().toLowerCase();
    if (!["yes", "no", ""].includes(answer)) log("Please answer Yes or No.");
  } while (!["yes", "no", ""].includes(answer));
  if (answer !== "yes") { log("Cancelled. Nothing was changed."); return { cancelled: true }; }
  const result = await reset();
  log(`✓ LocalCodeLink history and configuration reset. Recovery backup: ${result.backup}`);
  log("Starting fresh Telegram setup…");
  await setup();
  return { cancelled: false, ...result };
}

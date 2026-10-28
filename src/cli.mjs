#!/usr/bin/env node
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { StateStore, now, publicProject, slug } from "./state.mjs";
import { TelegramClient, validateTelegramGroup, waitForTelegramConnect } from "./telegram.mjs";
import { TelegramService } from "./telegram-service.mjs";
import { CodingRuntime } from "./runtime.mjs";
import { randomUUID } from "node:crypto";
import { CodexTuiProxy } from "./codex-tui-proxy.mjs";
import { assertCurrentProject, codexInteractiveArgs, selectCodexSession } from "./session-scope.mjs";
import { selectClaudeSession } from "./claude-session.mjs";
import { claudeInteractiveArgs, runClaudeTerminal } from "./claude-terminal.mjs";
import { claudeRequest } from "./claude-ipc.mjs";
import { codingEnvironment, exportedClaudeProvider, resolveProviderEnvironment } from "./provider-environment.mjs";
import { acquireProcessLease } from "./process-lease.mjs";
import { readSecret } from "./secret-input.mjs";
import { loadConfiguration, saveConfiguration } from "./config.mjs";
import { fileURLToPath } from "node:url";
import { buildLaunchAgent } from "./launch-agent.mjs";

function usage() {
  console.log(`LocalCodeLink

  local-code-link setup telegram
  local-code-link claude [project-name] [--link-only]
  local-code-link codex [project-name] [--link-only]
  local-code-link list
  local-code-link status [project]
  local-code-link doctor
  local-code-link unlink [project] [--confirm]
  local-code-link serve
  local-code-link service install|start|stop|status
  local-code-link reset --confirm

Telegram commands:
  /projects   list projects in the control topic
  /status     show this project's status
  /new        start a fresh provider session
  /interrupt  interrupt the active task
  /delivery   list held/uncertain Telegram deliveries
  /retry-delivery ID  resend a held message only (may duplicate delivery)
  /unlink     delete this project's topic/history (with confirmation)
`);
}

async function ask(question, fallback) {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim()
      || fallback || "";
  } finally {
    terminal.close();
  }
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const execute = (command, args, options = {}) => new Promise((resolve) => {
  execFile(command, args, options, (error, stdoutText, stderrText) => {
    resolve({ code: error?.code || 0, stdout: stdoutText || "", stderr: stderrText || "" });
  });
});

async function resolveExecutable(value) {
  if (path.isAbsolute(value)) return value;
  const result = await execute("/usr/bin/which", [value]);
  return result.code === 0 ? result.stdout.trim() : value;
}

async function installCodexHook(projectRoot) {
  const hooksFile = path.join(os.homedir(), ".codex", "hooks.json");
  let config = { hooks: {} };
  try {
    config = JSON.parse(await readFile(hooksFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  config.hooks ||= {};
  const script = path.join(projectRoot, "src", "codex-permission-hook.mjs");
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  let changed = false;
  const permissionGroups = config.hooks.PermissionRequest || [];
  const remainingPermissionGroups = permissionGroups.map((group) => ({
    ...group,
    hooks: group.hooks?.filter((hook) =>
      !hook.command?.includes("codex-permission-hook.mjs")),
  })).filter((group) => !Array.isArray(group.hooks) || group.hooks.length);
  if (JSON.stringify(permissionGroups) !== JSON.stringify(remainingPermissionGroups)) {
    config.hooks.PermissionRequest = remainingPermissionGroups;
    changed = true;
  }
  const ensureHook = (event, matcher, timeout, statusMessage) => {
    config.hooks[event] ||= [];
    const existingHooks = config.hooks[event].flatMap((group) => group.hooks || [])
      .filter((hook) => hook.command?.includes("codex-permission-hook.mjs"));
    if (existingHooks.length) {
      for (const hook of existingHooks) if (hook.command !== command) {
        hook.command = command;
        changed = true;
      }
      return;
    }
    config.hooks[event].push({
      matcher,
      hooks: [{
        type: "command",
        command,
        timeout,
        ...(statusMessage ? { statusMessage } : {}),
      }],
    });
    changed = true;
  };
  ensureHook("SessionStart", "startup|resume", 10);
  ensureHook("UserPromptSubmit", "*", 10);
  ensureHook("Stop", "*", 30);
  if (changed) {
    await writeFile(hooksFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  return { installed: changed, file: hooksFile };
}

async function installService(projectRoot, providerBins = {}) {
  if (process.platform !== "darwin") return { installed: false, reason: "Use local-code-link serve on this platform" };
  const label = "com.local-code-link.telegram";
  const target = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const plist = buildLaunchAgent({ projectRoot, stateRoot: storePath(),
    configFile: process.env.LOCAL_CODE_LINK_ENV_FILE, providerBins });
  const serviceTarget = `gui/${process.getuid()}/${label}`;
  const loaded = await execute("launchctl", ["print", serviceTarget]);
  if (loaded.code === 0) {
    const current = await new StateStore().init();
    if (current.state.approvals.some((a) => ["pending", "responding"].includes(a.status))
      || Object.values(current.state.projects).some((p) => p.backgroundTask || p.telegramRequests?.length)) {
      throw new Error("Finish pending approvals and Telegram/background work before reinstalling the service.");
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, plist, { mode: 0o600 });
  if (loaded.code === 0) {
    // kickstart restarts the old loaded definition; bootstrap must load the
    // updated configuration/location after an install or upgrade.
    const stopped = await execute("launchctl", ["bootout", serviceTarget]);
    if (stopped.code !== 0) {
      throw new Error(`Could not reload launch service: ${stopped.stderr.trim()}`);
    }
  }

  let started;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    started = await execute("launchctl", ["bootstrap", `gui/${process.getuid()}`, target]);
    if (started.code === 0) break;
  }
  if (started.code !== 0) throw new Error(`Could not start launch service: ${started.stderr.trim()}`);
  return { installed: true, restarted: loaded.code === 0, label, file: target };
}

function storePath() {
  return process.env.LOCAL_CODE_LINK_HOME || path.join(os.homedir(), ".local-code-link");
}

async function setupTelegram(store, envFile, projectRoot) {
  const configured = Boolean(process.env.TELEGRAM_BOT_TOKEN && store.state.telegram.botId);
  let reuseConfigured = false;
  let token = process.env.TELEGRAM_BOT_TOKEN;

  if (!configured) {
    console.log("Telegram bot setup");
    console.log("Create a bot with @BotFather using /newbot if you do not already have one.");
    console.log("Then paste its token below.");
    token ||= await readSecret("Bot token");
  } else {
    const botName = store.state.telegram.botUsername
      ? `@${store.state.telegram.botUsername}`
      : "the configured bot";
    console.log(`Telegram is already configured with ${botName}.`);
    console.log("  1. Reuse configured bot");
    console.log("  2. Replace bot token");
    const choice = await ask("Choose 1 or 2", "1");
    if (choice === "2") {
      token = await readSecret("New bot token");
    } else if (choice !== "1") {
      throw new Error("Choose 1 to reuse the configured bot or 2 to replace it");
    } else {
      reuseConfigured = true;
    }
  }

  if (!token) throw new Error("A Telegram bot token is required");
  const client = new TelegramClient(token);
  const bot = await client.getMe();
  console.log(`Connected as @${bot.username || bot.first_name}`);
  await client.setDefaultAdministratorRights();
  let pairing;
  const sameBot = bot.id === store.state.telegram.botId;
  if ((reuseConfigured || sameBot) && store.state.telegram.chatId && process.env.TELEGRAM_ALLOWED_USER_IDS) {
    const chat = await validateTelegramGroup(client, bot, store.state.telegram.chatId);
    pairing = {
      chatId: String(chat.id),
      chatTitle: chat.title || "Telegram group",
      userId: process.env.TELEGRAM_ALLOWED_USER_IDS,
      userName: "configured user",
      updateOffset: store.state.telegram.updateOffset || 0,
    };
  } else {
    const challenge = randomUUID().replaceAll("-", "");
    const addBotUrl = `https://t.me/${bot.username}?startgroup&admin=manage_chat+manage_topics+delete_messages`;
    console.log("");
    console.log("Finish in Telegram:");
    console.log("  1. Create or open a private group and enable Topics.");
    console.log(`  2. Add @${bot.username} as administrator: ${addBotUrl}`);
    console.log(`  3. Send /connect ${challenge} in that group from your owner/admin account.`);
    console.log("");
    console.log("Waiting for /connect…");
    pairing = await waitForTelegramConnect(client, bot, {
      challenge,
      onRejected: (message) => console.log(`! ${message}`),
    });
  }
  const chatId = pairing.chatId;
  const allowedUsers = pairing.userId;
  console.log(`Connected "${pairing.chatTitle}" for ${pairing.userName}.`);
  let controlTopicId = store.state.telegram.controlTopicId;
  if (!controlTopicId || String(store.state.telegram.chatId) !== String(chatId)) {
    controlTopicId = (await client.createForumTopic(chatId, "LocalCodeLink Control")).message_thread_id;
  }
  store.state.telegram = {
    chatId: String(chatId),
    controlTopicId: Number(controlTopicId),
    botId: bot.id,
    botUsername: bot.username || null,
    configuredAt: now(),
    updateOffset: pairing.updateOffset || 0,
  };
  await store.save();
  const providerBins = {
    codex: await resolveExecutable(process.env.CODEX_BIN || "codex"),
    claude: await resolveExecutable(process.env.CLAUDE_BIN || "claude"),
  };
  await saveConfiguration(envFile, {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_CHAT_ID: chatId,
    TELEGRAM_ALLOWED_USER_IDS: allowedUsers,
    LOCAL_CODE_LINK_HOME: store.root,
    CODEX_BIN: providerBins.codex,
    CLAUDE_BIN: providerBins.claude,
  });
  process.env.LOCAL_CODE_LINK_ENV_FILE = envFile;
  await client.sendMessage(chatId, "✅ LocalCodeLink is configured.", { topicId: controlTopicId });
  await installCodexHook(projectRoot);
  const service = await installService(projectRoot, providerBins);
  return { bot: bot.username || bot.first_name, chatId: String(chatId), controlTopicId, service };
}

async function linkProject(store, provider, requestedName) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !store.state.telegram.chatId) {
    throw new Error("Run local-code-link setup telegram first");
  }
  const cwd = await realpath(process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error("Current path is not a directory");
  const name = requestedName || path.basename(cwd);
  const id = slug(name);
  const existing = Object.values(store.state.projects).find((project) => project.cwd === cwd);
  if (existing) {
    if (existing.status === "unlinked") {
      throw new Error(`Project cleanup is incomplete. Retry local-code-link unlink ${existing.id} before linking again`);
    }
    if (existing.provider !== provider && (existing.localSession?.status === "active"
      || existing.status === "busy" || existing.telegramRequests?.length)) {
      throw new Error(`Close the active ${existing.provider} session and finish pending work before switching providers`);
    }
    existing.linkId ||= randomUUID();
    existing.provider = provider;
    if (provider === "claude") existing.claudeCloudProvider = exportedClaudeProvider(process.env);
    existing.lastActiveAt = now();
    await store.save();
    console.log(`✓ ${existing.name} already maps to Telegram topic ${existing.topicId} (${provider}).`);
    return publicProject(existing);
  }
  if (store.state.projects[id]) throw new Error(`Project name "${id}" is already linked`);
  const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
  await client.getMe();
  const topic = await client.createForumTopic(store.state.telegram.chatId, name);
  const project = {
    id, name, cwd, provider, linkId: randomUUID(),
    ...(provider === "claude" ? { claudeCloudProvider: exportedClaudeProvider(process.env) } : {}),
    topicId: Number(topic.message_thread_id),
    telegramChatId: String(store.state.telegram.chatId),
    sessionIds: {},
    accessMode: "edit",
    status: "idle",
    createdAt: now(),
    lastActiveAt: now(),
  };
  store.state.projects[id] = project;
  await store.save();
  await client.sendMessage(store.state.telegram.chatId, [
    `✅ Project linked: ${name}`,
    `Provider: ${provider}`,
    `Folder: ${cwd}`,
    "",
    "Send a message here to start or resume the coding session.",
  ].join("\n"), { topicId: project.topicId });
  console.log(`✓ Created Telegram topic "${name}" and linked it to ${provider}.`);
  return publicProject(project);
}

async function launchInteractiveProvider(store, project, provider, projectRoot) {
  await assertCurrentProject(project);
  const linkId = project.linkId;
  const topicId = project.topicId;
  let hookInstalled = false;
  if (provider === "codex") {
    try {
      const hook = await installCodexHook(projectRoot);
      hookInstalled = hook.installed;
      if (hook.installed) {
        console.log("✓ Updated Codex session tracking. Review local hooks once with /hooks if prompted.");
      }
    } catch (error) {
      console.warn(`! Could not install the Codex approval bridge: ${error.message}`);
    }
  }
  if (hookInstalled && process.platform === "darwin") {
    await execute("launchctl", [
      "kickstart",
      "-k",
      `gui/${process.getuid()}/com.local-code-link.telegram`,
    ]);
  }

  const configured = provider === "codex"
    ? process.env.CODEX_BIN || "codex"
    : process.env.CLAUDE_BIN || "claude";
  const executable = await resolveExecutable(configured);
  let sessionId = project.sessionIds?.[provider];
  let remoteCodex = false;
  let tuiProxy;
  let remoteEndpoint = "unix://";
  if (provider === "claude") {
    try {
      await claudeRequest(store.root, project, "status");
      throw new Error("This project already has a linked Claude terminal. Use it or Telegram; close it before reopening.");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    }
    if (project.localSession?.status === "active" && project.localSession.pid) {
      let alive = true;
      try { process.kill(project.localSession.pid, 0); } catch (error) {
        if (error.code === "ESRCH") alive = false; else throw error;
      }
      if (alive) throw new Error("Claude is already running for this project. Close that session, then reopen with local-code-link claude to enable the bridge.");
    }
    if (project.status === "busy") {
      throw new Error("Finish or interrupt this project's Telegram Claude task before opening a terminal session.");
    }
    if (project.backgroundTask?.pid) {
      let alive = false;
      try { process.kill(project.backgroundTask.pid, 0); alive = true; } catch { /* stopped */ }
      if (alive) throw new Error("A background Claude task is still running for this project. Finish or interrupt it before opening a terminal.");
    }
    const selection = await selectClaudeSession(store, project);
    sessionId = selection.sessionId;
    console.log("✓ Claude terminal + Telegram bridge enabled. Review the LocalCodeLink hooks if prompted; approval decisions remain single-use.");
  }
  if (provider === "codex") {
    if (["starting", "active"].includes(project.localSession?.status) && project.localSession.pid) {
      let alive = false;
      try { process.kill(project.localSession.pid, 0); alive = true; } catch { /* stale session */ }
      if (alive) throw new Error("This project already has a linked Codex terminal. Use it or Telegram; close it before reopening.");
    }
    const daemon = await execute(executable, ["app-server", "daemon", "start"], { env: codingEnvironment() });
    remoteCodex = daemon.code === 0;
    if (!remoteCodex) {
      throw new Error(`Cannot start the shared Codex server: ${daemon.stderr.trim() || daemon.stdout.trim()}`);
    }
    tuiProxy = new CodexTuiProxy(store, project);
    try {
      const selection = await selectCodexSession(store, project, tuiProxy.metadata);
      sessionId = selection.sessionId;
      if (selection.reason) {
        console.log(`! Ignored the saved Codex binding (${selection.reason}); starting a new session in this project.`);
      }
      remoteEndpoint = `unix://${await tuiProxy.start()}`;
    } catch (error) {
      await tuiProxy.stop();
      throw error;
    }
  }
  const providerArgs = provider === "codex"
    ? codexInteractiveArgs(project, remoteEndpoint, sessionId)
    : claudeInteractiveArgs(store, project, projectRoot, sessionId);

  await store.reload();
  const launchProject = store.state.projects[project.id];
  if (!launchProject || launchProject.linkId !== linkId || launchProject.topicId !== topicId
    || ["unlinked", "archived"].includes(launchProject.status)) {
    await tuiProxy?.stop();
    throw new Error("Project link changed while opening the session; run the command again.");
  }
  if (provider === "codex" && (launchProject.sessionIds?.codex || null) !== sessionId) {
    await tuiProxy?.stop();
    throw new Error("Project session changed while opening Codex; run the command again to use the current session.");
  }
  project = launchProject;
  project.provider = provider;
  project.localSession = {
    status: "starting",
    startedAt: now(),
    provider,
    ...(provider === "codex" ? { approvalProxyPid: process.pid } : { claudeBridgePid: process.pid }),
  };
  await store.save();

  console.log(`✓ Opening ${provider} for "${project.name}"${sessionId ? " (resuming)" : " (new session)"} in ${project.cwd}…`);
  let launchedPid;
  let exitCode;
  try {
    if (provider === "claude") {
      exitCode = await runClaudeTerminal(store, project, executable, providerArgs, async (pid) => {
        project.localSession.pid = pid;
        launchedPid = pid;
        project.localSession.status = "active";
        await store.save();
      });
    } else exitCode = await new Promise((resolve, reject) => {
      const child = spawn(executable, providerArgs, {
        cwd: project.cwd,
        env: codingEnvironment(),
        stdio: "inherit",
      });
      project.localSession.pid = child.pid;
      launchedPid = child.pid;
      project.localSession.status = "active";
      store.save().catch(() => {});
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await tuiProxy?.stop();
    await store.reload();
    const current = store.state.projects[project.id];
    if (current && current.linkId === linkId && current.topicId === topicId
      && current.localSession?.pid === launchedPid) {
      current.localSession = {
        status: "stopped",
        stoppedAt: now(),
        exitCode: exitCode?.code,
        signal: exitCode?.signal,
      };
      await store.save();
    }
  }
  if (exitCode.code && exitCode.code !== 0) {
    throw new Error(`${provider} exited with code ${exitCode.code}`);
  }
}

const args = process.argv.slice(2);
const command = args[0];
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  const { file: envFile } = await loadConfiguration(projectRoot);
  const store = await new StateStore().init();
  if (!command || command === "help" || args.includes("--help")) {
    usage();
  } else if (command === "setup" && args[1] === "telegram") {
    const result = await setupTelegram(store, envFile, projectRoot);
    console.log(`✓ Telegram setup complete with @${result.bot}.`);
    console.log("Run local-code-link claude or local-code-link codex inside a project.");
  } else if (command === "claude" || command === "codex") {
    const providerOptions = args.slice(1);
    if (providerOptions.some((arg) => arg.startsWith("--") && arg !== "--link-only")
      || providerOptions.filter((arg) => !arg.startsWith("--")).length > 1) {
      throw new Error(`Use local-code-link ${command} [project-name] [--link-only]`);
    }
    const linked = await linkProject(store, command, providerOptions.find((arg) => !arg.startsWith("--")));
    if (providerOptions.includes("--link-only")) {
      console.log("Mapping saved. To enable shared terminal control, open the managed session with local-code-link " + command + ".");
    } else await launchInteractiveProvider(store, store.state.projects[linked.id], command, projectRoot);
  } else if (command === "list") {
    console.log(JSON.stringify(Object.values(store.state.projects).map(publicProject), null, 2));
  } else if (command === "status") {
    const currentDirectory = args[1] ? null : await realpath(process.cwd());
    const project = args[1]
      ? store.state.projects[slug(args[1])]
      : Object.values(store.state.projects).find((item) => item.cwd === currentDirectory);
    if (!project) throw new Error("Project is not linked");
    console.log(JSON.stringify(publicProject(project), null, 2));
  } else if (command === "serve") {
    const release = await acquireProcessLease(path.join(store.root, "telegram-service.lock"));
    try {
      Object.assign(process.env, await resolveProviderEnvironment());
      const service = new TelegramService(store);
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
        service.runtime.stop();
        service.client.stop();
      });
      await service.start();
    } finally { await release(); }
  } else if (command === "doctor") {
    const env = await resolveProviderEnvironment();
    console.log(`Telegram: ${store.state.telegram.botId ? "configured" : "not configured"}`);
    console.log(`Claude background provider: ${env.CLAUDE_CODE_USE_BEDROCK === "1" ? "Bedrock"
      : env.CLAUDE_CODE_USE_VERTEX === "1" ? "Vertex" : env.CLAUDE_CODE_USE_FOUNDRY === "1" ? "Foundry" : "native/API authentication"}`);
    console.log("Login-shell provider configuration: available (credential values hidden)");
    for (const provider of ["claude", "codex"]) {
      const executable = await resolveExecutable(env[`${provider.toUpperCase()}_BIN`] || process.env[`${provider.toUpperCase()}_BIN`] || provider);
      const result = await execute(executable, ["--version"]);
      console.log(`${provider}: ${result.code === 0 ? "installed" : "unavailable"}`);
    }
  } else if (command === "service") {
    if (process.platform !== "darwin") throw new Error("Service management currently supports macOS. Use local-code-link serve on other systems.");
    const target = `gui/${process.getuid()}/com.local-code-link.telegram`;
    let result;
    if (args[1] === "install") {
      result = await installService(projectRoot, {
        codex: await resolveExecutable(process.env.CODEX_BIN || "codex"),
        claude: await resolveExecutable(process.env.CLAUDE_BIN || "claude"),
      });
      console.log("✓ Background service installed. Provider authentication is loaded from your login shell without saving credentials.");
    } else if (args[1] === "stop") {
      result = await execute("launchctl", ["bootout", target]);
    } else if (args[1] === "start") {
      result = await execute("launchctl", ["kickstart", target]);
    } else if (args[1] === "status") {
      result = await execute("launchctl", ["print", target]);
      console.log(result.code === 0 ? "Background service is loaded." : "Background service is not loaded.");
    } else throw new Error("Use local-code-link service install|start|stop|status");
    if (result.code && args[1] !== "status") throw new Error(`Service ${args[1]} failed. Use service install if it is not loaded.`);
    if (["stop", "start"].includes(args[1])) console.log(`✓ Background service ${args[1] === "stop" ? "stopped" : "started"}.`);
  } else if (command === "unlink") {
    const requestedProject = args.slice(1).find((arg) => !arg.startsWith("--"));
    const currentDirectory = requestedProject ? null : await realpath(process.cwd());
    const project = requestedProject
      ? store.state.projects[slug(requestedProject)]
      : Object.values(store.state.projects).find((item) => item.cwd === currentDirectory);
    if (!project) throw new Error("Project is not linked");
    if (!args.includes("--confirm")) {
      console.log(`This permanently deletes the Telegram topic "${project.name}" and all of its messages,`);
      console.log("plus this project's LocalCodeLink mapping, approval history, and request records.");
      console.log("Project files and native Codex/Claude session history are kept.");
      if (!stdin.isTTY) {
        throw new Error("Unlink requires confirmation. Run interactively or add --confirm");
      }
      if ((await ask("Delete this project's topic and bridge history? Type yes", "no")).toLowerCase() !== "yes") {
        console.log("Cancelled. Nothing was removed.");
        process.exit(0);
      }
    }
    const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
    const runtime = new CodingRuntime(store, {
      onDeleteTopic: (linkedProject) => client.deleteForumTopic(
        linkedProject.telegramChatId || store.state.telegram.chatId, linkedProject.topicId),
    });
    try {
      const result = await runtime.unlink(project.id, { confirmed: true });
      console.log(`✓ Removed "${project.name}" from LocalCodeLink and deleted its Telegram topic/messages.`);
      console.log("Project files and native coding sessions are kept.");
      for (const warning of result.warnings) console.warn(`! ${warning}`);
    } finally {
      runtime.stop();
    }
  } else if (command === "reset") {
    if (!args.includes("--confirm")) throw new Error("Reset requires --confirm");
    // The state root can be customized. Never recursively erase an arbitrary
    // user-selected directory or unrelated files stored next to state.json.
    await rm(store.file, { force: true });
    console.log("Reset LocalCodeLink mappings/history. Telegram topics, native sessions and other files were not deleted.");
  } else {
    throw new Error(`Unknown command: ${args.join(" ")}`);
  }
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}

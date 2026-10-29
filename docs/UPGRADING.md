# Install, verify and upgrade

[LocalCodeLink 0.9.2](https://github.com/joinotto/local-code-link/releases/tag/v0.9.2)
is a GitHub preview. npm registry publication remains disabled.
Use Node.js 20.18.1 or newer; Node.js 22.22.0 is used for verification.
macOS is the verified native deployment. Linux foreground/protocol checks do
not constitute live native-provider acceptance; Windows is unsupported.

## Install the published preview

```sh
npm install --global https://github.com/joinotto/local-code-link/releases/download/v0.9.2/local-code-link-0.9.2.tgz
local-code-link
```

The wizard handles first-time Telegram pairing and project launch.
Use a user-owned npm prefix or Node installation; do not run setup or coding
sessions with `sudo`.

## Verify the archive before installation

Download both assets from the trusted release page into a temporary directory:

```sh
lcl_release_dir="$(mktemp -d)"
cd "$lcl_release_dir"
curl --fail --location --remote-name https://github.com/joinotto/local-code-link/releases/download/v0.9.2/local-code-link-0.9.2.tgz
curl --fail --location --remote-name https://github.com/joinotto/local-code-link/releases/download/v0.9.2/local-code-link-0.9.2.tgz.sha256
shasum -a 256 -c local-code-link-0.9.2.tgz.sha256
```

Continue only if the checksum reports `OK`. The published 0.9.2 archive's SHA-256 is:

```text
97006f031af7c18739ba76e38afb06a6a50ead14fe2bf3d25972c5b44e8230fc
```

This checks byte integrity against the published checksum, not the safety of
arbitrary code or a replacement asset from an untrusted source.
Install the verified archive with:

```sh
npm install --global ./local-code-link-0.9.2.tgz
```

## Upgrade without losing mappings

1. Finish pending approvals and Telegram/background coding work.
2. Close managed Claude/Codex terminals normally. Their native session history
   and saved bridge bindings remain available for resume.
3. Stop your foreground `local-code-link serve` process with Ctrl+C. On macOS,
   if the launchd service is installed and loaded, use
   `local-code-link service stop` instead. Stop only your LocalCodeLink service;
   do not stop unrelated coding sessions or native provider daemons.
4. Install the published archive using the **same npm prefix and supported Node
   installation** as before.
5. Restart the bridge and reopen managed project sessions as shown below.

Keep the same `LOCAL_CODE_LINK_HOME` and `LOCAL_CODE_LINK_ENV_FILE` if you set
custom paths. Version 0.9.2 does not require `reset`, `unlink` or fresh
Telegram pairing. Existing private configuration, project topics and native
session history are preserved.

### Avoid installing a second CLI accidentally

Before and after upgrading, check:

```sh
command -v local-code-link
npm prefix --global
```

If the original install used `--prefix`, use that same option during upgrades.
For example, an existing user-local installation may use:

```sh
npm install --global --prefix "$HOME/.local" https://github.com/joinotto/local-code-link/releases/download/v0.9.2/local-code-link-0.9.2.tgz
```

Changing Node versions can change the default global npm prefix. Installing
somewhere else may leave the old command first on PATH. Do not delete an unknown
launcher to resolve this; use the original prefix and verify command resolution.

### Restart on macOS

```sh
local-code-link service install
local-code-link service status
local-code-link doctor
```

Reinstallation loads the new package/configuration paths into launchd.
It does not reset the Telegram bot or project mappings.

Inside each project folder, reopen the appropriate provider:

```sh
local-code-link codex
# or
local-code-link claude
```

Already-running terminals do not automatically load new relay code.

### Restart Linux foreground mode

In a dedicated terminal:

```sh
local-code-link serve
```

Then reopen the appropriate managed provider in another terminal inside its
project. macOS `service` commands do not apply to Linux.

## Recover a missing Codex executable

If Codex works in a different terminal, run `command -v codex` there.
Use the returned absolute path when rerunning setup:

```sh
CODEX_BIN="/absolute/path/from-command-v/codex" local-code-link setup telegram
```

Select **Reuse configured bot** to preserve existing pairing and topics.
This makes the provider path available to the background service even if Codex
is installed under a different Node version.

## Preview status

See [release acceptance](RELEASE_CHECKLIST.md) for observed results and remaining
live/hardware checks. Automated tests and checksum verification are not full
production sign-off.

Existing memory-only or paginated Codex threads are not converted during an
upgrade. If you have one, preserve its context and follow the explicit
fresh-session steps below. Ordinary supported saved sessions remain resumable.

## Reset and pair again

Reset is an explicit start-over operation, **not** a required upgrade step.
The following workflow is available in the published 0.9.2 preview:

```sh
local-code-link reset
```

Read the scope shown in the terminal and answer **Yes** or **No**.
Enter defaults to No; invalid answers are requested again.
Piped/noninteractive execution and the old `--confirm` bypass are rejected.
No does not initialize a new state directory or modify existing files.

Before choosing Yes, finish pending approvals/queued deliveries and close
managed coding sessions. Stop a foreground `serve` process yourself.
Reset can stop the matching macOS launchd service, but never kills unrelated
coding/provider processes. If history cannot be safely checked for active work,
reset refuses rather than guessing that it is idle.

Yes archives only known bridge history/configuration/log files, stale relay
endpoints and the matching service definition into a private recovery directory.
It removes only this installation's owned provider hooks, preserving other
settings and permission rules. New stores/writers are blocked during archival.
Unrelated files in a custom state directory remain untouched.

Fresh Telegram setup starts immediately and requires hidden token entry and a
new owner/admin `/connect CODE`. Old loaded or inherited Telegram credentials
are not reused. Installed provider executable locations and native authentication
remain available; project/session mappings do not.
If you previously exported Telegram settings in your shell, run this before
later CLI commands so the freshly saved private configuration takes precedence:

```sh
unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_ALLOWED_USER_IDS
```

Project files, native Claude/Codex session history and Telegram messages remain.
Old Telegram topics are not deleted, but lose their local mappings; linking
projects after reset creates fresh topics. This does not revoke a bot token.
Replace any previously exposed token through BotFather before reconnecting.

If setup is cancelled or pairing fails, the old setup is not silently restored.
Use `local-code-link setup telegram` to continue pairing.
The backup location printed by reset retains the previous configuration/history
for recovery. Backups contain private data and potentially credentials; do not
commit or share them.

## Recovering a memory-only Codex session

If Telegram reports `ephemeral thread does not support queued submissions`,
the linked terminal created a memory-only thread. Updated starts/forks explicitly
use persistent threads. Installing the update does not alter an already-running
terminal relay or convert its thread.

Finish any current work and close that project's terminal session. After updating
the background service, send `/new` in the project's Telegram topic, then run
`local-code-link codex` from that project's folder and resend the rejected prompt.
This keeps the existing project/topic mapping; it starts a fresh conversation.
The old native thread is not deleted, but its context is not automatically
transferred. Save any context you need before closing a memory-only session.
If the native server already reports `thread not loaded`, the updated CLI can
discard that unavailable binding and start fresh in the same project without
`/new`, provided no genuinely pending Telegram work remains.
The CLI itself clears legacy definite ephemeral-queue rejections during this
check; those rejected prompts do not require a service restart to unblock opening.

The updated service removes only legacy request records containing the exact
ephemeral-queue rejection with no accepted queue ID or result. It never replays
those prompts. Timeouts and disconnected submissions remain uncertain rather
than being automatically retried.

## Codex reserved rollout paths and history format

Codex can report a persistent thread and a future rollout path before its first
user message. That metadata alone is not proof it can resume. The CLI now checks
for a nonempty rollout file; a verified empty/unmaterialized binding starts fresh
in the same project/topic. Existing turns, active work or failed verification
prevent replacement. No native history files are deleted.

New managed threads explicitly use legacy JSONL history for this bridge's
result correlation. Existing paginated threads are not converted: preserve
their context and explicitly use `/new` for a supported managed conversation.
Paginated-history result support remains future work.

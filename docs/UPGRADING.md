# Install, verify and upgrade

[LocalCodeLink 0.9.1](https://github.com/joinotto/local-code-link/releases/tag/v0.9.1)
is a GitHub preview. npm registry publication remains disabled.
Use Node.js 20.18.1 or newer; Node.js 22.22.0 is used for verification.
macOS is the verified native deployment. Linux foreground/protocol checks do
not constitute live native-provider acceptance; Windows is unsupported.

## Install the published preview

```sh
npm install --global https://github.com/joinotto/local-code-link/releases/download/v0.9.1/local-code-link-0.9.1.tgz
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
curl --fail --location --remote-name https://github.com/joinotto/local-code-link/releases/download/v0.9.1/local-code-link-0.9.1.tgz
curl --fail --location --remote-name https://github.com/joinotto/local-code-link/releases/download/v0.9.1/local-code-link-0.9.1.tgz.sha256
shasum -a 256 -c local-code-link-0.9.1.tgz.sha256
```

Continue only if the checksum reports `OK`. The published 0.9.1 archive's SHA-256 is:

```text
f556de1bf5bd8e7ba439603ba1c6b660a1867f1eb69155d6db119d26494ee182
```

This checks byte integrity against the published checksum, not the safety of
arbitrary code or a replacement asset from an untrusted source.
Install the verified archive with:

```sh
npm install --global ./local-code-link-0.9.1.tgz
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
custom paths. Version 0.9.1 does not require `reset`, `unlink`, `/new` or fresh
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
npm install --global --prefix "$HOME/.local" https://github.com/joinotto/local-code-link/releases/download/v0.9.1/local-code-link-0.9.1.tgz
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

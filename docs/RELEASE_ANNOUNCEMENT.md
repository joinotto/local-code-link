# LocalCodeLink 0.9.2 preview

Control project-scoped Claude Code and Codex sessions from Telegram while
keeping native terminal access and approval checks.

This release fixes Codex persistence, empty-session resume and rejected queue
recovery. It also adds a safe interactive `local-code-link reset` with private
backups. Normal upgrades preserve Telegram mappings and native coding history;
no reset or re-pairing is required.

Install the preview:

```sh
npm install --global https://github.com/joinotto/local-code-link/releases/download/v0.9.2/local-code-link-0.9.2.tgz && local-code-link
```

Existing users should first finish pending work, stop their bridge and follow
[the upgrade guide](UPGRADING.md), retaining the same npm prefix.

Verification: 235 passing automated tests, required macOS/Linux CI, zero reported
dependency vulnerabilities, clean archive installation and checked release
checksums. These are distribution checks, not full production sign-off.

Known limits: macOS is the verified native deployment; Windows is unsupported.
Existing memory-only/paginated Codex conversations are not automatically
converted. Live Telegram and hardware acceptance remain deployment checks.
npm registry publication remains disabled.

[Release and checksum](https://github.com/joinotto/local-code-link/releases/tag/v0.9.2)
· [Release acceptance](RELEASE_CHECKLIST.md) · [Security](../SECURITY.md)

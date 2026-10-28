# Changelog

## 0.9.1 — 2026-10-28 (preview)

[Published preview and checksum](https://github.com/joinotto/local-code-link/releases/tag/v0.9.1).
See [installation and upgrades](UPGRADING.md); no reset or re-pairing is needed
when retaining the same configuration/state directory.

### Setup guidance

- Telegram pairing now shows phone and desktop instructions for enabling Topics,
  adding the bot as an administrator and checking Manage Topics/Delete Messages.
- Added manual steps when the add-bot link is insufficient, plus guidance for
  private groups, non-anonymous pairing and the General topic.
- Added a maintained Telegram setup guide and absolute Codex-path recovery steps.

### Codex startup

- Terminal and background Telegram flows use the same daemon startup helper.
- Missing executables, denied execution, empty-output failures and signals now
  produce actionable errors instead of a blank startup message.
- Startup is bounded to 30 seconds and diagnostic output is bounded.
- Telegram bot credentials remain excluded from provider subprocesses.

Existing project/topic mappings and provider approval policies are unchanged.
There is no state migration or automatic reset. No native daemon stop/restart or
permission bypass is introduced.

This remains a preview, not full production sign-off. Hardware sleep/wake,
additional provider configurations and the remaining live acceptance gates are
documented in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
npm registry publication remains disabled; installation uses GitHub source or
the inspected release archive.

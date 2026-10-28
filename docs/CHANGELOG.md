# Changelog

## 0.9.2 — release candidate (2026-10-28)

- Linked Codex terminal starts/forks now explicitly create persistent threads
  so Telegram queue submissions are supported; native approval policies are unchanged.
- Explicit Codex queue rejections no longer remain as uncertain pending work.
  Recovery clears only legacy definite ephemeral-queue rejections, without replay.
  Existing memory-only threads are preserved and require an explicit fresh session.
- Stale `thread not loaded` bindings now recover like missing sessions without
  changing project topics or native history; genuinely pending work still blocks replacement.
- CLI session selection also clears only legacy definite ephemeral rejections,
  so reopening does not depend on a background-service reload.
- Codex resume verifies that a nonempty rollout file actually exists, rather
  than trusting a reserved path in live metadata. Empty unmaterialized sessions
  start fresh; existing turns, active work and verification failures preserve
  the binding instead of silently replacing context.
- New managed Codex threads explicitly use legacy JSONL history, matching native
  resume and result correlation. Existing paginated conversations are preserved
  and rejected with guidance, not silently converted or sent untrackable prompts.
- Native Codex replies remain actionable when the OS username lookup is
  unavailable; the CLI actor label falls back without changing authorization.
- `local-code-link reset` asks Yes/No with a safe No default, archives local
  history/configuration and starts fresh hidden-token Telegram pairing.
- Active-work/service/relay checks and a reset guard prevent clearing live
  approvals or concurrent state writes. Unrelated files, provider settings,
  native histories and Telegram messages are preserved.
- Recovery backups are private; noninteractive and `--confirm` bypasses are
  rejected. Existing versioned release tags/archives remain unchanged.

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

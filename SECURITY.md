# LocalCodeLink security

This is a single-user local bridge, not a multi-tenant service or a security
sandbox. A person controlling an allowed Telegram account can direct the
linked coding agents, subject to the providers' native permission policies.

## Deployment requirements

- Use a private forum group and explicit Telegram user/chat allowlists.
- Treat the bot token as a bearer credential. The private `config.env` (or a
  legacy `.env`) must be mode `0600`;
  never commit it, screenshots containing it, or provider credential output.
- The background service loads allowlisted provider settings from your trusted
  zsh/bash startup configuration. Credentials remain in process memory; the
  bridge does not save them in its state, launchd plist, or diagnostics.
- Do not put credentials in noisy shell startup output. Shell startup is
  executed as you; remote project text cannot change the shell command.
- New coding child processes do not inherit the Telegram bot token.
  This does not retroactively sanitize an already-running provider daemon.
- First setup pairs only with the fresh `/connect CODE` printed by the CLI,
  from a real group owner/admin. Public groups and insufficient bot topic/message
  permissions are rejected. Keep the setup code private until pairing finishes.
- The launcher never sources `.env` as shell code. New setup writes configuration
  into the user's private state directory, not the installed package.
- Proxy settings are captured from the trusted login shell in memory; service
  definitions do not store credential-bearing proxy URLs.
- Keep the native provider sandbox and permission checks enabled.
- Unix sockets and state files are private to the local user. Another process
  running as that same user is not isolated by the bridge.
- Telegram bot messages are not a place for passwords or other secrets.
  Codex questions flagged `isSecret` remain terminal-only and their answers are
  not recorded by the bridge.

## Approval guarantees

Remote decisions are scoped to one request, project, topic, user and link
generation. The CLI and Telegram share a disk-backed first-writer claim.
Expired, interrupted, unlinked and resolved requests cannot be remotely
approved again. Remote approval does not create permanent permission rules.
Secret questions, malformed questions and unknown request types are never
automatically answered.

## Recovery and delivery

Only one bridge service may own a state directory. Telegram update offsets are
checkpointed after handling; accepted prompts carry bounded update-ID history
to avoid repeating a received prompt. Queued Claude work and results are
durable. A interrupted/background task is reported, not automatically replayed
when its execution state is ambiguous. A still-running orphan is not replaced
by a second writer.

Telegram cannot provide exactly-once message delivery: an HTTP response may
be lost after a message was delivered. A retry may duplicate a notification or
result. Uncertain new-message writes and partially sent multi-chunk output are
held, not blindly retried. Inspect Telegram, then use `/delivery` and
`/retry-delivery ID` to explicitly resend only that message. Known rejected
requests honor Telegram's retry delay; repeated failures back off. Duplicate
approval buttons still refer to the same decision claim and cannot authorize
the action twice.

State writes use private temporary files, fsync and atomic rename. Corrupt or
unsupported state fails closed without silently resetting project mappings.
This protects against ordinary interrupted writes, not failing storage hardware
or a malicious process running as the same local user.

Actual hardware sleep/wake, provider upgrades, credential expiry and OS account
changes must be verified on the deployment machine. Test coverage or a working
connection alone is not certification that every provider will always behave
identically.

## Reporting

Do not post tokens, full state files, transcripts or credential-bearing logs in
public issues. Report security problems privately to the repository maintainer
and include sanitized reproduction steps and affected versions.

If GitHub private vulnerability reporting is enabled, use
https://github.com/joinotto/local-code-link/security/advisories/new.
If it is unavailable, ask the maintainer for a private reporting route without
disclosing vulnerability details. A monitored route has not yet been verified.
The maintainer must enable and monitor it before advertising it as available.

The current release candidate is the only version under evaluation. No long-term
support policy or security certification is claimed.

Do not deploy a token that has been posted in chat, logs or screenshots.
Rotate it with BotFather and enter the replacement at the hidden setup prompt.
An automated package test cannot attest that a previously exposed token has
actually been revoked.

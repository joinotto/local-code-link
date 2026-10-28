# LocalCodeLink roadmap

## 0.9 — Telegram foundation

- [x] Telegram long polling
- [x] Existing/new BotFather token onboarding
- [x] Private chat and user allowlists
- [x] Automatic control and project topics
- [x] Claude Code streaming provider
- [x] Codex app-server provider
- [x] Immediate single-use approval buttons
- [x] Native Codex + Telegram approval mirroring, first-decision wins, button cleanup
- [x] Prompt, output, reset, status, and interrupt
- [x] Confirmed unlink deletes project topic/messages and bridge history
- [x] End-to-end Claude approval, denial, questions and replies with the owner's Telegram bot
- [ ] Portable launchd/systemd installer
- [ ] macOS Keychain token storage
- [x] 90-day inactive topic archival

## 0.10 — Reliability

- [ ] SQLite transactional state
- [x] Telegram retry-after handling, delivery backoff and explicit uncertain-message recovery
- [ ] Incremental streaming and message editing
- [ ] Provider protocol compatibility checks
- [ ] Crash-safe task recovery
- [x] Durable Claude prompt queue and result outbox; ambiguous interrupted work is not replayed
- [x] Background provider authentication from the login shell without credential persistence
- [x] Single-service lease, update checkpointing and inbound prompt deduplication
- [x] macOS service-management commands and sanitized doctor diagnostics
- [x] Bounded incremental Codex transcript reads and reconnect recovery
- [x] Shared Codex daemon dispatch (start idle requests; queue busy follow-ups)
- [x] Recover queued Codex requests after bridge restart
- [x] Concurrent JSON state writes with project unlink protection
- [x] Crash-durable JSON writes and fail-closed corrupt/unsupported-state handling
- [ ] Structured audit log and redaction
- [ ] Handoff for locally started provider sessions
- [x] Managed live interactive Claude terminal relay (reopen plain sessions once)
- [x] Provider-neutral Claude terminal relay (Bedrock live-tested)
- [x] Shared Claude decision claims and CLI/Telegram actor attribution
- [ ] Retroactive attachment to arbitrary already-running plain Claude terminals
- [ ] MCP elicitation and sandbox network approval forwarding
- [ ] Cross-version/provider/platform compatibility matrix
- [x] Structured Claude/Codex question forwarding, answer validation and shared first-decision claims
- [ ] MCP elicitation forwarding
- [ ] Files, images, and voice messages
- [x] Linux/macOS protocol-test CI definition and security/release checklist
- [x] Hidden bot-token input with cancellation and terminal restoration
- [x] Portable Node launcher and source-path decoding
- [x] Private configuration outside installed packages, with legacy read compatibility
- [x] Mapping-only bundled Claude/Codex commands; no nested session launch
- [x] Fresh-challenge, owner/admin-only private Telegram group pairing
- [x] Distributable dependency shrinkwrap and isolated tarball/native-terminal test
- [x] Durable hardware acceptance reports and package release inspection
- [x] Apache-2.0 license, attribution, contributor docs and standalone CLI metadata
- [x] OpenSource repository conventions, SVG banner and SHA-pinned CI definition
- [x] Live deployed restart acceptance for Claude/Codex pending approvals
- [x] Real isolated Telegram outage and Bedrock credential-rejection recovery checks
- [ ] Hardware sleep/wake verification for Codex: idle, active turn, pending approval

## Future deployment acceptance

Checked items record observed results. Unchecked items remain deferred and
unverified; deferral does not provide a blanket production guarantee.

- [x] Run hosted Linux/macOS CI after approved publication to joinotto/local-code-link
- [ ] Verify Claude hardware sleep/wake while idle, active, and awaiting approval
- [ ] Test natural long-lived credential expiry and renewal with the deployed auth method
- [ ] Reopen existing provider terminals/daemons safely after upgrades
- [ ] Review ordinary Telegram group membership; administrator allowlist was checked
- [ ] Inspect Telegram for an unrecorded temporary topic from an uncertain creation response
- [ ] Confirm replacement of any previously exposed Telegram token

Token replacement is an owner-controlled security action, not an optional
feature: if the previously exposed token is still valid, rotate it with
BotFather before relying on remote access. Enter the replacement only at the
hidden CLI setup prompt, never in chat.

## Later

- [ ] Gemini CLI
- [ ] Antigravity CLI
- [ ] xAI Grok Build
- [ ] Matrix
- [ ] Slack

## Non-goals

- Automatically creating Telegram bot accounts
- Disabling provider sandboxes by default
- Permanent remote approval rules
- Public unauthenticated access
- Hosting project source code remotely

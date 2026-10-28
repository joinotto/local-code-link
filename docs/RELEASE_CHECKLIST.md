# Release acceptance

Scope: a distributable package that each user installs on their own macOS
machine, with their own Telegram bot and authenticated native Claude and Codex
sessions. This is not a shared hosted service. This checklist distinguishes
implemented behavior, real-provider verification and outstanding release gates.

**Status: release candidate; full production sign-off is not granted.**

## Open-source repository preparation — 2026-10-28

- Used the `joinotto/opensource` common-only generator in an ignored temporary
  scaffold, then adapted its repository files without replacing the JavaScript CLI.
- Declared Apache-2.0 and copyright `2026 Anurag Patel (geekfarmer)`, retained
  upstream notices, and added contributor/DCO guidance and security reporting steps.
- Initialized a standalone local repository with `main` and origin
  `joinotto/local-code-link`. The owner authorized the initial commit and push;
  source publication and hosted CI must be confirmed against the remote revision.
- The updated 172-test suite passed on macOS with no failures, skips or cancellations.
  Linux evidence below covers the earlier 171-test revision; hosted current CI
  remains outstanding.
- Distributable package inspection passed for 57 files, including license/notice
  matching and private scaffold exclusion.
- The actual updated archive installed cleanly in a spaced-path temporary
  directory. Both CLI aliases, native PTY execution, both provider integrations,
  licensing, notices and maintained docs passed.
- GitHub YAML files parsed successfully; CI action references were verified and
  pinned. This is not evidence that hosted CI has run.
- npm publication remains disabled.

## Distribution verification — 2026-10-28

- All 171 automated tests passed on macOS and in an isolated Linux Node 22.22.0
  container, with no failures, skips or cancellations.
- Dependency audit reported no known vulnerabilities.
- A real packed archive installed successfully into an isolated directory with
  spaces in its path. Both command aliases, native PTY execution and bundled
  Claude/Codex integrations passed. This test did not configure a bot or modify
  real provider sessions or home configuration.
- The package ships an exact dependency shrinkwrap. The launcher no longer
  requires developer-specific paths or executes configuration as shell code.
- Private configuration defaults to `~/.local-code-link/config.env`; configuration
  and acceptance evidence are written atomically with mode `0600`.
- Telegram onboarding requires a fresh pairing challenge, validates private
  forum and administrator permissions, preserves received updates, and refuses
  to displace another application's webhook.
- Bundled linking commands use `--link-only`, preventing a nested coding session.
  The bundled Codex skill passed its structural validator.
- Fresh real Codex tests passed: structured question resolution, harmless command
  denial, cleanup, exact-project/session reconnect and authenticated inference.
- Fresh real Claude tests passed: permission denial and exact-session resume
  from a credential-free launchd-like parent environment.
- Initial artifact inspection found only two package blockers: no selected
  license and no `LICENSE` file. Both have now been resolved with Apache-2.0,
  copyright `2026 Anurag Patel (geekfarmer)`, and retained upstream notices.
  Package inspection is not a substitute for the live deployment gates below.

These changes have not yet been installed into the owner's running launchd
service or already-open managed terminals. The earlier running service is not
evidence that the new service-install path has passed live acceptance.

## Verified locally — 2026-10-27

- 149 automated tests passed on macOS and in a disposable Linux container;
  no skipped or cancelled tests.
- Verification environment: Node 22.22.0, macOS 27.2, live interactive Claude
  Code 2.1.146 and Codex CLI 0.164.0; Linux protocol tests used Debian Bookworm.
- Dependency audit reported no known vulnerabilities.
- Real Claude stdio permission denial and exact-session resume passed with
  provider credentials removed from the parent environment and restored from
  trusted shell configuration.
- Real Codex structured question, native decision resolution, harmless command
  denial and same-thread reconnect/inference passed through the production relay.
- Real deployed daemon restarts passed with a native Codex approval pending and
  with a native Claude terminal turn awaiting approval. Neither terminal was
  replaced; the same pending request was resolved afterward.
- Native interactive Claude approval, denial and question answering passed
  through the real CLI panel, with actual Telegram result delivery and resolved
  button cleanup. This run used controlled CLI decisions, not fabricated
  Telegram callbacks.
- An isolated real Telegram transport was blocked for 60 seconds. A computed
  Claude result remained held and was delivered after connectivity returned,
  without rerunning coding work. The Mac's global network was not disabled.
- Bedrock rejected invalid credentials injected only into a test child. Trusted
  shell authentication was then refreshed and the exact Claude session resumed.
  This is not evidence of natural long-lived credential expiry.
- Interactive bot token entry does not echo the token or display it as a prompt
  default. Cancellation and terminal-mode restoration are regression-tested.
- The updated macOS Telegram service was reloaded; diagnostics detect the
  configured Bedrock provider without exposing credential values.
- Live Telegram read-only checks passed: authentication, private forum group,
  explicit numeric user allowlist and bot topic-management permission.
- The group's sole human administrator is in the configured allowlist.
  Ordinary group membership still requires owner review; it was not enumerated.
- Package inspection excluded `.env`, state and log files.
- Fault tests cover retry-after, lost HTTP responses, partial message delivery,
  expired Telegram access, Unicode chunk boundaries, corrupt state, concurrent
  reload/save and unsafe retention settings.

An earlier human-operated scripted Telegram test timed out waiting for a
decision and is not counted as a pass. The owner subsequently reported that
inactive-session Telegram replies work. A stale question left by that older
temporary fixture was explicitly interrupted; its queued message then
completed. Real sessions were not interrupted.

## Release scope and limits

This is a hardened release candidate for the single-user scope above, not a
blanket guarantee for every future provider version, OS change, credential
expiry, network condition or storage failure. The checks below must pass on the
deployment before declaring full production acceptance. Local container tests
do not imply that hosted CI ran.

Uncertain deliveries are intentionally paused. Use `/delivery`, inspect
Telegram, then `/retry-delivery ID` if a resend is needed. This resends only a
message; it never replays coding work or approves an action. `/status` explains
when a saved Codex turn is waiting for input; resolve it or explicitly interrupt
it rather than allowing the bridge to guess.

## Implemented

- Project/topic isolation, queued prompts, exact-folder session selection.
- Immediate shared approvals, explicit single-use decisions, actor attribution.
- Structured Claude/Codex questions; secret Codex answers stay local.
- Background provider authentication without copying credentials into state.
- Native coding children do not inherit the Telegram bot token.
- Durable Claude prompt/output handling and duplicate incoming-update guards.
- Singleton bridge service and Telegram polling-conflict detection.
- Codex reconnect/queue recovery and bounded transcript tailing.
- Safe interruption, unlink revocation, button cleanup and diagnostics.
- Crash-durable state writes and fail-closed corrupt/unsupported-state handling.
- Telegram delivery backoff and explicit uncertain-message recovery.
- Safe retention validation; invalid activity records/control topics/busy native
  turns are not accidentally archived.

## Verification commands

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
npm run test:package
npm run check:release
local-code-link doctor
node scripts/verify-claude-live.mjs --background-env
node scripts/verify-codex-live.mjs
node scripts/verify-codex-live.mjs --telegram
node scripts/verify-codex-live.mjs --restart-service
node scripts/verify-claude-telegram-live.mjs --cli-decisions --restart-service
node scripts/verify-operational-live.mjs --credentials
node scripts/verify-operational-live.mjs --network
```

Use the default Claude Telegram verifier and `--telegram` Codex verifier for
real user button choices; `--cli-decisions` exercises the actual CLI panel.
The restart verifiers refuse to restart the service if another project has
pending approvals or background work. Tests create temporary projects/topics.
An absent request,
connection alone, an error response or an unexpected user choice must not be
reported as a successful approval/denial case.

Hardware verification is deliberately manual. With a person ready to wake the
Mac, run each command below and wait for `READY FOR REAL SLEEP` before sleeping
the machine for at least 15 seconds. The script checks actual system Sleep/Wake
events; pausing a process or sleeping the display does not count.

```bash
node scripts/verify-sleep-all-live.mjs
# Or run each state separately:
node scripts/verify-sleep-live.mjs --phase idle
node scripts/verify-sleep-live.mjs --phase active
node scripts/verify-sleep-live.mjs --phase approval
```

These hardware checks cover Codex; Claude hardware sleep/wake must also be
verified separately. Full hardware acceptance has not passed on this deployment.

The combined verifier prepares three isolated native sessions so one physical
sleep can cover all states. Its active command is exactly `/bin/sleep 1800`,
allowing time for manual preparation; after wake the verifier interrupts only
that owned turn rather than waiting for the command's full duration. It checks
actual execution, no replay, and native interruption acknowledgement. An unused
empty thread is not treated as persisted history: the idle fixture completes a
no-tools seed turn before readiness.

Earlier hardware attempts did not pass: one power-log read timed out across
sleep, an empty idle fixture had no saved rollout, and a five-minute manual
window expired before a later sleep began. The power reader now retries only
bounded timeout failures, the fixture is seeded, and the manual event window is
longer. Those failures must not be counted as successful recovery.

In the October 27 combined attempt, physical sleep lasted from 12:59:58 UTC
to 13:01:53 UTC. The active fixture had already finished at 12:55:46 UTC, so
that attempt does not verify recovery of running work. Idle and pending-approval
observations do not count as a complete three-state pass; no durable successful
combined report was produced.

The updated helpers now persist private per-phase evidence and a combined
summary. Readiness output alone is not acceptance. Require `status: "passed"`
for every phase and the combined summary, with matching physical Sleep/Wake
events. A fresh successful hardware run remains outstanding.

## Deployment checks

Unchecked items remain release gates for full distributable production sign-off.
Listing them in [ROADMAP.md](ROADMAP.md) does not make them verified.

- [x] Clean archive installation, portable commands and real native PTY execution.
- [x] macOS and isolated Linux automated regression suites.
- [x] Select license; include `LICENSE`, `NOTICE` and matching package metadata.
- [x] Choose repository destination: joinotto/local-code-link.
- [ ] Publish reviewed source after owner authorization.
- [ ] Hosted Linux and macOS CI jobs actually pass.
- [ ] Codex laptop sleep/wake while idle, while a turn runs, and with approval pending.
- [ ] Claude laptop sleep/wake while idle, while a turn runs, and with approval pending.
- [ ] Fresh-user Telegram onboarding using the current pairing wizard.
- [x] Real isolated transport offline/online recovery with Telegram unreachable.
- [x] Real daemon restart while a managed terminal turn is running.
- [ ] Credential expiry and renewal using the deployment's actual auth method.
- [ ] Current release daemon installed/reloaded safely and confirmed healthy.
- [ ] Existing provider daemon/terminals reopened when safe after upgrades.
- [x] Existing private Telegram group, topic permissions and numeric allowlists verified.
- [x] `.env`, logs and state excluded from package artifacts.
- [ ] Bot token rotated if previously exposed; verify shared Telegram memberships/admins.
- [ ] Temporary live-test topics removed when their history is no longer needed.

The four recorded live-test topics were deleted together with their bridge
history. Project files and native session history were preserved. One separate
Claude topic-creation attempt returned an uncertain network error before an ID
was received; the owner must inspect Telegram for an extra “Claude bridge E2E”
topic before this final cleanup gate can be checked. No blind retry or broad
topic deletion was performed.

Hosted CI awaits approved source publication to joinotto/local-code-link.
Token rotation requires the owner
to use BotFather if the token exposed earlier has not already been replaced.
Never paste the replacement into chat; enter it at the hidden CLI prompt.

## Not in this release

Retroactive attachment to arbitrary plain terminals, MCP elicitation forms,
Claude sandbox network prompts that do not fire supported hooks, multi-tenant
operation, exactly-once Telegram message delivery, and universal provider/OS
compatibility. These require separate work; they are not silently approved or
advertised as verified.

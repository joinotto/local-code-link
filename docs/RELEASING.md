# Release preparation

LocalCodeLink is a release candidate. npm publication remains disabled through
`private: true`; no publishing workflow or trusted-publisher configuration is
claimed. Repository publication and npm publication are separate actions.

## Current preview

[Version 0.9.2](https://github.com/joinotto/local-code-link/releases/tag/v0.9.2)
is published from `ac56ebeb2f228911cc16070325a48d5cdebc2446` with an inspected
archive and SHA-256 checksum. See [installation/upgrades](UPGRADING.md) for
end-user steps and [release acceptance](RELEASE_CHECKLIST.md) for verification
and remaining deployment gates.

## Review the source

1. Run `npm ci`, `npm test`, `npm audit --omit=dev --audit-level=high`,
   `npm run check:release` and `npm run test:package`.
2. Inspect `npm pack --dry-run --json` and the actual archive. Include LICENSE,
   NOTICE, runtime code and integrations; exclude credentials, state, logs and
   private `.opensource/` artifacts.
3. Review README installation instructions, supported platforms and
   RELEASE_CHECKLIST.md. Mark only observed results as verified.
4. Inspect the exact public file list before committing. This working directory
   originally belonged to a larger parent repository; do not include siblings or
   private parent history in the standalone repository.
5. With owner approval, publish reviewed source to `joinotto/local-code-link`
   through a pull request. `main` requires passing macOS/Linux checks and prohibits
   direct pushes, force-pushes and deletion, including for administrators.
   Reviews are optional; maintainers can merge their own PR after required checks.
   Keep PRs up to date, resolve review conversations, and use squash merge.
6. Private vulnerability reporting, secret scanning/push protection and Dependabot
   security updates are enabled. The owner must monitor incoming reports and
   periodically review the account-side configuration.

The intended repository is https://github.com/joinotto/local-code-link.
GitHub configuration files do not themselves enable account protections.

## Distribute an archive

After source and hosted checks are reviewed, run `npm pack`. With separate
approval, attach the inspected archive and its SHA-256 checksum to a GitHub
preview release. Use a preview label; the archive version does not prove
production readiness.

Build from the exact reviewed commit and require its merged-main CI to pass.
Test the exact checksummed archive in an isolated install. Upload the archive
and checksum as a draft, download them and verify byte equality before publishing.
Check the public download and confirm the tag points to the tested commit.

Treat published tags and release archives as immutable. Do not replace the
0.9.1 or 0.9.2 archives or move their tags for a later fix. Runtime/package changes need a new
version and new verification. Documentation-only corrections can land through
a protected PR without republishing an existing archive.

Smoke-test the exact distributed archive on a clean machine with the recipient's
own Telegram bot and authenticated Claude/Codex CLI. The macOS helper permissions
require install scripts; do not document an `--ignore-scripts` runtime install.

## npm publication later

Do not remove `private: true` merely to make a check pass. Enabling npm publication
requires an approved change that selects the public package name/version/tag,
verifies npm ownership and account protections, and implements a reviewed release
workflow. No npm token, OTP, account setup or publication is needed for source or
local-tarball use.

Do not stage, approve or publish packages without explicit authority. An npm
staging operation can itself change public state. Never ask users to paste
credentials or OTPs into chat.

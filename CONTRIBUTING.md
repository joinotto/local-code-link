# Contributing

Discuss large changes first. Keep pull requests focused and add tests for behavior
changes. LocalCodeLink is a JavaScript ESM CLI; no TypeScript build is required.

## Development

Use Node.js 22.22.0 for the verified development environment.

```sh
git clone https://github.com/joinotto/local-code-link.git
cd local-code-link
npm ci
npm test
npm run check:release
npm run test:package
```

For local CLI development, `npm link` exposes this checkout's launcher. End users
can use the single-line GitHub archive installation in README.md.

`npm run test:install` installs the real public source archive into an isolated
temporary global prefix. It does not change your real global install or bot.

The regression suite uses local Unix sockets. Run it on a machine/container that
allows these fixtures; sandbox permission errors are not successful test results.
The package test installs a real archive into an isolated temporary directory.
Neither command needs your Telegram bot or provider account.

Live tests need authenticated provider CLIs and may create temporary projects or
Telegram topics. Read docs/RELEASE_CHECKLIST.md first. Do not restart another user's
service, interrupt unrelated sessions, or sleep a machine without coordination.

## Pull requests

`main` requires an up-to-date PR with passing macOS/Linux checks and resolved
conversations. Force-pushes and deletion are prohibited, including for admins.
Maintainers can merge their own PR after CI; another review is encouraged but
not required. Use squash merge; do not bypass required checks.

- Describe the scope, reason, verification commands and missing checks.
- Add regression coverage for project isolation, approvals and recovery changes.
- Do not commit credentials, private data or development evidence.
- Use your actual author identity and `git commit -s` for DCO certification.
  Human contributors remain responsible for generated code.
- Retain required third-party notices and the Apache-2.0 license.

See https://developercertificate.org/ for the DCO. A signoff must be the real
contributor's certification; it is not an invented maintainer approval.

Report vulnerabilities privately as described in SECURITY.md, not in a public
issue. See docs/CONVENTIONS.md for repository conventions.

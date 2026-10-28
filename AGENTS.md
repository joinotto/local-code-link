# Project instructions

LocalCodeLink is a Node.js ESM CLI and local daemon, not a TypeScript SDK.
Preserve existing work and implement only the requested scope.

Run `npm test` after code changes. Before a distribution change, run
`npm run check:release` and `npm run test:package`. These checks do not replace
live Claude/Codex or hardware acceptance in docs/RELEASE_CHECKLIST.md.

Keep native provider permission checks enabled. Never automatically approve
requests, introduce competing session writers, or weaken project/user isolation.
Use isolated fixtures; do not interrupt unrelated user sessions.
Never print or commit tokens, credentials, transcripts, private state or evidence.
Store private development artifacts under ignored `.opensource/`.

Keep maintained product documentation under docs/. Preserve the root security
policy and actual license/third-party notices. Use truthful status; never invent
reviews, signoffs, hosted CI results or production acceptance.

Do not create repositories, change account settings, push, stage or publish
without authorization. npm publication remains disabled.

<!-- postman-cli:installation:start -->
Postman CLI is installed on this device, and can be used for API Engineering work.
<!-- postman-cli:installation:end -->

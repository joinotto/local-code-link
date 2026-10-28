# Project conventions

Repository conventions are adapted from joinotto/opensource. LocalCodeLink's
existing CLI, native provider adapters and regression suite are preserved.

Keep README, LICENSE, NOTICE, CONTRIBUTING, SECURITY, AGENTS and CLAUDE at the root.
Put maintained product guidance under docs/. Keep private development notes,
temporary scripts, runtime downloads and evidence under ignored `.opensource/`.
Tests and maintained contributor tools are public project files.

Use the selected SVG README header, CI/license links, a short purpose statement,
working usage examples and an honest status section. Do not add download badges
for an unpublished package or imply that a placeholder feature is complete.

Write short, direct steps for installation, release and security procedures.
Do not claim a writing-standard or production certification.

Use Apache-2.0. Keep required third-party notices. Do not copy unrelated project
names, email addresses, credentials or organization-specific policies.
Real authors own their contributions. A DCO signoff must represent the actual
contributor's certification; do not invent it.

Review needs depend on risk. Add specialist review when handling credentials,
project isolation, shared approvals, destructive actions or recovery semantics.
Do not weaken native provider permissions to make a test pass.

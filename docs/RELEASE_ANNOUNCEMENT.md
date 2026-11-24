# LocalCodeLink 0.9.3 preview

Codex startup timeouts now explain when the shared socket link points to a
missing file and how to recover safely. This can block new Telegram connections
while existing Codex sessions remain connected.

This is a diagnostic improvement. It does not automatically repair or restart
the daemon. Finish or save work in all shared sessions before following the
[recovery instructions](TROUBLESHOOTING.md).

## Install or upgrade

```sh
npm install --global https://github.com/joinotto/local-code-link/releases/download/v0.9.3/local-code-link-0.9.3.tgz
```

Existing users should finish pending bridge work and follow the
[upgrade guide](UPGRADING.md), using the same npm prefix and reloading the bridge.
Already-running installations do not automatically receive the patch.
No reset, project migration or Telegram re-pairing is required.

[Release and checksum](https://github.com/joinotto/local-code-link/releases/tag/v0.9.3)

This remains a preview. Automated distribution checks do not constitute live
Telegram, native provider or hardware acceptance. npm registry publication
remains disabled.

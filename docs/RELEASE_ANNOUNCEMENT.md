# LocalCodeLink 0.9.5 preview

Keep your existing Codex conversation linked to Telegram, including persistent
threads with paginated history. LocalCodeLink reads replies through Codex's shared
daemon APIs, preserving the same thread and earlier context. No `/new` or history
conversion is required for these conversations.

Replies are correlated with the submitted request across history pages and
reconnects. Recovery does not resend uncertain submissions, and the completion
hook leaves result delivery to the bridge to avoid duplicate replies. Native
permission handling and project/topic/session isolation remain enabled.

## Install or upgrade

```sh
npm install --global https://github.com/joinotto/local-code-link/releases/download/v0.9.5/local-code-link-0.9.5.tgz
```

Existing users should finish pending bridge work and follow the
[upgrade guide](UPGRADING.md), using the same npm prefix and reloading the bridge.
Already-running installations do not automatically receive the patch.
No reset, project migration or Telegram re-pairing is required.

[Release and checksum](https://github.com/joinotto/local-code-link/releases/tag/v0.9.5)

An isolated live Codex conversation retained earlier context and returned a queued
reply in the same paginated thread. This did not test actual Telegram delivery.
This remains a preview; automated distribution checks and isolated provider tests
are not full production or hardware acceptance. npm registry publication remains
disabled.

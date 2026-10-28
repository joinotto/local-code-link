---
description: Link the current Claude Code project to its Telegram topic
allowed-tools: Bash
---

Link the current working project to LocalCodeLink Telegram by running:

```bash
local-code-link claude --link-only
```

Report the project, folder, provider, Telegram topic ID, and whether its mapping
was reused. Do not send a coding prompt or modify project files. This saves the
mapping without starting a nested session. Shared terminal control requires
reopening a plain session through `local-code-link claude`.

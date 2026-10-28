---
name: local-code-link
description: Link the current Codex project to its LocalCodeLink Telegram topic.
---

# Link Current Codex Project to Telegram

Run this command in the current project directory:

```bash
local-code-link codex --link-only
```

Report the project, canonical folder, provider, Telegram topic ID, and whether
the existing mapping was reused. Do not send a coding prompt or modify project
files. This saves the mapping without starting a nested session. A plain session
must be reopened through `local-code-link codex` for shared terminal control;
do not claim that linking alone attaches an already-running plain session.

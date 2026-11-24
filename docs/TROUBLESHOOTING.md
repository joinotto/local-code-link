# Troubleshooting

## Codex startup times out from Telegram

LocalCodeLink waits up to 30 seconds for `codex app-server daemon start`.
It does not automatically stop or restart the shared Codex daemon.

Check connectivity with the same Codex executable configured as `CODEX_BIN`:

```sh
codex app-server daemon version
```

If LocalCodeLink reports that the shared socket link points to a missing file,
the socket endpoint is unavailable. A daemon process can still be running and
serving already-connected sessions while new connections fail. Re-pairing
Telegram or relinking every project does not repair that endpoint.

Save or finish work in **all sessions using the shared Codex daemon** before
recovery. When it is safe to interrupt those sessions, run:

```sh
codex app-server daemon restart
codex app-server daemon version
```

After the version check succeeds, reopen affected terminals as needed and retry
the Telegram instruction that failed during startup. Do not resend instructions
that were already accepted or whose submission status is uncertain.

If work is still active, leave the daemon running and defer recovery. Do not
delete daemon PID files, locks, or socket links to force a second server.

# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app.

This package installs a `Stop` hook into the Windows Codex profile and sends one app-level WakaTime heartbeat for each completed assistant turn with a non-empty message body.

## Scope

- Codex desktop app
- WSL-first setup
- Windows WakaTime CLI

## Commands

```bash
node ./bin/codex-app-wakatime.js install
node ./bin/codex-app-wakatime.js status
node ./bin/codex-app-wakatime.js test
```

## Notes

- The generated Codex hook command uses the WSL `node` binary, so it does not need the Windows `node.exe` popup path that broke earlier.
- Heartbeats are sent with the plugin string `codex-app/1.0.0 codex-app-wakatime/0.1.0`.
- The hook always returns valid `Stop` JSON, even when WakaTime is unavailable.

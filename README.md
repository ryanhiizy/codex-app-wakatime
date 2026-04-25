# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app.

This package installs a `Stop` hook into the Windows Codex profile and sends a WakaTime heartbeat for each completed assistant turn with a non-empty message body. It sends file heartbeats when files can be detected from the assistant output, otherwise it falls back to an app heartbeat.

## Scope

- Codex desktop app
- WSL-first setup
- Windows WakaTime CLI

## Commands

```bash
node ./bin/codex-app-wakatime.js install
node ./bin/codex-app-wakatime.js uninstall
node ./bin/codex-app-wakatime.js status
node ./bin/codex-app-wakatime.js test
```

## Notes

- The generated Codex hook command uses the WSL `node` binary, so it does not need the Windows `node.exe` popup path that broke earlier.
- Heartbeats are sent with the plugin string `codex/1.0.0 codex-app-wakatime/0.1.0`.
- File paths are extracted from assistant output and sent as file heartbeats when possible.
- Git worktree paths are canonicalised through `git worktree list --porcelain`, so Codex worktrees can still attribute activity to the primary project when Git exposes that relationship.
- A local state file keeps a 60-second heartbeat throttle outside the WakaTime CLI.
- The hook always returns valid `Stop` JSON, even when WakaTime is unavailable.

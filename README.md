# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app.

> This package is for the Codex desktop app, not the standalone Codex CLI.

## What It Does

- Installs Codex desktop app `PostToolUse` and `Stop` hooks.
- Records files edited by Codex `apply_patch`, `Edit`, and `Write` tool calls during a turn.
- Sends WakaTime heartbeats after completed assistant turns.
- Attributes activity to the edited files when Codex exposes them through hook payloads.
- Falls back to project-level app activity when no file path is available.

> All Codex assistant activity is tracked. When there is no detected file edit, WakaTime may show that activity as project-level `Other` time.

## File Attribution

`PostToolUse` hooks only collect edited files from structured write-tool payloads. The `Stop` hook sends the heartbeat at the end of the turn using the files remembered for that turn.

This intentionally ignores broad assistant text scraping, shell command output, package-manager side effects, formatters, generated files, and files created by external tools. Those cases still count as Codex activity, but they are attributed to the project instead of a large guessed file list.

## Prerequisites

- Node.js 18 or newer.
- Codex desktop app with hook support.
- WakaTime installed and configured before installing this package.
- A working WakaTime config at `~/.wakatime.cfg` or `C:\Users\<user>\.wakatime.cfg`.

WakaTime CLI lookup:

| Environment | CLI path |
| --- | --- |
| Windows + WSL | `WAKATIME_CLI_PATH` or `/mnt/c/Users/<user>/.wakatime/wakatime-cli-windows-amd64.exe` |
| macOS/native Linux | `WAKATIME_CLI_PATH`, `~/.wakatime/wakatime-cli`, `~/.wakatime/wakatime-cli-<platform>-<arch>`, or `wakatime-cli` on `PATH` |

> For Codex installed on Windows but working on a project inside WSL, install and configure WakaTime on Windows. The hook runs from WSL but sends heartbeats through the Windows WakaTime CLI.

## Install

```bash
npm install -g codex-app-wakatime
codex-app-wakatime install
```

Restart Codex after installing or changing hooks.

If the installer cannot validate paths but `status` or `test` shows WakaTime is working, you can install without validation:

```bash
codex-app-wakatime install --skip-checks
```

### Existing Hooks

Install keeps existing hooks from other tools, replaces any previous `codex-app-wakatime` entry, and backs up the previous hook file to `hooks.json.bak`.

## Commands

| Command | Purpose |
| --- | --- |
| `codex-app-wakatime install` | Add the Codex `PostToolUse` and `Stop` hooks. |
| `codex-app-wakatime uninstall` | Remove only this package's Codex hook entries. |
| `codex-app-wakatime status` | Print hook, log, state, WakaTime CLI, and installed command paths. |
| `codex-app-wakatime doctor` | Check that WakaTime CLI/config paths are available. |
| `codex-app-wakatime test [path]` | Send one project heartbeat for the current directory or optional path. |

## Files Written

macOS/native Linux:

| File | Purpose |
| --- | --- |
| `~/.codex/hooks.json` | Codex hook configuration. |
| `~/.codex/codex-app-wakatime.log` | Hook debug log. |
| `~/.wakatime/codex-app-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |

Windows Codex working on a WSL project:

| File | Purpose |
| --- | --- |
| `/mnt/c/Users/<user>/.codex/hooks.json` | Windows Codex hook configuration. |
| `/mnt/c/Users/<user>/.codex/codex-app-wakatime.log` | Hook debug log. |
| `/mnt/c/Users/<user>/.wakatime/codex-app-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |

## Troubleshooting

```bash
codex-app-wakatime status
codex-app-wakatime test
```

If `test` reports `missing_wakatime_cli`, install or initialize WakaTime first, or set:

```bash
export WAKATIME_CLI_PATH=/absolute/path/to/wakatime-cli
```

On WSL, set this if Windows profile detection picks the wrong user:

```bash
export WAKATIME_WINDOWS_HOME='C:\Users\YourName'
```

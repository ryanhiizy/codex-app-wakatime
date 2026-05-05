# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app.

> This package is for the Codex desktop app, not the standalone Codex CLI.

## What It Does

- Installs a Codex desktop app `Stop` hook.
- Sends a WakaTime heartbeat after completed assistant turns.
- Attributes activity to files and projects when Codex output includes detectable file paths.
- Falls back to project-level app activity when no file path is available.

> All Codex assistant activity is tracked. When there is no file edit or detectable file path, WakaTime may show that activity as `Other`.

## Prerequisites

- Node.js 18 or newer.
- Codex desktop app with hook support.
- WakaTime installed and configured before installing this package.
- A working WakaTime config at `~/.wakatime.cfg` or `C:\Users\<user>\.wakatime.cfg`.

WakaTime CLI lookup:

| Environment | CLI path |
| --- | --- |
| Windows + WSL | `/mnt/c/Users/<user>/.wakatime/wakatime-cli-windows-amd64.exe` |
| macOS/native Linux | `WAKATIME_CLI_PATH`, `~/.wakatime/wakatime-cli`, `~/.wakatime/wakatime-cli-<platform>-<arch>`, or `wakatime-cli` on `PATH` |

> For Codex installed on Windows but working on a project inside WSL, install and configure WakaTime on Windows. The hook runs from WSL but sends heartbeats through the Windows WakaTime CLI.

## Install

```bash
npm install -g codex-app-wakatime
codex-app-wakatime install
```

Restart Codex after installing or changing hooks.

### Existing Hooks

Install keeps existing hooks from other tools, replaces any previous `codex-app-wakatime` entry, and backs up the previous hook file to `hooks.json.bak`.

## Commands

| Command | Purpose |
| --- | --- |
| `codex-app-wakatime install` | Add the Codex `Stop` hook. |
| `codex-app-wakatime uninstall` | Remove only this package's Codex hook entry. |
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

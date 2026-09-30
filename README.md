# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app and Cursor on macOS, native Linux, Windows, and WSL.

> Codex integration requires the desktop app with hook support, not the standalone Codex CLI. Cursor integration tracks Agent activity.

## What It Does

- Installs Codex desktop app `PostToolUse` and `Stop` hooks, or Cursor `afterFileEdit` and `stop` hooks.
- Records files edited by Codex `apply_patch`, `Edit`, and `Write` tool calls during a turn.
- Sends WakaTime heartbeats after completed assistant turns.
- Attributes activity to the edited files when Codex exposes them through hook payloads.
- Falls back to project-level app activity when no file path is available.

> All Codex assistant activity is tracked. When there is no detected file edit, WakaTime may show that activity as project-level `Other` time.

## Prerequisites

- Node.js 18 or newer.
- Codex desktop app or Cursor with hook support.
- WakaTime installed and configured before installing this package.
- A working WakaTime config at `~/.wakatime.cfg` or `C:\Users\<user>\.wakatime.cfg`.

WakaTime CLI lookup:

| Environment | CLI path |
| --- | --- |
| Windows + WSL | `WAKATIME_CLI_PATH` or `/mnt/c/Users/<user>/.wakatime/wakatime-cli-windows-amd64.exe` |
| macOS | `WAKATIME_CLI_PATH`, `wakatime-cli` on `PATH`, Homebrew paths, then `~/.wakatime/wakatime-cli` or the Darwin binary |
| Native Linux | `WAKATIME_CLI_PATH`, `wakatime-cli` on `PATH`, then `~/.wakatime/wakatime-cli` or `~/.wakatime/wakatime-cli-linux-<arch>` (`amd64`, `arm64`, `386`, or `arm`) |

> For Codex installed on Windows but working on a project inside WSL, install and configure WakaTime on Windows. The hook runs from WSL but sends heartbeats through the Windows WakaTime CLI.

## Install

```bash
npm install -g codex-app-wakatime
codex-app-wakatime install
```

For Cursor:

```bash
codex-app-wakatime install --app cursor
codex-app-wakatime doctor --app cursor
```

Run both install commands to track both apps. Codex is the default; use `--app cursor` with `install`, `uninstall`, `status`, `doctor`, or `test` to select Cursor. Each app has separate heartbeat state and edited-file queues.

On native Linux, use a Linux WakaTime CLI and a local `~/.wakatime.cfg`; Windows mounts and WSL are not required. This package uses the installed app's hook support.

Restart Codex after installing or changing hooks. Cursor reloads its hook configuration automatically ([Cursor hooks documentation](https://cursor.com/docs/hooks)).

### Existing Hooks

Install keeps existing hooks from other tools, replaces any previous `codex-app-wakatime` entry for the selected app, and backs up the previous hook file to `hooks.json.bak`. Invalid JSON is reported without overwriting the hook file.

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
| `~/.codex/codex-app-wakatime.log` | Hook debug log, only written when debug logging is enabled. |
| `~/.wakatime/codex-app-wakatime.config.json` | Package config. |
| `~/.wakatime/codex-app-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |
| `~/.wakatime/codex-app-wakatime-turns/*.jsonl` | Temporary per-turn edited-file queues used to keep edit hooks lightweight. |

Windows Codex working on a WSL project:

| File | Purpose |
| --- | --- |
| `/mnt/c/Users/<user>/.codex/hooks.json` | Windows Codex hook configuration. |
| `/mnt/c/Users/<user>/.codex/codex-app-wakatime.log` | Hook debug log, only written when debug logging is enabled. |
| `~/.wakatime/codex-app-wakatime.config.json` | Package config. |
| `/mnt/c/Users/<user>/.wakatime/codex-app-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |
| `~/.wakatime/codex-app-wakatime-turns/*.jsonl` | Temporary per-turn edited-file queues used to keep edit hooks lightweight without writing through `/mnt/c` on every edit. |

Cursor on macOS/native Linux uses `~/.cursor/hooks.json` and `~/.cursor/codex-app-wakatime.log`. Its heartbeat state is `~/.wakatime/cursor-app-wakatime.json`, and its edited-file queue is `~/.wakatime/cursor-app-wakatime-turns/`. The package config is shared. On Windows/WSL, Cursor follows the same host-profile rules as Codex, using `.cursor` in place of `.codex`.

Hook commands retain the selected WakaTime CLI/config paths, so explicit install overrides also apply when the app invokes the hook. Use `--cursor-hooks /path/to/hooks.json` to override Cursor's hooks file.

## Config

Install creates the config file at `~/.wakatime/codex-app-wakatime.config.json`:

```json
{
  "debug": false,
  "maxFileHeartbeats": 30
}
```

- `debug`: set to `true` to write hook debug logs. It is `false` by default.
- `maxFileHeartbeats`: caps how many edited-file heartbeats are sent per completed turn. The default is `30`.

## Troubleshooting

AI transcript tracking stays enabled (`sync_ai_disabled = false`). Codex hooks
identify the agent and desktop editor separately so direct activity and imported
transcripts can both appear as **Codex App**. Codex turns run transcript sync once,
then send direct heartbeats without parsing the same transcripts again. The
`--sync-ai-disabled` flag applies only to that direct send; transcript sync runs
separately and the global setting stays enabled. Existing records keep their original
labels. Other editor plugins and older installations can still contribute their
own labels, so update the integration on each computer you use.

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

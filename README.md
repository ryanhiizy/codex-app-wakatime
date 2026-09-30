# codex-app-wakatime

WakaTime heartbeats for the Codex desktop app on macOS, native Linux, Windows, and WSL.

> This package is for the Codex desktop app, not the standalone Codex CLI.

## What It Does

- Installs Codex desktop app `PostToolUse` and `Stop` hooks.
- Records files edited by Codex `apply_patch`, `Edit`, and `Write` tool calls during a turn.
- Sends WakaTime heartbeats after completed assistant turns.
- Attributes activity to the edited files when Codex exposes them through hook payloads.
- Falls back to project-level app activity when no file path is available.

> All Codex assistant activity is tracked. When there is no detected file edit, WakaTime may show that activity as project-level `Other` time.

## Prerequisites

- Node.js 18 or newer.
- Codex desktop app with hook support.
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

On native Linux, use a Linux WakaTime CLI and a local `~/.wakatime.cfg`; Windows mounts and WSL are not required. This package uses the installed app's hook support.

Restart Codex after installing or changing hooks.

### Existing Hooks

Install keeps existing hooks from other tools, replaces any previous `codex-app-wakatime` entry, and backs up the previous hook file to `hooks.json.bak`. Invalid JSON is reported without overwriting the hook file.

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

Hook commands retain the selected WakaTime CLI/config paths, so explicit install overrides also apply when the app invokes the hook.

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
separately and the global setting stays enabled. If standalone sync fails, the
direct send falls back to WakaTime's normal transcript parsing. Existing records keep their original
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

## Development

This package has no runtime dependencies. Run the checks from a source checkout:

```bash
npm run check
npm test
npm pack --dry-run
```

CI runs the suite on Linux, macOS, and Windows with Node 18, 22, and 24. To also
exercise an installed WakaTime CLI against a local HTTP server, set
`WAKATIME_TEST_CLI_PATH` to its absolute path when running `npm test`. That test uses
a temporary home, synthetic transcripts, and a dummy API key; it never sends to
your WakaTime account. It verifies transcript import, batch metadata, custom
project names, offline queue delivery, and new worktree files.

The source is split by responsibility:

| Module | Responsibility |
| --- | --- |
| `src/cli.js` | Commands, hook protocol, installation, and turn orchestration |
| `src/platform.js` | CLI discovery, shell commands, and native/WSL paths |
| `src/files.js` | Edit extraction, project roots, and worktree attribution |
| `src/config.js` | Configuration parsing and atomic writes |
| `src/state.js` | Rate limiting, edit queues, snapshot recovery, and cleanup |
| `src/wakatime.js` | Transcript sync, heartbeat batching, and process deadlines |

Edit hooks append to a local queue without launching WakaTime or Git. Stop hooks
claim a snapshot so later edits survive cleanup, retain failed sends for retry,
and recognize queues written by older versions. Dead-process snapshots recover
on the next stop for that turn. WakaTime may also buffer successful sends in its
own offline queue under its normal upload rate limit.

Files in the same project are sent in one CLI invocation using
`--extra-heartbeats`. A new worktree file that does not yet exist in the primary
checkout gets its own invocation with `--local-file`, preserving canonical project
attribution. The default 30-file cap and 60-second duplicate suppression remain.
WakaTime subprocesses share a 25-second budget to leave time for the hook response.

`node scripts/benchmark.cjs [checkout-path]` measures a synthetic 30-file stop on
macOS/Linux, including Node startup and real process launches, with a fake CLI and
no network. On the development Mac, the median of seven runs fell from about
113 ms to 39 ms, and CLI launches fell from 31 to 2 compared with `c464803`.
These figures measure hook overhead; real transcript parsing, disk, and network
costs depend on the installed WakaTime CLI and session history.

Installed commands use the absolute Node executable and retain path overrides,
including the WakaTime log. Re-run `install` after moving Node or this package.

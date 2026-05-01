# codex-app-wakatime

WakaTime tracking for the Codex desktop app.

## Install

Clone the repo, then run one command:

```bash
npm run setup
```

Setup auto-detects macOS, Windows, or WSL and installs the Codex hook.

## Verify

```bash
npm run status
npm run test:heartbeat
```

`test:heartbeat` should return `"ok": true`.

## What It Tracks

- Codex assistant turns through the Codex `Stop` hook.
- File activity when Codex mentions real files inside the current project.
- App activity when no project file can be safely detected.

WakaTime currently shows this integration as `Codex-App`.

## Commands

- `npm run setup` installs the hook.
- `npm run doctor` checks the setup.
- `npm run status` shows the installed config.
- `npm run test:heartbeat` sends one test heartbeat.
- `node ./bin/codex-app-wakatime.js uninstall` removes the hook.

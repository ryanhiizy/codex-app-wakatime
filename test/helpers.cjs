const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const bin = path.resolve(__dirname, "../bin/codex-app-wakatime.js");

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-test-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(home, "wakatime-cli");
  const capture = path.join(home, "calls.jsonl");
  const config = path.join(home, ".wakatime.cfg");
  const settings = path.join(home, "config.json");
  fs.writeFileSync(binary, "");
  fs.writeFileSync(config, "[settings]\nsync_ai_disabled = false\n");
  fs.writeFileSync(settings, '{"debug":false,"maxFileHeartbeats":30}');
  const env = { ...process.env, WAKATIME_FAKE_CLI: binary, WAKATIME_CAPTURE: capture,
    NODE_OPTIONS: `--require ${JSON.stringify(path.resolve(__dirname, "fixtures/mock-wakatime.cjs"))}` };
  delete env.CODEX_WAKATIME_EDITOR;
  delete env.CODEX_WAKATIME_PLUGIN;
  const options = ["--home", home, "--wakatime-cli", binary, "--wakatime-config", config,
    "--wakatime-log", path.join(home, "wakatime.log"),
    "--codex-hooks", path.join(home, "hooks.json"),
    "--state-file", path.join(home, "state.json"), "--turn-files-dir", path.join(home, "turns"),
    "--config-file", settings, "--codex-log", path.join(home, "hook.log")];
  const run = (args, payload, extraEnv) => spawnSync(process.execPath, [bin, ...args, ...options], {
    encoding: "utf8", input: payload === undefined ? undefined : JSON.stringify(payload),
    env: { ...env, ...extraEnv },
  });
  const calls = () => fs.existsSync(capture)
    ? fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { home, binary, capture, config, settings, env, options, run, calls };
}
module.exports = { fixture, bin };

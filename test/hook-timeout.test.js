const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("a timed-out transcript scan reserves time for fallback and a valid Stop response", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-timeout-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(home, "fake-wakatime");
  const capture = path.join(home, "calls.jsonl");
  const config = path.join(home, ".wakatime.cfg");
  fs.writeFileSync(binary, "");
  fs.writeFileSync(config, "[settings]\nsync_ai_disabled = false\n");
  fs.writeFileSync(path.join(home, "config.json"), '{"debug":false}');
  for (const directTimeout of ["false", "true"]) {
    fs.writeFileSync(capture, "");
    fs.rmSync(path.join(home, "state.json"), { force: true });
    const env = { ...process.env, WAKATIME_FAKE_CLI: binary, WAKATIME_CAPTURE: capture,
      WAKATIME_DIRECT_TIMEOUT: directTimeout,
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "fixtures/timeout-wakatime.cjs"))}` };
    delete env.CODEX_WAKATIME_EDITOR;
    delete env.CODEX_WAKATIME_PLUGIN;
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/codex-app-wakatime.js"),
      "hook", "--home", home, "--wakatime-cli", binary, "--wakatime-config", config,
      "--wakatime-log", path.join(home, "wakatime.log"), "--config-file", path.join(home, "config.json"),
      "--state-file", path.join(home, "state.json"), "--turn-files-dir", path.join(home, "turns"),
      "--codex-log", path.join(home, "hook.log"),
    ], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "Stop", cwd: home }), env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    const [sync, fallback] = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(sync.timeout, 10000);
    assert.equal(fallback.timeout, 15000);
    assert.equal(sync.timeout + fallback.timeout, 25000);
    assert.ok(fallback.args.includes("--entity"));
    assert.equal(fallback.args.includes("--sync-ai-disabled"), false);
    assert.match(fallback.args[fallback.args.indexOf("--plugin") + 1], /^codex-app\//);
  }
  assert.match(fs.readFileSync(config, "utf8"), /sync_ai_disabled = false/);
});

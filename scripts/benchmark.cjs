// Synthetic POSIX benchmark: real hook process and lightweight fake CLI, no network.
// Pass another checkout to compare the same fixture across revisions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { quotePosixShellArg } = require("../src/platform");
if (process.platform === "win32") throw new Error("This benchmark requires a POSIX shell.");
const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-bench-"));
const capture = path.join(home, "calls");
const binary = path.join(home, "fake-wakatime");
const queue = path.join(home, "turns");
const project = path.join(home, "project");
fs.mkdirSync(queue);
fs.mkdirSync(project);
fs.writeFileSync(binary, `#!/bin/sh\nprintf 'call\\n' >> ${quotePosixShellArg(capture)}\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(home, ".wakatime.cfg"), "[settings]\nsync_ai_disabled = false\n");
fs.writeFileSync(path.join(home, "config.json"), '{"debug":false,"maxFileHeartbeats":30}');
const files = Array.from({ length: 30 }, (_, i) => ({ path: path.join(project, `file-${i}.js`), isWrite: true }));
files.forEach((file) => fs.writeFileSync(file.path, "module.exports = 1;\n"));
const samples = [];
const env = { ...process.env };
delete env.CODEX_WAKATIME_EDITOR;
delete env.CODEX_WAKATIME_PLUGIN;
try {
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(capture, "");
    fs.writeFileSync(path.join(home, "state.json"), "{}");
    fs.writeFileSync(path.join(queue, `${Buffer.from("session:turn").toString("base64url")}.jsonl`), `${JSON.stringify({ files })}\n`);
    const start = performance.now();
    const result = spawnSync(process.execPath, [path.join(root, "bin/codex-app-wakatime.js"), "hook",
      "--home", home, "--wakatime-cli", binary, "--wakatime-config", path.join(home, ".wakatime.cfg"),
      "--state-file", path.join(home, "state.json"), "--turn-files-dir", queue,
      "--config-file", path.join(home, "config.json"), "--wakatime-log", path.join(home, "wakatime.log"),
    ], { input: JSON.stringify({ hook_event_name: "Stop", session_id: "session", turn_id: "turn", cwd: project }), encoding: "utf8", env });
    if (result.status !== 0) throw new Error(result.stderr);
    samples.push({ ms: performance.now() - start,
      cliCalls: fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).length });
  }
  console.log(JSON.stringify({ root, samples, medianMs: samples.map((sample) => sample.ms).sort((a, b) => a - b)[3] }, null, 2));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

const fs = require("node:fs");
const { createWakatime } = require("../../src/wakatime");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const result = createWakatime(() => input.paths, () => ({ maxFileHeartbeats: 30 }), console.error)
  .sendTurn(input.files, input.project);
// A recent transcript upload intentionally queues the direct batch under WakaTime's
// own rate limit. Flush that fixture queue so the test can inspect every record now.
if (result.ok) {
  const flushed = require("node:child_process").spawnSync(input.paths.wakatimeCli, [
    "--sync-offline-activity", "0", "--heartbeat-rate-limit-seconds", "0", "--sync-ai-disabled",
    "--config", input.paths.wakatimeConfig, "--log-file", input.paths.wakatimeLog,
  ], { encoding: "utf8", timeout: 10000 });
  if (flushed.status !== 0) throw new Error(flushed.stderr || String(flushed.error));
}
process.stdout.write(JSON.stringify(result));

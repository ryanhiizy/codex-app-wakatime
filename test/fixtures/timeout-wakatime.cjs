// Deterministic clock + CLI stub: consume each requested process timeout instantly.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const original = childProcess.spawnSync;
let now = 1790000000000;
Date.now = () => now;
childProcess.spawnSync = function (command, args, options) {
  if (command !== process.env.WAKATIME_FAKE_CLI) return original.apply(this, arguments);
  fs.appendFileSync(process.env.WAKATIME_CAPTURE, `${JSON.stringify({ args, timeout: options.timeout })}\n`);
  now += options.timeout;
  if (args.includes("--sync-ai-activity") || process.env.WAKATIME_DIRECT_TIMEOUT === "true") {
    return { status: null, error: Object.assign(new Error("simulated timeout"), { code: "ETIMEDOUT" }) };
  }
  return { status: 0, stdout: "", stderr: "" };
};

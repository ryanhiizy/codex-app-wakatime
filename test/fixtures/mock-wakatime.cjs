// Loaded only by child hook processes in the integration tests.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const original = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (command !== process.env.WAKATIME_FAKE_CLI) return original.apply(this, arguments);
  fs.appendFileSync(process.env.WAKATIME_CAPTURE, `${JSON.stringify({ args, input: options?.input, timeout: options?.timeout })}\n`);
  const status = Number(args.includes("--sync-ai-activity")
    ? process.env.WAKATIME_SYNC_EXIT || 0 : process.env.WAKATIME_SEND_EXIT || 0);
  return { status, stdout: "", stderr: status ? "simulated failure" : "" };
};

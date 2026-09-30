const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const tests = fs.readdirSync(path.join(root, "test")).filter((name) => name.endsWith(".test.js"));
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...tests.map((name) => path.join(root, "test", name))], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

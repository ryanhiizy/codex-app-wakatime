const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) check(target);
    else if (/\.(?:c?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", target], { stdio: "inherit" });
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}
for (const directory of ["src", "bin", "test", "scripts"]) check(path.join(root, directory));

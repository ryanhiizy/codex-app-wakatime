const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fixture } = require("./helpers.cjs");
const { wslToUnc, toWindowsWslPath, resolveRuntimePaths, commandOrFileExists } = require("../src/platform");

test("WSL mounted-drive files use drive paths while Linux files use distro UNC paths", () => {
  assert.equal(wslToUnc("/mnt/c/Users/Ryan/project/a.js", "Ubuntu"), "C:\\Users\\Ryan\\project\\a.js");
  assert.equal(wslToUnc("/home/ryan/project/a.js", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\home\\ryan\\project\\a.js");
  assert.equal(toWindowsWslPath("D:/Users/Ryan/.wakatime.cfg"), "/mnt/d/Users/Ryan/.wakatime.cfg");
});

test("Cursor Windows state resolves beside the Codex state using Windows path semantics", () => {
  const paths = resolveRuntimePaths({ platform: "win32", app: "cursor",
    windowsHome: { win: "C:\\Users\\Ryan", wsl: "/mnt/c/Users/Ryan" } });
  assert.equal(paths.stateFile, "C:\\Users\\Ryan\\.wakatime\\cursor-app-wakatime.json");
  assert.equal(paths.turnFilesDir, "C:\\Users\\Ryan\\.wakatime\\cursor-app-wakatime-turns");
});

test("CLI setup rejects directories even when their names resemble executables", (t) => {
  const f = fixture(t);
  assert.equal(commandOrFileExists(f.home), false);
  assert.equal(commandOrFileExists(path.join(f.home, "missing")), false);
  assert.equal(commandOrFileExists(f.binary), true);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");

test("macos runtime uses native Codex and WakaTime paths", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-mac-home");
  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
    arch: "arm64",
  });

  assert.equal(paths.runtime, "macos");
  assert.equal(paths.codexHooks, path.join(home, ".codex", "hooks.json"));
  assert.equal(paths.wakatimeCli, path.join(home, ".wakatime", "wakatime-cli-darwin-arm64"));
  assert.equal(paths.wakatimeConfig, path.join(home, ".wakatime.cfg"));
  assert.equal(paths.stateFile, path.join(home, ".wakatime", "codex-app-wakatime.json"));
  assert.equal(cli.toHeartbeatPath("/Users/example/project/app.js", paths), "/Users/example/project/app.js");
});

test("wsl runtime keeps Windows WakaTime paths and converts heartbeat paths to UNC", () => {
  const paths = cli.resolveRuntimePaths({
    platform: "linux",
    isWsl: true,
    windowsHome: {
      win: "C:\\Users\\User",
      wsl: "/mnt/c/Users/User",
    },
    distro: "Ubuntu",
  });

  assert.equal(paths.runtime, "wsl");
  assert.equal(paths.codexHooks, "/mnt/c/Users/User/.codex/hooks.json");
  assert.equal(paths.wakatimeCli, "/mnt/c/Users/User/.wakatime/wakatime-cli-windows-amd64.exe");
  assert.equal(paths.wakatimeConfig, "C:\\Users\\User\\.wakatime.cfg");
  assert.equal(cli.toHeartbeatPath("/home/user/project/app.js", paths), "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\app.js");
});

test("wsl runtime accepts WAKATIME_CLI_PATH override", () => {
  const previous = process.env.WAKATIME_CLI_PATH;
  process.env.WAKATIME_CLI_PATH = "/custom/wakatime-cli";

  try {
    const paths = cli.resolveRuntimePaths({
      platform: "linux",
      isWsl: true,
      windowsHome: {
        win: "C:\\Users\\User",
        wsl: "/mnt/c/Users/User",
      },
    });

    assert.equal(paths.wakatimeCli, "/custom/wakatime-cli");
  } finally {
    if (previous === undefined) {
      delete process.env.WAKATIME_CLI_PATH;
    } else {
      process.env.WAKATIME_CLI_PATH = previous;
    }
  }
});

test("windows runtime uses native Windows paths", () => {
  const paths = cli.resolveRuntimePaths({
    platform: "win32",
    windowsHome: {
      win: "C:\\Users\\User",
      wsl: "/mnt/c/Users/User",
    },
  });

  assert.equal(paths.runtime, "windows");
  assert.equal(paths.codexHooks, "C:\\Users\\User\\.codex\\hooks.json");
  assert.equal(paths.wakatimeCli, "C:\\Users\\User\\.wakatime\\wakatime-cli-windows-amd64.exe");
  assert.equal(paths.wakatimeConfig, "C:\\Users\\User\\.wakatime.cfg");
});

test("auto runtime selects macos on darwin", () => {
  assert.equal(cli.detectRuntime({ platform: "darwin" }), "macos");
});

test("macos runtime accepts explicit path overrides", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-custom-home");
  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
    wakatimeCli: "/opt/homebrew/bin/wakatime-cli",
    codexHooks: path.join(home, "codex-hooks.json"),
  });

  assert.equal(paths.wakatimeCli, "/opt/homebrew/bin/wakatime-cli");
  assert.equal(paths.codexHooks, path.join(home, "codex-hooks.json"));
});

test("validateSetup reports each missing dependency by path", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-missing-home");
  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
  });

  assert.throws(
    () => cli.validateSetup(paths),
    /missing WakaTime CLI: .*wakatime-cli-darwin/
  );
  assert.throws(
    () => cli.validateSetup(paths),
    /missing WakaTime config: .*\.wakatime\.cfg/
  );
});

test("hook command uses shell quoting for the selected runtime", () => {
  const macCommand = cli.buildHookEntry({ runtime: "macos" }).command;
  const windowsCommand = cli.buildHookEntry({ runtime: "windows" }).command;

  assert.match(macCommand, /^node '.+' hook$/);
  assert.match(windowsCommand, /^node ".+" hook$/);
});

test("hook matching replaces old installs from different package paths", () => {
  assert.equal(cli.isOurHookEntry({
    type: "command",
    command: "node '/tmp/local/codex-app-wakatime/bin/codex-app-wakatime.js' hook",
  }), true);
  assert.equal(cli.isOurHookEntry({
    type: "command",
    command: "node '/usr/local/lib/node_modules/codex-app-wakatime/bin/codex-app-wakatime.js' hook",
  }), true);
  assert.equal(cli.isOurHookEntry({
    type: "command",
    command: "node '/tmp/other-tool/bin/other-tool.js' hook",
  }), false);
});

test("parseOptions keeps positional arguments separate from option flags", () => {
  const options = cli.parseOptions(["/tmp/project", "--skip-checks"]);

  assert.equal(options.skipChecks, true);
  assert.deepEqual(options.rest, ["/tmp/project"]);
});

test("buildPluginString uses the WakaTime Codex identity", () => {
  assert.equal(cli.buildPluginString(), "codex/1.0.0 codex-wakatime/0.1.0");
});

test("buildPluginString supports explicit identity overrides", () => {
  assert.equal(cli.buildPluginString({
    editorName: "cursor",
    pluginName: "codex-wakatime",
  }), "cursor/1.0.0 codex-wakatime/0.1.0");
});

test("filterTrackableFiles keeps only existing files inside the project", () => {
  const cwd = path.join(os.tmpdir(), "codex-wakatime-filter-project");
  const sourceFile = path.join(cwd, "src", "cli.js");
  const appBundle = "/Applications/Codex.app";

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, "");

  const files = cli.filterTrackableFiles([
    { path: sourceFile, isWrite: true },
    { path: appBundle, isWrite: false },
    { path: path.join(cwd, "missing.js"), isWrite: false },
  ], cwd);

  assert.deepEqual(files, [
    { path: sourceFile, isWrite: true },
  ]);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const packageJson = require("../package.json");

const cli = require("../src/cli");

test("macos runtime uses native Codex and WakaTime paths", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-mac-home");
  const homebrewCli = ["/opt/homebrew/bin/wakatime-cli", "/usr/local/bin/wakatime-cli"].find((candidate) => fs.existsSync(candidate));
  const expectedWakatimeCli = homebrewCli || path.join(home, ".wakatime", "wakatime-cli-darwin-arm64");

  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
    arch: "arm64",
  });

  assert.equal(paths.runtime, "macos");
  assert.equal(paths.codexHooks, path.join(home, ".codex", "hooks.json"));
  assert.equal(paths.wakatimeCli, expectedWakatimeCli);
  assert.equal(paths.wakatimeConfig, path.join(home, ".wakatime.cfg"));
  assert.equal(paths.stateFile, path.join(home, ".wakatime", "codex-app-wakatime.json"));
  assert.equal(cli.toHeartbeatPath("/Users/example/project/app.js", paths), "/Users/example/project/app.js");
});

test("wsl runtime keeps Windows WakaTime paths and converts heartbeat paths to UNC", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-wsl-home");
  const paths = cli.resolveRuntimePaths({
    platform: "linux",
    isWsl: true,
    homeDir: home,
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
  assert.equal(paths.turnFilesDir, path.join(home, ".wakatime", "codex-app-wakatime-turns"));
  assert.equal(cli.toHeartbeatPath("/home/user/project/app.js", paths), "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\app.js");
});

test("wsl setup checks read Windows config through the mounted host path", () => {
  assert.equal(cli.toReadableHostPath("C:\\Users\\User\\.wakatime.cfg"), "/mnt/c/Users/User/.wakatime.cfg");
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

test("macos runtime resolves WakaTime CLI from PATH before platform fallback", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-path-home");
  const bin = path.join(os.tmpdir(), "codex-wakatime-path-bin");
  const wakatimeCli = path.join(bin, "wakatime-cli");
  const staleWakatimeCli = path.join(home, ".wakatime", "wakatime-cli-darwin-arm64");
  const previousPath = process.env.PATH;

  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(wakatimeCli, "#!/bin/sh\n");
  fs.chmodSync(wakatimeCli, 0o755);
  fs.mkdirSync(path.dirname(staleWakatimeCli), { recursive: true });
  fs.writeFileSync(staleWakatimeCli, "");
  process.env.PATH = bin;

  try {
    const paths = cli.resolveRuntimePaths({
      platform: "darwin",
      homeDir: home,
      arch: "arm64",
    });

    assert.equal(paths.wakatimeCli, wakatimeCli);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("validateSetup reports each missing dependency by path", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-missing-home");
  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
    wakatimeCli: path.join(home, ".wakatime", "wakatime-cli-darwin-arm64"),
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

  assert.match(macCommand, /^node '.+' hook/);
  assert.match(windowsCommand, /^node ".+" hook/);
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

test("install writes hooks even when setup validation warns", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-install-warning-home");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  const originalLog = console.log;
  const originalWarn = console.warn;
  const warnings = [];

  fs.rmSync(home, { recursive: true, force: true });

  console.log = () => {};
  console.warn = (message) => warnings.push(message);

  try {
    cli.install({
      homeDir: home,
      codexHooks,
      wakatimeCli: path.join(home, ".wakatime", "missing-cli"),
      wakatimeConfig: path.join(home, ".wakatime.cfg"),
      platform: "darwin",
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const hooks = JSON.parse(fs.readFileSync(codexHooks, "utf8")).hooks;
  const command = hooks.Stop[0].hooks[0].command;
  const configFile = path.join(home, ".wakatime", "codex-app-wakatime.config.json");

  assert.match(warnings.join("\n"), /Setup check failed/);
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(cli.isOurHookEntry(hooks.Stop[0].hooks[0]), true);
  assert.match(command, /--state-file/);
  assert.match(command, /--turn-files-dir/);
  assert.match(command, /--config-file/);
  assert.match(command, /--codex-log/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), {
    debug: false,
    maxFileHeartbeats: 20,
    canonicalWorktree: true,
  });
});

test("buildPluginString uses the WakaTime Codex identity", () => {
  assert.equal(cli.buildPluginString(), `codex/1.0.0 codex-wakatime/${packageJson.version}`);
});

test("buildPluginString supports explicit identity overrides", () => {
  assert.equal(cli.buildPluginString({
    editorName: "cursor",
    pluginName: "codex-wakatime",
  }), `cursor/1.0.0 codex-wakatime/${packageJson.version}`);
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

test("extractEditedFilesFromPatch reads apply_patch file headers", () => {
  const cwd = path.join(os.tmpdir(), "codex-wakatime-patch-project");
  const addedFile = path.join(cwd, "src", "added.ts");
  const updatedFile = path.join(cwd, "src", "updated.ts");
  const movedFile = path.join(cwd, "src", "new-name.ts");

  const files = cli.extractEditedFilesFromPatch([
    "*** Begin Patch",
    "*** Add File: src/added.ts",
    "+export {};",
    "*** Update File: src/updated.ts",
    "@@",
    "-old",
    "+new",
    "*** Move to: src/new-name.ts",
    "*** End Patch",
  ].join("\n"), cwd);

  assert.deepEqual(files, [
    { path: addedFile, isWrite: true },
    { path: updatedFile, isWrite: true },
    { path: movedFile, isWrite: true },
  ]);
});

test("extractEditedFilesFromHookPayload only accepts edit tool events", () => {
  const cwd = path.join(os.tmpdir(), "codex-wakatime-hook-payload-project");
  const sourceFile = path.join(cwd, "src", "cli.js");
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/cli.js",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(cli.extractEditedFilesFromHookPayload({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { command: patch },
  }, cwd), [
    { path: sourceFile, isWrite: true },
  ]);

  assert.deepEqual(cli.extractEditedFilesFromHookPayload({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "sed -n '1,20p' src/cli.js" },
  }, cwd), []);
});

test("limitFilesForHeartbeats caps large extraction bursts", () => {
  const files = Array.from({ length: 25 }, (_, index) => ({
    path: `/tmp/project/file-${index}.js`,
    isWrite: false,
  }));

  assert.deepEqual(cli.limitFilesForHeartbeats(files), files.slice(0, 20));
});

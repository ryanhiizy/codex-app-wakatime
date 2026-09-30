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
    maxFileHeartbeats: 30,
  });
});

test("install enables WakaTime global AI transcript sync", () => {
  const home = path.join(os.tmpdir(), "codex-wakatime-ai-sync-home");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  const wakatimeCli = path.join(home, ".wakatime", "wakatime-cli");
  const wakatimeConfig = path.join(home, ".wakatime.cfg");
  const originalLog = console.log;

  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(wakatimeCli), { recursive: true });
  fs.writeFileSync(wakatimeCli, "");
  fs.writeFileSync(wakatimeConfig, "[settings]\napi_key = test\nsync_ai_disabled = true\n");
  console.log = () => {};

  try {
    cli.install({
      homeDir: home,
      codexHooks,
      wakatimeCli,
      wakatimeConfig,
      platform: "darwin",
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(cli.isWakatimeAiSyncDisabled({ wakatimeConfig }), false);
  assert.match(fs.readFileSync(wakatimeConfig, "utf8"), /sync_ai_disabled = false/);
  assert.doesNotThrow(() => cli.validateSetup({
    wakatimeCli,
    wakatimeConfig,
    runtime: "macos",
  }));
});

test("buildPluginString distinguishes the Codex agent from the desktop editor", () => {
  assert.equal(cli.buildPluginString(), `Codex codex-app/${packageJson.version}`);
  assert.equal(cli.buildPluginString({ includeAgent: false }), `codex-app/${packageJson.version}`);
  assert.equal(cli.buildPluginString({ editorName: "cursor" }), `cursor/${packageJson.version}`);
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
  const files = Array.from({ length: 35 }, (_, index) => ({
    path: `/tmp/project/file-${index}.js`,
    isWrite: false,
  }));

  assert.deepEqual(cli.limitFilesForHeartbeats(files, 30), files.slice(0, 30));
});

// Native Linux must never depend on a mounted Windows user profile.
test("native Linux resolves local paths and architecture-specific binaries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-linux-"));
  const previousPath = process.env.PATH;
  const previousCli = process.env.WAKATIME_CLI_PATH;
  process.env.PATH = "";
  delete process.env.WAKATIME_CLI_PATH;
  try {
    for (const [arch, suffix] of [["x64", "amd64"], ["arm64", "arm64"], ["ia32", "386"], ["arm", "arm"]]) {
      const paths = cli.resolveRuntimePaths({ platform: "linux", isWsl: false, arch, homeDir: home });
      assert.equal(paths.runtime, "linux");
      assert.equal(paths.wakatimeCli, path.join(home, ".wakatime", `wakatime-cli-linux-${suffix}`));
      assert.equal(paths.codexHooks, path.join(home, ".codex", "hooks.json"));
      assert.equal(paths.wakatimeConfig, path.join(home, ".wakatime.cfg"));
      assert.equal(cli.toHeartbeatPath("/home/user/project/app.js", paths), "/home/user/project/app.js");
    }
    const generic = path.join(home, ".wakatime", "wakatime-cli");
    fs.mkdirSync(path.dirname(generic), { recursive: true });
    fs.writeFileSync(generic, "");
    assert.equal(cli.resolveRuntimePaths({ platform: "linux", isWsl: false, homeDir: home }).wakatimeCli, generic);
  } finally {
    process.env.PATH = previousPath;
    if (previousCli === undefined) delete process.env.WAKATIME_CLI_PATH;
    else process.env.WAKATIME_CLI_PATH = previousCli;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Linux runtime distinguishes WSL and uses CLI overrides or PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-linux-path-"));
  const previousPath = process.env.PATH;
  const previousCli = process.env.WAKATIME_CLI_PATH;
  try {
    assert.equal(cli.detectRuntime({ platform: "linux", isWsl: false }), "linux");
    assert.equal(cli.detectRuntime({ platform: "linux", isWsl: true }), "wsl");
    const binary = path.join(home, "wakatime-cli");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = home;
    delete process.env.WAKATIME_CLI_PATH;
    const options = { platform: "linux", isWsl: false, homeDir: home };
    assert.equal(cli.resolveRuntimePaths(options).wakatimeCli, binary);
    process.env.WAKATIME_CLI_PATH = "/custom/linux-cli";
    assert.equal(cli.resolveRuntimePaths(options).wakatimeCli, "/custom/linux-cli");
    assert.equal(cli.resolveRuntimePaths({ ...options, wakatimeCli: binary }).wakatimeCli, binary);
  } finally {
    process.env.PATH = previousPath;
    if (previousCli === undefined) delete process.env.WAKATIME_CLI_PATH;
    else process.env.WAKATIME_CLI_PATH = previousCli;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor install is idempotent and uninstall preserves other hooks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-cursor-"));
  const options = { platform: "linux", isWsl: false, app: "cursor", homeDir: home, skipChecks: true };
  const paths = cli.resolveRuntimePaths(options);
  const original = { version: 1, custom: true, hooks: {
    stop: [{ command: "other-tool" }], beforeReadFile: [{ command: "read-tool" }],
  } };
  fs.mkdirSync(path.dirname(paths.hooksFile), { recursive: true });
  fs.writeFileSync(paths.hooksFile, JSON.stringify(original));
  const originalLog = console.log;
  console.log = () => {};
  try {
    cli.install(options);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${paths.hooksFile}.bak`, "utf8")), original);
    cli.install(options);
    const installed = JSON.parse(fs.readFileSync(paths.hooksFile, "utf8"));
    assert.equal(installed.hooks.stop.length, 2);
    assert.equal(installed.hooks.afterFileEdit.length, 1);
    assert.match(installed.hooks.stop[1].command, /--app 'cursor'/);
    assert.equal(paths.hooksFile, path.join(home, ".cursor", "hooks.json"));
    assert.notEqual(paths.stateFile, cli.resolveRuntimePaths({ ...options, app: "codex" }).stateFile);
    assert.notEqual(paths.turnFilesDir, cli.resolveRuntimePaths({ ...options, app: "codex" }).turnFilesDir);
    cli.uninstall(options);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.hooksFile, "utf8")), original);
    fs.writeFileSync(paths.hooksFile, "invalid json");
    assert.throws(() => cli.install(options), SyntaxError);
    assert.equal(fs.readFileSync(paths.hooksFile, "utf8"), "invalid json");
  } finally {
    console.log = originalLog;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installed Codex and Cursor hooks send file and project heartbeats through the selected CLI", () => {
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-hook-e2e-"));
  const capture = path.join(home, "heartbeats.jsonl");
  const binary = path.join(home, "fake-wakatime");
  const project = path.join(home, "project with spaces");
  fs.mkdirSync(project);
  const source = path.join(project, "main.js");
  fs.writeFileSync(source, "export {};\n");
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  const captured = () => fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
  const directCalls = () => captured().filter((args) => args.includes("--entity"));
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const app of ["codex", "cursor"]) {
      const options = { platform: "linux", isWsl: false, app, homeDir: home, wakatimeCli: binary, skipChecks: true };
      cli.install(options);
      const paths = cli.resolveRuntimePaths(options);
      const hooks = JSON.parse(fs.readFileSync(paths.hooksFile, "utf8")).hooks;
      const editCommand = app === "cursor" ? hooks.afterFileEdit[0].command : hooks.PostToolUse[0].hooks[0].command;
      const stopCommand = app === "cursor" ? hooks.stop[0].command : hooks.Stop[0].hooks[0].command;
      const base = app === "cursor" ? { conversation_id: "c", generation_id: "g", workspace_roots: [project] }
        : { session_id: "c", turn_id: "g", cwd: project };
      const invoke = (command, payload) => {
        const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8", cwd: home });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), app === "cursor" ? {} : payload.hook_event_name === "PostToolUse" ? {} : { continue: true });
      };
      invoke(editCommand, { ...base, hook_event_name: app === "cursor" ? "afterFileEdit" : "PostToolUse",
        file_path: source, tool_name: "Edit", tool_input: { file_path: source } });
      invoke(stopCommand, { ...base, hook_event_name: app === "cursor" ? "stop" : "Stop" });
      let calls = directCalls();
      const fileCall = calls.at(-1);
      assert.equal(fileCall[fileCall.indexOf("--entity") + 1], source);
      assert.equal(fileCall[fileCall.indexOf("--project-folder") + 1], project);
      assert.equal(fileCall[fileCall.indexOf("--plugin") + 1], `${app === "cursor" ? "cursor" : "Codex codex-app"}/${packageJson.version}`);
      assert.equal(fileCall.includes("--sync-ai-disabled"), app === "codex");
      if (app === "codex") {
        const syncCalls = captured().filter((args) => args.includes("--sync-ai-activity"));
        assert.equal(syncCalls.length, 1);
        assert.equal(syncCalls[0][syncCalls[0].indexOf("--plugin") + 1], `codex-app/${packageJson.version}`);
        assert.ok(!syncCalls[0].includes("--sync-ai-disabled"));
      }
      assert.ok(fileCall.includes("--write"));
      assert.deepEqual(fs.readdirSync(paths.turnFilesDir), []);
      if (app === "cursor") {
        const secondProject = path.join(home, "second project");
        fs.mkdirSync(secondProject);
        const secondFile = path.join(secondProject, "other.js");
        fs.writeFileSync(secondFile, "export {};\n");
        const multiRoot = { ...base, generation_id: "multi", workspace_roots: [project, secondProject] };
        invoke(editCommand, { ...multiRoot, hook_event_name: "afterFileEdit", file_path: secondFile });
        invoke(editCommand, { ...multiRoot, hook_event_name: "afterFileEdit", file_path: binary });
        invoke(stopCommand, { ...multiRoot, hook_event_name: "stop" });
        const multiCalls = directCalls();
        assert.equal(multiCalls.length, calls.length + 1);
        assert.equal(multiCalls.at(-1)[1], secondFile);
        assert.equal(multiCalls.at(-1)[multiCalls.at(-1).indexOf("--project-folder") + 1], secondProject);
      }
      const stop = { ...base, hook_event_name: app === "cursor" ? "stop" : "Stop", generation_id: "next", turn_id: "next" };
      invoke(stopCommand, stop);
      calls = directCalls();
      assert.equal(calls.at(-1)[1], app === "cursor" ? "Cursor" : "Codex");
      const count = captured().length;
      invoke(stopCommand, stop);
      assert.equal(captured().length, count);
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("app selection validates options", () => {
  assert.deepEqual(cli.parseOptions(["--app", "cursor"]).app, "cursor");
  assert.equal(cli.parseOptions(["--app=codex"]).app, "codex");
  assert.throws(() => cli.parseOptions(["--app"]), /Missing value/);
  assert.throws(() => cli.resolveRuntimePaths({ app: "unknown" }), /Unsupported app/);
});

test("failed standalone sync preserves transcript parsing for the direct send", () => {
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakatime-sync-fallback-"));
  const capture = path.join(home, "calls.jsonl");
  const binary = path.join(home, "fake-wakatime");
  const config = path.join(home, ".wakatime.cfg");
  fs.writeFileSync(config, "[settings]\nsync_ai_disabled = false\n");
  fs.writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n');
process.exit(args.includes('--sync-ai-activity') ? 2 : 0);
`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/codex-app-wakatime.js"),
      "test", home, "--home", home, "--wakatime-cli", binary,
      "--wakatime-config", config,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--sync-ai-activity"));
    assert.ok(calls[1].includes("--entity"));
    assert.ok(!calls[1].includes("--sync-ai-disabled"));
    assert.equal(calls[1][calls[1].indexOf("--plugin") + 1], `codex-app/${packageJson.version}`);
    assert.equal(fs.readFileSync(config, "utf8"), "[settings]\nsync_ai_disabled = false\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

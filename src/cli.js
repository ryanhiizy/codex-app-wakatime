const fs = require("node:fs");
const path = require("node:path");
const { version: VERSION } = require("../package.json");
const files = require("./files");
const platform = require("./platform");
const config = require("./config");
const { createStore } = require("./state");
const { createWakatime, buildPluginString, limitFilesForHeartbeats } = require("./wakatime");
const { resolveProjectRoot, resolveProjectRootRaw, getPrimaryWorktreeRoot,
  filterTrackableFiles, extractEditedFilesFromHookPayload, isInsideDir } = files;
const { resolveRuntimePaths, commandOrFileExists, toReadableHostPath,
  quotePosixShellArg, quoteWindowsShellArg } = platform;
const { readJson, writeJson, readConfig, ensureConfigFile,
  isWakatimeAiSyncDisabled, ensureWakatimeAiSyncEnabled } = config;
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "codex-app-wakatime.js");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function buildSignature(files, cwd) {
  if (files.length === 0) {
    return `app:${cwd}`;
  }

  return files
    .map((file) => `${file.isWrite ? "w" : "r"}:${file.path}`)
    .sort()
    .join("|");
}

function buildHookEntry(paths = resolveRuntimePaths(), options = {}) {
  const quotedBinPath = paths.runtime === "windows"
    ? quoteWindowsShellArg(BIN_PATH)
    : quotePosixShellArg(BIN_PATH);
  const quoteArg = paths.runtime === "windows" ? quoteWindowsShellArg : quotePosixShellArg;
  const commandParts = [
    quoteArg(process.execPath),
    quotedBinPath,
    "hook",
  ];

  for (const [flag, value] of [
    ["--app", paths.app],
    ["--wakatime-cli", paths.wakatimeCli],
    ["--wakatime-config", paths.wakatimeConfig],
    ["--wakatime-log", paths.wakatimeLog],
    ["--state-file", paths.stateFile],
    ["--turn-files-dir", paths.turnFilesDir],
    ["--config-file", paths.configFile],
    ["--codex-log", paths.codexLog],
  ]) {
    if (value) {
      commandParts.push(flag, quoteArg(value));
    }
  }

  const entry = {
    type: "command",
    command: commandParts.join(" "),
    timeout: 30,
  };

  if (options.statusMessage !== false) {
    entry.statusMessage = options.statusMessage || "Sending WakaTime heartbeat";
  }

  return entry;
}

function validateSetup(paths) {
  const failures = [];

  if (!commandOrFileExists(paths.wakatimeCli)) {
    failures.push(`missing WakaTime CLI: ${paths.wakatimeCli}`);
  }

  if (!fs.existsSync(toReadableHostPath(paths.wakatimeConfig))) {
    failures.push(`missing WakaTime config: ${paths.wakatimeConfig}`);
  } else if (isWakatimeAiSyncDisabled(paths)) {
    failures.push(`WakaTime AI transcript sync must be enabled: ${paths.wakatimeConfig}`);
  }

  if (failures.length > 0) {
    throw new Error(`Setup check failed for ${paths.runtime}:\n- ${failures.join("\n- ")}`);
  }
}

function warnOnInvalidSetup(paths) {
  try {
    validateSetup(paths);
  } catch (error) {
    console.warn(`Warning: ${error.message}`);
    console.warn("Installed hooks anyway. Run `codex-app-wakatime doctor` for setup details.");
  }
}

function getSetupChecks(paths) {
  return {
    hooksFileExists: fs.existsSync(paths.hooksFile || paths.codexHooks),
    codexHooksExists: fs.existsSync(paths.codexHooks),
    wakatimeCliExists: commandOrFileExists(paths.wakatimeCli),
    wakatimeConfigExists: fs.existsSync(toReadableHostPath(paths.wakatimeConfig)),
    wakatimeAiSyncDisabled: fs.existsSync(toReadableHostPath(paths.wakatimeConfig)) ? isWakatimeAiSyncDisabled(paths) : null,
  };
}

function isOurHookEntry(entry) {
  return Boolean(entry && (!entry.type || entry.type === "command")
    && typeof entry.command === "string"
    && /(?:^|[\\/])codex-app-wakatime\.js['"]?\s+hook(?:\s|$)/.test(entry.command));
}

function removeOurHookEntries(groups = []) {
  return groups.flatMap((group) => {
    const hooks = group.hooks.filter((entry) => !isOurHookEntry(entry));
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

function validateHookConfig(value, app) {
  if (value === undefined) return;
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) {
    throw new Error("Invalid hooks configuration: expected a JSON object with an optional hooks object.");
  }
  for (const event of app === "cursor" ? ["afterFileEdit", "stop"] : ["PostToolUse", "Stop"]) {
    const entries = value.hooks?.[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => !object(entry)
      || (app !== "cursor" && !Array.isArray(entry.hooks)))) {
      throw new Error(`Invalid hooks configuration for ${event}.`);
    }
  }
}

const VALUE_OPTIONS = {
  "--app": "app", "--cursor-hooks": "cursorHooks", "--home": "homeDir",
  "--wakatime-cli": "wakatimeCli", "--wakatime-config": "wakatimeConfig",
  "--wakatime-log": "wakatimeLog", "--codex-hooks": "codexHooks",
  "--state-file": "stateFile", "--turn-files-dir": "turnFilesDir",
  "--config-file": "configFile", "--codex-log": "codexLog",
};

function parseOptions(args) {
  const options = { rest: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") { options.rest.push(...args.slice(index + 1)); break; }
    if (arg === "--skip-checks") { options.skipChecks = true; continue; }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const key = VALUE_OPTIONS[flag];
    if (key) {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      options[key] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${flag}`);
    } else options.rest.push(arg);
  }
  return options;
}

function createApp(options = {}) {
  let paths;
  const getPaths = () => paths ||= resolveRuntimePaths(options);
  const store = createStore(getPaths);
  const wakatime = createWakatime(getPaths, store.getConfig, store.logDebug);

  async function runHook() {
    let response = options.app === "cursor" ? {} : { continue: true };
    try {
      const rawInput = await readStdin();
      let payload;
      try { payload = JSON.parse(rawInput); } catch { return; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) { return; }
      const isCursor = options.app === "cursor";
      const event = payload.hook_event_name;
      const workspaceRoots = isCursor && Array.isArray(payload.workspace_roots)
        ? payload.workspace_roots.filter((root) => typeof root === "string" && path.isAbsolute(root)) : [];
      const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : workspaceRoots[0] || process.cwd();
      if (event === (isCursor ? "afterFileEdit" : "PostToolUse")) {
        response = {};
        store.remember(payload, extractEditedFilesFromHookPayload(payload, cwd));
        return;
      }
      if (event && event !== (isCursor ? "stop" : "Stop")) { response = {}; return; }
      const state = store.readState();
      const queue = store.claim(payload, state);
      let consumed = false;
      try {
        const appSignature = buildSignature([], cwd);
        if (!queue.files.length && !store.shouldSend(appSignature, state)) {
          consumed = true;
          return;
        }
        const raw = resolveProjectRootRaw(cwd);
        const primary = getPrimaryWorktreeRoot(raw);
        let tracked;
        if (isCursor && workspaceRoots.length) {
          const roots = workspaceRoots.map((root) => {
            const rawRoot = resolveProjectRootRaw(root);
            return { workspace: root, raw: rawRoot, primary: getPrimaryWorktreeRoot(rawRoot) };
          }).sort((a, b) => b.workspace.length - a.workspace.length);
          tracked = queue.files.flatMap((file) => {
            const root = roots.find((candidate) => isInsideDir(file.path, candidate.workspace));
            if (!root) return [];
            return filterTrackableFiles([file], root.workspace, store.logDebug, root.primary, root.raw)
              .map((item) => ({ ...item, projectRoot: root.primary }));
          });
        } else tracked = filterTrackableFiles(queue.files, cwd, store.logDebug, primary, raw);
        const signature = tracked.length ? buildSignature(tracked, cwd) : appSignature;
        if (!store.shouldSend(signature, state)) { consumed = true; return; }
        const result = wakatime.sendTurn(tracked, primary);
        if (result.ok) {
          store.recordHeartbeat(signature, payload);
          consumed = true;
        }
      } finally {
        queue.finish(consumed);
      }
    } finally {
      process.stdout.write(JSON.stringify(response));
    }
  }

  function install() {
    const paths = getPaths();
    const { codexHooks } = paths;

    const existing = readJson(codexHooks);
    validateHookConfig(existing, paths.app);

    ensureConfigFile(paths);
    ensureWakatimeAiSyncEnabled(paths);

    if (!options.skipChecks) {
      warnOnInvalidSetup(paths);
    }

    const config = existing || { hooks: {} };

    if (paths.app === "cursor") {
      if (existing) writeJson(`${codexHooks}.bak`, existing);
      config.version = config.version ?? 1;
      config.hooks = { ...(config.hooks || {}) };
      const { command } = buildHookEntry(paths);
      for (const event of ["afterFileEdit", "stop"]) {
        const entries = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
        config.hooks[event] = [...entries.filter((entry) => !isOurHookEntry(entry)), { command }];
      }
      writeJson(codexHooks, config);
      console.log(`Installed Cursor hooks at ${codexHooks}`);
      return;
    }
    const stopHooks = Array.isArray(config.hooks?.Stop) ? config.hooks.Stop : [];
    const postToolUseHooks = Array.isArray(config.hooks?.PostToolUse) ? config.hooks.PostToolUse : [];

    if (existing) {
      writeJson(`${codexHooks}.bak`, existing);
    }

    const normalizedStopHooks = removeOurHookEntries(stopHooks);
    normalizedStopHooks.push({ hooks: [buildHookEntry(paths)] });

    const normalizedPostToolUseHooks = removeOurHookEntries(postToolUseHooks);
    normalizedPostToolUseHooks.push({
      matcher: "apply_patch|Edit|Write",
      hooks: [buildHookEntry(paths, {
        statusMessage: "Tracking edited files",
      })],
    });

    config.hooks = {
      ...(config.hooks || {}),
      PostToolUse: normalizedPostToolUseHooks,
      Stop: normalizedStopHooks,
    };

    writeJson(codexHooks, config);
    console.log(`Installed Codex hook at ${codexHooks}`);
  }

  function uninstall() {
    const { codexHooks, app } = getPaths();
    const existing = readJson(codexHooks);
    validateHookConfig(existing, app);

    if (app === "cursor") {
      if (!existing) {
        console.log("No Cursor hook config found.");
        return;
      }
      const hooks = { ...(existing.hooks || {}) };
      for (const event of ["afterFileEdit", "stop"]) {
        if (!Array.isArray(hooks[event])) continue;
        hooks[event] = hooks[event].filter((entry) => !isOurHookEntry(entry));
        if (!hooks[event].length) delete hooks[event];
      }
      writeJson(codexHooks, { ...existing, hooks });
      console.log(`Removed Cursor hook entries from ${codexHooks}`);
      return;
    }

    if (!existing?.hooks?.Stop && !existing?.hooks?.PostToolUse) {
      console.log("No Codex hook config found.");
      return;
    }

    const nextHooks = { ...(existing.hooks || {}) };

    for (const eventName of ["PostToolUse", "Stop"]) {
      const normalized = removeOurHookEntries(Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []);

      if (normalized.length > 0) {
        nextHooks[eventName] = normalized;
      } else {
        delete nextHooks[eventName];
      }
    }

    const nextConfig = { ...existing, hooks: nextHooks };
    writeJson(codexHooks, nextConfig);
    console.log(`Removed Codex hook entry from ${codexHooks}`);
  }

  function status() {
    const paths = getPaths();
    const hookConfig = readJson(paths.codexHooks);

    console.log(JSON.stringify({
      version: VERSION,
      app: paths.app,
      hooksFile: paths.hooksFile,
      runtime: paths.runtime,
      rootDir: ROOT_DIR,
      binPath: BIN_PATH,
      codexHooks: paths.codexHooks,
      codexLog: paths.codexLog,
      stateFile: paths.stateFile,
      turnFilesDir: paths.turnFilesDir,
      configFile: paths.configFile,
      config: readConfig(paths.configFile),
      wakatimeCli: paths.wakatimeCli,
      wakatimePlugin: buildPluginString({ app: options.app }),
      wakatimeAiSyncDisabled: isWakatimeAiSyncDisabled(paths),
      checks: {
        ...getSetupChecks(paths),
      },
      installedCommand: paths.app === "cursor"
        ? hookConfig?.hooks?.stop?.find(isOurHookEntry)?.command || null
        : hookConfig?.hooks?.Stop?.flatMap((group) => group.hooks || []).find(isOurHookEntry)?.command || null,
    }, null, 2));
  }

  function doctor() {
    const paths = getPaths();
    const checks = getSetupChecks(paths);

    console.log(JSON.stringify({
      app: paths.app,
      hooksFile: paths.hooksFile,
      runtime: paths.runtime,
      codexHooks: paths.codexHooks,
      wakatimeCli: paths.wakatimeCli,
      wakatimeConfig: paths.wakatimeConfig,
      configFile: paths.configFile,
      turnFilesDir: paths.turnFilesDir,
      config: readConfig(paths.configFile),
      wakatimePlugin: buildPluginString({ app: options.app }),
      wakatimeAiSyncDisabled: isWakatimeAiSyncDisabled(paths),
      checks,
    }, null, 2));

    validateSetup(paths);
    console.log("Setup checks passed.");
  }

  function test(targetPath) {
    const cwd = targetPath || process.cwd();
    const projectRoot = resolveProjectRoot(cwd);
    const result = wakatime.sendTurn([], projectRoot);
    console.log(JSON.stringify({ ...result, project: files.basenameAny(projectRoot), projectRoot, cwd }, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
  return { runHook, install, uninstall, status, doctor, test };
}

async function run(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (options.app && !["codex", "cursor"].includes(options.app)) throw new Error(`Unsupported app: ${options.app}`);
  const app = createApp(options);
  switch (command) {
    case "hook":
      try { await app.runHook(); } catch (error) {
        console.error(`WakaTime hook: ${error.message}`);
        // The host app must remain usable when its tracking storage is unavailable.
        // runHook always writes its protocol response in finally.
      }
      return;
    case "install": case "setup": return app.install();
    case "uninstall": return app.uninstall();
    case "status": return app.status();
    case "doctor": return app.doctor();
    case "test": return app.test(options.rest[0]);
    default:
      console.log("Usage: codex-app-wakatime <setup|install|uninstall|status|doctor|test|hook> [--app codex|cursor] [--skip-checks]");
  }
}

module.exports = {
  run, detectRuntime: platform.detectRuntime, resolveRuntimePaths, toHeartbeatPath: platform.toHeartbeatPath,
  validateSetup, warnOnInvalidSetup,
  install: (options) => createApp(options).install(),
  uninstall: (options) => createApp(options).uninstall(),
  buildHookEntry, isOurHookEntry, buildPluginString, ensureWakatimeAiSyncEnabled,
  isWakatimeAiSyncDisabled, parseOptions, toReadableHostPath,
  extractEditedFilesFromPatch: files.extractEditedFilesFromPatch,
  extractEditedFilesFromHookPayload, filterTrackableFiles,
  limitFilesForHeartbeats: (items, maximum = readConfig(resolveRuntimePaths().configFile).maxFileHeartbeats) => limitFilesForHeartbeats(items, maximum),
};

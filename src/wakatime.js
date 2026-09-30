const { spawnSync } = require("node:child_process");
const { basenameAny } = require("./files");
const { buildWakatimeLaunch, commandOrFileExists, toHeartbeatPath } = require("./platform");
const { version: VERSION } = require("../package.json");

function buildPluginString(options = {}) {
  const editor = options.editorName || process.env.CODEX_WAKATIME_EDITOR
    || (options.app === "cursor" ? "cursor" : "codex-app");
  const plugin = options.pluginName || process.env.CODEX_WAKATIME_PLUGIN || "";
  if (plugin) return `${editor}/1.0.0 ${plugin}/${VERSION}`;
  // A lone codex-app token is interpreted as the agent rather than the editor.
  const agent = options.includeAgent !== false && editor.toLowerCase() === "codex-app" ? "Codex " : "";
  return `${agent}${editor}/${VERSION}`;
}

function limitFilesForHeartbeats(files, maximum = 30) {
  return files.slice(0, maximum);
}

function createWakatime(getPaths, getConfig, logDebug) {
  function sendTurn(files, projectRoot) {
    const paths = getPaths();
    if (!commandOrFileExists(paths.wakatimeCli)) {
      logDebug(`missing wakatime cli at ${paths.wakatimeCli}`);
      return { ok: false, reason: "missing_wakatime_cli" };
    }
    // Leave time for state cleanup and a valid hook response before the host's 30s limit.
    const deadline = Date.now() + 25000;
    const launch = buildWakatimeLaunch(paths.wakatimeCli);
    const plugin = (includeAgent) => buildPluginString({ app: paths.app, includeAgent });
    const invoke = (args, input, maximumMs = 25000) => {
      const timeout = Math.min(maximumMs, deadline - Date.now());
      if (timeout <= 0) return { ok: false, reason: "hook_timeout" };
      const result = spawnSync(launch.command, [...launch.argsPrefix, ...args,
        "--config", paths.wakatimeConfig, "--log-file", paths.wakatimeLog,
        "--timeout", String(Math.max(1, Math.floor(timeout / 1000))),
      ], { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true, timeout, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        logDebug(`WakaTime failed: ${result.error?.message || result.stderr || result.status}`);
        return { ok: false, reason: result.error ? "spawn_error" : "non_zero_exit", status: result.status };
      }
      return { ok: true };
    };
    let transcriptsSynced = false;
    if (plugin(true).startsWith("Codex ")) {
      transcriptsSynced = invoke(["--sync-ai-activity", "--plugin", plugin(false)], undefined, 10000).ok;
    }
    const common = ["--category", "ai coding", "--plugin", plugin(transcriptsSynced),
      "--heartbeat-rate-limit-seconds", "60"];
    if (transcriptsSynced) common.push("--sync-ai-disabled");
    if (!files.length) {
      const entity = paths.app === "cursor" ? "Cursor" : "Codex";
      return { ...invoke(["--entity", entity, "--entity-type", "app",
        "--project", basenameAny(projectRoot), ...common]), entity };
    }
    const limited = limitFilesForHeartbeats(files, getConfig().maxFileHeartbeats);
    const groups = new Map();
    for (const file of limited) {
      const folder = file.projectRoot || projectRoot;
      // Legacy CLI extra-heartbeat payloads cannot carry a per-file local-file override.
      const key = file.localFile ? file : folder;
      if (!groups.has(key)) groups.set(key, { folder, files: [] });
      groups.get(key).files.push(file);
    }
    let ok = true;
    for (const group of groups.values()) {
      const [first, ...rest] = group.files;
      const args = ["--entity", toHeartbeatPath(first.path, paths), "--entity-type", "file",
        "--project-folder", toHeartbeatPath(group.folder, paths), ...common];
      if (first.isWrite) args.push("--write");
      if (first.localFile) args.push("--local-file", toHeartbeatPath(first.localFile, paths));
      let input;
      if (rest.length) {
        args.push("--extra-heartbeats");
        const time = Date.now() / 1000;
        input = JSON.stringify(rest.map((file) => ({ entity: toHeartbeatPath(file.path, paths),
          type: "file", category: "ai coding", is_write: file.isWrite, time,
          alternate_project: basenameAny(group.folder),
        })));
      }
      if (!invoke(args, input).ok) ok = false;
      logDebug(`WakaTime file batch count=${group.files.length} project=${group.folder}`);
    }
    return { ok, ...(ok ? {} : { reason: "file_send_failed" }) };
  }
  return { sendTurn };
}

module.exports = { buildPluginString, limitFilesForHeartbeats, createWakatime };

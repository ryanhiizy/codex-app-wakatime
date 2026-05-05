const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageJson = require("../package.json");

const VERSION = packageJson.version;
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "codex-app-wakatime.js");
const DEFAULT_WAKATIME_EDITOR = "codex";
const DEFAULT_WAKATIME_PLUGIN = "codex-app-wakatime";
const HOOK_COMMAND_MARKER = "codex-app-wakatime";
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const READ_PATTERNS = [
  /```\w*:([^\n`]+)/g,
  /`([^`\s]+\.\w{1,6})`/g,
  /["']([^"'\s]+\.\w{1,6})["']/g,
  /(?:Read|List)\s+`?([^\s`\n]+\.\w{1,6})`?/gi,
];
const WRITE_PATTERN = /(?:Create|Created|Modify|Modified|Update|Updated|Write|Wrote|Edit|Edited|Delete|Deleted)\s+`?([^\s`\n]+\.\w{1,6})`?/gi;

function basenameAny(value) {
  return String(value || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "project";
}

function getParentDir(currentPath) {
  const parsed = path.parse(currentPath);

  if (currentPath === parsed.root) {
    return null;
  }

  return path.dirname(currentPath);
}

function hasGitMarker(dirPath) {
  return fs.existsSync(path.join(dirPath, ".git"));
}

function resolveProjectRootRaw(startPath) {
  if (!startPath) {
    return process.cwd();
  }

  let currentPath = path.resolve(startPath);

  if (!fs.existsSync(currentPath)) {
    currentPath = path.dirname(currentPath);
  } else if (!fs.statSync(currentPath).isDirectory()) {
    currentPath = path.dirname(currentPath);
  }

  while (currentPath) {
    if (hasGitMarker(currentPath)) {
      return currentPath;
    }

    currentPath = getParentDir(currentPath);
  }

  return path.resolve(startPath);
}

function getPrimaryWorktreeRoot(projectRoot) {
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) {
    return projectRoot;
  }

  const firstWorktree = result.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  const primaryRoot = firstWorktree ? firstWorktree.slice("worktree ".length).trim() : "";

  if (!primaryRoot || !fs.existsSync(primaryRoot)) {
    return projectRoot;
  }

  return path.resolve(primaryRoot);
}

function canonicalizeGitWorktreePath(filePath, projectRoot) {
  const resolvedPath = path.resolve(filePath);
  const primaryRoot = getPrimaryWorktreeRoot(projectRoot);

  if (primaryRoot === projectRoot || !resolvedPath.startsWith(`${projectRoot}${path.sep}`)) {
    return resolvedPath;
  }

  return path.join(primaryRoot, path.relative(projectRoot, resolvedPath));
}

function resolveProjectRoot(startPath) {
  const rawProjectRoot = resolveProjectRootRaw(startPath);
  return getPrimaryWorktreeRoot(rawProjectRoot);
}

function quotePosixShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function wslToUnc(posixPath, distro = process.env.WSL_DISTRO_NAME || "Ubuntu") {

  if (!posixPath || !posixPath.startsWith("/")) {
    return posixPath;
  }

  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

function isWindowsAbsolutePath(filePath) {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(filePath);
}

function isValidFilePath(filePath) {
  if (!filePath || filePath.length === 0) {
    return false;
  }

  if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.includes("://")) {
    return false;
  }

  if (/[<>|?*]/.test(filePath)) {
    return false;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (!ext || ext.length > 6) {
    return false;
  }

  return true;
}

function normalizePath(filePath, cwd) {
  const cleaned = filePath.trim();

  if (isWindowsAbsolutePath(cleaned) && process.platform !== "win32") {
    return path.normalize(cleaned);
  }

  const candidatePath = path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)
    ? path.normalize(cleaned)
    : path.normalize(path.join(cwd, cleaned));

  return canonicalizeGitWorktreePath(candidatePath, resolveProjectRootRaw(candidatePath));
}

function toHeartbeatPath(filePath, paths = getPaths()) {
  if (paths.runtime === "wsl" && filePath.startsWith("/")) {
    return wslToUnc(filePath, paths.distro);
  }

  return filePath;
}

function isInsideDir(filePath, dirPath) {
  const relativePath = path.relative(dirPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function filterTrackableFiles(files, cwd, logger = () => {}) {
  const projectRoot = resolveProjectRoot(cwd);

  return files.filter((file) => {
    if (!fs.existsSync(file.path)) {
      logger(`skipped missing extracted file path=${file.path}`);
      return false;
    }

    const stats = fs.statSync(file.path);

    if (!stats.isFile()) {
      logger(`skipped non-file extracted path=${file.path}`);
      return false;
    }

    if (!isInsideDir(file.path, projectRoot)) {
      logger(`skipped extracted file outside project path=${file.path}`);
      return false;
    }

    return true;
  });
}

function extractFiles(message, cwd) {
  if (!message || message.length === 0) {
    return [];
  }

  const fileMap = new Map();
  WRITE_PATTERN.lastIndex = 0;

  for (const match of message.matchAll(WRITE_PATTERN)) {
    const filePath = match[1];

    if (filePath && isValidFilePath(filePath)) {
      const normalized = normalizePath(filePath, cwd);
      fileMap.set(normalized, true);
    }
  }

  for (const pattern of READ_PATTERNS) {
    pattern.lastIndex = 0;

    for (const match of message.matchAll(pattern)) {
      const filePath = match[1];

      if (filePath && isValidFilePath(filePath)) {
        const normalized = normalizePath(filePath, cwd);

        if (!fileMap.has(normalized)) {
          fileMap.set(normalized, false);
        }
      }
    }
  }

  return Array.from(fileMap.entries()).map(([filePath, isWrite]) => ({
    path: filePath,
    isWrite,
  }));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

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

function toWindowsWslPath(windowsPath) {
  return windowsPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

function findWindowsUserDir() {
  const explicitWindowsHome = process.env.WAKATIME_WINDOWS_HOME || process.env.USERPROFILE;

  if (explicitWindowsHome && /^[A-Za-z]:\\/.test(explicitWindowsHome)) {
    const wslPath = toWindowsWslPath(explicitWindowsHome);
    const exists = process.platform === "win32" ? fs.existsSync(explicitWindowsHome) : fs.existsSync(wslPath);

    if (exists) {
      return {
        win: explicitWindowsHome,
        wsl: wslPath,
      };
    }
  }

  const usersRoot = process.platform === "win32" ? "C:\\Users" : "/mnt/c/Users";
  const ignoredNames = new Set([
    "All Users",
    "Default",
    "Default User",
    "Public",
    "defaultuser0",
    "desktop.ini",
  ]);

  if (!fs.existsSync(usersRoot)) {
    return null;
  }

  const candidates = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
    .map((entry) => {
      const win = process.platform === "win32"
        ? path.win32.join(usersRoot, entry.name)
        : `C:\\Users\\${entry.name}`;
      const wsl = process.platform === "win32"
        ? win
        : path.posix.join("/mnt/c/Users", entry.name);
      const profileRoot = process.platform === "win32" ? win : wsl;
      const score = Number(fs.existsSync(process.platform === "win32"
        ? path.win32.join(win, ".wakatime.cfg")
        : path.posix.join(wsl, ".wakatime.cfg")))
        + Number(fs.existsSync(process.platform === "win32"
          ? path.win32.join(win, ".wakatime", "wakatime-cli-windows-amd64.exe")
          : path.posix.join(wsl, ".wakatime", "wakatime-cli-windows-amd64.exe")))
        + Number(entry.name.toLowerCase() === "user")
        + Number(entry.name.toLowerCase() === String(process.env.USER || "").toLowerCase());

      return {
        win,
        wsl: process.platform === "win32" ? toWindowsWslPath(win) : wsl,
        profileRoot,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || left.profileRoot.localeCompare(right.profileRoot));

  if (candidates.length === 0) {
    return null;
  }

  return {
    win: candidates[0].win,
    wsl: candidates[0].wsl,
  };
}

function detectRuntime(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "darwin") {
    return "macos";
  }

  if (platform === "win32") {
    return "windows";
  }

  if (platform === "linux" && (options.isWsl || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
    return "wsl";
  }

  throw new Error("Unable to auto-detect supported runtime. Expected macOS, Windows, or WSL.");
}

function getDarwinWakatimeCliName(arch = process.arch) {
  if (arch === "arm64") {
    return "wakatime-cli-darwin-arm64";
  }

  return "wakatime-cli-darwin-amd64";
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    encoding: "utf8",
    shell: process.platform !== "win32",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

function findNativeWakatimeCli(homeDir, options = {}) {
  if (options.wakatimeCli) {
    return options.wakatimeCli;
  }

  if (process.env.WAKATIME_CLI_PATH) {
    return process.env.WAKATIME_CLI_PATH;
  }

  const candidates = [
    path.join(homeDir, ".wakatime", "wakatime-cli"),
    path.join(homeDir, ".wakatime", getDarwinWakatimeCliName(options.arch)),
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));

  if (existing) {
    return existing;
  }

  return commandExists("wakatime-cli") ? "wakatime-cli" : candidates[1];
}

function resolveRuntimePaths(options = {}) {
  const runtime = detectRuntime(options);

  if (runtime === "macos") {
    const homeDir = options.homeDir || os.homedir();

    return {
      runtime,
      homeDir,
      distro: null,
      wakatimeCli: findNativeWakatimeCli(homeDir, options),
      wakatimeConfig: options.wakatimeConfig || path.join(homeDir, ".wakatime.cfg"),
      wakatimeLog: options.wakatimeLog || path.join(homeDir, ".wakatime", "wakatime.log"),
      stateFile: options.stateFile || path.join(homeDir, ".wakatime", "codex-app-wakatime.json"),
      codexHooks: options.codexHooks || path.join(homeDir, ".codex", "hooks.json"),
      codexLog: options.codexLog || path.join(homeDir, ".codex", "codex-app-wakatime.log"),
    };
  }

  const windowsHome = options.windowsHome || findWindowsUserDir();

  if (!windowsHome) {
    throw new Error(`Unable to find the Windows user profile needed for the ${runtime} runtime.`);
  }

  const isWindowsRuntime = runtime === "windows";
  const defaultWakatimeCli = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".wakatime", "wakatime-cli-windows-amd64.exe")
    : path.posix.join(windowsHome.wsl, ".wakatime", "wakatime-cli-windows-amd64.exe");

  const codexHooks = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".codex", "hooks.json")
    : path.posix.join(windowsHome.wsl, ".codex", "hooks.json");

  const codexLog = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".codex", "codex-app-wakatime.log")
    : path.posix.join(windowsHome.wsl, ".codex", "codex-app-wakatime.log");

  return {
    runtime,
    windowsHome,
    distro: options.distro || process.env.WSL_DISTRO_NAME || "Ubuntu",
    wakatimeCli: options.wakatimeCli || process.env.WAKATIME_CLI_PATH || defaultWakatimeCli,
    wakatimeConfig: options.wakatimeConfig || path.win32.join(windowsHome.win, ".wakatime.cfg"),
    wakatimeLog: options.wakatimeLog || path.win32.join(windowsHome.win, ".wakatime", "wakatime.log"),
    stateFile: options.stateFile || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", "codex-app-wakatime.json")
      : path.posix.join(windowsHome.wsl, ".wakatime", "codex-app-wakatime.json")),
    codexHooks: options.codexHooks || codexHooks,
    codexLog: options.codexLog || codexLog,
  };
}

function getPaths(options = {}) {
  return resolveRuntimePaths(options);
}

function logDebug(message) {
  const { codexLog } = getPaths();
  ensureDir(path.dirname(codexLog));
  fs.appendFileSync(codexLog, `[${new Date().toISOString()}] ${message}\n`);
}

function writeContinue(systemMessage) {
  const payload = { continue: true };

  if (systemMessage) {
    payload.systemMessage = systemMessage;
  }

  process.stdout.write(JSON.stringify(payload));
}

function readState() {
  const { stateFile } = getPaths();

  if (!fs.existsSync(stateFile)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const { stateFile } = getPaths();
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function shouldSendHeartbeat(signature, force = false) {
  if (force) {
    return true;
  }

  const state = readState();
  const lastHeartbeatAt = state.lastHeartbeatAt || 0;
  const lastSignature = state.lastSignature || "";
  const elapsed = Math.floor(Date.now() / 1000) - lastHeartbeatAt;

  if (elapsed >= 60) {
    return true;
  }

  return signature !== lastSignature;
}

function updateLastHeartbeat(signature) {
  writeState({
    lastHeartbeatAt: Math.floor(Date.now() / 1000),
    lastSignature: signature,
  });
}

function isWsl() {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function buildWakatimeLaunch(wakatimeCli) {
  if (isWsl() && /\.exe$/i.test(wakatimeCli) && fs.existsSync("/init")) {
    return {
      command: "/init",
      argsPrefix: [wakatimeCli, "--"],
    };
  }

  return {
    command: wakatimeCli,
    argsPrefix: [],
  };
}

function buildPluginString(options = {}) {
  const editorName = options.editorName || process.env.CODEX_WAKATIME_EDITOR || DEFAULT_WAKATIME_EDITOR;
  const pluginName = options.pluginName || process.env.CODEX_WAKATIME_PLUGIN || DEFAULT_WAKATIME_PLUGIN;

  return `${editorName}/1.0.0 ${pluginName}/${VERSION}`;
}

function sendHeartbeat(params) {
  const paths = getPaths();

  if (!fs.existsSync(paths.wakatimeCli)) {
    logDebug(`missing wakatime cli at ${paths.wakatimeCli}`);
    return { ok: false, reason: "missing_wakatime_cli" };
  }

  const args = [
    "--entity",
    params.entity,
    "--entity-type",
    params.entityType,
    "--category",
    params.category || "ai coding",
    "--plugin",
    buildPluginString(),
    "--config",
    paths.wakatimeConfig,
    "--log-file",
    paths.wakatimeLog,
    "--heartbeat-rate-limit-seconds",
    "60",
    "--timeout",
    "30",
  ];

  if (params.projectFolder) {
    args.push("--project-folder", params.projectFolder);
  }

  if (params.project) {
    args.push("--project", params.project);
  }

  if (params.isWrite) {
    args.push("--write");
  }

  const launch = buildWakatimeLaunch(paths.wakatimeCli);

  if (launch.command !== paths.wakatimeCli) {
    logDebug(`launching wakatime cli through ${launch.command}`);
  }

  const result = spawnSync(launch.command, [...launch.argsPrefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.error) {
    logDebug(`wakatime spawn error=${result.error.message}`);
    return { ok: false, reason: "spawn_error", error: result.error.message };
  }

  if (result.status !== 0) {
    logDebug(`wakatime failed status=${result.status} stderr=${(result.stderr || "").trim()}`);
    return { ok: false, reason: "non_zero_exit", status: result.status };
  }

  logDebug(`heartbeat sent entity=${params.entity}`);
  return { ok: true, entity: params.entity };
}

function sendProjectHeartbeat(cwd) {
  const projectRoot = resolveProjectRoot(cwd);
  const project = basenameAny(projectRoot);
  return sendHeartbeat({
    entity: "Codex",
    entityType: "app",
    project,
  });
}

function sendFileHeartbeats(files, cwd) {
  const paths = getPaths();
  const projectRoot = resolveProjectRoot(cwd);
  const heartbeatProjectFolder = toHeartbeatPath(projectRoot, paths);
  let sentCount = 0;

  for (const file of files) {
    const heartbeatPath = toHeartbeatPath(file.path, paths);
    logDebug(`sending file heartbeat path=${heartbeatPath} isWrite=${file.isWrite}`);
    const result = sendHeartbeat({
      entity: heartbeatPath,
      entityType: "file",
      projectFolder: heartbeatProjectFolder,
      isWrite: file.isWrite,
    });

    if (result.ok) {
      sentCount += 1;
    }
  }

  return sentCount > 0;
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

function buildHookEntry(paths = getPaths()) {
  const quotedBinPath = paths.runtime === "windows"
    ? quoteWindowsShellArg(BIN_PATH)
    : quotePosixShellArg(BIN_PATH);

  return {
    type: "command",
    command: `node ${quotedBinPath} hook`,
    timeout: 30,
    statusMessage: "Sending WakaTime heartbeat",
  };
}

function isOurHookEntry(entry) {
  return entry
    && entry.type === "command"
    && typeof entry.command === "string"
    && entry.command.includes(HOOK_COMMAND_MARKER)
    && /\bhook\b/.test(entry.command);
}

function parseOptions(args) {
  const options = {
    rest: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--skip-checks") {
      options.skipChecks = true;
    } else if (arg === "--home") {
      options.homeDir = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--home=")) {
      options.homeDir = arg.slice("--home=".length);
    } else if (arg === "--wakatime-cli") {
      options.wakatimeCli = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--wakatime-cli=")) {
      options.wakatimeCli = arg.slice("--wakatime-cli=".length);
    } else if (arg === "--wakatime-config") {
      options.wakatimeConfig = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--wakatime-config=")) {
      options.wakatimeConfig = arg.slice("--wakatime-config=".length);
    } else if (arg === "--codex-hooks") {
      options.codexHooks = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--codex-hooks=")) {
      options.codexHooks = arg.slice("--codex-hooks=".length);
    } else {
      options.rest.push(arg);
    }
  }

  return options;
}

function validateSetup(paths) {
  const failures = [];

  if (!fs.existsSync(paths.wakatimeCli)) {
    failures.push(`missing WakaTime CLI: ${paths.wakatimeCli}`);
  }

  if (!fs.existsSync(paths.wakatimeConfig)) {
    failures.push(`missing WakaTime config: ${paths.wakatimeConfig}`);
  }

  if (failures.length > 0) {
    throw new Error(`Setup check failed for ${paths.runtime}:\n- ${failures.join("\n- ")}`);
  }
}

function getSetupChecks(paths) {
  return {
    codexHooksExists: fs.existsSync(paths.codexHooks),
    wakatimeCliExists: fs.existsSync(paths.wakatimeCli),
    wakatimeConfigExists: fs.existsSync(paths.wakatimeConfig),
  };
}

async function runHook() {
  const rawInput = await readStdin();
  logDebug(`received input bytes=${rawInput.length}`);

  if (!rawInput.trim()) {
    logDebug("skipped empty input");
    writeContinue();
    return;
  }

  let payload;

  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    logDebug(`invalid hook payload=${error.message}`);
    writeContinue();
    return;
  }

  const lastAssistantMessage = payload.last_assistant_message;

  if (!lastAssistantMessage || !String(lastAssistantMessage).trim()) {
    logDebug("skipped empty assistant message");
    writeContinue();
    return;
  }

  const cwd = payload.cwd || process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const files = filterTrackableFiles(extractFiles(lastAssistantMessage, cwd), cwd, logDebug);
  logDebug(`project root=${projectRoot} extracted files=${files.length}`);

  const signature = buildSignature(files, cwd);

  if (!shouldSendHeartbeat(signature)) {
    logDebug("skipped heartbeat due to local rate limit");
    writeContinue();
    return;
  }

  let sent = false;

  if (files.length > 0) {
    sent = sendFileHeartbeats(files, cwd);
  } else {
    sent = sendProjectHeartbeat(cwd).ok;
  }

  if (sent) {
    updateLastHeartbeat(signature);
  }

  writeContinue();
}

function install(options = {}) {
  const paths = getPaths(options);
  const { codexHooks } = paths;

  if (!options.skipChecks) {
    validateSetup(paths);
  }

  const existing = readJsonSafe(codexHooks);
  const config = existing || { hooks: {} };
  const stopHooks = Array.isArray(config.hooks?.Stop) ? config.hooks.Stop : [];

  if (existing) {
    fs.writeFileSync(`${codexHooks}.bak`, `${JSON.stringify(existing, null, 2)}\n`);
  }

  const normalized = stopHooks.map((group) => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((entry) => !isOurHookEntry(entry)) : [];
    return { ...group, hooks };
  }).filter((group) => group.hooks.length > 0);

  if (normalized.length === 0) {
    normalized.push({ hooks: [buildHookEntry(paths)] });
  } else {
    normalized[0].hooks.push(buildHookEntry(paths));
  }

  config.hooks = {
    ...(config.hooks || {}),
    Stop: normalized,
  };

  writeJson(codexHooks, config);
  console.log(`Installed Codex hook at ${codexHooks}`);
}

function uninstall(options = {}) {
  const { codexHooks } = getPaths(options);
  const existing = readJsonSafe(codexHooks);

  if (!existing?.hooks?.Stop) {
    console.log("No Codex hook config found.");
    return;
  }

  const normalized = existing.hooks.Stop.map((group) => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((entry) => !isOurHookEntry(entry)) : [];
    return { ...group, hooks };
  }).filter((group) => group.hooks.length > 0);

  const nextHooks = { ...(existing.hooks || {}) };

  if (normalized.length > 0) {
    nextHooks.Stop = normalized;
  } else {
    delete nextHooks.Stop;
  }

  const nextConfig = { ...existing, hooks: nextHooks };
  writeJson(codexHooks, nextConfig);
  console.log(`Removed Codex hook entry from ${codexHooks}`);
}

function status(options = {}) {
  const paths = getPaths(options);
  const hookConfig = readJson(paths.codexHooks);

  console.log(JSON.stringify({
    version: VERSION,
    runtime: paths.runtime,
    rootDir: ROOT_DIR,
    binPath: BIN_PATH,
    codexHooks: paths.codexHooks,
    codexLog: paths.codexLog,
    stateFile: paths.stateFile,
    wakatimeCli: paths.wakatimeCli,
    wakatimePlugin: buildPluginString(),
    checks: {
      ...getSetupChecks(paths),
    },
    installedCommand: hookConfig?.hooks?.Stop?.[0]?.hooks?.[0]?.command || null,
  }, null, 2));
}

function doctor(options = {}) {
  const paths = getPaths(options);
  const checks = getSetupChecks(paths);

  console.log(JSON.stringify({
    runtime: paths.runtime,
    codexHooks: paths.codexHooks,
    wakatimeCli: paths.wakatimeCli,
    wakatimeConfig: paths.wakatimeConfig,
    wakatimePlugin: buildPluginString(),
    checks,
  }, null, 2));

  validateSetup(paths);
  console.log("Setup checks passed.");
}

function test(targetPath) {
  const cwd = targetPath || process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const result = sendProjectHeartbeat(cwd);
  console.log(JSON.stringify({
    ...result,
    project: basenameAny(projectRoot),
    projectRoot,
    cwd,
  }, null, 2));
  process.exit(result && result.ok ? 0 : 1);
}

async function run(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);

  switch (command) {
    case "hook":
      await runHook();
      return;
    case "install":
    case "setup":
      install(options);
      return;
    case "uninstall":
      uninstall(options);
      return;
    case "status":
      status(options);
      return;
    case "doctor":
      doctor(options);
      return;
    case "test":
      test(options.rest[0]);
      return;
    default:
      console.log("Usage: codex-app-wakatime <setup|install|uninstall|status|doctor|test|hook> [--skip-checks]");
  }
}

module.exports = {
  run,
  detectRuntime,
  resolveRuntimePaths,
  toHeartbeatPath,
  validateSetup,
  buildHookEntry,
  isOurHookEntry,
  buildPluginString,
  parseOptions,
  filterTrackableFiles,
};

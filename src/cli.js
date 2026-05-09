const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageJson = require("../package.json");

const VERSION = packageJson.version;
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "codex-app-wakatime.js");
const DEFAULT_WAKATIME_EDITOR = "codex";
const DEFAULT_WAKATIME_PLUGIN = "codex-wakatime";
const DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK = 30;
const MAX_TRACKED_TURNS = 100;
const HOOK_COMMAND_MARKER = "codex-app-wakatime";
const DEFAULT_CONFIG = {
  debug: false,
  maxFileHeartbeats: DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK,
};
const CONFIG_FILE_NAME = "codex-app-wakatime.config.json";
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const KNOWN_EXTENSIONLESS_FILENAMES = new Set([
  ".dockerignore",
  ".env",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  "brewfile",
  "build",
  "caddyfile",
  "containerfile",
  "copying",
  "dockerfile",
  "earthfile",
  "gemfile",
  "jenkinsfile",
  "justfile",
  "license",
  "makefile",
  "procfile",
  "rakefile",
  "readme",
  "taskfile",
  "tiltfile",
  "vagrantfile",
  "workspace",
]);
const DOMAIN_TLDS = new Set([
  "app",
  "au",
  "com",
  "dev",
  "io",
  "net",
  "org",
]);
let cachedConfig;
let activeOptions = {};

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

function canonicalizeGitWorktreePath(filePath, projectRoot, primaryRoot = getPrimaryWorktreeRoot(projectRoot)) {
  const resolvedPath = path.resolve(filePath);

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

function cleanupExtractedPath(filePath) {
  let cleaned = String(filePath || "").trim();

  const markdownLink = cleaned.match(/^\[[^\]\n]+\]\(([^)]+)\)$/);
  if (markdownLink) {
    cleaned = markdownLink[1].trim();
  }

  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  return cleaned
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/[),.;]+$/, "");
}

function isLikelyNonFileToken(filePath) {
  const cleaned = String(filePath || "").trim();
  const pathSegments = cleaned.split(/[\\/]/);
  const basename = pathSegments[pathSegments.length - 1] || "";
  const extension = path.extname(cleaned).slice(1).toLowerCase();

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) {
    return true;
  }

  if (cleaned === "process.env" || cleaned.startsWith("process.env.")) {
    return true;
  }

  if (/^(?:v)?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(cleaned)) {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleaned)) {
    return true;
  }

  if (/^@?[^/\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleaned)
    || /[/\\][^/\\\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleaned)) {
    return true;
  }

  if (!/[\\/]/.test(cleaned) && cleaned.split(".").length > 2 && DOMAIN_TLDS.has(extension)) {
    return true;
  }

  if (basename.includes("@") && /\d+\.\d+\.\d+/.test(basename)) {
    return true;
  }

  return false;
}

function isValidFilePath(filePath) {
  const cleaned = cleanupExtractedPath(filePath);

  if (!cleaned || cleaned.length === 0) {
    return false;
  }

  if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.includes("://")) {
    return false;
  }

  if (/[<>"'`|?*\[\]]/.test(cleaned)) {
    return false;
  }

  if (isLikelyNonFileToken(cleaned)) {
    return false;
  }

  const ext = path.extname(cleaned).slice(1).toLowerCase();
  const basename = basenameAny(cleaned).toLowerCase();

  if (!ext && !/[\\/]/.test(cleaned) && !KNOWN_EXTENSIONLESS_FILENAMES.has(basename)) {
    return false;
  }

  if (ext && (ext.length > 6 || /^\d+$/.test(ext))) {
    return false;
  }

  return true;
}

function normalizePath(filePath, cwd) {
  const cleaned = cleanupExtractedPath(filePath);

  if (isWindowsAbsolutePath(cleaned) && process.platform !== "win32") {
    return path.normalize(cleaned);
  }

  const candidatePath = path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)
    ? path.normalize(cleaned)
    : path.normalize(path.join(cwd, cleaned));

  return candidatePath;
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

function filterTrackableFiles(files, cwd, logger = () => {}, projectRoot = resolveProjectRoot(cwd), rawProjectRoot = projectRoot) {

  return files.map((file) => {
    if (!fs.existsSync(file.path)) {
      logger(`skipped missing extracted file path=${file.path}`);
      return null;
    }

    const stats = fs.statSync(file.path);

    if (!stats.isFile()) {
      logger(`skipped non-file extracted path=${file.path}`);
      return null;
    }

    if (!isInsideDir(file.path, rawProjectRoot)) {
      logger(`skipped extracted file outside project path=${file.path}`);
      return null;
    }

    return {
      ...file,
      path: canonicalizeGitWorktreePath(file.path, rawProjectRoot, projectRoot),
    };
  }).filter(Boolean);
}

function extractEditedFilesFromPatch(patchText, cwd) {
  if (!patchText || typeof patchText !== "string") {
    return [];
  }

  const fileMap = new Map();
  const fileHeaderPattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

  for (const match of patchText.matchAll(fileHeaderPattern)) {
    const filePath = match[1];

    if (filePath && isValidFilePath(filePath)) {
      fileMap.set(normalizePath(filePath, cwd), true);
    }
  }

  return Array.from(fileMap.keys()).map((filePath) => ({
    path: filePath,
    isWrite: true,
  }));
}

function getToolInputText(toolInput) {
  if (typeof toolInput === "string") {
    return toolInput;
  }

  if (!toolInput || typeof toolInput !== "object") {
    return "";
  }

  return [
    toolInput.command,
    toolInput.patch,
    toolInput.input,
  ].find((value) => typeof value === "string") || "";
}

function extractEditedFilesFromHookPayload(payload, cwd) {
  if (!payload || payload.hook_event_name !== "PostToolUse") {
    return [];
  }

  const toolName = String(payload.tool_name || "");

  if (!/(?:^|_)apply_patch$|^Edit$|^Write$/i.test(toolName)) {
    return [];
  }

  return extractEditedFilesFromPatch(getToolInputText(payload.tool_input), cwd);
}

function getTurnStateKey(payload) {
  if (!payload?.session_id || !payload?.turn_id) {
    return null;
  }

  return `${payload.session_id}:${payload.turn_id}`;
}

function mergeFiles(existingFiles, newFiles) {
  const fileMap = new Map();

  for (const file of [...existingFiles, ...newFiles]) {
    if (file?.path) {
      fileMap.set(file.path, {
        path: file.path,
        isWrite: Boolean(file.isWrite),
      });
    }
  }

  return Array.from(fileMap.values());
}

function getTurnFilesPath(turnKey) {
  const encodedKey = Buffer.from(turnKey).toString("base64url");
  return path.join(getTurnFilesDirPath(), `${encodedKey}.jsonl`);
}

function getTurnFilesDir() {
  return getTurnFilesDirPath();
}

function pruneQueuedTurnFiles() {
  const dirPath = getTurnFilesDir();

  if (!fs.existsSync(dirPath)) {
    return;
  }

  const files = fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const filePath = path.join(dirPath, name);
      return {
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const file of files.slice(MAX_TRACKED_TURNS)) {
    fs.unlinkSync(file.filePath);
  }
}

function appendTurnFiles(turnKey, files) {
  if (!turnKey || files.length === 0) {
    return;
  }

  const filePath = getTurnFilesPath(turnKey);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify({
    updatedAt: Math.floor(Date.now() / 1000),
    files,
  })}\n`);
}

function readQueuedTurnFiles(turnKey) {
  if (!turnKey) {
    return [];
  }

  const filePath = getTurnFilesPath(turnKey);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const files = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (Array.isArray(entry.files)) {
        files.push(...entry.files);
      }
    } catch {
      // Ignore a partial line if a hook process was interrupted mid-write.
    }
  }

  return mergeFiles([], files);
}

function clearQueuedTurnFiles(turnKey) {
  if (!turnKey) {
    return;
  }

  const filePath = getTurnFilesPath(turnKey);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function rememberTurnFiles(payload, files) {
  const turnKey = getTurnStateKey(payload);

  appendTurnFiles(turnKey, files);
}

function readTurnFiles(payload, state = readState()) {
  const turnKey = getTurnStateKey(payload);

  if (!turnKey) {
    return [];
  }

  pruneQueuedTurnFiles();

  const files = state.turnFiles?.[turnKey]?.files;
  return mergeFiles(
    Array.isArray(files) ? files : [],
    readQueuedTurnFiles(turnKey)
  );
}

function clearTurnFiles(payload, state = readState()) {
  const turnKey = getTurnStateKey(payload);

  if (!turnKey) {
    return;
  }

  clearQueuedTurnFiles(turnKey);

  if (!state.turnFiles?.[turnKey]) {
    return;
  }

  const turnFiles = { ...state.turnFiles };
  delete turnFiles[turnKey];
  writeState({
    ...state,
    turnFiles,
  });
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

function toReadableHostPath(filePath) {
  if (process.platform !== "win32" && isWindowsAbsolutePath(filePath)) {
    return toWindowsWslPath(filePath);
  }

  return filePath;
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

function findCommand(command) {
  if (!command) {
    return null;
  }

  const result = process.platform === "win32"
    ? spawnSync("where", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    : spawnSync("/bin/sh", ["-c", "command -v \"$1\"", "sh", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

  if (result.status !== 0) {
    return null;
  }

  const resolved = result.stdout.trim().split(/\r?\n/)[0];
  return resolved || null;
}

function commandExists(command) {
  return Boolean(findCommand(command));
}

function commandOrFileExists(command) {
  if (!command) {
    return false;
  }

  if (path.isAbsolute(command) || isWindowsAbsolutePath(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }

  return commandExists(command);
}

function findNativeWakatimeCli(homeDir, options = {}) {
  if (options.wakatimeCli) {
    return options.wakatimeCli;
  }

  if (process.env.WAKATIME_CLI_PATH) {
    return process.env.WAKATIME_CLI_PATH;
  }

  const globalCandidates = [
    findCommand("wakatime-cli"),
    "/opt/homebrew/bin/wakatime-cli",
    "/usr/local/bin/wakatime-cli",
  ].filter(Boolean);
  const globalExisting = globalCandidates.find((candidate) => fs.existsSync(candidate));

  if (globalExisting) {
    return globalExisting;
  }

  const localCandidates = [
    path.join(homeDir, ".wakatime", "wakatime-cli"),
    path.join(homeDir, ".wakatime", getDarwinWakatimeCliName(options.arch)),
  ];
  const localExisting = localCandidates.find((candidate) => fs.existsSync(candidate));

  return localExisting || localCandidates[localCandidates.length - 1];
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
      configFile: options.configFile || path.join(homeDir, ".wakatime", CONFIG_FILE_NAME),
      wakatimeLog: options.wakatimeLog || path.join(homeDir, ".wakatime", "wakatime.log"),
      stateFile: options.stateFile || path.join(homeDir, ".wakatime", "codex-app-wakatime.json"),
      turnFilesDir: options.turnFilesDir || path.join(homeDir, ".wakatime", "codex-app-wakatime-turns"),
      codexHooks: options.codexHooks || path.join(homeDir, ".codex", "hooks.json"),
      codexLog: options.codexLog || path.join(homeDir, ".codex", "codex-app-wakatime.log"),
    };
  }

  const windowsHome = options.windowsHome || findWindowsUserDir();

  if (!windowsHome) {
    throw new Error(`Unable to find the Windows user profile needed for the ${runtime} runtime.`);
  }

  const isWindowsRuntime = runtime === "windows";
  const homeDir = options.homeDir || os.homedir();
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
    configFile: options.configFile || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", CONFIG_FILE_NAME)
      : path.posix.join(homeDir, ".wakatime", CONFIG_FILE_NAME)),
    wakatimeLog: options.wakatimeLog || path.win32.join(windowsHome.win, ".wakatime", "wakatime.log"),
    stateFile: options.stateFile || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", "codex-app-wakatime.json")
      : path.posix.join(windowsHome.wsl, ".wakatime", "codex-app-wakatime.json")),
    turnFilesDir: options.turnFilesDir || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", "codex-app-wakatime-turns")
      : path.posix.join(homeDir, ".wakatime", "codex-app-wakatime-turns")),
    codexHooks: options.codexHooks || codexHooks,
    codexLog: options.codexLog || codexLog,
  };
}

function getPaths(options = {}) {
  return resolveRuntimePaths(options);
}

function getConfigFilePath(options = {}) {
  if (options.configFile) {
    return options.configFile;
  }

  if (activeOptions.configFile) {
    return activeOptions.configFile;
  }

  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, ".wakatime", CONFIG_FILE_NAME);
}

function getStateFilePath(options = {}) {
  if (options.stateFile) {
    return options.stateFile;
  }

  if (activeOptions.stateFile) {
    return activeOptions.stateFile;
  }

  return getPaths(options).stateFile;
}

function getTurnFilesDirPath(options = {}) {
  if (options.turnFilesDir) {
    return options.turnFilesDir;
  }

  if (activeOptions.turnFilesDir) {
    return activeOptions.turnFilesDir;
  }

  return getPaths(options).turnFilesDir || path.join(path.dirname(getStateFilePath(options)), "codex-app-wakatime-turns");
}

function readConfig(options = {}) {
  if (!options.configFile && cachedConfig) {
    return cachedConfig;
  }

  const config = readJsonSafe(toReadableHostPath(getConfigFilePath(options))) || {};
  const normalized = {
    ...DEFAULT_CONFIG,
  };

  if (typeof config.debug === "boolean") {
    normalized.debug = config.debug;
  }

  if (Object.prototype.hasOwnProperty.call(config, "maxFileHeartbeats")) {
    normalized.maxFileHeartbeats = config.maxFileHeartbeats;
  }

  if (!options.configFile) {
    cachedConfig = normalized;
  }

  return normalized;
}

function ensureConfigFile(paths) {
  const readableConfigFile = toReadableHostPath(paths.configFile);

  if (!fs.existsSync(readableConfigFile)) {
    writeJson(readableConfigFile, DEFAULT_CONFIG);
  }
}

function isDebugEnabled() {
  return readConfig().debug === true;
}

function logDebug(message) {
  if (!isDebugEnabled()) {
    return;
  }

  const codexLog = activeOptions.codexLog || getPaths().codexLog;
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

function writeOk() {
  process.stdout.write("{}");
}

function readState() {
  const stateFile = getStateFilePath();

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
  const stateFile = getStateFilePath();
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function shouldSendHeartbeat(signature, force = false, state = readState()) {
  if (force) {
    return true;
  }

  const lastHeartbeatAt = state.lastHeartbeatAt || 0;
  const lastSignature = state.lastSignature || "";
  const elapsed = Math.floor(Date.now() / 1000) - lastHeartbeatAt;

  if (elapsed >= 60) {
    return true;
  }

  return signature !== lastSignature;
}

function updateLastHeartbeat(signature, state = readState()) {
  writeState({
    ...state,
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

  if (!commandOrFileExists(paths.wakatimeCli)) {
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

function sendProjectHeartbeat(cwd, projectRoot = resolveProjectRoot(cwd)) {
  const project = basenameAny(projectRoot);
  return sendHeartbeat({
    entity: "Codex",
    entityType: "app",
    project,
  });
}

function getMaxFileHeartbeats() {
  const configuredLimit = Number(readConfig().maxFileHeartbeats);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK;
}

function limitFilesForHeartbeats(files) {
  return files.slice(0, getMaxFileHeartbeats());
}

function sendFileHeartbeats(files, cwd, projectRoot = resolveProjectRoot(cwd)) {
  const paths = getPaths();
  const heartbeatProjectFolder = toHeartbeatPath(projectRoot, paths);
  const filesToSend = limitFilesForHeartbeats(files);
  let sentCount = 0;

  if (files.length > filesToSend.length) {
    logDebug(`limiting file heartbeats sent=${filesToSend.length} extracted=${files.length}`);
  }

  for (const file of filesToSend) {
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

function buildHookEntry(paths = getPaths(), options = {}) {
  const quotedBinPath = paths.runtime === "windows"
    ? quoteWindowsShellArg(BIN_PATH)
    : quotePosixShellArg(BIN_PATH);
  const quoteArg = paths.runtime === "windows" ? quoteWindowsShellArg : quotePosixShellArg;
  const commandParts = [
    "node",
    quotedBinPath,
    "hook",
  ];

  for (const [flag, value] of [
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

function isOurHookEntry(entry) {
  return entry
    && entry.type === "command"
    && typeof entry.command === "string"
    && entry.command.includes(HOOK_COMMAND_MARKER)
    && /\bhook\b/.test(entry.command);
}

function removeOurHookEntries(groups = []) {
  return groups.map((group) => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((entry) => !isOurHookEntry(entry)) : [];
    return { ...group, hooks };
  }).filter((group) => group.hooks.length > 0);
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
    } else if (arg === "--state-file") {
      options.stateFile = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--state-file=")) {
      options.stateFile = arg.slice("--state-file=".length);
    } else if (arg === "--turn-files-dir") {
      options.turnFilesDir = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--turn-files-dir=")) {
      options.turnFilesDir = arg.slice("--turn-files-dir=".length);
    } else if (arg === "--config-file") {
      options.configFile = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--config-file=")) {
      options.configFile = arg.slice("--config-file=".length);
    } else if (arg === "--codex-log") {
      options.codexLog = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--codex-log=")) {
      options.codexLog = arg.slice("--codex-log=".length);
    } else {
      options.rest.push(arg);
    }
  }

  return options;
}

function validateSetup(paths) {
  const failures = [];

  if (!commandOrFileExists(paths.wakatimeCli)) {
    failures.push(`missing WakaTime CLI: ${paths.wakatimeCli}`);
  }

  if (!fs.existsSync(toReadableHostPath(paths.wakatimeConfig))) {
    failures.push(`missing WakaTime config: ${paths.wakatimeConfig}`);
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
    codexHooksExists: fs.existsSync(paths.codexHooks),
    wakatimeCliExists: commandOrFileExists(paths.wakatimeCli),
    wakatimeConfigExists: fs.existsSync(toReadableHostPath(paths.wakatimeConfig)),
  };
}

async function runHook(options = {}) {
  activeOptions = options;
  const rawInput = await readStdin();

  if (!rawInput.trim()) {
    writeContinue();
    return;
  }

  let payload;

  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    writeContinue();
    return;
  }

  const cwd = payload.cwd || process.cwd();
  const eventName = payload.hook_event_name;

  if (eventName === "PostToolUse") {
    const files = extractEditedFilesFromHookPayload(payload, cwd);

    if (files.length > 0) {
      rememberTurnFiles(payload, files);
    }

    writeOk();
    return;
  }

  logDebug(`received input bytes=${rawInput.length}`);

  if (eventName && eventName !== "Stop") {
    logDebug(`skipped unsupported hook event=${eventName}`);
    writeOk();
    return;
  }

  const state = readState();
  const rememberedFiles = readTurnFiles(payload, state);

  const rawProjectRoot = resolveProjectRootRaw(cwd);
  const projectRoot = getPrimaryWorktreeRoot(rawProjectRoot);
  const files = filterTrackableFiles(rememberedFiles, cwd, logDebug, projectRoot, rawProjectRoot);
  logDebug(`project root=${projectRoot} tracked edited files=${files.length}`);

  const signature = buildSignature(files, cwd);

  if (!shouldSendHeartbeat(signature, false, state)) {
    logDebug("skipped heartbeat due to local rate limit");
    clearTurnFiles(payload, state);
    writeContinue();
    return;
  }

  let sent = false;

  if (files.length > 0) {
    sent = sendFileHeartbeats(files, cwd, projectRoot);
  } else {
    sent = sendProjectHeartbeat(cwd, projectRoot).ok;
  }

  if (sent) {
    updateLastHeartbeat(signature, state);
  }

  clearTurnFiles(payload, state);
  writeContinue();
}

function install(options = {}) {
  const paths = getPaths(options);
  const { codexHooks } = paths;

  ensureConfigFile(paths);

  if (!options.skipChecks) {
    warnOnInvalidSetup(paths);
  }

  const existing = readJsonSafe(codexHooks);
  const config = existing || { hooks: {} };
  const stopHooks = Array.isArray(config.hooks?.Stop) ? config.hooks.Stop : [];
  const postToolUseHooks = Array.isArray(config.hooks?.PostToolUse) ? config.hooks.PostToolUse : [];

  if (existing) {
    fs.writeFileSync(`${codexHooks}.bak`, `${JSON.stringify(existing, null, 2)}\n`);
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

function uninstall(options = {}) {
  const { codexHooks } = getPaths(options);
  const existing = readJsonSafe(codexHooks);

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
    turnFilesDir: paths.turnFilesDir,
    configFile: paths.configFile,
    config: readConfig({ configFile: paths.configFile }),
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
    configFile: paths.configFile,
    turnFilesDir: paths.turnFilesDir,
    config: readConfig({ configFile: paths.configFile }),
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
      await runHook(options);
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
  warnOnInvalidSetup,
  install,
  buildHookEntry,
  isOurHookEntry,
  buildPluginString,
  parseOptions,
  toReadableHostPath,
  extractEditedFilesFromPatch,
  extractEditedFilesFromHookPayload,
  limitFilesForHeartbeats,
  filterTrackableFiles,
};

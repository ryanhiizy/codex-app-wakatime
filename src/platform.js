const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isWindowsAbsolutePath } = require("./files");
const CONFIG_FILE_NAME = "codex-app-wakatime.config.json";

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

  const mountedDrive = posixPath.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (mountedDrive) return `${mountedDrive[1].toUpperCase()}:\\${(mountedDrive[2] || "").replace(/\//g, "\\")}`;
  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

function toHeartbeatPath(filePath, paths = resolveRuntimePaths()) {
  if (paths.runtime === "wsl" && filePath.startsWith("/")) {
    return wslToUnc(filePath, paths.distro);
  }

  return filePath;
}

function toWindowsWslPath(windowsPath) {
  return windowsPath.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

function toReadableHostPath(filePath) {
  if (process.platform !== "win32" && isWindowsAbsolutePath(filePath)) {
    return toWindowsWslPath(filePath);
  }

  return filePath;
}

function findWindowsUserDir() {
  const explicitWindowsHome = process.env.WAKATIME_WINDOWS_HOME || process.env.USERPROFILE;

  if (explicitWindowsHome && /^[A-Za-z]:[\\/]/.test(explicitWindowsHome)) {
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

  if (platform === "linux") {
    const wsl = options.isWsl ?? Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
    return wsl ? "wsl" : "linux";
  }

  throw new Error("Unable to auto-detect supported runtime. Expected macOS, Linux, Windows, or WSL.");
}

function getDarwinWakatimeCliName(arch = process.arch) {
  if (arch === "arm64") {
    return "wakatime-cli-darwin-arm64";
  }

  return "wakatime-cli-darwin-amd64";
}

function findCommand(command) {
  if (!command) return null;
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  const directories = command.includes("/") || command.includes("\\")
    ? [""] : (process.env.PATH || "").split(path.delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), command + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH candidate. */ }
    }
  }
  return null;
}

function commandExists(command) {
  return Boolean(findCommand(command));
}

function commandOrFileExists(command) {
  if (!command) {
    return false;
  }

  if (path.isAbsolute(command) || isWindowsAbsolutePath(command) || command.includes("/") || command.includes("\\")) {
    try {
      return fs.statSync(command).isFile();
    } catch { return false; }
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

  const runtime = detectRuntime(options);
  const globalCandidates = [
    findCommand("wakatime-cli"),
    ...(runtime === "macos" ? ["/opt/homebrew/bin/wakatime-cli", "/usr/local/bin/wakatime-cli"] : []),
  ].filter(Boolean);
  const globalExisting = globalCandidates.find((candidate) => fs.existsSync(candidate));

  if (globalExisting) {
    return globalExisting;
  }

  const localCandidates = [
    path.join(homeDir, ".wakatime", "wakatime-cli"),
    path.join(homeDir, ".wakatime", runtime === "linux"
      ? `wakatime-cli-linux-${getLinuxArch(options.arch)}`
      : getDarwinWakatimeCliName(options.arch)),
  ];
  const localExisting = localCandidates.find((candidate) => fs.existsSync(candidate));

  return localExisting || localCandidates[localCandidates.length - 1];
}

function getLinuxArch(arch = process.arch) {
  const names = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" };
  return names[arch] || arch;
}

function resolveRuntimePaths(options = {}) {
  return resolvePlatformPaths(options);
}

function resolvePlatformPaths(options = {}) {
  const runtime = detectRuntime(options);

  if (runtime === "macos" || runtime === "linux") {
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

module.exports = { quotePosixShellArg, quoteWindowsShellArg, wslToUnc, toHeartbeatPath, toWindowsWslPath, toReadableHostPath, findWindowsUserDir, detectRuntime, getDarwinWakatimeCliName, findCommand, commandExists, commandOrFileExists, findNativeWakatimeCli, getLinuxArch, resolveRuntimePaths, resolvePlatformPaths, isWsl, buildWakatimeLaunch };

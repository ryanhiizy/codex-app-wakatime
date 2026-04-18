const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VERSION = "0.1.0";
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "codex-app-wakatime.js");

function basenameAny(value) {
  return String(value || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "project";
}

function wslToUnc(posixPath) {
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";

  if (!posixPath || !posixPath.startsWith("/")) {
    return posixPath;
  }

  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
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

  const defaultDir = process.platform === "win32" ? "C:\\Users\\User" : "/mnt/c/Users/User";

  if (fs.existsSync(defaultDir)) {
    return {
      win: "C:\\Users\\User",
      wsl: toWindowsWslPath("C:\\Users\\User"),
    };
  }

  if (process.platform === "win32") {
    return null;
  }

  const usersRoot = "/mnt/c/Users";
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

  const match = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))[0];

  if (!match) {
    return null;
  }

  return {
    win: `C:\\Users\\${match.name}`,
    wsl: path.posix.join(usersRoot, match.name),
  };
}

function getPaths() {
  const windowsHome = findWindowsUserDir();

  if (!windowsHome) {
    throw new Error("Unable to find the Windows user profile needed for WakaTime.");
  }

  const wakatimeCli = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".wakatime", "wakatime-cli-windows-amd64.exe")
    : path.posix.join(windowsHome.wsl, ".wakatime", "wakatime-cli-windows-amd64.exe");

  const codexHooks = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".codex", "hooks.json")
    : path.posix.join(windowsHome.wsl, ".codex", "hooks.json");

  const codexLog = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".codex", "codex-app-wakatime.log")
    : path.posix.join(windowsHome.wsl, ".codex", "codex-app-wakatime.log");

  return {
    windowsHome,
    wakatimeCli,
    wakatimeConfig: `${windowsHome.win}\\.wakatime.cfg`,
    wakatimeLog: `${windowsHome.win}\\.wakatime\\wakatime.log`,
    codexHooks,
    codexLog,
  };
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

function sendHeartbeat(entityPath) {
  const paths = getPaths();
  const rawCwd = entityPath || process.cwd();
  const project = basenameAny(rawCwd);
  const entity = "Codex App";

  if (!fs.existsSync(paths.wakatimeCli)) {
    logDebug(`missing wakatime cli at ${paths.wakatimeCli}`);
    return { ok: false, reason: "missing_wakatime_cli" };
  }

  const args = [
    "--entity",
    entity,
    "--entity-type",
    "app",
    "--category",
    "ai coding",
    "--plugin",
    `codex-app/1.0.0 codex-app-wakatime/${VERSION}`,
    "--project",
    project,
    "--config",
    paths.wakatimeConfig,
    "--log-file",
    paths.wakatimeLog,
    "--heartbeat-rate-limit-seconds",
    "60",
    "--timeout",
    "30",
    "--sync-ai-disabled",
  ];

  const result = spawnSync(paths.wakatimeCli, args, {
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

  logDebug(`heartbeat sent cwd=${rawCwd}`);
  return { ok: true, project, cwd: rawCwd, entity };
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

  sendHeartbeat(payload.cwd || process.cwd());
  writeContinue();
}

function buildHookConfig() {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${BIN_PATH} hook`,
              timeout: 30,
              statusMessage: "Sending WakaTime heartbeat",
            },
          ],
        },
      ],
    },
  };
}

function install() {
  const { codexHooks } = getPaths();
  const existing = readJson(codexHooks);

  if (existing) {
    fs.writeFileSync(`${codexHooks}.bak`, `${JSON.stringify(existing, null, 2)}\n`);
  }

  writeJson(codexHooks, buildHookConfig());
  console.log(`Installed Codex hook at ${codexHooks}`);
}

function status() {
  const paths = getPaths();
  const hookConfig = readJson(paths.codexHooks);

  console.log(JSON.stringify({
    version: VERSION,
    rootDir: ROOT_DIR,
    binPath: BIN_PATH,
    codexHooks: paths.codexHooks,
    codexLog: paths.codexLog,
    wakatimeCli: paths.wakatimeCli,
    installedCommand: hookConfig?.hooks?.Stop?.[0]?.hooks?.[0]?.command || null,
  }, null, 2));
}

function test(targetPath) {
  const result = sendHeartbeat(targetPath || process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

async function run(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case "hook":
      await runHook();
      return;
    case "install":
      install();
      return;
    case "status":
      status();
      return;
    case "test":
      test(rest[0]);
      return;
    default:
      console.log("Usage: codex-app-wakatime <install|status|test|hook>");
  }
}

module.exports = {
  run,
};

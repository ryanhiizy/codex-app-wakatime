const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { toReadableHostPath, resolveRuntimePaths } = require("./platform");
const DEFAULT_CONFIG = Object.freeze({ debug: false, maxFileHeartbeats: 30 });

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readJsonSafe(filePath) {
  try { return readJson(filePath); } catch { return null; }
}

function readWakatimeConfigSetting(filePath, key) {
  const readablePath = toReadableHostPath(filePath);

  if (!fs.existsSync(readablePath)) {
    return null;
  }

  let inSettingsSection = false;
  let value = null;

  for (const line of fs.readFileSync(readablePath, "utf8").split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (section) {
      inSettingsSection = section[1].toLowerCase() === "settings";
      continue;
    }

    if (!inSettingsSection) {
      continue;
    }

    const setting = line.match(/^\s*([^#;=\s]+)\s*=\s*(.*?)\s*$/);

    if (setting && setting[1] === key) {
      value = setting[2].replace(/\s+[#;].*$/, "").trim();
    }
  }

  return value;
}

function setWakatimeConfigSetting(filePath, key, value) {
  const readablePath = toReadableHostPath(filePath);
  const existingText = fs.existsSync(readablePath) ? fs.readFileSync(readablePath, "utf8") : "";
  const lines = existingText.split(/\r?\n/);
  const hasTrailingNewline = existingText.endsWith("\n") || existingText === "";
  const settingsHeaderIndex = lines.findIndex((line) => /^\s*\[settings\]\s*$/i.test(line));

  if (settingsHeaderIndex === -1) {
    const prefix = [`[settings]`, `${key} = ${value}`, ""];
    const nextLines = existingText.trim() ? [...prefix, ...lines] : prefix;
    ensureDir(path.dirname(readablePath));
    writeText(readablePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
    return;
  }

  let inSettings = false;
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) inSettings = section[1].toLowerCase() === "settings";
    const setting = lines[index].match(/^\s*([^#;=\s]+)\s*=/);
    if (inSettings && setting?.[1] === key) {
      lines[index] = `${key} = ${value}`;
      replaced = true;
    }
  }

  if (!replaced) lines.splice(settingsHeaderIndex + 1, 0, `${key} = ${value}`);
  ensureDir(path.dirname(readablePath));
  writeText(readablePath, `${lines.join("\n").replace(/\n+$/, "")}${hasTrailingNewline ? "\n" : ""}`);
}

function isWakatimeAiSyncDisabled(paths = resolveRuntimePaths()) {
  return /^(true|yes|on|1)$/i.test(readWakatimeConfigSetting(paths.wakatimeConfig, "sync_ai_disabled") || "");
}

function ensureWakatimeAiSyncEnabled(paths = resolveRuntimePaths()) {
  const readablePath = toReadableHostPath(paths.wakatimeConfig);

  if (!fs.existsSync(readablePath)) {
    return false;
  }

  if (!isWakatimeAiSyncDisabled(paths)) {
    return false;
  }

  setWakatimeConfigSetting(paths.wakatimeConfig, "sync_ai_disabled", "false");
  return true;
}

function ensureConfigFile(paths) {
  const readableConfigFile = toReadableHostPath(paths.configFile);

  if (!fs.existsSync(readableConfigFile)) {
    writeJson(readableConfigFile, DEFAULT_CONFIG);
  }
}

function readConfig(filePath) {
  const config = readJsonSafe(toReadableHostPath(filePath));
  const limit = Math.floor(Number(config?.maxFileHeartbeats));
  return {
    debug: config?.debug === true,
    maxFileHeartbeats: Number.isSafeInteger(limit) && limit >= 1 ? limit : DEFAULT_CONFIG.maxFileHeartbeats,
  };
}

module.exports = { DEFAULT_CONFIG, ensureDir, writeText, writeJson, readJson, readJsonSafe,
  readConfig, ensureConfigFile, readWakatimeConfigSetting, setWakatimeConfigSetting,
  isWakatimeAiSyncDisabled, ensureWakatimeAiSyncEnabled };

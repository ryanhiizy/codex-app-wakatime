const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { ensureDir, readJsonSafe, writeJson, readConfig } = require("./config");
const { getTurnStateKey, mergeFiles } = require("./files");

function unlinkIfPresent(filePath) {
  try { fs.unlinkSync(filePath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error.code !== "ESRCH";
  }
}

function parseQueue(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (Array.isArray(entry?.files)) files.push(...entry.files);
    } catch { /* Interrupted writes must not invalidate the other records. */ }
  }
  return mergeFiles([], files);
}

function createStore(getPaths) {
  let config;
  const getConfig = () => config ||= readConfig(getPaths().configFile);
  const queueDir = () => getPaths().turnFilesDir;
  const queuePath = (key) => path.join(queueDir(), `${createHash("sha256").update(key).digest("hex")}.jsonl`);
  const legacyPath = (key) => {
    const encoded = Buffer.from(key).toString("base64url");
    return encoded.length < 240 ? path.join(queueDir(), `${encoded}.jsonl`) : null;
  };
  const logDebug = (message) => {
    if (!getConfig().debug) return;
    try {
      const log = getPaths().codexLog;
      ensureDir(path.dirname(log));
      fs.appendFileSync(log, `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* Diagnostics must not break the host app's hook. */ }
  };
  const readState = () => {
    const value = readJsonSafe(getPaths().stateFile);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const shouldSend = (signature, state = readState()) => {
    const elapsed = Math.floor(Date.now() / 1000) - Number(state.lastHeartbeatAt || 0);
    return !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 60 || signature !== state.lastSignature;
  };
  const forgetLegacy = (key, state) => {
    if (!key || !state.turnFiles?.[key]) return state;
    const turnFiles = { ...state.turnFiles };
    delete turnFiles[key];
    return { ...state, turnFiles };
  };
  const recordHeartbeat = (signature, payload) => {
    const state = forgetLegacy(getTurnStateKey(payload), readState());
    writeJson(getPaths().stateFile, { ...state,
      lastHeartbeatAt: Math.floor(Date.now() / 1000), lastSignature: signature,
    });
  };
  const remember = (payload, files) => {
    const key = getTurnStateKey(payload);
    if (!key || !files.length) return;
    ensureDir(queueDir());
    // A leading newline isolates this record from an interrupted prior append.
    fs.appendFileSync(queuePath(key), `\n${JSON.stringify({ files })}\n`, { mode: 0o600 });
  };
  const prune = (protectedNames = []) => {
    let entries;
    try { entries = fs.readdirSync(queueDir()); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const queued = entries.filter((name) => name.endsWith(".jsonl") && !protectedNames.includes(name))
      .flatMap((name) => {
        const filePath = path.join(queueDir(), name);
        try { return [{ filePath, mtime: fs.statSync(filePath).mtimeMs }]; } catch (error) {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      }).sort((a, b) => b.mtime - a.mtime);
    for (const entry of queued.slice(100)) unlinkIfPresent(entry.filePath);
  };
  const claim = (payload, state = readState()) => {
    const key = getTurnStateKey(payload);
    if (!key) return { files: [], finish() {} };
    const names = [queuePath(key), legacyPath(key)].filter(Boolean);
    const claimed = [];
    const take = (filePath) => {
      const temporary = `${queuePath(key)}.${process.pid}.${randomUUID()}.processing`;
      try { fs.renameSync(filePath, temporary); } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      claimed.push({ filePath: temporary, text: fs.readFileSync(temporary, "utf8") });
    };
    for (const filePath of names) take(filePath);
    // Recover a snapshot abandoned when a hook was killed. A live hook owns its snapshot.
    if (fs.existsSync(queueDir())) {
      for (const name of fs.readdirSync(queueDir())) {
        const prefix = names.find((filePath) => name.startsWith(`${path.basename(filePath)}.`));
        if (!prefix || !name.endsWith(".processing")) continue;
        const pid = Number(name.slice(path.basename(prefix).length + 1).split(".")[0]);
        if (Number.isInteger(pid) && pid > 0 && !processIsAlive(pid)) take(path.join(queueDir(), name));
      }
    }
    const legacy = state.turnFiles?.[key]?.files;
    const files = mergeFiles(Array.isArray(legacy) ? legacy : [], claimed.flatMap((entry) => parseQueue(entry.text)));
    let finished = false;
    return {
      files,
      finish(success) {
        if (finished) return;
        finished = true;
        for (const entry of claimed) {
          if (!success) fs.appendFileSync(queuePath(key), `\n${entry.text.trimEnd()}\n`, { mode: 0o600 });
          unlinkIfPresent(entry.filePath);
        }
        if (success) {
          const fresh = readState();
          if (fresh.turnFiles?.[key]) writeJson(getPaths().stateFile, forgetLegacy(key, fresh));
        }
        prune(names.map((filePath) => path.basename(filePath)));
      },
    };
  };
  return { getConfig, logDebug, readState, shouldSend, recordHeartbeat, remember, claim };
}

module.exports = { createStore, parseQueue };

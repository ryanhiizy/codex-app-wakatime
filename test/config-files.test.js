const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./helpers.cjs");
const { readConfig, writeJson, readWakatimeConfigSetting, ensureWakatimeAiSyncEnabled } = require("../src/config");
const { parseOptions, isOurHookEntry } = require("../src/cli");
const { extractEditedFilesFromPatch, filterTrackableFiles, resolveProjectRootRaw,
  getPrimaryWorktreeRoot, isInsideDir, getTurnStateKey } = require("../src/files");

test("configuration normalizes invalid limits without leaking between files", (t) => {
  const f = fixture(t);
  for (const maximum of [0.5, 0, -1, "invalid", null, [], 1e100]) {
    fs.writeFileSync(f.settings, JSON.stringify({ maxFileHeartbeats: maximum }));
    assert.equal(readConfig(f.settings).maxFileHeartbeats, 30);
  }
  fs.writeFileSync(f.settings, '{"maxFileHeartbeats":2,"debug":true}');
  assert.deepEqual(readConfig(f.settings), { debug: true, maxFileHeartbeats: 2 });
  fs.writeFileSync(f.settings, "null");
  assert.deepEqual(readConfig(f.settings), { debug: false, maxFileHeartbeats: 30 });
});

test("enabling transcript sync handles commented booleans and duplicate settings", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.config, "[SETTINGS]\nsync_ai_disabled = false\nsync_ai_disabled = YES ; disabled\n[other]\nsync_ai_disabled = true\n[settings]\nsync_ai_disabled = ON\n");
  assert.equal(ensureWakatimeAiSyncEnabled({ wakatimeConfig: f.config }), true);
  assert.equal(readWakatimeConfigSetting(f.config, "sync_ai_disabled"), "false");
  assert.match(fs.readFileSync(f.config, "utf8"), /\[other\]\nsync_ai_disabled = true/);
  assert.equal(ensureWakatimeAiSyncEnabled({ wakatimeConfig: f.config }), false);
});

test("atomic config writes preserve symlink destinations and permissions", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const target = path.join(f.home, "target.json");
  const link = path.join(f.home, "link.json");
  fs.writeFileSync(target, "{}", { mode: 0o640 });
  fs.symlinkSync(target, link);
  writeJson(link, { enabled: true });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { enabled: true });
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(fs.readdirSync(f.home).some((name) => name.endsWith(".tmp")), false);
});

test("invalid hook config fails before changing any settings", (t) => {
  const f = fixture(t);
  const hookFile = path.join(f.home, "hooks.json");
  fs.writeFileSync(f.config, "[settings]\nsync_ai_disabled = true\n");
  for (const invalid of [null, [], { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{}] } }]) {
    const original = JSON.stringify(invalid);
    fs.writeFileSync(hookFile, original);
    const result = f.run(["install"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid hooks configuration/);
    assert.equal(fs.readFileSync(hookFile, "utf8"), original);
    assert.match(fs.readFileSync(f.config, "utf8"), /sync_ai_disabled = true/);
  }
});

test("install and uninstall preserve unrelated hook groups and metadata", (t) => {
  const f = fixture(t);
  const hooks = path.join(f.home, "hooks.json");
  const untouched = { matcher: "untouched", hooks: [], extra: true };
  const other = { type: "command", command: "node /codex-app-wakatime/unrelated.js hook" };
  fs.writeFileSync(hooks, JSON.stringify({ metadata: "keep", hooks: {
    Stop: [untouched, { matcher: "mixed", extra: 42, hooks: [other,
      { type: "command", command: "node '/old/bin/codex-app-wakatime.js' hook" }] }],
    SessionStart: [{ hooks: [other] }],
  } }));
  assert.equal(f.run(["install"]).status, 0);
  assert.equal(f.run(["install"]).status, 0);
  assert.equal(f.run(["uninstall"]).status, 0);
  const result = JSON.parse(fs.readFileSync(hooks));
  assert.deepEqual(result.hooks.Stop, [untouched, { matcher: "mixed", extra: 42, hooks: [other] }]);
  assert.equal(result.metadata, "keep");
  assert.deepEqual(result.hooks.SessionStart, [{ hooks: [other] }]);
  assert.equal(isOurHookEntry(other), false);
});

test("every value option rejects missing arguments, while -- preserves literal positional paths", () => {
  for (const flag of ["--app", "--home", "--wakatime-cli", "--wakatime-config", "--wakatime-log",
    "--codex-hooks", "--cursor-hooks", "--state-file", "--turn-files-dir", "--config-file", "--codex-log"]) {
    assert.throws(() => parseOptions([flag]), /Missing value/);
    assert.throws(() => parseOptions([flag, "--skip-checks"]), /Missing value/);
  }
  assert.throws(() => parseOptions(["--typo"]), /Unknown option/);
  assert.deepEqual(parseOptions(["--", "--literal-folder"]).rest, ["--literal-folder"]);
});

test("exact patch filenames allow routing brackets, apostrophes and long extensions", (t) => {
  const f = fixture(t);
  const names = ["[id].tsx", "owner's file.js", "layout.svelte", "..hidden.js"];
  names.forEach((name) => fs.writeFileSync(path.join(f.home, name), ""));
  const extracted = extractEditedFilesFromPatch(names.map((name) => `*** Update File: ${name}\r\n`).join(""), f.home);
  assert.deepEqual(filterTrackableFiles(extracted, f.home).map((item) => path.basename(item.path)), names);
  assert.equal(isInsideDir(path.join(f.home, "..hidden.js"), f.home), true);
  assert.equal(isInsideDir(path.resolve(f.home, "../outside.js"), f.home), false);
  assert.equal(resolveProjectRootRaw(path.join(f.home, names[0])), f.home);
  assert.equal(getTurnStateKey({ session_id: {}, turn_id: "t" }), null);
});

test("linked worktrees retain a readable local file for newly created canonical entities", (t) => {
  const f = fixture(t);
  const repo = path.join(f.home, "repo");
  const worktree = path.join(f.home, "worktree");
  fs.mkdirSync(repo);
  function git(...args) {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial");
  git("worktree", "add", "--detach", worktree);
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]));
  const created = path.join(worktree, "new.js");
  fs.writeFileSync(created, "const value = 1;\n");
  // Git can expand a Windows 8.3 alias. Compare directory identity, not spelling.
  const primary = getPrimaryWorktreeRoot(worktree);
  assert.equal(fs.statSync(primary).dev, fs.statSync(repo).dev);
  assert.equal(fs.statSync(primary).ino, fs.statSync(repo).ino);
  assert.deepEqual(filterTrackableFiles([{ path: created, isWrite: true }], worktree, () => {}, primary, worktree),
    [{ path: path.join(primary, "new.js"), localFile: created, isWrite: true }]);
});

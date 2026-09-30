const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture, bin } = require("./helpers.cjs");

function turn(f, count = 3, extra = {}) {
  const project = path.join(f.home, "project");
  fs.mkdirSync(project);
  const files = Array.from({ length: count }, (_, i) => path.join(project, `file-${i}.js`));
  files.forEach((name) => fs.writeFileSync(name, "const value = 1;\n"));
  const payload = { session_id: "session", turn_id: "turn", cwd: project, ...extra };
  const edited = f.run(["hook"], { ...payload, hook_event_name: "PostToolUse", tool_name: "apply_patch",
    tool_input: { patch: files.map((name) => `*** Update File: ${name}\n`).join("") } });
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(JSON.parse(edited.stdout), {});
  assert.equal(f.calls().length, 0);
  return { project, files, payload: { ...payload, hook_event_name: "Stop" } };
}
const arg = (call, name) => call.args[call.args.indexOf(name) + 1];

test("a 35-file turn caps at 30, scans transcripts once, and batches 29 extra heartbeats", (t) => {
  const f = fixture(t);
  const { project, files, payload } = turn(f, 35);
  const result = f.run(["hook"], payload);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  const [sync, send] = f.calls();
  assert.equal(f.calls().length, 2);
  assert.ok(sync.args.includes("--sync-ai-activity"));
  assert.match(arg(sync, "--plugin"), /^codex-app\//);
  assert.match(arg(send, "--plugin"), /^Codex codex-app\//);
  assert.ok(send.args.includes("--sync-ai-disabled"));
  assert.equal(arg(send, "--entity"), files[0]);
  assert.equal(arg(send, "--project-folder"), project);
  const extra = JSON.parse(send.input);
  assert.equal(extra.length, 29);
  assert.deepEqual(extra.map((item) => item.entity), files.slice(1, 30));
  extra.forEach((item) => {
    assert.equal(item.type, "file");
    assert.equal(item.category, "ai coding");
    assert.equal(item.alternate_project, "project");
    assert.equal(item.is_write, true);
    assert.ok(Math.abs(Date.now() / 1000 - item.time) < 10);
  });
  assert.ok(sync.timeout <= 10000 && send.timeout <= 25000);
  assert.equal(fs.readdirSync(path.join(f.home, "turns")).length, 0);
  assert.match(fs.readFileSync(f.config, "utf8"), /sync_ai_disabled = false/);
});

test("failed sends retain edits for a later stop and do not advance the rate limit", (t) => {
  const f = fixture(t);
  const { payload, files } = turn(f);
  const failed = f.run(["hook"], payload, { WAKATIME_SEND_EXIT: "102" });
  assert.equal(failed.status, 0);
  assert.deepEqual(JSON.parse(failed.stdout), { continue: true });
  assert.equal(fs.existsSync(path.join(f.home, "state.json")), false);
  assert.equal(fs.readdirSync(path.join(f.home, "turns")).length, 1);
  assert.equal(f.run(["hook"], payload).status, 0);
  assert.equal(f.calls().length, 4);
  assert.equal(arg(f.calls()[3], "--entity"), files[0]);
  assert.equal(fs.readdirSync(path.join(f.home, "turns")).length, 0);
});

test("repeated empty stops are rate limited without launching WakaTime", (t) => {
  const f = fixture(t);
  const payload = { hook_event_name: "Stop", cwd: f.home };
  assert.equal(f.run(["hook"], payload).status, 0);
  assert.equal(f.run(["hook"], payload).status, 0);
  assert.equal(f.calls().length, 2);
});

test("malformed payloads return valid host responses without heartbeats", (t) => {
  const f = fixture(t);
  for (const input of ["{", "null", "[]", "42", '"text"']) {
    const result = spawnSync(process.execPath, [bin, "hook", ...f.options], {
      encoding: "utf8", input, env: f.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  }
  assert.equal(f.calls().length, 0);
});

test("unavailable queue storage still responds to both edit and stop hooks", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, "turns"), "not a directory");
  for (const event of ["PostToolUse", "Stop"]) {
    const result = f.run(["hook"], { session_id: "s", turn_id: "t", hook_event_name: event,
      cwd: f.home, tool_name: "Write", tool_input: { file_path: "file.js" } });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), event === "Stop" ? { continue: true } : {});
    assert.match(result.stderr, /WakaTime hook:/);
  }
  assert.equal(f.calls().length, 0);
});

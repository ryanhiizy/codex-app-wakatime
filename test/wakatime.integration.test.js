// Opt in with WAKATIME_TEST_CLI_PATH=/absolute/path/to/wakatime-cli npm test.
// All data, credentials, transcripts, and HTTP requests stay in an isolated fixture.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { fixture } = require("./helpers.cjs");

test("real CLI preserves batch metadata, custom projects, local files, and transcript import", {
  skip: !process.env.WAKATIME_TEST_CLI_PATH, timeout: 60000,
}, async (t) => {
  const f = fixture(t);
  const project = path.join(f.home, "project");
  fs.mkdirSync(project);
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        let raw = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw);
        const body = JSON.parse(raw.toString());
        const rows = Array.isArray(body) ? body : [body];
        received.push(...rows);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ responses: rows.map(() => [{ data: { id: randomUUID() } }, 201]) }));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  fs.writeFileSync(f.config, `[settings]\napi_key = ${randomUUID()}\napi_url = http://127.0.0.1:${server.address().port}/api/v1\nsync_ai_disabled = false\n`);
  const sessionId = randomUUID();
  const timestamp = new Date(Date.now() - 10000).toISOString();
  const sessions = path.join(f.home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `rollout-${sessionId}.jsonl`), [
    { type: "session_meta", timestamp, payload: { id: sessionId, cwd: project, cli_version: "0.159.0", source: "vscode" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: "Synthetic test prompt" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const files = Array.from({ length: 3 }, (_, i) => ({ path: path.join(project, `file-${i}.js`), isWrite: i !== 1 }));
  files.forEach((file) => fs.writeFileSync(file.path, "const value = 1;\n"));
  const paths = { runtime: process.platform === "win32" ? "windows" : "linux", app: "codex",
    wakatimeCli: process.env.WAKATIME_TEST_CLI_PATH, wakatimeConfig: f.config,
    wakatimeLog: path.join(f.home, "wakatime.log") };
  async function send(items) {
    const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, WAKATIME_HOME: f.home };
    delete env.NODE_OPTIONS;
    delete env.CODEX_WAKATIME_EDITOR;
    delete env.CODEX_WAKATIME_PLUGIN;
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures/send-turn.cjs")], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ paths, files: items, project }));
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).ok, true, stderr);
  }
  await send(files);
  const rows = received.filter((row) => files.some((file) => file.path === row.entity));
  assert.equal(rows.length, 3, JSON.stringify(received));
  for (const row of rows) {
    assert.equal(row.project, "project");
    assert.equal(row.category, "ai coding");
    assert.equal(row.is_write, files.find((file) => file.path === row.entity).isWrite);
    assert.match(row.user_agent, /Codex codex-app\//);
  }
  assert.ok(received.some((row) => row.ai_session === sessionId), "transcript activity must be imported");

  fs.writeFileSync(path.join(project, ".wakatime-project"), "Custom Project\n");
  const custom = ["custom-a.py", "custom-b.py"].map((name) => ({ path: path.join(project, name), isWrite: true }));
  custom.forEach((file) => fs.writeFileSync(file.path, "value = 1\n"));
  await send(custom);
  for (const file of custom) assert.equal(received.find((row) => row.entity === file.path)?.project, "Custom Project");

  const localFile = path.join(f.home, "new-local.js");
  fs.writeFileSync(localFile, "const value = 1;\n");
  const canonical = path.join(project, "not-yet-in-primary.js");
  await send([{ path: canonical, localFile, isWrite: true }]);
  const localRow = received.find((row) => row.entity === canonical);
  assert.ok(localRow, "a new worktree file must survive WakaTime's file-existence filter");
  assert.equal(localRow.project, "Custom Project");
});

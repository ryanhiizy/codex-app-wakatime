const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createStore, parseQueue } = require("../src/state");
const { fixture } = require("./helpers.cjs");
function setup(t) {
  const f = fixture(t);
  const paths = { stateFile: path.join(f.home, "state.json"), turnFilesDir: path.join(f.home, "turns"), configFile: f.settings };
  const store = createStore(() => paths);
  const payload = { session_id: "session", turn_id: "turn" };
  const first = { path: path.join(f.home, "first.js"), isWrite: true };
  const second = { path: path.join(f.home, "second.js"), isWrite: true };
  return { ...f, paths, store, payload, first, second };
}

test("finishing a claimed queue preserves edits appended while sending", (t) => {
  const { store, payload, first, second } = setup(t);
  store.remember(payload, [first]);
  const sending = store.claim(payload);
  assert.deepEqual(sending.files, [first]);
  store.remember(payload, [second]);
  sending.finish(true);
  const next = store.claim(payload);
  assert.deepEqual(next.files, [second]);
  next.finish(true);
});

test("failed snapshots are restored alongside new edits without downgrading write flags", (t) => {
  const { store, payload, first, second } = setup(t);
  store.remember(payload, [first]);
  const sending = store.claim(payload);
  store.remember(payload, [second, { ...first, isWrite: false }]);
  sending.finish(false);
  sending.finish(false);
  const next = store.claim(payload);
  assert.deepEqual(next.files, [first, second]);
  next.finish(true);
});

test("abandoned snapshots recover but live process snapshots stay owned", (t) => {
  const { store, paths, payload, first } = setup(t);
  fs.mkdirSync(paths.turnFilesDir);
  const prefix = createHash("sha256").update("session:turn").digest("hex");
  const dead = path.join(paths.turnFilesDir, `${prefix}.jsonl.2147483647.dead.processing`);
  const live = path.join(paths.turnFilesDir, `${prefix}.jsonl.${process.pid}.live.processing`);
  fs.writeFileSync(dead, `${JSON.stringify({ files: [first] })}\n`);
  fs.writeFileSync(live, "unrelated in-flight data");
  const snapshot = store.claim(payload);
  assert.deepEqual(snapshot.files, [first]);
  snapshot.finish(true);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.readFileSync(live, "utf8"), "unrelated in-flight data");
});

test("legacy migration preserves new heartbeat timestamps and other turns", (t) => {
  const { store, paths, payload, first, second } = setup(t);
  fs.writeFileSync(paths.stateFile, JSON.stringify({ lastHeartbeatAt: 1, turnFiles: {
    "session:turn": { files: [first] }, "other:turn": { files: [second] },
  } }));
  const sending = store.claim(payload);
  assert.deepEqual(sending.files, [first]);
  store.recordHeartbeat("signature", payload);
  sending.finish(true);
  const state = store.readState();
  assert.ok(state.lastHeartbeatAt > 1);
  assert.equal(state.lastSignature, "signature");
  assert.deepEqual(Object.keys(state.turnFiles), ["other:turn"]);
});

test("legacy queues, corrupt records, invalid state, and long turn IDs recover", (t) => {
  const { store, paths, payload, first } = setup(t);
  fs.mkdirSync(paths.turnFilesDir);
  fs.writeFileSync(path.join(paths.turnFilesDir, `${Buffer.from("session:turn").toString("base64url")}.jsonl`),
    `broken\n${JSON.stringify({ files: [null, first, { path: 3 }] })}\n{`);
  fs.writeFileSync(paths.stateFile, "null");
  assert.deepEqual(store.readState(), {});
  const sending = store.claim(payload);
  assert.deepEqual(sending.files, [first]);
  sending.finish(true);
  const long = { ...payload, turn_id: "a".repeat(5000) };
  store.remember(long, [first]);
  const next = store.claim(long);
  assert.deepEqual(next.files, [first]);
  next.finish(true);
  assert.deepEqual(parseQueue('null\n{"files":[null]}\n'), []);
});

test("queue pruning never drops the current failed turn", (t) => {
  const { store, paths, payload, first } = setup(t);
  store.remember(payload, [first]);
  for (let i = 0; i < 110; i++) fs.writeFileSync(path.join(paths.turnFilesDir, `unused-${i}.jsonl`), "{}");
  store.claim(payload).finish(false);
  assert.equal(fs.readdirSync(paths.turnFilesDir).length, 101);
  const retry = store.claim(payload);
  assert.deepEqual(retry.files, [first]);
  retry.finish(true);
});

test("future or invalid clock values never suppress tracking indefinitely", (t) => {
  const { store } = setup(t);
  for (const lastHeartbeatAt of ["broken", Date.now() / 1000 + 3600]) {
    assert.equal(store.shouldSend("same", { lastSignature: "same", lastHeartbeatAt }), true);
  }
});

test("a partial append cannot swallow the next edit or a failed snapshot", (t) => {
  const { store, paths, payload, first, second } = setup(t);
  store.remember(payload, [first]);
  const sending = store.claim(payload);
  const queue = path.join(paths.turnFilesDir, `${createHash("sha256").update("session:turn").digest("hex")}.jsonl`);
  fs.writeFileSync(queue, '{"files":[');
  store.remember(payload, [second]);
  fs.appendFileSync(queue, '{"files":[');
  sending.finish(false);
  const retry = store.claim(payload);
  assert.deepEqual(retry.files, [first, second]);
  retry.finish(true);
});

test("later turns retire stale abandoned snapshots while preserving recent work and live owners", (t) => {
  const { store, paths, payload } = setup(t);
  fs.mkdirSync(paths.turnFilesDir);
  const base = `${createHash("sha256").update("other:turn").digest("hex")}.jsonl`;
  const staleDead = path.join(paths.turnFilesDir, `${base}.2147483647.dead.processing`);
  const staleRetry = path.join(paths.turnFilesDir, `${base}.failed.retry`);
  const recentDead = path.join(paths.turnFilesDir, `${base}.2147483647.recent.processing`);
  const staleLive = path.join(paths.turnFilesDir, `${base}.${process.pid}.live.processing`);
  for (const name of [staleDead, staleRetry, recentDead, staleLive]) fs.writeFileSync(name, "{}\n");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const name of [staleDead, staleRetry, staleLive]) fs.utimesSync(name, old, old);
  store.claim(payload).finish(true);
  assert.equal(fs.existsSync(staleDead), false);
  assert.equal(fs.existsSync(staleRetry), false);
  assert.equal(fs.existsSync(recentDead), true);
  assert.equal(fs.existsSync(staleLive), true);
});

test("stops without turn IDs also retire stale snapshots", (t) => {
  const { store, paths } = setup(t);
  fs.mkdirSync(paths.turnFilesDir);
  const stale = path.join(paths.turnFilesDir, "old.jsonl.2147483647.dead.processing");
  fs.writeFileSync(stale, "{}\n");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  store.claim({}).finish(true);
  assert.equal(fs.existsSync(stale), false);
});

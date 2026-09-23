import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDiagnostic } from "../../src/collectors/base.js";
import {
  assertAllowedSql,
  CursorCollector,
  storePaths,
  transcriptPaths,
} from "../../src/collectors/cursor.js";

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-cursor-"));
}

function varint(value) {
  const bytes = [];
  let number = BigInt(value);
  do {
    let byte = Number(number & 0x7fn);
    number >>= 7n;
    if (number) byte |= 0x80;
    bytes.push(byte);
  } while (number);
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const key = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([key, varint(value)]);
  const bytes = Buffer.from(value);
  return Buffer.concat([key, varint(bytes.length), bytes]);
}

function rootBlob({ timestamps = [], maxTokens, turns = timestamps.length } = {}) {
  const parts = [];
  for (let index = 0; index < turns; index += 1) parts.push(field(8, 2, Buffer.alloc(0)));
  for (const timestamp of timestamps) {
    const timing = Buffer.concat([field(1, 0, 10), field(2, 0, timestamp)]);
    parts.push(field(14, 2, timing));
  }
  if (maxTokens !== undefined) parts.push(field(5, 2, field(2, 0, maxTokens)));
  return Buffer.concat(parts);
}

function store(home, {
  id = "session-1",
  tree = "chats",
  metadata = {},
  blob = rootBlob(),
  sidecar = {},
  envPath,
} = {}) {
  const root = envPath ?? path.join(home, ".cursor");
  const dbDir = tree === "acp-sessions"
    ? path.join(root, tree, id)
    : path.join(root, tree, "cwd-hash", id);
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "store.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  const rootId = "a".repeat(64);
  const complete = {
    agentId: id,
    name: "Cursor fixture",
    createdAt: 1700000000000,
    lastUsedModel: "gpt-5-codex",
    latestRootBlobId: rootId,
    ...metadata,
  };
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", Buffer.from(JSON.stringify(complete), "utf8").toString("hex"));
  db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(rootId, blob);
  db.close();
  if (Object.keys(sidecar).length > 0) writeFileSync(path.join(dbDir, "meta.json"), JSON.stringify(sidecar));
  return dbPath;
}

function collector(home, env = {}) {
  return new CursorCollector({ home, env: { ...env } });
}

function transcriptPath(home, cwd, id, form = "simple") {
  const dataDir = path.join(home, ".cursor");
  const candidates = transcriptPaths(dataDir, cwd, id);
  if (form === "bounded") return candidates[0];
  if (form === "legacy") return candidates[2];
  return candidates[1];
}

function writeTranscript(filePath, lines) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("hex metadata decodes session identity, model, and start time", async () => {
  const home = scratch();
  store(home, { metadata: { agentId: "agent-hex", name: "Renamed", lastUsedModel: "gpt-5" } });
  const instance = collector(home);
  const [session] = await instance.collect();
  assert.equal(session.cli, "cursor");
  assert.equal(session.cli, instance.cli);
  assert.equal(session.project, null);
  assert.equal(session.sessionId, "agent-hex");
  assert.equal(session.model, "gpt-5");
  assert.equal(session.startedAt, new Date(1700000000000).toISOString());
});

test("URI fallback returns the same session and records an informational note", async () => {
  const home = scratch();
  store(home, { id: "fallback-uri" });
  const instance = collector(home);
  const realDatabaseSync = DatabaseSync;
  instance.DatabaseSync = class UriRejectingDatabaseSync {
    constructor(filename, options) {
      if (filename.includes("file:")) throw new Error("URI unsupported");
      return new realDatabaseSync(filename, options);
    }
  };
  const diagnostic = createDiagnostic("cursor");
  const sessions = await instance.collect({ diagnostic });
  assert.deepEqual(sessions.map((session) => session.sessionId), ["fallback-uri"]);
  assert.deepEqual(diagnostic.notes, [
    "Runtime did not accept a URI filename; used the plain path with the read-only flag.",
  ]);
  assert.deepEqual(diagnostic.errors, []);
});

test("raw JSON metadata is skipped with a diagnostic", async () => {
  const home = scratch();
  const dbPath = store(home);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(JSON.stringify({ agentId: "raw" }));
  db.close();
  const diagnostic = createDiagnostic("cursor");
  assert.deepEqual(await collector(home).collect({ diagnostic }), []);
  assert.equal(diagnostic.linesSkipped, 1);
});

test("blobEncryptionKey never appears in collector output", async () => {
  const home = scratch();
  const secret = "b".repeat(64);
  store(home, { metadata: { blobEncryptionKey: secret } });
  const instance = collector(home);
  const diagnostic = createDiagnostic("cursor");
  const sessions = await instance.collect({ diagnostic });
  assert.equal(JSON.stringify({ sessions, diagnostic, sqlLog: instance.sqlLog }).includes(secret), false);
});

test("turn timings produce honest timestamped unknown turns", async () => {
  const home = scratch();
  store(home, { blob: rootBlob({ timestamps: [1700000000123, 1700000000456] }), sidecar: { cwd: "/a/b/my-project", updatedAtMs: 1700000000999 } });
  const [session] = await collector(home).collect();
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].ts, new Date(1700000000123).toISOString());
  for (const turn of session.turns) {
    assert.equal(turn.context.inputTokens, null);
    assert.equal(turn.context.fraction, null);
    assert.equal(turn.context.source, "unknown");
    assert.equal(turn.cacheRead, null);
    assert.equal(turn.cacheCreate, null);
    assert.equal(turn.output, null);
    assert.deepEqual(turn.toolCalls, []);
    assert.equal(turn.toolResultBytes, null);
  }
  assert.equal(session.cwd, "/a/b/my-project");
  assert.equal(session.project, "my-project");
  assert.equal(session.endedAt, new Date(1700000000999).toISOString());
});

test("native max_tokens wins, while absent token_details uses the model table", async () => {
  const home = scratch();
  store(home, { id: "native", blob: rootBlob({ timestamps: [1], maxTokens: 123456 }) });
  store(home, { id: "fallback", metadata: { lastUsedModel: "gpt-5-codex" }, blob: rootBlob({ timestamps: [1] }) });
  const sessions = await collector(home).collect();
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  assert.deepEqual(byId.get("native").window, { tokens: 123456, source: "native" });
  assert.deepEqual(byId.get("fallback").window, { tokens: 400000, source: "model-table" });
});

test("absent home is not installed and collects nothing", async () => {
  const home = scratch();
  const instance = collector(home);
  assert.deepEqual(instance.detect(), { installed: false, paths: [], status: "absent" });
  assert.deepEqual(await instance.collect(), []);
});

test("detect distinguishes supported, detection-only, and absent", () => {
  const home = scratch();
  const configDir = path.join(home, ".cursor");
  mkdirSync(configDir, { recursive: true });
  assert.equal(collector(home).detect().status, "detection-only");

  store(home, { id: "detected" });
  assert.equal(collector(home).detect().status, "supported");

  const absentHome = scratch();
  const detection = collector(absentHome).detect();
  assert.equal(detection.status, "absent");
  assert.equal(detection.installed, false);
});

test("detection-only Cursor explains the CLI and desktop boundary", () => {
  const home = scratch();
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const detection = collector(home).detect();
  assert.equal(detection.status, "detection-only");
  assert.match(detection.reason, /Cursor CLI \(cursor-agent\)/);
  assert.match(detection.reason, /desktop editor keeps its chat history separately/);
  assert.doesNotMatch(detection.reason, /desktop.*\.cursor|\.cursor.*desktop/);
  assert.match(detection.reason, /not the same as no usage/);
});

test("a store whose mtime cannot be read remains a scan candidate", () => {
  const home = scratch();
  const dbPath = store(home, { id: "unstatable" });
  const original = fs.statSync;
  fs.statSync = (target) => {
    if (target === dbPath) throw new Error("stat blocked");
    return original(target);
  };
  try {
    assert.deepEqual(storePaths(path.join(home, ".cursor")), [dbPath]);
  } finally {
    fs.statSync = original;
  }
});

test("CURSOR_CONFIG_DIR and XDG_CONFIG_HOME redirect the scan", async () => {
  const home = scratch();
  const config = path.join(home, "explicit-config");
  store(home, { id: "explicit", envPath: config });
  assert.equal((await collector(home, { CURSOR_CONFIG_DIR: config }).collect()).length, 1);

  const xdg = path.join(home, "xdg");
  store(home, { id: "xdg", envPath: path.join(xdg, "cursor") });
  assert.equal((await collector(home, { XDG_CONFIG_HOME: xdg }).collect()).length, 1);
});

test("acp-sessions is scanned", async () => {
  const home = scratch();
  store(home, { id: "acp-1", tree: "acp-sessions" });
  const detection = collector(home).detect();
  assert.equal(detection.status, "supported");
  assert.equal((await collector(home).collect()).length, 1);
});

test("allowlist rejects wildcard, chaining, off-list tables, and missing LIMIT", () => {
  assert.throws(() => assertAllowedSql("SELECT * FROM meta LIMIT 1"), /forbidden/);
  assert.throws(() => assertAllowedSql("SELECT value FROM meta LIMIT 1; SELECT value FROM blobs LIMIT 1"), /chained/);
  assert.throws(() => assertAllowedSql("SELECT value FROM secrets LIMIT 1"), /allowlist/);
  assert.throws(() => assertAllowedSql("SELECT value FROM meta"), /LIMIT/);
});

test("bounded transcript form populates tool calls in turn order", async () => {
  const home = scratch();
  const cwd = "/private/var/folders/T/session-rx-fixture/Users/demo/Projects/very-long-workspace-name-forcing-the-bounded-cursor-path";
  const id = "bounded-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001, 1700000000002] }) });
  writeTranscript(transcriptPath(home, cwd, id, "bounded"), [
    { role: "user", message: { content: [{ type: "text", text: "first" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "read_file", input: { path: "a" } }] } },
    { role: "user", message: { content: [{ type: "text", text: "second" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "shell", input: { command: "pwd" } }] } },
  ]);
  const [session] = await collector(home).collect();
  assert.deepEqual(session.turns.map((turn) => turn.toolCalls.map((call) => call.name)), [["read_file"], ["shell"]]);
});

function assertBoundedProjectName(dataDir, cwd, expected, slugPrefix, alternateCwd) {
  const projectName = (candidate) => candidate
    .split(`${path.sep}agent-transcripts`)[0]
    .split(`${path.sep}projects${path.sep}`)[1];
  const [candidate] = transcriptPaths(dataDir, cwd, "regression");
  const bounded = projectName(candidate);

  if (path.sep === "/") {
    assert.equal(bounded, expected);
  } else {
    assert.ok(bounded.startsWith(slugPrefix));
    assert.match(bounded, /-[a-f0-9]{7}$/);
    assert.ok(
      candidate.split(`${path.sep}agent-transcripts`)[0].length <= 92,
      "the bounded project path exceeds its length limit",
    );
    assert.equal(projectName(transcriptPaths(dataDir, cwd, "regression")[0]), bounded);
    assert.notEqual(
      projectName(transcriptPaths(dataDir, alternateCwd, "regression")[0]),
      bounded,
      "different long project paths must not share the same bounded name",
    );
  }
}

test("bounded Cursor paths use the exact clamped project name", () => {
  const dataDir = "/Users/demo/.cursor";
  const cwd = "/private/var/folders/T/session-rx-fixture/Users/demo/Projects/very-long-workspace-name-forcing-the-bounded-cursor-path";
  assertBoundedProjectName(
    dataDir,
    cwd,
    "private-var-folders-T-session-rx-fixture-Users-demo-Pro-aba1a6d",
    "private-var-folders-T-session-rx-fixture-Users-demo-Pro",
    `${cwd}-different`,
  );
});

test("another bounded Cursor path keeps its exact clamped project name", () => {
  const dataDir = "/home/demo/.cursor";
  const cwd = "/home/demo/workspaces/an-extremely-long-monorepo-package-directory-name-that-exceeds-the-cap";
  assertBoundedProjectName(
    dataDir,
    cwd,
    "home-demo-workspaces-an-extremely-long-monorepo-package--c7d4772",
    "home-demo-workspaces-an-extremely-long-monorepo-package-",
    `${cwd}-different`,
  );
});

test("short Cursor paths remain unbounded", () => {
  const dataDir = "/Users/demo/.cursor";
  const cwd = "/Users/demo/project";
  const [candidate] = transcriptPaths(dataDir, cwd, "regression");
  assert.equal(candidate.split(`${path.sep}agent-transcripts`)[0].split(`${path.sep}projects${path.sep}`)[1], "Users-demo-project");
});

test("session cap keeps newest stores and reports the truncated scan", async () => {
  const home = scratch();
  const now = Date.now();
  for (let index = 0; index < 201; index += 1) {
    const id = `session-${String(index).padStart(3, "0")}`;
    const dbPath = store(home, { id });
    const timestamp = new Date(now - (200 - index) * 1000);
    utimesSync(dbPath, timestamp, timestamp);
  }
  const diagnostic = createDiagnostic("cursor");
  const sessions = await collector(home).collect({ diagnostic });
  assert.equal(sessions.length, 200);
  assert.equal(sessions.some(({ sessionId }) => sessionId === "session-000"), false);
  assert.equal(sessions[0].sessionId, "session-200");
  assert.deepEqual(diagnostic.truncated, [`${path.join(home, ".cursor")}#sessions>200`]);
});

test("every transcript candidate stays below the data directory projects root", () => {
  const cwd = "/Users/demo/project";
  for (const dataDir of ["/tmp/cursor", path.join(scratch(), "d".repeat(100), ".cursor")]) {
    const root = path.join(dataDir, "projects");
    for (const candidate of transcriptPaths(dataDir, cwd, "root-check")) {
      assert.equal(candidate.startsWith(root), true);
    }
  }
});

test("collect finds a transcript under a long data directory and populates tool calls", async () => {
  const home = path.join(scratch(), "h".repeat(100));
  const cwd = "/Users/demo/long-home-project";
  const id = "long-home-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001] }) });
  writeTranscript(transcriptPaths(path.join(home, ".cursor"), cwd, id)[0], [
    { role: "user", message: { content: [] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "long_root_tool", input: {} }] } },
  ]);
  const [session] = await collector(home).collect();
  assert.equal(session.turns[0].toolCalls[0].name, "long_root_tool");
});

test("simple transcript form is found when bounded form is absent", async () => {
  const home = scratch();
  const cwd = "/Users/demo/project";
  const id = "simple-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001] }) });
  writeTranscript(transcriptPath(home, cwd, id), [
    { role: "user", message: { content: [{ type: "text", text: "go" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "list_dir", input: null }] } },
  ]);
  const [session] = await collector(home).collect();
  assert.equal(session.turns[0].toolCalls[0].name, "list_dir");
});

test("control lines and tool-only role lines are ignored", async () => {
  const home = scratch();
  const cwd = "/Users/demo/controls";
  const id = "control-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001] }) });
  writeTranscript(transcriptPath(home, cwd, id), [
    { type: "metadata", metadata: { overview: "ignored" } },
    { role: "user", message: { content: [{ type: "text", text: "go" }] } },
    { role: "tool", message: { content: [{ type: "tool-result", content: "dropped" }] } },
    { type: "turn_ended", status: "success" },
  ]);
  const [session] = await collector(home).collect();
  assert.deepEqual(session.turns[0].toolCalls, []);
});

test("malformed transcript lines do not discard earlier calls", async () => {
  const home = scratch();
  const cwd = "/Users/demo/malformed";
  const id = "malformed-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001] }) });
  const file = transcriptPath(home, cwd, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ role: "user", message: { content: [] } })}\n${JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "keep", input: {} }] } })}\nnot-json\n`);
  const diagnostic = createDiagnostic("cursor");
  const [session] = await collector(home).collect({ diagnostic });
  assert.equal(session.turns[0].toolCalls[0].name, "keep");
  assert.match(diagnostic.errors.join("\n"), /malformed transcript/);
});

test("missing sidecar cwd leaves tool calls empty without throwing", async () => {
  const home = scratch();
  store(home, { id: "no-cwd", blob: rootBlob({ timestamps: [1700000000001] }) });
  const [session] = await collector(home).collect();
  assert.deepEqual(session.turns[0].toolCalls, []);
});

test("transcript tool calls do not change Cursor unknown fields", async () => {
  const home = scratch();
  const cwd = "/Users/demo/honesty";
  const id = "honesty-session";
  store(home, { id, sidecar: { cwd }, blob: rootBlob({ timestamps: [1700000000001] }) });
  writeTranscript(transcriptPath(home, cwd, id), [
    { role: "user", message: { content: [] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "inspect", input: {} }] } },
  ]);
  const [turn] = (await collector(home).collect())[0].turns;
  assert.equal(turn.context.inputTokens, null);
  assert.equal(turn.context.source, "unknown");
  assert.equal(turn.toolResultBytes, null);
});

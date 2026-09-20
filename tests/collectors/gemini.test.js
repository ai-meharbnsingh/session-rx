import assert from "node:assert/strict";
import { cpSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDiagnostic } from "../../src/collectors/base.js";
import { GeminiCollector } from "../../src/collectors/gemini.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = path.join(here, "..", "fixtures", "gemini", "home");
const ALPHA = path.join(
  FIXTURE_HOME, ".gemini", "tmp", "project-alpha", "chats",
  "session-2026-09-20T10-00-00-aaaa1111.jsonl",
);
const HISTORY = path.join(FIXTURE_HOME, ".gemini", "antigravity-cli", "history.jsonl");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-gemini-"));
}

/** Tests never read the real home directory. */
function collector(home = FIXTURE_HOME, options = {}) {
  return new GeminiCollector({ home, ...options });
}

/** Selected by project, not by scan order: checkout mtimes are not meaningful. */
async function alphaSession() {
  const sessions = await collector().collect();
  return sessions.find((session) => session.project === "project-alpha");
}

function tempSession(lines, name = "session-2026-09-20T12-00-00-cccc3333.jsonl") {
  const home = scratch();
  const chats = path.join(home, ".gemini", "tmp", "project-temp", "chats");
  cpSync(path.join(FIXTURE_HOME, ".gemini", "tmp", "project-beta", "chats"), chats, { recursive: true });
  const file = path.join(chats, name);
  writeFileSync(file, lines);
  return { home, file };
}

test("detect reports supported only when the Gemini tmp root exists", () => {
  assert.deepEqual(collector().detect(), {
    installed: true,
    paths: [path.join(FIXTURE_HOME, ".gemini", "tmp")],
    status: "supported",
  });
  assert.deepEqual(collector(path.join(scratch(), "no-such-home")).detect(), {
    installed: false,
    paths: [],
    status: "absent",
  });
});

test("only session-*.jsonl chat logs are discovered", () => {
  const files = collector().sessionFiles().map((entry) => entry.path);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => path.basename(file).startsWith("session-")));
  assert.ok(!files.some((file) => file.endsWith("checkpoint.json")));
  assert.ok(!files.some((file) => file.includes("antigravity-cli")));
});

test("$set snapshots and overlapping bare records produce an exact turn count", async () => {
  const sessions = await collector().collect();
  const alpha = sessions.find((session) => session.project === "project-alpha");
  // m1 user, m2 gemini (stated three times), m3 info, m4 gemini, m5 error.
  // Only the two model records are turns, and the repeats never double-count.
  assert.equal(alpha.turns.length, 2);
  assert.equal(alpha.sessionId, "aaaa1111-0000-4000-8000-000000000001");
  assert.equal(alpha.cli, "gemini");
  assert.equal(alpha.support, "supported");
  assert.equal(alpha.startedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(alpha.endedAt, "2026-09-20T10:00:10.000Z");
  assert.equal(alpha.cwd, null);
});

test("the last statement of a message id wins", async () => {
  const alpha = await alphaSession();
  const [first, second] = alpha.turns;
  // m2 was first written with input 1000 and restated with input 1200.
  assert.equal(first.ts, "2026-09-20T10:00:05.000Z");
  assert.equal(first.context.inputTokens, 1200);
  assert.equal(first.output, 20);
  assert.equal(first.cacheRead, 256);
  assert.equal(first.context.source, "native");
  assert.deepEqual(first.toolCalls, [{ id: "tc1", name: "read_file", input: { path: "a.js" } }]);
  assert.equal(second.context.inputTokens, 2000);
  assert.equal(second.output, 30);
});

test("absent Gemini metrics are null, never zero", async () => {
  const alpha = await alphaSession();
  for (const turn of alpha.turns) {
    // BP-002.03: Gemini reports no cache-creation figure at all.
    assert.equal(turn.cacheCreate, null);
    // DIS-006: no recoverable tool-result byte length; never inferred from tokens.
    assert.equal(turn.toolResultBytes, null);
    // DIS-004: no sub-agent interval marker in the Gemini evidence.
    assert.equal(turn.isSidechain, null);
    assert.equal(turn.context.fraction, null);
  }
  // m4 carries no `cached` key, so cache-read is unknown rather than 0.
  assert.equal(alpha.turns[1].cacheRead, null);
});

test("DIS-003: a tool call is proved without fabricating a tool result", async () => {
  const alpha = await alphaSession();
  const [turnWithTool] = alpha.turns;
  assert.equal(turnWithTool.toolCalls.length, 1);
  assert.equal(turnWithTool.toolResultBytes, null);
  // Nothing on the turn can stand in for a result signature.
  assert.deepEqual(Object.keys(turnWithTool).sort(), [
    "cacheCreate", "cacheRead", "context", "isSidechain", "output", "toolCalls", "toolResultBytes", "ts",
  ]);
});

test("a mapped model fills the window; an unmapped model falls back to the observed floor", async () => {
  const sessions = await collector().collect();
  const alpha = sessions.find((session) => session.project === "project-alpha");
  const beta = sessions.find((session) => session.project === "project-beta");
  assert.equal(alpha.model, "gemini-3.5-flash");
  // The map still wins where the session fits inside it (BP-002.03).
  assert.deepEqual(alpha.window, { tokens: 1000000, source: "model-map" });

  assert.equal(beta.model, "mystery-model-x");
  // CONTRACT CHANGE (orchestrator ruling F-008): this read
  // {tokens: null, source: "unknown"}. `mystery-model-x` is in no map, but the
  // session is evidence of its own window - it held 50 tokens of context, so its
  // window is AT LEAST 50. That is a measurement, not a guess; F-014 then keeps
  // it out of every fraction.
  assert.deepEqual(beta.window, { tokens: 50, source: "observed-floor" });
  assert.equal(beta.turns.length, 1);
});

test("the antigravity-cli command history is not a session log", async () => {
  const diagnostic = createDiagnostic("gemini");
  const session = await collector().parseSessionFile(HISTORY, diagnostic);
  assert.equal(session, null);
  // Every history row was rejected as a non-message record.
  assert.equal(diagnostic.linesSkipped, 3);
  assert.equal(diagnostic.filesSkipped, 1);
  const collected = await collector().collect();
  assert.ok(!collected.some((entry) => entry.project === "antigravity-cli"));
});

test("since and limit bound the scan", async () => {
  const home = scratch();
  cpSync(FIXTURE_HOME, home, { recursive: true });
  const alpha = path.join(home, ".gemini", "tmp", "project-alpha", "chats", path.basename(ALPHA));
  const beta = path.join(
    home, ".gemini", "tmp", "project-beta", "chats",
    "session-2026-09-19T09-00-00-bbbb2222.jsonl",
  );
  const newest = new Date("2026-09-20T10:00:00Z");
  const oldest = new Date("2026-09-19T09:00:00Z");
  utimesSync(alpha, newest, newest);
  utimesSync(beta, oldest, oldest);
  const scoped = collector(home);
  assert.equal((await scoped.collect({ limit: 1 })).length, 1);
  assert.equal((await scoped.collect({ since: new Date("2026-09-20T00:00:00Z") })).length, 1);
  assert.equal((await scoped.collect()).length, 2);
});

test("an empty file yields no session and no throw", async () => {
  const { home, file } = tempSession("");
  const diagnostic = createDiagnostic("gemini");
  assert.equal(await collector(home).parseSessionFile(file, diagnostic), null);
  assert.equal(diagnostic.errors.length, 0);
  assert.equal((await collector(home).collect()).length, 1);
});

test("a whitespace-only file yields no session and no throw", async () => {
  const { home, file } = tempSession("\n   \n\t\n");
  const diagnostic = createDiagnostic("gemini");
  assert.equal(await collector(home).parseSessionFile(file, diagnostic), null);
  assert.equal(diagnostic.errors.length, 0);
});

test("a truncated JSON line is skipped and the rest of the file still parses", async () => {
  const { home, file } = tempSession([
    '{"sessionId":"dddd4444","startTime":"2026-09-20T12:00:00.000Z","kind":"main"}',
    '{"id":"t1","timestamp":"2026-09-20T12:00:01.000Z","type":"gemini","tokens":{"input":11,"output":1},"model":"gemini-3.5-flash"}',
    '{"id":"t2","timestamp":"2026-09-20T12:00:02.000Z","type":"gemini","tokens":{"inp',
    '{"id":"t3","timestamp":"2026-09-20T12:00:03.000Z","type":"gemini","tokens":{"input":22,"output":2},"model":"gemini-3.5-flash"}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("gemini");
  const session = await collector(home).parseSessionFile(file, diagnostic);
  assert.equal(diagnostic.linesSkipped, 1);
  assert.equal(diagnostic.errors.length, 0);
  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns.map((turn) => turn.context.inputTokens), [11, 22]);
});

test("valid JSON lines with no expected field are skipped, not turned into turns", async () => {
  const { home, file } = tempSession([
    '{"sessionId":"eeee5555","startTime":"2026-09-20T12:00:00.000Z","kind":"main"}',
    '{"unrelated":true}',
    '[1,2,3]',
    '42',
    '{"$set":{"notMessages":1}}',
    '{"id":"t1","timestamp":"2026-09-20T12:00:04.000Z","type":"gemini","tokens":{"input":9,"output":1},"model":"gemini-3.5-flash"}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("gemini");
  const session = await collector(home).parseSessionFile(file, diagnostic);
  assert.equal(diagnostic.linesSkipped, 4);
  assert.equal(session.turns.length, 1);
});

test("a file over the byte cap is truncated rather than fully read", async () => {
  const filler = "x".repeat(400);
  const { home, file } = tempSession([
    '{"sessionId":"ffff6666","startTime":"2026-09-20T12:00:00.000Z","kind":"main"}',
    `{"id":"t1","timestamp":"2026-09-20T12:00:01.000Z","type":"gemini","content":[{"text":"${filler}"}],"tokens":{"input":5,"output":1},"model":"gemini-3.5-flash"}`,
    `{"id":"t2","timestamp":"2026-09-20T12:00:02.000Z","type":"gemini","content":[{"text":"${filler}"}],"tokens":{"input":6,"output":1},"model":"gemini-3.5-flash"}`,
  ].join("\n") + "\n");
  const capped = collector(home, { maxBytes: 256 });
  const diagnostic = createDiagnostic("gemini");
  const session = await capped.parseSessionFile(file, diagnostic);
  assert.ok(diagnostic.truncated.includes(file));
  assert.equal(diagnostic.errors.length, 0);
  assert.ok(session === null || Array.isArray(session.turns));
  assert.ok(Array.isArray(await capped.collect()));
});

test("a $set clock bump and a re-written header are not lost data", async () => {
  // The commonest record in a real Gemini log is {"$set":{"lastUpdated":...}},
  // and the CLI re-writes the header when a chat resumes.  Neither is a
  // malformed line, so neither may be reported as skipped.
  const { home, file } = tempSession([
    '{"sessionId":"gggg7777","projectHash":"h","startTime":"2026-09-20T12:00:00.000Z","lastUpdated":"2026-09-20T12:00:00.000Z","kind":"main"}',
    '{"$set":{"lastUpdated":"2026-09-20T12:00:01.000Z"}}',
    '{"id":"t1","timestamp":"2026-09-20T12:00:02.000Z","type":"gemini","tokens":{"input":7,"output":1},"model":"gemini-3.5-flash"}',
    '{"sessionId":"gggg7777","projectHash":"h","startTime":"2026-09-20T12:00:00.000Z","lastUpdated":"2026-09-20T12:00:09.000Z","kind":"main"}',
    '{"$set":{"lastUpdated":"2026-09-20T12:00:30.000Z"}}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("gemini");
  const session = await collector(home).parseSessionFile(file, diagnostic);
  assert.equal(diagnostic.linesSkipped, 0);
  assert.equal(session.sessionId, "gggg7777");
  assert.equal(session.turns.length, 1);
  assert.equal(session.startedAt, "2026-09-20T12:00:00.000Z");
  // The clock ran on after the last message, and the latest stamp wins.
  assert.equal(session.endedAt, "2026-09-20T12:00:30.000Z");
});

test("F-014: an observed-floor window publishes no context fraction", async () => {
  const sessions = await collector().collect();
  const beta = sessions.find((session) => session.project === "project-beta");
  assert.equal(beta.window.source, "observed-floor");
  for (const turn of beta.turns) {
    assert.equal(turn.context.fraction, null,
      "floor/floor is 1.0 by construction, so it is not published as a reading");
  }
});

test("F-010: the observed floor is the MAX per-turn context, never the sum of the turns", async () => {
  const lines = [
    JSON.stringify({
      sessionId: "cccc3333-0000-4000-8000-000000000003",
      projectHash: "abc", startTime: "2026-09-20T12:00:00.000Z",
      lastUpdated: "2026-09-20T12:00:30.000Z", kind: "main",
    }),
    JSON.stringify({
      id: "s1", timestamp: "2026-09-20T12:00:01.000Z", type: "gemini", content: [{ text: "a" }],
      tokens: { input: 30000, output: 5, cached: 0, thoughts: 0, tool: 0, total: 30005 },
      model: "mystery-model-x",
    }),
    JSON.stringify({
      id: "s2", timestamp: "2026-09-20T12:00:02.000Z", type: "gemini", content: [{ text: "b" }],
      tokens: { input: 41344, output: 5, cached: 0, thoughts: 0, tool: 0, total: 41349 },
      model: "mystery-model-x",
    }),
    JSON.stringify({
      id: "s3", timestamp: "2026-09-20T12:00:03.000Z", type: "gemini", content: [{ text: "c" }],
      tokens: { input: 12000, output: 5, cached: 0, thoughts: 0, tool: 0, total: 12005 },
      model: "mystery-model-x",
    }),
  ].join("\n");
  const { file } = tempSession(`${lines}\n`);
  const diagnostic = createDiagnostic("gemini");
  const session = await collector().parseSessionFile(file, diagnostic);
  // 30,000 + 41,344 + 12,000 = 83,344: a workload total, not a context reading.
  assert.deepEqual(session.window, { tokens: 41344, source: "observed-floor" });
  assert.notEqual(session.window.tokens, 83344);
});

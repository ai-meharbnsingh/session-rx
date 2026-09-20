import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

// ==========================================================================
// THE EMPTY SHELL, AND THE NOTE THAT HAS TO SAY SO
//
// Gemini writes the session header and a `session_context` user message the
// moment a chat opens, so a chat that was opened and never used is a real file
// that parses as a real session with no turn in it. On the machine this was
// measured on, 250 of the newest 250 session files are exactly that, and the
// only thing the product said about them was "the collection limit of 250 was
// reached" — a count of 250 that reads as activity.
//
// These tests go through the REAL collector over REAL file shapes and then
// through the REAL analyzer, and assert on the sentence a user reads. A fixture
// that handed the analyzer pre-built sessions would prove nothing about whether
// Gemini's own file shape reaches the note.
// ==========================================================================

const { collectMany } = await import("../../src/collectors/registry.js");
const { analyzeAll } = await import("../../src/analyzer/health.js");

/** A chat opened and never used: header, the session_context line, a clock bump. */
function emptyShellLines(id, minute) {
  const stamp = `2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return [
    JSON.stringify({ sessionId: id, projectHash: "h", startTime: stamp, lastUpdated: stamp, kind: "main" }),
    JSON.stringify({ $set: { messages: [{ id: `${id}-u`, timestamp: stamp, type: "user", content: [{ text: "<session_context>" }] }] } }),
    JSON.stringify({ $set: { lastUpdated: stamp } }),
    "",
  ].join("\n");
}

/** A chat that was actually used: one model reply, so one turn. */
function usedSessionLines(id, minute) {
  const stamp = `2026-09-20T11:${String(minute).padStart(2, "0")}:00.000Z`;
  return [
    JSON.stringify({ sessionId: id, projectHash: "h", startTime: stamp, lastUpdated: stamp, kind: "main" }),
    JSON.stringify({ $set: { messages: [
      { id: `${id}-u`, timestamp: stamp, type: "user", content: [{ text: "hi" }] },
      {
        id: `${id}-g`, timestamp: stamp, type: "gemini", model: "gemini-2.5-pro",
        content: [{ text: "ok" }], tokens: { input: 1000, output: 20, cached: 0 },
      },
    ] } }),
    "",
  ].join("\n");
}

/**
 * A Gemini home holding `shells` empty chats and `used` real ones, with mtimes
 * set so the newest-first ordering the collector relies on is deterministic.
 */
function shellHome(shells, used = 0) {
  const home = scratch();
  const chats = path.join(home, ".gemini", "tmp", "project-shells", "chats");
  mkdirSync(chats, { recursive: true });
  const write = (name, body, minute) => {
    const file = path.join(chats, name);
    writeFileSync(file, body);
    const when = Date.UTC(2026, 8, 20, 10, minute, 0) / 1000;
    utimesSync(file, when, when);
  };
  for (let i = 0; i < shells; i += 1) {
    write(`session-2026-09-20T10-${String(i).padStart(2, "0")}-shell${i}.jsonl`, emptyShellLines(`shell${i}`, i), i);
  }
  for (let i = 0; i < used; i += 1) {
    write(`session-2026-09-20T11-${String(i).padStart(2, "0")}-used${i}.jsonl`, usedSessionLines(`used${i}`, i), 30 + i);
  }
  return home;
}

/** The real collector, then the real analyzer: what the user would be shown. */
async function shellReading(shells, used = 0, options = {}) {
  const collected = await collectMany([collector(shellHome(shells, used))], options);
  const out = analyzeAll(collected, { ...options, generatedAt: "2026-09-21T00:00:00Z" });
  return {
    read: collected.supported[0].sessions.length,
    turnCounts: collected.supported[0].sessions.map((session) => session.turns.length),
    entry: out.collectors.find((cli) => cli.cli === "gemini"),
  };
}

test("a CLI whose every collected session holds no turn is said to hold none, not just counted", async () => {
  const { read, turnCounts, entry } = await shellReading(3);
  // The shells are still collected and still counted: they are real chats.
  assert.equal(read, 3);
  assert.equal(entry.sessions, 3);
  assert.deepEqual(turnCounts, [0, 0, 0]);
  assert.ok(
    entry.note.includes("not one of the 3 sessions read for this CLI recorded a single turn"),
    entry.note,
  );
  assert.ok(entry.note.includes("started and then left unused"), entry.note);
  // With nothing cut off, there is nowhere else for a used session to be, so
  // the note must NOT send the reader off to raise a limit.
  assert.ok(!entry.note.includes("raise the limit"), entry.note);
});

test("when the limit was reached too, the all-empty note says used sessions may lie outside it", async () => {
  const { read, entry } = await shellReading(3, 0, { limit: 2 });
  assert.equal(read, 2);
  assert.equal(entry.sessions, 2);
  assert.ok(entry.note.includes("the collection limit of 2 was reached"), entry.note);
  assert.ok(entry.note.includes("not one of the 2 sessions read for this CLI recorded a single turn"), entry.note);
  assert.ok(entry.note.includes("may sit outside the newest 2 read here"), entry.note);
  assert.ok(entry.note.includes("raise the limit to reach them"), entry.note);
});

test("the turn-less share is published with both its numbers, and the remainder with it", async () => {
  const { read, entry } = await shellReading(9, 1);
  assert.equal(read, 10);
  assert.equal(entry.sessions, 10);
  assert.ok(entry.note.includes("9 of the 10 sessions read for this CLI recorded no turns at all"), entry.note);
  assert.ok(entry.note.includes("only 1 of them has anything in it to measure"), entry.note);
  // 9 of 10 is not "not one of them": the one that was used is not erased.
  assert.ok(!entry.note.includes("not one of"), entry.note);
});

test("a healthy mix of used and unused chats raises no turn-less alarm at all", async () => {
  const { read, turnCounts, entry } = await shellReading(1, 4);
  assert.equal(read, 5);
  assert.deepEqual(turnCounts.filter((count) => count === 0).length, 1);
  // 1 of 5 turn-less is ordinary — the real Claude, Codex and OpenCode readings
  // are 2%, 1% and 3%. A note here would be a false alarm on every machine.
  assert.equal(entry.note, null);
});

test("a CLI that is installed but has no session at all gets no turn-less note: 0 of 0 is not a finding", async () => {
  // Installed — the tmp root exists, so this CLI is `supported` and reaches the
  // same note-building path — but holding no session file at all.
  const home = scratch();
  mkdirSync(path.join(home, ".gemini", "tmp"), { recursive: true });
  const collected = await collectMany([collector(home)], {});
  assert.equal(collected.supported.length, 1, "the CLI must be supported, or this exercises the absent path instead");
  assert.equal(collected.supported[0].sessions.length, 0);

  const out = analyzeAll(collected, { generatedAt: "2026-09-21T00:00:00Z" });
  const entry = out.collectors.find((cli) => cli.cli === "gemini");
  assert.equal(entry.sessions, 0);
  assert.ok(!entry.note.includes("recorded no turns at all"), entry.note);
  assert.ok(!entry.note.includes("recorded a single turn"), entry.note);
  assert.ok(entry.note.includes("no session fell inside the requested range"), entry.note);
});

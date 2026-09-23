import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDiagnostic } from "../../src/collectors/base.js";
import { KimiCollector } from "../../src/collectors/kimi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = path.join(here, "..", "fixtures", "kimi", "home");
const WORKSPACE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const RICH_SESSION = "11111111-1111-4111-8111-111111111111";
const SHORT_SESSION = "22222222-2222-4222-8222-222222222222";

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-kimi-"));
}

/** Tests never read the real home directory. */
function collector(home = FIXTURE_HOME, options = {}) {
  return new KimiCollector({ home, ...options });
}

/** Selected by session id, not by scan order: checkout mtimes are not meaningful. */
async function richSession() {
  const sessions = await collector().collect();
  return sessions.find((session) => session.sessionId === RICH_SESSION);
}

function tempWire(lines, sessionId = "33333333-3333-4333-8333-333333333333") {
  const home = scratch();
  const dir = path.join(home, ".kimi", "sessions", "ws-temp", sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wire.jsonl");
  writeFileSync(file, lines);
  return { home, file, meta: { workspace: "ws-temp", sessionId } };
}

test("detect reports supported only when the Kimi sessions root exists", () => {
  assert.deepEqual(collector().detect(), {
    installed: true,
    paths: [path.join(FIXTURE_HOME, ".kimi", "sessions")],
    status: "supported",
  });
  assert.deepEqual(collector(path.join(scratch(), "no-such-home")).detect(), {
    installed: false,
    paths: [],
    status: "absent",
  });
});

test("wire.jsonl is discovered per workspace and session directory", () => {
  const files = collector().sessionFiles();
  assert.equal(files.length, 2);
  assert.ok(files.every((entry) => path.basename(entry.path) === "wire.jsonl"));
  assert.deepEqual(files.map((entry) => entry.workspace), [WORKSPACE, WORKSPACE]);
  assert.deepEqual([...files.map((entry) => entry.sessionId)].sort(), [RICH_SESSION, SHORT_SESSION]);
});

test("Kimi scans both homes and prefers the .kimi-code copy by session id", async () => {
  const home = scratch();
  cpSync(path.join(FIXTURE_HOME, ".kimi"), path.join(home, ".kimi"), { recursive: true });
  const newer = path.join(home, ".kimi-code", "sessions", "preferred-workspace", RICH_SESSION);
  mkdirSync(newer, { recursive: true });
  cpSync(path.join(FIXTURE_HOME, ".kimi", "sessions", WORKSPACE, RICH_SESSION, "wire.jsonl"),
    path.join(newer, "wire.jsonl"));
  const instance = new KimiCollector({ home, env: {} });
  const sessions = await instance.collect();
  assert.equal(sessions.filter((session) => session.sessionId === RICH_SESSION).length, 1);
  assert.equal(sessions.find((session) => session.sessionId === RICH_SESSION).project, "preferred-workspace");
  assert.deepEqual(instance.detect().paths, [path.join(home, ".kimi-code", "sessions"), path.join(home, ".kimi", "sessions")]);
});

test("KIMI_CODE_HOME relocates the current tree while legacy stays under home", () => {
  const home = scratch();
  const codeRoot = path.join(scratch(), "custom-code");
  const instance = new KimiCollector({ home, env: { KIMI_CODE_HOME: ` ${codeRoot} ` } });
  assert.deepEqual(instance.roots, [
    path.join(codeRoot, "sessions"),
    path.join(home, ".kimi", "sessions"),
  ]);
});

test("KIMI_SHARE_DIR relocates the legacy tree while current stays under home", () => {
  const home = scratch();
  const shareRoot = path.join(scratch(), "custom-share");
  const instance = new KimiCollector({ home, env: { KIMI_SHARE_DIR: ` ${shareRoot} ` } });
  assert.deepEqual(instance.roots, [
    path.join(home, ".kimi-code", "sessions"),
    path.join(shareRoot, "sessions"),
  ]);
});

test("KIMI_CODE_HOME and KIMI_SHARE_DIR resolve independently", () => {
  const home = scratch();
  const codeRoot = path.join(scratch(), "custom-code");
  const shareRoot = path.join(scratch(), "custom-share");
  const instance = new KimiCollector({ home, env: { KIMI_CODE_HOME: codeRoot, KIMI_SHARE_DIR: shareRoot } });
  assert.deepEqual(instance.roots, [
    path.join(codeRoot, "sessions"),
    path.join(shareRoot, "sessions"),
  ]);
});

test("blank Kimi data-root variables are ignored", () => {
  const home = scratch();
  for (const env of [{ KIMI_CODE_HOME: "" }, { KIMI_CODE_HOME: "   " }, { KIMI_SHARE_DIR: "" }, { KIMI_SHARE_DIR: "   " }]) {
    assert.deepEqual(new KimiCollector({ home, env }).roots, [
      path.join(home, ".kimi-code", "sessions"),
      path.join(home, ".kimi", "sessions"),
    ]);
  }
});

test("without Kimi data-root variables, roots use the explicit home", () => {
  const home = scratch();
  assert.deepEqual(new KimiCollector({ home, env: {} }).roots, [
    path.join(home, ".kimi-code", "sessions"),
    path.join(home, ".kimi", "sessions"),
  ]);
});

test("TurnBegin/TurnEnd delimit turns and an unterminated turn is kept", async () => {
  const session = await richSession();
  assert.equal(session.cli, "kimi");
  assert.equal(session.support, "supported");
  assert.equal(session.project, WORKSPACE);
  assert.equal(session.cwd, null);
  // Two TurnBegin events; the second has no TurnEnd and still counts.
  assert.equal(session.turns.length, 2);
  // Float epoch seconds are converted to ISO.
  assert.equal(session.turns[0].ts, "2026-09-10T00:26:40.000Z");
  assert.equal(session.turns[1].ts, "2026-09-10T00:26:50.000Z");
  assert.equal(session.startedAt, "2026-09-10T00:26:40.000Z");
  assert.equal(session.endedAt, "2026-09-10T00:26:54.000Z");
});

test("StatusUpdate usage is summed per turn and the last context reading wins", async () => {
  const [first] = (await richSession()).turns;
  // token_usage is per model call (verified: input_other rises and falls), so a
  // turn's totals are the sum of its calls.
  assert.equal(first.context.inputTokens, 300);
  assert.equal(first.output, 30);
  assert.equal(first.cacheRead, 1100);
  assert.equal(first.cacheCreate, 128);
  // context_usage is the session gauge: the turn ends at the last reading.
  assert.equal(first.context.fraction, 0.25);
  assert.equal(first.context.source, "native");
});

test("DIS-005: Kimi reports a fraction, never an invented absolute window", async () => {
  const session = await richSession();
  assert.equal(session.model, null);
  assert.deepEqual(session.window, { tokens: null, source: "unknown" });
  for (const turn of session.turns) {
    if (turn.context.fraction !== null) {
      assert.ok(turn.context.fraction > 0 && turn.context.fraction <= 1);
    }
    // No absolute context may be reconstructed from the fraction.
    assert.equal(session.window.tokens, null);
  }
});

test("tool calls and result bytes are read from the wire payload", async () => {
  const [first, second] = (await richSession()).turns;
  assert.deepEqual(first.toolCalls, [{ id: "tool_a", name: "ReadFile", input: { path: "x.js" } }]);
  assert.equal(first.toolResultBytes, 10);
  assert.deepEqual(second.toolCalls, [{ id: "tool_b", name: "Bash", input: { cmd: "ls" } }]);
  // An error result whose output really is the empty string measures 0 bytes;
  // that is a reading, not a substitute for a missing one.
  assert.equal(second.toolResultBytes, 0);
});

test("a turn with no StatusUpdate reports nulls, not zeros", async () => {
  const [, second] = (await richSession()).turns;
  assert.equal(second.context.inputTokens, null);
  assert.equal(second.context.fraction, null);
  assert.equal(second.context.source, "unknown");
  assert.equal(second.cacheRead, null);
  assert.equal(second.cacheCreate, null);
  assert.equal(second.output, null);
  // DIS-004: the wire protocol establishes no sub-agent interval marker.
  assert.equal(second.isSidechain, null);
});

test("an absent tool result leaves bytes null", async () => {
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"timestamp":1789200000.0,"message":{"type":"TurnBegin","payload":{}}}',
    '{"timestamp":1789200001.0,"message":{"type":"ToolCall","payload":{"type":"function","id":"tool_z","function":{"name":"Grep","arguments":"{\\"q\\":\\"x\\"}"}}}}',
    '{"timestamp":1789200002.0,"message":{"type":"ToolResult","payload":{"tool_call_id":"tool_z","return_value":{"is_error":false,"message":"no output field"}}}}',
    '{"timestamp":1789200003.0,"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const session = await collector(home).parseSessionFile(file, meta, createDiagnostic("kimi"));
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].toolCalls.length, 1);
  assert.equal(session.turns[0].toolResultBytes, null);
});

test("limit bounds the scan", async () => {
  const home = scratch();
  cpSync(FIXTURE_HOME, home, { recursive: true });
  const rich = path.join(home, ".kimi", "sessions", WORKSPACE, RICH_SESSION, "wire.jsonl");
  const short = path.join(home, ".kimi", "sessions", WORKSPACE, SHORT_SESSION, "wire.jsonl");
  const newest = new Date("2026-09-11T00:00:00Z");
  const oldest = new Date("2026-09-10T00:00:00Z");
  utimesSync(rich, newest, newest);
  utimesSync(short, oldest, oldest);
  const scoped = collector(home);
  const limited = await scoped.collect({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].sessionId, RICH_SESSION);
  assert.equal((await scoped.collect()).length, 2);
  assert.equal((await scoped.collect({ since: newest })).length, 1);
});

test("an empty file yields no session and no throw", async () => {
  const { home, file, meta } = tempWire("");
  const diagnostic = createDiagnostic("kimi");
  assert.equal(await collector(home).parseSessionFile(file, meta, diagnostic), null);
  assert.equal(diagnostic.errors.length, 0);
  assert.deepEqual(await collector(home).collect(), []);
});

test("a whitespace-only file yields no session and no throw", async () => {
  const { home, file, meta } = tempWire("\n  \n\t\n");
  const diagnostic = createDiagnostic("kimi");
  assert.equal(await collector(home).parseSessionFile(file, meta, diagnostic), null);
  assert.equal(diagnostic.errors.length, 0);
});

test("a truncated JSON line is skipped and the rest of the file still parses", async () => {
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"timestamp":1789300000.0,"message":{"type":"TurnBegin","payload":{}}}',
    '{"timestamp":1789300001.0,"message":{"type":"StatusUpdate","payload":{"context_usage":0.4,"token_',
    '{"timestamp":1789300002.0,"message":{"type":"StatusUpdate","payload":{"context_usage":0.42,"token_usage":{"input_other":8,"output":2,"input_cache_read":4,"input_cache_creation":0}}}}',
    '{"timestamp":1789300003.0,"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("kimi");
  const session = await collector(home).parseSessionFile(file, meta, diagnostic);
  assert.equal(diagnostic.linesSkipped, 1);
  assert.equal(diagnostic.errors.length, 0);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].context.fraction, 0.42);
  assert.equal(session.turns[0].context.inputTokens, 8);
});

test("valid JSON lines with no expected field are skipped and unknown events do not throw", async () => {
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"unrelated":true}',
    '[1,2,3]',
    '{"timestamp":1789400000.0,"message":{"noType":true}}',
    '{"timestamp":1789400001.0,"message":{"type":"TurnBegin","payload":{}}}',
    '{"timestamp":1789400002.0,"message":{"type":"SomethingNewInProtocol2","payload":{}}}',
    '{"timestamp":1789400003.0,"message":{"type":"ContentPart","payload":{"type":"think","think":"x"}}}',
    '{"timestamp":1789400004.0,"message":{"type":"StatusUpdate","payload":{"context_usage":0.6,"token_usage":{"input_other":3,"output":1,"input_cache_read":2,"input_cache_creation":0}}}}',
    '{"timestamp":1789400005.0,"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("kimi");
  const session = await collector(home).parseSessionFile(file, meta, diagnostic);
  // Three unusable records plus one unknown event type.
  assert.equal(diagnostic.linesSkipped, 4);
  assert.equal(diagnostic.errors.length, 0);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].context.fraction, 0.6);
});

test("a file over the byte cap is truncated rather than fully read", async () => {
  const filler = "y".repeat(400);
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"timestamp":1789500000.0,"message":{"type":"TurnBegin","payload":{}}}',
    `{"timestamp":1789500001.0,"message":{"type":"ToolResult","payload":{"tool_call_id":"t1","return_value":{"is_error":false,"output":"${filler}"}}}}`,
    `{"timestamp":1789500002.0,"message":{"type":"ToolResult","payload":{"tool_call_id":"t2","return_value":{"is_error":false,"output":"${filler}"}}}}`,
    '{"timestamp":1789500003.0,"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const capped = collector(home, { maxBytes: 256 });
  const diagnostic = createDiagnostic("kimi");
  const session = await capped.parseSessionFile(file, meta, diagnostic);
  assert.ok(diagnostic.truncated.includes(file));
  assert.equal(diagnostic.errors.length, 0);
  assert.ok(session === null || Array.isArray(session.turns));
  assert.ok(Array.isArray(await capped.collect()));
});

test("a bare timestamp outside the epoch-seconds range is not invented", async () => {
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"timestamp":1789600000000,"message":{"type":"TurnBegin","payload":{}}}',
    '{"timestamp":"not-a-number","message":{"type":"StatusUpdate","payload":{"context_usage":0.3,"token_usage":{"input_other":1,"output":1,"input_cache_read":0,"input_cache_creation":0}}}}',
    '{"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const session = await collector(home).parseSessionFile(file, meta, createDiagnostic("kimi"));
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].ts, null);
  assert.equal(session.startedAt, null);
  assert.equal(session.endedAt, null);
  // The usage was still readable even though no timestamp was.
  assert.equal(session.turns[0].context.fraction, 0.3);
});

test("nested SubagentEvent usage never inflates the parent turn", async () => {
  // Real logs wrap a complete sub-agent stream as
  // {task_tool_call_id, event:{type, payload}}.  Its StatusUpdate is the
  // sub-agent's own gauge and must not be added to the parent's accounting.
  const { home, file, meta } = tempWire([
    '{"type":"metadata","protocol_version":"1.3"}',
    '{"timestamp":1789700000.0,"message":{"type":"TurnBegin","payload":{}}}',
    '{"timestamp":1789700001.0,"message":{"type":"StatusUpdate","payload":{"context_usage":0.11,"token_usage":{"input_other":100,"output":10,"input_cache_read":50,"input_cache_creation":0}}}}',
    '{"timestamp":1789700002.0,"message":{"type":"SubagentEvent","payload":{"task_tool_call_id":"tool_task_1","event":{"type":"StatusUpdate","payload":{"context_usage":0.99,"token_usage":{"input_other":999999,"output":999,"input_cache_read":999999,"input_cache_creation":999}}}}}}',
    '{"timestamp":1789700003.0,"message":{"type":"SubagentEvent","payload":{"task_tool_call_id":"tool_task_1","event":{"type":"ToolCall","payload":{"type":"function","id":"tool_nested","function":{"name":"Grep","arguments":"{}"}}}}}}',
    '{"timestamp":1789700004.0,"message":{"type":"TurnEnd","payload":{}}}',
  ].join("\n") + "\n");
  const diagnostic = createDiagnostic("kimi");
  const session = await collector(home).parseSessionFile(file, meta, diagnostic);
  const [turn] = session.turns;
  assert.equal(session.turns.length, 1);
  assert.equal(turn.context.fraction, 0.11);
  assert.equal(turn.context.inputTokens, 100);
  assert.equal(turn.cacheRead, 50);
  assert.equal(turn.output, 10);
  // The nested tool call belongs to the sub-agent, not to this turn.
  assert.equal(turn.toolCalls.length, 0);
  // Known protocol traffic is not reported as unreadable data.
  assert.equal(diagnostic.linesSkipped, 0);
  // DIS-004: a sub-agent interval is visible in the log but is not claimed here.
  assert.equal(turn.isSidechain, null);
});

// ---------------------------------------------------------------------------
// F-006: nested sub-agent streams become sub-agent sessions
//
// `SubagentEvent` is 33,268 of 92,539 real records on this machine (36%, the
// most common type) and each one wraps a COMPLETE nested wire message keyed by
// `task_tool_call_id`.  Nothing read them, so the analyzer got dispatched = 0
// and BP-003.06 could only say `unknown`.  Wave 2B's decision to keep nested
// events OUT of the parent's accounting is unchanged and still tested above;
// these tests add the destination that data was missing.
// ---------------------------------------------------------------------------

/** `{type, payload}` wrapped as sub-agent `taskId` saw it, at `ts`. */
function subagentEvent(ts, taskId, type, payload = {}) {
  return JSON.stringify({
    timestamp: ts,
    message: { type: "SubagentEvent", payload: { task_tool_call_id: taskId, event: { type, payload } } },
  });
}

function parentEvent(ts, type, payload = {}) {
  return JSON.stringify({ timestamp: ts, message: { type, payload } });
}

/** Parent turn plus two OVERLAPPING sub-agents, the way a real fan-out reads. */
const FANOUT = [
  '{"type":"metadata","protocol_version":"1.3"}',
  parentEvent(1789700000, "TurnBegin"),
  parentEvent(1789700001, "StatusUpdate", { context_usage: 0.11, token_usage: { input_other: 100, output: 10, input_cache_read: 50, input_cache_creation: 0 } }),
  // alpha runs 1789700010 -> 1789700040, beta 1789700020 -> 1789700030: overlapping.
  subagentEvent(1789700010, "tool_alpha", "TurnBegin"),
  subagentEvent(1789700011, "tool_alpha", "StatusUpdate", { context_usage: 0.97, token_usage: { input_other: 888888, output: 777, input_cache_read: 999999, input_cache_creation: 42 } }),
  subagentEvent(1789700020, "tool_beta", "TurnBegin"),
  subagentEvent(1789700021, "tool_beta", "ToolCall", { type: "function", id: "tool_nested_b", function: { name: "Grep", arguments: "{}" } }),
  subagentEvent(1789700030, "tool_beta", "TurnEnd"),
  subagentEvent(1789700040, "tool_alpha", "TurnEnd"),
  parentEvent(1789700050, "TurnEnd"),
].join("\n") + "\n";

/** Collect a wire log, with the sub-agent linkage that `registry.js` forwards. */
async function collectWire(text, options = {}) {
  const { home, meta } = tempWire(text);
  const kimi = collector(home, options.ctor ?? {});
  const sessions = await kimi.collect(options.collect ?? {});
  return { sessions, meta: kimi.sessionMeta, parentId: meta.sessionId, diagnostic: kimi.diagnostic };
}

test("a nested stream becomes its own session, named parent.taskToolCallId", async () => {
  const { sessions, meta, parentId } = await collectWire(FANOUT);
  assert.deepEqual(sessions.map((session) => session.sessionId), [
    parentId,
    `${parentId}.tool_alpha`,
    `${parentId}.tool_beta`,
  ]);

  assert.deepEqual(meta.get(parentId), {
    sessionId: parentId,
    parentSessionId: null,
    taskToolCallId: null,
    subagentSessionIds: [`${parentId}.tool_alpha`, `${parentId}.tool_beta`],
  });
  assert.deepEqual(meta.get(`${parentId}.tool_beta`), {
    sessionId: `${parentId}.tool_beta`,
    parentSessionId: parentId,
    taskToolCallId: "tool_beta",
    subagentSessionIds: [],
  });
});

test("a sub-agent's own gauge lands on the sub-agent: its context, its tool call", async () => {
  const { sessions, parentId } = await collectWire(FANOUT);
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));

  const alpha = byId.get(`${parentId}.tool_alpha`);
  assert.equal(alpha.cli, "kimi");
  assert.equal(alpha.turns.length, 1);
  assert.equal(alpha.turns[0].context.fraction, 0.97, "0.97 is ALPHA's context usage, not the parent's");
  assert.equal(alpha.turns[0].context.inputTokens, 888888);
  assert.equal(alpha.turns[0].cacheRead, 999999);
  // The wrapping SubagentEvent IS the marker DIS-004 said did not exist.
  assert.equal(alpha.turns[0].isSidechain, true);
  // Same refusals as the parent: no model id in the log, and `input_other` is a
  // sum over model calls, so it is never offered as an observed window floor.
  assert.equal(alpha.model, null);
  assert.deepEqual(alpha.window, { tokens: null, source: "unknown" });

  const beta = byId.get(`${parentId}.tool_beta`);
  assert.deepEqual(beta.turns[0].toolCalls.map((call) => call.name), ["Grep"]);
});

test("the analyzer receives overlapping sub-agent intervals from a real fan-out", async () => {
  const { sessions, meta, parentId } = await collectWire(FANOUT);
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const children = meta.get(parentId).subagentSessionIds.map((id) => byId.get(id));

  assert.deepEqual(children.map((child) => child.startedAt), [
    "2026-09-18T02:53:30.000Z", "2026-09-18T02:53:40.000Z",
  ]);
  assert.deepEqual(children.map((child) => child.endedAt), [
    "2026-09-18T02:54:00.000Z", "2026-09-18T02:53:50.000Z",
  ]);
  const spans = children.map((child) => [Date.parse(child.startedAt), Date.parse(child.endedAt)]);
  assert.ok(spans[0][0] < spans[1][1] && spans[1][0] < spans[0][1], "alpha and beta overlap");
});

test("NO INFLATION: reading sub-agents changes not one parent figure", async () => {
  // THE ERROR CLASS THIS TEST EXISTS TO CATCH, and why wave 2B excluded nested
  // events in the first place: alpha reports 888,888 input tokens and 999,999
  // cache reads against a parent turn of 100 and 50. Any leak is unmissable.
  const off = await collectWire(FANOUT, { ctor: { subagents: false } });
  const on = await collectWire(FANOUT);

  assert.equal(off.sessions.length, 1, "with reading off there is only the parent");
  const before = off.sessions[0];
  const after = on.sessions.find((session) => session.sessionId === on.parentId);
  assert.deepEqual(after, before, "the parent session is identical, field for field");

  assert.equal(after.turns.length, 1);
  assert.equal(after.turns[0].context.fraction, 0.11);
  assert.equal(after.turns[0].context.inputTokens, 100);
  assert.equal(after.turns[0].cacheRead, 50);
  assert.equal(after.turns[0].toolCalls.length, 0, "the nested tool call is the sub-agent's");
  assert.equal(after.turns[0].isSidechain, null, "the parent's own status is still unestablished");

  // `null` says sub-agent reading was off; `[]` says it ran and found none.
  assert.equal(off.meta.get(off.parentId).subagentSessionIds, null);
  assert.equal(on.diagnostic.linesSkipped, 0);
  assert.equal(off.diagnostic.linesSkipped, 0, "a SubagentEvent is known traffic either way");
});

test("an unattributable or unknown nested event is reported, not absorbed", async () => {
  // No task_tool_call_id: known protocol traffic with nothing to attribute it
  // to. 0 of 33,268 real SubagentEvents look like this, so it is a guard.
  const orphan = await collectWire([
    parentEvent(1789700000, "TurnBegin"),
    JSON.stringify({ timestamp: 1789700001, message: { type: "SubagentEvent", payload: { event: { type: "TurnBegin", payload: {} } } } }),
    parentEvent(1789700002, "TurnEnd"),
  ].join("\n") + "\n");
  assert.equal(orphan.sessions.length, 1);
  assert.equal(orphan.diagnostic.linesSkipped, 0, "unattributable is not unreadable");

  // A nested type nobody handles is protocol drift and must surface as one,
  // exactly as an unhandled top-level type does.
  const drift = await collectWire([
    parentEvent(1789700000, "TurnBegin"),
    subagentEvent(1789700001, "tool_x", "SomethingNewFromTheVendor"),
    parentEvent(1789700002, "TurnEnd"),
  ].join("\n") + "\n");
  assert.equal(drift.diagnostic.linesSkipped, 1, "a nested type we cannot read is a skipped line");
  assert.equal(drift.sessions.length, 2, "the sub-agent is still known to have existed");
});

test("a sub-agent stream with no TurnEnd still yields its turn and its interval", async () => {
  // Measured on real logs: nested streams show 57 TurnBegin against 50 TurnEnd,
  // so an unclosed sub-agent turn is the normal case, not an edge.
  const { sessions, parentId } = await collectWire([
    parentEvent(1789700000, "TurnBegin"),
    subagentEvent(1789700010, "tool_open", "TurnBegin"),
    subagentEvent(1789700011, "tool_open", "StatusUpdate", { context_usage: 0.4 }),
    subagentEvent(1789700019, "tool_open", "ToolCall", { type: "function", id: "c1", function: { name: "Read", arguments: "{}" } }),
  ].join("\n") + "\n");
  const child = sessions.find((session) => session.sessionId === `${parentId}.tool_open`);
  assert.equal(child.turns.length, 1);
  assert.equal(child.turns[0].context.fraction, 0.4);
  assert.ok(child.startedAt && child.endedAt);
  assert.notEqual(child.startedAt, child.endedAt, "an unclosed stream still has a span");
});

test("limit counts parent sessions, so a selected parent keeps its sub-agents", async () => {
  const { sessions, meta, parentId } = await collectWire(FANOUT, { collect: { limit: 1 } });
  const parents = sessions.filter((session) => meta.get(session.sessionId).parentSessionId === null);
  assert.equal(parents.length, 1);
  assert.equal(meta.get(parentId).subagentSessionIds.length, 2,
    "a dispatched count short by one would move the concurrency ratio");
});

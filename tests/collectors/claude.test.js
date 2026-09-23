import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { windowPromotions } from "../../src/collectors/base.js";
import { ClaudeCollector } from "../../src/collectors/claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures", "claude");
const HOME = path.join(fixtures, "home");
const ROBUST = path.join(fixtures, "robust");
const LARGE = path.join(fixtures, "large");
const MISSING = path.join(fixtures, "does-not-exist");

function byId(sessions) {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

async function collectFrom(root, options = {}, ctor = {}) {
  const collector = new ClaudeCollector({ root, home: root, ...ctor });
  const sessions = await collector.collect(options);
  return { collector, sessions, diagnostic: collector.lastDiagnostic, meta: collector.sessionMeta };
}

/** Sessions the user ran: a `sessionMeta` row with no parent. */
function parentsOf({ sessions, meta }) {
  return sessions.filter((session) => meta.get(session.sessionId)?.parentSessionId == null);
}

/** Sub-agent sessions: a `sessionMeta` row naming the session that dispatched them. */
function childrenOf({ sessions, meta }) {
  return sessions.filter((session) => meta.get(session.sessionId)?.parentSessionId != null);
}

test("detect() reports supported, detection-only, and absent honestly", () => {
  assert.deepEqual(new ClaudeCollector({ root: HOME, home: HOME }).detect(),
    { installed: true, paths: [HOME], status: "supported" });

  // Installed CLI, no transcript directory: detected, not a data source.
  assert.deepEqual(new ClaudeCollector({ root: MISSING, home: HOME }).detect(),
    { installed: true, paths: [HOME], status: "detection-only" });

  assert.deepEqual(new ClaudeCollector({ root: MISSING, home: MISSING }).detect(),
    { installed: false, paths: [], status: "absent" });
});

test("collect() returns nothing and does not throw when the root is absent", async () => {
  const { sessions } = await collectFrom(MISSING);
  assert.deepEqual(sessions, []);
});

test("CLAUDE_CONFIG_DIR relocates the scan, while explicit home wins and blanks are unset", async () => {
  const relocated = await mkdtemp(path.join(os.tmpdir(), "session-rx-claude-env-"));
  cpSync(HOME, path.join(relocated, "projects"), { recursive: true });
  const found = await new ClaudeCollector({ env: { CLAUDE_CONFIG_DIR: ` ${relocated} ` } }).collect();
  assert.ok(found.some((session) => session.sessionId === "sess-dedupe"));

  const explicit = new ClaudeCollector({ home: HOME, env: { CLAUDE_CONFIG_DIR: relocated } });
  assert.equal(explicit.home, HOME);
  assert.equal(new ClaudeCollector({ env: { CLAUDE_CONFIG_DIR: "   " } }).home, path.join(os.homedir(), ".claude"));
  assert.equal(new ClaudeCollector({ env: {} }).home, path.join(os.homedir(), ".claude"));
});

test("THE DEDUPE RULE: cumulative usage is the last line, tool calls are the union", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-dedupe");
  assert.ok(session, "sess-dedupe fixture was parsed");

  // Six lines share message.id msg_dedupe; one more line is a sidechain turn.
  assert.equal(session.turns.length, 2, "six lines of one message.id collapse to ONE turn");

  const turn = session.turns[0];

  // usage is CUMULATIVE: the turn's usage is the LAST line for that id.
  // 120 + 1200 + 60. Summing all six lines would report 7130.
  assert.equal(turn.context.inputTokens, 1380);
  assert.notEqual(turn.context.inputTokens, 7130, "summing cumulative lines double-counts the turn");
  assert.equal(turn.cacheRead, 1200);
  assert.equal(turn.cacheCreate, 60);
  assert.equal(turn.output, 150);
  assert.equal(turn.context.source, "native");

  // tool_use blocks are NOT cumulative: union over the turn's lines.
  // Last-line-only would report 1 tool call; the union is 4.
  assert.equal(turn.toolCalls.length, 4, "union of tool_use blocks across the turn's lines");
  assert.deepEqual(turn.toolCalls.map((call) => call.id), ["toolu_A", "toolu_B", "toolu_C", null]);
  assert.deepEqual(turn.toolCalls.map((call) => call.name), ["Bash", "Read", "Grep", "Bash"]);
  assert.deepEqual(turn.toolCalls[0].input, { command: "ls" });

  // The id-less block is re-emitted at the same position on two lines and is
  // keyed on (position, json), so it counts once.
  assert.equal(turn.toolCalls.filter((call) => call.id === null).length, 1,
    "a re-emitted id-less block at the same slot is one call, not two");
});

test("toolResultBytes sums only results that were actually recorded", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-dedupe");
  // toolu_A -> "hello" (5 bytes); toolu_B -> [{text:"12345678"}] (8 bytes);
  // toolu_C and the id-less call have no tool_result and add nothing.
  assert.equal(session.turns[0].toolResultBytes, 13);
});

test("isSidechain comes from the line's own field and drives sub-agent counting", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-dedupe");
  assert.equal(session.turns[0].isSidechain, false);
  assert.equal(session.turns[1].isSidechain, true);
  assert.equal(session.turns[1].toolResultBytes, 3);
  assert.equal(session.turns[1].context.inputTokens, 100);
});

test("window comes from the model table, and the session model ignores sidechain models", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-dedupe");
  assert.equal(session.model, "claude-opus-5");
  assert.deepEqual(session.window, { tokens: 200000, source: "model-table" });
  assert.equal(session.turns[0].context.fraction, 1380 / 200000);
  assert.equal(session.cwd, "/Users/demo/app");
  assert.equal(session.project, "-Users-demo-app");
  assert.equal(session.cli, "claude");
  assert.equal(session.startedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(session.endedAt, "2026-09-20T10:00:09.000Z");
});

test("F-008/F-014: an unknown model takes the OBSERVED FLOOR as its window, and publishes no fraction", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-unknown");
  assert.equal(session.model, "mystery-model-9");

  // CONTRACT CHANGE (orchestrator ruling F-008). This assertion read
  // {tokens: null, source: "unknown"} until the resolver was wired in: with no
  // table entry the window was simply unreported. The session demonstrably HELD
  // 10 tokens of context, and a session cannot hold more context than its
  // window, so 10 is a measured LOWER BOUND - evidence, not the guess the old
  // assertion existed to forbid. Guessing is still forbidden: with no turn
  // carrying a reading at all the window stays {null, "unknown"} (see the empty
  // and whitespace fixtures below).
  assert.deepEqual(session.window, { tokens: 10, source: "observed-floor" });

  // F-014: at an observed floor the numerator IS the denominator, so any
  // fraction it could produce is 1.0 by construction - an artifact of having no
  // upper bound, not a reading. Every fraction stays unknown and no threshold
  // verdict may be derived from it.
  for (const turn of session.turns) {
    assert.equal(turn.context.fraction, null, "a lower bound is never turned into a percentage");
  }
});

test("HONEST NULLS: an unreadable metric is null; a reported zero stays zero", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("sess-unknown");

  // The log reported cache_creation_input_tokens: 0 — that zero is real.
  assert.equal(session.turns[0].cacheCreate, 0);
  assert.equal(session.turns[0].context.inputTokens, 10);

  // The second line carries no usage object at all: every counter is null.
  const unread = session.turns[1];
  assert.equal(unread.context.inputTokens, null);
  assert.equal(unread.context.fraction, null);
  assert.equal(unread.context.source, "unknown");
  assert.equal(unread.cacheRead, null);
  assert.equal(unread.cacheCreate, null);
  assert.equal(unread.output, null);
  // The tool call happened, but no tool_result was recorded for it.
  assert.equal(unread.toolCalls.length, 1);
  assert.equal(unread.toolResultBytes, null);
});

test("ROBUSTNESS: an empty file yields a session with no turns and no error", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("empty");
  assert.ok(session);
  assert.deepEqual(session.turns, []);
  assert.deepEqual(session.window, { tokens: null, source: "unknown" });
  assert.deepEqual(diagnostic.errors, []);
});

test("ROBUSTNESS: a whitespace-only file yields no turns", async () => {
  const { sessions } = await collectFrom(ROBUST);
  const session = byId(sessions).get("whitespace");
  assert.ok(session);
  assert.deepEqual(session.turns, []);
});

test("ROBUSTNESS: a truncated JSON line mid-file is skipped and counted", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("sess-corrupt");
  assert.ok(session, "lines either side of the corrupt line still parse");
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].toolCalls.length, 1);
  assert.ok(diagnostic.linesSkipped >= 1, "the bad line is counted, not silently dropped");
});

test("ROBUSTNESS: valid JSON with no expected fields is skipped, never crashes", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("bare");
  assert.ok(session);
  assert.equal(session.turns.length, 1, "only the one line carrying a message becomes a turn");
  assert.equal(session.turns[0].context.inputTokens, null);
  assert.ok(diagnostic.linesSkipped >= 5);
  assert.deepEqual(diagnostic.errors, []);
});

test("ROBUSTNESS: the byte cap keeps partial results and records truncation", async () => {
  assert.equal(new ClaudeCollector().maxBytes, 50 * 1024 * 1024, "default cap is 50MB (BP-002.08)");

  // The committed fixtures are deliberately small, so the oversized case is
  // built in the OS temp dir - never in the real home dir.
  const root = path.join(os.tmpdir(), "session-rx-claude-cap");
  const dir = path.join(root, "-tmp-oversized");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "oversized.jsonl");

  const padding = "p".repeat(320);
  const lines = [];
  for (let index = 0; index < 300; index += 1) {
    lines.push(JSON.stringify({
      type: "assistant",
      sessionId: "sess-oversized",
      cwd: "/tmp/oversized",
      timestamp: new Date(Date.UTC(2026, 8, 20, 0, 0, index)).toISOString(),
      uuid: `o${index}`,
      isSidechain: false,
      message: {
        id: `msg_${index}`,
        model: "claude-opus-5",
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
        content: [{ type: "tool_use", id: `toolu_${index}`, name: "Bash", input: { command: padding } }],
      },
    }));
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");

  const collector = new ClaudeCollector({ root, home: root, maxBytes: 70 * 1024 });
  const sessions = await collector.collect();
  assert.equal(sessions.length, 1, "a capped file still yields a session");
  assert.ok(sessions[0].turns.length > 0, "the records read before the cap survive");
  assert.ok(sessions[0].turns.length < 300, "the read stopped before the end of the file");
  assert.ok(collector.lastDiagnostic.truncated.some((entry) => entry.endsWith("oversized.jsonl")),
    "truncation is reported in the diagnostic");
});

test("ROBUSTNESS: a cap smaller than one read chunk still completes without throwing", async () => {
  const { sessions, diagnostic } = await collectFrom(LARGE, {}, { maxBytes: 512 });
  assert.equal(sessions.length, 1, "the session is still reported, with whatever was readable");
  assert.ok(diagnostic.truncated.some((file) => file.endsWith("big.jsonl")));
  assert.deepEqual(diagnostic.errors, []);
});

test("limit and since bound the scan, counted in PARENT sessions", async () => {
  // `limit` bounds the sessions the user ran. A sub-agent is evidence ABOUT one
  // of those, not another one of them, so a selected parent brings its own
  // sub-agents with it: slicing the combined list would drop a sub-agent whose
  // parent was kept and leave `dispatched` short of what really ran.
  const all = await collectFrom(HOME, {}, { subagents: false });
  assert.equal(all.sessions.length, 2, "two parent transcripts in the fixture");

  const limited = await collectFrom(HOME, { limit: 1 }, { subagents: false });
  assert.equal(limited.sessions.length, 1);

  const withKids = await collectFrom(HOME, { limit: 1 });
  assert.equal(parentsOf(withKids).length, 1, "the limit still admits exactly one parent");
  assert.ok(childrenOf(withKids).length > 0, "that parent's sub-agents came with it");

  const future = await collectFrom(HOME, { since: new Date("2999-01-01T00:00:00.000Z") });
  assert.deepEqual(future.sessions, []);

  const epoch = await collectFrom(HOME, { since: new Date(0) });
  assert.equal(parentsOf(epoch).length, 2);
});

test("every collected session matches the normalized contract", async () => {
  const { sessions } = await collectFrom(HOME);
  for (const session of sessions) {
    assert.deepEqual(Object.keys(session).sort(), [
      "cli", "cwd", "endedAt", "model", "project", "sessionId",
      "startedAt", "support", "turns", "window",
    ]);
    assert.equal(session.support, "supported");
    for (const turn of session.turns) {
      assert.deepEqual(Object.keys(turn).sort(), [
        "cacheCreate", "cacheRead", "context", "isSidechain",
        "output", "toolCalls", "toolResultBytes", "ts",
      ]);
      assert.ok(["native", "derived", "unknown"].includes(turn.context.source));
    }
  }
});

/**
 * One transcript in a FRESH temp root, at real context sizes - never the real
 * home directory.  `turns` are per-turn context readings in order; `sidechain`
 * marks a sub-agent turn.  Caches are explicit zeros so the reading a test names
 * is exactly the context the collector computes.
 */
async function windowFixture(model, turns) {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-rx-claude-window-"));
  const dir = path.join(root, "-tmp-window");
  await mkdir(dir, { recursive: true });
  const lines = turns.map((turn, index) => JSON.stringify({
    type: "assistant",
    sessionId: "sess-window",
    cwd: "/tmp/window",
    timestamp: new Date(Date.UTC(2026, 8, 20, 11, 0, index)).toISOString(),
    uuid: `w${index}`,
    isSidechain: turn.sidechain === true,
    message: {
      id: `msg_${index}`,
      model,
      usage: {
        input_tokens: turn.context,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  }));
  await writeFile(path.join(dir, "sess-window.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return collectFrom(root);
}

test("F-008: the session's own peak outranks a stale table window (2.08 becomes 0.42)", async () => {
  const { sessions, collector } = await windowFixture("claude-opus-5", [
    { context: 120000 },
    { context: 416200 },
  ]);
  const [session] = sessions;
  assert.equal(session.model, "claude-opus-5");

  // The table says 200,000 for this id. This session HELD 416,200, and a session
  // cannot hold more context than its window: that is proof the TABLE is wrong
  // for it, not proof the measurement is wrong. 416,200 is a real
  // `claude-opus-5` session on this machine that reported "fraction 2.08".
  assert.deepEqual(session.window, { tokens: 1000000, source: "observed-promoted" });
  assert.equal(session.turns[1].context.fraction, 416200 / 1000000);
  assert.ok(session.turns[1].context.fraction <= 1, "no fraction above 1.0 is ever published");
  assert.notEqual(session.turns[1].context.fraction, 416200 / 200000, "the stale table is not the denominator");

  // The stale entry is SURFACED on the diagnostic, not silently papered over.
  const [promotion] = windowPromotions(collector.lastDiagnostic);
  assert.ok(promotion, "the promotion is recorded");
  assert.equal(promotion.sessionId, "sess-window");
  assert.equal(promotion.tableTokens, 200000);
  assert.equal(promotion.observedFloor, 416200);
  assert.equal(promotion.tokens, 1000000);
  assert.equal(promotion.ladder, "vendor", "a Claude window is an Anthropic tier, never OpenAI's 400,000");
});

test("F-008: a SIDECHAIN peak is inside the floor, so no turn can publish a fraction above 1.0", async () => {
  const { sessions } = await windowFixture("claude-opus-5", [
    { context: 90000 },
    { context: 350000, sidechain: true },
  ]);
  const [session] = sessions;

  // THE TRAP: the main chain alone fits inside the table's 200,000. Taking the
  // floor from main-chain turns only would keep the window at 200,000 and then
  // publish the sidechain turn at 1.75. Every turn divides by this ONE window,
  // so the floor must cover every turn that will be divided by it.
  assert.deepEqual(session.window, { tokens: 1000000, source: "observed-promoted" });
  assert.equal(session.turns[1].isSidechain, true);
  assert.equal(session.turns[1].context.fraction, 350000 / 1000000);
  for (const turn of session.turns) {
    assert.ok(turn.context.fraction === null || turn.context.fraction <= 1,
      `fraction ${turn.context.fraction} exceeds the window`);
  }
});

test("F-010: the floor is a MAX over turns, never their sum", async () => {
  const { sessions } = await windowFixture("mystery-model-9", [
    { context: 30000 },
    { context: 41344 },
    { context: 12000 },
  ]);
  const [session] = sessions;
  // 30,000 + 41,344 + 12,000 = 83,344. Summing would invent that window for a
  // session whose largest single context was 41,344.
  assert.deepEqual(session.window, { tokens: 41344, source: "observed-floor" });
  assert.notEqual(session.window.tokens, 83344, "a sum is not a context reading");
});

test("no session from any fixture publishes a context fraction above 1.0", async () => {
  for (const root of [HOME, ROBUST, LARGE]) {
    const { sessions } = await collectFrom(root);
    for (const session of sessions) {
      for (const turn of session.turns) {
        assert.ok(turn.context.fraction === null || turn.context.fraction <= 1,
          `${session.sessionId}: fraction ${turn.context.fraction}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// F-016: sub-agent transcripts are read, and the parent is left alone
//
// A dispatched sub-agent writes nothing to the main transcript — measured on
// this machine, `isSidechain` is true on ZERO of 138,358 main-transcript
// records and true on every record of the 1,105 files under `subagents/`.  The
// collector listed that directory and never opened it, so BP-003.06 read
// `unknown` for every Claude session: the sixth of six specified rules had
// never produced a verdict anywhere.
// ---------------------------------------------------------------------------

test("a sub-agent transcript becomes its own session, named after parent and agent", async () => {
  const collected = await collectFrom(HOME);
  const children = childrenOf(collected);
  assert.deepEqual(children.map((session) => session.sessionId).sort(), [
    "sess-dedupe.alpha-aaaa1111",
    "sess-dedupe.beta-bbbb2222",
    "sess-unknown.alpha-aaaa1111",
  ]);

  const alpha = collected.meta.get("sess-dedupe.alpha-aaaa1111");
  assert.deepEqual(alpha, {
    sessionId: "sess-dedupe.alpha-aaaa1111",
    parentSessionId: "sess-dedupe",
    agentId: "alpha-aaaa1111",
    subagentSessionIds: [],
  });

  // Its own turns, its own model, its own interval — read from its own file.
  const session = byId(collected.sessions).get("sess-dedupe.alpha-aaaa1111");
  assert.equal(session.cli, "claude");
  assert.equal(session.turns.length, 2);
  assert.equal(session.model, "claude-opus-5");
  assert.equal(session.startedAt, "2026-09-20T10:01:00.000Z");
  assert.equal(session.endedAt, "2026-09-20T10:05:00.000Z");
  assert.equal(session.turns[0].isSidechain, true);
});

test("the same agentId under two parents stays two sessions (20 real ids do this)", async () => {
  // `agentId` alone is not unique: across all 1,105 real sub-agent files, 20
  // agent ids appear under more than one parent. Keyed on the agent id alone,
  // two different sub-agents would collapse into one row and the analyzer would
  // be handed one interval where two ran.
  const collected = await collectFrom(HOME);
  const shared = childrenOf(collected).filter((session) => session.sessionId.endsWith(".alpha-aaaa1111"));
  assert.equal(shared.length, 2, "one agent id, two parents, two sessions");
  assert.deepEqual(shared.map((session) => collected.meta.get(session.sessionId).parentSessionId).sort(),
    ["sess-dedupe", "sess-unknown"]);
  assert.equal(new Set(shared.map((session) => session.sessionId)).size, 2);
});

test("a file in subagents/ that is not an agent transcript is ignored", async () => {
  // `notes.jsonl` sits beside the agent files in the fixture.
  const collected = await collectFrom(HOME);
  for (const session of childrenOf(collected)) {
    assert.ok(collected.meta.get(session.sessionId).agentId, `${session.sessionId} came from an agent-*.jsonl`);
  }
  assert.equal(childrenOf(collected).length, 3);
});

test("a parent that dispatched none carries an EMPTY list, not a missing one", async () => {
  // The distinction the analyzer needs: an empty list is a measured zero, a
  // null one means sub-agent reading was off and nothing was looked for.
  const looked = await collectFrom(ROBUST);
  for (const session of parentsOf(looked)) {
    assert.deepEqual(looked.meta.get(session.sessionId).subagentSessionIds, [],
      `${session.sessionId} has no subagents/ directory, which is a measured zero`);
  }
  assert.equal(looked.diagnostic.filesSkipped, 0, "an absent subagents/ dir is not an unreadable file");

  const notLooked = await collectFrom(ROBUST, {}, { subagents: false });
  for (const session of parentsOf(notLooked)) {
    assert.equal(notLooked.meta.get(session.sessionId).subagentSessionIds, null);
  }
});

test("NO INFLATION: sub-agent reading changes not one parent figure", async () => {
  // THE ERROR CLASS THIS TEST EXISTS TO CATCH. A sub-agent's context and cache
  // are ITS OWN gauge. Folding them into the session that dispatched it is what
  // once inflated this codebase's context figures 1.97x, and the fixture's
  // sub-agents carry deliberately huge usage (900,000 input tokens) so that any
  // leak into the parent is unmissable.
  const off = await collectFrom(HOME, {}, { subagents: false });
  const on = await collectFrom(HOME);

  const before = byId(off.sessions);
  for (const parent of parentsOf(on)) {
    const plain = before.get(parent.sessionId);
    assert.ok(plain, `${parent.sessionId} is the same session either way`);
    assert.deepEqual(parent, plain, `${parent.sessionId} is unchanged, field for field`);
  }
  assert.equal(parentsOf(on).length, off.sessions.length, "no parent appeared or vanished");

  // Named explicitly, so a partial leak cannot pass by deep-equalling something
  // else that also moved.
  const peak = (session) => Math.max(0, ...session.turns.map((turn) => turn.context.inputTokens ?? 0));
  for (const parent of parentsOf(on)) {
    const plain = before.get(parent.sessionId);
    assert.equal(parent.turns.length, plain.turns.length, `${parent.sessionId} turn count`);
    assert.equal(peak(parent), peak(plain), `${parent.sessionId} peak context`);
    assert.deepEqual(parent.window, plain.window, `${parent.sessionId} resolved window`);
    assert.equal(parent.endedAt, plain.endedAt, `${parent.sessionId} end time`);
  }
  // The 900,000-token sub-agent turn exists, and it exists somewhere ELSE.
  assert.ok(childrenOf(on).some((session) => peak(session) === 910000));
  assert.ok(parentsOf(on).every((session) => peak(session) < 900000));
});

test("the analyzer receives real sub-agent intervals, so BP-003.06 can be measured", async () => {
  // The shape `src/analyzer/health.js` builds `ctx.children` from: a
  // `sessionMeta` row naming the parent, plus the child's own start and end
  // taken from the child SESSION. Both halves have to be present or the rule is
  // handed a dispatched count with no interval and must report unknown.
  const collected = await collectFrom(HOME);
  const sessions = byId(collected.sessions);
  const children = [...collected.meta.values()]
    .filter((row) => row.parentSessionId === "sess-dedupe")
    .map((row) => sessions.get(row.sessionId));

  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(child.startedAt, `${child.sessionId} carries a start`);
    assert.ok(child.endedAt, `${child.sessionId} carries an end`);
    assert.ok(Date.parse(child.endedAt) >= Date.parse(child.startedAt));
  }

  // alpha 10:01-10:05 and beta 10:02-10:04 overlap: 2 running at once of 2
  // dispatched. Not a fixture convenience — a real session measured this way
  // showed 3 concurrent of 18 dispatched.
  const spans = children.map((child) => [Date.parse(child.startedAt), Date.parse(child.endedAt)]);
  assert.ok(spans[0][0] < spans[1][1] && spans[1][0] < spans[0][1], "the two intervals overlap");
});

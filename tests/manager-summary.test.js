/**
 * tests/manager-summary.test.js — `buildManagerSummary` (src/analyzer/health.js)
 * and its wiring into `buildReportInput` / the generated report's "Summary
 * for managers" section (src/report/generator.js).
 *
 * Fixtures only: no read of a developer's real ~/.claude or ~/.session-rx.
 *
 * Pins the honesty rules the summary must keep:
 *   - `unknown` is its own bucket, never folded into observed/not-observed.
 *   - a null count stays null through the report generator, never becomes 0.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSession, buildManagerSummary, buildReportInput } from "../src/analyzer/health.js";
import { generateReport } from "../src/report/generator.js";

function turn(overrides = {}) {
  return { ts: "2026-09-20T10:00:00Z", context: { inputTokens: 100 }, ...overrides };
}

/** A session that will observe `repeat-tool` (5 identical calls) and pass the rest cleanly. */
function repeatToolSession(cli, sessionId) {
  const call = { name: "Read", input: { file: "a.txt" } };
  const turns = Array.from({ length: 5 }, (_, i) => ({
    ts: `2026-09-20T10:0${i}:00Z`,
    toolCalls: [call],
    toolResultBytes: 4096,
    context: { inputTokens: 100 },
  }));
  return { cli, sessionId, model: "test-model", window: { tokens: 200000, source: "model-table" }, turns };
}

/** A session with no turns at all: every rule reports unknown. */
function emptySession(cli, sessionId) {
  return { cli, sessionId, turns: [] };
}

test("buildManagerSummary: sessionsAnalyzed and the three verdict buckets never overlap", () => {
  const sessions = [
    analyzeSession(repeatToolSession("claude", "s1"), { toolCallsRecorded: true }),
    analyzeSession(emptySession("claude", "s2"), {}),
  ];
  const summary = buildManagerSummary({ sessions, clis: [] });

  assert.equal(summary.sessionsAnalyzed, 2);
  const total = summary.verdicts.observed + summary.verdicts.notObserved + summary.verdicts.unknown;
  // Every rule on every session lands in exactly one bucket: 6 rules * 2 sessions.
  assert.equal(total, 12);
  assert.ok(summary.verdicts.observed >= 1, "repeat-tool should be observed on s1");
  assert.ok(summary.verdicts.unknown >= 6, "every rule on the empty session is unknown");
});

test("buildManagerSummary: perCheck names match the plain rule names, and counts sum to the totals", () => {
  const sessions = [analyzeSession(repeatToolSession("claude", "s1"), { toolCallsRecorded: true })];
  const summary = buildManagerSummary({ sessions, clis: [] });

  assert.equal(summary.perCheck.length, 6);
  const repeatRow = summary.perCheck.find((row) => row.id === "repeat-tool");
  assert.equal(repeatRow.name, "Ran the same command again and again");
  assert.equal(repeatRow.observed, 1);

  const summedObserved = summary.perCheck.reduce((sum, row) => sum + row.observed, 0);
  const summedNotObserved = summary.perCheck.reduce((sum, row) => sum + row.notObserved, 0);
  const summedUnknown = summary.perCheck.reduce((sum, row) => sum + row.unknown, 0);
  assert.equal(summedObserved, summary.verdicts.observed);
  assert.equal(summedNotObserved, summary.verdicts.notObserved);
  assert.equal(summedUnknown, summary.verdicts.unknown);
});

test("buildManagerSummary: perTool covers exactly the supported tools", () => {
  const summary = buildManagerSummary({ sessions: [], clis: [] });
  assert.deepEqual(summary.perTool.map((r) => r.cli), ["claude", "codex", "cursor"]);
});

test("buildManagerSummary includes a collector supplied outside the registry literal", () => {
  const summary = buildManagerSummary({ sessions: [], clis: [{ cli: "future-cli", support: "supported" }] });
  assert.deepEqual(summary.perTool.map((r) => r.cli), ["claude", "codex", "cursor", "future-cli"]);
});

test("report aggregation excludes not-applicable sessions and exposes the denominator", () => {
  const codex = analyzeSession(repeatToolSession("codex", "codex-1"), { toolCallsRecorded: true });
  const claude = analyzeSession(repeatToolSession("claude", "claude-1"), { toolCallsRecorded: true });
  const input = buildReportInput({ sessions: [codex, claude], clis: [{ cli: "codex" }, { cli: "claude" }] });
  const aggregate = input.rules.find((rule) => rule.id === "subagent-concurrency");
  assert.ok(aggregate, "the mixed corpus still aggregates the applicable Claude session");
  assert.equal(aggregate.evidence.values.find((value) => value.label === "sessions checked").value, 1);
  assert.equal(aggregate.evidence.values.find((value) => value.label.includes("not applicable")).value, 1);
  assert.equal(input.notApplicable.filter((item) => item.ruleId === "subagent-concurrency").length, 1);
});

test("buildManagerSummary: a tool with sessions read gets a real (non-null) problem count", () => {
  const sessions = [analyzeSession(repeatToolSession("claude", "s1"), { toolCallsRecorded: true })];
  const summary = buildManagerSummary({
    sessions,
    clis: [{ cli: "claude", sessions: 1, support: "supported", note: null }],
  });
  const row = summary.perTool.find((r) => r.cli === "claude");
  assert.equal(row.status, "read");
  assert.equal(row.sessions, 1);
  assert.equal(row.problems, 1);
});

test("buildReportInput computes summary automatically when not supplied", () => {
  const sessions = [analyzeSession(repeatToolSession("claude", "s1"), { toolCallsRecorded: true })];
  const input = buildReportInput({ sessions, clis: [{ cli: "claude", sessions: 1, support: "supported", note: null }] });
  assert.equal(input.summary.sessionsAnalyzed, 1);
  assert.ok(Array.isArray(input.summary.perCheck));
  assert.ok(Array.isArray(input.summary.perTool));
});

test("the rendered Markdown's 'Summary for managers' section states the honesty rule for unknown, in plain words", () => {
  const sessions = [analyzeSession(emptySession("claude", "s1"), {})];
  const input = buildReportInput({ sessions, clis: [{ cli: "claude", sessions: 1, support: "supported", note: null }] });
  const md = generateReport(input);
  assert.match(md, /## Summary for managers/);
  assert.match(md, /could not be measured — this is explicitly not a pass/i);
  // Comes before every numbered section.
  assert.ok(md.indexOf("## Summary for managers") < md.indexOf("## 1. Date range covered"));
});

test("a null summary count renders as 'not available', never as 0, in the Markdown summary", () => {
  const input = buildReportInput({ sessions: [] });
  input.summary = {
    sessionsAnalyzed: null,
    verdicts: { observed: null, notObserved: null, unknown: null },
    perCheck: [],
    perTool: [],
  };
  const md = generateReport(input);
  assert.match(md, /Sessions checked: not available\./);
  assert.match(md, /Problems found: not available\./);
  assert.match(md, /Checks that could not be measured: not available\./);
  assert.doesNotMatch(md, /Sessions checked: 0/);
});

test("no structured summary at all degrades to an honest sentence, never a fabricated section", () => {
  const input = buildReportInput({ sessions: [] });
  delete input.summary;
  const md = generateReport(input);
  assert.match(md, /## Summary for managers/);
  assert.match(md, /could not be computed for this report/i);
});

/**
 * ReportInput fixtures for the "do not pad" cases.
 *
 *   zeroFindingsInput — six rules evaluated, NONE observed. Three of them are
 *     `unknown`, which is exactly the situation where a lesser report would
 *     print a clean bill of health.
 *   twoFindingsInput — two observed rules. The report must print two, say that
 *     is fewer than three, and invent nothing.
 *
 * Both are shaped against the INPUT CONTRACT at the top of
 * src/report/generator.js.
 */

const NOT_OBSERVED = (id, name, reason) => ({
  id,
  name,
  severity: "warn",
  fix: null,
  threshold: { value: null, derivation: "see BP-003" },
  evidence: {
    status: "not-observed",
    reason,
    values: [],
    sources: ["~/.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-aaaa1111-2222-4333-8444-555566667777.jsonl"],
    derivation: "evaluated against real records",
    parserVersion: "2026-09-20.2",
  },
});

const UNKNOWN = (id, name, reason) => ({
  id,
  name,
  severity: "warn",
  fix: null,
  threshold: { value: null, derivation: "see BP-003" },
  evidence: {
    status: "unknown",
    reason,
    values: [],
    sources: [],
    derivation: "not computed: prerequisite field absent",
    parserVersion: "2026-09-20.2",
  },
});

export const zeroFindingsInput = {
  generatedAt: "2026-09-20T16:00:00Z",
  parserVersion: "2026-09-20.2",
  range: { from: "2026-09-20T09:00:00Z", to: "2026-09-20T15:00:00Z", sessions: 3 },
  clis: [{ cli: "codex", sessions: 3, support: "supported", note: null }],
  rules: [
    NOT_OBSERVED("context-pressure", "Context pressure", "peak context 84,210 against a native window of 400,000 is 0.21, below the 0.70 threshold"),
    NOT_OBSERVED("large-tool-result", "Large tool results", "1 tool result exceeded 10,240 bytes, below the 3-result threshold"),
    NOT_OBSERVED("long-rising-context", "Long rising context", "longest session was 1.2h, below the 4h threshold"),
    UNKNOWN("cache-hit", "Low cache hit", "Codex rollout records carry no cache counters in this range, so the denominator is zero and the rate cannot be computed"),
    UNKNOWN("repeat-tool", "Repeated tool work", "tool results were not recoverable for 3 of 3 sessions, so same-input/same-result cannot be established without a false positive (DIS-003)"),
    UNKNOWN("subagent-concurrency", "High sub-agent concurrency", "Codex records establish no parent/child intervals, so sub-agent concurrency is not computable for this CLI (DIS-004)"),
  ],
  fixes: [],
  trend: {
    direction: "unknown",
    reason: "3 sessions over 6 hours is too short a baseline to establish a direction",
    metrics: [],
  },
};

export const twoFindingsInput = {
  generatedAt: "2026-09-20T16:10:00Z",
  parserVersion: "2026-09-20.2",
  range: { from: "2026-09-18T09:00:00Z", to: "2026-09-20T15:00:00Z", sessions: 17 },
  clis: [
    { cli: "claude", sessions: 12, support: "supported", note: null },
    { cli: "cursor", sessions: 5, support: "supported", note: "native fraction only; window.tokens left null per DIS-005" },
  ],
  rules: [
    {
      id: "context-pressure",
      name: "Context pressure",
      severity: "warn",
      fix: "claude-auto-compact",
      threshold: { value: 0.7, derivation: "fraction > 0.70 when the CLI supplies a native fraction" },
      evidence: {
        status: "observed",
        values: [
          { label: "peak native context fraction", value: 0.91, unit: "fraction", sessionId: "3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31", windowSource: "native" },
          { label: "session average native context fraction", value: 0.7742, unit: "fraction", sessionId: "3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31", windowSource: "native" },
        ],
        sources: ["~/.cursor/chats/3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31.json"],
        derivation: "native fraction read straight from the wire record; no token count invented (DIS-005)",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "large-tool-result",
      name: "Large tool results",
      severity: "warn",
      fix: "claude-output-hygiene",
      threshold: { value: 10240, derivation: "toolResultBytes > 10,240 for >= 3 tool results" },
      evidence: {
        status: "observed",
        values: [
          { label: "tool results above 10,240 bytes", value: 7, unit: "count", sessionId: "3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31" },
          { label: "largest tool result", value: 402118, unit: "bytes", sessionId: "3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31" },
        ],
        sources: ["~/.cursor/chats/3f8a5c02-1d47-4b9e-8e10-77c4a2b90d31.json"],
        derivation: "byte length of each recovered tool result",
        parserVersion: "2026-09-20.2",
      },
    },
    NOT_OBSERVED("cache-hit", "Low cache hit", "cache hit rate 0.94 across 12 Claude sessions, above the 0.85 threshold"),
    UNKNOWN("repeat-tool", "Repeated tool work", "5 Cursor sessions expose calls without a canonical result signature (DIS-003)"),
  ],
  fixes: [
    {
      id: "claude-batch-commands",
      name: "Append batching instructions",
      target: "~/.claude/CLAUDE.md",
      appliedAt: "2026-09-20T16:05:41Z",
      status: "applied",
      before: null,
    },
  ],
  trend: { direction: "stable", reason: "mean peak context moved 3% across the window, inside measurement noise", metrics: [] },
};

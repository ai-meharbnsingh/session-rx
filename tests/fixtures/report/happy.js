/**
 * ReportInput fixture — the realistic happy path.
 *
 * Shaped by hand against the INPUT CONTRACT at the top of
 * src/report/generator.js.  The analyzer wave (src/analyzer/*) does not exist
 * yet; when it lands it must produce this shape.
 *
 * Deliberate properties, each one load-bearing for a test:
 *   - FOUR rules are `observed`, so the 3-finding cap is exercised.
 *   - `context-pressure` carries a fraction of 2.08 (F-008 control case
 *     1ecace68) and an `observed-promoted` window, so both the impossible
 *     reading and the inferred-window label are exercised.
 *   - `repeat-tool` is `unknown` for Cursor per DIS-003, with a real reason.
 *   - `subagent-concurrency` is `not-observed` — evaluated, threshold not met.
 *   - session ids are dashed UUIDs, which survive redaction (a continuous
 *     32-char hex run would not).
 */

export const happyInput = {
  generatedAt: "2026-09-20T15:42:07Z",
  parserVersion: "2026-09-20.2",
  range: {
    from: "2026-09-13T08:14:02Z",
    to: "2026-09-20T15:31:55Z",
    sessions: 120,
  },
  clis: [
    { cli: "claude", sessions: 96, support: "supported", note: null },
    { cli: "codex", sessions: 14, support: "supported", note: null },
    { cli: "cursor", sessions: 8, support: "supported", note: "tool results carry no stable byte length; see DIS-006" },
    { cli: "widget", sessions: 2, support: "supported", note: "native context fraction only; absolute window left null per DIS-005" },
    { cli: "antigravity", sessions: null, support: "detection-only", note: "installed, but Antigravity exposes no transcript; absence of sessions is not an absence of usage (DIS-007)" },
  ],
  rules: [
    {
      id: "long-rising-context",
      name: "Long rising context",
      severity: "critical",
      fix: "claude-compact-contract",
      threshold: {
        value: "4h and positive slope",
        derivation: "elapsed > 4h AND robust linear slope of known context observations > 0 AND at least 3 observations",
      },
      evidence: {
        status: "observed",
        values: [
          { label: "session elapsed", value: 7.4, unit: "hours", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "context observations used for the slope", value: 214, unit: "count", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "context at first observation", value: 41207, unit: "tokens", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "context at last observation", value: 416200, unit: "tokens", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "slope", value: 50674.7, unit: "tokens", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
        ],
        sources: [
          "~/.claude/projects/-Users-demo-app/1ecace68-4f31-4a0e-9a2d-88b1c0f4e512.jsonl",
        ],
        derivation: "Theil-Sen slope over (ts, context.inputTokens) pairs where both are non-null",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "context-pressure",
      name: "Context pressure",
      severity: "warn",
      fix: "claude-auto-compact",
      threshold: {
        value: 0.7,
        derivation: "context > 0.70 * window.tokens; for a native fraction, fraction > 0.70",
      },
      evidence: {
        status: "observed",
        values: [
          {
            label: "peak context",
            value: 416200,
            unit: "tokens",
            sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512",
            windowSource: "observed-promoted",
          },
          {
            label: "peak context against the model-id table window of 200,000",
            value: 2.081,
            unit: "fraction",
            sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512",
            windowSource: "model-table",
          },
          {
            label: "peak context against the promoted window of 1,000,000",
            value: 0.4162,
            unit: "fraction",
            sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512",
            windowSource: "observed-promoted",
          },
          {
            label: "session average context against the promoted window",
            value: 0.7431,
            unit: "fraction",
            sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512",
            windowSource: "observed-promoted",
          },
        ],
        sources: [
          "~/.claude/projects/-Users-demo-app/1ecace68-4f31-4a0e-9a2d-88b1c0f4e512.jsonl",
        ],
        derivation: "max and mean of per-turn context.inputTokens; window resolved by F-008 (observation outranks the model-id table)",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "large-tool-result",
      name: "Large tool results",
      severity: "warn",
      fix: "claude-output-hygiene",
      threshold: { value: 10240, derivation: "toolResultBytes > 10,240 for >= 3 tool results in a session" },
      evidence: {
        status: "observed",
        values: [
          { label: "tool results above 10,240 bytes", value: 31, unit: "count", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "largest tool result", value: 1842311, unit: "bytes", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
          { label: "total bytes in oversized results", value: 9127884, unit: "bytes", sessionId: "1ecace68-4f31-4a0e-9a2d-88b1c0f4e512" },
        ],
        sources: ["~/.claude/projects/-Users-demo-app/1ecace68-4f31-4a0e-9a2d-88b1c0f4e512.jsonl"],
        derivation: "byte length of each tool_result content block, counted once per tool id",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "cache-hit",
      name: "Low cache hit",
      severity: "warn",
      fix: "claude-output-hygiene",
      threshold: { value: 0.85, derivation: "cacheRead / (cacheRead + cacheCreate) when the denominator > 0; flag below 0.85" },
      evidence: {
        status: "observed",
        values: [
          { label: "cache read tokens", value: 18422901, unit: "tokens", sessionId: "6a0c12d4-7b91-4f02-8c33-2de5091aa7b1" },
          { label: "cache create tokens", value: 4118220, unit: "tokens", sessionId: "6a0c12d4-7b91-4f02-8c33-2de5091aa7b1" },
          { label: "cache hit rate", value: 0.8173, unit: "ratio", sessionId: "6a0c12d4-7b91-4f02-8c33-2de5091aa7b1" },
        ],
        sources: ["~/.claude/projects/-Users-demo-app/6a0c12d4-7b91-4f02-8c33-2de5091aa7b1.jsonl"],
        derivation: "summed per-message usage, last line per message.id (FVA-001)",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "repeat-tool",
      name: "Repeated tool work",
      severity: "warn",
      fix: "claude-batch-commands",
      threshold: { value: 5, derivation: "same normalized tool name + canonical input + canonical result signature >= 5 times" },
      evidence: {
        status: "unknown",
        reason: "the 8 Cursor sessions in this range record tool calls but no stable tool-result contract, so the same-input/same-result test cannot be evaluated without producing a same-input-only false positive (DIS-003)",
        values: [
          { label: "cursor sessions with tool calls but no result mapping", value: 8, unit: "count" },
        ],
        sources: ["~/.cursor/chats/session-2026-09-20T10-00-00-aaaa1111.json"],
        derivation: "not computed: prerequisite result signature is absent",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "subagent-concurrency",
      name: "High sub-agent concurrency",
      severity: "warn",
      fix: "claude-worker-cap",
      threshold: { value: 0.5, derivation: "peak simultaneous sidechain intervals > 0.50 * dispatched" },
      evidence: {
        status: "not-observed",
        reason: "isSidechain is present on all 96 Claude sessions; peak simultaneous sidechain intervals was 2 against 11 dispatched (0.18), below the 0.50 threshold",
        values: [
          { label: "peak simultaneous sidechains", value: 2, unit: "count" },
          { label: "sub-agents dispatched", value: 11, unit: "count" },
          { label: "peak over dispatched", value: 0.1818, unit: "ratio" },
        ],
        sources: ["~/.claude/projects/-Users-demo-app/1ecace68-4f31-4a0e-9a2d-88b1c0f4e512.jsonl"],
        derivation: "interval sweep over sidechain message spans",
        parserVersion: "2026-09-20.2",
      },
    },
  ],
  fixes: [
    {
      id: "claude-auto-compact",
      name: "Enable Claude auto-compact",
      target: "~/.claude/settings.json",
      appliedAt: "2026-09-20T15:33:10Z",
      status: "applied",
      before: '{\n  "model": "claude-opus-5",\n  "autoCompact": false\n}',
      after: '{\n  "model": "claude-opus-5",\n  "autoCompact": true\n}',
      undoPath: "~/.session-rx/undo/2026-09-20T15-33-10-settings.json",
    },
    {
      id: "claude-output-hygiene",
      name: "Append output-hygiene instructions",
      target: "~/.claude/CLAUDE.md",
      appliedAt: "2026-09-20T15:34:02Z",
      status: "applied",
      before: "(no output-hygiene section present; file ended at line 412)",
      undoPath: "~/.session-rx/undo/2026-09-20T15-34-02-CLAUDE.md",
    },
  ],
  trend: {
    direction: "declining",
    reason: "mean session context rose across the seven days while cache hit rate fell; both moves are in the costly direction",
    metrics: [
      { label: "mean peak context per session", from: 232118, to: 411351, unit: "tokens", windowSource: "observed-promoted" },
      { label: "mean cache hit rate", from: 0.8912, to: 0.8173, unit: "ratio" },
      { label: "sessions longer than 4h", from: 3, to: 11, unit: "count" },
    ],
  },
};

export default happyInput;

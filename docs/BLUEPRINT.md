# SessionRx Blueprint

| Field | Value |
|---|---|
| BP-ID | BP-000 |
| Product | `session-rx` |
| Invocation | `npx session-rx` |
| Runtime | Node.js + Express; vanilla browser JavaScript; vendored Chart.js |
| Trust boundary | Local machine; read-only collectors; explicit user-triggered local fixes |
| Evidence authority | `EVIDENCE_cli_formats.md`, probed 2026-09-20 |
| Non-goals | Cloud; accounts; telemetry; AI API calls; log mutation; invented parsers |
| Binding gates | `GATE-SEC`, `GATE-OFFLINE`, `GATE-PERF`, `GATE-FIX`, `GATE-COLLECT`, `GATE-FACTORY` |

## BP-001 Component inventory

| BP-ID | File | Single responsibility | Public exports | Callers |
|---|---|---|---|---|
| BP-001.01 | `src/cli.js` | Parse CLI options, select free loopback port, start server, open browser | `main`, `parseArgs` | `package.json` bin; `main` calls `server.createApp` and `server.startServer` |
| BP-001.02 | `src/server.js` | Express routes, startup nonce, loopback binding, request validation | `createApp`, `startServer`, `redactJson`, `csrfFailure`, `filterSessions`, `sortSessions`, `injectNonce`, plus module constants | `src/cli.js`; frontend `app.js` calls routes |
| BP-001.03 | `src/collectors/base.js` | Collector contract, bounded reads, normalized-record validation | `Collector`, `normalizeSession`, `safeReadLines` | every collector; `src/collectors/registry.js`; `src/analyzer/health.js` |
| BP-001.04 | `src/collectors/claude.js` | Parse Claude JSONL with message-id deduplication and model-window derivation | `ClaudeCollector` | registry; tests |
| BP-001.05 | `src/collectors/codex.js` | Parse Codex rollout JSONL and native context window | `CodexCollector` | registry; tests |
| BP-001.06 | `src/collectors/gemini.js` | Parse Gemini delta snapshots and bare messages | `GeminiCollector` | registry; tests |
| BP-001.07 | `src/collectors/kimi.js` | Parse Kimi wire protocol and native context fraction | `KimiCollector` | registry; tests |
| BP-001.08 | `src/collectors/opencode.js` | Read-only, windowed, allowlisted OpenCode SQLite queries | `OpenCodeCollector` | registry; tests |
| BP-001.09 | `src/collectors/copilot.js` | Detect Copilot installation without claiming transcript support | `CopilotCollector` | registry; tests |
| BP-001.10 | `src/collectors/registry.js` | Discover installed collectors, return support status, and relay each collector's sessions, `sessionMeta` (BP-002.19) and diagnostics | `collectors`, `detectAll`, `collectAll`, `detectMany`, `collectMany`, `discoverAll`, `collectorDefinitions` | `src/server.js`; tests |
| BP-001.11 | `src/analyzer/health.js` | Run rules against normalized sessions and produce evidence-qualified findings | `analyzeSession`, `analyzeAll` | `src/server.js`; `public/js/pages/health.js`, `sessions.js` |
| BP-001.12 | `src/analyzer/rules.js` | Declare six rules, threshold derivations, severity, fix mapping | `RULES`, `evaluateRule` | `health.js`; tests |
| BP-001.13 | `src/analyzer/trends.js` | Aggregate trend series and 24x15 activity heatmap | `buildTrends` | `src/server.js`; `public/js/pages/trends.js` |
| BP-001.14 | `src/fixes/base.js` | Fix contract, backup/undo storage, atomic writes, diff generation | `FixBase`, `WritableFix`, `AppendSectionFix`, `JsonMergeFix`, `HabitRecommendation`, `createFixEnvironment`, `undoTransaction`, `readJournal`, `listTransactions`, `unifiedDiff`, plus constants and error classes | every fix; `src/server.js`; tests |
| BP-001.15 | `src/fixes/claude/auto-compact.js` | Manage Claude auto-compact setting | `AutoCompactFix` | `rules.js`; `fix-modal.js`; tests |
| BP-001.16 | `src/fixes/claude/output-hygiene.js` | Append Claude output-hygiene instructions | `OutputHygieneFix` | `rules.js`; `fix-modal.js`; tests |
| BP-001.17 | `src/fixes/claude/batch-commands.js` | Append Claude batching instructions | `BatchCommandsFix` | `rules.js`; `fix-modal.js`; tests |
| BP-001.18 | `src/fixes/claude/worker-cap.js` | Append Claude worker-cap instructions | `WorkerCapFix` | `rules.js`; `fix-modal.js`; tests |
| BP-001.19 | `src/fixes/claude/compact-contract.js` | Append Claude compact-contract instructions | `CompactContractFix` | `rules.js`; `fix-modal.js`; tests |
| BP-001.20 | `src/report/generator.js` | Generate secret-redacted Markdown report | `generateReport`, `redactSecrets` | `src/server.js`; `public/js/pages/report.js`; tests |
| BP-001.21 | `public/index.html` | Shell, vendored assets, page-module script tags, page containers, CSRF token bootstrap, inline favicon. NOT the CSP: that is a response header from `src/server.js` only, because a meta copy is intersected with the header and could only tighten it silently | none | browser |
| BP-001.22 | `public/css/style.css` | Accessible responsive visual system | none | `index.html` |
| BP-001.23 | `public/js/app.js` | API client, router, page lifecycle, CSRF header | `api`, `navigate`, `registerPage` | `index.html`; page modules |
| BP-001.24 | `public/js/pages/health.js` | Render the latest session cards, the score headline and rule actions; owns the card markup outright since BP-001.29 was retired | `renderHealth`, `fixTitle` | `app.js` (via `registerPage`); imports `fix-modal.js` |
| BP-001.25 | `public/js/pages/trends.js` | Render three charts and 24x15 heatmap | `renderTrends` | `app.js`; `chart.js` |
| BP-001.26 | `public/js/pages/sessions.js` | Render sortable/filterable session table | `renderSessions` | `app.js` |
| BP-001.27 | `public/js/pages/report.js` | Generate, preview, and export Markdown | `renderReport` | `app.js` |
| BP-001.28 | `public/js/components/fix-modal.js` | Preview, confirm, apply, undo fix UI | `openFixModal` | `health.js`; `health-card.js` |
| BP-001.29 | ~~`public/js/components/health-card.js`~~ RETIRED to `_trash/wave5d_f021_retired_2026-09-20/` (INV-0, never `rm`) | Two implementations of one card existed (F-021); this one rendered a single button where the brief specifies `[Preview] [Apply] [Skip]`, so BP-001.24's won | — | none: it had no product caller, which is what exposed it |
| BP-001.30 | `public/js/components/chart.js` | Configure Chart.js with local assets and no network | `renderChart`, `destroyChart`, `buildChartConfig`, `toNullable`, `CACHE_ZONES` | `trends.js`. Its `renderHeatmap` export was retired alongside BP-001.29 — `trends.js` renders the heatmap itself |
| BP-001.31 | `README.md` | Installation, support matrix, security and fix behavior | none | npm consumer |
| BP-001.32 | `LICENSE` | MIT license text | none | npm consumer |
| BP-001.33 | `package.json` | Publish metadata, bin entry, runtime dependencies and scripts | metadata; `bin`; scripts | npm; `src/cli.js`; test runner |

| BP-ID | BP-001.14 correction (shipped, the CODE was right) |
|---|---|
| BP-001.34 | BP-001.14 originally listed three non-existent exports: `Fix`, `makeUndoPath`, `restoreUndo`. The shipped design uses `FixBase` and `WritableFix` base classes with concrete implementations (`AppendSectionFix`, etc.) and `undoTransaction()` for undo recovery, implementing FVA-007's before/after hash journal. The three original names were never implemented under those spellings, so this row was stale while the code was correct; every BP-004 fix contract is satisfied by the shipped design. |

## BP-002 Collector contract

```js
Collector = {
  id: string,
  displayName: string,
  detect(): {installed: boolean, paths: string[], status: "supported"|"detection-only"|"absent"},
  collect(options: {since?: Date, limit?: number}): Promise<NormalizedSession[]>
}

NormalizedSession = {
  cli: "claude"|"codex"|"gemini"|"kimi"|"opencode",
  support: "supported",
  sessionId: string,
  project: string|null,
  cwd: string|null,
  model: string|null,
  window: {tokens: number|null,
           source: "native"|"model-table"|"model-map"|"observed-promoted"|"observed-floor"|"unknown"},
  startedAt: string|null,
  endedAt: string|null,
  turns: NormalizedTurn[]
}

NormalizedTurn = {
  ts: string|null,
  context: {inputTokens: number|null, fraction: number|null, source: "native"|"derived"|"unknown"},
  cacheRead: number|null,
  cacheCreate: number|null,
  output: number|null,
  toolCalls: [{id: string|null, name: string|null, input: unknown}],
  toolResultBytes: number|null,
  isSidechain: boolean|null
}
```

| BP-ID | CLI | `window` fill | Honest unknown policy |
|---|---|---|---|
| BP-002.01 | Claude | Versioned model-id table, SUBORDINATE TO OBSERVATION: a matched entry is used only while the session's observed peak fits inside it, otherwise BP-002.17 promotes it; an unmatched model resolves per BP-002.11-BP-002.16 | Missing usage, result bytes, or sidechain marker stays `null`; no zero substitution |
| BP-002.02 | Codex | `token_count.info.model_context_window` | The native reading wins where present; without it the model id resolves per BP-002.11-BP-002.16. `last_token_usage` is per-turn, cumulative totals are never summed |
| BP-002.03 | Gemini | Model-id mapping (`source: "model-map"`), on the same terms as BP-002.01 — the mapping is evidence, not authority, and BP-002.17 outranks it; unmapped model resolves per BP-002.11-BP-002.16 | Delta snapshots and bare records both parsed; absent tool result bytes stay `null` |
| BP-002.04 | Kimi | `context_usage` is native fraction; absolute tokens may remain `null` | `context.fraction` is populated; `window.tokens` remains `null` unless independently known |
| BP-002.05 | OpenCode | `session.model`/`message.modelID` model-id map (`source: "model-map"`), subordinate to BP-002.17 as above; unmapped model resolves per BP-002.11-BP-002.16. MEASURED: on a real corpus every OpenCode model id is an unmapped free-tier id, so `observed-floor` is the normal case and BP-002.18 therefore suppresses its context verdict entirely | SQLite fields absent from selected rows remain `null`; never infer bytes from token counts |
| BP-002.06 | Copilot | no normalized session; detection-only response | UI says detected/unsupported; no fake session or zero metrics |
| BP-002.07 | Grok/Amp | no normalized session; existence probe only | UI says detection-only when candidate directory exists; no parser |

| BP-ID | `window.source` | Set when | `window.tokens` is | Threshold verdict from the context fraction |
|---|---|---|---|---|
| BP-002.11 | `native` | the CLI's own session record states the window | vendor-stated, exact | permitted |
| BP-002.12 | `model-table` | a versioned `MODEL_WINDOWS` entry matched the model id AND the session's observed peak fits inside it | the table value | permitted |
| BP-002.13 | `model-map` | as `model-table`, for a CLI whose model ids are mapped rather than tabled | the table value | permitted |
| BP-002.14 | `observed-promoted` | a table entry matched but the session's observed peak EXCEEDS it, so the entry is provably wrong for this session; the window is promoted to the smallest known tier `>= peak` | the promoted tier, or the observed peak when no known tier fits | permitted only where a known tier supplied the denominator (`promotion.ladder` is `vendor` or `global`); where `ladder` is `none` the denominator IS the observed floor and BP-002.18 applies |
| BP-002.15 | `observed-floor` | no table entry matched the model id; the session's observed peak is the only evidence there is | the observed peak: a LOWER BOUND, not a measured window | forbidden — BP-002.18 |
| BP-002.16 | `unknown` | no table entry and no observed peak | `null` | none is possible |

| BP-ID | Required collector behavior |
|---|---|
| BP-002.08 | Empty files, malformed JSON lines, missing fields, and files over 50 MB: skip bad records, bound memory, continue, and emit a collector diagnostic; never crash the server |
| BP-002.09 | Claude: usage is the last line per `message.id`; tool blocks are the union by tool id, with `(position, json)` key for id-less blocks |
| BP-002.10 | OpenCode: SQLite URI is `file:<path>?mode=ro`; table allowlist is exactly `session,message,part,project,workspace,session_message`; every query has explicit columns and time/session bounds |
| BP-002.17 | OBSERVATION OUTRANKS THE TABLE: `resolveWindow` compares the model-id reading against `peakContextTokens(turns)` — the MAX per-turn context, NEVER a sum of cumulative usage — and always returns `tokens >= observedFloor`, so no caller can derive a context fraction above `1.0`. Every promotion is recorded on the collector diagnostic as `windowPromotions`, so a stale `MODEL_WINDOWS` entry stays VISIBLE instead of being silently papered over |
| BP-002.18 | Where `window.source === "observed-floor"` the context fraction is `unknown` and NO threshold verdict may be derived from it: `observedFloor / observedFloor == 1.0` is an artifact of having no upper bound, not a measurement. `window.tokens` MAY still be DISPLAYED, labelled as a lower bound (`at least 41,344`). `observed-promoted` is exempt only while its denominator is a real known vendor tier |
| BP-002.19 | A collector MAY publish per-session facts `NormalizedSession` has no slot for — OpenCode's `session`-row totals and the `parent_id` sub-agent linkage — on `collector.sessionMeta`, keyed by session id. `registry.collectAll` relays it as `supported[].sessionMeta`, a plain object rather than a `Map` (a `Map` JSON-serializes to `{}`), joined to a session by `sessionId`. `NormalizedSession`'s own shape is unchanged |

## BP-003 Health rules

```js
Rule = {
  id: string,
  name: string,
  description: string,
  threshold: {value: number|string, derivation: string},
  severity: "info"|"warn"|"critical",
  fix: string|null,
  evidence: {status: "observed"|"not-observed"|"unknown", values: unknown[], sources: string[]}
}
```

| BP-ID | Rule ID / name | Threshold derivation | Severity | Fix | Evidence condition |
|---|---|---|---|---|---|
| BP-003.01 | `context-pressure` / Context pressure | `context > 0.70 * window.tokens`; for native fraction, `fraction > 0.70`; per-turn and session average are both retained | warn | `claude-auto-compact` | Unknown if window and fraction are unavailable |
| BP-003.02 | `cache-hit` / Low cache hit | `cacheRead / (cacheRead + cacheCreate)` when denominator > 0; flag `< 0.85` | warn | `claude-output-hygiene` | Unknown when cache counters absent or denominator is zero |
| BP-003.03 | `repeat-tool` / Repeated tool work | Same normalized tool name + canonical input + canonical result signature occurs `>= 5` times in a session | warn | `claude-batch-commands` | Unknown if result is unavailable; do not equate same input with same result |
| BP-003.04 | `large-tool-result` / Large tool results | `toolResultBytes > 10,240` for `>= 3` tool results in a session; frequency is an observed count, not an invented rate | warn | `claude-output-hygiene` | Unknown where byte count cannot be recovered |
| BP-003.05 | `long-rising-context` / Long rising context | elapsed duration `> 4h` AND robust linear slope of known context observations `> 0` AND at least 3 observations | critical | `claude-compact-contract` | Unknown with missing timestamps/context or fewer than 3 points |
| BP-003.06 | `subagent-concurrency` / High sub-agent concurrency | peak simultaneous sidechain/child intervals `> 0.50 * dispatched`; dispatched count is session-observed, not a global default | warn | `claude-worker-cap` | SHIPPED (corrects DIS-004, see BP-003.07): Claude, Kimi and OpenCode all produce verdicts; Codex and Gemini are structurally `unknown` |

| BP-ID | BP-003.06 as SHIPPED — DIS-004's premise was wrong twice (F-006, F-016) |
|---|---|
| BP-003.07 | Claude: the sidechain marker is never `true` in a main transcript (measured: true=0, false=138,358). ALL sub-agent activity is in sibling files, `<project-slug>/<session-id>/subagents/agent-*.jsonl` (measured: 87 dirs, 1,093 files). Reading them is what makes the rule fire at all |
| BP-003.08 | Kimi: `SubagentEvent`, keyed by `task_tool_call_id`, nests a complete sub-agent wire stream and is 36% of all its records. DIS-004 said Kimi's evidence established no sub-agent interval; it does |
| BP-003.09 | OpenCode: `sessionMeta.parentSessionId` links child to parent, which DIS-004 anticipated as conditional. It is `unknown`, not zero, when the child list is empty, because a bounded scan cannot distinguish "no sub-agent" from "the child was not collected" |
| BP-003.10 | Codex and Gemini remain `unknown`: no sidechain marker and no parent/child linkage. That is the rule working, not failing |
| BP-003.11 | A sub-agent session is EVIDENCE ABOUT ITS PARENT, never a peer of it. Sub-agent sessions are partitioned out of the session list and the headline count, counted in `subagentSessionsSetAside`, and still passed as `ctx.children` so the rule keeps its evidence (F-023). The partition happens AFTER `childrenByParent` is built over the full set, so it can never cost the rule a verdict |
| BP-003.12 | Rule 6's coverage depends on SCAN WIDTH: a parent whose sub-agent transcripts fall outside the scanned window reads `unknown`, not a concurrency figure invented from partial evidence (F-026). A wider `?scan=` yields more verdicts |

## BP-004 Fix contracts and exact append/write text

```js
Fix = {
  id: string,
  preview(): {description: string, diff: string, files_affected: string[], reversible: true},
  apply(): {description: string, diff: string, files_affected: string[], undoPath: string},
  undo(): {restored: true, byteIdentical: true},
  check(): {applied: boolean, marker: string}
}
```

| BP-ID | Fix | Exact file | Exact appended text | Idempotency marker |
|---|---|---|---|---|
| BP-004.01 | `claude-auto-compact` | `~/.claude/settings.json` | No append is permitted. Exact merged fragment: `"autoCompact": true`; preserve every existing key and write the merged JSON with original newline style | JSON key `autoCompact === true` |
| BP-004.02 | `claude-output-hygiene` | `~/.claude/CLAUDE.md` | `\n<!-- session-rx:output-hygiene:v1 -->\n## SessionRx: output hygiene\nKeep tool output concise; request bounded, relevant output and summarize large results before continuing.\n<!-- /session-rx:output-hygiene:v1 -->\n` | `<!-- session-rx:output-hygiene:v1 -->` |
| BP-004.03 | `claude-batch-commands` | `~/.claude/CLAUDE.md` | `\n<!-- session-rx:batch-commands:v1 -->\n## SessionRx: batch commands\nBatch independent read-only commands when safe; avoid repeating identical tool calls and reuse verified results.\n<!-- /session-rx:batch-commands:v1 -->\n` | `<!-- session-rx:batch-commands:v1 -->` |
| BP-004.04 | `claude-worker-cap` | `~/.claude/CLAUDE.md` | `\n<!-- session-rx:worker-cap:v1 -->\n## SessionRx: worker cap\nKeep concurrent sub-agents at or below half of the dispatched worker count unless a deliberate exception is documented.\n<!-- /session-rx:worker-cap:v1 -->\n` | `<!-- session-rx:worker-cap:v1 -->` |
| BP-004.05 | `claude-compact-contract` | `~/.claude/CLAUDE.md` | `\n<!-- session-rx:compact-contract:v1 -->\n## SessionRx: compact contract\nWhen context pressure rises, compact deliberately: preserve active requirements, decisions, unresolved risks, and exact file paths before continuing.\n<!-- /session-rx:compact-contract:v1 -->\n` | `<!-- session-rx:compact-contract:v1 -->` |

| BP-ID | Apply/undo invariant |
|---|---|
| BP-004.06 | `preview().diff` is generated from the exact bytes that `apply()` will write; `files_affected` is explicit; `reversible` is always `true` |
| BP-004.07 | Before apply, copy each target byte-for-byte to `~/.session-rx/undo/<timestamp>/`; write temp file, fsync, rename; retain mode where possible |
| BP-004.08 | `CLAUDE.md` is never reformatted; append one delimited section only; existing bytes before append are preserved |
| BP-004.09 | `settings.json` is parsed, shallow-merged only for the named key, serialized with stable two-space indentation and preserved existing keys; backup precedes write |
| BP-004.10 | `undo()` restores byte-identical bytes and refuses a missing or mismatched undo record |

## BP-005 API surface

| BP-ID | Method | Route | Request | Response |
|---|---|---|---|---|
| BP-005.01 | `GET` | `/api/health` | `since?`, `limit?` query | `{sessions:[NormalizedSessionHealth], collectors:[status], diagnostics:[]}` |
| BP-005.02 | `GET` | `/api/sessions` | `cli?`, `project?`, `from?`, `to?`, `sort?`, `order?`, `limit?` | `{sessions:[NormalizedSessionHealth], total:number, diagnostics:[]}` |
| BP-005.03 | `GET` | `/api/sessions/:sessionId` | URL id | `{session:NormalizedSessionHealth}` or `404 {error}` |
| BP-005.04 | `GET` | `/api/trends` | `from?`, `to?`, `cli?`, `scan?` | `{window, days:[], clis:[], thresholds, charts:{context:[],spend:[],cache:[]}, heatmap:{rows:15,cols:24,orientation:"day-major",days:[],hours:[],grid:[],nonZeroCells,maxCell,placedTurns,daysWithoutData}, trend, excluded, unknowns:[], scan, diagnostics:[]}` |
| BP-005.05 | `GET` | `/api/report` | `from?`, `to?`, `cli?` | `{markdown:string, generatedAt:string, redactions:number}` |
| BP-005.06 | `POST` | `/api/fixes/:fixId/preview` | `{sessionId?, ruleId?}`, `X-CSRF-Token` | `{description,diff,files_affected,reversible,check}` |
| BP-005.07 | `POST` | `/api/fixes/:fixId/apply` | `{sessionId?, ruleId?}`, `X-CSRF-Token` | `{applied:true,undoPath,files_affected,diff}` |
| BP-005.08 | `POST` | `/api/fixes/:fixId/undo` | `{undoPath}`, `X-CSRF-Token` | `{restored:true,byteIdentical:true}` |
| BP-005.09 | `GET` | `/api/fixes/:fixId/check` | none | `{applied:boolean,marker:string}` |
| BP-005.10 | `GET` | `/api/collectors` | none | `{collectors:[{id,installed,status,paths}]}` |
| BP-005.20 | `GET` | `/api/fixes` | none | `{fixes:[{id,title,kind,blueprint,available,reason}]}` — curl-able capability matrix; same honesty purpose as FVA-003; UI currently inlines fix titles via BP-005.19 |
| BP-005.11 | `GET` | `/` and static assets | none | local HTML/JS/CSS/vendor assets only |

| BP-ID | BP-005.04 correction (D-039) — the CODE was right, this row was wrong |
|---|---|
| BP-005.16 | `charts.tools` never existed. `buildTrends` measures cache SPEND, not tool counts, and returns `{context, spend, cache}`. Emitting `tools: []` to satisfy the old row would have rendered in the UI as "no tool problems" — a fabricated all-clear from a series nothing computes |
| BP-005.17 | `heatmap` is a LABELLED OBJECT, not a bare 24x15 array: `rows:15, cols:24, orientation:"day-major"`, with its own `days`/`hours` axes and a `grid`. An orientation a caller has to guess is an off-by-one transpose waiting to happen, so it is stated in the payload |
| BP-005.18 | `/api/health` also publishes `subagentSessionsSetAside {total, orphans, byCli}` (F-023/F-025) and `promotions`. `sessions` is the user's OWN sessions only, so without the set-aside count the gap between what was read and what is listed is unexplained |
| BP-005.19 | Every `rules[]` entry carries `fixTitle` beside `fix`: the id's human name, taken from `FIX_CATALOG`, or `null` where the catalogue has no entry. The client prints the id rather than guessing a name. Before this the page kept its own copy of the five titles, held to this file by a drift test — two catalogues and a test standing between them (F-021) |

| BP-ID | API security contract |
|---|---|
| BP-005.12 | Bind only to `127.0.0.1`; reject non-loopback socket requests; enforce exact `Host` allowlist for chosen port |
| BP-005.13 | On startup generate a random nonce, inject it into HTML, and require `X-CSRF-Token` plus matching same-origin `Origin` on every mutating route; reject missing, mismatched, or non-browser origins with `403` |
| BP-005.14 | Do not rely on cookies, CORS, or browser private-network checks as CSRF protection; reject `Origin: null` for mutating routes |
| BP-005.15 | JSON responses, diagnostics, report text, and frontend state pass secret redaction; never return OpenCode account/control-account/credential data |

## BP-006 Phase and wave breakdown

| Phase | Wave | OWNER | OWNED PATHS | EXIT GATE |
|---|---|---|---|---|
| 1 Contract | 1A | Lead | `package.json`, `README.md`, `LICENSE` | `npm pkg get name bin` returns `session-rx` and a valid bin |
| 1 Contract | 1B | Collector owner | `src/collectors/base.js`, `src/collectors/registry.js` | `node --check src/collectors/base.js && node --check src/collectors/registry.js` |
| 1 Contract | 1C | UI owner | `public/index.html`, `public/css/style.css`, `public/js/app.js` | `node --check public/js/app.js` |
| 2 Collectors | 2A | Claude/Codex owner | `src/collectors/claude.js`, `src/collectors/codex.js` | `node --test tests/collectors/claude.test.js tests/collectors/codex.test.js` |
| 2 Collectors | 2B | Gemini/Kimi owner | `src/collectors/gemini.js`, `src/collectors/kimi.js` | `node --test tests/collectors/gemini.test.js tests/collectors/kimi.test.js` |
| 2 Collectors | 2C | OpenCode/safety owner | `src/collectors/opencode.js`, `src/collectors/copilot.js` | `node --test tests/collectors/opencode.test.js tests/collectors/copilot.test.js` |
| 3 Analysis | 3A | Analysis owner | `src/analyzer/rules.js`, `src/analyzer/health.js` | `node --test tests/analyzer.test.js` |
| 3 Analysis | 3B | Trends owner | `src/analyzer/trends.js` | `node --test tests/trends.test.js` |
| 3 Analysis | 3C | Report owner | `src/report/generator.js` | `node --test tests/report.test.js` |
| 4 Fixes | 4A | Fix foundation owner | `src/fixes/base.js` | `node --test tests/fixes-base.test.js` |
| 4 Fixes | 4B | Claude fix owner A | `src/fixes/claude/auto-compact.js`, `src/fixes/claude/output-hygiene.js` | `node --test tests/fixes-compact.test.js tests/fixes-output.test.js` |
| 4 Fixes | 4C | Claude fix owner B | `src/fixes/claude/batch-commands.js`, `src/fixes/claude/worker-cap.js`, `src/fixes/claude/compact-contract.js` | `node --test tests/fixes-guidance.test.js` |
| 5 Product | 5A | Backend owner | `src/server.js`, `src/cli.js` | `node --test tests/server.test.js && npm pack --dry-run` |
| 5 Product | 5B | Page owner | `public/js/pages/health.js`, `public/js/pages/trends.js`, `public/js/pages/sessions.js`, `public/js/pages/report.js` | `node --check public/js/pages/health.js && node --check public/js/pages/trends.js && node --check public/js/pages/sessions.js && node --check public/js/pages/report.js` |
| 5 Product | 5C | Component/security owner | `public/js/components/fix-modal.js`, `public/js/components/health-card.js`, `public/js/components/chart.js` | `node --test tests/frontend-contract.test.js` |
| 5 Product | 5D | Integration owner | `tests/` | `npm test && npm pack --dry-run && rg -n "https?://" public src package.json` |

| BP-ID | Wave rule |
|---|---|
| BP-006.01 | Owned paths are disjoint within each phase; a wave may import another wave's completed contract but may not edit its files |
| BP-006.02 | Every wave must run its own exit gate before handoff; final integration may not hide a failed wave gate |

## BP-007 Test plan

| Test file | Assertions | Gate |
|---|---|---|
| `tests/collectors/base.test.js` | malformed/empty/missing/over-50MB inputs; bounded read; normalized shape | `GATE-COLLECT` |
| `tests/collectors/claude.test.js` | message-id cumulative dedupe; tool union; sidechain; model window; cache/context | `GATE-COLLECT` |
| `tests/collectors/codex.test.js` | native window; per-turn token usage; function calls/results | `GATE-COLLECT` |
| `tests/collectors/gemini.test.js` | `$set` snapshot and bare records; model mapping; missing tool results | `GATE-COLLECT` |
| `tests/collectors/kimi.test.js` | wire event mapping; native fraction; tool result bytes; unknowns | `GATE-COLLECT` |
| `tests/collectors/opencode.test.js` | read-only URI; bounded columns/time windows; normalized rows; 10GB-safe query shape | `GATE-SEC`, `GATE-PERF` |
| `tests/collectors/copilot.test.js` | detection-only result; no parser; no fake sessions | `GATE-COLLECT` |
| `tests/collectors/security.test.js` | query authorizer rejects `account`, `control_account`, `credential`; response/report secret scan | `GATE-SEC` |
| `tests/analyzer.test.js` | six rules, derivations, severities, fix IDs, unknown propagation; no zero substitution | `GATE-COLLECT` |
| `tests/trends.test.js` | three chart series, 24x15 heatmap, null/unknown handling | `GATE-COLLECT` |
| `tests/fixes-base.test.js` | preview/apply diff equality, backup, atomic write, byte-identical undo, refusal on mismatch | `GATE-FIX` |
| `tests/fixes-compact.test.js` | auto-compact settings merge and compact-contract append/check/idempotency | `GATE-FIX` |
| `tests/fixes-output.test.js` | output-hygiene exact append, preview/apply equality, undo | `GATE-FIX` |
| `tests/fixes-guidance.test.js` | batch, worker-cap, compact-contract exact text, no duplicate markers | `GATE-FIX` |
| `tests/report.test.js` | Markdown generation, unknown labels, secret redaction, no credential fields | `GATE-SEC` |
| `tests/server.test.js` | loopback bind, route schemas, CSRF/origin/host rejection, POST-only mutation | `GATE-SEC` |
| `tests/frontend-contract.test.js` | four pages, local Chart.js only, CSRF header, no CDN/network URL | `GATE-OFFLINE` |
| `tests/cli.test.js` | free port, browser launch, startup under three seconds in fixture mode | `GATE-PERF` |
| `tests/package.test.js` | packed artifact contains declared files and excludes fixtures/secrets | `GATE-FACTORY` |
| `tests/integration.test.js` | WIRING: index.html loads every page module that exists; imports resolve on disk; no dangling imports to retired modules; no remote URLs outside vendor/. BOOT: modules load in order, DOMContentLoaded fires, routes register and render into their mounts (F-022) | `GATE-OFFLINE` |
| `tests/registry.test.js` | Collector detection splits into supported/detection-only/absent; collection isolation and error containment; diagnostic aggregation from collect() and published properties; sessionMeta relay as plain objects; edge cases (non-array returns, empty/absent/copied meta) | `GATE-COLLECT` |
| `tests/ui-health.test.js` | summary strip counts (analyzed/found/available/unmeasured); plain-English leads per check; three verdicts preserved; NOT-a-pass on unknowns; metrics/evidence in collapsed sections | `GATE-COLLECT` |
| `tests/ui-trends.test.js` | plain-English verdict verbatim from analyzer; statistical evidence in collapsed section; mixed/undecidable never presented as confirmed improvement | `GATE-COLLECT` |
| `tests/ui-fixmodal.test.js` | proposed change exact; expected effect and limitations; limitations state guidance-not-constraint; Apply/Undo round-trip; second Apply refused | `GATE-FIX` |

## BP-008 Disagreements

| ID | Disagreement | Ruling |
|---|---|---|
| DIS-001 | “Chart.js VENDORED (offline)” versus any CDN implication | Vendored wins. No CDN, no runtime fetch, no remote font/script/style. `public/vendor/chart.umd.min.js` is a required package asset even though it was omitted from the fixed-file list; adding the vendored asset is necessary to satisfy the explicit offline requirement, not scope creep. |
| DIS-002 | Localhost CSRF described as a real risk | Correct. Loopback is not a CSRF boundary. Every POST requires startup nonce header, exact same-origin `Origin`, exact `Host`, and loopback binding. GET `check` is non-mutating. |
| DIS-003 | “Repeated tool input with same result” across five supported CLIs | Not uniformly computable. Claude, Codex, and Kimi expose enough call/result structure; OpenCode exposes parts and is computable only for supported part shapes; Gemini evidence proves tool calls but not a stable result contract. Gemini must report `unknown` for same-result detection unless a fixture proves a result mapping. No same-input-only false positive. |
| DIS-004 | “Sub-agents” across five logs | PREMISE CORRECTED BY MEASUREMENT (BP-003.07..12) — the ruling's shape survives, two of its facts did not. Claude's `isSidechain` is NOT the mechanism (it is never true in a main transcript); the sub-agent transcripts are separate files. Kimi's evidence DOES establish intervals, via `SubagentEvent`. Shipped: observed for Claude, Kimi and OpenCode; `unknown` for Codex and Gemini; never zero. |
| DIS-005 | Normalized `window` for Kimi | Kimi supplies a fraction, not necessarily an absolute window. Preserve `context.fraction`; leave `window.tokens` null. Converting fraction to invented tokens is forbidden. |
| DIS-006 | Normalized `toolResultBytes` for Gemini | Do not default to zero. Use `null` when byte length is not recoverable from the actual record; large-result rule becomes unknown for that observation. |
| DIS-007 | Copilot in the collector list | Detection-only is the only honest behavior from the verified evidence. It is not a normalized session source and must not appear as healthy/empty data. |
| DIS-008 | Exact five Claude fixes versus settings schema variability | `autoCompact` is applied only as a named merged key after preview; if the installed settings schema rejects it, apply fails closed with diagnostic and no partial write. The four instruction fixes append only to `CLAUDE.md`. |

## BP-009 FACTORY VALUE-ADD

| ID | In-scope addition | Developer value | Acceptance evidence |
|---|---|---|---|
| FVA-001 | Port the Claude logical-turn dedupe rule verbatim: last cumulative usage; union non-cumulative tool blocks | Prevents silently wrong health metrics and dropped/repeated tool calls | Fixture with repeated `message.id`; expected counts are exact |
| FVA-002 | Evidence ledger per finding: source file/table, record ids, derivation, unknown reasons, parser version | Makes every card auditable without exposing secrets | API and report include redacted evidence references |
| FVA-003 | Source capability matrix shown in UI: supported, detection-only, unsupported field, last scan diagnostic | Stops users treating missing telemetry as healthy behavior | `/api/collectors` and health page display capability state |
| FVA-004 | Secret redaction gate before API serialization, report generation, and DOM insertion | Prevents OpenCode credentials and accidental token-like values leaking | Negative fixtures containing `access_token`, `refresh_token`, and authorization headers remain absent |
| FVA-005 | Deterministic fixture corpus for empty, corrupt, large, cumulative, duplicate, and unknown-field cases | Makes parser regressions reproducible across contributors | `npm test` runs fixtures without user home access |
| FVA-006 | Rule result status triad `observed` / `not-observed` / `unknown` with visible reason | Prevents “no evidence” becoming “all clear” | Every rule result serializes status and evidence |
| FVA-007 | Fix transaction journal with target hash before and after apply/undo | Makes local changes recoverable and detects external edits | Apply/undo tests verify hashes and mismatch refusal |
| FVA-008 | Packaged smoke test in a clean temporary home with network disabled | Proves `npx session-rx` is actually offline and publishable | `npm pack` followed by isolated startup and zero network requests |

## BP-010 Hard quality gates

| Gate | Pass condition |
|---|---|
| `GATE-SEC` | OpenCode allowlist test passes; no secrets in API/UI/report; loopback + CSRF/origin/host tests pass |
| `GATE-OFFLINE` | No CDN or runtime network dependency; vendored Chart.js loads from package; offline smoke test passes |
| `GATE-PERF` | Cold start `<3s`; OpenCode queries are read-only, bounded, indexed/windowed; parsers are bounded on >50MB files |
| `GATE-FIX` | Preview diff equals apply write; backups precede writes; check prevents duplicate apply; undo is byte-identical |
| `GATE-COLLECT` | All parser fixtures pass; unsupported fields are null/unknown rather than zero; no invented Copilot/Grok/Amp parser |
| `GATE-FACTORY` | Every export has a caller; every requested file is inventoried; `git diff --check`; clean packed artifact contains no secrets |

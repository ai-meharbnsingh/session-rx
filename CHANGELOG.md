# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-25

### Added

- **Sub-agent token-spend rollup.** SessionRx's collectors already parsed a session's dispatched sub-agent transcripts, but nothing summed their token cost. A user had to open every sub-agent session by hand to see what an orchestration run actually cost. `analyzeSession()` in `src/analyzer/health.js` now computes each session's own `tokenSpend` (cacheRead/cacheCreate/output summed from its turns), and `analyzeAll()` attaches a recursive `subagentTokenSpend` rollup to every session, summing every descendant sub-agent's spend (any nesting depth) without folding it into the session's own totals. The session detail page (`public/js/pages/sessions.js`) shows this as a new "sub-agent token spend" row. Honesty preserved throughout: a session that dispatched no sub-agents gets a real 0; a session that dispatched sub-agents whose usage was never recorded gets `null` token fields (visibly different from "dispatched nothing"), never a fabricated 0.

- **G2 trend chart transparency.** The G2 "Token spend" trend chart (`src/analyzer/trends.js`) was already summing sub-agent turns into its daily cacheRead/cacheCreation/total figures (sub-agent sessions are collected as flat siblings, and were never excluded from that sum) — this was correct behavior (sub-agent tokens are real spend) but was undocumented and untested. The daily totals are unchanged; the fix adds an explicit `subagentCacheRead`/`subagentCacheCreation`/`subagentTotal` breakdown per day so a day of heavy delegation is legible rather than an unexplained spike, plus a new legend line on the chart, plus test coverage for the mixed/own-only/sub-agent-only cases.

### Tests

- Full suite: 769 passing tests (3 new trend tests added), exit code 0, no regressions.

## [0.4.1] - 2026-09-25

### Added

- **A third suggestion status, `possibly-already-satisfied`, closing a false-negative in `checkMarkerStatus`/`checkSettingsStatus` (`src/suggestions/targets.js`).** Previously, if a user's instructions file already addressed a finding in different wording than SessionRx's own exact marker, the suggestion was reported as plain "not-added" — indistinguishable from a user who had done nothing. The exact-marker/exact-settings-key check is unchanged and is still the only path that produces a clean "already-added" (idempotence guarantee preserved). Now, only when that exact check fails, an optional secondary heuristic runs per suggestion (`src/suggestions/secondary-detectors.js`): a keyword/rule-ID-table detector for the batch-commands and output-hygiene suggestions, a numeric-cap-near-keyword detector for the sub-agent worker-cap suggestion, a preserve-near-compact detector for the compaction-contract suggestion, and a launch-command-flag detector (checks shell rc files for a `--autocompact`-style CLI flag/alias) for the auto-compact suggestion. A match reports `possibly-already-satisfied` with the matched line number and snippet as evidence, never a silent reclassification to "already-added" — the UI (`public/js/components/suggestion-panel.js`) shows this as a distinct "Possibly already satisfied" callout with the evidence, and `[Show me]` (expand the evidence), `[Apply anyway]` (copies the request text regardless), and `[Dismiss]` actions.

- **`tests/ui-suggestion-panel.test.js`: the first automated test coverage for `suggestion-panel.js`'s rendering logic.** Covers every suggestion status (`already-added`, `not-added` with and without a reason, `possibly-already-satisfied`'s evidence display and its three actions, all three `unknown` reasons, and the unavailable-tool message) using a hand-built DOM shim, no browser.

### Fixed

- **The `claude-auto-compact` suggestion's "not-added" reason now adds one clarifying sentence when a readable global instructions file exists alongside settings.json:** "Not found in settings.json or shell rc files. If you set --autocompact via a CLI flag or alias, this check can't see it — only settings.json and shell rc files are read." The other four suggestions' reason text is unaffected.

### Tests

- Full suite: 784 passing tests, exit code 0, no regressions.

## [0.3.3] - 2026-09-24

### Fixed

- **The cache-hit rule fired on a sample too small to support a verdict.** The analyzer had guards for every missing counter but none for a counter that was present but tiny. A 1-turn session with 0 cache reads computed a 0.00 rate and fired `observed`, while the report printed "rate is not meaningful at fewer than 5 cache-read-carrying turns" beside it. The analyzer now returns `unknown` (reason code `cache-sample-too-small`) when a session carried fewer than 5 cache-read-carrying turns. Threshold lives in `src/constants.js` as `CACHE_SAMPLE_MIN_TURNS`, read by both the analyzer and the report generator so the two cannot drift.
- **The measured effect on a 1,888-session scan:** cache-hit `observed` fell from 642 to 2. Of the 640 removed, 589 had exactly 1 turn. cache-hit `unknown` rose from 5 to 936 (931 `cache-sample-too-small`, 5 `no-cache-traffic`). Importantly, the guard removed false passes as well as false problems: 291 sessions that previously read as `not-observed` were also below the sample threshold and are now honestly `unknown`. A short session with a flattering rate was a false all-clear before.

### Changed

- **The README verdict table now carries new figures from the same scan:** not-observed 2,207 (83.6%), observed 233 (8.8%), unknown 201 (7.6%), with the same 245 not-applicable pairs and 2,641 total attempted verdicts. The note about unknown rose from 0.4% to 7.6% deliberately, because the smaller number was partly built on sessions the tool could not actually assess.

## [0.3.2] - 2026-09-24

### Documentation

- **The Health page example in the README.** It quoted an evidence string the tool does not produce: "largest single tool result: 184,220 characters", where the real check reports "turns whose tool results totalled more than 10,240 bytes: 7". The block is now a verbatim transcript of one real Codex session, evidence strings included, rather than a composite written by hand.

## [0.3.1] - 2026-09-24

### Removed

- **The Antigravity collector source file (`src/collectors/antigravity.js`) and its test file.** Antigravity was already dropped from the collector registry in 0.3.0; only the now-unreachable source remained. Both were archived, not deleted. The test count went 766 to 759, which is exactly the 7 tests in that archived file, so no other coverage was lost.
- **Dead CSS in `public/css/style.css`: `.cli-icon` background rules for `data-cli="gemini"`, `"kimi"` and `"opencode"`.** Those three CLIs are no longer read, so no code path could ever emit those values.

### Added

- **A `.cli-icon` background colour for `data-cli="cursor"`**, which had no rule of its own and so rendered with no colour.

### Documentation

- **README rewritten to describe 0.3.x.** It still described the removed Preview/Apply workflow, four summary cards, five CLIs, and quoted a 51% unknown rate from a measurement taken before the unsupported CLIs were dropped.
- **The verdict counts table now carries a measurement taken on 2026-09-24 against this build:** 481 sessions across three CLIs, 2,641 attempted verdicts — not-observed 2,256 (85.4%), observed 375 (14.2%), unknown 10 (0.4%) — plus 245 not-applicable rule-session pairs that sit outside the denominator.
- **The Health page ASCII example was internally contradictory:** it marked "Long session that kept growing" as a problem on a four-minute session while printing 0.07 hours elapsed, though that rule requires more than four hours. Corrected, along with an invented rule name.
- **Screenshots regenerated against the current UI;** the "Screenshots show an earlier version" disclaimer is gone.

## [0.3.0] - 2026-09-24

### Breaking

- **Apply and Undo are removed.** SessionRx no longer writes user files. The Preview/Apply/Undo workflow is gone. Each observed problem now gets a suggestion: a preview of the exact text to add and a ready-made request to paste into the user's own AI tool. Suggestions target the tool whose session showed the problem.

### Removed

- **Gemini CLI, Kimi, OpenCode, GitHub Copilot CLI, Grok, Amp and Antigravity CLI are no longer read.** SessionRx now reads only Claude Code, Codex, and Cursor CLI. Antigravity CLI (the Gemini CLI successor) has been removed from the collector registry.

### Changed

- **The dashboard now explains unmeasured checks once per page.** A single note at the foot replaces the same explanation repeated on every check of every session. The Report keeps its explicit "not a pass" summary card.
- **Clean session counts are easier to read.** The count clause appears only when it is non-zero, so a clean session reads "5/5 checks passed". A non-zero unmeasured count is always shown.
- **Suggestion language now matches what SessionRx does.** "Review fixes" and "Fixable findings" are now "Review suggestions" and "Findings with a suggestion", because this release only ever suggests.

### Fixed

- **Checks a CLI's log format cannot support are now excluded and explained.** They are no longer reported as "could not be measured" on every session of that CLI; the limitation is disclosed as not applicable to that CLI's log format.
- **Trends no longer count sessions outside the selected date window as unmeasurable.** Only sessions inside the reader's selected window contribute to its measured and unmeasured trend counts.
- **Sub-agent concurrency can now be answered by a bounded scan.** Claude records each parent's sub-agents under the parent, so a complete corpus scan is no longer required.
- **Sessions with no transcript turns are no longer reported as five failed checks.**
- **The Health page no longer crashes on load in a real browser.** It was calling `.find` on a NodeList.
- **Context-window findings no longer rely on an unsupported assumption.** Anthropic ships both a 200,000 and a 1,000,000 window for the same model ids, while the log records neither. A breach measured against the smaller window is now reported as unmeasurable rather than as a finding.
- **Cursor's actual availability is now explained.** It is no longer labelled "support coming soon" when Cursor is supported but no cursor-agent store is present.

## [0.2.2] - 2026-09-23

### Fixed

- **Cursor sessions were picked in directory order before the 200-session cap.** An arbitrary 200 were kept rather than the 200 newest. They are now sorted by mtime descending, ties by path. Scan-coverage reporting is unchanged.
- **The Sessions tab built its CLI filter from the sessions already loaded.** On a machine whose newest sessions were all one CLI, only that CLI was offered, and the others were unreachable — reaching them required filtering to them. `/api/sessions` now returns a scan-wide `cliCounts` facet, and selecting a CLI refetches server-side from offset 0. On a real 1,236-session corpus the filter offered 1 CLI before and 5 after.
- **With no Claude Code installed, the Fixes page proposed a Claude Code config change as the fix for a Cursor session.** With a live preview and five more behind it, fixes are now recommended only for a CLI detected on the machine. Fixes already applied stay listed and undoable whatever is installed.
- **The detection-only note claimed Cursor "exposes no session transcript to read" — false.** SessionRx reads the Cursor CLI. A collector can now supply its own reason, and Cursor's separates the Cursor CLI from the Cursor desktop editor, whose own stored conversations are not read.
- **A Cursor store that could not be stat'd was dropped silently.** It is now kept and still scanned.
- **The vendored Chart.js failed its own integrity check on Windows because git converted the bundle's line endings on checkout.** A root `.gitattributes` now protects the vendored assets. The expected hash was NOT changed.
- **The suite now runs on Windows.** Path expectations hardcoding POSIX separators, and an npm call assuming `npm` not `npm.cmd`, were failing the suite on Windows for reasons unrelated to the product.

### Added

- **`--limit <n>` and `SESSION_RX_LIMIT` set sessions read per CLI.** Default stays 250, which is deliberate and measured. Until now the scan note told the user to pass a larger limit while no way to pass one existed. On a 12,115-session machine, `--limit 3000` moves the scan from 1,236 to 7,820 sessions.

## [0.2.1] - 2026-09-23

### Fixed

- **OpenCode and Cursor could not be read on Windows.** Both build a read-only SQLite URI as `file:<path>?mode=ro`. On Windows `os.homedir()` is `C:\Users\<name>`, producing `file:C:\Users\...?mode=ro`. Per sqlite.org/uri.html a Windows drive-letter path needs backslashes converted to forward slashes, a single `/` before the drive letter, and the blank authority — `file:///C:/Users/...` — and SQLite states that "a filename that is not a well-formed URI is interpreted as an ordinary filename". So the open failed AND the `mode=ro` guarantee silently stopped applying; only the separate `{readOnly: true}` option still held. Both collectors now share one `readOnlyFileUri` helper that emits the three-slash form on every platform. The `{readOnly: true}` option is kept as a second lock. The other five collectors read JSONL through `path.join` and were never affected.

### Added

- **Relocation environment variables are honoured.** `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME` (OpenCode, on every OS including Windows), and `KIMI_CODE_HOME` / `KIMI_SHARE_DIR`. Cursor already honoured its three. A user who had relocated a CLI's data previously got that CLI reported as **absent** — telling someone who has the tool that they do not, which is the one thing this project exists not to do. An explicitly passed path still wins over the variable, and a variable that is empty after trimming counts as unset.
- **Kimi's current CLI is read.** Kimi Code CLI moved its data root to `~/.kimi-code/` and migrates the old `~/.kimi/` across without deleting it. Both trees are now scanned and de-duplicated by session id, preferring the `.kimi-code` copy, so a migrated user does not see every session twice.
- **OpenCode's non-stable install channels are read.** Those write `opencode-<channel>.db` beside `opencode.db`. When `opencode.db` is absent the most recently modified channel database is used; when both exist `opencode.db` wins and the two are never merged.

## [0.2.0] - 2026-09-23

### Added

- **Cursor CLI sessions are now read.** Built against Cursor's own shipped source (the CLI installs as readable JavaScript bundles), not against a guessed format. Reads `~/.cursor/chats/<md5-of-cwd>/<chat-id>/store.db` and `~/.cursor/acp-sessions/<id>/store.db`, both SQLite opened read-only through a `file:…?mode=ro` URI, with a two-table allowlist (`meta`, `blobs`), explicit column names, and a LIMIT on every statement. The chat metadata is ONE row, keyed `"0"`, whose value is hex-encoded UTF-8 JSON — not JSON, which is the trap a naive parser falls into. The conversation root is a protobuf blob; a small hand-written reader decodes exactly three fields — turn list, per-turn timings, and token details — with no new dependency and no protobuf runtime vendored in. Tool call names come from Cursor's transcript at `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`. What a Cursor session shows: project, model last used, turn count, per-turn timestamps (so duration is real), tool names, and Cursor's OWN reported context window rather than one inferred from a model-id table. What it cannot show, and why: Cursor does not persist per-turn token counts anywhere on disk — they exist only in memory while it runs — so all six health checks report `unknown`, with a specific machine-readable reason each. Zero is never shown in place of a number Cursor did not record. It also discards tool results from its transcript, so result size cannot be measured. Security: the same metadata row holds a blob encryption key. It is deleted before anything else reads the row, and a test asserts it appears nowhere in collector output. A machine with no Cursor reports `absent`; Cursor present but with no readable chat store reports `detection-only`; neither is ever reported as a pass.

### Fixed

- **Sessions: the Key findings pill painted over the Trend column.** The unknown and clear pills were appended straight to the table cell while only the observed pills were wrapped in the container that clips them, and a later `white-space: nowrap` rule had silently disabled the earlier wrapping rule. Measured at 1440px: the pill ran to 862px against a cell ending at 811px — 51px over, drawn on top of the Trend text. All three pill paths now share the same container; a single over-long pill ellipses on one line and carries its full text on hover. Rows stay 77px.
- **Sessions: the CLI chip overflowed its column by 5 pixels.** The column was 62px and the chip needs 68px with its uppercase letter-spacing, padding and border. Column 2 is now 68px and the Health column gives back the same 6px, so the ten widths still sum to 1120px and the table still fits with no horizontal overflow.

## [0.1.3] - 2026-09-23

### Fixed

- **Sessions: the Trend column never drew anything; every row read "not measured".** Per-turn context readings were collected by the collectors but the analyzer's session serializer dropped them, sending only a turn count, so the page always saw an empty list. The list endpoint now sends a compact per-turn context series with each row (numbers only, bounded by the page size, not the scan). Sparklines now draw. A session whose turns genuinely record no context size still reads "not measured" — that verdict was always correct and was kept. A row whose turns never reached the page is reported differently from a row whose turns were read and held nothing.
- **Sessions: the Project column wrapped long paths, making some rows three times taller than others.** Path text wrapping at the cell level stretched those rows to 216px against a 77px baseline. It is now a single ellipsed line; the full path is still on hover.
- **Sessions: the table overflowed by 15 pixels at 1440px-wide windows, clipping the Health column.** Column widths summed to 1144px inside a 1129px card at a 1440px-wide window. The budget had been measured only at 1920px with no floor for narrower windows. Widths now sum to 1120px and the table fits with no horizontal overflow at both 1440px and 1920px.
- **Sessions: findings wrapped onto separate lines, making rows with multiple findings three times taller than others.** Finding pills wrapping at the cell level stretched those rows to 109px against a 77px baseline. Rows now show findings that fit on one line, followed by an exact counter for the rest ("+3 more", say). Hovering the counter names the off-screen findings; expanding the row lists them all. Total findings reported is unchanged. All rows are now 77px.
- **Fixes: applying a fix removed its own Undo button, leaving it only in an unlabelled list capped at six.** Both Health and Fixes pages only offered a fix while its finding was still observed, so once applied, the fix vanished from both — the only way back was an unlabelled entry in a list capped at six. Applied fixes now appear in their own "Applied fixes" group, uncapped, with an Undo button. Fixes whose applied state could not be determined are listed separately with the reason, never silently dropped and never shown as not applied.
- **Sessions: the Health status and Issue type checkboxes did nothing.** They were drawn without a click handler. Both now filter the table: ticks in one group widen (either one matches), ticks across groups narrow (all must match), and a Clear filters button appears while any filter is on. The number beside each box is the number of loaded rows it shows when ticked. Issue type now lists every observed issue, not only the first five.
- **Sessions: the Diagnosis / Evidence / Metrics / Timeline tabs in the detail panel did nothing.** Each now shows its own content from the session's real data: findings and suggested fixes; every check with its numbers and reasons; turns, duration, model, context window and sub-agent counts; and start, sub-agent and end times. The page receives no per-turn records, so the Timeline says the turn-by-turn view is not measured instead of leaving a gap.
- **Fixes: Preview, Apply and Undo all opened the same window.** They are replaced by one "Review fix" button that opens the full workflow (see the exact change, apply it, undo it).
- **Fixes: the issue categories were plain labels.** They are now buttons that narrow the issue list, and Previous/Next stay inside the chosen category.
- **Fixes: any Fixes address with a `?` in it — including the existing Previous/Next buttons — opened the Health page.** The router read `fixes?issue=1` as an unknown page name.
- **Fixes: every finding was told its fix "targets the configuration for another CLI".** The check compared against a field the fix list never carries. Findings now read "Fix available for your CLI" or "Recommendation only" based on the CLI the fix actually changes; the Sessions detail panel uses the same labels.

## [0.1.2] - 2026-09-22

### Changed

- **Date-range selector in the header**: Last 15 days / 30 days / 3 months / All time. Each range filters which sessions you see without narrowing the scan or changing the verdicts. Wider windows read wider with per-range scan bounds (250 / 500 / 1500 / 5000 per CLI) to keep response time bounded. Every response states how many sessions the window actually holds and when the scan did not reach back into it.
- **Collectors now publish `support` and `installed` as separate fields.** Previously a CLI that was not installed was reported as "unsupported", which was false — SessionRx can parse it, the machine just does not have it. `support` describes SessionRx's capability: "supported", "detection-only", or "unreadable". `installed` describes this machine: true, false, or null. The note beside each CLI name is no longer confused with these properties.
- **Overview page aggregates now computed over the selected window instead of over the newest ten serialized session cards.** Problems found, fixes available, and could-not-be-measured counts reflect every session in the date range, not the ten cards that fit on screen. Top fixes list now shows up to five rows.
- **Trends cards now show a level and a percentage change.** Context efficiency and cache hit rate are percentages; token spend is a count. Each card leads with the current level and a relative change derived from the window's two halves, or "not comparable" with a reason when the scan never reached into both periods.
- **A previous-window comparison publishes a delta only when the scan actually covered both windows.** The comparison states whether it is valid and why, never manufacturing a figure from incomplete evidence.
- **Health Summary displays all six health checks as an issue distribution,** counting each check across the full window with all three states (observed, not-observed, unknown) visible. Rules with no findings in the window are listed with zero observed count rather than hidden.
- **First-run state distinct from an empty date range.** A machine with no AI CLI sessions shows a panel naming every CLI SessionRx can read, whether each was found, and what to do next. A machine with sessions but none in the selected range says so and offers to widen the range.
- **The other five pages brought in line with the Overview's visual language**: session IDs and dates render on one line, monospace and ellipsized, with the full ID in a title attribute rather than wrapping rows to three lines. Finding severity pills are shaped as pills rather than tall circles. Every page carries icon badges on section headings.
- **Three pages rebuilt against supplied mockups**: Overview, Sessions, and Fix Workflow. Overview is now the landing page; Health, Trends and Report untouched and still work.
- **The score changed from a single number to passed-of-measured, because a single figure forces a choice about whether `unknown` counts as pass or fail.** Every mockup showed "78 Session Health" or "62/100". But a session's score is `{total, passed, observed, unknown}` — collapsing to one number forces a lie: count unknown as pass and the honesty rule vanishes; count it as failure and a check that could not run gets reported as failed. The donut now shows passed-of-measured, e.g., `44/48 measured`, with unknown count displayed beside it, never folded inside. This decision and four others are documented in `docs/UI_DATA_CONTRACT.md` and are binding on page modules: trend deltas render only where both `from` and `to` are supplied; "total tokens" is labelled "total context read across all turns" (its actual meaning); anything the mockups showed with no data source behind it was cut, never invented.
- **Colour now carries meaning**: blue for a plain count, amber for problems, green for available fixes, grey with a dashed stroke for unmeasured. Session trend lines take their session's verdict colour. Finding pills are now actually pill-shaped instead of circles with text stacked vertically inside.

### Fixed

- **The Sessions table rendered roughly three rows per screen.** The health verdict is an honest ~60-character sentence, but its column was pinned at 78px under `table-layout: fixed` while the empty expand-row column took 372px, and `overflow-wrap: anywhere` broke the sentence mid-word. Measured at 1920px: the pill was 50px wide and up to 357px tall, average row height 288px. All ten columns are now sized, the pill wraps on word boundaries, and the same measurement gives a 242x56px pill and a 63px average row. The verdict text is unchanged — shortening it to buy column width would have traded a layout bug for an honesty bug.
- **The "Fixes available" card's arrow could point the opposite way to its own number.** The value came from `distinctFixes.count` while its delta chip and sparkline came from `fixableFindings`, a different quantity: a window where distinct fixes fell from 4 to 3 rendered `3` with a 63.8% increase. The API publishes no previous-window figure for distinct fixes, so the chip now reads "not comparable" and names why, and the sparkline is gone. Sessions and Problems keep their deltas; they have the data.
- **A per-hour token rate was published to a tenth of a token** (`1,279,557.4 tokens per hour`), across 45 evidence rows on five pages. It now publishes whole tokens per hour. A rate that could not be computed is still null, never 0.
- **The token-spend headline still carried nine significant figures on a seven-day mean.** It now leads with three (`336M`) and prints the exact whole-token figure beneath it, so the precision is reduced without the value being hidden.
- **One rule reported two different severities on the same screen.** The Sessions page kept its own severity map alongside the shared one, so `long-rising-context` — declared `critical` — read "High" in Key findings and "Medium" in the detail panel. Both now read the shared helper.
- **"Fixes available" named two different quantities.** The Overview card counts distinct fixes; a stat on the Health page counted fixable findings under the identical label, so the wider scan showed the smaller number. The Health stat is now "Fixable findings". The count is unchanged.
- **The date-range selector had no visible focus ring.** An `outline: 0` at higher specificity cancelled the global `:focus-visible` rule, leaving the one control that changes every number on every page invisible to keyboard users. It now shows a 2px outline on focus.
- **A green "No problems" pill rendered on sessions where checks could not run.** Over 1,000 real sessions, 587 rows displayed it and 583 of those had at least one unmeasured check; 268 had zero checks pass. The verdict honours the honesty contract (unknown is never a pass), but the table did not. Sessions now show three distinct states: a pass only when no checks are unknown, an observed problem when findings exist, or an unmeasured state when unknown checks exist, with a count of how many of how many could not be measured.
- **The session health badge computed a wrong denominator and disagreed between pages.** The Sessions table computed `passed/(total - unknown)` and rendered `4/5 measured` while the Health page computed the same session as `4/6`. The badge now uses the API's own `score.label` string, computed once and shared across all components, eliminating the discrepancy.
- **Four summary cards lacked unit words, causing a count of checks to read as a count of sessions.** Cards now explicitly label their units: "sessions", "findings", "findings", and "checks".
- **The token-spend card printed a per-day mean to nine significant figures under the caption "Total tokens per day", hiding the fact that ~99% of it was cache re-reads.** The card now states it is a per-day mean over N measured days, separates cache-read tokens from fresh input, and renders both values.
- **The "Sessions analyzed" card presented a scan-limited floor as fact.** When the scan has reached its per-CLI limit and cannot read further back, the card now discloses this on its own face.
- **"Fixes available" showed the same count as "Problems found" (both 277) because every rule carries a fix, obscuring which improvements SessionRx can actually offer.** The card now shows the count of distinct fixes (4), notes how many findings they address (277), and states that all fixes write to Claude Code's config, not the other CLI mentioned in a finding.
- **`distinctFixes` counted fix ids with no implementation behind them.** The count is now bounded by the real fix catalogue; a finding whose fix id is unknown stays an observed finding but no longer claims a remedy exists.
- **"High rank" / "Medium rank" / "Low rank" severity badges on Top fixes were assigned from list position and displayed as a judgement.** These badges have been removed.
- **A missing bracket in `tests/frontend-contract.test.js` left the test file unable to parse, silently hiding 64 tests.** The bracket is restored; the test suite now correctly reports all assertions.
- **On Node 22, the first line printed was Node's own SQLite ExperimentalWarning, making SessionRx appear experimental.** The warning is now suppressed for SQLite only via scoped filtering; all other warnings continue to reach the user.
- **A chart invented its own data from a loop index.** The Fix page's "Occurrences in recent sessions" chart set bar heights from a for-loop counter — seven bars, fixed heights, unrelated to any measurement. This was the most serious bug in this release on the one tool whose whole claim is that it never shows a figure it cannot justify. The chart now draws real per-day counts from each finding's session start time. Where no session carries a start time it says so instead of drawing anything.
- An internal rule identifier like `BP-003.04` escaped into user-facing body text. These ids are deliberate in the analyzer as evidence of record and render only inside collapsed evidence sections; they do not appear in prose a reader sees by default.
- With only two days in range, the occurrence histogram drew two bars each as wide as the card. Bar width is now capped.
- Overview page "Recent sessions" table inherited a 1,100px minimum width in a ~940px column, clipping its last column mid-word — "No problem observed" rendered as "No problem observec". The width floor is removed. The table now fits its container at 560px, 700px, 860px, 1000px, 1100px, 1280px and 1440px wide; the rule hiding two columns below 700px still applies.
- "Top fixes" and "Recent sessions" cards sit side by side in CSS grid, which stretched both cards to the taller one's height. On machines whose scan found only one or two distinct fixes, the Top fixes card padded out with ~500px of empty space. Each card's height now follows its own content.

### Repository (not shipped in the npm package)

- README screenshots recaptured against the redesigned interface: new Overview page image, and replacement Health page showing one real session carrying all three verdicts at once.
- The README Overview screenshot was recaptured because the committed image still showed the nine-significant-figure token number and the Fixes-card sparkline that this release removes.
- Test suite verified on Node 22.23.2 and Node 26.9.0: 885 passing, 0 failing.

## [0.1.1] - 2026-09-21

### Fixed

- **A fix offered on a Codex or Gemini session never said it writes Claude Code's config.** The README stated the limitation; the card did not. A finding on a Codex session offered "Batch commands instruction" with nothing indicating the write lands in `~/.claude/`. Nothing was ever written silently — Apply opens a modal showing the absolute target path — but the user had to infer "Claude Code's config" from a file path on a card about a different CLI. The card now states it outright, in the fix offer, above the buttons: *"Changes Claude Code's config, not Codex's. Affects future Claude Code sessions only."* Same-CLI findings render no note, and a fix whose target CLI is unknown renders no note rather than a guess.
- The CLI display names in that sentence are published by the server from the collector registry, the single place that already owns them. An earlier draft capitalized the id client-side and produced "Claude", "Gemini" and "Opencode" instead of "Claude Code", "Gemini CLI" and "OpenCode".

### Changed

- The fix catalogue now records each fix's target CLI, and the API publishes it as `fixCli` / `fixCliName` beside `fixTitle`, so no client keeps a second copy of that catalogue.

### Repository (not shipped in the npm package)

- A Copilot test fixture was silently excluded by a blanket `*.log` rule in `.gitignore`. The test passed on the author's machine and failed on every fresh clone, against the project's own requirement that the suite pass on a clean checkout. Fixtures are now exempted; real logs are still ignored.
- The changelog's "Six health rules" list named three rules and three fixes, leaving cache-hit, large-tool-result and long-rising-context undocumented. Both lists are now keyed to their ids in `src/`.

## [0.1.0] - 2026-09-21

### Added

- **Local-first session analysis tool**: `npx session-rx` opens a browser to diagnose inefficient AI coding sessions. No cloud, no accounts, no telemetry, and no AI API calls.
- **CLI support**: Parsers for Claude Code, Codex, Gemini CLI, Kimi, and OpenCode. Copilot has detection-only support; Grok and Amp are honest stubs, acknowledging when a format cannot be confirmed.
- **Six health rules** scored against each session's actual CLI context window, not a hardcoded threshold:
  - Context pressure — average per-turn context against the session's own window
  - Low cache hit — share of reusable prompt content rebuilt instead of read back
  - Repeated tool work — same tool, same input, a result of the same size
  - Large tool results — turns whose tool results exceed the byte threshold
  - Long rising context — long session AND a rising context trend, both required
  - High sub-agent concurrency — peak concurrent sub-agents against total dispatched
- **Honesty contract**: Every verdict is one of `observed`, `not-observed`, or `unknown`. The tool never reports `unknown` as a pass. Null metrics are never rendered as zero. Over 50% of verdicts acknowledge what cannot be measured with evidence.
- **Five reversible fixes** for Claude Code configuration with preview, apply, undo, and check operations. Every one writes to Claude Code's own config, whichever CLI the finding came from:
  - `claude-auto-compact` — merges auto-compaction settings into `~/.claude/settings.json`
  - `claude-output-hygiene` — appends an output-bounding section to `~/.claude/CLAUDE.md`
  - `claude-batch-commands` — appends a command-batching section to `~/.claude/CLAUDE.md`
  - `claude-worker-cap` — appends sub-agent fan-out and brief-size caps to `~/.claude/CLAUDE.md`
  - `claude-compact-contract` — appends what must survive a compaction to `~/.claude/CLAUDE.md`
- **`session-rx clean` command**: Explicitly remove undo history. The command is a dry-run by default, showing what would be removed (files, bytes, date range) before confirming with `--yes`.
- **Four analysis pages**:
  - Health: diagnoses across recent sessions, showing the 10 newest sessions and total measured count
  - Trends: changes in session behavior over time
  - Sessions: paginated list of all sessions (newest first, 20 per page by default, up to 5,000)
  - Report: Markdown summary with secret redaction, traceable to session sources
- **Performance optimizations**:
  - Paginated session API reduces response from 43.8 MB to 0.53 MB for the first page
  - Corpus signature caching with invalidation on file changes
  - Analysis cached selectively to maintain honesty guarantees (verdicts rebuilt per request)
  - Health page renders in ~1,050ms after first request
- **Offline operation**: Chart.js is vendored; the UI works without internet access.
- **Security hardening**:
  - Host header validation on every request to prevent DNS rebinding
  - Read-only database access via `file:?mode=ro` URI
  - Backup before every fix apply, stored in `~/.session-rx/undo/<timestamp>/`
  - Report redaction enforced (fails closed if redaction code cannot load)
- **Complete test suite**: 824 tests covering health rules, collectors, fix engine, server routes, and UI components. All pass.

### Fixed

- Half of the `subagent-concurrency` rule's positives were false: sessions with peak=1 (one sub-agent) no longer trigger a problem report; the floor is now peak ≥ 2.
- Report section "Fixes applied" was asserted as empty even when fixes had been applied minutes earlier. Now reads the transaction journal correctly.
- Crashed collectors reported as healthy; failed reads now transparently publish error status instead of a measured zero.
- False all-clear when a session's vendor tier was unknown: now returns `unknown` with reason rather than borrowing from a fallback vendor tier.
- Long-rising-context rule returned false `not-observed` when slope could not be computed (all timestamps identical); now returns `unknown` with reason.
- Sub-agent sessions (449 on the machine) were silently hidden; now counted and displayed separately.
- 250 Gemini sessions with zero turns were counted as readable; disclosure now clarifies that none of them recorded any message, so there is nothing to measure.
- Server restart left open tabs unable to apply fixes; error message now names the actual cause (stale CSRF token) and the fix (reload the page).
- Foreign Host headers bypassed all validation checks; now rejected before path traversal (fixes DNS rebinding vulnerability).
- Fixes refused to create absent config files even when their parent directories existed; now creates absent files (never absent directories), with disclosure in the diff using `/dev/null` as git convention.
- AutoCompactFix failed on created files; now handles empty-file case separately from unparseable-file case.
- Health page shipped full 18.2 MB of data to render 10 cards; now narrows only the serialized array while keeping full dataset in analysis (preserves honesty contract).
- Pagination count was off-by-one on filtered lists; ordering clarified (filter then page, never the reverse).
- Sessions API could re-scan all sessions on every page load (5,538ms overhead per page); now caches the scan result with signature-based invalidation (1,151ms → 1,050ms after first request).
- README claimed database write lock was never taken but WAL mode takes a lock on the `-shm` sidecar; clarified that database **content** is never altered.
- README promised privacy without disclosing that the report includes file paths and project names for traceability; now documented.

### Changed

- CLI now accepts subcommands (`session-rx clean`); flags like `--port` work unchanged.
- Undo history now survives tool uninstall (documented). Explicit removal requires `session-rx clean --yes`.
- Collectors now deliver diagnostic details on every scan, including file counts and error reasons, enabling honest "could not read" verdicts.
- Health rule verdicts that cannot be measured (too few data points, vendor tier unknown, no slope computed) now return `unknown` with a plain-English reason instead of being reported as `not-observed`.
- Window tier resolution no longer borrows from a fallback all-vendor ladder when a vendor is explicitly named; unknown tiers in named vendors stay unknown.
- Sub-agent sessions are now counted and partitioned, not silently removed from the headline view.

---

SessionRx is designed around a core principle: an absence of evidence is not evidence of absence. The tool's first obligation is honesty about what it can and cannot measure. Over 51% of verdicts on live sessions acknowledge measurable uncertainty rather than reporting a pass the evidence does not support.

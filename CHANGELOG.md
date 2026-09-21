# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-21

### Changed

- **Three pages rebuilt against supplied mockups**: Overview, Sessions, and Fix Workflow. Overview is now the landing page; Health, Trends and Report untouched and still work.
- **The score changed from a single number to passed-of-measured, because a single figure forces a choice about whether `unknown` counts as pass or fail.** Every mockup showed "78 Session Health" or "62/100". But a session's score is `{total, passed, observed, unknown}` — collapsing to one number forces a lie: count unknown as pass and the honesty rule vanishes; count it as failure and a check that could not run gets reported as failed. The donut now shows passed-of-measured, e.g., `44/48 measured`, with unknown count displayed beside it, never folded inside. This decision and four others are documented in `docs/UI_DATA_CONTRACT.md` and are binding on page modules: trend deltas render only where both `from` and `to` are supplied; "total tokens" is labelled "total context read across all turns" (its actual meaning); anything the mockups showed with no data source behind it was cut, never invented.
- **Colour now carries meaning**: blue for a plain count, amber for problems, green for available fixes, grey with a dashed stroke for unmeasured. Session trend lines take their session's verdict colour. Finding pills are now actually pill-shaped instead of circles with text stacked vertically inside.

### Fixed

- **A chart invented its own data from a loop index.** The Fix page's "Occurrences in recent sessions" chart set bar heights from a for-loop counter — seven bars, fixed heights, unrelated to any measurement. This was the most serious bug in this release on the one tool whose whole claim is that it never shows a figure it cannot justify. The chart now draws real per-day counts from each finding's session start time. Where no session carries a start time it says so instead of drawing anything.
- An internal rule identifier like `BP-003.04` escaped into user-facing body text. These ids are deliberate in the analyzer as evidence of record and render only inside collapsed evidence sections; they do not appear in prose a reader sees by default.
- With only two days in range, the occurrence histogram drew two bars each as wide as the card. Bar width is now capped.
- Overview page "Recent sessions" table inherited a 1,100px minimum width in a ~940px column, clipping its last column mid-word — "No problem observed" rendered as "No problem observec". The width floor is removed. The table now fits its container at 560px, 700px, 860px, 1000px, 1100px, 1280px and 1440px wide; the rule hiding two columns below 700px still applies.
- "Top fixes" and "Recent sessions" cards sit side by side in CSS grid, which stretched both cards to the taller one's height. On machines whose scan found only one or two distinct fixes, the Top fixes card padded out with ~500px of empty space. Each card's height now follows its own content.

### Repository (not shipped in the npm package)

- README screenshots recaptured against the redesigned interface: new Overview page image, and replacement Health page showing one real session carrying all three verdicts at once.
- Test suite: 828 passing, 0 failing.

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

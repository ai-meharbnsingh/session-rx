# SessionRx — Contributor Rules

## THE HONESTY CONTRACT

Every health-rule verdict is exactly one of: `observed` | `not-observed` | `unknown`. A fourth state (`pass`, `0`, `—`, or null) is not allowed.

| Rule | Binding requirement |
|---|---|
| `observed` | a problem was found, with the numbers that show it |
| `not-observed` | the check ran and found nothing wrong |
| `unknown` | the check could not run — the log does not record what it needs, PLUS a machine-readable reason in `verdict.reason` |

`unknown` is **never a pass**. Null metrics are never rendered as 0. No-evidence statements never read as "all clear".

A new rule that cannot produce `unknown` honestly is not mergeable.

## THE FIX CONTRACT

Every fix implements `preview()` / `apply()` / `undo()` / `check()`.

| Gate | Rule |
|---|---|
| Preview output | must equal what `apply()` writes, byte-for-byte |
| Backup | before any write, copies target file to `~/.session-rx/undo/<timestamp>/` |
| Idempotence | fixes are idempotent; `check()` reads a stable marker and does not re-offer if already applied |
| Append-only config | never overwrite or reformat existing user content (sections only); never remove an existing key from JSON files |

## READ-ONLY BY DEFAULT

Collectors stream user log files with `createReadStream` — never opened for writing. The OpenCode SQLite database is opened through a `file:<path>?mode=ro` URI, so its database file is never written; reading may advance the mtime of the WAL index sidecar file but never alters its content. The only writes to user files or settings are inside a fix's `apply()`, after an explicit user click.

## NO NETWORK

No runtime `fetch()` or `require('http')` calls. Chart.js is vendored at `public/vendor/chart.umd.min.js`. A PR adding a CDN `<script>`, a remote `import`, or a `fetch()` is rejected.

## TESTS

Run via `npm` scripts. Every test must pass on a fresh clone with no AI CLI installed (use fixtures, never developer's real `~/.claude/` or `~/.session-rx/`).

| Script | Command |
|---|---|
| All tests | `npm test` or `node --test` |
| Collectors only | `npm run test:collectors` or `node --test 'tests/collectors/*.test.js'` |
| Run the tool | `npm start` or `node src/cli.js` |

## ADDING A CLI PARSER

Never invent a log format. Confirm the real on-disk shape first by examining actual session files. A CLI whose format is unconfirmed ships as detection-only (collector returns empty `sessions: []`), not as a guessed parser.

## LAYOUT

| Directory | Responsibility |
|---|---|
| `src/analyzer/` | Health rules, verdict logic, trend analysis |
| `src/collectors/` | CLI log parsers (Claude Code, Codex, Gemini, Kimi, OpenCode, etc.) |
| `src/fixes/` | User-facing fixes (config rewrites, settings changes) |
| `src/report/` | Markdown report generation + secret redaction |
| `public/js/pages/` | Page modules (health, report, sessions, trends) |
| `public/js/components/` | UI components (chart, fix-modal, etc.) |
| `public/css/` | Stylesheets |
| `public/vendor/` | Vendored third-party libraries (Chart.js) |
| `tests/` | Test suites (parallel structure matching src/) |

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

## THE SUGGESTION CONTRACT

SessionRx never writes a user's files. Every observed finding that names a fix produces a SUGGESTION instead: a preview of the exact text to add, and a ready-made request the user copies into their own AI coding tool, which makes the change itself.

| Gate | Rule |
|---|---|
| No writes | a suggestion never writes any file — not the target, not a backup, not state |
| Preview | is exactly the text the request asks the target tool to add, byte-for-byte |
| Append-only request | the request tells the tool to add a section or a key without changing or removing anything already there |
| Idempotence | the marker (or, for a settings key, the key/value) is the idempotence gate: a resolvable target already carrying it is reported `already-added`, never re-offered |
| Own tool | a suggestion targets the SAME tool whose session showed the problem — a Codex finding gets a Codex-targeted suggestion, never always Claude |

## READ-ONLY BY DEFAULT

Collectors stream user log files with `createReadStream` — never opened for writing. The Cursor CLI SQLite database is opened through a `file:<path>?mode=ro` URI, so its database file is never written; reading may advance the mtime of the WAL index sidecar file but never alters its content. SessionRx never writes a user's files at all. The only thing it ever deletes is its own leftover data under `~/.session-rx/` (backups an earlier version made), and only via `session-rx clean`, on an explicit `--yes`.

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
| `src/collectors/` | CLI log parsers (Claude Code, Codex, Cursor) |
| `src/suggestions/` | Suggestion definitions, tool targets, and request/preview generation |
| `src/clean.js` | `session-rx clean` — deletes only SessionRx's own leftover data |
| `src/report/` | Markdown report generation + secret redaction |
| `public/js/pages/` | Page modules (fixes, health, overview, report, sessions, trends) |
| `public/js/components/` | UI components (chart, suggestion-panel, etc.) |
| `public/css/` | Stylesheets |
| `public/vendor/` | Vendored third-party libraries (Chart.js) |
| `tests/` | Test suites (parallel structure matching src/) |

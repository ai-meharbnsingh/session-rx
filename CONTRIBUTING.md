# Contributing to SessionRx

## Running tests

All tests must pass on a fresh clone with no AI CLI installed. Use fixtures, never developer's real `~/.claude/` or `~/.session-rx/`.

| Test suite | Command |
|---|---|
| All tests | `npm test` or `node --test` |
| Collectors only | `npm run test:collectors` or `node --test 'tests/collectors/*.test.js'` |

## The honesty contract

Every health-rule verdict is **exactly one of**: `observed` | `not-observed` | `unknown`.

A fourth state (`pass`, `0`, `—`, or null) is not allowed.

| Rule | Binding requirement |
|---|---|
| `observed` | a problem was found, with the numbers that show it |
| `not-observed` | the check ran and found nothing wrong |
| `unknown` | the check could not run — the log does not record what it needs, PLUS a machine-readable reason in `verdict.reason` |

`unknown` is **never a pass**. Null metrics are never rendered as 0. No-evidence statements never read as "all clear".

A new rule that cannot produce `unknown` honestly is not mergeable.

## The suggestion contract

Every suggestion implements a preview of the exact text to add.

| Gate | Rule |
|---|---|
| Preview output | must show exactly what text would be added, byte-for-byte |
| Read-only | SessionRx never writes any user file |
| Idempotence | a suggestion's marker check reads a stable file marker and does not re-offer if already added |

SessionRx reads target files to check whether a suggestion is already present. It never applies anything; the user's AI tool reads the request and makes the change.

## No network

No runtime `fetch()` or `require('http')` calls. Chart.js is vendored at `public/vendor/chart.umd.min.js`. A PR adding a CDN `<script>`, a remote `import`, or a `fetch()` is rejected.

## Adding a CLI parser

1. **Confirm the real log format first** by examining actual session files from the CLI on your machine.
2. **Write the parser** as a subclass of `Collector` in `src/collectors/<cli>.js`.
3. **Add an entry to the registry** in `src/collectors/registry.js` so the CLI is discovered.
4. **Write tests** exercising the parser against real file shapes.

A CLI whose format is unconfirmed ships as detection-only (collector returns empty `sessions: []`), not as a guessed parser. This prevents fabricating zero-metric sessions, which would render as healthy sessions rather than unknown sessions.

## Full rules

See `.claude/CLAUDE.md` in the project root for the complete set of contributor rules.

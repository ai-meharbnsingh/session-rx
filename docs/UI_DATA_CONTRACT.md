# UI data contract — what the mockups ask for vs what the analyzer can honestly produce

> Binding on every page module. The mockups are a LAYOUT spec, not a DATA spec.
> Where a mockup shows a number the analyzer cannot compute, the page shows
> "not measured" with a reason. It never shows a filled-in guess.

## D-1 — health score: there is no 0-100 score, and one cannot be invented

| Mockup shows | Data actually has |
|---|---|
| `78 Session Health`, `62/100`, `92`, `41` | `score = {total:6, passed:4, observed:1, unknown:1, label}` |

A 0-100 number requires deciding what `unknown` is worth. Counting it as a pass
breaks "unknown is never a pass". Counting it as a failure reports a check that
could not run as a check that failed. Both are the exact collapse the honesty
contract exists to prevent.

RULE: the health circle renders `passed / measured` where
`measured = total - unknown`. The unknown count sits BESIDE it, never inside
it. A session with 6 unknowns renders "no checks could be measured", not 0.

| Circle colour | Condition |
|---|---|
| green | `observed === 0` and `unknown === 0` |
| amber | `observed === 0` and `unknown > 0`, OR `observed === 1` |
| red | `observed >= 2` |
| grey | `measured === 0` — nothing could be measured |

## D-2 — period-over-period deltas exist for TWO metrics only

`/api/trends.trend.metrics` supplies `{label, from, to, unit}` with a
materiality floor and a standard error already applied. Today that is
"turns above 70% of window" and "cache hit rate".

RULE: a summary card shows a delta ONLY when a metric with `from` and `to`
backs it. Otherwise the card shows the value and NO delta. An absent delta is
absent, never rendered as `0%` or a flat arrow.

## D-3 — "total tokens" must say which tokens

`turn.context.inputTokens` is the CONTEXT SIZE at that turn, not new tokens
written. Summing it across turns counts the same prompt repeatedly, because
that is what actually happens on every turn.

RULE: label it exactly - "total context read across all turns". Never
"total tokens", which reads as spend and would overstate it by the reuse
factor. Sessions whose turns carry no token count are excluded from the sum
and the excluded count is disclosed.

## D-4 — every count on a card is a real count

| Card | Source |
|---|---|
| Sessions analyzed | `sessionsTotal` |
| Problems found | rules with `evidence.status === "observed"` |
| Fixes available | observed rules carrying a `fix` |
| Not measured | rules with `evidence.status === "unknown"` |

The mockup's "Not measured: 98, 8%" is legitimate. It must never be styled as
a lesser or dismissible state - it is a first-class verdict.

## D-5 — anything the mockup shows that has no source is CUT, not faked

Known cases, all cut rather than invented:

| Mockup element | Why it is cut |
|---|---|
| `↑ 12 points vs previous 15 days` on the donut | no historical health score exists to difference |
| per-session `duration` on cards where `startedAt`/`endedAt` are absent | renders "not measured" |
| "All systems operational" footer | there is no system to be operational; replaced with the real local-only notice |

## D-6 — the three-state vocabulary survives the redesign

PROBLEM FOUND / PASSED / COULD NOT BE MEASURED keep distinct treatments on
every new page. A redesign that renders unknown as a dash, a zero, or a muted
pass is a failed redesign regardless of how it looks.

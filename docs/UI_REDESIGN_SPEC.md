# UI redesign spec — three pages

> Mockups: `docs/assets/mockup-overview.png`, `mockup-sessions.png`,
> `mockup-fix.png`. Open them. They are the LAYOUT authority.
> `docs/UI_DATA_CONTRACT.md` is the DATA authority and overrides the mockups
> wherever they disagree. Vanilla JS + CSS only. No new dependency.

## Scope

| Page | File | Nav label |
|---|---|---|
| Overview | `public/js/pages/overview.js` (new) | Overview |
| Sessions | `public/js/pages/sessions.js` (rewrite) | Sessions |
| Fix Workflow | `public/js/pages/fixes.js` (new) | Fixes |

Health, Trends and Report pages keep working unchanged. Overview becomes the
landing route; Health stays reachable.

## PAGE 1 — Overview

- Header: tagline "Make your AI sessions more effective." + subtitle, and
  detected CLIs as pills on the right with a count.
- Four summary cards: Sessions analyzed / Problems found / Fixes available /
  Not measured. Each: large number, subtitle, sparkline SVG. A trend delta
  ONLY where `/api/trends.trend.metrics` backs it (contract D-2).
- Health Summary: SVG donut, issue distribution legend with percentage bars,
  and the trend verdict ("improving"/"declining"/"stable") taken from
  `trends.trend.direction` with its `summary` sentence.
  The donut centre shows passed-of-measured, NOT a 0-100 score (contract D-1).
- Trends preview: three mini cards from real metrics, each with a mini line
  chart. Cards with no backing metric are not rendered at all.
- Top Fixes: ranked list, severity badge, Preview / Apply / Skip per row,
  reusing the existing fix modal.
- Recent Sessions: table — CLI, started, duration, turns, health circle, key
  issue, View.

## PAGE 2 — Sessions

- Left sidebar filters: CLI (with counts), health status, date range, issue
  type. All counts computed from real data.
- Centre: sortable table — session id, CLI, date, duration, turns, health
  circle, key findings as pills, sparkline, expand arrow. Pagination at the
  bottom, wired to the EXISTING `/api/sessions` offset/limit paging. Do not
  change the API.
- Right panel opens on row click: session id, CLI badge, timestamp, duration,
  turns, health circle with label, context sparkline, tabs
  (Diagnosis / Evidence / Metrics / Timeline), suggested fixes with Apply,
  and Export / Preview Fix actions at the bottom.
- "Open in CLI" from the mockup is CUT — there is no such capability.

## PAGE 3 — Fix Workflow

- Left sidebar: three-step progress (Diagnose done, Review & Fix active,
  Verify), then issue categories with counts (All Issues, Configuration,
  Context & Memory, Tool Usage, Performance). Categories derive from the rule
  set; a category with no rules shows 0, never hidden.
- Centre: issue detail — severity badge, title, plain description, "Why this
  happens" from the rule's existing plain-language text, "Expected benefit"
  with impact badge and bullets, and an occurrences-over-time bar chart.
- Right panel: "Proposed fix", Safe-change badge, target file name, unified
  diff with line numbers and +/- colouring taken from the EXISTING
  `/api/fixes/:id/preview` response, then Preview / Apply Fix / Undo, and the
  local-only notice.
- The cross-CLI disclosure from 0.1.1 must survive here: when the finding's
  CLI differs from the fix's target CLI, say so.
- Bottom: other recommended fixes as horizontal cards.
- Navigation: "Back to issues", "Issue N of M" with prev/next.

## Shared

- Dark theme, every colour/border/background a CSS variable in `:root`.
- Cards: rounded corners, subtle border, slight shadow — one shared class.
- Health circles: green / amber / red / grey per contract D-1.
- Severity badges: High (red-orange), Medium (amber), Low (blue-grey).
- CLI icon: first letter in a coloured circle, colour derived from the id.
- Sparklines: inline SVG paths, ~30px tall, no axes.
- Donut: pure SVG, animated on load, `prefers-reduced-motion` respected.
- Footer: version, local-only privacy note. No fake status indicator.
- Mobile: cards stack, sidebar collapses, no horizontal page scroll.

## Non-negotiable

- No change to any API route, analyzer, collector or fix module.
- Nothing hardcoded. Every number from the existing API.
- `unknown` keeps a distinct treatment everywhere. Never a dash, zero or a
  muted pass.
- Text rendered via `textContent`, never `innerHTML`, for anything derived
  from session data.
- No internal ids or jargon in user-facing strings: DIS-N, BP-N, F-N,
  sidechain, linkage, denominator, corpus, magnitude.

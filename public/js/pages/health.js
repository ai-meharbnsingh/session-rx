/**
 * BP-001.24 — Health page: the ten most recent sessions, one card each.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD (FVA-006, BP-002.18)
 * ---------------------------------------------------------
 * The analyzer emits three verdicts, not two: `observed` (a problem was found),
 * `not-observed` (the check ran and found nothing) and `unknown` (the check
 * COULD NOT RUN).  On the real corpus the third is the majority.  A UI that
 * folds `unknown` into a tick tells the user an unmeasurable check passed,
 * which is the single failure this product exists to prevent.
 *
 * So, here, `unknown` is separated on five channels at once:
 *   1. its own row class `.verdict-unknown` (dashed + hatched, wave 5C)
 *   2. its own glyph `?` where pass is `✓` and a problem is `!`
 *   3. its own words — "COULD NOT BE MEASURED", never "OK"
 *   4. the sentence "This is NOT a pass" in plain text, not a tooltip
 *   5. a plain-English sentence saying WHAT could not be worked out and WHY,
 *      leading the row; the engineering `evidence.reason` that sentence stands
 *      in for keeps its every word, one click away inside the evidence
 *      `<details>`.  Where a rule has no plain sentence for its cause, the
 *      engineering reason stays on the card face — it is then all a reader has,
 *      and an unknown with no stated cause would be a worse honesty failure
 *      than a jargon-heavy one.
 * plus `data-status="unknown"` for any styling or test that wants to assert it.
 *
 * The score bar is three segments — passed, observed, unknown — so the unknown
 * share is visible as area, and `score-headline` prints the unknown count
 * alongside "N/6 checks passed" unconditionally.  "4/6" can never stand alone
 * and hide two checks that never ran.
 *
 * DEFAULT STATE (F-024, extended by the plain-language wave)
 * ------------------------------------------------------------
 * Each rule is ONE line by default, the shape the brief specified, and an
 * OBSERVED finding leads with a plain-English sentence above that line — the
 * jargon (rule name, id, raw metric) stays exactly where it was, one line,
 * not deleted, just no longer the FIRST thing a reader sees:
 *
 *   ! Your AI repeated the same tool operation 6 times. This may indicate
 *     wasted work — [...] a DETECTED REPETITION, not CONFIRMED WASTE.
 *     Repeated tool work   identical call+input+result: 6   repeat-tool · warn
 *     → Output hygiene instruction        [Preview] [Apply] [Skip]
 *   ✓ Low cache hit        cache hit rate: 100.0%           cache-hit · warn
 *
 * The plain sentence is a template declared on the RULE, in
 * `src/analyzer/rules.js` (`plain.problem` / `plain.why` for a finding,
 * `plain.unmeasured` — keyed by `evidence.reasonCode` — for a check that could
 * not run, all beside `name` and `threshold`, BP-005.19-style: one catalogue),
 * not a second copy of the wording kept here; this file only fills its
 * `{count}`/`{pct}` token from the rule's own `magnitude`
 * (`fillPlainTemplate`) and looks the unmeasured sentence up by its cause.
 *
 * Nothing is deleted to get there.  The threshold derivation, the computation
 * note, the raw evidence numbers and the evidence citation move behind a native
 * `<details>` whose `<summary>` IS that one line — so the disclosure costs no
 * vertical space, works from the keyboard, and works with script disabled.
 *
 * What is NEVER behind that click, because it is the honesty surface: the score
 * headline, the three-segment bar, the sentence that an unknown is not a pass,
 * each unknown rule's cause in plain English, every `— not measured`, the
 * lower-bound rendering and its note, and the [Preview] [Apply] [Skip]
 * buttons.
 *
 * A `null` number renders as `.not-measured` ("— not measured"), never as 0.
 * A window whose source is `observed-promoted` or `observed-floor` carries an
 * `.inferred-tag` wherever its number appears; an `observed-floor` window reads
 * as a lower bound ("at least 41,344") and NO percentage is derived from it,
 * because `floor / floor == 1.0` is an artifact of having no upper bound.
 *
 * SECURITY
 * --------
 * This page renders content read off local disk — project paths, cwd, model
 * ids, tool names, rule derivations.  `innerHTML` appears nowhere in this file.
 * Every string reaches the DOM through `el()` / `text()` (which assign
 * `textContent`) or `setAttribute`, so escaping is structural rather than a
 * function somebody can forget to call.  An injection here would run on an
 * origin that can POST `/api/fixes/:id/apply`, so it is privilege escalation,
 * not a cosmetic bug.  Mutating calls go through `app.js`'s wrapper, which
 * carries the startup CSRF nonce (BP-005.13).
 *
 * @module public/js/pages/health
 */

import { registerPage, api as appApi } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
import { icon } from '../components/ui.js';

/** BP-001.24: the ten latest sessions across every detected CLI. */
const SESSION_LIMIT = 10;

/**
 * `${sessionId}::${ruleId}` for fixes the user chose to skip.  Page-local and
 * deliberately not persisted: skipping means "not now", not a stored
 * preference, and a remembered skip would silently hide a finding next run.
 */
const skipped = new Set();

function iconBadge(name) {
  const badge = el('span', 'rx-icon');
  badge.append(icon(name));
  return badge;
}

/** Verdict presentation. `unknown` shares no channel with either other state. */
const STATUS = Object.freeze({
  observed: { word: 'PROBLEM FOUND', glyph: '!', row: 'verdict-warn', badge: 'badge-warn' },
  'not-observed': { word: 'PASSED', glyph: '✓', row: 'verdict-pass', badge: 'badge-ok' },
  unknown: { word: 'COULD NOT BE MEASURED', glyph: '?', row: 'verdict-unknown', badge: 'badge-unknown' },
});

/** BP-002.11..BP-002.16 — how the window number was arrived at, in words. */
export const WINDOW_SOURCE = Object.freeze({
  native: 'the CLI stated this window itself',
  'model-table': 'read from the versioned model-id table',
  'model-map': 'read from the model-id map',
  'observed-promoted': 'inferred: our table of model sizes said this model was smaller than the context this session actually held, so a larger size was assumed',
  'observed-floor': 'a lower bound: the largest amount of context this session was actually seen holding. That is not a measured window — nothing recorded how big it could have been',
  unknown: 'no window could be resolved for this session',
});

/** Sources whose number is an inference, not a reading. */
export const INFERRED_SOURCES = new Set(['observed-promoted', 'observed-floor']);

/** BP-002.18 — this source supports no percentage at all. */
export const FLOOR_SOURCE = 'observed-floor';

/**
 * The human name for a rule's fix.
 *
 * The API publishes `fixTitle` alongside `fix` (server.js `annotateFixTitles`),
 * so the catalogue lives in ONE place.  This page used to mirror the five
 * titles locally with a drift test holding the copies together — two
 * catalogues is how the UI and the API drift apart, which is the defect F-021
 * recorded.  Where the server published no title the id is printed verbatim,
 * never a name guessed here.
 *
 * @param {{fix?: unknown, fixTitle?: unknown}|null|undefined} rule
 * @returns {string}
 */
export function fixTitle(rule) {
  const title = rule?.fixTitle;
  if (typeof title === 'string' && title.length > 0) return title;
  const id = rule?.fix;
  return typeof id === 'string' && id.length > 0 ? id : 'this fix';
}

function fixCliNote(session, rule) {
  if (session?.cli !== rule?.fixCli) {
    if (typeof session?.cliName !== 'string' || typeof rule?.fixCliName !== 'string') return null;
  } else return null;
  const sourceCli = session.cliName;
  const targetCli = rule.fixCliName;
  return `Changes ${targetCli}'s config, not ${sourceCli}'s. Affects future ${targetCli} sessions only.`;
}

// ---------------------------------------------------------------------------
// DOM helpers — the only path text takes into the document
// ---------------------------------------------------------------------------

/**
 * Build an element.  `textContent` is assigned, never parsed as HTML, so a
 * `<script>` inside a project path or a tool name stays inert text.
 *
 * @param {string} tag
 * @param {string|null} [className]
 * @param {string|number|null} [textContent]
 * @returns {HTMLElement}
 */
export function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

/** A text node: content, never markup. */
export function text(value) {
  return document.createTextNode(value === undefined || value === null ? '' : String(value));
}

/**
 * The rendering of an absent measurement.  Carries its meaning for assistive
 * technology, because a bare dash reads as nothing at all.
 *
 * @param {string} [why] what specifically could not be read
 * @returns {HTMLElement}
 */
export function notMeasured(why = 'this value was not recorded') {
  const node = el('span', 'not-measured');
  node.append(el('span', 'dash', '—'), text(' not measured'));
  node.setAttribute('title', why);
  node.setAttribute('aria-label', `not measured: ${why}`);
  return node;
}

/** `at least N` — BP-002.15's lower bound, never presented as a measurement. */
export function lowerBound(value) {
  const node = el('span', 'lower-bound');
  node.append(el('span', 'lb-prefix', 'at least'), text(` ${groupInt(value)}`));
  return node;
}

/** The dashed "inferred" / "lower bound" tag attached to a promoted window. */
export function inferredTag(source) {
  const tag = el('span', 'inferred-tag', source === FLOOR_SOURCE ? 'lower bound' : 'inferred');
  tag.setAttribute('title', WINDOW_SOURCE[source] ?? source);
  return tag;
}

/** Thousands separators for display only. Non-finite input yields `null`. */
export function groupInt(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : null;
}

/** ISO string to a local date-time. Unparseable input yields `null`. */
export function whenText(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : null;
}

/**
 * Session duration from its own endpoints.  A missing endpoint means the
 * duration was not recorded: it is not zero, and it is not guessed from the
 * turn count.
 */
export function durationText(startedAt, endedAt) {
  const from = Date.parse(startedAt ?? '');
  const to = Date.parse(endedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A `.callout`, optionally with a detail paragraph. */
export function callout(kind, title, body, detail) {
  const box = el('div', `callout callout-${kind}`);
  if (title) box.append(el('p', 'callout-title', title));
  if (body) box.append(el('p', null, body));
  if (detail) box.append(el('p', 'callout-detail', detail));
  return box;
}

// ---------------------------------------------------------------------------
// Evidence values — where the honesty rules bite
// ---------------------------------------------------------------------------

/**
 * Render one evidence value (`{label, value, unit?, windowSource?}`).
 *
 * The three cases that are not simply "print the number":
 *   - `value == null` -> `.not-measured`, never 0.
 *   - a fraction/ratio on an `observed-floor` window -> NO percentage at all.
 *     The denominator IS the observed peak, so the share is 1.0 by
 *     construction (BP-002.18); printing "100%" would invent a measurement.
 *   - any number on an inferred window -> the number plus `.inferred-tag`.
 *
 * @param {{label?: string, value?: unknown, unit?: string, windowSource?: string}} value
 * @returns {DocumentFragment}
 */
export function evidenceValueNode(value) {
  const fragment = document.createDocumentFragment();
  const unit = typeof value?.unit === 'string' ? value.unit : null;
  const source = typeof value?.windowSource === 'string' ? value.windowSource : null;
  const raw = value?.value;
  const isShare = unit === 'fraction' || unit === 'ratio';

  if (raw === null || raw === undefined) {
    fragment.append(notMeasured('the collector recorded no value for this'));
    return fragment;
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fragment.append(el('span', 'num', String(raw)));
    return fragment;
  }

  if (isShare && source === FLOOR_SOURCE) {
    fragment.append(notMeasured('no honest percentage exists: the only figure to divide by is the peak this session was seen holding, which is not the size of its window'));
    fragment.append(inferredTag(source));
    return fragment;
  }

  if (isShare) {
    fragment.append(el('span', 'num', `${(raw * 100).toFixed(1)}%`));
  } else if (source === FLOOR_SOURCE) {
    fragment.append(lowerBound(raw));
    if (unit && unit !== 'count') fragment.append(text(` ${unit}`));
  } else {
    fragment.append(el('span', 'num', groupInt(raw)));
    if (unit && unit !== 'count') fragment.append(text(` ${unit}`));
  }

  if (source && INFERRED_SOURCES.has(source)) fragment.append(inferredTag(source));
  return fragment;
}

/** True when this value is a share the floor-window rule forbids showing. */
function isSuppressedShare(value) {
  const unit = typeof value?.unit === 'string' ? value.unit : null;
  return (unit === 'fraction' || unit === 'ratio') && value?.windowSource === FLOOR_SOURCE;
}

/**
 * Why a share is missing, in VISIBLE text.  The same sentence is on the value's
 * tooltip, but a tooltip does not exist on a touch device and does not appear in
 * a screenshot, so a suppressed percentage has to explain itself on the page.
 */
const FLOOR_SHARE_NOTE =
  'No share of the window is shown for this session: its window is only a lower bound — the largest context actually '
  + 'seen — so dividing by it yields 1.0 by construction. That is an artifact of having no upper bound, not a '
  + 'measurement.';

/**
 * The evidence numbers behind one verdict, as `.verdict-values` plus any note.
 *
 * @param {Array<object>} values the rule's `evidence.values`
 * @param {{withNote?: boolean}} [options] `withNote: false` when the caller
 *   renders `FLOOR_SHARE_NOTE` itself.  `verdictNode` does: the note explains a
 *   missing percentage, which is an honesty line, and an honesty line may not be
 *   the thing hidden behind a disclosure.
 * @returns {DocumentFragment|null}
 */
export function evidenceValuesNode(values, { withNote = true } = {}) {
  const rows = Array.isArray(values) ? values : [];
  if (!rows.length) return null;
  const fragment = document.createDocumentFragment();
  const list = el('ul', 'verdict-values');
  for (const row of rows) {
    const item = el('li');
    item.append(text(`${typeof row?.label === 'string' ? row.label : 'value'}: `));
    item.append(evidenceValueNode(row));
    list.append(item);
  }
  fragment.append(list);
  if (withNote && rows.some(isSuppressedShare)) fragment.append(el('p', 'note', FLOOR_SHARE_NOTE));
  return fragment;
}

/**
 * Fill a rule's plain-language template with its OWN measured number.
 *
 * `rule.plain.problem` (declared in `src/analyzer/rules.js`, beside `name` and
 * `threshold` — one catalogue, BP-005.19-style) may carry `{count}` or `{pct}`
 * exactly once. Both are filled from `rule.magnitude` — the same "how bad"
 * number the analyzer ranks sessions by for this rule — never from a number
 * this page invents. A magnitude that is not a finite number renders as an em
 * dash, the same rule this page follows everywhere else: absence is never 0.
 *
 * @param {string|null|undefined} template
 * @param {number|null|undefined} magnitude
 * @returns {string|null}
 */
export function fillPlainTemplate(template, magnitude) {
  if (typeof template !== 'string' || !template.length) return null;
  const finite = typeof magnitude === 'number' && Number.isFinite(magnitude);
  const count = finite ? groupInt(Math.round(magnitude)) : '—';
  const pct = finite ? `${(magnitude * 100).toFixed(1)}%` : '—';
  return template.replace(/\{count\}/g, count).replace(/\{pct\}/g, pct);
}

/**
 * The plain-English problem sentence for an OBSERVED finding, leading the
 * row per the product brief: the rule's name, id and raw metric stay on the
 * summary line below this, this is what a reader sees FIRST.
 *
 * Renders nothing when the rule carries no `plain.problem` — including every
 * fixture in `tests/frontend-contract.test.js`, none of which declares one —
 * so a rule result with no catalogue entry degrades to exactly today's
 * behaviour rather than to a blank or a thrown error.
 *
 * @param {object} rule a `RuleResult`
 * @returns {HTMLElement|null}
 */
export function plainProblemNode(rule) {
  const problem = fillPlainTemplate(rule?.plain?.problem, rule?.magnitude);
  if (!problem) return null;
  const node = el('p', 'verdict-plain');
  node.append(text(problem));
  const why = typeof rule?.plain?.why === 'string' && rule.plain.why.length ? rule.plain.why : null;
  if (why) node.append(text(' '), el('span', 'verdict-plain-why', why));
  return node;
}

/**
 * The plain-English sentence for a check that COULD NOT BE MEASURED, as a
 * STRING.  This is the ONE lookup: everything that needs the sentence goes
 * through here — `plainUnmeasuredNode` for the lead paragraph on the card face,
 * `subagentTurnsNode` for a tooltip.  A second copy of this lookup is how F-021
 * happened, so there is not one.
 *
 * `plain.unmeasured` (declared on the rule in `src/analyzer/rules.js`) is a MAP
 * from reason class to sentence, because one rule goes unmeasured for several
 * different causes and a single sentence would be false for the others. The
 * class is `evidence.reasonCode`, which the analyzer emits beside the prose
 * `evidence.reason`; an unrecognised or absent class falls back to `default`,
 * so a cause added later still reads as English rather than as nothing.
 *
 * @param {object} rule a `RuleResult`
 * @returns {string|null} null when the rule declares no `plain.unmeasured` at all
 */
export function plainUnmeasuredSentence(rule) {
  const catalogue = rule?.plain?.unmeasured;
  if (!catalogue || typeof catalogue !== 'object') return null;
  const code = typeof rule?.evidence?.reasonCode === 'string' ? rule.evidence.reasonCode : 'default';
  const template = typeof catalogue[code] === 'string' ? catalogue[code] : catalogue.default;
  return fillPlainTemplate(template, rule?.magnitude);
}

/**
 * The plain-English unmeasured sentence as the card's lead paragraph.
 *
 * Renders nothing when the rule carries no `plain.unmeasured` at all — the same
 * silent degradation as `plainProblemNode`, and the reason the verbatim
 * engineering text stays on the card face in that case.
 *
 * @param {object} rule a `RuleResult`
 * @returns {HTMLElement|null}
 */
export function plainUnmeasuredNode(rule) {
  const sentence = plainUnmeasuredSentence(rule);
  if (!sentence) return null;
  const node = el('p', 'verdict-plain');
  node.append(text(sentence));
  return node;
}

/**
 * Pull one labelled evidence number out of a rule result, or `null`.  Used by
 * the sessions table, whose columns are evidence the analyzer already computed.
 *
 * @param {object|undefined} rule a `RuleResult`
 * @param {string} label the exact `values[].label`
 * @returns {{label: string, value: unknown, unit?: string, windowSource?: string}|null}
 */
export function evidenceValueByLabel(rule, label) {
  if (rule?.evidence?.status === 'unknown') return null;
  const values = Array.isArray(rule?.evidence?.values) ? rule.evidence.values : [];
  return values.find((row) => row?.label === label) ?? null;
}

/** The rule result with this id, or `undefined`. */
export function ruleById(session, id) {
  const rules = Array.isArray(session?.rules) ? session.rules : [];
  return rules.find((rule) => rule?.id === id);
}

/**
 * The sub-agent turn count, or an honest absence.
 *
 * `subagentTurns` counts turns whose `isSidechain` is exactly `true`.  For a CLI
 * that publishes no sidechain marker at all, every turn is `null` and the count
 * comes out 0 — which on the page would read "this session dispatched no
 * sub-agents" when what actually happened is that nobody could tell (DIS-004).
 * The `subagent-concurrency` rule has already decided which of the two it is,
 * so its verdict is what gates the number: an `unknown` rule means the count is
 * not a measurement and is not shown as one.
 *
 * @param {object} session an analyzed session
 * @returns {Node}
 */
export function subagentTurnsNode(session) {
  const rule = ruleById(session, 'subagent-concurrency');
  if (rule?.evidence?.status === 'unknown') {
    // NEVER `evidence.reason` here.  That string is the engineering evidence of
    // record and belongs in the collapsed evidence fold, where it still is; this
    // span's `title` and `aria-label` are read by an ordinary user hovering a
    // dash and by a screen reader, neither of whom opened the fold.
    return notMeasured(
      plainUnmeasuredSentence(rule)
        || "this tool's logs don't identify sub-agents, so the count is unknown — not zero",
    );
  }
  const count = Number.isFinite(session?.subagentTurns) ? session.subagentTurns : null;
  return count === null ? notMeasured('no sub-agent turn count was recorded') : text(groupInt(count));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * The session's context window with its provenance attached.
 *
 * @param {{tokens: number|null, source: string}|undefined} window
 * @returns {DocumentFragment}
 */
export function windowValueNode(window) {
  const fragment = document.createDocumentFragment();
  const source = typeof window?.source === 'string' ? window.source : 'unknown';
  const tokens = Number.isFinite(window?.tokens) ? window.tokens : null;

  if (tokens === null) {
    fragment.append(notMeasured(WINDOW_SOURCE.unknown));
    return fragment;
  }
  if (source === FLOOR_SOURCE) fragment.append(lowerBound(tokens));
  else fragment.append(el('span', 'num', groupInt(tokens)));
  fragment.append(text(' tokens'));
  if (INFERRED_SOURCES.has(source)) fragment.append(inferredTag(source));
  return fragment;
}

/** BP-002.17: a stale `MODEL_WINDOWS` entry stays visible instead of silently fixed. */
function promotionCallout(promotion) {
  if (!promotion) return null;
  const table = Number.isFinite(promotion?.tableTokens) ? groupInt(promotion.tableTokens) : 'an unrecorded number of';
  const used = Number.isFinite(promotion?.tokens) ? groupInt(promotion.tokens) : 'an unrecorded number of';
  const detail =
    `The model table says ${table} tokens for ${promotion?.modelId ?? 'this model'}; this session held more, ` +
    `so ${used} tokens was used as the window instead.` +
    (promotion?.ladder === 'none'
      ? ' No known model size fits, so that number is only the peak this session was seen holding, and no context share is derived from it.'
      : ` That is a known ${promotion?.ladder ?? 'vendor'} tier, so shares derived from it are permitted.`);
  return callout('unknown', 'Window inferred, not read', 'The model-id table is stale for this session.', detail);
}

// ---------------------------------------------------------------------------
// Verdict rows
// ---------------------------------------------------------------------------

/** Preview / Apply / Skip for one finding. */
function verdictActions(session, rule, api, rerender) {
  const key = `${session?.sessionId ?? ''}::${rule?.id ?? ''}`;
  const wrap = el('div', 'verdict-actions');

  if (skipped.has(key)) {
    wrap.append(el('span', 'badge badge-unknown badge-sm', 'skipped for now'));
    const undo = el('button', 'button button-quiet button-sm', 'Un-skip');
    undo.type = 'button';
    undo.addEventListener('click', () => { skipped.delete(key); rerender(); });
    wrap.append(undo);
    return wrap;
  }

  /**
   * The modal is wave 5C's (BP-001.28): it owns preview, confirm, apply, undo
   * and the CSRF-carrying POSTs.  This page only names the fix, the finding it
   * came from, and the mode to open in.
   *
   * @param {'preview'|'apply'} mode
   */
  const open = (mode) => {
    openFixModal({
      mode,
      fixId: rule.fix,
      ruleId: rule.id,
      ruleName: rule.name,
      sessionId: session?.sessionId ?? null,
      cli: session?.cli ?? null,
      api,
      onSettled: rerender,
    });
  };

  const preview = el('button', 'button button-sm', 'Preview');
  preview.type = 'button';
  preview.setAttribute('aria-label', `Preview the fix for ${rule.name}`);
  preview.addEventListener('click', () => open('preview'));

  const apply = el('button', 'button button-primary button-sm', 'Apply');
  apply.type = 'button';
  apply.setAttribute('aria-label', `Apply the fix for ${rule.name}`);
  apply.addEventListener('click', () => open('apply'));

  const skip = el('button', 'button button-quiet button-sm', 'Skip');
  skip.type = 'button';
  skip.setAttribute('aria-label', `Skip the fix for ${rule.name}`);
  skip.addEventListener('click', () => { skipped.add(key); rerender(); });

  wrap.append(preview, apply, skip);
  return wrap;
}

/**
 * The one number that goes on the collapsed line.
 *
 * `evidence.values` already arrives in the analyzer's own order, with the number
 * the rule turns on first, so this takes the first value it can print as a real
 * reading: not null, and not a share the floor-window rule forbids (BP-002.18).
 * When none qualifies the first value is used anyway — it renders "— not
 * measured", which is the honest headline for a rule whose numbers are absent.
 *
 * @param {object} rule a `RuleResult`
 * @returns {object|null}
 */
export function headlineValue(rule) {
  const values = Array.isArray(rule?.evidence?.values) ? rule.evidence.values : [];
  const readable = values.find(
    (row) => typeof row?.value === 'number' && Number.isFinite(row.value) && !isSuppressedShare(row),
  );
  return readable ?? values[0] ?? null;
}

/**
 * The disclosure's label, naming what is actually behind it rather than saying
 * "more". A caret alone would not tell the reader that the threshold's
 * justification and the raw evidence are one keystroke away.
 *
 * @param {object} rule
 * @returns {{text: string, title: string}}
 */
export function disclosureLabel(rule) {
  const why = typeof rule?.threshold?.derivation === 'string' && rule.threshold.derivation.length > 0;
  const evidence =
    (Array.isArray(rule?.evidence?.values) && rule.evidence.values.length > 0)
    || (typeof rule?.evidence?.derivation === 'string' && rule.evidence.derivation.length > 0)
    || (Array.isArray(rule?.evidence?.sources) && rule.evidence.sources.length > 0);
  // Short enough to stay on the verdict's own line: a label that wraps costs a
  // whole row per rule, which is the height this wave exists to give back.
  if (why && evidence) return { text: 'why · evidence', title: 'why this threshold, and the evidence behind it' };
  if (why) return { text: 'why', title: 'why this threshold' };
  if (evidence) return { text: 'evidence', title: 'the evidence behind this verdict' };
  return { text: 'details', title: 'what this rule recorded' };
}

/**
 * The collapsed line: name, its headline number, the rule id, the verdict word,
 * and the disclosure label.  It is a `<summary>`, so it is the click target and
 * the keyboard target for the detail below it and costs no extra row.
 *
 * It carries NO button: the fix actions are siblings of the `<details>`, not
 * children of its summary, because a click on Apply must apply the fix rather
 * than toggle a disclosure.
 *
 * @param {object} rule a `RuleResult`
 * @param {{word: string, glyph: string, badge: string}} meta the STATUS entry
 * @param {boolean} critical
 * @returns {HTMLElement}
 */
export function verdictSummary(rule, meta, critical) {
  const line = el('summary', 'verdict-line');
  line.append(el('span', 'verdict-name', rule?.name ?? rule?.id ?? 'rule'));

  const head = headlineValue(rule);
  if (head) {
    const metric = el('span', 'verdict-metric');
    metric.append(text(`${typeof head.label === 'string' ? head.label : 'value'}: `));
    metric.append(evidenceValueNode(head));
    line.append(metric);
  }

  line.append(el('span', 'verdict-rule', `${rule?.id ?? 'unknown-rule'} · ${rule?.severity ?? 'warn'}`));

  const badge = el('span', `badge badge-sm ${critical ? 'badge-critical' : meta.badge}`);
  badge.append(el('span', 'badge-glyph', meta.glyph), text(meta.word));
  badge.setAttribute('aria-label', `${rule?.name ?? 'rule'}: ${meta.word.toLowerCase()}`);
  line.append(badge);

  const disclosure = disclosureLabel(rule);
  const toggle = el('span', 'verdict-toggle', disclosure.text);
  toggle.setAttribute('title', disclosure.title);
  line.append(toggle);
  return line;
}

/**
 * The analyzer's own words for why a check could not run.
 *
 * An unknown with no recorded reason is itself an unmeasured thing and says so,
 * rather than rendering as an empty paragraph that reads like nothing was wrong.
 *
 * @param {object} rule a `RuleResult`
 * @returns {string}
 */
function unknownReasonText(rule) {
  return rule?.evidence?.reason || 'the analyzer recorded no reason, which is itself unmeasured.';
}

/**
 * One rule verdict as a `.verdict` row — one line, expandable.
 *
 * WHAT IS BEHIND THE DISCLOSURE: the threshold and its derivation, every
 * evidence number, the computation note, and the evidence citation.  They are
 * the best justification this product has and are kept in full; what changed in
 * wave 5E is only that they are no longer the default state (F-024).
 *
 * WHAT IS NOT, EVER: an `unknown`'s row class, glyph, badge, the sentence that
 * it is not a pass, and the plain-English statement of what could not be worked
 * out and why; the note explaining a suppressed percentage; and the fix offer.
 * An unknown is offered no fix, because there is no finding to fix and offering
 * one would imply one was found.
 *
 * The verbatim `evidence.reason` — written for whoever has to fix the gap, not
 * for the person reading the screen — moves behind the disclosure ONCE a plain
 * sentence has taken its place on the card face.  It is never dropped, and it
 * stays on the face for a rule that has no plain sentence for its cause: an
 * unknown with no stated cause at all would be a worse failure than a
 * jargon-heavy one.
 *
 * @param {object} session the analyzed session
 * @param {object} rule a `RuleResult`
 * @param {object|null} [api] the app fetch wrapper, for the fix modal
 * @param {Function|null} [rerender] re-render callback for Skip / Un-skip
 * @returns {HTMLLIElement}
 */
export function verdictNode(session, rule, api = null, rerender = null) {
  const status = STATUS[rule?.evidence?.status] ? rule.evidence.status : 'unknown';
  const meta = STATUS[status];
  const critical = status === 'observed' && rule?.severity === 'critical';

  const row = el('li', `verdict ${critical ? 'verdict-critical' : meta.row}`);
  row.dataset.status = status;
  row.dataset.severity = rule?.severity ?? 'warn';
  row.dataset.ruleId = rule?.id ?? '';

  const mark = el('span', 'verdict-mark', meta.glyph);
  mark.setAttribute('aria-hidden', 'true');
  row.append(mark);

  const body = el('div', 'verdict-body');

  // Leads the row, per the product brief: plain English first, the rule's
  // own name/id/raw-metric technical line (below, in the summary) second.
  // An unknown leads the same way — with what could not be worked out and why,
  // never with the engineering prose a reader cannot parse.
  let unmeasuredPlain = null;
  if (status === 'observed') {
    const plain = plainProblemNode(rule);
    if (plain) body.append(plain);
  } else if (status === 'unknown') {
    unmeasuredPlain = plainUnmeasuredNode(rule);
    if (unmeasuredPlain) body.append(unmeasuredPlain);
  }

  const details = el('details', 'verdict-why');
  details.append(verdictSummary(rule, meta, critical));

  const more = el('div', 'verdict-more');
  // The engineering reason, in full and unedited, first behind the disclosure —
  // it is the most specific thing this rule recorded about why it could not
  // run. It is only here when a plain sentence is leading the row in its place.
  if (unmeasuredPlain) more.append(el('p', 'verdict-detail', unknownReasonText(rule)));
  const threshold = el('p', 'verdict-detail');
  threshold.append(text(`Threshold ${String(rule?.threshold?.value ?? 'not recorded')}`));
  if (rule?.threshold?.derivation) threshold.append(text(` — ${rule.threshold.derivation}`));
  more.append(threshold);

  const values = Array.isArray(rule?.evidence?.values) ? rule.evidence.values : [];
  // `withNote: false`: the floor note belongs in the visible area, below.
  const valuesNode = evidenceValuesNode(values, { withNote: false });
  if (valuesNode) more.append(valuesNode);
  if (rule?.evidence?.derivation) more.append(el('p', 'verdict-detail', rule.evidence.derivation));
  const sources = Array.isArray(rule?.evidence?.sources) ? rule.evidence.sources : [];
  if (sources.length) more.append(el('p', 'verdict-detail', `Evidence: ${sources.join(' · ')}`));
  details.append(more);
  body.append(details);

  if (status === 'unknown') {
    // The line the whole product turns on. Plain text, not a tooltip, and not
    // behind the disclosure — a reader must see this without clicking.
    const reason = el('p', 'verdict-reason');
    reason.append(el('strong', null, 'Not measured. This is NOT a pass — the check could not run here. '));
    if (!unmeasuredPlain) reason.append(text(unknownReasonText(rule)));
    body.append(reason);
  }

  // Why a percentage is missing, in visible text (BP-002.18).
  if (values.some(isSuppressedShare)) body.append(el('p', 'note verdict-floor-note', FLOOR_SHARE_NOTE));

  if (status === 'observed' && rule?.fix && api && rerender) {
    const offer = el('div', 'verdict-offer');
    offer.append(el('span', 'verdict-arrow', '→'));
    offer.append(el('span', 'verdict-fix', fixTitle(rule)));
    const scopeNote = fixCliNote(session, rule);
    if (scopeNote) offer.append(el('span', 'verdict-fix-scope', scopeNote));
    offer.append(verdictActions(session, rule, api, rerender));
    body.append(offer);
  }

  row.append(body);
  return row;
}

/**
 * Every rule verdict for one session, in the analyzer's own order: problems
 * first, then unmeasurable, then passing.  Every rule appears — a rule omitted
 * from the list is as invisible as a rule reported as a pass.
 *
 * @returns {HTMLElement}
 */
export function verdictList(session, api = null, rerender = null) {
  const rules = Array.isArray(session?.rules) ? session.rules : [];
  if (!rules.length) {
    return el(
      'p',
      'empty-state',
      'No rule was evaluated for this session. That is an absence of evidence, not a clean session.',
    );
  }
  const list = el('ul', 'verdict-list');
  for (const rule of rules) list.append(verdictNode(session, rule, api, rerender));
  return list;
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * The score block: a three-segment bar, a headline that always names the
 * unknown count, a legend, and — whenever anything was unmeasurable — an
 * explicit callout line.
 *
 * The unknown segment is hatched by wave 5C's CSS, so its area reads as
 * neither filled-and-fine nor as an alarm.
 *
 * @param {{total?: number, passed?: number, observed?: number, unknown?: number, label?: string}|undefined} score
 * @param {Array<object>} rules used only to split observed into warn/critical
 * @returns {HTMLElement}
 */
export function scoreNode(score, rules = []) {
  const total = Number.isFinite(score?.total) ? score.total : 0;
  const passed = Number.isFinite(score?.passed) ? score.passed : 0;
  const observed = Number.isFinite(score?.observed) ? score.observed : 0;
  const unknown = Number.isFinite(score?.unknown) ? score.unknown : Math.max(0, total - passed - observed);
  const critical = (Array.isArray(rules) ? rules : []).filter(
    (rule) => rule?.evidence?.status === 'observed' && rule?.severity === 'critical',
  ).length;
  const warn = Math.max(0, observed - critical);

  const label =
    score?.label
    || `${passed} of ${total} checks passed, ${observed} problem${observed === 1 ? '' : 's'} observed, ${unknown} could not be measured`;

  const wrap = el('div', 'score');

  const bar = el('div', 'score-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', label);
  const pct = (count) => (total > 0 ? `${(count / total) * 100}%` : '0%');
  const segment = (count, kind, title) => {
    if (count <= 0) return;
    const seg = el('span', `score-seg score-seg-${kind}`);
    seg.style.width = pct(count);
    seg.setAttribute('title', title);
    bar.append(seg);
  };
  segment(passed, 'passed', `${passed} measured and clear`);
  segment(critical, 'critical', `${critical} critical problem${critical === 1 ? '' : 's'} observed`);
  segment(warn, 'observed', `${warn} problem${warn === 1 ? '' : 's'} observed`);
  segment(unknown, 'unknown', `${unknown} could not be measured — neither passed nor failed`);
  wrap.append(bar);

  // "N/6 checks passed" NEVER appears without the unknown count beside it.
  const headline = el('div', 'score-headline');
  headline.append(el('strong', null, `${passed}/${total} checks passed`));
  headline.append(text(` · ${observed} problem${observed === 1 ? '' : 's'} observed`));
  headline.append(text(` · ${unknown} could not be measured`));
  wrap.append(headline);

  const legend = el('div', 'score-legend');
  const swatch = (kind, caption) => {
    const item = el('span');
    item.append(el('i', `score-swatch score-swatch-${kind}`), text(caption));
    return item;
  };
  legend.append(swatch('passed', `${passed} passed`));
  if (critical > 0) legend.append(swatch('critical', `${critical} critical`));
  if (warn > 0) legend.append(swatch('observed', `${warn} observed`));
  legend.append(swatch('unknown', `${unknown} unknown`));
  wrap.append(legend);

  if (unknown > 0) {
    wrap.append(
      el(
        'p',
        'score-unknown-callout',
        `${unknown} of ${total} checks could not be measured on this session. Those are not passes — each one says below why it could not run.`,
      ),
    );
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Session card
// ---------------------------------------------------------------------------

/** One `.meta-grid` cell. A `null` value renders `.not-measured`. */
function metaCell(label, value, why) {
  const cell = el('div');
  cell.append(el('span', 'meta-label', label));
  const slot = el('span', 'meta-value');
  if (value === null || value === undefined) slot.append(notMeasured(why));
  else if (typeof value === 'string' || typeof value === 'number') slot.append(text(String(value)));
  else slot.append(value);
  cell.append(slot);
  return cell;
}

/**
 * One session card: `CLI | session id | duration | turns` in the header, the
 * score block, the session's metadata, then every rule verdict.
 *
 * @param {object} session an analyzed session (BP-005.01 `sessions[]`)
 * @param {object} api the app fetch wrapper
 * @param {Function} rerender
 * @returns {HTMLElement}
 */
export function sessionCard(session, api, rerender) {
  const card = el('article', 'card health-card');
  card.dataset.cli = session?.cli ?? 'unknown';
  card.dataset.sessionId = session?.sessionId ?? '';

  const head = el('header', 'card-head');
  const ident = el('div', 'health-ident');
  ident.append(iconBadge('health'));
  ident.append(el('span', 'health-cli', session?.cli ?? 'unknown'));
  ident.append(el('span', 'health-session', session?.sessionId ?? '(no session id)'));
  head.append(ident);

  const duration = durationText(session?.startedAt, session?.endedAt);
  const turns = groupInt(session?.turnCount);
  const meta = el('div', 'health-meta');
  if (duration === null) meta.append(notMeasured('the session start or end was not recorded, so its duration is unknown'));
  else meta.append(text(duration));
  meta.append(el('span', 'health-sep', ' | '));
  if (turns === null) meta.append(notMeasured('no turn count was recorded'));
  else meta.append(text(`${turns} turns`));
  head.append(meta);
  card.append(head);

  const body = el('div', 'card-body');
  body.append(scoreNode(session?.score, session?.rules));

  const grid = el('div', 'meta-grid');
  grid.append(metaCell('project', session?.project ?? null, 'the collector recorded no project for this session'));
  grid.append(metaCell('model', session?.model ?? null, 'no model id was recorded'));
  grid.append(metaCell('context window', windowValueNode(session?.window)));
  grid.append(metaCell('started', whenText(session?.startedAt), 'no start timestamp was recorded'));
  grid.append(metaCell('sub-agent turns', subagentTurnsNode(session)));
  body.append(grid);

  const promotion = promotionCallout(session?.windowPromotion);
  if (promotion) body.append(promotion);

  body.append(verdictList(session, api, rerender));
  card.append(body);
  return card;
}

// ---------------------------------------------------------------------------
// Detected CLIs (FVA-003)
// ---------------------------------------------------------------------------

/**
 * Supported CLIs with their session counts, and detection-only CLIs named as
 * unsupported rather than shown as quiet.
 *
 * A supported CLI that produced no session in this scan is omitted entirely: a
 * row reading "0 sessions" invites "you did not use it", which is not what was
 * measured.  Unsupported CLIs are omitted too — nothing was read, so there is
 * nothing to report.
 *
 * @param {Array<{cli?: string, sessions?: number|null, support?: string, note?: string|null}>} collectors
 * @returns {HTMLElement}
 */
export function collectorsPanel(collectors) {
  const rows = Array.isArray(collectors) ? collectors : [];
  const panel = el('section', 'card card-pad panel-compact');
  panel.append(el('div', 'section-kicker', 'Sources'));
  const heading = el('div', 'panel-heading');
  const title = el('div', 'rx-section-title tone-accent');
  title.append(iconBadge('health'), el('h2', '', 'Detected CLIs'));
  heading.append(title);
  panel.append(heading);

  const supported = rows.filter(
    (row) => row?.support === 'supported' && Number.isFinite(row?.sessions) && row.sessions > 0,
  );
  const detectionOnly = rows.filter((row) => row?.support === 'detection-only');

  /**
   * A collector's note is a CAVEAT on the count beside it — a collection limit
   * reached, windows inferred, sub-agent transcripts set aside.  Five of them
   * stacked above the cards is most of the first screen, so they fold; but a
   * caveat nobody knows about is a caveat nobody reads, so the fold's summary
   * states how many there are and which CLIs they qualify, and the count chip
   * of a CLI that has one is marked.  Nothing is dropped.
   */
  const notes = supported.filter((row) => typeof row?.note === 'string' && row.note.length > 0);

  const list = el('div', 'cli-list cli-list-inline');
  for (const row of supported) {
    const item = el('div', 'cli-item');
    item.append(el('span', 'cli-name', row.cli ?? 'unknown'));
    const caveat = typeof row?.note === 'string' && row.note.length > 0;
    const count = el(
      'span',
      'cli-status badge badge-sm badge-ok',
      `${groupInt(row.sessions)} session${row.sessions === 1 ? '' : 's'}${caveat ? ' *' : ''}`,
    );
    if (caveat) count.setAttribute('title', row.note);
    item.append(count);
    list.append(item);
  }
  for (const row of detectionOnly) {
    const item = el('div', 'cli-item');
    item.append(el('span', 'cli-name', row.cli ?? 'unknown'));
    const status = el('span', 'cli-status badge badge-sm badge-unknown', 'Detected — support coming soon');
    status.setAttribute('title', row?.note ?? 'this tool is installed, but it keeps no session transcript that can be read, so nothing about its usage is measured here');
    item.append(status);
    list.append(item);
  }
  if (!supported.length && !detectionOnly.length) {
    list.append(el('p', 'empty-state', 'No CLI was detected on this machine, so nothing was read.'));
  }
  panel.append(list);

  if (notes.length) {
    const fold = el('details', 'cli-notes');
    fold.append(
      el(
        'summary',
        null,
        `* ${notes.length} caveat${notes.length === 1 ? '' : 's'} on these counts `
          + `(${notes.map((row) => row.cli ?? 'unknown').join(', ')}) — read before trusting a total`,
      ),
    );
    for (const row of notes) fold.append(el('p', 'note', `${row.cli ?? 'unknown'}: ${row.note}`));
    panel.append(fold);
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Newest first; a session with no start timestamp sorts last, never first. */
function newestFirst(sessions) {
  return [...sessions].sort((a, b) => {
    const left = Date.parse(a?.startedAt ?? '');
    const right = Date.parse(b?.startedAt ?? '');
    const leftOk = Number.isFinite(left);
    const rightOk = Number.isFinite(right);
    if (!leftOk && !rightOk) return 0;
    if (!leftOk) return 1;
    if (!rightOk) return -1;
    return right - left;
  });
}

/**
 * Index into `shown` of the first session carrying an OBSERVED, fixable
 * finding, in the same newest-first order the cards render in — or `-1`
 * when none does.  Drives the summary's "Review fixes" jump: it must point
 * at a card that actually offers `[Preview] [Apply] [Skip]` (BP item 1),
 * never merely the first problem regardless of whether a fix exists for it.
 *
 * @param {Array<object>} shown
 * @returns {number}
 */
export function firstActionableIndex(shown) {
  const sessions = Array.isArray(shown) ? shown : [];
  for (let index = 0; index < sessions.length; index += 1) {
    const rules = Array.isArray(sessions[index]?.rules) ? sessions[index].rules : [];
    if (rules.some((rule) => rule?.evidence?.status === 'observed' && rule?.fix)) return index;
  }
  return -1;
}

/**
 * BRIEF ITEM 1 — the compact summary at the top of the page: four counts a
 * reader can take in before opening a single card, plus one action that
 * jumps straight to the first card with something to fix.
 *
 * Every count is taken over the SAME `shown` sessions the cards below
 * render.  That is deliberate, not a shortcut: `/api/health` sends only the
 * newest `HEALTH_CARD_LIMIT` sessions' rule results at all (BP-005.01), so
 * `shown` is the entire rule evidence this page ever has — counting over
 * anything wider would either be fabricated or require a second request this
 * wave does not add. It also keeps the four numbers here in permanent
 * agreement with the cards printed right below them.
 *
 * "Sessions analyzed" is a real, always-known count — `shown.length` — so it
 * is never an em dash, including when it is honestly 0. The other three
 * depend on rule data existing at all: if not ONE session in `shown` carries
 * a `rules` array, nothing was actually evaluated, and reporting 0 would be
 * exactly the false all-clear this product exists to refuse — so all three
 * render as an em dash together, never as a 0 that never happened.
 *
 * @param {Array<object>} shown the sessions about to be rendered as cards
 * @param {number} actionableIndex from `firstActionableIndex`
 * @returns {HTMLElement}
 */
export function healthSummaryNode(shown, actionableIndex) {
  const sessions = Array.isArray(shown) ? shown : [];
  let sawRules = false;
  let problems = 0;
  let fixable = 0;
  let unmeasured = 0;
  for (const session of sessions) {
    const rules = Array.isArray(session?.rules) ? session.rules : null;
    if (!rules) continue;
    sawRules = true;
    for (const rule of rules) {
      const st = rule?.evidence?.status;
      if (st === 'observed') {
        problems += 1;
        if (rule?.fix) fixable += 1;
      } else if (st === 'unknown') {
        unmeasured += 1;
      }
    }
  }
  const noEvidence = 'no rule result was published for any session shown here, so nothing could be counted — that is an absence of evidence, not a zero';

  const wrap = el('section', 'health-summary');
  const stats = el('div', 'summary-stats');
  const stat = (label, value, why) => {
    const cell = el('div', 'summary-stat');
    const valueNode = el('span', 'summary-stat-value');
    if (value === null) valueNode.append(notMeasured(why));
    else valueNode.append(text(groupInt(value)));
    cell.append(valueNode, el('span', 'summary-stat-label', label));
    return cell;
  };
  stats.append(stat('Sessions analyzed', sessions.length, 'no session fell inside this scan'));
  stats.append(stat('Problems found', sawRules ? problems : null, noEvidence));
  stats.append(stat('Fixes available', sawRules ? fixable : null, noEvidence));
  stats.append(stat('Checks not measured', sawRules ? unmeasured : null, noEvidence));
  wrap.append(stats);

  const action = el('button', 'button button-primary summary-action', 'Review fixes');
  action.type = 'button';
  if (actionableIndex >= 0) {
    action.setAttribute('aria-label', 'Review fixes: jump to the first session with an actionable problem');
    action.addEventListener('click', () => {
      const target = document.getElementById(`health-card-${actionableIndex}`);
      if (!target) return;
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof target.focus === 'function') target.focus();
    });
  } else {
    action.disabled = true;
    action.setAttribute('aria-disabled', 'true');
    action.setAttribute('title', 'no session shown here has an actionable problem to review');
  }
  wrap.append(action);
  return wrap;
}

/** Collector diagnostics, folded away but never dropped (BP-002.08). */
function diagnosticsNode(diagnostics) {
  const rows = Array.isArray(diagnostics) ? diagnostics : [];
  if (!rows.length) return null;
  const details = el('details', 'card card-pad');
  details.append(el('summary', null, `Collector diagnostics (${rows.length})`));
  const list = el('ul', 'file-list');
  for (const row of rows) {
    const item = el('li');
    const note = row?.note ?? row?.message ?? row?.reason ?? null;
    item.textContent = `${row?.cli ?? 'unknown'}: ${note ?? 'no detail recorded'}`;
    list.append(item);
  }
  details.append(list);
  return details;
}

/**
 * Render the health page (BP-001.24).
 *
 * @param {HTMLElement} mount the `#page-health` section
 * @param {object} data the `/api/health` body (BP-005.01)
 * @param {{store?: object, api?: object, navigate?: Function}} [ctx]
 * @returns {void}
 */
export function renderHealth(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api ?? appApi;
  const rerender = () => renderHealth(mount, data, ctx);
  mount.replaceChildren();

  const stack = el('div', 'page-stack');

  // index.html points `aria-labelledby="health-title"` at this heading.
  const title = el('h1', null, 'Session health');
  title.id = 'health-title';
  stack.append(title);

  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const shown = newestFirst(sessions).slice(0, SESSION_LIMIT);
  // The server now sends only the newest-N cards and states the true corpus
  // size separately (`sessionsTotal`), so the count below no longer misreads
  // a narrowed response as the whole corpus. An older payload carries no
  // such field, so `sessions.length` — the whole old-shaped array — is the
  // fallback, not 0.
  const sessionsTotal = Number.isFinite(data?.sessionsTotal) ? data.sessionsTotal : sessions.length;

  // BRIEF ITEM 1: before any card, so a reader knows whether there is
  // anything to act on before opening one.
  stack.append(healthSummaryNode(shown, firstActionableIndex(shown)));

  stack.append(
    el(
      'p',
      'note',
      `The ${shown.length} most recent session${shown.length === 1 ? '' : 's'} of ${groupInt(sessionsTotal) ?? '0'} read from this machine. `
        + 'Every check returns one of three verdicts: a problem was observed, nothing was observed, or it could not be measured. '
        + 'The third is not a pass, and it is the most common answer on real data.',
    ),
  );
  if (data?.scan?.note) stack.append(el('p', 'note', `Scan: ${data.scan.note}`));

  stack.append(collectorsPanel(data?.collectors));

  if (!shown.length) {
    stack.append(
      callout(
        'unknown',
        'Nothing read',
        'No session fell inside this scan, so there is nothing to diagnose. An empty read is not a clean bill of health.',
      ),
    );
    mount.append(stack);
    return;
  }

  // Indexed so the summary's "Review fixes" button (`firstActionableIndex`)
  // has a stable element to jump to.
  shown.forEach((session, index) => {
    const card = sessionCard(session, api, rerender);
    card.id = `health-card-${index}`;
    stack.append(card);
  });

  const diagnostics = diagnosticsNode(data?.diagnostics);
  if (diagnostics) stack.append(diagnostics);

  mount.append(stack);
}

registerPage('health', renderHealth);

export default renderHealth;

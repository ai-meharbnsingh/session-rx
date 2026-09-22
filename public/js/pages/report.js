/**
 * BP-001.27 — Report page: generate the Markdown diagnostic, preview it,
 * download it as `.md`, copy it to the clipboard.
 *
 * WHY THE PREVIEW IS THE MARKDOWN SOURCE, NOT RENDERED HTML
 * --------------------------------------------------------
 * The report is built from session content read off local disk — file paths,
 * project names, model ids, tool names, rule derivations.  Rendering it as HTML
 * would mean either `innerHTML` over that content (an XSS on an origin that can
 * POST `/api/fixes/:id/apply`) or a Markdown parser, which is a new dependency
 * this package does not take.  So the preview shows the exact bytes that the
 * download and the clipboard will contain, in a monospace block whose content
 * is set with `textContent`.  What you read is what you get, and nothing in the
 * report can execute.
 *
 * The generator redacts secrets before the text ever reaches this page
 * (FVA-004, BP-005.15); the redaction COUNT is displayed, because a silent
 * redaction is indistinguishable from nothing having been there.
 *
 * SECURITY: no `innerHTML` in this file.
 *
 * @module public/js/pages/report
 */

import { rangeQuery, registerPage, api as appApi } from '../app.js';
import { icon } from '../components/ui.js';

function iconBadge(name) {
  const badge = el('span', 'rx-icon');
  badge.append(icon(name));
  return badge;
}

function sectionTitle(title, iconName, tone = 'accent') {
  const node = el('div', `rx-section-title tone-${tone}`);
  node.append(iconBadge(iconName), el('h2', '', title));
  return node;
}

/** The last report fetched on this page, so a tab switch does not lose it. */
const state = {
  mount: null,
  ctx: {},
  report: null,
  error: null,
  busy: false,
  copied: null,
};

// ---------------------------------------------------------------------------
// DOM helpers — the only path text takes into the document
// ---------------------------------------------------------------------------

/** Build an element. `textContent` is assigned, never parsed as HTML. */
function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

function text(value) {
  return document.createTextNode(value === undefined || value === null ? '' : String(value));
}

function groupInt(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : null;
}

function notMeasured(why = 'this value was not recorded') {
  const node = el('span', 'not-measured');
  node.append(el('span', 'dash', '—'), text(' not recorded'));
  node.setAttribute('title', why);
  node.setAttribute('aria-label', `not recorded: ${why}`);
  return node;
}

function callout(kind, title, body, detail) {
  const box = el('div', `callout callout-${kind}`);
  if (title) box.append(el('p', 'callout-title', title));
  if (body) box.append(el('p', null, body));
  if (detail) box.append(el('p', 'callout-detail', detail));
  return box;
}

/** `session-rx-report-YYYY-MM-DDTHH-MM-SS.md`, or a date-free name if unknown. */
function filenameFor(report) {
  const stamp = typeof report?.generatedAt === 'string' ? report.generatedAt : null;
  const ms = Date.parse(stamp ?? '');
  if (!Number.isFinite(ms)) return 'session-rx-report.md';
  return `session-rx-report-${new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')}.md`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Fetch a fresh report. Goes through app.js's wrapper, so errors arrive as messages. */
async function generate(api) {
  state.busy = true;
  state.error = null;
  state.copied = null;
  draw();
  try {
    const body = await api.get(`/api/report${rangeQuery('/api/report')}`);
    state.report = body;
    // Keep the router's cache in step, so navigating away and back shows the
    // report just generated rather than the one it fetched on first load.
    if (state.ctx?.store?.data) state.ctx.store.data.report = body;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    draw();
  }
}

/**
 * Save the markdown as a file.  A blob URL is used rather than a `data:` URL so
 * the report never passes through a URL-encoded string, and it is revoked in the
 * same task once the click has been dispatched.
 */
function download(markdown, filename) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Copy to the clipboard, and say plainly when the browser refused. */
async function copy(markdown) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('this browser exposes no clipboard API to the page');
    await navigator.clipboard.writeText(markdown);
    state.copied = true;
  } catch (error) {
    state.copied = false;
    state.error = `Copy failed: ${error instanceof Error ? error.message : String(error)}. The report text below is selectable — select it and copy manually, or use Download .md.`;
  }
  draw();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Generated-at, redaction count and scan bounds, as a `.modal-facts` grid. */
function factsNode(report) {
  const facts = el('div', 'modal-facts');
  const fact = (label, value, why) => {
    const wrap = el('div');
    wrap.append(el('span', 'meta-label', label));
    const slot = el('span', 'meta-value');
    if (value === null || value === undefined) slot.append(notMeasured(why));
    else slot.append(text(String(value)));
    wrap.append(slot);
    return wrap;
  };
  const ms = Date.parse(report?.generatedAt ?? '');
  facts.append(
    fact(
      'generated',
      Number.isFinite(ms) ? new Date(ms).toLocaleString() : null,
      'the generator was called without a timestamp, so the document records none',
    ),
  );
  facts.append(
    fact(
      'secrets redacted',
      Number.isFinite(report?.redactions) ? groupInt(report.redactions) : null,
      'the generator did not report a redaction count',
    ),
  );
  const markdown = typeof report?.markdown === 'string' ? report.markdown : '';
  facts.append(fact('length', `${groupInt(markdown.split('\n').length)} lines · ${groupInt(markdown.length)} characters`));
  return facts;
}

function draw() {
  const mount = state.mount;
  if (!mount) return;
  const api = state.ctx?.api ?? appApi;
  const report = state.report;
  const markdown = typeof report?.markdown === 'string' ? report.markdown : null;

  mount.replaceChildren();
  const stack = el('div', 'page-stack');
  const title = el('h1', null, 'Report');
  title.id = 'report-title';
  stack.append(title);

  stack.append(
    el(
      'p',
      'note',
      'The report is plain Markdown, generated on this machine from the sessions in the current scan. '
        + 'The preview below is the exact text that Download and Copy produce — it is shown as source rather than rendered, '
        + 'so nothing read off disk is ever interpreted as markup.',
    ),
  );

  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(sectionTitle('Report', 'health'));
  const bar = el('div', 'toolbar');

  const button = el('button', 'button button-primary');
  button.type = 'button';
  if (state.busy) {
    button.append(el('span', 'spinner'), text('Generating…'));
    button.disabled = true;
  } else {
    button.append(text(markdown === null ? 'Generate Report' : 'Regenerate Report'));
  }
  button.addEventListener('click', () => { generate(api); });
  bar.append(button);

  const downloadButton = el('button', 'button', 'Download .md');
  downloadButton.type = 'button';
  downloadButton.disabled = markdown === null || state.busy;
  downloadButton.addEventListener('click', () => { download(markdown ?? '', filenameFor(report)); });
  bar.append(downloadButton);

  const copyButton = el('button', 'button', state.copied === true ? 'Copied' : 'Copy to clipboard');
  copyButton.type = 'button';
  copyButton.disabled = markdown === null || state.busy;
  copyButton.addEventListener('click', () => { copy(markdown ?? ''); });
  bar.append(copyButton);

  bar.append(el('span', 'toolbar-spacer'));
  if (markdown !== null) bar.append(el('span', 'chart-sub', filenameFor(report)));
  head.append(bar);
  card.append(head);

  const body = el('div', 'card-body');

  if (state.error) {
    body.append(callout('error', 'Something failed', state.error));
  }

  if (markdown === null) {
    body.append(
      callout(
        'unknown',
        'No report yet',
        'Press Generate Report to build one from the current scan. Nothing is sent anywhere: the document is assembled locally and stays on this machine until you save it.',
      ),
    );
  } else {
    body.append(factsNode(report));
    if (report?.scan?.note) body.append(el('p', 'note', `Scan: ${report.scan.note}`));
    if (Number.isFinite(report?.redactions) && report.redactions > 0) {
      body.append(
        callout(
          'info',
          'Redacted before display',
          `${groupInt(report.redactions)} secret-shaped value${report.redactions === 1 ? ' was' : 's were'} replaced before this text reached the page, and before it reached the download. The count is shown because a silent redaction looks the same as nothing having been there.`,
        ),
      );
    }
    const caption = el('div', 'diff-caption');
    caption.append(el('span', null, 'Markdown source'));
    caption.append(el('span', null, 'exactly what Download .md and Copy produce'));
    body.append(caption);
    if (markdown.length === 0) {
      body.append(el('div', 'diff-empty', 'The generator returned an empty document.'));
    } else {
      // textContent, so a `<script>` inside a project path is text, not markup.
      const pre = el('pre', 'diff');
      pre.textContent = markdown;
      pre.setAttribute('tabindex', '0');
      pre.setAttribute('aria-label', 'Markdown report source');
      body.append(pre);
    }
  }

  card.append(body);
  stack.append(card);
  mount.append(stack);
}

/**
 * Render the report page (BP-001.27).
 *
 * The router pre-fetches `/api/report` on first navigation, so an already
 * fetched document is shown straight away; the button regenerates it.
 *
 * @param {HTMLElement} mount the `#page-report` section
 * @param {object|null} data the `/api/report` body (BP-005.05), if already fetched
 * @param {{store?: object, api?: object, navigate?: Function}} [ctx]
 * @returns {void}
 */
export function renderReport(mount, data, ctx = {}) {
  if (!mount) return;
  state.mount = mount;
  state.ctx = ctx;
  if (typeof data?.markdown === 'string') state.report = data;
  draw();
}

registerPage('report', renderReport);

export default renderReport;

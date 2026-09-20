/**
 * BP-001.28 — Preview / Apply / Skip / Undo for one fix (BP-004, BP-005.06..09).
 *
 * WHY EACH RULE HERE IS A RULE
 * ----------------------------
 * 1. THE DIFF IS SHOWN VERBATIM. `preview().diff` is generated from the exact
 *    bytes `apply()` will write (BP-004.06), so it is the user's only chance to
 *    see the change before it lands in their config. Lines are wrapped in spans
 *    to colour them, and `renderDiff` then ASSERTS that the rendered element's
 *    textContent is character-identical to the diff it was given, falling back
 *    to one raw text node if it is not. Nothing is re-indented, re-wrapped,
 *    trimmed, truncated or prettified.
 *
 * 2. `check()` RUNS FIRST, AND BEFORE preview(). The engine's `preview()` throws
 *    ALREADY_APPLIED for a fix already present (R_4A §2), so previewing an
 *    applied fix would surface a red error for a healthy state. An applied fix
 *    is reported as applied and offered Undo, never Apply.
 *
 * 3. FAILURES ARE SHOWN, NOT SUMMARISED. The engine fails closed with coded,
 *    specific messages — TARGET_IS_SYMLINK (a CLAUDE.md symlinked into a
 *    dotfiles repo, which an atomic rename would replace with a regular file)
 *    and EXTERNAL_EDIT (the file changed since apply, so undo refuses rather
 *    than destroying the user's later edit). Those messages name the real path
 *    and the hashes. They are rendered verbatim; "Something went wrong" would
 *    throw away the only actionable part.
 *
 * 4. NO innerHTML. Every string rendered here — diffs of the user's own config,
 *    file paths, engine messages — reaches the DOM through textContent. This
 *    origin can POST /api/fixes/:id/apply, so script injected here would write
 *    to the user's home directory: an XSS on this page is privilege escalation,
 *    not a cosmetic defect.
 *
 * 5. MUTATIONS GO THROUGH app.js's `api.post`, which attaches the startup
 *    X-CSRF-Token (BP-005.13). This module never calls `fetch` itself.
 *
 * 6. LIMITATIONS ARE STATED, NOT BURIED. Every writable fix here is one thing:
 *    an instruction appended or merged into a config file the AGENT reads.
 *    That is guidance, not an enforced constraint — writing it does not prove
 *    the agent's behaviour changes, and nothing here checks compliance after
 *    the fact. The "Limitations" callout says this plainly, before the diff,
 *    on both Preview and Applied, because overselling a fix that might do
 *    nothing is worse than not fixing it. Alongside it: an explicit
 *    "expected effect" (the engine's `rationale` — why this section exists —
 *    read from `preview()`/`GET /api/fixes` and rendered honestly absent when
 *    neither has one), and a call-out when a target does not exist yet
 *    (`targets[].created`, or the `--- /dev/null` convention in the raw diff
 *    text as a fallback) so a newly-created file is never a surprise.
 */

import { api as appApi } from "../app.js";

const MODAL_ROOT_ID = "modal-root";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const str = (value) => (typeof value === "string" ? value : "");

/**
 * Engine error codes recognised from the message text.
 *
 * LIMIT, STATED: the server DOES return `code` in the error body
 * (src/server.js sendFixError), but app.js's fetch wrapper throws
 * `new Error(body.error)` and keeps only the message, so a code is not
 * available on the thrown Error today. `error.code` is read first so this
 * becomes exact the moment app.js forwards it; the text match below is the
 * fallback and is used ONLY to attach extra explanation. The engine's own
 * message is always rendered verbatim either way, so a missed match loses the
 * explainer, never the error.
 */
const CODE_SIGNATURES = [
  [/\bis a symlink\b/i, "TARGET_IS_SYMLINK"],
  [/changed after the fix was applied|changed while the fix was being prepared/i, "EXTERNAL_EDIT"],
  [/already carries .*but it was changed|refusing to touch the file/i, "MARKER_DRIFT"],
  [/already carries|already has/i, "ALREADY_APPLIED"],
  [/does not exist\b/i, "TARGET_MISSING"],
  [/is not valid JSON|could not be parsed/i, "TARGET_UNPARSEABLE"],
  [/not writable|permission denied/i, "TARGET_UNWRITABLE"],
];

const CODE_GUIDANCE = {
  TARGET_IS_SYMLINK:
    "SessionRx writes by renaming a temporary file over the target, and a rename "
    + "replaces a symlink with a regular file — so a CLAUDE.md symlinked into a "
    + "dotfiles repo would silently stop being a link. Nothing was written. Point "
    + "the fix at the real file named above, or add the section by hand.",
  EXTERNAL_EDIT:
    "The file no longer matches what was recorded, so the change was refused "
    + "instead of overwriting whatever was edited since. Nothing was written. "
    + "The message above names the backup if you want to merge by hand.",
  MARKER_DRIFT:
    "The section this fix manages is present but has been edited, so SessionRx "
    + "will not rewrite it. Nothing was written.",
  ALREADY_APPLIED:
    "This fix is already in place. Applying it again would duplicate the section.",
  TARGET_MISSING:
    "The file this fix edits does not exist. SessionRx never creates it, because "
    + "guessing a config file into existence is not a fix.",
  TARGET_UNPARSEABLE:
    "The target could not be parsed, so no merge was attempted and nothing was written.",
  TARGET_UNWRITABLE:
    "The target is not writable by this process. Nothing was written.",
};

function classifyError(error) {
  const direct = str(error?.code);
  if (direct) return direct;
  const message = str(error?.message);
  for (const [pattern, code] of CODE_SIGNATURES) {
    if (pattern.test(message)) return code;
  }
  return "";
}

// ------------------------------------------------------------------- diff

function diffLineClass(line) {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "ins";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "ctx";
}

/**
 * Render the diff exactly as received.
 *
 * Colour is added by WRAPPING lines, never by rewriting them: the spans are
 * joined by literal "\n" text nodes, so the element's textContent reassembles
 * the input character for character. That identity is then checked, and a
 * mismatch falls back to a single raw text node — the bytes win over the
 * colouring, always.
 */
export function renderDiff(diff) {
  const pre = el("pre", "diff");
  pre.setAttribute("tabindex", "0");
  const text = typeof diff === "string" ? diff : "";
  if (!text) {
    pre.append(el("span", "diff-empty", "The API returned no diff for this fix."));
    return pre;
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    pre.append(el("span", `diff-line ${diffLineClass(line)}`, line));
    if (index < lines.length - 1) pre.append(document.createTextNode("\n"));
  });
  if (pre.textContent !== text) {
    // Should be unreachable; if it ever is not, the raw bytes are what matter.
    pre.replaceChildren(document.createTextNode(text));
    pre.dataset.rendered = "raw-fallback";
  } else {
    pre.dataset.rendered = "verbatim";
  }
  return pre;
}

// -------------------------------------------------------------- fragments

function callout(kind, title, message, { code = "", detail = "" } = {}) {
  const box = el("div", `callout callout-${kind}`);
  box.append(el("p", "callout-title", title));
  if (message) box.append(el("p", null, message));
  if (detail) box.append(el("p", "callout-detail", detail));
  if (code) box.append(el("code", "callout-code", code));
  return box;
}

function factRow(label, valueNode) {
  const cell = el("div");
  cell.append(el("dt", "meta-label", label));
  const dd = el("dd", "meta-value");
  dd.append(valueNode);
  cell.append(dd);
  return cell;
}

/**
 * The home-relative `~/...` spelling of an absolute target path — matching
 * what the diff header and the "does not exist yet" notice already show.
 * `files_affected` always comes back absolute from the engine; showing that
 * raw form next to a `~/...` diff header in the same panel reads as two
 * different files, not one.
 *
 * Preferred source: `targets[].display`, exact because the engine set it
 * from the real home directory. Fallback, for a payload that carries
 * `files_affected` and a `diff` but no `targets` at all (an `apply()`
 * response, or a minimal caller/double): read the `~/...` form straight off
 * the diff's own `---`/`+++` lines and accept it only if it is a genuine
 * suffix of the absolute path. No match either way -> shown unchanged;
 * never a guessed or fabricated path.
 */
function displayFor(absolute, payload) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  const matched = targets.find((target) => str(target?.path) === absolute);
  const fromTarget = str(matched?.display);
  if (fromTarget) return fromTarget;

  const diff = str(payload?.diff);
  const tildePaths = [...diff.matchAll(/^(?:---|\+\+\+) (~\/\S.*)$/gm)].map((match) => match[1].trim());
  const home = tildePaths.find((tilde) => tilde.length > 2 && absolute.endsWith(tilde.slice(2)));
  return home || absolute;
}

/**
 * Renders `files` as the `~/...` form `displayFor` resolves, plus a
 * `.callout-detail` line naming the absolute path for any entry whose
 * display was abbreviated — `.file-list li` is single-line and ellipsised
 * (see its own rule below), so the full path goes below the list rather
 * than inside it, and stays reachable (also as the `<li>`'s `title`)
 * instead of being hidden.
 */
function fileList(files, payload) {
  const paths = Array.isArray(files) ? files.filter((path) => typeof path === "string" && path) : [];
  if (!paths.length) {
    const empty = el("p", "not-measured");
    empty.append(el("span", "dash", "—"), document.createTextNode(" no files reported"));
    return [empty];
  }
  const list = el("ul", "file-list");
  const hints = [];
  paths.forEach((path) => {
    const display = displayFor(path, payload);
    const item = el("li", null, display);
    item.title = path;
    list.append(item);
    if (display !== path) hints.push(el("p", "callout-detail", `${display} is the full path ${path}`));
  });
  return [list, ...hints];
}

/**
 * "This is guidance, not a guarantee" — shown on every writable fix, first,
 * before any diff. `kind` comes from the payload the caller has in hand
 * (`preview.kind`); a `recommendation` fix writes nothing, so it gets the
 * narrower, honest claim instead of the write-specific one.
 */
function limitationsCallout(kind) {
  if (kind === "recommendation") {
    return callout(
      "warn",
      "Limitations",
      "This is a suggestion, not something SessionRx writes anywhere: nothing changes on disk, "
      + "and nothing here checks whether the habit is actually followed.",
    );
  }
  return callout(
    "warn",
    "Limitations",
    "This writes an instruction into a config file the AGENT reads as guidance, not an enforced "
    + "constraint. Adding it does not guarantee the agent's behaviour changes — nothing checks "
    + "compliance after the fact, and the agent can still repeat what this was meant to stop. "
    + "Treat Apply as worth trying, not as a verified fix.",
  );
}

/** An ALREADY_APPLIED refusal is a healthy state, not a failure — render it that way. */
function alreadyAppliedCallout(error) {
  const message = str(error?.message) || "This fix is already in place.";
  return callout(
    "ok",
    "Already applied",
    message,
    { detail: "Nothing was written. This fix is not offered again while it is in place — Undo removes it." },
  );
}

/**
 * Targets the engine reports as about to be CREATED, by name.
 *
 * Primary source: `targets[].created` (BP-004.11) — set by `preview()`/
 * `apply()` from the actual file-existence check, so it is exact. Fallback:
 * the diff's own `--- /dev/null` convention (git's for "no prior file"),
 * read straight off `diff` text, for a payload that carries a diff but no
 * `targets` array (e.g. an `apply()` response, or a minimal test double).
 */
function targetsBeingCreated(payload) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  const named = targets
    .filter((target) => target?.created === true)
    .map((target) => str(target?.display) || str(target?.path))
    .filter(Boolean);
  if (named.length) return named;
  const diff = str(payload?.diff);
  if (!/^--- \/dev\/null$/m.test(diff)) return [];
  const match = diff.match(/^\+\+\+ (.+)$/m);
  return [match ? match[1].trim() : "the target file"];
}

/** Per-target detail of exactly what would be written — bytes appended, keys added. */
function targetNotes(preview) {
  const targets = Array.isArray(preview?.targets) ? preview.targets : [];
  return targets
    .map((target) => {
      const label = str(target?.display) || str(target?.path);
      const note = str(target?.note);
      return label && note ? `${label}: ${note}` : "";
    })
    .filter(Boolean);
}

/** "expected effect" — the engine's `rationale`, or an honest admission it has none. */
function effectSection(rationale) {
  const section = el("div", "modal-section");
  section.append(el("h4", null, "expected effect"));
  if (rationale) {
    section.append(el("p", null, rationale));
  } else {
    const notStated = el("p", "not-measured");
    notStated.append(el("span", "dash", "—"), document.createTextNode(" the engine did not report an expected effect for this fix"));
    section.append(notStated);
  }
  return section;
}

/** The engine's error, verbatim, plus optional guidance keyed off its code. */
function errorCallout(error, phase) {
  const code = classifyError(error);
  const message = str(error?.message) || "The request failed and reported no message.";
  const box = callout(
    "error",
    `${phase} failed${code ? ` — ${code}` : ""}`,
    // Verbatim. The engine names the real path, the hashes and the backup here.
    message,
    { code: code ? `code: ${code}` : "" },
  );
  const guidance = CODE_GUIDANCE[code];
  if (guidance) box.append(el("p", "note", guidance));
  return box;
}

// -------------------------------------------------------------- the modal

/**
 * Open the fix modal.
 *
 * @param {string|object} fixId the fix id (BP-004), or an options object
 *   carrying `fixId`
 * @param {{rule?: object, session?: object, api?: {get: Function, post: Function},
 *          mount?: Element, onApplied?: Function, onUndone?: Function,
 *          onClose?: Function, title?: string}} [options]
 *   `api` defaults to app.js's wrapper, which is what carries the CSRF nonce;
 *   it is a parameter only so a harness can inject a double.
 * @returns {{close: () => void, element: HTMLElement}} handle for the caller
 */
export function openFixModal(fixId, options = {}) {
  const raw = (fixId && typeof fixId === "object" ? fixId : options) || {};
  const id = str(typeof fixId === "string" ? fixId : raw.fixId);

  /**
   * Two callers, two vocabularies, one modal.
   *
   * `public/js/pages/health.js` (BP-001.24) passes the finding FLAT —
   * `{mode, fixId, ruleId, ruleName, sessionId, cli, api, onSettled}` — while a
   * caller holding the analyzed objects passes `{rule, session}`. Both are
   * normalised here rather than pushed back onto the callers, because this
   * module is the one that has to be right about what it renders.
   */
  const opts = {
    ...raw,
    rule: raw.rule ?? (str(raw.ruleId) || str(raw.ruleName)
      ? { id: str(raw.ruleId), name: str(raw.ruleName) }
      : null),
    session: raw.session ?? (str(raw.sessionId) || str(raw.cli)
      ? { sessionId: str(raw.sessionId), cli: str(raw.cli) }
      : null),
  };
  // `mode: "apply"` primes the Apply button; it NEVER writes on its own. The
  // diff is on screen and a click has happened before any byte is written
  // (BP-004.06) — an auto-apply would remove the only review step there is.
  const primeApply = str(raw.mode) === "apply";
  const settled = (...args) => {
    if (typeof raw.onSettled === "function") raw.onSettled(...args);
  };
  const api = raw.api && typeof raw.api.post === "function" ? raw.api : appApi;
  const root = raw.mount || document.getElementById(MODAL_ROOT_ID) || document.body;

  const state = {
    checked: null,
    preview: null,
    applied: null,
    busy: false,
    closed: false,
    undoPath: null,
    // The catalogue entry (GET /api/fixes) for this fix id, carrying
    // `rationale` — the "expected effect" text — for the writable fix kinds
    // whose own preview()/apply() payload does not include it. Best-effort:
    // stays null if the fetch fails, and the UI says so rather than guessing.
    catalogEntry: null,
  };

  // ---- chrome
  const overlay = el("div", "modal-root");
  const modal = el("section", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "fix-modal-title");

  const head = el("div", "modal-head");
  const headText = el("div");
  const title = el("h2", "modal-title", str(opts.title) || str(opts.rule?.name) || id || "Fix");
  title.id = "fix-modal-title";
  headText.append(title);
  const subtitleBits = [id];
  const ruleId = str(opts.rule?.id);
  if (ruleId) subtitleBits.push(`rule ${ruleId}`);
  const sessionId = str(opts.session?.sessionId);
  if (sessionId) subtitleBits.push(`session ${sessionId}`);
  headText.append(el("p", "modal-subtitle", subtitleBits.filter(Boolean).join("  ·  ")));
  head.append(headText);

  const closeButton = el("button", "modal-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close without changing anything");
  head.append(closeButton);

  const body = el("div", "modal-body");
  const actions = el("div", "modal-actions");

  const previewButton = el("button", "button", "Preview");
  previewButton.type = "button";
  const applyButton = el("button", "button button-primary", "Apply");
  applyButton.type = "button";
  const undoButton = el("button", "button button-danger", "Undo");
  undoButton.type = "button";
  const skipButton = el("button", "button button-quiet", "Skip");
  skipButton.type = "button";

  actions.append(skipButton, el("span", "toolbar-spacer"), previewButton, undoButton, applyButton);
  modal.append(head, body, actions);
  overlay.append(modal);

  // ---- lifecycle

  const onKeydown = (event) => {
    if (event.key === "Escape" && !state.busy) close();
  };

  function close() {
    if (state.closed) return;
    state.closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
    if (typeof opts.onClose === "function") opts.onClose(state);
  }

  function setBusy(busy, label) {
    state.busy = busy === true;
    [previewButton, applyButton, undoButton, skipButton, closeButton].forEach((button) => {
      button.disabled = state.busy;
    });
    if (state.busy && label) {
      body.replaceChildren();
      const waiting = el("p", "empty-state");
      waiting.append(el("span", "spinner"), document.createTextNode(` ${label}`));
      body.append(waiting);
    }
  }

  /** Enable exactly the actions the current state actually supports. */
  function syncActions() {
    const isApplied = state.applied !== null || state.checked?.applied === true;
    const hasPreview = state.preview !== null;
    applyButton.disabled = state.busy || isApplied || !hasPreview
      || state.preview?.applyable === false;
    applyButton.textContent = isApplied ? "Applied" : "Apply";
    undoButton.hidden = !isApplied;
    undoButton.disabled = state.busy || !isApplied;
    previewButton.disabled = state.busy || isApplied;
    previewButton.hidden = isApplied;
  }

  // ---- rendering

  function renderCheckState(checked) {
    const status = str(checked?.status);
    if (checked?.applied === true) {
      return callout(
        "ok",
        "Already applied",
        `This fix is already present${str(checked.display) ? ` in ${checked.display}` : ""}, so it is not `
        + "offered again. Undo removes it.",
        { code: str(checked.marker) ? `marker: ${checked.marker}` : "" },
      );
    }
    if (checked?.drifted === true) {
      return callout(
        "warn",
        "Section present but edited",
        `The section this fix manages exists and has been changed${str(checked.reason) ? ` (${checked.reason})` : ""}. `
        + "SessionRx will not rewrite an edited section.",
        { detail: str(checked.message) },
      );
    }
    if (status === "unknown") {
      return callout(
        "unknown",
        "Could not determine whether this fix is applied",
        // `check().reason` IS the engine's error code in this branch.
        `Reported as unmeasurable rather than as "not applied"${str(checked?.reason) ? `: ${checked.reason}` : ""}.`,
        { detail: str(checked?.message) },
      );
    }
    return null;
  }

  function renderPreview(preview) {
    const sections = [];

    // Prominent and first: what this can and cannot promise, before a single
    // byte of diff. See header comment point 6.
    sections.push(limitationsCallout(str(preview?.kind)));

    const creating = targetsBeingCreated(preview);
    if (creating.length) {
      sections.push(callout(
        "info",
        creating.length > 1 ? "These files do not exist yet" : "This file does not exist yet",
        `SessionRx will CREATE ${creating.join(", ")}. This is a new file, not an edit to `
        + "something already there — check the path above is the one you expect.",
      ));
    }

    if (str(preview?.description)) {
      sections.push(el("p", null, preview.description));
    }

    sections.push(effectSection(str(preview?.rationale) || str(state.catalogEntry?.rationale)));

    const facts = el("dl", "modal-facts");
    facts.append(factRow(
      "reversible",
      preview?.reversible === true
        ? el("span", "badge badge-sm badge-ok", "yes — backup before write")
        : el("span", "badge badge-sm badge-unknown", "not stated as reversible"),
    ));
    facts.append(factRow(
      "already applied",
      state.checked?.applied === true
        ? el("span", "badge badge-sm badge-ok", "yes")
        : (str(state.checked?.status) === "unknown"
          ? el("span", "badge badge-sm badge-unknown", "could not tell")
          : el("span", "badge badge-sm badge-info", "no")),
    ));
    if (str(preview?.kind)) facts.append(factRow("kind", el("code", null, preview.kind)));
    sections.push(facts);

    const filesSection = el("div", "modal-section");
    filesSection.append(el("h4", null, "files affected"));
    filesSection.append(...fileList(preview?.files_affected, preview));
    // Exactly what would be written per target — bytes appended, keys added —
    // as `.callout-detail` text (wraps), never inside `.file-list li` (which
    // is single-line, ellipsised, and would clip anything longer than a path).
    targetNotes(preview).forEach((note) => filesSection.append(el("p", "callout-detail", note)));
    sections.push(filesSection);

    if (preview?.sensitive === true) {
      sections.push(callout(
        "warn",
        "This diff contains your own configuration",
        "The context lines around the change are bytes from your own file, which can "
        + "include token-shaped values. It is shown exactly as written because the preview "
        + "must equal what Apply writes, byte for byte — read it before sharing a screenshot.",
      ));
    }

    const diffSection = el("div", "modal-section");
    const diffHead = el("div", "diff-caption");
    diffHead.append(el("span", null, "exact bytes Apply will write"));
    if (Array.isArray(preview?.targets) && preview.targets.length) {
      preview.targets.forEach((target) => {
        if (str(target?.afterHash)) diffHead.append(el("span", null, `after: ${target.afterHash}`));
      });
    }
    diffSection.append(el("h4", null, "diff"), renderDiff(preview?.diff), diffHead);
    sections.push(diffSection);

    if (Array.isArray(preview?.conflicts) && preview.conflicts.length) {
      sections.push(callout(
        "warn",
        "conflicts reported by the engine",
        preview.conflicts.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"),
      ));
    }
    return sections;
  }

  function renderAppliedState(applied) {
    const sections = [];
    sections.push(callout(
      "ok",
      "Applied",
      "The bytes below are what was written. A byte-for-byte backup was taken first, "
      + "and Undo restores it — refusing rather than clobbering the file if it has "
      + "changed since.",
      { code: str(applied?.undoPath) ? `undo record: ${applied.undoPath}` : "" },
    ));
    // The promise made before Apply still holds after it: this is guidance
    // written into a config file, not a verified behaviour change.
    sections.push(limitationsCallout(str(applied?.kind)));
    const created = targetsBeingCreated(applied);
    if (created.length) {
      sections.push(callout(
        "info",
        created.length > 1 ? "These files were created" : "This file was created",
        `SessionRx created ${created.join(", ")} — it did not exist before this Apply.`,
      ));
    }
    sections.push(effectSection(str(applied?.rationale) || str(state.catalogEntry?.rationale)));
    const filesSection = el("div", "modal-section");
    filesSection.append(el("h4", null, "files written"), ...fileList(applied?.files_affected, applied));
    sections.push(filesSection);
    const diffSection = el("div", "modal-section");
    diffSection.append(el("h4", null, "diff written"), renderDiff(applied?.diff));
    sections.push(diffSection);
    return sections;
  }

  function show(nodes) {
    body.replaceChildren();
    nodes.filter(Boolean).forEach((node) => body.append(node));
    syncActions();
  }

  // ---- actions

  async function loadCheck() {
    // BP-005.09 is a GET: it reads and changes nothing.
    setBusy(true, "Checking whether this fix is already in place…");
    try {
      state.checked = await api.get(`/api/fixes/${encodeURIComponent(id)}/check`);
    } catch (error) {
      state.checked = null;
      setBusy(false);
      show([errorCallout(error, "Check")]);
      return false;
    }
    setBusy(false);
    return true;
  }

  /**
   * `GET /api/fixes` for this fix's `rationale` (BP-005.20's shipped shape,
   * not its stale blueprint row) — the "expected effect" text that
   * `preview()`/`apply()` do not carry for a writable fix. Runs alongside
   * `loadCheck()`, never blocks it, and leaves `catalogEntry` null on any
   * failure: this is a nicety, not a precondition for Preview/Apply/Undo.
   */
  async function loadCatalog() {
    try {
      const listing = await api.get("/api/fixes");
      const entries = Array.isArray(listing?.fixes) ? listing.fixes : [];
      state.catalogEntry = entries.find((entry) => str(entry?.id) === id) || null;
    } catch {
      state.catalogEntry = null;
    }
  }

  async function loadPreview() {
    setBusy(true, "Generating the exact diff Apply would write…");
    try {
      state.preview = await api.post(`/api/fixes/${encodeURIComponent(id)}/preview`, {
        sessionId: str(opts.session?.sessionId) || undefined,
        ruleId: str(opts.rule?.id) || undefined,
      });
    } catch (error) {
      state.preview = null;
      setBusy(false);
      if (classifyError(error) === "ALREADY_APPLIED") {
        // A race with another tab/apply since loadCheck() ran: not a failure.
        state.checked = { ...(state.checked || {}), applied: true };
        show([alreadyAppliedCallout(error)]);
        return;
      }
      show([renderCheckState(state.checked), errorCallout(error, "Preview")]);
      return;
    }
    setBusy(false);
    show([renderCheckState(state.checked), ...renderPreview(state.preview)]);
    if (primeApply && !applyButton.disabled) applyButton.focus();
  }

  async function doApply() {
    setBusy(true, "Backing up, then writing…");
    try {
      state.applied = await api.post(`/api/fixes/${encodeURIComponent(id)}/apply`, {
        sessionId: str(opts.session?.sessionId) || undefined,
        ruleId: str(opts.rule?.id) || undefined,
      });
      state.undoPath = str(state.applied?.undoPath) || null;
    } catch (error) {
      state.applied = null;
      setBusy(false);
      if (classifyError(error) === "ALREADY_APPLIED") {
        // Another tab applied it between Preview and this click: not a failure.
        state.checked = { ...(state.checked || {}), applied: true };
        show([alreadyAppliedCallout(error)]);
        return;
      }
      show([errorCallout(error, "Apply"), ...(state.preview ? renderPreview(state.preview) : [])]);
      return;
    }
    setBusy(false);
    show(renderAppliedState(state.applied));
    if (typeof opts.onApplied === "function") opts.onApplied(state.applied, id);
    settled({ phase: "apply", result: state.applied, fixId: id });
  }

  async function doUndo() {
    setBusy(true, "Restoring the backup…");
    const payload = state.undoPath ? { undoPath: state.undoPath } : {};
    try {
      const restored = await api.post(`/api/fixes/${encodeURIComponent(id)}/undo`, payload);
      state.applied = null;
      state.preview = null;
      state.undoPath = null;
      // Refresh applied-status BEFORE rendering the confirmation: loadCheck()
      // runs its own busy spinner (setBusy(true, "Checking…") replaces body),
      // and only re-renders on failure — calling it after `show()` would
      // silently clobber the "Undone" message with that spinner and never
      // put the message back. `show()` below is what must render last.
      await loadCheck();
      show([callout(
        "ok",
        "Undone",
        restored?.byteIdentical === true
          ? "The file was restored byte-for-byte to its pre-apply content."
          : "The undo reported success but did not confirm a byte-identical restore.",
        { code: str(restored?.undoPath) ? `undo record: ${restored.undoPath}` : "" },
      )]);
      if (typeof opts.onUndone === "function") opts.onUndone(restored, id);
      settled({ phase: "undo", result: restored, fixId: id });
    } catch (error) {
      setBusy(false);
      show([errorCallout(error, "Undo")]);
    }
  }

  previewButton.addEventListener("click", () => { loadPreview(); });
  applyButton.addEventListener("click", () => { doApply(); });
  undoButton.addEventListener("click", () => { doUndo(); });
  skipButton.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !state.busy) close();
  });
  document.addEventListener("keydown", onKeydown, true);

  root.append(overlay);
  skipButton.focus();

  (async () => {
    if (!id) {
      show([callout("error", "No fix id", "The modal was opened without a fix id, so there is nothing to preview.")]);
      return;
    }
    const [ok] = await Promise.all([loadCheck(), loadCatalog()]);
    if (!ok || state.closed) return;
    if (state.checked?.applied === true) {
      // Previewing here would throw ALREADY_APPLIED and read as a failure.
      show([renderCheckState(state.checked)]);
      return;
    }
    await loadPreview();
  })();

  return { close, element: overlay };
}

export default openFixModal;

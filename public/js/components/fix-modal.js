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

function fileList(files) {
  const paths = Array.isArray(files) ? files.filter((path) => typeof path === "string" && path) : [];
  if (!paths.length) {
    const empty = el("p", "not-measured");
    empty.append(el("span", "dash", "—"), document.createTextNode(" no files reported"));
    return empty;
  }
  const list = el("ul", "file-list");
  paths.forEach((path) => {
    const item = el("li", null, path);
    item.title = path;
    list.append(item);
  });
  return list;
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

    if (str(preview?.description)) {
      sections.push(el("p", null, preview.description));
    }

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
    filesSection.append(fileList(preview?.files_affected));
    sections.push(filesSection);

    if (preview?.sensitive === true) {
      sections.push(callout(
        "warn",
        "This diff contains your own configuration",
        "The context lines around the change are bytes from your own file, which can "
        + "include token-shaped values. It is shown byte-for-byte because the diff must "
        + "equal what Apply writes (BP-004.06) — read it before sharing a screenshot.",
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
    const filesSection = el("div", "modal-section");
    filesSection.append(el("h4", null, "files written"), fileList(applied?.files_affected));
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
      setBusy(false);
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
      await loadCheck();
      syncActions();
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
    const ok = await loadCheck();
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

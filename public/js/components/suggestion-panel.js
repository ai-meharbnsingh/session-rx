/**
 * Suggested change — SessionRx's replacement for the old fix modal.
 *
 * SessionRx never writes a user's files. Instead of Preview/Apply/Undo, this
 * panel shows: a plain-language one-line summary, a Global / Project switch,
 * the target file or location, the exact preview text, and a "Copy request"
 * button that copies a ready-to-paste message for the user's own AI coding
 * tool to act on. No wording here claims SessionRx changed anything.
 *
 * SECURITY: every string rendered here — preview text, request text, file
 * paths — reaches the DOM through `textContent`, never `innerHTML`.
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

function callout(kind, title, message) {
  const box = el("div", `callout callout-${kind}`);
  box.append(el("p", "callout-title", title));
  if (message) box.append(el("p", null, message));
  return box;
}

/**
 * Copy text to the clipboard. Tries `navigator.clipboard` first, falls back
 * to a hidden `<textarea>` + `execCommand('copy')`, and never throws — a
 * copy that fails is reported back to the caller as `false`, not an
 * exception the caller has to guard against.
 */
export async function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok === true;
  } catch {
    return false;
  }
}

function statusCallout(suggestion) {
  const status = str(suggestion?.status);
  if (status === "already-added") {
    return callout("ok", "Already added", `The marker for this suggestion was found in ${str(suggestion?.targetLabel) || "the target"}, so it looks like this change is already in place.`);
  }
  if (status === "not-added") {
    return callout("info", "Not added yet", "SessionRx did not find this section in the target file.");
  }
  if (status === "possibly-already-satisfied") {
    const evidenceLine = Number.isFinite(suggestion?.evidenceLine) ? suggestion.evidenceLine : "an unspecified";
    const evidenceSnippet = str(suggestion?.evidenceSnippet);
    const sourceLabel = str(suggestion?.evidenceSourceLabel) || str(suggestion?.targetLabel) || "the target";
    const message = `This file appears to address this with different wording (found near line ${evidenceLine} of ${sourceLabel}: '${evidenceSnippet}'). SessionRx couldn't confirm automatically. Review before applying — applying anyway won't duplicate content, but it's likely unnecessary.`;
    const box = callout("maybe", "Possibly already satisfied", message);
    const actions = el("div", "modal-actions suggestion-actions");
    const showButton = el("button", "button button-sm", "Show me");
    showButton.type = "button";
    const details = el("details");
    const evidenceDetails = str(suggestion?.evidenceSnippetFull) || evidenceSnippet;
    details.append(el("summary", null, "Evidence"), el("p", null, evidenceDetails));
    showButton.addEventListener("click", () => {
      details.open = !details.open;
    });

    const applyButton = el("button", "button button-sm button-primary", "Apply anyway");
    applyButton.type = "button";
    const applyStatus = el("span", "copy-status", "");
    applyStatus.setAttribute("role", "status");
    applyButton.addEventListener("click", async () => {
      const ok = await copyToClipboard(str(suggestion?.request));
      applyStatus.textContent = ok ? "Copied." : "Could not copy automatically — select the text below and copy it yourself.";
    });

    const dismissButton = el("button", "button button-sm", "Dismiss");
    dismissButton.type = "button";
    dismissButton.addEventListener("click", () => {
      box.replaceChildren(el("p", null, "Dismissed — treating as not confirmed either way."));
    });

    actions.append(showButton, applyButton, applyStatus, dismissButton);
    box.append(actions, details);
    return box;
  }
  const reason = str(suggestion?.statusReason);
  const why = reason === "project-path-not-resolvable"
    ? "SessionRx cannot resolve a project path from here, so it cannot say whether this is already added."
    : reason === "no-local-file"
      ? "This target is not a local file SessionRx can read."
      : "SessionRx could not determine whether this is already added.";
  return callout("unknown", "Could not be checked", `${why} That is not the same as "not added" — it is not a pass either way.`);
}

/**
 * Render one suggestion into `body`. `onScopeChange` fires when the person
 * flips the Global / Project switch, so the caller can re-fetch and re-render.
 */
function renderSuggestion(body, suggestion, { scope, onScopeChange, onCopy }) {
  body.replaceChildren();

  if (suggestion?.available === false) {
    body.append(callout("info", "No suggested change for this tool", str(suggestion?.message) || "SessionRx has no known remedy for this finding on this tool."));
    return;
  }

  body.append(el("p", "suggestion-summary", str(suggestion?.plainSummary) || str(suggestion?.title)));

  const switcher = el("div", "scope-switch");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", "Global or project");
  ["global", "project"].forEach((value) => {
    const button = el("button", `button button-sm${value === scope ? " is-active" : ""}`, value === "global" ? "Global" : "Project");
    button.type = "button";
    button.setAttribute("aria-pressed", value === scope ? "true" : "false");
    button.addEventListener("click", () => {
      if (value !== scope) onScopeChange(value);
    });
    switcher.append(button);
  });
  body.append(switcher);

  const target = el("p", "suggestion-target");
  target.append(el("strong", null, "Target: "), document.createTextNode(str(suggestion?.targetLabel) || "not resolved"));
  body.append(target);

  body.append(statusCallout(suggestion));

  if (str(suggestion?.rationale)) {
    const rationale = el("div", "modal-section");
    rationale.append(el("h4", null, "why this is suggested"), el("p", null, suggestion.rationale));
    body.append(rationale);
  }

  const previewSection = el("div", "modal-section");
  previewSection.append(el("h4", null, "preview — the exact text the request asks to add"));
  const pre = el("pre", "diff");
  pre.textContent = str(suggestion?.preview);
  previewSection.append(pre);
  body.append(previewSection);

  const actions = el("div", "modal-actions suggestion-actions");
  const copyButton = el("button", "button button-primary", "Copy request");
  copyButton.type = "button";
  const status = el("span", "copy-status", "");
  status.setAttribute("role", "status");
  copyButton.addEventListener("click", async () => {
    const ok = await copyToClipboard(str(suggestion?.request));
    status.textContent = ok ? "Copied." : "Could not copy automatically — select the text below and copy it yourself.";
    if (typeof onCopy === "function") onCopy(ok);
  });
  actions.append(copyButton, status);
  body.append(actions);

  const requestSection = el("div", "modal-section");
  requestSection.append(el("h4", null, "request — paste this into your AI coding tool"));
  const requestBox = el("pre", "diff");
  requestBox.textContent = str(suggestion?.request);
  requestSection.append(requestBox);
  body.append(requestSection);
}

/**
 * Open the suggestion panel for one `rule.fix` id and tool.
 *
 * @param {{id: string, toolId?: string, scope?: "global"|"project",
 *   title?: string, api?: object, mount?: Element, onClose?: Function}} options
 * @returns {{close: () => void, element: HTMLElement}}
 */
export function openSuggestionPanel(options = {}) {
  const id = str(options.id);
  const toolId = str(options.toolId);
  const api = options.api && typeof options.api.get === "function" ? options.api : appApi;
  const root = options.mount || document.getElementById(MODAL_ROOT_ID) || document.body;

  const state = { scope: options.scope === "project" ? "project" : "global", closed: false };

  const overlay = el("div", "modal-root");
  const modal = el("section", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "suggestion-title");

  const head = el("div", "modal-head");
  const title = el("h2", "modal-title", str(options.title) || "Suggested change");
  title.id = "suggestion-title";
  head.append(title);
  const closeButton = el("button", "modal-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close");
  head.append(closeButton);

  const body = el("div", "modal-body");
  modal.append(head, body);
  overlay.append(modal);

  function close() {
    if (state.closed) return;
    state.closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
    if (typeof options.onClose === "function") options.onClose();
  }
  const onKeydown = (event) => { if (event.key === "Escape") close(); };

  async function load() {
    body.replaceChildren(el("p", "empty-state", "Loading the suggested change…"));
    if (!id || !toolId) {
      body.replaceChildren(callout("error", "Nothing to show", "This suggestion was opened without an id or a tool."));
      return;
    }
    let suggestion = null;
    try {
      const payload = await api.get(`/api/suggestions?id=${encodeURIComponent(id)}&tool=${encodeURIComponent(toolId)}&scope=${encodeURIComponent(state.scope)}`);
      suggestion = Array.isArray(payload?.suggestions) ? payload.suggestions[0] : null;
    } catch (error) {
      body.replaceChildren(callout("error", "Could not load this suggestion", str(error?.message) || "The request failed."));
      return;
    }
    if (!suggestion) {
      body.replaceChildren(callout("error", "No suggestion found", "SessionRx has no suggestion for this id and tool."));
      return;
    }
    renderSuggestion(body, suggestion, {
      scope: state.scope,
      onScopeChange: (scope) => { state.scope = scope; load(); },
    });
  }

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", onKeydown, true);

  root.append(overlay);
  load();

  return { close, element: overlay };
}

export default openSuggestionPanel;

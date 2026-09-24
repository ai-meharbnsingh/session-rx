/**
 * Suggestions — SessionRx's answer to an observed finding, now that it never
 * writes a user's files itself.
 *
 * For every (suggestion, tool, scope) this module produces a plain object:
 * a one-line summary, the target (a file path or, for Cursor's global scope,
 * an application settings location), the exact preview text, and a
 * ready-to-paste request the user hands to their own AI coding tool.
 *
 * `SUGGESTION_DEFS` (src/suggestions/sections.js) is keyed by the same id
 * `rule.fix` already names in `src/analyzer/rules.js`, so a finding's
 * suggestion is found by that id directly — no second catalogue to drift
 * out of sync with the first.
 */

import { renderSection, SUGGESTION_DEFS } from "./sections.js";
import { checkMarkerStatus, checkSettingsStatus, TOOL_IDS, toolLabel, TOOLS } from "./targets.js";

export { SUGGESTION_DEFS, TOOL_IDS, toolLabel };

const SCOPES = Object.freeze(["global", "project"]);

/** The `descriptor.fix` ids the analyzer's rule catalogue can name. */
export function listSuggestionIds() {
  return Object.keys(SUGGESTION_DEFS);
}

/**
 * The suggestion for one `rule.fix` id targeting one tool.
 *
 * For the settings suggestion (`claude-auto-compact`) on a tool other than
 * Claude Code, there is no confirmed setting, so the instruction-section
 * fallback (`compact-contract`, a genuine content match: both are about
 * compacting deliberately) is offered instead, and the result says so
 * plainly. When a definition has no fallback and the tool has no matching
 * section, `null` is returned — never an invented setting name.
 */
function resolveDefinition(def, toolId) {
  if (!def.key) return { def, usingFallback: false };
  if (toolId === "claude") return { def, usingFallback: false };
  if (def.fallbackSection) return { def: def.fallbackSection, usingFallback: true, originalDef: def };
  return null;
}

function requestForFile({ toolId, scope, targetDisplay, preview, note, kind = "instructions" }) {
  const tool = toolLabel(toolId);
  const scopeText = scope === "global"
    ? `my global ${kind} file for ${tool} (${targetDisplay})`
    : `the ${kind} file for ${tool} in the current project (${targetDisplay})`;
  const noteLine = note ? ` ${note}` : "";
  return `Please add the following section to the end of ${scopeText}. Create the file if it does not `
    + `exist. Do not change or remove anything already in the file.${noteLine} If a section with the `
    + `marker shown below is already there, leave it as is and tell me.\n\n---\n${preview}---\n`;
}

function requestForCursorUserRules(preview) {
  return "Cursor has no global instructions file that a CLI can edit — its global rules live in the "
    + "app's own settings. Please open Cursor Settings → Rules → User Rules yourself and paste the "
    + "following in there. If a rule with the marker shown below is already present, leave it as is.\n\n"
    + `---\n${preview}---\n`;
}

function requestForSettings({ toolId, scope, targetDisplay, key, value }) {
  const tool = toolLabel(toolId);
  const scopeText = scope === "global" ? `my global ${tool} settings file` : `the ${tool} settings file for the current project`;
  return `Please add the key "${key}": ${JSON.stringify(value)} to ${scopeText} (${targetDisplay}) `
    + `without removing or reformatting any other keys. Create the file if it does not exist. If `
    + `"${key}" is already ${JSON.stringify(value)}, leave it as is and tell me.\n`;
}

/**
 * Build the full suggestion for one (id, tool, scope).
 *
 * @param {string} id a `SUGGESTION_DEFS` key (== a `rule.fix` value)
 * @param {string} toolId one of `TOOL_IDS`
 * @param {"global"|"project"} scope
 * @param {{env?: object, home?: string}} [options] `home` overrides
 *   `os.homedir()` for the read-only global-target check, the same knob
 *   `SESSION_RX_HOME` gives the rest of the process (and what a test points
 *   at a fixture directory instead of a developer's real home).
 * @returns {Promise<object|null>} `null` when the tool is not one SessionRx
 *   knows, or when no suggestion — no setting and no sensible instruction
 *   fallback — exists for this (id, tool) pair.
 */
export async function buildSuggestion(id, toolId, scope, { env = process.env, home } = {}) {
  const baseDef = SUGGESTION_DEFS[id];
  if (!baseDef || !TOOLS[toolId] || !SCOPES.includes(scope)) return null;
  const resolved = resolveDefinition(baseDef, toolId);
  if (!resolved) {
    return {
      id, ruleId: baseDef.ruleId, targetTool: toolId, toolLabel: toolLabel(toolId), scope,
      available: false,
      plainSummary: `No suggested change for ${toolLabel(toolId)}.`,
      message: `There is no confirmed setting for ${toolLabel(toolId)} that answers this finding, and no `
        + "instruction section is a close enough match to suggest instead.",
    };
  }
  const { def, usingFallback, originalDef } = resolved;

  if (def.key) {
    // The settings suggestion, on Claude Code (the only tool it ever targets).
    const target = TOOLS[toolId].settings?.[scope];
    const targetDisplay = target?.display ? target.display({ env, home }) : null;
    // The preview is the key/value pair on its own line, not a whole document —
    // that is what the request asks the tool to MERGE in, byte for byte.
    const previewLine = `"${def.key}": ${JSON.stringify(def.value)}\n`;
    const check = await checkSettingsStatus({ toolId, scope, key: def.key, value: def.value, env, home });
    return {
      id: def.id,
      ruleId: def.ruleId,
      title: def.title,
      plainSummary: def.description,
      rationale: def.rationale,
      targetTool: toolId,
      toolLabel: toolLabel(toolId),
      scope,
      targetLabel: targetDisplay,
      preview: previewLine,
      request: requestForSettings({ toolId, scope, targetDisplay, key: def.key, value: def.value }),
      status: check.status,
      statusReason: check.reason,
      available: true,
    };
  }

  const preview = renderSection(def);
  const tool = TOOLS[toolId];
  const target = tool[scope];
  const cursorGlobalNoFile = toolId === "cursor" && scope === "global";
  const targetDisplay = target?.display ? target.display({ env, home }) : null;
  const check = await checkMarkerStatus({ toolId, scope, marker: def.marker, env, home });
  const request = cursorGlobalNoFile
    ? requestForCursorUserRules(preview)
    : requestForFile({ toolId, scope, targetDisplay, preview, note: target?.note ?? null });

  const fallbackNote = usingFallback
    ? `There is no confirmed setting for ${toolLabel(toolId)} for "${originalDef.title}", so this `
      + `instruction section — "${def.title}" — is suggested instead.`
    : null;

  return {
    id: usingFallback ? `${originalDef.id}:${def.id}` : def.id,
    ruleId: originalDef ? originalDef.ruleId : def.ruleId,
    title: def.title,
    plainSummary: fallbackNote ? `${fallbackNote} ${def.description}` : def.description,
    rationale: def.rationale,
    targetTool: toolId,
    toolLabel: toolLabel(toolId),
    scope,
    targetLabel: targetDisplay,
    preview,
    request,
    status: cursorGlobalNoFile ? "unknown" : check.status,
    statusReason: cursorGlobalNoFile ? "no-local-file" : check.reason,
    available: true,
    usingFallback,
  };
}

/**
 * Every (scope, and every tool unless `toolId` narrows it) suggestion for one
 * `SUGGESTION_DEFS` id, flattened.
 */
export async function buildSuggestions({ id, toolId = null, scope = null, env = process.env, home } = {}) {
  const ids = id ? [id] : listSuggestionIds();
  const tools = toolId ? [toolId] : TOOL_IDS;
  const scopes = scope ? [scope] : SCOPES;
  const out = [];
  for (const suggestionId of ids) {
    for (const tool of tools) {
      for (const oneScope of scopes) {
        const built = await buildSuggestion(suggestionId, tool, oneScope, { env, home });
        if (built) out.push(built);
      }
    }
  }
  return out;
}

/**
 * Does a suggestion exist AT ALL for this `rule.fix` id and tool — used to
 * annotate health findings without generating the full preview/request text
 * for every rule on every session (that is what `/api/suggestions` is for).
 */
export function suggestionExists(id, toolId) {
  const def = SUGGESTION_DEFS[id];
  if (!def || !TOOLS[toolId]) return false;
  return Boolean(resolveDefinition(def, toolId));
}

export function suggestionTitleFor(id, toolId) {
  const def = SUGGESTION_DEFS[id];
  if (!def) return null;
  const resolved = resolveDefinition(def, toolId);
  return resolved ? resolved.def.title : null;
}

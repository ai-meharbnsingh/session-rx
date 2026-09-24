/**
 * Where a suggestion's request would land, per tool and scope, and a
 * read-only check of whether the marker is already there.
 *
 * SessionRx never writes any of these files. The resolution here exists only
 * to (a) name the target in the request text and (b) read it — never write
 * it — to tell the user "already added" instead of pushing a suggestion that
 * is already in place.
 *
 * Global paths honor the same environment overrides the collectors resolve
 * their own read-only roots against (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) —
 * checked first, ahead of `home` — so the file this module reads is the same
 * file the CLI itself would read. `home` is a caller-supplied home directory
 * (defaulting to `os.homedir()`), the same knob `SESSION_RX_HOME` gives the
 * rest of this process and the one tests point at a fixture directory
 * instead of a developer's real home.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function homeOf(home) {
  return typeof home === "string" && home ? home : os.homedir();
}

/**
 * One entry per supported tool. `global.resolve` returns an absolute path (or
 * is absent entirely, e.g. Cursor's user rules, which live in application
 * settings SessionRx cannot read or write). `project` is always a
 * repo-relative path: never resolvable from here, since SessionRx does not
 * know which project the request is for.
 */
export const TOOLS = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    global: {
      kind: "file",
      resolve: ({ env, home }) => path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeOf(home), ".claude"), "CLAUDE.md"),
      display: ({ env }) => (env.CLAUDE_CONFIG_DIR?.trim() ? `${env.CLAUDE_CONFIG_DIR.trim()}/CLAUDE.md` : "~/.claude/CLAUDE.md"),
    },
    project: { kind: "file", display: () => "./CLAUDE.md" },
    settings: {
      global: {
        resolve: ({ env, home }) => path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeOf(home), ".claude"), "settings.json"),
        display: ({ env }) => (env.CLAUDE_CONFIG_DIR?.trim() ? `${env.CLAUDE_CONFIG_DIR.trim()}/settings.json` : "~/.claude/settings.json"),
      },
      project: { display: () => "./.claude/settings.json" },
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    global: {
      kind: "file",
      resolve: ({ env, home }) => path.join(env.CODEX_HOME?.trim() || path.join(homeOf(home), ".codex"), "AGENTS.md"),
      display: ({ env }) => (env.CODEX_HOME?.trim() ? `${env.CODEX_HOME.trim()}/AGENTS.md` : "~/.codex/AGENTS.md"),
      note: "Codex reads ~/.codex/AGENTS.override.md instead if that file exists.",
    },
    project: { kind: "file", display: () => "./AGENTS.md" },
  },
  cursor: {
    id: "cursor",
    label: "Cursor CLI",
    // No global instructions FILE: Cursor's global rules live in the app's own
    // settings, which SessionRx cannot read or write. The request asks the
    // person to paste the text there themselves.
    global: {
      kind: "app-settings",
      display: () => "Cursor Settings → Rules → User Rules",
    },
    project: {
      kind: "file",
      display: () => "./AGENTS.md",
      note: "Cursor CLI reads AGENTS.md and .cursor/rules/ at the project root.",
    },
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity CLI",
    global: {
      kind: "file",
      resolve: ({ home }) => path.join(homeOf(home), ".gemini", "GEMINI.md"),
      display: () => "~/.gemini/GEMINI.md",
    },
    project: { kind: "file", display: () => "./AGENTS.md" },
  },
});

export const TOOL_IDS = Object.freeze(Object.keys(TOOLS));

export function toolLabel(toolId) {
  return TOOLS[toolId]?.label ?? toolId;
}

/**
 * Read-only presence check for an instruction-section marker.
 *
 * Only a resolvable GLOBAL file can be checked at all: a project path is not
 * resolvable from the server process (it does not know which project the
 * request is for), and Cursor's global target is not a file. Both report
 * `unknown` with a machine-readable reason rather than guessing either way —
 * the same honesty rule the health rules themselves follow.
 *
 * @returns {Promise<{status: "already-added"|"not-added"|"unknown", reason: string|null}>}
 */
export async function checkMarkerStatus({ toolId, scope, marker, env = process.env, home }) {
  if (scope !== "global") {
    return { status: "unknown", reason: "project-path-not-resolvable" };
  }
  const tool = TOOLS[toolId];
  const target = tool?.global;
  if (!target || target.kind !== "file" || typeof target.resolve !== "function") {
    return { status: "unknown", reason: "no-local-file" };
  }
  let text;
  try {
    text = await readFile(target.resolve({ env, home }), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "not-added", reason: null };
    return { status: "unknown", reason: `read-failed:${error?.code ?? "unknown"}` };
  }
  return text.includes(`<!-- ${marker} -->`)
    ? { status: "already-added", reason: null }
    : { status: "not-added", reason: null };
}

/** Same idea, for the one settings-file suggestion (Claude Code only). */
export async function checkSettingsStatus({ toolId, scope, key, value, env = process.env, home }) {
  if (scope !== "global") {
    return { status: "unknown", reason: "project-path-not-resolvable" };
  }
  const settings = TOOLS[toolId]?.settings?.global;
  if (!settings || typeof settings.resolve !== "function") {
    return { status: "unknown", reason: "no-local-file" };
  }
  let text;
  try {
    text = await readFile(settings.resolve({ env, home }), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "not-added", reason: null };
    return { status: "unknown", reason: `read-failed:${error?.code ?? "unknown"}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unknown", reason: "target-unparseable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unknown", reason: "target-unparseable" };
  }
  return Object.hasOwn(parsed, key) && parsed[key] === value
    ? { status: "already-added", reason: null }
    : { status: "not-added", reason: null };
}

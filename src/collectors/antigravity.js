import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Collector } from "./base.js";

/**
 * Google Antigravity CLI is DETECTED, NOT SUPPORTED.
 *
 * Third-party reports (no on-disk format has been confirmed from a real file
 * on this project) describe two candidate locations under `~/.gemini`:
 *
 *   - `~/.gemini/antigravity-cli/conversations/<uuid>.db` — SQLite, with token
 *     counts said to live inside unschemed protobuf blobs.
 *   - `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
 *     — a transcript log.
 *   - `~/.gemini/antigravity` — used by the Antigravity IDE, not the CLI.
 *
 * Per the "never invent a log format" rule, no parser is written against an
 * unconfirmed shape.  `collect()` therefore returns an EMPTY ARRAY, never a
 * fabricated session: a zero-metric session would render as a *healthy*
 * session in the UI, reporting "all clear" about a CLI this tool cannot read
 * at all. When real files are examined and the format confirmed, this can
 * become a real parser; until then it is detection-only, on the same
 * principle as any other unconfirmed-format collector in this codebase.
 */

/** Candidate paths, relative to home, in the order the UI should report them. */
const ANTIGRAVITY_SUBPATHS = Object.freeze([".gemini/antigravity-cli", ".gemini/antigravity"]);

export class AntigravityCollector extends Collector {
  constructor({ home = os.homedir() } = {}) {
    super({ id: "antigravity", displayName: "Antigravity CLI", cli: "antigravity" });
    this.home = home;
  }

  /**
   * "detection-only" when at least one candidate path exists: installed,
   * present, and deliberately unparsed.  "absent" when neither is found.
   * Never "supported".
   */
  detect() {
    const paths = ANTIGRAVITY_SUBPATHS
      .map((sub) => path.join(this.home, sub))
      .filter((candidate) => existsSync(candidate));
    if (!paths.length) return { installed: false, paths: [], status: "absent" };
    return { installed: true, paths, status: "detection-only" };
  }

  /** Always empty: no confirmed transcript format exists to normalize. */
  async collect() {
    return [];
  }
}

export default AntigravityCollector;

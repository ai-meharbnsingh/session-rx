import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Collector } from "./base.js";

/**
 * BP-002.06 - GitHub Copilot CLI is DETECTED, NOT SUPPORTED.
 *
 * EVIDENCE B1 (probed 2026-09-20): `~/.copilot/` contains only `config.json`
 * (`{"firstLaunchAt": ...}`), `ide/<uuid>.lock`, and `logs/process-<epoch>-<pid>.log`
 * whose contents are server lifecycle lines such as
 * "[INFO] Starting CLI in server mode (stdio)".  There is no transcript and no
 * token accounting anywhere under that directory.
 *
 * `collect()` therefore returns an EMPTY ARRAY, never a session.  A session with
 * zero tokens and zero turns would render in the health UI as a *healthy*
 * session - the tool would report "all clear" about a CLI it cannot read at all.
 * That is the precise failure this rule exists to prevent, so no parser is
 * invented and no zero-metric placeholder is emitted.
 */

/** Probed paths, in the order the UI should report them. */
const COPILOT_SUBPATHS = Object.freeze(["config.json", "ide", "logs"]);

export class CopilotCollector extends Collector {
  constructor({ home = os.homedir() } = {}) {
    super({ id: "copilot", displayName: "GitHub Copilot CLI", cli: "copilot" });
    this.home = home;
    this.root = path.join(home, ".copilot");
  }

  /**
   * "detection-only" when the directory exists: installed, readable, and
   * deliberately unparsed.  "absent" when it does not.  Never "supported".
   */
  detect() {
    if (!existsSync(this.root)) {
      return { installed: false, paths: [], status: "absent" };
    }
    const paths = [this.root];
    for (const sub of COPILOT_SUBPATHS) {
      const candidate = path.join(this.root, sub);
      if (existsSync(candidate)) paths.push(candidate);
    }
    return { installed: true, paths, status: "detection-only" };
  }

  /** Always empty: no transcript exists to normalize (BP-002.06). */
  async collect() {
    return [];
  }
}

export default CopilotCollector;

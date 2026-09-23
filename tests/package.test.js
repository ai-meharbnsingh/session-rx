/**
 * BP-007 / GATE-FACTORY — the packed npm artifact.
 *
 * The blueprint (docs/BLUEPRINT.md, BP-007) requires this exact file:
 * "packed artifact contains declared files and excludes fixtures/secrets".
 * Nothing in the suite asserted anything about `npm pack` output before this
 * file existed, so BP-010's GATE-FACTORY ("clean packed artifact contains no
 * secrets") and FVA-008 ("packaged smoke test proves npx session-rx is
 * offline and publishable") were untested claims.
 *
 * Every test below drives the SAME `npm pack --dry-run --json` invocation,
 * run once in `before()` because it shells out to npm and is materially
 * slower than a unit test. `--dry-run` is load-bearing: a plain `npm pack`
 * writes a real `.tgz` into the project directory, which is exactly the kind
 * of stray artifact §0.4 FILE LOCATION forbids.
 *
 * Credential-shaped probe values below are ASSEMBLED FROM FRAGMENTS — e.g.
 * `"sk" + "-ant-api"` — the same convention tests/server.test.js uses for its
 * planted-secret fixture, so this file never contains a literal
 * credential-shaped string that the machine's own secret-handling guard
 * would have to refuse on write.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");

const PACKAGE_JSON = JSON.parse(
  await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
);

// npm pack is slow (seconds, not milliseconds) compared to the rest of the
// suite; give it real headroom rather than tuning a flaky-under-load number.
const PACK_TIMEOUT_MS = 180_000;

/**
 * Credential-shaped probes, one per vendor family the brief calls out.
 * Each `pattern` is built from concatenated fragments so no fragment on its
 * own, nor the assembled source string, is written to disk as a literal
 * credential-shaped token.
 */
const SECRET_PROBES = [
  {
    name: "Anthropic-style API key",
    pattern: new RegExp(`${"sk"}${"-ant-api"}\\d{2}-[A-Za-z0-9_-]{20,}`),
  },
  {
    name: "OpenAI-style API key",
    pattern: new RegExp(`${"sk"}${"-proj-"}[A-Za-z0-9]{20,}`),
  },
  {
    name: "GitHub personal access token",
    pattern: new RegExp(`${"gh"}${"p_"}[A-Za-z0-9]{30,}`),
  },
  {
    name: "AWS access key id",
    pattern: new RegExp(`${"AK"}${"IA"}[0-9A-Z]{16}\\b`),
  },
  {
    name: "Google API key",
    pattern: new RegExp(`${"AI"}${"za"}[0-9A-Za-z_-]{35}`),
  },
];

// Binary/opaque file kinds a text-secret scan and a text-URL scan can't (and
// shouldn't) parse as UTF-8 text.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".tgz", ".gz", ".zip",
]);

/**
 * "The code loads something over the network" patterns — a script/link tag,
 * a CSS @import or url(), or a runtime fetch()/import() call — deliberately
 * narrower than "the substring http appears somewhere". Two counterexamples
 * in this very codebase would break a substring-only check:
 *   - the vendored Chart.js bundle's MIT license banner comment, which
 *     names its own homepage ("* https://www.chartjs.org") and that of its
 *     @kurkle/color dependency — legitimate provenance text, not a fetch;
 *   - a JSDoc comment in src/server.js illustrating the DNS-rebinding
 *     attack it defends against with an example `fetch('http://127.0.0.1
 *     :<port>/...')` call — real code shape, but a loopback address, not a
 *     remote asset.
 * Each pattern captures the URL so `isLoopback` can drop references to the
 * app's own local server, leaving only genuine remote-asset references.
 */
const NETWORK_REFERENCE_PATTERNS = [
  /<script[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
  /<link[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
  /@import\s+(?:url\()?["']?(https?:\/\/[^"')]+)["']?\)?/gi,
  /\burl\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi,
  /\bfetch\(\s*[`"'](https?:\/\/[^`"']+)[`"']/gi,
  /\bimport\(\s*[`"'](https?:\/\/[^`"']+)[`"']/gi,
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);

function isLoopback(url) {
  const host = /^https?:\/\/([^/:]+)/i.exec(url)?.[1] ?? "";
  return LOOPBACK_HOSTS.has(host);
}

function packResultShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "empty array" : "array";
  if (typeof value === "object") {
    return Array.isArray(value.files) ? "object with files array" : "object without files array";
  }
  return typeof value;
}

function normalizePackReport(value, npmVersion = "unknown") {
  const report = Array.isArray(value) ? value[0] : value;
  if (
    (Array.isArray(value) && value.length === 0) ||
    report === null ||
    typeof report !== "object" ||
    !Array.isArray(report.files)
  ) {
    throw new Error(
      `Unsupported npm pack --json result from npm ${npmVersion}: ` +
      `expected a non-empty array or an object with a files array; got shape=${packResultShape(value)}`,
    );
  }
  return report;
}

describe("npm pack report normalization", () => {
  it("normalizes an npm 11-style array to its inner report", () => {
    const report = { files: [{ path: "package.json" }] };
    assert.strictEqual(normalizePackReport([report], "11.19.1"), report);
  });

  it("accepts an npm 12-style object report", () => {
    const report = { files: [{ path: "package.json" }] };
    assert.strictEqual(normalizePackReport(report, "12.1.0"), report);
  });

  it("throws with the received shape for invalid pack results", () => {
    for (const value of [[], {}, null, "string"]) {
      assert.throws(
        () => normalizePackReport(value, "12.1.0"),
        (error) => /shape=/.test(error.message) && /npm 12\.1\.0/.test(error.message),
      );
    }
  });
});

describe("packaged npm artifact (BP-007 / GATE-FACTORY)", { timeout: PACK_TIMEOUT_MS }, () => {
  /** @type {{path: string, size: number, mode: number}[]} */
  let packedEntries;
  /** @type {Set<string>} */
  let packedPaths;

  before(() => {
    const raw = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()
      || process.env.npm_config_user_agent
      || "unknown";
    const report = normalizePackReport(JSON.parse(raw), npmVersion);
    packedEntries = report.files;
    packedPaths = new Set(packedEntries.map((f) => f.path));
  }, { timeout: PACK_TIMEOUT_MS });

  describe("A. declared files are present", () => {
    it("packs at least one entry for every path in package.json's files whitelist", () => {
      const missing = PACKAGE_JSON.files.filter(
        (entry) => !packedEntries.some((f) => f.path === entry || f.path.startsWith(`${entry}/`)),
      );
      assert.deepEqual(
        missing,
        [],
        `files whitelist entries with nothing packed: ${missing.join(", ")}`,
      );
    });

    it("packs the file the bin entry points at (an installed CLI needs it)", () => {
      const binTargets = Object.values(PACKAGE_JSON.bin ?? {}).map((t) => t.replace(/^\.\//, ""));
      assert.ok(binTargets.length > 0, "package.json declares no bin entry to check");
      const missing = binTargets.filter((target) => !packedPaths.has(target));
      assert.deepEqual(
        missing,
        [],
        `bin target(s) missing from packed artifact: ${missing.join(", ")}`,
      );
    });

    it("packs the vendored Chart.js bundle (the offline guarantee depends on it shipping)", () => {
      const vendored = packedEntries
        .map((f) => f.path)
        .filter((p) => p.startsWith("public/vendor/") && /chart[^/]*\.js$/i.test(p));
      assert.ok(
        vendored.length > 0,
        "no packed file under public/vendor/ looks like the Chart.js bundle",
      );
    });
  });

  describe("B. fixtures, tests, and dev material are excluded", () => {
    it("packs nothing under tests/, docs/, _trash/, node_modules/, or .claude/", () => {
      const offending = packedEntries
        .map((f) => f.path)
        .filter(
          (p) =>
            p.startsWith("tests/") ||
            p.startsWith("docs/") ||
            p.startsWith("_trash/") ||
            p.startsWith("node_modules/") ||
            p.startsWith(".claude/"),
        );
      assert.deepEqual(
        offending,
        [],
        `dev-only paths leaked into the packed artifact: ${offending.join(", ")}`,
      );
    });

    it("packs no file whose name ends in .test.js", () => {
      const offending = packedEntries.map((f) => f.path).filter((p) => p.endsWith(".test.js"));
      assert.deepEqual(
        offending,
        [],
        `test files leaked into the packed artifact: ${offending.join(", ")}`,
      );
    });
  });

  describe("C. no secrets in the packed set (GATE-FACTORY)", () => {
    it("contains no credential-shaped token in any packed text file", async () => {
      const offenders = [];
      for (const entry of packedEntries) {
        if (BINARY_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
        const content = await fs.readFile(path.join(PROJECT_ROOT, entry.path), "utf8");
        for (const probe of SECRET_PROBES) {
          if (probe.pattern.test(content)) {
            offenders.push(`${entry.path}: ${probe.name}`);
          }
        }
      }
      // The repo deliberately keeps a fixture with credential-shaped PREFIX
      // fragments for the redaction tests (tests/fixtures/...). Section B
      // already proves nothing under tests/ is packed, so that fixture
      // should never reach this loop in the first place. If it — or
      // anything else — does show up here, that is a genuine finding, not
      // a flake to silence.
      assert.deepEqual(
        offenders,
        [],
        `credential-shaped tokens found in packed files: ${offenders.join(", ")}`,
      );
    });
  });

  describe("D. no network references in packed code (supports GATE-OFFLINE)", () => {
    it("packed .js/.html/.css files reference no remote network asset", async () => {
      const offenders = [];
      for (const entry of packedEntries) {
        const ext = path.extname(entry.path).toLowerCase();
        if (![".js", ".html", ".css"].includes(ext)) continue;
        const content = await fs.readFile(path.join(PROJECT_ROOT, entry.path), "utf8");
        for (const re of NETWORK_REFERENCE_PATTERNS) {
          for (const match of content.matchAll(re)) {
            const url = match[1];
            if (!isLoopback(url)) offenders.push(`${entry.path}: ${url}`);
          }
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `remote network reference(s) found in packed code: ${offenders.join(", ")}`,
      );
    });
  });
});

/**
 * BP-007 — `tests/cli.test.js`: `src/cli.js`'s own surface.
 *
 * `tests/server.test.js` exercises `src/server.js`'s HTTP routes end to end
 * (including two smoke tests of `parseArgs`/`listenOnFreePort` at its tail).
 * This file is the dedicated coverage BP-007 asks for: `parseArgs` in full,
 * `listenOnFreePort`'s actual free-port-selection behaviour under a real
 * port conflict, and the BP-010 GATE-PERF bound ("Cold start <3s").
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 * Every server started here gets its own `mkdtemp` home and a stub collector
 * registry, mirroring `tests/server.test.js`'s `launch()` helper — so a
 * `home`/`modules` override can never fall through to the REAL collector
 * registry, which hardcodes `os.homedir()` at import time (see
 * `src/collectors/registry.js`). No test in this file issues an HTTP
 * request, so no route ever actually calls into that registry either way;
 * the override is there so that guarantee does not depend on that staying
 * true forever.
 *
 * ── No real browser, ever ───────────────────────────────────────────────
 * `openBrowser()` is called only from inside `main()`, after
 * `listenOnFreePort` resolves. Every test below calls `listenOnFreePort` or
 * `parseArgs` directly and never `main()` — `main()`'s shutdown handler ends
 * in `process.exit(0)`, which would kill the test runner itself, so running
 * it in-process here is not safe. `parseArgs(["--no-open"])` is exercised as
 * a pure parse (it decides whether `main()` WOULD open a browser), which is
 * the safe extent to which "browser launch" is covered by this file.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { listenOnFreePort, parseArgs, shouldSuppressWarning } from "../src/cli.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "cli.js");

/**
 * Run the real CLI as a real process. Used only for paths that return before
 * any server is bound (`--help`, `clean`) — see the file header on why
 * `main()` is never called in-process here. `SESSION_RX_HOME` is always
 * pinned to a temp dir so a subprocess cannot reach the developer's own
 * `~/.session-rx`.
 */
function runCli(args, { home, expectFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, SESSION_RX_HOME: home ?? os.tmpdir(), SESSION_RX_NO_OPEN: "1" },
      timeout: 20000,
    });
    return { code: 0, stdout };
  } catch (error) {
    if (!expectFailure) throw error;
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * Never expected to actually run in this file: no test below issues an HTTP
 * request, so no route ever calls `load("registry")`. It exists purely as a
 * safety rail — see the file header.
 */
function stubRegistry() {
  return {
    async detectAll() { return []; },
    async collectAll() { return { sessions: [], diagnostics: [] }; },
  };
}

async function isolatedHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "session-rx-cli-test-"));
}

function isolatedOptions(home) {
  return { publicDir: PUBLIC_DIR, home, modules: { registry: stubRegistry() } };
}

/** Get a genuinely free port from the OS without hardcoding a number — this
 * is what keeps this file from ever needing to know or touch 7331. */
async function freePort() {
  const probe = net.createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const servers = [];
async function trackedListen(candidates, options) {
  const running = await listenOnFreePort(candidates, options);
  servers.push(running);
  return running;
}

after(async () => {
  for (const running of servers) {
    try { await running.close(); } catch { /* already closed */ }
  }
});

describe("node warning filter", () => {
  it("suppresses SQLite ExperimentalWarnings", () => {
    assert.equal(shouldSuppressWarning({ name: "ExperimentalWarning", message: "SQLite is an experimental feature" }), true);
  });

  it("does not suppress other ExperimentalWarnings", () => {
    assert.equal(shouldSuppressWarning({ name: "ExperimentalWarning", message: "WebAssembly is experimental" }), false);
  });

  it("does not suppress DeprecationWarnings", () => {
    assert.equal(shouldSuppressWarning({ name: "DeprecationWarning", message: "SQLite API is deprecated" }), false);
  });
});

// ===========================================================================

describe("parseArgs — defaults and flags", () => {
  it("defaults: no port pinned (the candidate list decides), browser opens, no flags set", () => {
    const options = parseArgs([], {});
    assert.equal(options.port, null, "no --port/SESSION_RX_PORT means the CLI's own candidate list picks the port");
    assert.equal(options.scanLimit, null, "no --limit/SESSION_RX_LIMIT means the server default applies");
    assert.equal(options.open, true);
    assert.equal(options.help, false);
    assert.equal(options.version, false);
    assert.equal(options.hostInfo, false);
  });

  it("--port N is honoured, as --port N and as --port=N", () => {
    assert.equal(parseArgs(["--port", "7415"]).port, 7415);
    assert.equal(parseArgs(["--port=7415"]).port, 7415);
  });

  it("SESSION_RX_PORT env is honoured, and an explicit --port overrides it", () => {
    assert.equal(parseArgs([], { SESSION_RX_PORT: "7420" }).port, 7420);
    assert.equal(parseArgs(["--port", "7425"], { SESSION_RX_PORT: "7420" }).port, 7425);
  });

  it("--limit N is honoured, as --limit N and as --limit=N", () => {
    assert.equal(parseArgs(["--limit", "1000"]).scanLimit, 1000);
    assert.equal(parseArgs(["--limit=1000"]).scanLimit, 1000);
  });

  it("SESSION_RX_LIMIT env is honoured, and an explicit --limit overrides it", () => {
    assert.equal(parseArgs([], { SESSION_RX_LIMIT: "1200" }).scanLimit, 1200);
    assert.equal(parseArgs(["--limit", "1000"], { SESSION_RX_LIMIT: "1200" }).scanLimit, 1000);
  });

  it("--no-open suppresses opening a browser — the real flag name, read from src/cli.js", () => {
    assert.equal(parseArgs(["--no-open"]).open, false);
    assert.equal(parseArgs(["--no-open", "--open"]).open, true, "a later explicit --open re-enables it");
  });

  it("SESSION_RX_NO_OPEN=1 or =true implies --no-open; any other value does not", () => {
    assert.equal(parseArgs([], { SESSION_RX_NO_OPEN: "1" }).open, false);
    assert.equal(parseArgs([], { SESSION_RX_NO_OPEN: "true" }).open, false);
    assert.equal(parseArgs([], { SESSION_RX_NO_OPEN: "0" }).open, true);
    assert.equal(parseArgs([], { SESSION_RX_NO_OPEN: "yes" }).open, true);
  });

  it("--help/-h, --version/-v and --host-info each set their own flag only", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--version"]).version, true);
    assert.equal(parseArgs(["-v"]).version, true);
    assert.equal(parseArgs(["--host-info"]).hostInfo, true);
  });

  it("an unknown option throws, naming the option", () => {
    assert.throws(() => parseArgs(["--nonsense"]), /unknown option: --nonsense/);
  });
});

describe("parseArgs — invalid ports are rejected, not silently coerced", () => {
  // This documents src/cli.js's ACTUAL behaviour (its unexported `readPort`
  // helper): every case below is a hard throw, from both --port and
  // SESSION_RX_PORT. There is no silent coercion anywhere in this path.
  it("a non-numeric port throws 'needs a port number'", () => {
    assert.throws(() => parseArgs(["--port", "nope"]), /needs a port number/);
  });

  it("port 0 is REJECTED by the CLI, even though 0 means 'OS, pick one' internally", () => {
    // "0" matches readPort's own /^\d+$/ digits-only check, so it is NOT
    // caught there — it fails the very next `port < 1` bound instead.
    // --port 0 therefore cannot be used to ask for an OS-picked port;
    // omitting --port entirely is the only way to get that behaviour.
    assert.throws(() => parseArgs(["--port", "0"]), /between 1 and 65535/);
  });

  it("a negative port throws — the leading '-' fails the digits-only check, not the range check", () => {
    assert.throws(() => parseArgs(["--port", "-1"]), /needs a port number/);
  });

  it("a port above 65535 throws 'between 1 and 65535'", () => {
    assert.throws(() => parseArgs(["--port", "70000"]), /between 1 and 65535/);
  });

  it("the same validation applies via SESSION_RX_PORT, not only --port", () => {
    assert.throws(() => parseArgs([], { SESSION_RX_PORT: "0" }), /between 1 and 65535/);
    assert.throws(() => parseArgs([], { SESSION_RX_PORT: "abc" }), /needs a port number/);
  });
});

describe("parseArgs — invalid scan limits are rejected, not silently defaulted", () => {
  it("rejects zero, negatives, non-numeric, and empty values", () => {
    for (const value of ["0", "-5", "abc", ""]) {
      assert.throws(() => parseArgs(["--limit", value]), /--limit .*positive integer/);
    }
  });

  it("rejects the same invalid values from SESSION_RX_LIMIT", () => {
    for (const value of ["0", "-5", "abc", ""]) {
      assert.throws(() => parseArgs([], { SESSION_RX_LIMIT: value }), /SESSION_RX_LIMIT .*positive integer/);
    }
  });
});

describe("listenOnFreePort — free-port selection", () => {
  it("returns a listening server on an available port", async () => {
    const home = await isolatedHome();
    const running = await trackedListen([0], isolatedOptions(home));
    assert.ok(running.server.address(), "the server must actually be bound");
    assert.equal(running.host, "127.0.0.1");
    assert.ok(running.port > 0);
  });

  it("skips a port a third party already holds, and does not hand it back", async () => {
    const occupiedPort = await freePort();
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(occupiedPort, "127.0.0.1", resolve);
    });
    try {
      const home = await isolatedHome();
      const running = await trackedListen([occupiedPort, 0], isolatedOptions(home));
      assert.notEqual(running.port, occupiedPort, "listenOnFreePort must not hand back a port someone else already holds");
      assert.ok(running.server.address());
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("if every candidate is occupied, it rejects with EADDRINUSE rather than binding an unrelated port", async () => {
    const occupiedPort = await freePort();
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(occupiedPort, "127.0.0.1", resolve);
    });
    try {
      const home = await isolatedHome();
      await assert.rejects(
        listenOnFreePort([occupiedPort], isolatedOptions(home)),
        (error) => error.code === "EADDRINUSE",
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe("BP-010 GATE-PERF — cold start under three seconds (fixture mode)", () => {
  // Measures the same startup path main() uses — listenOnFreePort ->
  // startServer -> app.listen — timed from just before the call to the
  // moment the server reports itself listening. main() itself is not
  // called: its browser-open step and its process.exit-based shutdown are
  // both outside what GATE-PERF measures, and running main() in-process
  // here would risk exiting the test runner (see file header). Collectors
  // are stubbed and home is a fresh temp dir, so this number cannot depend
  // on how large the developer's real session corpus is.
  it("becomes ready in under 3000ms", async () => {
    const home = await isolatedHome();
    const startedAt = process.hrtime.bigint();
    const running = await trackedListen([0], isolatedOptions(home));
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(running.server.address(), "the server must actually be listening before the clock is trusted");
    assert.ok(
      elapsedMs < 3000,
      `cold start took ${elapsedMs.toFixed(1)}ms, must be under 3000ms per BP-010 GATE-PERF`,
    );
  });
});

describe("parseArgs — subcommands", () => {
  // `clean` is the first and only subcommand. The mechanism is deliberately
  // small: the first argument is a command only if it is a known verb, and
  // everything else keeps parsing exactly as it did when the CLI was flags
  // only. The two tests below are the regression proof of that second half.
  it("no subcommand means serve — bare `session-rx` behaves exactly as before", () => {
    const options = parseArgs([], {});
    assert.equal(options.command, "serve");
    assert.equal(options.port, null);
    assert.equal(options.open, true);
    assert.equal(options.yes, false);
  });

  it("`session-rx --port N` is still the server, with the port pinned", () => {
    const options = parseArgs(["--port", "7415"], {});
    assert.equal(options.command, "serve");
    assert.equal(options.port, 7415);
    assert.equal(options.open, true);
  });

  it("`clean` selects the command and defaults to the dry run", () => {
    const options = parseArgs(["clean"], {});
    assert.equal(options.command, "clean");
    assert.equal(options.yes, false, "clean must never perform anything without --yes");
  });

  it("`clean --yes` (and `-y`) arms the removal", () => {
    assert.equal(parseArgs(["clean", "--yes"]).yes, true);
    assert.equal(parseArgs(["clean", "-y"]).yes, true);
  });

  it("`clean --help` asks for the usage text rather than cleaning anything", () => {
    const options = parseArgs(["clean", "--help"]);
    assert.equal(options.command, "clean");
    assert.equal(options.help, true);
    assert.equal(options.yes, false);
  });

  it("an unknown flag after `clean` throws, naming the subcommand", () => {
    assert.throws(() => parseArgs(["clean", "--force"]), /unknown option for `session-rx clean`: --force/);
  });

  it("--yes is a clean-only flag: it is not a server flag", () => {
    assert.throws(() => parseArgs(["--yes"]), /unknown option: --yes/);
  });

  it("SESSION_RX_PORT is not consulted for clean — it binds nothing", () => {
    const options = parseArgs(["clean"], { SESSION_RX_PORT: "7420" });
    assert.equal(options.command, "clean");
    assert.equal(options.port, null);
  });
});

describe("the CLI as a real process — help and clean", () => {
  it("--help lists the clean command, what performs it, and what it costs", () => {
    const { code, stdout } = runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /session-rx clean \[--yes\]/, "usage must show the subcommand");
    assert.match(stdout, /clean\s+remove SessionRx's own undo history/);
    assert.match(stdout, /can no longer be undone/, "--help must say what cleaning costs");
  });

  it("`clean` against a home with no state directory exits 0 and starts no server", async () => {
    const home = await isolatedHome();
    const { code, stdout } = runCli(["clean"], { home });
    assert.equal(code, 0, "a missing state directory is not an error");
    assert.match(stdout, /Nothing to clean/);
    assert.ok(!/is serving/.test(stdout), "clean must return before anything is bound");
  });
});

// ---------------------------------------------------------------------------
// The safety proof, asserted last (mirrors tests/server.test.js's own).
// ---------------------------------------------------------------------------

describe("real-file safety (this file's own proof)", () => {
  it("every server started in this file was pointed at a temp home, never the real one", () => {
    assert.ok(servers.length > 0, "this file must have started at least one server to prove anything");
    for (const running of servers) {
      assert.notEqual(running.state.home, os.homedir());
      assert.ok(running.state.home.startsWith(os.tmpdir()), `${running.state.home} is not a temp dir`);
    }
  });
});

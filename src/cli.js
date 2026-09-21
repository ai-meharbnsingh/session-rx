#!/usr/bin/env node
/**
 * `npx session-rx` — start the local SessionRx server and open it.
 *
 * Nothing here talks to the network: the server binds 127.0.0.1 only, and the
 * only outbound action is asking the OS to open a loopback URL in a browser.
 *
 * The port is never hardcoded. A short candidate list is tried in order and an
 * already-taken port falls through to the next one; if every candidate is taken
 * the OS picks a free ephemeral port. `--port` / `SESSION_RX_PORT` pin one
 * explicitly, and pinning a taken port is a hard error rather than a silent
 * move to a different port the user was not told about.
 *
 * If a browser cannot be opened — headless box, SSH session, container — the
 * URL is printed and the server KEEPS SERVING. Being unable to open a browser
 * is not a reason to refuse to serve.
 */

import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { STATE_DIR_NAME } from "./fixes/base.js";
import { runCleanCommand } from "./fixes/clean.js";
import { startServer } from "./server.js";

const STARTED_AT = process.hrtime.bigint();

/** First choice, then fallbacks, then `0` = "OS, give me anything free". */
const PORT_CANDIDATES = [7331, 7332, 7431, 7531, 0];

/**
 * Subcommands, kept as a plain set on purpose.
 *
 * `session-rx` started life as flags only, and the first word of `argv` being
 * a verb rather than a flag is the entire mechanism: if it is in this set it
 * names the command and the remaining arguments are parsed as that command's
 * flags, otherwise the whole of `argv` is parsed exactly as before and the
 * command is `serve`. That keeps `session-rx`, `session-rx --port 7400` and
 * every existing flag byte-identical in behaviour, and it is deliberately not
 * a command framework — one verb does not need a router.
 */
const COMMANDS = new Set(["clean"]);

const USAGE = `SessionRx — diagnose and fix inefficient AI coding sessions.

Usage: session-rx [options]
       session-rx clean [--yes]

Commands:
  clean          remove SessionRx's own undo history in ~/${STATE_DIR_NAME}.
                 Shows what it would remove and stops; --yes performs it.
                 Nothing else ever removes that directory, and once it is
                 gone the fixes already applied can no longer be undone.

Options:
  --port <n>     bind this exact port (fails if it is taken)
  --no-open      do not launch a browser; just print the URL and serve
  --host-info    print the resolved bind address and exit
  -h, --help     show this message
  -v, --version  print the package version

Environment:
  SESSION_RX_PORT     same as --port
  SESSION_RX_NO_OPEN  set to 1 to imply --no-open
  SESSION_RX_HOME     resolve fix targets under this home instead of $HOME

SessionRx binds 127.0.0.1 only and reads local session files. It makes no
network requests.`;

export function parseArgs(argv, env = {}) {
  const options = {
    command: "serve",
    port: null,
    open: env.SESSION_RX_NO_OPEN !== "1" && env.SESSION_RX_NO_OPEN !== "true",
    help: false,
    version: false,
    hostInfo: false,
    yes: false,
  };

  let flags = argv;
  if (argv.length > 0 && COMMANDS.has(argv[0])) {
    options.command = argv[0];
    flags = argv.slice(1);
  }

  if (options.command === "serve" && typeof env.SESSION_RX_PORT === "string" && env.SESSION_RX_PORT !== "") {
    options.port = readPort(env.SESSION_RX_PORT, "SESSION_RX_PORT");
  }
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i];
    if (options.command === "clean") {
      if (arg === "--yes" || arg === "-y") options.yes = true;
      else if (arg === "-h" || arg === "--help") options.help = true;
      else throw new Error(`unknown option for \`session-rx clean\`: ${arg}\n\n${USAGE}`);
      continue;
    }
    if (arg === "--no-open") options.open = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--host-info") options.hostInfo = true;
    else if (arg === "--port") {
      options.port = readPort(flags[i + 1], "--port");
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = readPort(arg.slice("--port=".length), "--port");
    } else {
      throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

function readPort(raw, label) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`${label} needs a port number, got: ${raw ?? "(nothing)"}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`${label} must be between 1 and 65535, got ${port}`);
  return port;
}

/**
 * Try each candidate in order. `EADDRINUSE` and `EACCES` mean "someone else has
 * it" and move on; anything else is a real failure and is re-thrown.
 */
export async function listenOnFreePort(candidates, options = {}) {
  let lastError = null;
  for (const port of candidates) {
    try {
      return await startServer({ ...options, port });
    } catch (error) {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("no port could be bound");
}

async function readVersion() {
  try {
    const url = new URL("../package.json", import.meta.url);
    const { default: fs } = await import("node:fs/promises");
    const parsed = JSON.parse(await fs.readFile(url, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Open the URL, or explain why it could not be opened and carry on serving. */
async function openBrowser(url) {
  try {
    const { default: open } = await import("open");
    await open(url);
    return { opened: true };
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  if (options.command === "clean") {
    // No server, no browser, no port: clean only ever touches the state
    // directory, so it returns before anything is bound or opened.
    return runCleanCommand({ home: env.SESSION_RX_HOME, yes: options.yes });
  }

  const candidates = options.port === null ? PORT_CANDIDATES : [options.port];
  let running;
  try {
    running = await listenOnFreePort(candidates);
  } catch (error) {
    const code = error?.code ?? "";
    const hint = code === "EADDRINUSE" && options.port !== null
      ? `port ${options.port} is already in use — omit --port to let SessionRx pick a free one`
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`SessionRx could not start: ${hint}\n`);
    return 1;
  }

  const elapsedMs = Number(process.hrtime.bigint() - STARTED_AT) / 1e6;

  if (options.hostInfo) {
    // Deliberately no nonce: it is never printed, logged, or written to disk.
    process.stdout.write(`${JSON.stringify({ host: running.host, port: running.port, url: running.url, readyMs: Math.round(elapsedMs) })}\n`);
    await running.close();
    return 0;
  }

  process.stdout.write(`SessionRx is serving ${running.url}\n`);
  process.stdout.write(`Ready in ${elapsedMs.toFixed(0)} ms — local only, no network requests. Press Ctrl+C to stop.\n`);

  if (options.open) {
    const result = await openBrowser(running.url);
    if (!result.opened) {
      process.stdout.write(`Could not open a browser (${result.reason}). Open ${running.url} yourself; SessionRx keeps serving.\n`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nStopping SessionRx (${signal})…\n`);
    try {
      await running.close();
    } catch {
      // A socket that refuses to close cleanly must not turn Ctrl+C into a hang.
    }
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Resolves only on shutdown; `process.exit` above is what actually ends it.
  return new Promise(() => {});
}

/**
 * True only when this file IS the entry point. `realpath` matters: `npx` and
 * `npm link` invoke a `node_modules/.bin` symlink, so a raw path comparison
 * would decide the CLI was merely imported and start nothing.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main();
  if (typeof code === "number") process.exit(code);
}

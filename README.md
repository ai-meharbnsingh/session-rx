# SessionRx

Diagnose and fix inefficient AI coding sessions. Local, private, one command.

## Install

```
npx session-rx
```

Requires Node.js 22.13 or newer — SessionRx reads Cursor's database with the
SQLite support built into Node, which earlier versions do not have. The command
picks a free loopback port, starts a local server, and opens your browser.
`--port <n>` binds an exact port, `--limit <n>` and `SESSION_RX_LIMIT` set how
many sessions are read per CLI, and `--no-open` just prints the URL. A larger
limit reads further back and takes longer. `--help` lists the rest.

```
npx session-rx clean
```

Removes the backups that earlier versions of SessionRx (which could apply
fixes) left in `~/.session-rx/`. It prints what it would remove and stops;
`--yes` performs it. Your own files are left exactly as they are.

## What it does

It reads the session logs your AI coding CLIs already write, runs six health
checks against each recent session, and offers suggestions for the ones that
find problems. The six checks diagnose whether your session got too full, whether you re-read the same material instead of reusing it, whether you ran the same command again and again, whether commands returned very long output, whether your session was long and kept growing, and whether you had too many helper agents at once. A date-range
selector in the header lets you filter results by the last 15 days, 30 days, 3
months, or all time without changing the verdicts.

![Overview showing a date-range selector, a line stating how many sessions the window holds and that the scan was not complete, the CLIs detected on this machine, and four summary cards — sessions analyzed marked as a floor because the scan hit its limit, problems found, distinct fixes available noted as Claude Code only, and checks that could not be measured — each with its unit named and its comparison marked not comparable, above a Health summary beside Trends showing the share of measured checks that passed with the unmeasured count kept outside it](https://raw.githubusercontent.com/ai-meharbnsingh/session-rx/main/docs/assets/screenshot-overview.png)

*Screenshots show an earlier version of SessionRx.*

### Every check returns one of three answers

This is the part most likely to mislead you, so it comes first.

| Verdict | What it means | Is it a pass? |
|---|---|---|
| `observed` | a problem was found, with the numbers that show it | no |
| `not-observed` | the check ran and found nothing wrong | yes |
| `unknown` | the check could not run — the log does not record what it needs | **no** |

![One session card displaying all three verdict types: a problem found row in amber with Preview/Apply buttons, a could not be measured row in hatched grey stating it is not a pass, and four passed rows in green, with header showing 4/6 checks passed, 1 problem observed, 1 could not be measured](https://raw.githubusercontent.com/ai-meharbnsingh/session-rx/main/docs/assets/screenshot-health.png)

*This is one real session; the grey row is a check that could not run, not a pass.*

`unknown` is not a pass. It is the tool refusing to turn an absence of evidence
into a clean bill of health, and it always carries a sentence saying what could
not be read. A blank check is not a healthy check.

It is also the most common answer. Measured on one developer machine on
2026-09-20, at the default scan — 1,236 sessions across five CLIs, 7,416
verdicts. That measurement was taken before Gemini CLI, Kimi, and OpenCode support were removed.

| | count | share |
|---|---|---|
| `not-observed` — a genuine pass | 3,149 | 42% |
| `unknown` — could not be measured | 3,772 | 51% |
| `observed` — a real problem found | 495 | 7% |

Your numbers will differ, because they depend entirely on which CLIs you use
and what those CLIs record. On that machine the unknown share ran from 20%
(Codex) to 100% (Gemini). A report where half the boxes say "could not
measure" is the normal, honest case, not a malfunction. Printing `0` and a
green tick instead is the thing this tool exists not to do.

### The Health page

One card per session, one line per check, with the suggestion on its own line:

```
CODEX  01a0bebe-3ce5-79b3-8130-132d288e…                  4m | 26 turns
[████████████████░░░░░░░░░░░░░░░░]
3/6 checks passed · 2 problems observed · 1 could not be measured
1 of 6 checks could not be measured on this session. Those are not passes
— each one says below why it could not run.

  ! Ran the same command again and again
                         identical tool call + input + result, most
                         repeated 7 times            [! PROBLEM FOUND]
    → View suggestion and copy text for Codex

  ? Too many helper agents at once               [? COULD NOT BE MEASURED]
    Not measured. This is NOT a pass — the check could not run here.
    Codex's logs don't record which turns belonged to a sub-agent or
    which parent started them, so there is no way to tell whether two
    were running at the same time. Claude Code does record it, so this
    check produces a real result on a Claude session.

  ✓ Long session that kept growing  session elapsed: 0.07 hours       [✓ PASSED]
  ✓ Conversation got too full     average per-turn context: 52,612 tokens
  ✓ Re-read the same material instead of reusing it        cache hit rate: 100.0%
```

Each line has a `why` and an `evidence` disclosure. `why` gives the threshold
and how it was derived; `evidence` gives the files and record counts the
number came from. The score, the unknown sentence and the suggestion button are
never behind a click.

## Supported CLIs

"Supported" is not one thing. What a check can answer depends on what the CLI
writes down, so each row says what it can and cannot support.

| CLI | Log location | What it supports |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, plus `…/<session-uuid>/subagents/agent-*.jsonl` | All six checks. Sub-agent concurrency is read from the separate sub-agent transcripts, which is the only place that activity is recorded. Context windows come from a model-id table, overridden by observation where a session demonstrably held more than the table allows — see Limitations. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl` | Five of six. The context window is stated by the CLI itself (`model_context_window`), which is the most reliable source there is. Nothing in its records establishes a sub-agent interval, so that check always reports `unknown`. |
| Cursor CLI | `~/.cursor/chats/<md5-of-cwd>/<chat-id>/store.db` (SQLite, opened read-only) plus the transcript at `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl` | Zero of six. Cursor does not persist per-turn token counts anywhere on disk — only in memory — so context pressure, cache hit rate, and long rising context cannot be measured and report `unknown`. It also discards tool results from its transcript, so the large-result check reports `unknown` too. What it does provide: the session list, the project, the model last used, turn count with timestamps (so duration is real), and the names of tools each turn called. Cursor reports its own context window size, which is better than a lookup table. Its chat metadata includes an encryption key, which SessionRx strips before reading the row, so it never reaches the report or UI. |
| Antigravity CLI | `~/.gemini/antigravity-cli` and `~/.gemini/antigravity` | Detected only. No on-disk format has been confirmed from real files, so no sessions are read yet. When real files are examined and the format confirmed, this can become a full parser. |

## Platform support

SessionRx runs on macOS, Linux and Windows. Node.js 22.13 or newer is the only requirement — there is no platform-specific code in the project. Every path is built from `os.homedir()` and `path.join`, and every CLI stores its data in the same home-relative folder on all three platforms (`%USERPROFILE%\.claude` on Windows is the same `~/.claude`).

Where a CLI documents an environment variable for relocating its data, SessionRx honours it. One honest caveat: reading a SQLite database in WAL mode read-only requires its `-shm` sidecar present and readable, which is true on every platform but noisier on Windows. When that fails the CLI reports `unknown` with the reason; it is never reported as a clean result.

| CLI | Relocation variable honoured |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Codex | `CODEX_HOME` |
| Cursor CLI | `CURSOR_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CURSOR_DATA_DIR` |

## How suggestions work

SessionRx never writes your files. When it finds a problem, it shows you a
suggestion: a preview of the exact text to add and a ready-made request you can
copy and paste into your own AI tool (Claude Code, Codex, Cursor, or Antigravity).

- **View suggestion** shows the exact text that would address the problem, which
  CLI's configuration it would go into (global or project-level), and a toggle
  between "Global" and "Project" scope.
- **Copy request** copies a message you can paste directly into your AI tool.
  Your AI tool then makes the change itself, and you approve it there.
- SessionRx reads (never writes) the global file to see whether a suggestion
  is already there, and says "already added" if so. A project file depends on
  which folder you are in, so for Project it says it cannot tell.

Where each request points:

| Tool | Global (all projects) | Project (this folder) |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` (settings: `~/.claude/settings.json`) | `./CLAUDE.md` (settings: `./.claude/settings.json`) |
| Codex | `~/.codex/AGENTS.md` (or `AGENTS.override.md` if you have one) | `./AGENTS.md` |
| Cursor | Cursor Settings → Rules → User Rules (paste it yourself; there is no global file) | `./AGENTS.md` |
| Antigravity | `~/.gemini/GEMINI.md` | `./AGENTS.md` |

## Privacy

- Everything runs on your machine.
- No data leaves the machine.
- No accounts, no sign-in.
- No telemetry.
- No AI API calls.
- No remote network requests at all. The page talks only to the SessionRx
  server running on your own machine at `127.0.0.1`, and nothing is requested
  from, or sent to, anywhere else. Chart.js is vendored into the package, so
  the charts work with the network off.
- Session logs are read read-only. SessionRx never writes your files.
- The report includes file paths and project names to make findings traceable,
  so read it before sharing it publicly.

## Limitations

- **The scan is bounded.** By default it reads the 250 newest sessions per
  CLI, because reading every session on a heavily used machine takes
  minutes. Every
  response says how much was read and whether it hit that bound. Widen it with
  `?scan=` on `/api/sessions`, `/api/trends` and `/api/report`, or `?limit=` on
  `/api/health`.
- **The sub-agent check's coverage depends on that width.** A sub-agent
  transcript that falls outside the scanned window cannot be read, so the check
  reports `unknown` for that session rather than inventing a concurrency figure
  from partial evidence. A wider scan yields more verdicts.
- **Sub-agent sessions are set aside, not hidden.** They are analysed in full
  and kept as evidence about the session that dispatched them, but they are not
  listed as sessions you ran and are not in the headline count. How many were
  set aside is stated in the response and on the page — on the machine measured
  above, 1,236 sessions were listed and 448 were set aside as sub-agents.
- **Some window sizes are inferred, and say so.** Where a session demonstrably
  held more context than the model-id table allows, the table is wrong for that
  session and the window is promoted to the smallest known vendor tier that
  fits; where no table entry matched at all, the window shown is the session's
  own observed peak, labelled "at least N". Both are marked as inferred in the
  UI, and a lower bound never becomes a percentage.

## Built by

Adaptive Mind

## License

MIT

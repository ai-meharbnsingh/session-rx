# SessionRx

Diagnose and fix inefficient AI coding sessions. Local, private, one command.

## Install

```
npx session-rx
```

Requires Node.js 22.13 or newer — SessionRx reads OpenCode's database with the
SQLite support built into Node, which earlier versions do not have. The command
picks a free loopback port, starts a local server, and opens your browser.
`--port <n>` binds an exact port, `--no-open` just prints the URL, and `--help`
lists the rest.

```
npx session-rx clean
```

Removes SessionRx's own undo history in `~/.session-rx/`. It prints what it
would remove and stops; `--yes` performs it. Once that history is gone, the
fixes SessionRx has already applied can no longer be undone by SessionRx —
your own files are left exactly as they are either way.

## What it does

It reads the session logs your AI coding CLIs already write, runs six health
checks against each recent session, and offers a local fix for the ones that
fail. The six checks are context pressure, cache hit rate, repeated tool work,
large tool results, long rising context, and sub-agent concurrency. A date-range
selector in the header lets you filter results by the last 15 days, 30 days, 3
months, or all time without changing the verdicts.

![Overview showing a date-range selector, a line stating how many sessions the window holds and that the scan was not complete, the CLIs detected on this machine, and four summary cards — sessions analyzed marked as a floor because the scan hit its limit, problems found, distinct fixes available noted as Claude Code only, and checks that could not be measured — each with its unit named and its comparison marked not comparable, above a Health summary beside Trends showing the share of measured checks that passed with the unmeasured count kept outside it](https://raw.githubusercontent.com/ai-meharbnsingh/session-rx/main/docs/assets/screenshot-overview.png)

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
verdicts:

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

One card per session, one line per check, with the fix offer on its own line:

```
CODEX  01a0bebe-3ce5-79b3-8130-132d288e…                  4m | 26 turns
[████████████████░░░░░░░░░░░░░░░░]
3/6 checks passed · 2 problems observed · 1 could not be measured
1 of 6 checks could not be measured on this session. Those are not passes
— each one says below why it could not run.

  ! Repeated tool work   identical tool call + input + result, most
                         repeated 7 times            [! PROBLEM FOUND]
    → Batch commands instruction     [Preview] [Apply] [Skip]

  ? High sub-agent concurrency               [? COULD NOT BE MEASURED]
    Not measured. This is NOT a pass — the check could not run here.
    Codex's logs don't record which turns belonged to a sub-agent or
    which parent started them, so there is no way to tell whether two
    were running at the same time. Claude Code does record it, so this
    check produces a real result on a Claude session.

  ✓ Long rising context  session elapsed: 0.07 hours       [✓ PASSED]
  ✓ Context pressure     average per-turn context: 52,612 tokens
  ✓ Low cache hit        cache hit rate: 100.0%
```

Each line has a `why` and an `evidence` disclosure. `why` gives the threshold
and how it was derived; `evidence` gives the files and record counts the
number came from. The score, the unknown sentence and the fix buttons are
never behind a click.

## Supported CLIs

"Supported" is not one thing. What a check can answer depends on what the CLI
writes down, so each row says what it can and cannot support.

| CLI | Log location | What it supports |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, plus `…/<session-uuid>/subagents/agent-*.jsonl` | All six checks. Sub-agent concurrency is read from the separate sub-agent transcripts, which is the only place that activity is recorded. Context windows come from a model-id table, overridden by observation where a session demonstrably held more than the table allows — see Limitations. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl` | Five of six. The context window is stated by the CLI itself (`model_context_window`), which is the most reliable source there is. Nothing in its records establishes a sub-agent interval, so that check always reports `unknown`. |
| Gemini CLI | `~/.gemini/tmp/<project-slug>/chats/session-<ISO>-<id>.jsonl` | Context pressure and long rising context work. Its records prove that a tool was *called* but carry no stable tool-result contract and no result byte length, so on a session that actually calls tools the repeated-work and large-result checks report `unknown`; cache counters are absent too, and nothing in its records ties a sub-agent back to the session that started it. It also writes a session file per invocation, most of which hold no exchange at all — on the machine measured above, 508 of 510 files had no turn to read, and those sessions report `unknown` on every check. |
| Kimi | `~/.kimi/sessions/<workspace-hash>/<session-uuid>/wire.jsonl` | All six can produce a verdict, with one caveat: Kimi reports a context *fraction* and no absolute window, so the card shows no token window and no token count is invented from the percentage. The context check still works, from the fraction. Sub-agent intervals come from its `SubagentEvent` records. |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite, opened read-only) | Five of six. Its model ids are not in any published window table, so the window shown is a *measured lower bound* from the session's own peak ("at least 64,329 tokens"). Dividing that peak by itself is 1.0 for every session by construction, so no context percentage and no context verdict is derived from it — that check reports `unknown` rather than warning on every session. |
| GitHub Copilot CLI | `~/.copilot/` (`config.json`, `logs/process-<epoch>-<pid>.log`) | Detected only. Its logs carry no transcript, so there is nothing to check and no session is invented for it. |
| Grok Build CLI | `~/.grok`, `~/.config/grok` (candidate paths) | Detected only, if the directory exists. The log format is unconfirmed and no parser was written on a guess. |
| Amp | `~/.amp`, `~/.config/amp`, `~/.cache/amp` (candidate paths) | Detected only, on the same terms as Grok. |

## How fixes work

Every fix is Preview, then Apply, then Undo.

- **Preview** shows the exact diff, the files it touches, and nothing is
  written. The diff is generated from the same bytes Apply will write.
- **Apply** copies each target file byte-for-byte into
  `~/.session-rx/undo/<timestamp>/` first, then writes.
- **Undo** restores those bytes. It refuses to run if the undo record is
  missing or no longer matches the file it came from. Your files are restored
  exactly; SessionRx keeps its own history under `~/.session-rx/`, which is
  not removed by an undo. Nothing removes that directory on its own —
  `session-rx clean` is the only thing that does, and only when you run it.

Fixes are idempotent. Each one carries a marker, and `check()` reads that
marker, so a fix that is already applied is not offered again and cannot be
applied twice.

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
- Session logs are read read-only. The only writes are the fixes you
  explicitly Apply, and each one is backed up first.
- OpenCode's database is opened read-only and queried against a table
  allowlist that excludes its `account` and `credential` tables, which hold
  plaintext tokens.
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
- **The five fixes only change Claude Code.** They write to
  `~/.claude/settings.json` and `~/.claude/CLAUDE.md`. They are offered against
  findings from any CLI, because the underlying habit is the same, but applying
  one changes Claude Code's behaviour and nothing else.

## Built by

Adaptive Mind

## License

MIT

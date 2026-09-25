---
name: release
description: "Deterministic, reviewed release pipeline for session-rx: full test suite -> independent review of the release diff -> npm pack/smoke test -> version bump/changelog/commit/tag/push/CI wait -> npm-registry verification -> mandatory evidence table. Never publishes without a PASS verdict from a reviewer that is not the writer's own family. Triggers on: 'release', '/release', 'cut a release', 'publish session-rx', 'ship a version'."
version: 1.1.0
---

## §0 PRECONDITIONS

| ID | Check | Command | Required result |
|----|-------|---------|------------------|
| PC-1 | cwd is the session-rx project root | `test -f package.json && grep -q '"name": "session-rx"' package.json` | exit 0 |
| PC-2 | working tree clean before starting | `git status --porcelain` | empty output |
| PC-3 | not BEHIND `origin/main` | `git rev-parse --abbrev-ref HEAD` = `main`; `git fetch origin main --quiet && git rev-list HEAD..origin/main --count` | branch=main, count=0 |
| PC-4 | publish is CI-driven, not local | see `.github/workflows/publish.yml` — trusted OIDC publisher, triggers on `push: tags: 'v*'` | no local `npm publish` is ever run by this skill |

```
PC-3 deliberately does NOT require `origin/main..HEAD` (local-ahead) to be
zero — being ahead of origin/main is the release diff by design: RS-B
reviews exactly `origin/main..HEAD`, and RS-D's own `git push origin main`
is what carries those commits onto origin/main. A reviewer may flag this
as "silently including unreviewed commits" — it does not: whatever is
locally ahead of origin/main IS what RS-B reviews, by definition of the
diff range used throughout this skill.
```
FAIL ANY PC -> STOP, report which check failed, do not proceed to RS-A.
```

## §1 INVOCATION MODES

| Mode | Invocation | Env vars set | RS-A | RS-B | RS-C | RS-D | RS-E | RS-F |
|------|-----------|------|------|------|------|------|------|------|
| Live | `/release [--minor\|--major]` (default: patch bump) | `RELEASE_BUMP=minor\|major` (omit for patch); `RELEASE_DRY_RUN` unset | real | real | real | real: bump+changelog+commit+tag+push+CI-wait | real: npm view check | real, DONE gate applies |
| Dry run | `/release --dry-run` | `RELEASE_DRY_RUN=1` | real | real | real | PREVIEW ONLY (see the `RELEASE_DRY_RUN` block in RS-D): prints the would-be version bump and the raw commit list the CHANGELOG entry is drafted from, then exits — no `npm version`, `git commit`, `git tag`, or `git push` | SKIPPED (dry-run) — nothing was pushed, so nothing to verify | required, rows for D/E marked `SKIPPED (dry-run)` |

```
WHY: .github/workflows/publish.yml fires "Publish to npm" on any `v*` tag push
and runs `npm publish --provenance --access public` via OIDC trusted
publishing. A real `git push` of a version-bump commit to main only
triggers the harmless Tests workflow, but a real tag push is a real
publish. Dry run therefore never runs `git commit`/`git tag`/`git push` at
all, so it cannot accidentally cut or leave behind a stray local release
artifact. "Without publishing" (operator instruction) = no git push, no tag,
no npm registry interaction anywhere in dry-run mode.
```

## §2 STEPS

### RS-A — Full test suite

```bash
SCRATCH="${CLAUDE_SCRATCHPAD:-/tmp}"
set -o pipefail
npm test 2>&1 | tee "$SCRATCH/release_test_output.txt"
TEST_EXIT=$?
echo "EXIT:$TEST_EXIT"
```

| ID | Rule |
|----|------|
| A-1 | `[ "$TEST_EXIT" -ne 0 ]` -> ABORT the whole release; do not proceed to RS-B. Capture the exit code into a variable BEFORE any further command runs — a bare trailing `echo "EXIT:$?"` always itself exits 0, so a caller checking the block's own exit status would see success even when the tests failed. This is a real bug a reviewer caught in an earlier draft; do not reintroduce it. |
| A-2 | `release_test_output.txt` lives in the session scratchpad, never the repo root — an evidence file sitting in the working tree (even temporarily, even if moved to `_trash/` afterward) is a real "writes to the user's tree" complaint, and reviewers will correctly flag it |

### RS-B — Independent review of the release diff

```bash
SCRATCH="${CLAUDE_SCRATCHPAD:-/tmp}"
git diff origin/main...HEAD --stat
git diff origin/main...HEAD > "$SCRATCH/release_diff.patch"
git log origin/main..HEAD --format='%B'                  # writer-detection input
```

**RM-1 — writer-of-diff detection** (never guessed, always read from commit trailers of the commits being released):

| Trailer found in `git log origin/main..HEAD --format='%B'` | writer |
|---|---|
| `Co-Authored-By: Claude` (any Claude model) | Claude |
| `Co-Authored-By: Codex` / `Co-Authored-By: codex-cli` | Codex |
| both present, or neither present | STOP — ask the operator which family wrote this diff; do not guess |

**RM-2 — reviewer order by writer** (a reviewer must never be the writer's own family; corrected 2026-09-25 per operator: agy before Opus, never Opus before agy):

| Writer | 1st reviewer | 2nd reviewer (only if 1st gives no verdict) |
|---|---|---|
| Codex | **agy** with Gemini 3.1 Pro | **Opus** (Agent tool, `model: "opus"`) |
| Claude | **Codex Sol** (`codex review`, Codex's own non-interactive review mode) | **agy** (default model) |

```
RULE: never invoke the 2nd reviewer unless the 1st produced NO verdict
(RM-4). Never skip straight to the 2nd. Never invoke Opus before agy has
been tried, for either writer branch.
```

**Review prompt template** — write it to a file in the session scratchpad
FIRST (never the repo root — an evidence artifact left in the working tree
is exactly the "writes user files" complaint a reviewer will correctly
raise); every reviewer invocation below depends on this file existing:

```bash
SCRATCH="${CLAUDE_SCRATCHPAD:-/tmp}"   # session scratchpad if set, else /tmp
SHA=$(git rev-parse HEAD)
cat > "$SCRATCH/review_prompt.txt" <<EOF
Review commit $SHA in this repository (run 'git show $SHA' yourself, or use
the embedded diff below if your tool cannot run shell commands) for
correctness and contract compliance.

Check specifically: the Honesty Contract (verdict is always observed |
not-observed | unknown -- never a fourth state, never null-as-0), the
Suggestion Contract (no file writes, byte-for-byte preview text, append-only
requests, idempotence marker check), read-only collector guarantees
(createReadStream / SQLite opened mode=ro), and the no-network rule (no
fetch/require('http'), no CDN <script>, Chart.js stays vendored).

End your review with exactly one line, verbatim, nothing else on that line:
VERDICT: PASS
VERDICT: FIX
VERDICT: BLOCK
EOF
```

| ID | Rule |
|----|------|
| RB-1 | if the reviewer tool cannot be granted shell/command permission in non-interactive mode (headless `--print`/`exec` modes commonly can't prompt for a permission grant), append the diff itself (`git show --format=fuller "$SHA"`) to the prompt file instead of asking the reviewer to run `git show` — never grant a blanket `--dangerously-skip-permissions`/sandbox-bypass flag just to let a reviewer shell out; that is a bigger risk than the review is worth |

**Grounded invocation commands** (`$SCRATCH` as defined above):

```bash
# agy (with Gemini 3.1 Pro) — verified model id via `agy models`
agy --print --model gemini-3.1-pro-high "$(cat "$SCRATCH/review_prompt.txt")" > "$SCRATCH/release_review_agy.txt" 2>&1

# Codex Sol = codex's own non-interactive review subcommand.
# NOTE: --base/--uncommitted/--commit are MUTUALLY EXCLUSIVE with a custom
# PROMPT argument (verified: `codex review --base X -` errors "cannot be
# used with '[PROMPT]'"). Use the self-contained prompt file (which already
# names the commit and, if RB-1 applied, embeds the diff) with NO scope flag:
codex review - < "$SCRATCH/review_prompt.txt" > "$SCRATCH/release_review_codex.txt" 2>&1

# Opus fallback = Agent tool call, model: "opus", NOT a CLI — write its
# report to "$SCRATCH/release_review_opus.txt" via the agent's own file write
```

| ID | Rule |
|----|------|
| RM-3 | review file must contain exactly one `VERDICT: (PASS\|FIX\|BLOCK)` line: `grep -Eo 'VERDICT: (PASS\|FIX\|BLOCK)' <file>` returns exactly 1 line |
| RM-4 | `grep -iE '429\|quota\|rate.?limit\|resource_exhausted\|unavailable\|\b50[0-9]\b'` matching anywhere in the review file, OR zero/more-than-one VERDICT lines, = **no verdict** -> try the 2nd reviewer in RM-2's order; if the 2nd also gives no verdict -> STOP and ask the operator |
| RM-4a | a transient `UNAVAILABLE`/`50x` from the CLI itself (not the model's review content) may be retried once after a short wait before counting as "no verdict" — a genuine model-authored review is worth one retry, a formatting failure (missing VERDICT line) is not, and is not retried |
| RM-5 | no reviewer available at all (both binaries missing / both Agent calls fail, or both give no verdict after RM-4/RM-4a) -> STOP and ask the operator; never proceed on an assumed PASS |
| RM-6 | `VERDICT: FIX` or `VERDICT: BLOCK` -> STOP, report the reviewer's findings verbatim, fix them, commit the fix as a NEW commit, and re-run RS-B against the new commit before proceeding to RS-C. A FIX/BLOCK verdict is never overridden to keep a demonstration or dry-run moving. |

### RS-C — npm pack + smoke test

```bash
SCRATCH="${CLAUDE_SCRATCHPAD:-/tmp}"
npm pack --pack-destination "$SCRATCH"
TARBALL=$(ls -t "$SCRATCH"/session-rx-*.tgz | head -1)
mkdir -p "$SCRATCH/session-rx-smoke" && tar -xzf "$TARBALL" -C "$SCRATCH/session-rx-smoke"
node "$SCRATCH/session-rx-smoke/package/src/cli.js" --version
SMOKE_EXIT=$?
echo "EXIT:$SMOKE_EXIT"
```

| ID | Rule |
|----|------|
| C-1 | `[ "$SMOKE_EXIT" -ne 0 ]` -> ABORT, do not proceed to RS-D. Same exit-code-capture rule as A-1 — capture before any further command runs. |
| C-2 | tarball and extracted dir live in the session scratchpad, never the repo — never leave them under the project working tree |

### RS-D — Version bump, CHANGELOG, commit, tag, push, CI wait

```bash
# 1. compute next version (default: patch; --minor / --major override)
BUMP="${RELEASE_BUMP:-patch}"   # patch|minor|major — set by the /release invocation flag
CUR=$(node -p "require('./package.json').version")
NEXT=$(node -e "
const [maj,min,pat] = '$CUR'.split('.').map(Number);
const bump = '$BUMP';
const out = bump === 'major' ? [maj+1,0,0] : bump === 'minor' ? [maj,min+1,0] : [maj,min,pat+1];
console.log(out.join('.'));
")
echo "CUR=$CUR NEXT=$NEXT BUMP=$BUMP"

# 1b. DRY-RUN ENDS HERE with an actual preview — not just the printed NEXT.
# This is the honest boundary: dry-run must PRODUCE the preview it claims,
# not merely state that live mode would. Nothing below this block writes
# anything.
if [ "${RELEASE_DRY_RUN:-0}" = "1" ]; then
  echo "--- would-be package.json diff (preview only, not written) ---"
  node -e "
    const fs = require('node:fs');
    const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
    console.log('  \"version\": \"' + pkg.version + '\" -> \"$NEXT\"');
  "
  echo "--- raw commit material for the CHANGELOG entry (drafted by whoever runs this skill -- not mechanically generated) ---"
  git log origin/main..HEAD --format='- %s'
  echo "--- end dry-run preview: no npm version, no commit, no tag, no push below this point ---"
  exit 0
fi

# 2. LIVE MODE ONLY past this point.
# `set -e`: a failed `git commit` must never fall through to `git tag` /
# `git push` (a P1 a reviewer caught — D-3 claimed this abort behavior
# without actually enforcing it). Every command below must exit non-zero
# on failure for this to work; none of them are piped.
set -e

npm version "$NEXT" --no-git-tag-version

# CHANGELOG.md entry: this is authored content (a summary of what changed),
# not a mechanical bash step — it is written by whoever is running this
# skill (the orchestrator), using Edit/Write, BEFORE this point in the
# procedure. This check enforces that it actually happened instead of
# silently committing with no entry (a P2 a reviewer caught — a bare
# comment here previously let every release ship without one):
grep -q "^## \[$NEXT\]" CHANGELOG.md || {
  echo "CHANGELOG.md has no '## [$NEXT]' entry yet — write one (Edit/Write, prepended, Keep a Changelog format) before continuing"
  exit 1
}

git add package.json package-lock.json CHANGELOG.md
git commit -m "[session-rx] chore(release): $NEXT"
RELEASE_SHA=$(git rev-parse HEAD)
git push origin main

# 3. wait for the Tests workflow on the main-branch push to go green
# BEFORE touching the tag — a `v*` tag push fires publish.yml UNCONDITIONALLY
# (it does not itself wait on the Tests workflow), so the tag must never be
# pushed until this wait has returned success. Pushing the tag first was a
# real ordering bug an earlier draft shipped with (caught by two independent
# reviewers); never reorder this back.
#
# `gh run list -L1` immediately after a push is a RACE: GitHub can take a
# few seconds to register the push and spawn the new run, so a naive -L1
# can return the PREVIOUS (already-green) commit's run, `gh run watch`
# returns instantly, and the tag ships before the new commit is actually
# verified — reintroducing the exact bug this ordering fix exists to close
# (caught by an independent reviewer on the first attempt at this fix; do
# not "simplify" this back to a bare `-L1`). Filter by the exact pushed SHA
# and poll until GitHub has registered it:
CI_RUN_ID=""
for _ in $(seq 1 20); do
  CI_RUN_ID=$(gh run list --workflow=test.yml --branch=main --commit "$RELEASE_SHA" --json databaseId -q '.[0].databaseId')
  # NOT `[ ... ] && [ ... ] && break` -- under `set -e`, a bare AND-list with
  # no trailing `||` propagates ITS OWN failure (when the run hasn't
  # appeared yet, which is the NORMAL first few iterations) straight to the
  # script's exit, aborting the whole release on iteration 1 instead of
  # retrying. A reviewer caught this exact interaction after `set -e` was
  # added in the previous fix. `if/then/fi` is one of the few constructs
  # POSIX explicitly exempts from `set -e`, so this form is required, not
  # stylistic:
  if [ -n "$CI_RUN_ID" ] && [ "$CI_RUN_ID" != "null" ]; then break; fi
  sleep 3
done
[ -n "$CI_RUN_ID" ] && [ "$CI_RUN_ID" != "null" ] || { echo "no Tests run appeared for $RELEASE_SHA after 60s — tag NOT pushed"; exit 1; }
# Same `set -e` hazard applies to `gh run watch`: it exits non-zero when CI
# is red, and a bare non-zero exit on a standalone command IS what `set -e`
# is supposed to catch and abort on -- except here we need to catch it
# ourselves first to print which commit/run failed and confirm the tag was
# never pushed. `|| CI_EXIT=$?` (an assignment, always itself exit-0) is the
# standard way to capture a failing command's status without either
# triggering `set -e` or losing the code (a reviewer caught the earlier
# `CI_EXIT=$?` on its own line never being reached for the same reason):
CI_EXIT=0
gh run watch --exit-status "$CI_RUN_ID" || CI_EXIT=$?
[ "$CI_EXIT" -eq 0 ] || { echo "CI red on main ($CI_RUN_ID, $RELEASE_SHA) — tag NOT pushed, no publish triggered"; exit 1; }

# 4. only now — main is green on the exact pushed commit — push the tag,
# which triggers publish.yml
git tag "v$NEXT" "$RELEASE_SHA"
git push origin "v$NEXT"
```

| ID | Rule |
|----|------|
| D-1 | dry-run mode: `RELEASE_DRY_RUN=1` gate exits after printing the would-be version and the commit list the CHANGELOG entry is drafted from — this is a real preview the step actually produces, not just a claim; `npm version`/`git commit`/`git tag`/`git push` never execute in this path |
| D-2 | live mode: `gh run watch --exit-status` non-zero -> the Tests workflow went red on `main` -> STOP, exit before the tag block; the tag is never created or pushed in this path, so `publish.yml` never fires. The commands are ordered push-main / wait-green / tag-and-push-tag specifically so a red main can never reach a tag push — do not reorder them. |
| D-3 | any git command failing (auth, conflict, rejected push) -> ABORT, report the exact command and error, do not retry blindly. Enforced by `set -e` at the top of the live block (a reviewer caught this being claimed but not actually enforced) — none of RS-D's live commands may be wrapped in a pipeline or `if` that would swallow their exit code. |
| D-4 | the CHANGELOG.md entry is authored by whoever runs this skill, before the `grep -q "^## \[$NEXT\]"` gate — that gate is what makes D-4 real instead of a comment nobody acts on (a reviewer caught an earlier draft shipping releases with no changelog entry at all) |

### RS-E — Verify published

```bash
sleep 30   # OIDC publish + registry propagation
npm view session-rx version
```

| ID | Rule |
|----|------|
| E-1 | output must equal `$NEXT` exactly, or the release is **not DONE** — re-check `gh run list --workflow=publish.yml` for the actual failure, do not silently retry `npm view` in a loop |
| E-2 | dry-run mode: this step is `SKIPPED (dry-run)` — nothing was pushed, there is nothing on the registry to check |

### RS-F — Mandatory evidence table (always produced, live or dry-run)

```
| claim | verifying command | exit code | key output line |
|---|---|---|---|
```

| ID | Rule |
|----|------|
| F-1 | every row's exit code and key output line must come from a command actually run THIS invocation — no recalled/remembered values |
| F-2 | a row with no evidence is `UNVERIFIED`, and per the operator's standing rule: **the release is not done** |
| F-3 | dry-run rows for RS-D's git actions and all of RS-E are `SKIPPED (dry-run)` — a distinct, honest state, never conflated with `UNVERIFIED` (which means "should have evidence and doesn't") or with a fabricated pass |
| F-4 | when RM-6 halts the release at RS-B (FIX/BLOCK verdict), the rows for every later step are `NOT RUN (blocked by review verdict)` — a third distinct state, different again from `SKIPPED (dry-run)` (which means the pipeline reached that point and deliberately did not act) and from `UNVERIFIED` (which means a claimed row has no evidence). The table still ships; a halted release is a correct, reportable outcome, not a reason to omit the table. |

```
NOTE ON STATE COUNT: a reviewer may flag F-3/F-4 as violating THE HONESTY
CONTRACT's three-state rule (observed | not-observed | unknown). That
contract governs a health RULE's VERDICT about a user's coding session
(src/analyzer/*) — a different artifact from this table's per-STEP EVIDENCE
row, whose required shape (claim | verifying command | exit code | key
output line, UNVERIFIED for a claim with no evidence) was specified
verbatim by the operator for this skill. SKIPPED (dry-run) and NOT RUN
(blocked by review verdict) are not additional verdicts layered onto
observed/not-observed/unknown; they are reasons a step produced no exit
code/output line at all, same role `unknown`'s `verdict.reason` plays for
a health rule. Keeping them distinct from UNVERIFIED is what makes
UNVERIFIED still mean "should have run and didn't" rather than absorbing
every legitimate reason a step was never attempted.
```

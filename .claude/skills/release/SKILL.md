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
| PC-3 | on `main`, up to date with `origin/main` | `git rev-parse --abbrev-ref HEAD` = `main`; `git fetch origin main --quiet && git rev-list HEAD..origin/main --count` | branch=main, count=0 |
| PC-4 | publish is CI-driven, not local | see `.github/workflows/publish.yml` — trusted OIDC publisher, triggers on `push: tags: 'v*'` | no local `npm publish` is ever run by this skill |

```
FAIL ANY PC -> STOP, report which check failed, do not proceed to RS-A.
```

## §1 INVOCATION MODES

| Mode | Invocation | RS-A | RS-B | RS-C | RS-D | RS-E | RS-F |
|------|-----------|------|------|------|------|------|------|
| Live | `/release [--minor\|--major]` (default: patch bump) | real | real | real | real: bump+changelog+commit+tag+push+CI-wait | real: npm view check | real, DONE gate applies |
| Dry run | `/release --dry-run` | real | real | real | PREVIEW ONLY: computes next version + drafts CHANGELOG entry + shows `git diff --stat` of the would-be package.json/CHANGELOG change; runs NO `git commit`/`git tag`/`git push` | SKIPPED (dry-run) — nothing was pushed, so nothing to verify | required, rows for D/E marked `SKIPPED (dry-run)` |

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
set -o pipefail
npm test 2>&1 | tee release_test_output.txt
echo "EXIT:$?"
```

| ID | Rule |
|----|------|
| A-1 | non-zero exit -> ABORT the whole release; do not proceed to RS-B |
| A-2 | `release_test_output.txt` is the evidence artifact for RS-F row 1; move it to `_trash/` (never `rm`) once the table is filled |

### RS-B — Independent review of the release diff

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD > /tmp/release_diff.patch   # or the session scratchpad
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

**Review prompt template** (same for every reviewer — fill `<DIFF>`):

```
Review this session-rx release diff for correctness and contract compliance.
Check specifically: the Honesty Contract (verdict is always observed |
not-observed | unknown — never a fourth state, never null-as-0), the
Suggestion Contract (no file writes, byte-for-byte preview text, append-only
requests, idempotence marker check), read-only collector guarantees
(createReadStream / SQLite opened `mode=ro`), and the no-network rule (no
fetch/require('http'), no CDN <script>, Chart.js stays vendored).

Diff:
<DIFF>

End your review with exactly one line, verbatim, nothing else on that line:
VERDICT: PASS
VERDICT: FIX
VERDICT: BLOCK
```

**Grounded invocation commands:**

```bash
# agy (with Gemini 3.1 Pro) — verified model id via `agy models`
agy --print --model gemini-3.1-pro-high "$(cat review_prompt.txt)" > release_review_agy.txt 2>&1

# Codex Sol = codex's own non-interactive review subcommand
codex review --base origin/main - < review_prompt.txt > release_review_codex.txt 2>&1

# Opus fallback = Agent tool call, model: "opus", NOT a CLI — write its
# report to release_review_opus.txt via the agent's own file write
```

| ID | Rule |
|----|------|
| RM-3 | review file must contain exactly one `VERDICT: (PASS\|FIX\|BLOCK)` line: `grep -Eo 'VERDICT: (PASS\|FIX\|BLOCK)' <file>` returns exactly 1 line |
| RM-4 | `grep -iE '429\|quota\|rate.?limit\|resource_exhausted'` matching anywhere in the review file, OR zero/more-than-one VERDICT lines, = **no verdict** -> try the 2nd reviewer in RM-2's order; if the 2nd also gives no verdict -> STOP and ask the operator |
| RM-5 | no reviewer available at all (both binaries missing / both Agent calls fail) -> STOP and ask the operator; never proceed on an assumed PASS |
| RM-6 | `VERDICT: FIX` or `VERDICT: BLOCK` -> STOP, report the reviewer's findings, do not proceed to RS-C |

### RS-C — npm pack + smoke test

```bash
npm pack --pack-destination /tmp
TARBALL=$(ls -t /tmp/session-rx-*.tgz | head -1)
mkdir -p /tmp/session-rx-smoke && tar -xzf "$TARBALL" -C /tmp/session-rx-smoke
node /tmp/session-rx-smoke/package/src/cli.js --version
echo "EXIT:$?"
```

| ID | Rule |
|----|------|
| C-1 | non-zero exit anywhere in this block -> ABORT, do not proceed to RS-D |
| C-2 | tarball and extracted dir are session-scratch, not project files — never leave them under the repo |

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

# 2. LIVE MODE ONLY past this point — dry-run stops here with a preview
npm version "$NEXT" --no-git-tag-version
# prepend CHANGELOG.md entry
git add package.json package-lock.json CHANGELOG.md
git commit -m "[session-rx] chore(release): $NEXT"
git tag "v$NEXT"
git push origin main
git push origin "v$NEXT"

# 3. wait for the Tests workflow on the main-branch push to go green
gh run watch --exit-status $(gh run list --workflow=test.yml --branch=main -L1 --json databaseId -q '.[0].databaseId')
```

| ID | Rule |
|----|------|
| D-1 | dry-run mode: everything above the `LIVE MODE ONLY` line runs for real (it is pure computation); nothing at or below it runs — show the would-be `NEXT` version and a `git diff --stat`-style preview of package.json/CHANGELOG.md instead |
| D-2 | live mode: `gh run watch --exit-status` non-zero -> the Tests workflow went red on `main` -> STOP, do not push the tag if it hasn't been pushed yet; if RS-D already pushed the tag, that already triggered `publish.yml` — this ordering (push main, wait green, only then push tag) exists specifically so a red main never reaches a tag push |
| D-3 | any git command failing (auth, conflict, rejected push) -> ABORT, report the exact command and error, do not retry blindly |

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

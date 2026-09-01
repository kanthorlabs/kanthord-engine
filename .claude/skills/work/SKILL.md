---
name: work
description: Drive a TDD implementation cycle for one EPIC — dispatching test-engineer / software-engineer in alternation until IMPLEMENTATION_READY_FOR_REVIEW, then a reviewer-engineer gate that auto-routes action:YES findings back through the loop once, then the human review. A case that fails its attempt limit goes to the debate engine for an unblock guideline first, and reaches the human only when that guideline also fails. Lifecycle state lives in the discussion file; the orchestrator writes no frontmatter or status board.
---

# /work — orchestrate a TDD implementation cycle

> **Harness note.** This skill runs under Claude Code, opencode and pi from the
> one file. Where a step says "dispatch a subagent", use the harness's dispatch
> tool: `Agent` under Claude Code, `Task` under opencode, the equivalent under
> pi. Where a step names a persona file, read it from `.claude/agents/<name>.md`
> or `.opencode/agents/<name>.md`, whichever exists.

Arguments: `$ARGUMENTS` — `<epic-file-path> [--max-turns N]`. A harness that does not substitute
`$ARGUMENTS` passes the same text with the invocation; read it from there.

You are the **orchestrator**. You own everything the test-engineer / software-engineer cannot do on their own:

- **TDD dispatch** — alternating `test-engineer` and `software-engineer` turns until `IMPLEMENTATION_READY_FOR_REVIEW:` lands in the discussion file or the turn cap fires.
- **Escalation** — counting `ATTEMPT-FAILED:` lines per case; when one case has failed **3** attempts, asking the debate engine for an unblock guideline through `/debate`, and handing the case to the human only when that guideline also fails. **One blocker skips both counters: a fix that needs a path locked to every role goes to the human on its first appearance**, because no engineer and no guideline can close it.
- **Reviewer auto-fix routing** — after the reviewer-engineer gate, auto-routing every `action:YES` finding back through the TDD loop **once** per review cycle; only `action:NO` findings reach the human.
- **Final review handoff** — after implementation and the reviewer auto-fix pass, pausing for the **human operator's** review (`HUMAN_REVIEW: PASS|FAIL`). If the human fails it, routing their `BLOCKER:` lines back through the TDD loop.
- **Discussion-file seed** — the one-time header write.

Lifecycle state lives **only in the discussion file** — there is no separate status board and the EPIC/story files carry no frontmatter to flip. An EPIC is "in progress" once its discussion file exists and "done" once that file contains `HUMAN_REVIEW: PASS`.

You do **not** commit; the human reviews and commits. You do **not** write to the discussion file after seeding it — subagents own every subsequent append via the race-safe `cat >>` protocol in their personas. (The one exception: the auto-review routing block the orchestrator appends in Step 6b.) You do **not** edit production sources, test files, or the locked EPIC/story files — the engineers and the planning phase own those.

A "turn" is one logical handoff, not one keystroke. A subagent may make many tool calls inside a single Task invocation (read context, edit sources / test files, build, append) and produce one substantive entry in the discussion file. Granularity below that belongs in version-control commits, not in the discussion file.

The canonical TDD cycle:

- `test-engineer` opens with either a failing test (RED) for the next unimplemented case, or a GREEN-ONLY pass-through for cases that state a build-only check. A case is one numbered entry under a story's `## Verify`, addressed as `<story-file-stem>#V<n>` — there are no checkboxes; progress is tracked from the discussion file.
- `software-engineer` makes that test green by editing production sources (RED flow), or implements the forwarded case(s) directly from the story's `## Change` (GREEN-ONLY flow). `## Change` is the whole-story implementation contract and is read whole; its `###` steps are never scheduled one per turn.
- `test-engineer` runs the test (GREEN), then either opens the next RED or — when every case is green and the EPIC's Verification Gate runs clean — appends `IMPLEMENTATION_READY_FOR_REVIEW:`. For GREEN-ONLY cases, the TE runs a build-only check instead of a test.

**The ready marker has three preconditions, all of them mandatory.** The EPIC's `## Verification Gate` has **two** parts — `Gates:` and `Proof:` — and running only the `Gates:` is the single most common way this loop reports work that is not done:

1. **Every numbered `## Verify` case in every story file is green** — not "the stories expanded so far". A `## Change` obligation that no case and no gate proves is an authoring defect, reported to the human, never a reason to invent a case. A partial implementation cannot satisfy a whole-epic Proof, so a marker emitted with stories outstanding is invalid.
2. **The `Gates:` command runs green** (typically `pnpm run verify`).
3. **The `Proof:` command has actually been run**, and its real output — including the string the EPIC says it must print — is pasted into the turn.

A marker missing any of the three is premature: the orchestrator must **reject it** and dispatch the next engineer turn instead of advancing to Step 6. `Proof:` scripts live under `scripts/`, which every role may always **run** (see AGENTS.md); only the software-engineer may **modify** it, and never the three pipeline guards. "Lane-forbidden" is never a valid reason to skip the Proof.

After the TDD loop completes (`IMPLEMENTATION_READY_FOR_REVIEW:` detected), the orchestrator runs the **reviewer-engineer gate** and auto-routes its `action:YES` findings back through the TDD loop (once per cycle), leaving only `action:NO` findings for the human. It then **pauses for the human operator's review**. The human reviews the implementation and records the verdict in the discussion file as `HUMAN_REVIEW: PASS` or `HUMAN_REVIEW: FAIL` (with `BLOCKER:` lines). On `PASS`, the EPIC is done. On `FAIL`, the orchestrator routes the `BLOCKER:` lines back through the TDD loop until the next `IMPLEMENTATION_READY_FOR_REVIEW:`.

Separately, while the TDD loop runs, the orchestrator counts `ATTEMPT-FAILED: <case-id>` lines emitted by the engineers. When any single case accumulates **3** failed attempts, the loop cannot self-resolve it — but the human is not the first stop. The orchestrator asks the **debate engine** for an unblock guideline through the `/debate` skill, records that guideline in the discussion file, and gives the case 3 more attempts under it. The human is reached only when the debate engine cannot be used, its run fails, or the case fails its 3 attempts under the guideline as well. Each case gets at most one guideline per review cycle.

The count answers "can the loop still resolve this?". It is the wrong question for a blocker whose fix needs a file locked to every pipeline role — the plan tree, the pipeline definition, the pipeline guards, `package.json`, `tsconfig*.json`, `AGENTS.md`, the `Makefile`, `Containerfile` or `compose.yaml`. No number of attempts closes such a blocker, and a debate guideline cannot either, because the guideline would have to be executed by a role that may not write the file. The engineers mark it `OPEN: OUT-OF-LANE — <path> — <change>`, and Step 5h escalates it to the human on the **first** occurrence, after validating the claimed lock with `scripts/lane-check.sh`.

## Step 1 — Parse arguments

From `$ARGUMENTS`:

- **First positional** = EPIC file path (required). If missing or empty, print usage and stop.
- **`--max-turns N`** = override turn cap. Default `128`. `0` means unlimited (use with care).

Resolve `<root>` = `$(git rev-parse --show-toplevel)` once. Every path in the steps below resolves under `<root>`.

## Step 2 — Pre-flight checks (abort with a clear message on any failure)

All path checks below resolve under `<root>`.

1. The EPIC file exists and is readable.
2. The path is under `.agents/plan/epics/` (sanity guard — refuse arbitrary paths).
3. The `test-engineer` persona file exists — `.claude/agents/test-engineer.md` or `.opencode/agents/test-engineer.md`.
4. The `software-engineer` persona file exists, under either directory.
5. The `reviewer-engineer` persona file exists, under either directory.
6. `.agents/tdd/history/` exists (create it with `mkdir -p` if not).
7. **No double review on resume.** If the discussion file (Step 3) already exists and its latest `HUMAN_REVIEW:` line is `PASS`, this cycle is already done — report `already closed` and stop without dispatching.

## Step 3 — Derive the discussion file path

From the EPIC file path, extract the basename without `.md` as `<epic-slug>`. Compute today's date in UTC as `<YYYY-MM-DD>`. The discussion file path is:

```
<root>/.agents/tdd/history/<YYYY-MM-DD>-<epic-slug>.md
```

If the discussion file does not exist, capture the current HEAD as the cycle's base ref (`BASE_REF=$(git -C '<root>' rev-parse HEAD)`) and seed the file with a single shell write (`cat > '<discussion-file>' <<'WORK_EOF' ... WORK_EOF`). This is the **only** time the orchestrator writes the discussion file. Header content:

```
---
epic: <epic-file-relative-path>
opened: <YYYY-MM-DD>
opener: test-engineer
base-ref: <BASE_REF>
---

# Implementation cycle — <epic-slug>

Pulled from EPIC: `<epic-file-relative-path>`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):
> <the prose under the EPIC's "## Verification Gate" heading, verbatim>

TDD protocol:
1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for cases that state a build-only check.
2. software-engineer makes the test green (RED flow) or implements the story's `## Change` for the forwarded cases (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next case or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.
```

(If the discussion file already exists, leave it alone — you are resuming a prior cycle.)

## Step 4 — Environment pre-flight (once)

None needed. Tests and typecheck run in-process with no emulator, database, browser, or booted resource. Pass `n/a` as `<ENV>` in every dispatch.

## Step 5 — The dispatch loop

Initialize `turn_count = 0`. Sweep any stale draft temps left by an aborted prior run (the orchestrator owns these — see 5e/5g.1): `rm -f '<root>'/.agents/tdd/.*-response-*.md`. Then repeat:

### 5a. Stop on max-turns

If `max_turns > 0` and `turn_count >= max_turns`: report `max-turns reached (<N>)` and jump to Step 8 (do **not** close the lifecycle — the work isn't done).

### 5b. Stop on IMPLEMENTATION_READY_FOR_REVIEW

Only a ready marker **newer than the last review failure** counts — otherwise a stale marker from before a review failure (a human `HUMAN_REVIEW: FAIL` or an orchestrator-emitted `AUTO_REVIEW: FAIL` from Step 6b) would bounce the cycle straight back to Step 6 without running the blocker regressions.

```bash
FAIL_LINE=$(grep -nE '^(HUMAN_REVIEW: FAIL|AUTO_REVIEW: FAIL)' '<discussion-file>' | tail -1 | cut -d: -f1)
awk -v s="${FAIL_LINE:-0}" 'NR>s && /^IMPLEMENTATION_READY_FOR_REVIEW:/' '<discussion-file>'
```

If that prints any line, **validate the LATEST such marker before honouring it** (append `| tail -1` — a rejected marker stays in the file, so always judge the most recent one). Read the turn that carries it and confirm it evidences all three preconditions from "The ready marker has three preconditions" above: every story case green, the `Gates:` command green, and the `Proof:` command run with its real output and the EPIC's success string present. A marker that admits outstanding work ("stories 4-6 remain pending", "not yet expanded") or that never ran the Proof is **premature**:

- Print `premature ready marker rejected: <what is missing>`.
- Do **not** jump to Step 6. Continue the loop at 5c so the next engineer turn finishes the work.
- Do not edit the discussion file to remove the marker — the next real marker supersedes it (Step 5b already scopes markers to the latest review failure, and rejection is not a failure verdict).

Otherwise: report `implementation ready for review` and jump to Step 6 (final review phase).

### 5c. Read the tail marker

```bash
grep -E '^END:[[:space:]]+(TEST-ENGINEER|SOFTWARE-ENGINEER)[[:space:]]*$' '<discussion-file>' \
  | tr -d '\r' \
  | tail -n 1 \
  | sed -E 's/^END:[[:space:]]+//; s/[[:space:]]+$//'
```

Capture the result as `tail_actor` (may be empty if no marker exists yet).

### 5d. Decide next role

**Post-failure override — check this first.** If the last review verdict (`HUMAN_REVIEW: FAIL` or `AUTO_REVIEW: FAIL`) has no engineer turn after it, `next = test-engineer` **regardless of `tail_actor`**:

```bash
FAIL_LINE=$(grep -nE '^(HUMAN_REVIEW: FAIL|AUTO_REVIEW: FAIL)' '<discussion-file>' | tail -1 | cut -d: -f1)
awk -v s="${FAIL_LINE:-0}" 'NR>s && /^END:[[:space:]]+(TEST-ENGINEER|SOFTWARE-ENGINEER)/' '<discussion-file>'
```

If `FAIL_LINE` is non-empty and that prints nothing → `next = test-engineer`; skip the alternation table below.

Strict alternation is wrong at this boundary. Blockers need a failing regression test **before** anyone fixes them, so the test engineer always takes the first turn after a review failure — that is what Step 6d means by "the test engineer turns testable blockers into failing regression tests". Following the tail marker instead (last = TE → next = SE) sends the software engineer in to fix a blocker with no test guarding the fix.

Otherwise use the alternation table:

- `tail_actor` empty → `next = test-engineer` (test engineer always opens; matches `opener: test-engineer` in the header)
- `tail_actor` is `TEST-ENGINEER` → `next = software-engineer`
- `tail_actor` is `SOFTWARE-ENGINEER` → `next = test-engineer`
- Anything else → abort with `"unrecognized tail state: <tail_actor>"` for human review

### 5e. Mint the turn id, capture `tail_before` and a changed-file snapshot

Save the raw tail line (or `<none>` if `tail_actor` was empty). Used after the Task call to verify the subagent actually wrote.

Mint this turn's id and the draft-file path. The orchestrator computes them **once here** and reuses them for create (5f) and delete (5g.1), so the draft temp is always cleaned by its **exact** name regardless of what the agent does. **The timestamp is minted here, by `/work`, never inside the agent** — an agent that recomputed `date` across its separate Bash calls would produce a name `/work` could not later delete:

```bash
TS=$(date -u +%Y%m%d-%H%M%S)                                       # minted once per turn by /work (UTC)
TURN_ID=<epic-slug>-$TS-t<turn_count>                              # epic+timestamp+turn — unique across cycles and runs
DRAFT_FILE=<root>/.agents/tdd/.<next>-response-$TURN_ID.md          # <next> = test-engineer | software-engineer
```

Also snapshot the **content fingerprint** of every changed file in `<root>` so Step 5g.1 can attribute this turn's edits and reject out-of-lane writes:

```bash
scripts/turn-snapshot.sh '<root>' > '/tmp/work-<epic-slug>-before-<turn>'
```

The guard emits one sorted `<blob-hash>\t<path>` line per dirty path (`ABSENT` in place of the hash for a deleted file). A **name-only** snapshot is not enough: a multi-turn TDD loop leaves files dirty by design, so a path already dirty before the turn appears in both snapshots and a name-set difference never reports the turn's second edit to it. The hash makes each turn's edit visible even on an already-dirty file. The guard uses `-uall` so git lists each new file individually instead of collapsing it into a directory path, `--no-renames` so a rename arrives as a plain delete plus a plain add rather than an `old -> new` record no predicate can split, and `LC_ALL=C sort` because Step 5g.1 feeds these snapshots to `comm`, which assumes sorted input.

### 5f. Dispatch the subagent

Dispatch the subagent with `subagent_type` equal to `next` (`test-engineer` or `software-engineer`) and this prompt verbatim, substituting `<root>`, `<EPIC_FILE>` (= `<root>/<epic-relative-path>`), `<DISCUSSION_FILE>`, `<DRAFT_FILE>` (from 5e), and `<ENV>` (whatever Step 4 captured):

```
Continue the TDD implementation cycle for EPIC <EPIC_FILE>.

Working root: <root>            # ALL paths below resolve under this root.
Discussion file: <DISCUSSION_FILE>
Pre-flight resource: <ENV>             # whatever the pre-flight captured, or "n/a"

SINGLE-TURN CONTRACT (OVERRIDES everything below):
- ONE turn = ONE role = ONE append (ONE "END: <ROLE>") = ONE `cat >>`, then STOP and return your one-sentence summary.
- Do NOT switch/impersonate the other role.
- Do NOT spawn or dispatch any sub-agent.
- Append "IMPLEMENTATION_READY_FOR_REVIEW:" ONLY when this turn IS it (test-engineer, EVERY case in EVERY story green, Gates: green, AND the Proof: command run with its real output pasted in). stories still unexpanded or unimplemented means NOT ready.

Follow your discussion-channel protocol exactly:
1. Read the EPIC file and the discussion file for full context. The EPIC's `## Verification Gate` is binding. If the discussion file's last "DEBATE_GUIDELINE:" block is newer than the last engineer turn, its "GUIDELINE:" lines are binding direction for this turn — the loop already failed this case three times without them. The `## Architecture` section of AGENTS.md (repo root) is binding for all production code. The discussion file's last turn (if any) tells you what was just done.
2. Do the work your persona owns this turn:
   - If you are test-engineer: identify the next unimplemented case, write its failing test under the exact test command the story's `## Verify` names, using the `it` name the case quotes verbatim, then run the test using the project's test command and capture the failing assertion line. Cases run in document order. When a case states a build-only check (GREEN-only), write a GREEN-ONLY pass-through turn listing the case(s) for the software-engineer; do not write tests for them; after the SE's turn, run a build-only check. When every case is green, run the Verification Gate and prepare an IMPLEMENTATION_READY_FOR_REVIEW turn if green.
   - If you are software-engineer: read the most recent TEST-ENGINEER turn, identify the failing test and the seam it imports, and edit production sources to make that test green with the smallest correct change. If the last TEST-ENGINEER turn is a GREEN-ONLY pass-through, read the story file path and case ids from the turn and implement the story's `## Change` for every listed case. Never edit the test files, and never edit anything under `test/**` — both are the test-engineer's lane, even when the last TEST-ENGINEER turn asks you to. Do not run tests.
3. Draft your turn into exactly this file: <DRAFT_FILE>
4. Append your turn to the discussion file via shell:  cat '<DRAFT_FILE>' >> '<DISCUSSION_FILE>'
5. Re-read the tail of the discussion file and verify the final non-blank line is exactly "END: <YOUR_ROLE>".
6. Do NOT delete <DRAFT_FILE> — /work removes it by its exact name after this turn.
7. STOP and return your one-sentence summary.

Do NOT use an editor on the discussion file — only shell append.
Do NOT edit files outside your lane (see the lane table in your persona).
Do NOT edit the EPIC or story files — those are locked by planning. Do NOT touch the build/project config files (see the always-forbidden list in your persona).

If you are test-engineer and you have just confirmed that every case is green AND the Verification Gate runs green end-to-end, append an IMPLEMENTATION_READY_FOR_REVIEW turn (still ending with END: TEST-ENGINEER). /work greps "^IMPLEMENTATION_READY_FOR_REVIEW:" to stop the TDD loop and hand the cycle to the human for review.

"The Verification Gate runs green end-to-end" means BOTH of its parts: the `Gates:` command AND the `Proof:` command, each actually executed this turn, with the Proof's real output (including the exact success string the EPIC names) pasted into your turn. A Proof script under `scripts/` is always allowed to RUN by every role — never skip it on lane grounds. If the Proof fails, you are not ready: report the failure as your turn instead. If any story case is still unimplemented or its story file still unexpanded, you are not ready either — open the next case.
```

Also append:

```
If this turn is a failed attempt at the active case — you raised an "OPEN:" blocker (missing copy, a missing seam, an unimplementable acceptance criterion), or (test-engineer) a confirm-GREEN turn found the test still red — add an "ATTEMPT-FAILED: <case-id> — <reason>" line just above your END marker. /work counts these per case: 3 failed attempts on the same case escalates it to the human.

Return one short sentence summarizing what you wrote.
```

### 5g. Verify the subagent wrote

Re-read the tail (same pipeline as 5c) and also check for any new `^IMPLEMENTATION_READY_FOR_REVIEW:` line. Compare with `tail_before`:

- If the tail is unchanged AND no new `IMPLEMENTATION_READY_FOR_REVIEW:` line appeared → abort with `"subagent <next> returned but discussion file unchanged"`. Leave the file as-is for human review.

### 5g.1 Lane ownership check (git diff)

Lane boundaries are stated in the personas but nothing enforces them. Compute the files this turn changed (in `<root>`) and reject any write outside `next`'s lane — a cheap backstop.

```bash
scripts/turn-snapshot.sh '<root>' > '/tmp/work-<epic-slug>-after-<turn>'
TURN_FILES=$(LC_ALL=C comm -3 '/tmp/work-<epic-slug>-before-<turn>' '/tmp/work-<epic-slug>-after-<turn>' | sed 's/^\t//' | cut -f2- | LC_ALL=C sort -u)
```

`LC_ALL=C comm -3` is required, not `comm -13`: a fingerprint line changes when the turn edits a file, deletes it, or reverts it to `HEAD`, and only the two-sided difference reports all three. The locale must match the snapshot sort locale, or unchanged lines can appear as differences. `sed 's/^\t//'` strips the tab `comm` prefixes to its second column, and `cut -f2-` drops the hash to leave the path.

Tests are **co-located** with source (`bar.ts` + `bar.test.ts` in one dir), so a
prefix table cannot separate the lanes — this project uses a **predicate
script**: `scripts/lane-check.sh <role> <path>` (exit 0 = in-lane).

- **test-engineer** lane: `src/**/*.test.ts`, `src/**/*.spec.ts`; plus **every
  file under `test/**`**, test suffix or not (`test/helpers/daemon.ts`,
  `test/helpers/port.ts` and every fixture under `test/fixtures/**` and
  `test/e2e/fixtures/**` are test-engineer files); plus its draft files
  under `.agents/tdd/` and its journal under
  `.agents/tdd/memory/test-engineer/`.
- **software-engineer** lane: `src/**/*.ts` that is NOT a `*.test.ts` /
  `*.spec.ts`; plus `scripts/**` (helper/proof scripts its work needs — the
  pipeline guards below stay locked); plus its draft files and journal as
  above. **`test/**` is not in this lane** — a helper or fixture the
  software-engineer needs is an `OPEN:` to the test-engineer, never an edit.
- **Always forbidden to BOTH** (the lane script denies these for every role):
  the locked plan tree `.agents/plan/**`; the pipeline files `.claude/**` and
  `.opencode/**`; the pipeline guards `scripts/lane-check.sh`,
  `scripts/turn-snapshot.sh`, `scripts/verify-handoff.mjs`,
  `scripts/memory-append-only.sh` and every `scripts/*.test.sh`;
  toolchain/config `package.json`, `package-lock.json`, `tsconfig*.json`,
  `*.config.*`; the architecture contract `AGENTS.md`; container/build files
  `Containerfile`, `compose.yaml`, `Makefile`. The reviewer-engineer edits
  nothing at all.

Both roles may also write `.agents/tdd/` and their own `.agents/tdd/memory/<role>/` journal dir (under `<root>`).

Pass each path to the predicate one at a time, and read a path with `read -r`, never by word splitting — a path that contains a space is legal, and splitting it produces two arguments the predicate denies for the wrong reason:

```bash
lane_failed=0
while IFS= read -r changed; do
  [ -n "$changed" ] || continue
  scripts/lane-check.sh '<role>' "$changed" || lane_failed=1
done <<EOF
$TURN_FILES
EOF
[ "$lane_failed" -eq 0 ] && echo "LANE: PASS" || echo "LANE: FAIL"
```

Two properties matter here. The flag replaces an in-loop `exit 1`, which stopped at the **first** violating path and left the rest unchecked — the human reviewing the abort needs every violation, not one. The here-doc replaces a `printf … | while` pipe, because a piped loop runs in a subshell where a flag set inside it is lost. Together they turn the verdict into an explicit stdout line instead of an exit status you must remember to read. Run the block on **every** turn, and read its last line before anything else:

- `LANE: PASS` → continue to the draft cleanup below.
- `LANE: FAIL` → **abort the cycle**. Print each denial `scripts/lane-check.sh` wrote to stderr as `"lane violation: <role> changed <path>"`, leave the tree and the draft file untouched for human review, and do not dispatch another turn. A lane violation is never a warning to note and move past — a turn that wrote outside its lane is not a turn that happened.

(`<DRAFT_FILE>` itself lives under `.agents/tdd/` and so is always in-lane.)

Otherwise the turn is clean. Delete this turn's draft temp by its **exact** path — the orchestrator owns this cleanup: `rm -f '<DRAFT_FILE>'`. Then remove the two `/tmp` snapshot files.

### 5h. Escalation — an out-of-lane blocker → Human at once; a case at its attempt limit → debate, then Human

After verifying the subagent wrote, check whether this turn was a **failed attempt** at the active case. Engineers mark a failed attempt with a greppable line `ATTEMPT-FAILED: <case-id> — <reason>`.

```bash
LAST_FAIL=$(grep '^ATTEMPT-FAILED:' '<discussion-file>' | tail -1)
```

If `LAST_FAIL` is empty → no failed attempt this turn — skip to 5i.

Otherwise extract its `<case-id>` (everything between `ATTEMPT-FAILED:` and the `—` em-dash delimiter) and count how many failed attempts that same case has accumulated **in the current review cycle**. Splitting on the em-dash only — not on any hyphen — is load-bearing: a case id is `<story-file-stem>#V<n>` and a story file stem holds hyphens, so a `[—-]` split would truncate it. Scoping the count to lines after the last review-fail boundary stops a case that already went green in an earlier cycle from inheriting stale failures and false-escalating.

A guideline from a previous escalation (5h.1) also bounds the count. It is a
second boundary, not a replacement: the attempts a case made **before** its
guideline were made without it, so counting them again would send the case to
the human on its first attempt under the new direction. The count therefore
starts at whichever boundary is later:

```bash
CASE_ID=$(printf '%s\n' "$LAST_FAIL" | sed -E 's/^ATTEMPT-FAILED:[[:space:]]*//; s/[[:space:]]*—.*$//')
FAIL_LINE=$(grep -nE '^(HUMAN_REVIEW: FAIL|AUTO_REVIEW: FAIL)' '<discussion-file>' | tail -1 | cut -d: -f1)
GUIDE_LINE=$(grep -nF "DEBATE_GUIDELINE: $CASE_ID —" '<discussion-file>' | tail -1 | cut -d: -f1)
START=$(printf '%s\n%s\n' "${FAIL_LINE:-0}" "${GUIDE_LINE:-0}" | sort -n | tail -1)
FAIL_COUNT=$(awk -v s="$START" 'NR>s' '<discussion-file>' | grep -F "ATTEMPT-FAILED: $CASE_ID —" | wc -l | tr -d ' ')
```

**Check the out-of-lane marker before the count.** An engineer whose blocker needs a path locked to **every** role marks it `OPEN: OUT-OF-LANE — <repo-relative path> — <the change it needs>`. That is not a stuck implementation, and neither the attempt budget nor a debate guideline can move it:

```bash
OOL_LINE=$(grep -n '^OPEN: OUT-OF-LANE —' '<discussion-file>' | tail -1 | cut -d: -f1)
if [ -n "$OOL_LINE" ] && [ "$OOL_LINE" -gt "${START:-0}" ]; then
  OOL_PATH=$(sed -n "${OOL_LINE}p" '<discussion-file>' | sed -E 's/^OPEN: OUT-OF-LANE —[[:space:]]*//; s/[[:space:]]*—.*$//')
  scripts/lane-check.sh test-engineer "$OOL_PATH" >/dev/null 2>&1 && TE_MAY=yes || TE_MAY=no
  scripts/lane-check.sh software-engineer "$OOL_PATH" >/dev/null 2>&1 && SE_MAY=yes || SE_MAY=no
  echo "OUT-OF-LANE: $OOL_PATH te=$TE_MAY se=$SE_MAY"
fi
```

Splitting on the em-dash only is load-bearing here for the same reason it is for `CASE_ID`: a path contains hyphens.

- **`te=no` and `se=no`** → the path is locked to both engineers. **Stop the loop and escalate to the human operator now**, whatever `FAIL_COUNT` says. Print the `OPEN: OUT-OF-LANE` line, the denial reason `scripts/lane-check.sh` writes to stderr for that path, the discussion file path, and instructions to make the change — or amend the story that needs it — and re-run the skill. Jump to Step 8 with `reason=human-escalation-out-of-lane`. Do **not** run 5h.1: a debate cannot author a locked file, so its guideline would name a change no role may execute.
- **Either one `yes`** → the claim is wrong. The path is one engineer's lane, so the work is in lane for that role. Log `out-of-lane claim rejected: <path> is the <role> lane`, and fall through to the count below, which treats the turn as an ordinary failed attempt. The rejected claim reaches the human through the review, not through an escalation.

The `scripts/lane-check.sh` validation is what stops this marker becoming an exit hatch from a hard case: a role cannot escalate by asserting a lock the script does not agree with.

Then the count:

- If `FAIL_COUNT < 3` → log `attempt <FAIL_COUNT>/3 failed for case <CASE_ID>` and continue to 5i.
- If `FAIL_COUNT >= 3` and the case has **no** guideline in the current review cycle (`GUIDE_LINE` empty, or `GUIDE_LINE` not greater than `${FAIL_LINE:-0}`) → the case is stuck. Run the debate escalation of **5h.1**, then continue to 5i.
- If `FAIL_COUNT >= 3` and the case **already carries** a guideline in this cycle → the guideline failed too. **Stop the loop and escalate to the human operator** — print the failed-attempt lines, the guideline that did not unblock them, the discussion file path, and instructions to resolve the blocker and re-run the skill. Jump to Step 8 with `reason=human-escalation`.

(A case that flips to GREEN simply stops emitting `ATTEMPT-FAILED:` lines, so only a case that never goes green reaches the limit.)

### 5h.1. Debate escalation — ask for an unblock guideline before the human

Reached only from 5h, for one `<CASE_ID>` that failed 3 attempts with no
guideline yet in this review cycle. The `/debate` skill owns the engine call.
Restate none of its mechanics — not the engine selection, not the read-only
enforcement, not the watchdog, not the validation gate. It hard-fails loudly,
and every one of its failures is a human escalation here.

**1. Check the engine is usable.** `KANTHOR_DEBATE_ENGINE` must be set to one of
`opencode`, `codex` or `pi`, and its binary must be executable (`command -v`).
If it is not, do **not** fall back and do **not** retry the case: escalate to
the human now, with `reason=human-escalation` and the exact reason the engine is
unusable.

**2. Build the unblock prompt.** Assemble it from the repository, in this order:

- the numbered `<CASE_ID>` case from its story file, verbatim, with that story's `## Change` and `## Constraints`;
- every `ATTEMPT-FAILED:` line for `<CASE_ID>` after `START`, each with the turn
  that carries it;
- the failing assertion output the last `TEST-ENGINEER` turn pasted;
- the EPIC's `## Verification Gate`, both parts;
- the lane table of 5g.1, because a guideline that proposes an out-of-lane edit
  is unusable;
- this question, last:

  ```
  The TDD loop failed this case three times. Produce the unblock guideline: the smallest concrete change that makes the named check pass within the lanes above, named by file and line. If the case as specified cannot pass, state exactly why and what the EPIC or the story must change. Propose no scope the EPIC does not carry.
  ```

**Cap the assembled prompt at ~25 KB.** A large inlined input stalls the engine
silently. Trim the pasted turns first, longest first; never trim the case block,
the `ATTEMPT-FAILED:` lines or the question.

**3. Invoke `/debate` with that prompt** and take its merged answer as
`<GUIDELINE>`. Read the guideline before you record it: a guideline that names
no file, or that proposes an edit outside both engineers' lanes, is not usable
direction — treat it as a failed run and escalate to the human.

**4. On any `/debate` failure** — engine error, stall, or a failed validation
gate — print the failure verbatim, then **stop the loop and escalate to the
human operator**. Jump to Step 8 with `reason=human-escalation`. Never retry the
case on a failed debate, and never invent a guideline yourself.

**5. Record the guideline.** Append **one** block to the discussion file. This is
the orchestrator's third and last write, beside the Step 3 seed and the Step 6b
routing block. `/debate` is read-only and stays read-only: this write happens
after it returns, and it is `/work`'s write, not the engine's.

```bash
cat >> '<discussion-file>' <<'WORK_EOF'
DEBATE_GUIDELINE: <CASE_ID> — <one-line summary of the guideline>
GUIDELINE: <step 1 of the guideline>
GUIDELINE: <step 2 of the guideline>
WORK_EOF
```

One line per step, each a single line, so the engineers' `grep` of the tail
reads them whole. The marker also becomes the new counting boundary in 5h, which
gives the case 3 fresh attempts under the guideline.

**6. Continue.** Print `debate guideline issued for case <CASE_ID>`, do **not**
reset `turn_count` (the max-turns cap still bounds the run), and continue to 5i.
The next role comes from the 5d alternation as usual — a guideline is direction,
not a review verdict, so it does not override the alternation. The engineer whose
turn it is reads the guideline out of the discussion file.

### 5i. Increment and continue

`turn_count += 1`. Loop back to 5a.

## Step 6 — Human review handoff

Reached when Step 5b detects `^IMPLEMENTATION_READY_FOR_REVIEW:`. All cases are green and the verification gate has passed. Final review is the **human operator's**, recorded as a `HUMAN_REVIEW:` line.

### 6a. Check for the human verdict

```bash
grep -E '^HUMAN_REVIEW: (PASS|FAIL)' '<discussion-file>' | tail -1
```

- Latest line is `HUMAN_REVIEW: PASS` → jump to Step 7 (close lifecycle).
- Latest line is `HUMAN_REVIEW: FAIL` → **only** jump to Step 6d if that verdict has not been processed yet. It has already been processed when an `^IMPLEMENTATION_READY_FOR_REVIEW:` line appears **after** it — the engineers already fixed its blockers and re-signalled. In that case the verdict is spent: proceed to Step 6b for a fresh reviewer gate instead, or 6d would re-route the same blockers forever.
- No `HUMAN_REVIEW:` line yet → proceed to Step 6b (reviewer-engineer pre-gate).

```bash
FAIL_LINE=$(grep -n '^HUMAN_REVIEW: FAIL' '<discussion-file>' | tail -1 | cut -d: -f1)
awk -v s="${FAIL_LINE:-0}" 'NR>s && /^IMPLEMENTATION_READY_FOR_REVIEW:/' '<discussion-file>'   # non-empty ⇒ verdict spent ⇒ 6b
```

A `HUMAN_REVIEW:` verdict is scoped to **one** review cycle, not to the whole run; a cycle may therefore hold several verdicts, each answered by its own ready marker.

### 6b. Reviewer-engineer review gate + auto-routing of `action:YES` findings

The reviewer-engineer IS the code review. Every finding it returns is tagged `action:YES` (must be applied) or `action:NO` (no-op / informational). The orchestrator auto-routes the `action:YES` findings straight back through the TDD loop — **once** per review cycle — and surfaces only the `action:NO` findings to the human.

**First, has the auto-fix pass already run this review cycle?** It fires at most once between human verdicts:

```bash
LAST_HUMAN=$(grep -n '^HUMAN_REVIEW:' '<discussion-file>' | tail -1 | cut -d: -f1)
AUTO_DONE=$(awk -v s="${LAST_HUMAN:-0}" 'NR>s && /^AUTO_REVIEW: FAIL/' '<discussion-file>')
```

- If `AUTO_DONE` is **non-empty** → the `action:YES` findings were already routed and fixed this cycle. **Do not re-dispatch the reviewer.** Read back the recorded `action:NO` findings (`awk -v s="${LAST_HUMAN:-0}" 'NR>s && /^INFO: /' '<discussion-file>'`), present them to the human, and skip to Step 6c.
- If `AUTO_DONE` is **empty** → dispatch the reviewer now.

Extract the base ref and compute the changed files:

```bash
BASE_REF=$(grep '^base-ref:' '<discussion-file>' | head -1 | sed 's/^base-ref:[[:space:]]*//')
CHANGED_FILES=$( { git -C '<root>' diff --name-only "$BASE_REF"; git -C '<root>' ls-files --others --exclude-standard; } | LC_ALL=C sort -u)
```

Dispatch one `reviewer-engineer` agent (substituting `<root>`, `<EPIC_FILE>`, `<DISCUSSION_FILE>`, `<BASE_REF>`, and `<CHANGED_FILES>`):

```
Review the implementation for EPIC <EPIC_FILE>.

Working root: <root>
EPIC file: <EPIC_FILE>
Discussion file: <DISCUSSION_FILE>
Base ref: <BASE_REF>
Changed files (review ONLY these — do not review unchanged files):
<CHANGED_FILES>

Follow your per-review workflow exactly. Read the gotcha files first, then the EPIC/story files, then the changed source and test files. Cross-reference against all review dimensions and produce your structured verdict.
```

**Parse the reviewer's verdict** into two lists by each finding's `action:` tag: `YES` = apply, `NO` = informational.

- **If any `action:YES` finding exists** → auto-route them through the TDD loop (single pass). Append **one** routing block to the discussion file — the lone post-seed write the orchestrator makes. Each `action:YES` becomes a `BLOCKER:` the test-engineer turns into a regression; each `action:NO` is recorded as `INFO:` so it survives to the human pause:

  ```bash
  cat >> '<discussion-file>' <<'WORK_EOF'
  AUTO_REVIEW: FAIL — routing <N> action:YES finding(s) to the TDD loop; <M> action:NO finding(s) recorded for the human.
  BLOCKER: <action:YES finding 1 — name + one-line description>
  INFO: <action:NO finding 1 — name + one-line description>
  WORK_EOF
  ```

  Then print the routed blockers, reset `turn_count` to 0, and **jump back to Step 5**. When the loop next reaches `IMPLEMENTATION_READY_FOR_REVIEW:`, the `AUTO_DONE` guard fires and the cycle proceeds to the human pause with only the `action:NO` findings.

- **If no `action:YES` finding exists** → print the reviewer's full verdict, present any `action:NO` findings, and proceed to Step 6c.

### 6c. Pause for human confirmation

The reviewer's verdict is the review. Stop the loop and present it to the human for confirmation. Do **not** close the lifecycle.

```
REVIEW COMPLETE — <EPIC_SLUG>

Any action:YES findings were auto-routed through the TDD loop and fixed; only the action:NO findings (above) were left unapplied. All cases are green and the verification gate passed.

Record your decision in the discussion file (append, do not edit) and re-run /work:
  - To accept:    append `HUMAN_REVIEW: PASS`
  - To send back: append `HUMAN_REVIEW: FAIL` followed by one `BLOCKER: <issue>` line per finding to fix

Discussion file: <DISCUSSION_FILE>
```

Jump to Step 8 with `reason=awaiting-human-review`.

### 6d. Review failure routing

When the human recorded `HUMAN_REVIEW: FAIL`:

1. Collect all `BLOCKER:` lines that follow the failing verdict.
2. Print them to the user.
3. Reset `turn_count` to 0.
4. Jump back to Step 5. The test engineer turns testable blockers into failing regression tests; the software engineer fixes them. When the TE signals `IMPLEMENTATION_READY_FOR_REVIEW:` again, Step 6 re-runs.

Note: if the human fails review 3 times in one `/work` invocation, stop with `lifecycle=review-loop-limit` and let the human intervene directly.

## Step 7 — Close

Reached when Step 6a confirms `HUMAN_REVIEW: PASS`. That line **is** the closing record — there is no frontmatter or status board to update. The EPIC is done. Report closed, continue to Step 8 with `lifecycle=closed`.

## Step 8 — Exit

When the run ends, print a one-line summary:

- `done · turns=<N> · reason=<...> · human_review=<PASS|FAIL|pending> · lifecycle=<opened|closed>`

`lifecycle=opened` means the discussion file was seeded this run; `closed` means a `HUMAN_REVIEW: PASS` was confirmed. Then print a short bullet list of what happened this run.

## Notes for the orchestrator (you)

- Use `Bash` for `grep`/`sed`/`tail`/`awk`/path checks and the one-time seed. Use `Read` for the EPIC's `## Verification Gate`. Use the harness dispatch tool for subagent dispatch. The orchestrator touches the discussion file only via the Step 3 seed and the Step 6b auto-review block.
- Do not summarize, judge, or editorialize turns between dispatches. You dispatch; you do not participate. The one exception is 5h.1: an unblock guideline is a dispatch decision, not participation in a turn.
- `/debate` is the only skill this one invokes, and only from 5h.1. It never runs on a healthy loop, and it never runs twice for the same case in one review cycle.
- Test engineer always opens. The first dispatch is always `test-engineer` if the file is fresh.
- If the user interrupts, stop cleanly. Each subagent's append is atomic, and the orchestrator holds no other mutable state.
- **GREEN-only case flow.** Some cases state a build-only check and no test. The cycle is compressed: TE writes a GREEN-ONLY pass-through → SE implements the story's `## Change` for those cases → TE runs a build-only check (no test) and advances.

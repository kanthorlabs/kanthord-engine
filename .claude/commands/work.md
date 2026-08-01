---
description: Drive a TDD implementation cycle for one EPIC — dispatching test-engineer / software-engineer in alternation until IMPLEMENTATION_READY_FOR_REVIEW, then a reviewer-engineer gate that auto-routes action:YES findings back through the loop once, then the human review. Escalates to the human when one Task fails its attempt limit. Lifecycle state lives in the discussion file; the orchestrator writes no frontmatter or status board.
argument-hint: <epic-file-path> [--max-turns N]
allowed-tools: Bash, Read, Agent
---

# /work — orchestrate a TDD implementation cycle

Arguments: `$ARGUMENTS`

You are the **orchestrator**. You own everything the test-engineer / software-engineer cannot do on their own:

- **TDD dispatch** — alternating `test-engineer` and `software-engineer` turns until `IMPLEMENTATION_READY_FOR_REVIEW:` lands in the discussion file or the turn cap fires.
- **Escalation to the human** — counting `ATTEMPT-FAILED:` lines per Task; when one Task has failed **3** attempts, stopping the loop and handing it to the human.
- **Reviewer auto-fix routing** — after the reviewer-engineer gate, auto-routing every `action:YES` finding back through the TDD loop **once** per review cycle; only `action:NO` findings reach the human.
- **Final review handoff** — after implementation and the reviewer auto-fix pass, pausing for the **human operator's** review (`HUMAN_REVIEW: PASS|FAIL`). If the human fails it, routing their `BLOCKER:` lines back through the TDD loop.
- **Discussion-file seed** — the one-time header write.

Lifecycle state lives **only in the discussion file** — there is no separate status board and the EPIC/Story files carry no frontmatter to flip. An EPIC is "in progress" once its discussion file exists and "done" once that file contains `HUMAN_REVIEW: PASS`.

You do **not** commit; the human reviews and commits. You do **not** write to the discussion file after seeding it — subagents own every subsequent append via the race-safe `cat >>` protocol in their personas. (The one exception: the auto-review routing block the orchestrator appends in Step 6b.) You do **not** edit production sources, test files, or the locked EPIC/Story files — the engineers and the planning phase own those.

A "turn" is one logical handoff, not one keystroke. A subagent may make many tool calls inside a single Task invocation (read context, edit sources / test files, build, append) and produce one substantive entry in the discussion file. Granularity below that belongs in version-control commits, not in the discussion file.

The canonical TDD cycle:

- `test-engineer` opens with either a failing test (RED) for the next unimplemented Task, or a GREEN-ONLY pass-through for Tasks that have no `Action — RED:` block. Tasks are `### Task` headings in the Story files — there are no checkboxes; progress is tracked from the discussion file.
- `software-engineer` makes that test green by editing production sources (RED flow), or implements the forwarded Task(s) directly from the Story spec (GREEN-ONLY flow).
- `test-engineer` runs the test (GREEN), then either opens the next RED or — when every Task is green and the EPIC's Verification Gate runs clean — appends `IMPLEMENTATION_READY_FOR_REVIEW:`. For GREEN-ONLY Tasks, the TE runs a build-only check instead of a test.

**The ready marker has three preconditions, all of them mandatory.** The EPIC's `## Verification Gate` has **two** parts — `Gates:` and `Proof:` — and running only the `Gates:` is the single most common way this loop reports work that is not done:

1. **Every `### Task` in every Story file is green** — not "the stories expanded so far". A partial implementation cannot satisfy a whole-epic Proof, so a marker emitted with stories outstanding is invalid.
2. **The `Gates:` command runs green** (typically `npm run verify`).
3. **The `Proof:` command has actually been run**, and its real output — including the string the EPIC says it must print — is pasted into the turn.

A marker missing any of the three is premature: the orchestrator must **reject it** and dispatch the next engineer turn instead of advancing to Step 6. `Proof:` scripts live under `scripts/`, which every role may always **run** (see AGENTS.md); only the software-engineer may **modify** it, and never the three pipeline guards. "Lane-forbidden" is never a valid reason to skip the Proof.

After the TDD loop completes (`IMPLEMENTATION_READY_FOR_REVIEW:` detected), the orchestrator runs the **reviewer-engineer gate** and auto-routes its `action:YES` findings back through the TDD loop (once per cycle), leaving only `action:NO` findings for the human. It then **pauses for the human operator's review**. The human reviews the implementation and records the verdict in the discussion file as `HUMAN_REVIEW: PASS` or `HUMAN_REVIEW: FAIL` (with `BLOCKER:` lines). On `PASS`, the EPIC is done. On `FAIL`, the orchestrator routes the `BLOCKER:` lines back through the TDD loop until the next `IMPLEMENTATION_READY_FOR_REVIEW:`.

Separately, while the TDD loop runs, the orchestrator counts `ATTEMPT-FAILED: <task-id>` lines emitted by the engineers. When any single Task accumulates **3** failed attempts, the orchestrator stops the loop and escalates that Task to the human — the implementation cannot self-resolve it.

## Step 1 — Parse arguments

From `$ARGUMENTS`:

- **First positional** = EPIC file path (required). If missing or empty, print usage and stop.
- **`--max-turns N`** = override turn cap. Default `128`. `0` means unlimited (use with care).

Resolve `<root>` = `$(git rev-parse --show-toplevel)` once. Every path in the steps below resolves under `<root>`.

## Step 2 — Pre-flight checks (abort with a clear message on any failure)

All path checks below resolve under `<root>`.

1. The EPIC file exists and is readable.
2. The path is under `.agent/plan/epics/` (sanity guard — refuse arbitrary paths).
3. `.claude/agents/test-engineer.md` exists.
4. `.claude/agents/software-engineer.md` exists.
5. `.claude/agents/reviewer-engineer.md` exists.
6. `.agent/tdd/history/` exists (create it with `mkdir -p` if not).
7. **No double review on resume.** If the discussion file (Step 3) already exists and its latest `HUMAN_REVIEW:` line is `PASS`, this cycle is already done — report `already closed` and stop without dispatching.

## Step 3 — Derive the discussion file path

From the EPIC file path, extract the basename without `.md` as `<epic-slug>`. Compute today's date in UTC as `<YYYY-MM-DD>`. The discussion file path is:

```
<root>/.agent/tdd/history/<YYYY-MM-DD>-<epic-slug>.md
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
1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.
```

(If the discussion file already exists, leave it alone — you are resuming a prior cycle.)

## Step 4 — Environment pre-flight (once)

None needed. Tests and typecheck run in-process with no emulator, database, browser, or booted resource. Pass `n/a` as `<ENV>` in every dispatch.

## Step 5 — The dispatch loop

Initialize `turn_count = 0`. Sweep any stale draft temps left by an aborted prior run (the orchestrator owns these — see 5e/5g.1): `rm -f '<root>'/.agent/tdd/.*-response-*.md`. Then repeat:

### 5a. Stop on max-turns

If `max_turns > 0` and `turn_count >= max_turns`: report `max-turns reached (<N>)` and jump to Step 8 (do **not** close the lifecycle — the work isn't done).

### 5b. Stop on IMPLEMENTATION_READY_FOR_REVIEW

Only a ready marker **newer than the last review failure** counts — otherwise a stale marker from before a review failure (a human `HUMAN_REVIEW: FAIL` or an orchestrator-emitted `AUTO_REVIEW: FAIL` from Step 6b) would bounce the cycle straight back to Step 6 without running the blocker regressions.

```bash
FAIL_LINE=$(grep -nE '^(HUMAN_REVIEW: FAIL|AUTO_REVIEW: FAIL)' '<discussion-file>' | tail -1 | cut -d: -f1)
awk -v s="${FAIL_LINE:-0}" 'NR>s && /^IMPLEMENTATION_READY_FOR_REVIEW:/' '<discussion-file>'
```

If that prints any line, **validate the LATEST such marker before honouring it** (append `| tail -1` — a rejected marker stays in the file, so always judge the most recent one). Read the turn that carries it and confirm it evidences all three preconditions from "The ready marker has three preconditions" above: every Story Task green, the `Gates:` command green, and the `Proof:` command run with its real output and the EPIC's success string present. A marker that admits outstanding work ("Stories 4-6 remain pending", "not yet expanded") or that never ran the Proof is **premature**:

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
DRAFT_FILE=<root>/.agent/tdd/.<next>-response-$TURN_ID.md          # <next> = test-engineer | software-engineer
```

Also snapshot the set of changed files in `<root>` so Step 5g.1 can attribute this turn's edits and reject out-of-lane writes:

```bash
git -C '<root>' status --porcelain -uall | cut -c4- | sort > '/tmp/work-<epic-slug>-before-<turn>'
```

`-uall` is required so git lists each new file individually instead of collapsing it into a directory path; `sort` is required because Step 5g.1 feeds these snapshots to `comm`, which assumes sorted input.

### 5f. Dispatch the subagent

Call the Agent tool with `subagent_type` equal to `next` (`test-engineer` or `software-engineer`) and this prompt verbatim, substituting `<root>`, `<EPIC_FILE>` (= `<root>/<epic-relative-path>`), `<DISCUSSION_FILE>`, `<DRAFT_FILE>` (from 5e), and `<ENV>` (whatever Step 4 captured):

```
Continue the TDD implementation cycle for EPIC <EPIC_FILE>.

Working root: <root>            # ALL paths below resolve under this root.
Discussion file: <DISCUSSION_FILE>
Pre-flight resource: <ENV>             # whatever the pre-flight captured, or "n/a"

SINGLE-TURN CONTRACT (OVERRIDES everything below):
- ONE turn = ONE role = ONE append (ONE "END: <ROLE>") = ONE `cat >>`, then STOP and return your one-sentence summary.
- Do NOT switch/impersonate the other role.
- Do NOT spawn or dispatch any sub-agent.
- Append "IMPLEMENTATION_READY_FOR_REVIEW:" ONLY when this turn IS it (test-engineer, EVERY Task in EVERY Story green, Gates: green, AND the Proof: command run with its real output pasted in). Stories still unexpanded or unimplemented means NOT ready.

Follow your discussion-channel protocol exactly:
1. Read the EPIC file and the discussion file for full context. The EPIC's `## Verification Gate` is binding. The `## Architecture` section of AGENTS.md (repo root) is binding for all production code. The discussion file's last turn (if any) tells you what was just done.
2. Do the work your persona owns this turn:
   - If you are test-engineer: identify the next unimplemented Task, write its failing test under the exact verify path the Task names, then run the test using the project's test command and capture the failing assertion line. Tasks run in dependency order. When a Task has no `Action — RED:` block (GREEN-only), write a GREEN-ONLY pass-through turn listing the Task(s) for the software-engineer; do not write tests for them; after the SE's turn, run a build-only check. When every Task is green, run the Verification Gate and prepare an IMPLEMENTATION_READY_FOR_REVIEW turn if green.
   - If you are software-engineer: read the most recent TEST-ENGINEER turn, identify the failing test and the seam it imports, and edit production sources to make that test green with the smallest correct change. If the last TEST-ENGINEER turn is a GREEN-ONLY pass-through, read the Story file path and Task IDs from the turn and implement all listed Tasks' GREEN+REFACTOR specs from the Story file. Never edit the test files. Do not run tests.
3. Draft your turn into exactly this file: <DRAFT_FILE>
4. Append your turn to the discussion file via shell:  cat '<DRAFT_FILE>' >> '<DISCUSSION_FILE>'
5. Re-read the tail of the discussion file and verify the final non-blank line is exactly "END: <YOUR_ROLE>".
6. Do NOT delete <DRAFT_FILE> — /work removes it by its exact name after this turn.
7. STOP and return your one-sentence summary.

Do NOT use an editor on the discussion file — only shell append.
Do NOT edit files outside your lane (see the lane table in your persona).
Do NOT edit the EPIC or Story files — those are locked by planning. Do NOT touch the build/project config files (see the always-forbidden list in your persona).

If you are test-engineer and you have just confirmed that every Task is green AND the Verification Gate runs green end-to-end, append an IMPLEMENTATION_READY_FOR_REVIEW turn (still ending with END: TEST-ENGINEER). /work greps "^IMPLEMENTATION_READY_FOR_REVIEW:" to stop the TDD loop and hand the cycle to the human for review.

"The Verification Gate runs green end-to-end" means BOTH of its parts: the `Gates:` command AND the `Proof:` command, each actually executed this turn, with the Proof's real output (including the exact success string the EPIC names) pasted into your turn. A Proof script under `scripts/` is always allowed to RUN by every role — never skip it on lane grounds. If the Proof fails, you are not ready: report the failure as your turn instead. If any Story Task is still unimplemented or its story file still unexpanded, you are not ready either — open the next Task.
```

Also append:

```
If this turn is a failed attempt at the active Task — you raised an "OPEN:" blocker (missing copy, a missing seam, an unimplementable acceptance criterion), or (test-engineer) a confirm-GREEN turn found the test still red — add an "ATTEMPT-FAILED: <task-id> — <reason>" line just above your END marker. /work counts these per Task: 3 failed attempts on the same Task escalates it to the human.

Return one short sentence summarizing what you wrote.
```

### 5g. Verify the subagent wrote

Re-read the tail (same pipeline as 5c) and also check for any new `^IMPLEMENTATION_READY_FOR_REVIEW:` line. Compare with `tail_before`:

- If the tail is unchanged AND no new `IMPLEMENTATION_READY_FOR_REVIEW:` line appeared → abort with `"subagent <next> returned but discussion file unchanged"`. Leave the file as-is for human review.

### 5g.1 Lane ownership check (git diff)

Lane boundaries are stated in the personas but nothing enforces them. Compute the files this turn changed (in `<root>`) and reject any write outside `next`'s lane — a cheap backstop.

```bash
git -C '<root>' status --porcelain -uall | cut -c4- | sort > '/tmp/work-<epic-slug>-after-<turn>'
TURN_FILES=$(comm -13 '/tmp/work-<epic-slug>-before-<turn>' '/tmp/work-<epic-slug>-after-<turn>')
```

Tests are **co-located** with source (`bar.ts` + `bar.test.ts` in one dir), so a
prefix table cannot separate the lanes — this project uses a **predicate
script**: `scripts/lane-check.sh <role> <path>` (exit 0 = in-lane).

- **test-engineer** lane: `src/**/*.test.ts`, `src/**/*.spec.ts`; plus its
  draft files under `.agent/tdd/` and its journal under
  `.agent/tdd/memory/test-engineer/`.
- **software-engineer** lane: `src/**/*.ts` that is NOT a `*.test.ts` /
  `*.spec.ts`; plus `scripts/**` (helper/proof scripts its work needs — the
  three pipeline guards below stay locked); plus its draft files and journal as
  above.
- **Always forbidden to BOTH** (the lane script denies these for every role):
  the locked plan tree `.agent/plan/**`; the pipeline files `.claude/**` and
  `.opencode/**`; the pipeline guards `scripts/lane-check.sh`,
  `scripts/verify-handoff.mjs`, `scripts/memory-append-only.sh`;
  toolchain/config `package.json`, `package-lock.json`, `tsconfig*.json`,
  `*.config.*`; the architecture contract `AGENTS.md`; container/build files
  `Containerfile`, `compose.yaml`, `Makefile`. The reviewer-engineer edits
  nothing at all.

Both roles may also write `.agent/tdd/` and their own `.agent/tdd/memory/<role>/` journal dir (under `<root>`).

If any path in `TURN_FILES` fails the active role predicate (or hits an always-forbidden path) → abort with `"lane violation: <role> changed <path>"` and leave the tree for human review. (`<DRAFT_FILE>` itself lives under `.agent/tdd/` and so is always in-lane.)

Otherwise the turn is clean. Delete this turn's draft temp by its **exact** path — the orchestrator owns this cleanup: `rm -f '<DRAFT_FILE>'`. Then remove the two `/tmp` snapshot files.

### 5h. Escalation — one Task fails its attempt limit → Human

After verifying the subagent wrote, check whether this turn was a **failed attempt** at the active Task. Engineers mark a failed attempt with a greppable line `ATTEMPT-FAILED: <task-id> — <reason>`.

```bash
LAST_FAIL=$(grep '^ATTEMPT-FAILED:' '<discussion-file>' | tail -1)
```

If `LAST_FAIL` is empty → no failed attempt this turn — skip to 5i.

Otherwise extract its `<task-id>` (everything between `ATTEMPT-FAILED:` and the `—` em-dash delimiter) and count how many failed attempts that same Task has accumulated **in the current review cycle**. Splitting on the em-dash only — not on any hyphen — is load-bearing: task-ids contain hyphens, so a `[—-]` split would truncate them. Scoping the count to lines after the last review-fail boundary stops a Task that already went green in an earlier cycle from inheriting stale failures and false-escalating:

```bash
TASK_ID=$(printf '%s\n' "$LAST_FAIL" | sed -E 's/^ATTEMPT-FAILED:[[:space:]]*//; s/[[:space:]]*—.*$//')
FAIL_LINE=$(grep -nE '^(HUMAN_REVIEW: FAIL|AUTO_REVIEW: FAIL)' '<discussion-file>' | tail -1 | cut -d: -f1)
FAIL_COUNT=$(awk -v s="${FAIL_LINE:-0}" 'NR>s' '<discussion-file>' | grep -F "ATTEMPT-FAILED: $TASK_ID —" | wc -l | tr -d ' ')
```

- If `FAIL_COUNT < 3` → log `attempt <FAIL_COUNT>/3 failed for task <TASK_ID>` and continue to 5i.
- If `FAIL_COUNT >= 3` → the Task is stuck. **Stop the loop and escalate to the human operator** — print the failed-attempt lines, the discussion file path, and instructions to resolve the blocker and re-run `/work`. Jump to Step 8 with `reason=human-escalation`.

(A Task that flips to GREEN simply stops emitting `ATTEMPT-FAILED:` lines, so only a Task that never goes green reaches the limit.)

### 5i. Increment and continue

`turn_count += 1`. Loop back to 5a.

## Step 6 — Human review handoff

Reached when Step 5b detects `^IMPLEMENTATION_READY_FOR_REVIEW:`. All Tasks are green and the verification gate has passed. Final review is the **human operator's**, recorded as a `HUMAN_REVIEW:` line.

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
CHANGED_FILES=$(git -C '<root>' diff --name-only "$BASE_REF"..HEAD)
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

Follow your per-review workflow exactly. Read the gotcha files first, then the EPIC/Story files, then the changed source and test files. Cross-reference against all review dimensions and produce your structured verdict.
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

Any action:YES findings were auto-routed through the TDD loop and fixed; only the action:NO findings (above) were left unapplied. All Tasks are green and the verification gate passed.

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

- Use `Bash` for `grep`/`sed`/`tail`/`awk`/path checks and the one-time seed. Use `Read` for the EPIC's `## Verification Gate`. Use `Agent` for subagent dispatch. The orchestrator touches the discussion file only via the Step 3 seed and the Step 6b auto-review block.
- Do not summarize, judge, or editorialize turns between dispatches. You dispatch; you do not participate.
- Test engineer always opens. The first dispatch is always `test-engineer` if the file is fresh.
- If the user interrupts, stop cleanly. Each subagent's append is atomic, and the orchestrator holds no other mutable state.
- **GREEN-only Task flow.** Some Tasks have no `Action — RED:` block. The cycle is compressed: TE writes a GREEN-ONLY pass-through → SE implements GREEN+REFACTOR → TE runs a build-only check (no test) and advances.

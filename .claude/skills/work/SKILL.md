---
name: work
description: Orchestrate one EPIC through guarded TDD, exact-grant groundwork, case-scoped debate, one reviewer auto-repair pass, and human review. Lifecycle state stays in the append-only discussion; one commit per completed story, and no plan edits.
---

# /work — one EPIC, guarded TDD

Arguments: `$ARGUMENTS` = `<epic-file-path> [--max-turns N]`. Read the invocation text when the harness does not substitute arguments. Default cap: **128**; `0` is unlimited. Reject missing paths, unknown arguments, and invalid counts.

You orchestrate; you do not implement, write tests, or redesign the plan. You commit only through the helper's `commit` command, once per completed story, and never by hand. Use the harness's actual subagent dispatcher and the **effective** `test-engineer`, `software-engineer`, `groundwork-engineer`, and `reviewer-engineer` definitions this harness loads from `.claude/agents/`. `.opencode/agents/` mirrors those bodies for a different harness; `scripts/persona-sync.test.sh` keeps the two in step. Keep their model, variant, tools and permissions unchanged.

## 1. Runtime and authority

This skill requires its sibling **`scripts/work-runtime.mjs`**. Resolve its absolute path as `R` from this installed skill directory, not from a guessed repository script. Execute it with Node; do **not** load its implementation, tests, or audit documents into the agent context. Missing helper or failing checks means STOP, not an improvised shell-parser fallback.

The discussion remains the only lifecycle ledger. The helper appends `WORK-EVENT:` receipts, groundwork completions, guidelines and review routing; workers append their own single turns. These receipts replace prose-driven bookkeeping, not the EPIC/story contracts. Private temporary snapshots/session envelopes and an exclusive worktree lock are execution evidence, not another status board. Do not edit EPIC/story frontmatter, production, tests, configuration, guard scripts, or other histories yourself. Never read/copy denied `.env` material or grant a worker broader permissions.

The helper performs deterministic discovery, counting, append validation, fingerprint comparison, grant checks and receipt creation. **You still verify meaning:** the correct source instruction, all required checks, real evidence, complete case coverage and unresolved design decisions. A JSON `true` is your recorded assessment, not proof the helper independently executed a gate.

## 2. Open or resume

Resolve the Git root and invoke:

```sh
node "$R" open --root "$ROOT" --epic "$EPIC" --max-turns "$MAX_TURNS"
```

Keep the returned absolute `session` path as `S`; reuse it in every command. Paths in JSON are literal repository-relative strings unless explicitly absolute. Put request/assessment JSON and captured reviewer text in the returned session's private temporary directory, **outside the repository**. Quote shell arguments; never shell-evaluate file content.

`open` validates the EPIC location, all four personas and the existing guard files. It discovers discussions by exact EPIC identity across dates; it never chooses today's filename merely because work resumed today. Multiple unfinished histories require the operator to select one explicitly with `--discussion`. A latest human PASS reports `already-closed` without dispatch. A new cycle needs a clean tree outside `.agents/tdd/`, because an operator edit left in place would land inside a story commit; commit or stash first. A new cycle records HEAD as `base-ref` and quotes the EPIC Verification Gate; existing files are not reseeded. Read the live EPIC as the contract, not only its quoted historical copy.

Only one `/work` invocation may own a worktree. On a lock conflict, inspect the reported owner/session and stop; never steal the lock or launch another EPIC in that tree. Legacy histories are recognized, but their prior guard checks cannot be reconstructed: require explicit operator authorization before reopening with `--adopt-legacy`. This records trust in the old history, not retrospective verification.

Pre-flight resource remains `n/a`. Do not install dependencies or boot external resources to hide missing prerequisites.

## 3. Drive the loop from recorded state

```sh
node "$R" state --session "$S"
```

Use its boundaries, exact request IDs, counters, accepted-turn ranges and next role; do not reimplement them with `grep`/`sed`. Re-read binding source when needed. Source order and case selection remain TE's responsibility; a case is `<story-file-stem>#V<n>`, never one `### Change` heading.

Process this priority order:

1. **Interrupted turn:** a `pending` entry must be recovered as in §10, never skipped or counted as completed. A human PASS closes the lifecycle without further dispatch.
2. **Pre-loop groundwork:** process the returned nonempty `groundwork.grant` under §5 before the first engineer turn. A third exhausted attempt requires the human, not another dispatch.
3. **Outstanding locked-path requests:** process **all** requests, oldest first, under §5. Do not look only at the newest marker. Ignore an `engineer-owned` claim for groundwork routing; log its real owner and retain the ordinary failure accounting.
4. **Readiness:** a nonrejected `readyCandidate` needs §8 validation. `validReady` goes to §9. A rejected candidate requires a fresh TE turn; it does not reset case counters or become a review failure.
5. **Uncommitted completed story:** a nonnull `commits.owed`, or a nonnull `commits.intent`, goes to §6 before any dispatch.
6. **Failed active case:** examine the latest accepted engineer turn and its current unresolved failures. For every affected case, use `counts`, not only the last failure line. Apply §7 before dispatching. Do not re-escalate a historical failure that later evidence resolved. Expected RED, a protocol-only handoff failure and a genuine locked-path handoff are not ordinary failed-case attempts.
7. **Next engineer:** dispatch `nextRole` under §4. Fresh work starts with TE. A review failure forces TE first even after a TE turn; groundwork turns do not advance the alternation. Otherwise TE and SE alternate.

Every dispatched worker, reviewer and `/debate` invocation consumes the cap **before** invocation. Never reset it after automatic/human review routing or inside a retry loop. A new `/work` invocation has a new cap; failures/guidelines remain scoped to discussion boundaries. Three human review failures inside one invocation stop with `review-loop-limit`.

## 4. One guarded dispatch

Call `begin` before invoking any role. For ordinary engineers:

```sh
node "$R" begin --session "$S" --role "$ROLE"
```

It returns a unique turn ID, exact draft, discussion and saved pre-turn evidence. Freeze these values. No `$$` names, recomputed dates, shared `/tmp` filenames or global draft sweeps. The draft path stays fixed even across UTC midnight.

Send the selected worker **only** its persona plus these inputs:

```text
Continue one <ROLE> turn for EPIC <EPIC>.
Working root: <ROOT>
Discussion file: <DISCUSSION>
Draft file: <DRAFT>
Turn ID: <TURN_ID>
Pre-flight resource: n/a
Relevant context: <latest accepted handoff/ranges; unresolved active blockers;
applicable case-specific guideline; any rejected-readiness reason>

One role, no subagents, one complete draft, one cat >> append, one final
END: <UPPERCASE_ROLE>, then return one sentence. Save work and collect evidence
before the discussion append. Leave the draft for /work.
Use only the supplied protocol paths and your existing lane. A cited
handoff does not grant someone else's files. No commits or staging.
Read your required sources; SE reads the whole active story's Change,
Constraints, and authoritative ship diagram/Seams, never isolated steps.
For each check, put its exact command, `exit <actual code>`, and real
stdout/stderr together in one contiguous evidence snippet. Annotate truly
empty output as `stdout/stderr: <empty>`; do not invent output.
Machine markers go at column one outside fenced command output.
```

Do not paste the other role's workflow into that dispatch. Preserve RED, same-story GREEN-only batching, independent TE handoff verification, named REFACTOR, exact signatures/copy, and all persona-specific obligations. The context index does not replace required source reads or evidence.

After the agent returns, **verify its meaning before you accept it**: read the turn, confirm the required sources, the real evidence and the claimed case. `finish` accepts the turn permanently and no operation rejects it afterwards, so an inspection after `finish` is too late.

For `test-engineer` and `software-engineer`, record that finding and finish:

```sh
node "$R" finish --session "$S" --assessment <file>
```

```json
{
  "turn": "<this turn ID>",
  "cases": ["01-story#V1"],
  "evidence": "<exact contiguous excerpt of this turn>"
}
```

Name every case the turn actually carries; each must appear in the turn, and `evidence` must be an exact excerpt of it. A turn you cannot assess is not accepted: leave it pending and escalate to the human.

For groundwork, supply its assessment as in §5. `finish` verifies the saved discussion prefix, exact draft suffix appended once, exactly one correct terminal END, reserved-marker ownership, content-fingerprint changes, and Git HEAD/branch/staged content. It calls the real lane predicate for **every** changed path. Protocol exceptions are only this draft and this discussion—not all `.agents/tdd/`. `.agents/tdd/memory/` is read-only for every role; a worker writes no per-turn journal. Groundwork additionally needs exact grant membership.

A clean finish records acceptance and removes only that draft. Any failure stops the cycle, preserves evidence/draft/tree for inspection, and records **no acceptance or completion**. Never automatically revert another actor's work, weaken a guard, or continue after a failed check. Snapshot validation detects persistent covered changes; it is not a sandbox against transient, ignored-file or external writes.

## 5. Groundwork: exact instruction, exact grant, positive proof

Pre-loop request `00-groundwork` comes from `00-groundwork.md` declaring `Executor: groundwork-engineer`. `Paths:` must be nonempty. JSON arrays are preferred; legacy simple lists and one-path-per-line lists are supported. The instruction is the **whole verbatim `## Change`**; retain its case IDs and required build-only checks. Validate every path against the existing guard. An ambiguous instruction or a test-running Verify command is an authoring blocker.

Completion is revision-aware: paths already proven for the **same story hash** are skipped. A changed story invalidates its old proof and rechecks the full current grant idempotently, including edits to already-named paths. Do not treat an old same-path completion as proof of newly changed instructions.

A mid-loop `OPEN: OUT-OF-LANE — <path> — <change>` gets the stable ID `OOL-<original-line>`. Its **exact change clause**, not the story's Change section, is the instruction. The active story supplies constraints/context. A `package.json` request also grants `package-lock.json`; no other implicit companion is added. Do not substitute a different package-manager lockfile without an explicit request/authorized planning correction.

Respect the returned route:

| Route             | Action                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `human-locked`    | Immediate human escalation; no role/debate can write this path.                                                        |
| `human-repeat`    | Same path was already completed by an OOL request in this failure epoch: human review, not repeated automatic editing. |
| `human-threshold` | Two OOL requests already completed: stop **before** dispatching the third.                                             |
| `groundwork`      | Dispatch its exact outstanding request and grant.                                                                      |
| `engineer-owned`  | False OOL claim; retain ordinary engineer routing/counts.                                                              |

Completion consumption always uses request ID, not a path substring. The repeat/threshold policy separately uses completions after the latest human/automatic review failure. Historical consumed requests never become outstanding again. `AGENTS.md` requires exact human/plan-approved text; a model's proposed architecture is not that authorization.

Prepare metadata JSON for `begin --role groundwork-engineer --meta <file>`:

```json
{
  "request": {
    "id": "OOL-123",
    "sourceFile": ".agents/plan/stories/<epic>/<story>.md",
    "instruction": "<exact change clause>",
    "paths": ["package.json", "package-lock.json"],
    "cases": [],
    "checks": ["pnpm run typecheck", "pnpm run lint"]
  }
}
```

For pre-loop work, use `id: 00-groundwork`, the actual story path, its remaining grant, complete Change text and actual case IDs. Take named build-only checks without weakening them. A mid-loop story is context, not a transfer of its TE-owned tests: use any explicitly requested build-only checks; when none are named, use the existing project `pnpm run typecheck` and `pnpm run lint` **after confirming their definitions exist and are build-only**. Missing/unsafe definitions require the human, not improvised commands.

Add the following to the common worker dispatch:

```text
Request ID: <ID>
Story file (constraints/context): <SOURCE_FILE>
YOUR INSTRUCTION — binding: <INSTRUCTION>
PATHS YOU MAY WRITE — complete grant: <one exact path per line>
Cases / required build-only checks: <CASES / CHECKS>
Apply YOUR INSTRUCTION even when the context story does not repeat it.
Take no unspecified decision. Report Result PASS only with all edits and
checks proven; otherwise BLOCKED with OPEN and the correct failure ID.
Never emit readiness, WORK-EVENT, or GROUNDWORK-COMPLETE.
```

Inspect actual edits and the returned transcript. For PASS, create an assessment containing `request`, `instructionSatisfied: true`, one `applied: [{path,evidence}]` entry per granted path, and `checks: [{command,exit,output,evidence}]`. `evidence` is an **exact contiguous excerpt** of this turn with that command, one `exit 0` line and its real output. Every required check must appear exactly once. Already-satisfied edits need evidence, not fictitious writes.

Run `finish --assessment <file>` for PASS; run ordinary `finish` for explicit BLOCKED. Acceptance and successful `GROUNDWORK-COMPLETE: <id> — ["path",...]` are appended together. Absence of OPEN is insufficient. A clean failed turn remains outstanding. Retry at most three **failed turns**, counting a batched failure once per request, from the ledger. Missing grants/ceiling denials stop immediately. No groundwork debate rung. After completion, resume the unchanged engineer alternation.

For repeat/threshold/exhaustion recovery, tell the human to fix the instruction/grant or add the missing groundwork, then append `HUMAN_REVIEW: FAIL` and precise `BLOCKER:` lines and rerun. Do not amend plans or invent that verdict yourself.

## 6. Story commit

A completed story earns exactly one commit, and the helper makes it. No persona commits or stages: `validateEffects` compares Git HEAD, the branch and the index across every turn, and that comparison is what stops a worker hiding a write behind a commit.

A story is complete when its closing turn is accepted and nothing has touched the tree since. For an ordinary story that turn is the test-engineer turn carrying `STORY-COMPLETE: <story-stem> — cases: <ids>`; for a story whose `Executor:` is the groundwork-engineer it is the accepted groundwork turn with a current `GROUNDWORK-COMPLETE`. An accepted turn alone proves neither: SE runs no test, a blocked turn is still protocol-valid, and a named REFACTOR may stand deferred. Never derive completion from case membership.

Read the story's `## Verify` section, take the commands it names, and record your assessment:

```json
{
  "turn": "<the closing turn ID>",
  "story": "<story-file-stem>",
  "storyGateSource": "<entire Verify section, verbatim>",
  "required": ["<exact command the Verify section names>"],
  "checks": [
    {
      "command": "<the same command>",
      "exit": 0,
      "output": "<real output>",
      "evidence": "<exact command-local excerpt of the closing turn including exit 0>"
    }
  ]
}
```

```sh
node "$R" commit --session "$S" --story "<story-file-stem>" --assessment <file>
```

The helper refuses a story whose closing turn is blocked, whose marker names the wrong cases, whose earlier stories are uncommitted, or whose current fingerprint differs from the closing turn's receipt. That fingerprint equality is the real authorization: it proves these exact bytes are the ones a turn already validated. A lane check says only that some role may write a path; it never says the bytes belong to this story.

The commit is journaled. The helper appends `commit-intent` with the expected parent and tree, commits, then appends `story-commit` with the resulting SHA. An interrupted commit is reconciled by parent and tree identity on the next `commit` call, never by matching the message. Call `commit` again to settle a nonnull `commits.intent` before anything else.

The commit excludes the discussion, so the ledger never enters a story commit and the pre-commit hook cannot reformat it. `.prettierignore` holds `.agents/tdd/` for the same reason.

The pre-commit hook runs `prettier --write` and `eslint --fix` over staged files, so it can rewrite bytes no turn validated. The helper compares the staged tree with the committed tree and reports `committed-with-hook-changes` plus the exact paths. Treat those paths as unverified: name them to the test-engineer in the next dispatch, and never report them as reviewed. A `commit-discarded` result means the hook rejected the commit; read its `hook` output, fix the cause, and call `commit` again.

One commit per story is the whole policy. A story repaired after a review failure earns no second commit; its repair stays in the working tree, the reviewer sees it, and the human commits it at PASS. A story commit is a checkpoint, never a publication: nothing is pushed, and no history is rewritten.

## 7. Ordinary failure → debate → human

An ordinary case receives three failed attempts after the later of its current review-failure boundary and its own guideline. Markers in fenced logs and duplicated same-case lines in one turn do not add attempts; all failed cases in a batch are considered. The same source case ID survives review repairs.

At three failures without a current guideline, check `KANTHOR_DEBATE_ENGINE` is set and names an engine `/debate` accepts, and that its binary is executable. `/debate` owns that value set; never restate it here, because a second copy goes stale. No fallback engine or invented guideline. If unusable, stop for the human. Otherwise assemble: exact case; whole story Change/Constraints; failed-turn evidence; last failing assertion; full EPIC Gates/Proof; applicable lane limits; the request for the smallest in-scope, file/line-specific unblock direction. Keep input near 25 KB; trim duplicated/long turn output first, never the case, failure markers or question. If essential contracts cannot fit, stop rather than omit them silently.

Call `begin --role debate --meta <JSON with caseId>` before invoking `/debate`. `/debate` remains the only subordinate skill and owns its engine, watchdog and read-only behavior. Validate its returned direction against scope and actual lane checks. A required locked-plan/new design change goes to the human, not a fabricated executable guideline.

On success, pass `finish --assessment <file>` with `caseId`, `summary`, `files` and single-line `steps`. Each proposed file must be TE/SE-writable. The helper records `DEBATE_GUIDELINE:`/`GUIDELINE:`. For an engine/validation failure, record `{"outcome":"FAILED","reason":"<actual failure>"}` with `finish`, then stop for the human. No silent retries. A detected repository mutation instead fails the turn and preserves evidence.

A valid guideline stays applicable to that case until resolution/supersession, not merely until the next turn. Three more ordinary failures under it require the human. Never issue a second guideline for that case within the failure epoch. Debate does not change engineer alternation or reset the invocation cap.

## 8. Readiness is an evidence gate

Every story carries a `story-commit` before readiness, and the last story commits before the readiness turn, not after it: `ready` binds to the readiness turn's fingerprint, and a commit changes it. Never commit between the readiness turn and `ready`, or between `ready` and the reviewer's verdict.

Only the latest accepted TE readiness turn after the review-failure boundary can qualify. Require every numbered Verify case in every EPIC story, including revision-current groundwork completions; no unexpanded/missing story or unresolved blocker; every Change obligation covered by an existing case/gate; every required story gate and **both** EPIC Gates and Proof actually executed this turn. The real Proof output must include its specified success string. A script's edit lane is not a reason to skip executing a permitted Proof. Missing coverage is an authoring defect, not permission to invent a case.

Use `plan --session "$S"` for a mechanical case inventory, then compare it to the EPIC's ordered Stories and source files. The story directory is the case source; the EPIC `## Stories` section is prose, so that comparison stays your semantic check. Unsupported Verify formatting or missing source is a stop, not inferred coverage. Read the TE's referenced turn and verify commands/exits/output against the complete live Verification Gate.

The EPIC names the gates, not your assessment. The helper reads every backticked command on the `Gates:` line of the Verification Gate and requires exactly those in `gates`. Supply each one, and no other. The cited TE turn must also name every case, so a readiness turn that reports counts alone is rejected.

Record your assessment with `ready --session "$S" --assessment <file>`:

```json
{
  "turn": "<accepted TE turn ID>",
  "cases": ["01-story#V1"],
  "obligationsReviewed": true,
  "unresolved": [],
  "sourceCoverageReviewed": true,
  "storyGatesReviewed": true,
  "gateSource": "<entire Verification Gate section>",
  "gates": [
    {
      "command": "<exact required command>",
      "exit": 0,
      "output": "<real output>",
      "evidence": "<exact command-local transcript including exit 0>"
    }
  ],
  "proof": {
    "command": "<exact Proof command/block>",
    "exit": 0,
    "output": "<real output>",
    "evidence": "<exact command-local transcript including exit 0>",
    "success": "<source-required success string>"
  }
}
```

Include **all** commands/cases, not just the illustrative entries. The helper validates coverage IDs, groundwork source revisions, transcript correspondence and current fingerprints; your source audit remains necessary to establish complete command/obligation coverage. Never fill booleans speculatively.

For premature/stale readiness, call `reject-ready --session "$S" --reason "<missing evidence/work>"`, leave history intact, and send TE to correct/verify it. This is neither confirmed readiness nor another case failure. Non-executable mandatory work or a plan defect requires a human blocker, never a weaker gate.

## 9. Reviewer gate and human review

On valid readiness, first inspect `autoUsed` and `currentReview`. Reuse a matching recorded review; never redispatch merely because the operator has not answered yet. After the single automatic repair pass, do **not** rerun the reviewer: require fresh TE readiness and present the retained findings plus repair evidence. Clearly say the repaired revision was **not independently re-reviewed**. A routed finding is not resolved merely because it was routed.

Otherwise obtain `scope --session "$S"`, then `begin --role reviewer-engineer`. Supply root, EPIC, discussion, baseline and the exact changed-file array. The diff is baseline-to-**current working tree**, including staged/unstaged changes, untracked files and deletions—not `<base>..HEAD`. Unchanged files can supply contract context; full verification remains project-wide. Ask for the persona's ten-dimension review, independent Gates/Proof, per-file verdicts and AC/directive coverage, without repository or discussion writes.

Require literal `action:YES`/`action:NO` tags and a Verification evidence table with four columns: check, exact command, exit/NOT_RUN, actual output/evidence; include Proof's success string on its row. The helper rebuilds the mandatory command set from the live EPIC, not from the readiness receipt, and a mandatory check reported `NOT_RUN` or nonzero must carry an `action:NO` blocker for the human. Capture the returned verdict unchanged into a private report file. Inspect scope/coverage/citations and every mandatory command before running `finish --report <file>`. Do not edit a deficient verdict into a passing one; malformed output is a protocol failure for human inspection.

The helper preserves severity and action independently:

- Every `action:YES` finding is routed once as an `AUTO_REVIEW: FAIL`/`BLOCKER:` repair, retaining whether its original severity was BLOCKER or SUGGESTION. TE creates the testable regression before SE fixes it. The cap does not reset.
- Every `action:NO` remains for the human. **BLOCKER + action:NO is mandatory**, not informational, and remains `NEEDS-HUMAN`. Only nonblocking suggestions are INFO. A NOT_RUN mandatory check cannot produce PASS.

Human failure starts a new review epoch: collect its BLOCKER lines through the next control boundary, not all historical blockers, and return to TE. Human PASS alone closes the lifecycle; never write it yourself. At the pause, show reviewer verdict, unresolved human blockers, automatic repair status, real verification evidence and every consumed groundwork request. Ask the operator to append `HUMAN_REVIEW: PASS`, or `HUMAN_REVIEW: FAIL` plus one precise BLOCKER per required repair. Stop; do not wait or commit.

## 10. Recovery and exit

A completed worker append is not accepted until `finish` validates it. After interruption, reuse the original session only after confirming no invocation/subagent is still active. If its before-evidence, draft and append are intact, run the pending `finish` rather than redispatching. Missing evidence, partial append or failed checks requires operator inspection; do not reconstruct a favorable baseline from the already-mutated tree.

`abandon --session "$S" --confirm-idle --human-reason "<authorized reason>"` is **operator-authorized recovery only**. It rejects the pending turn without accepting its markers or deleting evidence. The operator must inspect/repair the tree and append a human FAIL with blockers before further work. Never use abandonment to bypass a lane or permission failure.

On a normal pause/cap/closed exit with no pending turn, run `close --session "$S"` to release the owned lock. Keep private evidence for inspection; do not sweep other runs. Pending/error exits retain the lock/evidence until resolved. One filesystem append is not a guarantee against power loss; malformed/truncated receipts stop parsing.

Print:

`done · turns=<all charged dispatches> · commits=<story commits this cycle> · reason=<reason> · human_review=<PASS|FAIL|pending> · lifecycle=<opened|resumed|closed>`

Then identify the discussion, committed stories with their SHAs, any path a hook rewrote, consumed groundwork IDs/paths, remaining blockers, and precise next operator action. Preserve the specific groundwork story/grant/repeat/threshold/attempts and locked-path escalation reasons. No claims of completion, successful verification or performance improvement without their evidence.

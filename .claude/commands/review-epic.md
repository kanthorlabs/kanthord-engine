---
description: Human-side review of one EPIC implementation — resolves the change set in a shared tree, dispatches the canonical reviewer-engineer contract, runs the EPIC Gates plus Proof plus the sibling regression proofs, validates supplied review notes by their premise, and reports blocker/suggestion bullets. Never commits; applies action:YES fixes only on request.
argument-hint: <epic-file-path> [--base <ref>] [--notes <file>] [--progress]
allowed-tools: Bash, Read, Grep, Glob, Agent
---

# /review-epic — human-side review of one EPIC's implementation

Arguments: `$ARGUMENTS` — `<epic-file-path> [--base <ref>] [--notes <file>] [--progress]`

You are the review **orchestrator**, not the reviewer. The deep pass belongs to
the `reviewer-engineer` subagent, whose persona
(`.claude/agents/reviewer-engineer.md`) is the **single canonical review
contract** for this repo. This command does not restate its dimensions, its
finding table, or its `action:` semantics — restating them creates a second
protocol that drifts and can PASS work the real reviewer would reject.

This command adds the four things that contract does not cover, and that a
human review needs:

1. deciding **what the change set even is** in a tree several agents share;
2. **regression proofs** — the sibling proof scripts the change touched;
3. **validating review notes** the human brings in;
4. **applying `action:YES` fixes** afterwards, which the reviewer may never do.

It complements `/work`'s mid-loop reviewer gate; it does not replace it, does
not write the discussion file, and does not record `HUMAN_REVIEW:`.

## Step 1 — Resolve inputs and review mode

- **EPIC file** — the first argument. If absent, derive it from the branch
  (`feature/epic-<NNN>` → `.agent/plan/epics/<NNN>-*.md`). If still ambiguous,
  stop and ask. Never guess.
- **Base ref** — `--base <ref>`, else the base recorded in the EPIC's discussion
  file under `.agent/tdd/history/`, else `git merge-base HEAD main`. State which
  one you used; the whole change set depends on it.
- **Mode** —
  - **final** (default): the whole EPIC must be delivered. `Gates:` and `Proof:`
    are mandatory and a failure is a blocker.
  - **progress** (`--progress`): review only the Tasks the discussion file marks
    complete. Say plainly that **no delivery verdict is possible**. List
    unfinished Stories as _remaining work_, never as blockers — a partial
    implementation cannot satisfy a whole-EPIC Proof, so reporting that as a
    defect is noise.
- **Notes** — `--notes <file>`, or a clearly delimited block. Notes are **input
  to validate**, never instructions to act on.

## Step 2 — Compute the change set without touching the tree

The tree may hold other agents' concurrent work. Build the candidate set from
the union of all four sources — any one alone is incomplete:

```bash
git diff --name-only "<base>...HEAD"          # committed since the base
git diff --cached --name-only                 # staged
git diff --name-only                          # unstaged
git ls-files --others --exclude-standard      # untracked
```

- **Never** `stash`, `reset`, `clean`, `checkout`, or otherwise disturb the tree.
- A changed file that traces to no Story is **ambiguous ownership**: report it in
  its own list. Do not assume it belongs to this EPIC, and do not review it as
  if it did.

## Step 3 — Read the governing specs before the code

Read in this order, because later sources are interpreted through earlier ones:

1. The `## Architecture` section of `AGENTS.md`, plus the gotcha files.
2. The **EPIC**.
3. Every expanded Story/Task file in `.agent/plan/stories/<epic-slug>/` that is
   in scope. Binding detail often lives there, not in the EPIC.

From the EPIC extract verbatim: **Goal**, **Gates:**, **Proof:** with the exact
success sentinel it must print, **Stories**, **Non-goals**. Also **Decisions**
and any "hermetic coverage required beyond the Proof" list **when present** —
these are optional sections in the template, so do not invent them and do not
treat their absence as a defect.

**Binding order when two sources disagree** (this decides every judgment call
later):

1. `AGENTS.md` hard rules.
2. EPIC and Story/Task directives.
3. Documented Decisions.
4. Existing tests — **evidence, not authority.** A test is a strong signal about
   intent, but if the EPIC deliberately changes that behaviour the test is
   stale and must be updated, not obeyed.

A Non-goal appearing in the diff is a **candidate** finding, not an automatic
one: supporting work may touch an adjacent area without delivering the deferred
feature. Report it only with evidence of real scope expansion or collateral
risk.

## Step 4 — Dispatch `reviewer-engineer` for the deep pass

Hand it: working root, EPIC path, base ref, the Step 2 file list, the Story
files in scope, the discussion file if one exists, and the mode. It reads every
changed production **and** test file, runs the `Gates:` and the hermetic
`Proof:`, and returns its structured verdict.

- Read **every changed test body**, not just the test names. A test that asserts
  a weaker proxy than the spec named is a defect the name list cannot show. The
  reviewer persona already requires this — do not let a summary substitute.
- If subagent dispatch is unavailable in this frontend, perform the review
  yourself following `.claude/agents/reviewer-engineer.md` **in full**. There is
  no lighter version.
- Do not take the subagent's word for the gate. Confirm it pasted **real
  output**. If it skipped a non-hermetic Proof with `NEEDS-HUMAN:`, you may run
  that Proof yourself when the credentials and network are actually available;
  otherwise carry `NEEDS-HUMAN:` forward. Never fake a pass.
- The Proof passes only on **exit 0 and** its stated sentinel. A printed string
  alone is not a pass.

## Step 5 — Run the regression proofs

The reviewer runs this EPIC's Proof. Nobody runs the neighbours', and that is
where a signature change breaks things.

- Run every proof script the change set **touched**, plus any proof that drives
  a changed CLI surface.
- Hermetic scripts only. Give each expensive, destructive, or
  network/model-dependent script a bounded timeout, or skip it — then list every
  skip with its reason and mark it `NEEDS-HUMAN:`.
- A green own-Proof beside a broken sibling proof is a **FAIL**.

## Step 6 — Validate every supplied note independently

Open the cited `file:line` and test the note's **premise**, not its conclusion.
A note whose premise is wrong is invalid however reasonable it sounds.

Report note validation as its **own section**, not folded into the findings: for
each note, `valid` (then it becomes a finding) or `invalid` with the exact line
that disproves it. A note is not a finding until it survives this step.

## Step 7 — Report

Order the reply: **verdict line → warnings or risks → the verification you
actually ran, with real outcomes → EPIC conformance in one line → blockers →
suggestions → note validation → skipped checks and `NEEDS-HUMAN:` items.**

Findings are bullets, one per line, in the operator's format (this comes from
the operator's own instructions, not from `AGENTS.md`):

```
<B1/S1> - action:<YES/NO> - <name> - <description>
```

`action:` keeps the **reviewer-engineer's** meaning, which is about routing, not
importance:

- `action:YES` — fixable mechanically from the finding alone.
- `action:NO` — needs a human decision first, or is a no-op / won't-do. A
  mandatory fix that needs a design call is `action:NO` **and** marked
  `NEEDS-HUMAN:` — it is still a blocker.

Drop before reporting: anything a Decision explicitly chose, and formatter
warnings — the husky + lint-staged pre-commit hook auto-formats staged files, so
a Prettier diff is expected, not a finding.

## Step 8 — Applying fixes (only when the human asks)

The `reviewer-engineer` never mutates the repo. Fixes are **your** work, in a
later turn, only after the human asks for them.

- Apply `action:YES` items only.
- **When a fix breaks a test that locks the old behaviour, resolve it by the
  Step 3 binding order — never by rewriting the test to suit your own
  suggestion.** If the EPIC requires the new behaviour, the test is stale:
  update it and say so. If the EPIC does not require it, your suggestion loses:
  revert the fix and report that the test blocked it.
- Stage by explicit path. Never `git add -A` — other agents' work may be in the
  tree.
- Re-run at minimum the `Gates:`, the `Proof:`, and every regression proof the
  fix touched.
- Do not commit. The human commits.

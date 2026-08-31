---
name: sequence
description: Add or amend the `## Sequence` section of one plan document — a sequence diagram per changed path, drawn at the observable seam — and the verification gate that proves the code follows it. Binds every work item to the diagrams it changes, refuses a diagram no test can check, and refuses the permissive notation. Use when authoring a new EPIC, when amending one, or when a review finds an epic with no Sequence section.
---

# /sequence — the sequence diagram and its verification gate

> **Harness note.** This skill runs under Claude Code, opencode and pi from the
> one file. Where a step says "dispatch a subagent", use the harness's dispatch
> tool: `Agent` under Claude Code, `Task` under opencode, the equivalent under
> pi. Where a step names a persona file, read it from `.claude/agents/<name>.md`
> or `.opencode/agents/<name>.md`, whichever exists.

Arguments: `$ARGUMENTS` — `<plan-document-path>`. A harness that does not
substitute `$ARGUMENTS` passes the same text with the invocation; read it from
there.

**Read `STANDARD.md` beside this file first. It is the normative standard and it
is repository-neutral.** This file binds it to this repository and gives the
procedure. Where the two disagree, `STANDARD.md` wins, and the disagreement is a
defect to report.

You author two things and nothing else: the `## Sequence` section of the document
in the arguments, and the parts of its `## Stories` and `## Verification gate`
that bind to it. Standard 4 adds the one exception: superseding a diagram edits
the earlier document's diagram and deletes its scenario file. You do not
implement, you do not run a build, and you do not commit.

**Why this exists.** A plan document states its decisions in prose, and prose
drifts from the code that ships. A sequence diagram drawn at the seam is the one
part of a plan document a machine can compare with the running code.

**What this skill is not.** It is not the mechanism that makes the standard the
default. Standard 8 names the three that are — the range gate, the declared
exemption, and the consuming skills — and this skill only produces a section that
satisfies them.

## Repository binding

This is the engine repository. `docs/proposal/` is the source of truth for
behaviour and `AGENTS.md` for structure, so a diagram states order and never
redefines either.

| Concept          | Engine                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ |
| plan document    | `.agents/plan/epics/<NNN>-<slug>.md`                                                 |
| work item        | one numbered story of its `## Stories` section                                       |
| document id      | `EPIC <nnn>`                                                                         |
| the seam         | the dependency object a command receives, per the `## The shape of a command` rule   |
| participant keys | the keys of that object, capitalized — `Plan`, `Lease`, `Execution`, `Events`, ...   |
| the two ends     | `Command`, plus `Client` for a wire operation and `Caller` for a nested command      |
| the recorder     | `test/helpers/sequence-conformance.ts`, a proxy over the dependency object           |
| a scenario       | `test/sequence/scenarios/<diagram-id>.ts`, default-exporting the fixture and the run |
| the runner       | `test/sequence/conformance.test.ts`, on `node:test`                                  |
| the range gate   | `scripts/verify-epic-sequence.ts`, in `pnpm run verify`                              |

A command runs inside one `storage.transact` callback and is synchronous, so the
trace is invocation order and invocation order is completion order. An
asynchronous seam would need begin and end records; do not introduce one inside a
diagrammed path without saying so, and apply the concurrency rule of standard 1
if you must.

## Step 1 — Parse and pre-flight

1. First positional is the plan document path. Missing, unreadable, or outside
   the plan tree of the binding table: print usage and stop.
2. The document holds `## Stories` and `## Verification gate`. Missing either:
   stop and say which. This skill amends an epic; it does not author one, and it
   cannot run against an empty file.
3. A `## Sequence` section already present means you **amend** it. Read it first,
   keep every live diagram id stable, and never rename or renumber an id another
   document references.
4. The document moves no seam at all: write `Sequence: not applicable — <reason>`
   in place of the section, per standard 8, report it, and stop.

## Step 2 — Decide the paths, before drawing anything

Read the document's `## Goal`, `## Non-goals`, `## Decisions` and `## Stories`,
and list every path whose seam set or seam order the document changes. Apply the
drawing rules of standard 1: one diagram per success branch, one per refusal that
stops at a step no drawn refusal stops at, one per nested unit plus its
zero-effect path where the document claims one, and no diagram for a path whose
order is legitimately not fixed.

Refuse to continue if a path's branch set is not decidable from the document.
That is a planning defect: report it and stop, rather than drawing a block that
admits two traces.

State in the section, in one sentence per operation, that the drawn set is every
branch of that path. Standard 7 says a fixture proves no such thing, so the claim
is prose a reviewer checks, and it must be visible to be checked.

## Step 3 — Map the real seams, read-only

Dispatch a read-only explorer subagent per command in scope, all in one message
so they run concurrently. Ask each for, and require it to return:

- the dependency type of that command and every key on it, at `file:line`;
- the current ordered seam calls of the path, quoted, at `file:line`;
- which seam calls a story of this document adds, moves or removes;
- every seam call the stories imply that no interface declares yet.

Tell each explorer: **map what exists, do not propose changes.**

A seam the document needs and no interface declares is a decision this document
now owns. Add a story carrying the method signature, its capability and its
cases, and record the seam name in the section. Do not let an interface decision
stay implicit in a diagram.

The explorer's "current ordered seam calls" are what separate a context token
from a change, which standard 6 needs. Do not sign a token from memory.

## Step 4 — Write the section

Order:

1. the preamble, with the precedence rule and its limit from standard 5;
2. "What a diagram may say", carrying standards 1 to 4;
3. the addressing rule and the global-uniqueness rule of standard 3;
4. the work-item binding of standard 6;
5. the supersession rule of standard 4;
6. "What a diagram does not prove", from standard 7;
7. the seams the diagrams name that the stories did not;
8. the diagrams, each under its backticked id, each preceded by the fixture it
   assumes, each followed by the sentences that say what its shape asserts.

Every diagram is a `mermaid` fenced block declaring its participants and its
messages in the token grammar of standard 3.

## Step 5 — Bind the stories and the gate

1. Add the `Diagrams:` and signed `Seams:` lines to every story that moves a
   seam, per standard 6, and add the scenario file paths to those stories.
2. Add the harness, the runner and the range-gate stories if the repository does
   not hold them yet, and add the slice proof of standard 9 to the harness story.
   Once they exist, a later document adds none of them.
3. Extend the `## Verification gate` Proof block with the harness test, the
   runner and the range-gate test, and add one hermetic-coverage bullet per
   property: the replay by equality, the parser refusals, the four
   mutation-detection cases, each branch pair the diagrams separate, the decision
   table for precedence, the same-context case, the two-direction work-item
   binding, and the range-gate refusals.

## Step 6 — Self-check, and prove it

Run `node scripts/verify-epic-sequence.ts` when it exists. When it does not,
perform its checks yourself over the document you just wrote and report each
result:

1. every backticked `###` heading holds one `sequenceDiagram`, and its ordinals
   are dense from 1;
2. no diagram repeats a token, and no diagram holds `loop` or `opt`;
3. every diagram states one terminal, or ends with a well-formed pinned-tail
   note;
4. every diagram id is unique across every document in the gate's range;
5. every live diagram is named by exactly one `Diagrams:` line, and every
   `Diagrams:` id exists and is not superseded;
6. every `Seams:` token carries one sign, a `+` or `~` token appears in a diagram
   that story names, a `-` token appears in no live diagram, and every token new
   to the range is `+` in exactly one story;
7. every story owning a diagram holds the exact scenario path for it;
8. every `Supersedes:` names a document and an id that resolve, and the
   superseded diagram carries its `Superseded by:` line and has no scenario file.

A failure here is yours to fix before you report, not the reader's to find.

## Step 7 — Report

Print the diagram ids you wrote with their owning story, the seam names this
document now owns, and every open item as a bullet list in the house format:

```text
<B1/S1> - status:<FIXED/OPEN> - action:<YES/NO> - <name> - <description> - fix:<recommended change> - why:<reason>
```

Report a behaviour question the diagrams exposed as a blocker, not as a note. A
diagram that forces a decision the prose avoided is this skill working, and the
human decides it.

Do **not** commit — the human reviews and commits.

## What this skill refuses

- a diagram message that is not a seam call;
- `loop`, `opt`, or any notation that admits more than one trace;
- a diagram for a path whose order is legitimately concurrent, in place of the
  set or partial-order assertion standard 1 requires;
- a diagram with no scenario file, and a scenario file with no diagram;
- an unsigned `Seams:` token, and a context token declared as a change;
- a story that moves a seam and declares no `Seams:` line;
- a gate bullet that claims a property the trace does not prove, in particular
  "the operation wrote nothing" and "every branch is drawn";
- renaming or renumbering a live diagram id another document references;
- editing production code, a test, or any document other than the one in the
  arguments and the one diagram a supersession retires.

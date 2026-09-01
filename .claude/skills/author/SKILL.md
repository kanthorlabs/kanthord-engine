---
name: author
description: Expand one EPIC into work-ready story files under .agents/plan/stories/<epic-slug>/, each declaring its kind and drawing the diagrams the standard requires. A story-implement draws its baseline and its ship diagram and declares Diagrams/Baselines/Seams; a story-foundation draws nothing. Grounds every edit in real file:line by read-only exploration, states the exact tests, and refuses to ship a story that leaves a design decision to build time.
---

# /author — expand an EPIC into story files and their diagrams

> **Harness note.** This skill runs under Claude Code, opencode and pi from the
> one file. Where a step says "dispatch a subagent", use the harness's dispatch
> tool: `Agent` under Claude Code, `Task` under opencode, the equivalent under
> pi. Where a step names a persona file, read it from `.claude/agents/<name>.md`
> or `.opencode/agents/<name>.md`, whichever exists.

Arguments: `$ARGUMENTS` — `<epic-file-path>`. A harness that does not substitute
`$ARGUMENTS` passes the same text with the invocation; read it from there.

**Read `.agents/plan/authoring.md` first. It is the standard, and it wins over
this file.** It gives the diagram grammar, the two story kinds, the pair rule,
the `Diagrams:`/`Baselines:`/`Seams:` binding, the supersession rule and the
gate. This file gives the procedure and the templates.

You turn one EPIC's `## Stories` list into the story files `/work` consumes,
under `.agents/plan/stories/<epic-slug>/`. You do not implement, you do not run a
build, you do not edit the EPIC, and you do not commit. Standard supersession is
the one exception: it edits the earlier story's diagram and deletes its scenario
file.

Two rules are binding and are the whole point of this skill:

- **The diagram is the focus.** A story that changes a path draws the pair — the
  baseline, which is the shipped code, and the ship diagram, which replaces it —
  and the difference between them is the boundary of the change. A story that
  changes no drawn path draws nothing and says so by its kind. A diagram nobody
  implements and a story that implements something nobody drew are the same
  defect.
- **A story is an execution script, not a brief.** It states the exact edit at
  `file:line`, the exact tests to write and their assertions, and the pass/fail
  check. **A story that cannot be made deterministic is a planning defect — fix
  the story, or report it. Never push the decision onto the implementing agent.**

## Step 1 — Parse and pre-flight

Abort with a clear message on any failure.

1. Resolve `<root> = $(git rev-parse --show-toplevel)` once.
2. The EPIC file exists, is readable, and is under `.agents/plan/epics/`.
3. `<epic-slug>` is the EPIC basename without `.md`.
4. **Already expanded?** `.agents/plan/stories/<epic-slug>/` exists and is
   non-empty: report `already expanded` and stop. Do not clobber.
5. **Sequence check.** Identify epic N-1 by number. Its EPIC file missing: abort.
   Its story directory missing: warn and continue.
6. **The EPIC is valid to expand.** It holds `## Stories`, `## Verification gate`
   with a `Proof:` block, and **no mermaid block**. A mermaid block in an EPIC is a
   defect: stop and tell the human to move it, because a path belongs to a story.
7. **Every story entry declares a kind.** An entry with none: stop and report it.
   The kind decides what the story draws, and guessing it is `/plan`'s work done
   here.

## Step 2 — Read the EPIC, which is the source of truth

Extract:

- **Goal** — the properties that hold when the epic lands.
- **Decisions** — each is a constraint the stories obey and never re-decide.
- **Verification gate** — the `Gates:` line, the full `Proof` block, and the
  hermetic-coverage list. The Proof is binding: every `PASS` line and every
  coverage assertion is delivered by some story, and each story names which.
- **stories** — one entry becomes exactly one story file, with the kind it
  declares.
- **Non-goals** — scope fences every story respects.

## Step 3 — Decide the paths, before drawing anything

For every entry the EPIC marks `story-implement`, name the one path it changes.
Apply the drawing rules of the standard: one diagram per success branch, one per
refusal that stops at a step no drawn refusal stops at, one per nested command,
and no diagram for a path whose order is legitimately not fixed.

- **One implement story is one changed path.** An entry that changes two paths is
  too big: report it as a blocker for the EPIC, and do not split it yourself.
- **An entry that draws no baseline and changes a shipped path is too small**, or
  is foundation work wearing the wrong label. Report it.
- A path's branch set that is not decidable from the EPIC is a planning defect.
  Report it and stop, rather than drawing a block that admits two traces.

State in each story, in one sentence, that the drawn set is every branch of that
path. A fixture proves no such thing, so the claim is prose a reviewer checks, and
it must be visible to be checked.

## Step 4 — Map the code surface, read-only and parallel

Determinism needs real anchors. Dispatch a read-only explorer subagent per story
or small group, all **in one message** so they run concurrently. Each explorer
returns:

- exact **file paths and line numbers** of every site the story edits;
- **signatures and current behaviour** at those sites, quoted;
- the **dependency type** of each command in scope and every key on it, at
  `file:line`;
- the **current ordered seam calls** of the path, quoted, one citation per call;
- which seam calls this story adds, moves or removes;
- every seam call the EPIC implies that no interface declares yet;
- the **test file** covering each site and its convention — framework, fakes
  against mocks, real SQLite or git, hermetic temp dirs — with the helper names
  and their lines;
- any **greenfield gap or gotcha**.

Tell each explorer: **map what exists, do not propose changes.** Wait for every
finding before writing.

The explorer's ordered seam calls are what separate a context token from a
change. **Never sign a token from memory.**

## Step 5 — Write the story files

Create `.agents/plan/stories/<epic-slug>/`. Write one file per EPIC story entry,
named `NN-<kebab-slug>.md` in the epic's story order, plus `index.md`. Every file
is execution-only: no motivation, no history, no debate.

### `story-foundation` template

````
# Story <X> — <name>

Epic: `.agents/plan/epics/<epic-slug>.md`
Depends on: <only a real ordering constraint>
Kind: story-foundation

## Change

**`<path>` — <the edit>.** <the exact behaviour, at file:line or symbol>

## Constraints

- <correctness-critical only>

## Verify

```
node --test <exact files>
```

<the test file to extend, and its existing helpers at file:line>

Add, each as a separate `it`:

1. `"<the test name>"` — <the exact assertion, by value>.
2. ...

`pnpm run verify` exits 0.

Proof: PASS line delivered — <files> in `PASS EPIC-<nnn>`.
````

It carries no `Diagrams:`, no `Baselines:` and no `Seams:` line. The pair rule
does not reach it, and it is never "too small" for holding no diagram.

### `story-implement` template

````
# Story <X> — <name>

Epic: `.agents/plan/epics/<epic-slug>.md`
Depends on: <the stories and epics whose output this story reads>
Kind: story-implement

Diagrams: <live-id>
Baselines: <live-id> <- baseline-<id>
Seams: <live-id>: +<key>.<method>, ~<key>.<method>, -<key>.<method> @<file>:<line>

<one sentence naming what this story leaves to a later story of the epic>

## The shipped path

### `baseline-<id>`

Superseded by: EPIC <nnn> <live-id>

Shipped path: `<file>:<from>-<to>`. Fixture: <the exact fixture, stated>.

```mermaid
sequenceDiagram
    participant Client
    participant Command
    participant <Key>
    Client->>Command: <operation>
    Command->><Key>: 1 <key>.<method>:<label>
    Command-->>Client: ok
```

Citations, one per step: `:<line>`, `:<line>`, ...

<the sentences that say what this baseline records, and which of its properties
the story changes>

### `<live-id>`

Supersedes: EPIC <nnn> baseline-<id>

Fixture: <the fixture, and what it makes the run kind or the branch>.

```mermaid
<the ship diagram>
```

<the sentences that say what the shape asserts: where the first mutation is, why
one step follows another, what is unrolled>

Add `test/sequence/scenarios/<live-id>.ts`.

## Change

**`<file>` — <the edit in one bold sentence>.** <why the boundary is where it is>

### <the first linear step>

<the exact edit, with every deletion citing `file:line`>

### <the next step>

...

## Constraints

- <correctness-critical only: transaction scope, what must not change, invariants>

## Verify

```
node --test <exact files> test/sequence/conformance.test.ts
```

<the test file to extend, and its existing helpers at file:line>

Add, each as a separate `it`:

1. `"<the test name>"` — <the exact assertion, by value>.
2. ...

Add `test/sequence/scenarios/<live-id>.ts`, building the fixture the diagram
names, running the real command over real SQLite behind the recorder, binding
every nested command to unrecorded dependencies, and returning the recorder and
the result.

`pnpm run verify` exits 0.

Proof: PASS line delivered — <files> in `PASS EPIC-<nnn>`.
````

### The declared lines

- **`Diagrams:` names the live diagram ids this story owns.** Exactly one story
  owns each live diagram, and that story adds the scenario file.
- **`Baselines:` maps a live diagram to the shipped path it replaces.** A live
  diagram in no pair is a path written from nothing, and its prior set is empty.
- **A path an earlier epic already drew has no `baseline-` diagram.** Its prior
  set is the live diagram it supersedes, and the story declares `Supersedes:`
  where a first change declares `Baselines:`. The two never appear together for
  one diagram, and drawing a baseline for a path an earlier epic owns claims that
  epic never landed.
- **`Seams:` is one line per live diagram**, prefixed by that diagram id. Every
  token carries one sign, and the token is exact, label included. A context token
  is not declared. A removal from a path no baseline draws cites its source as
  `-<key>.<method> @<file>:<line>`.

### The numbered case is the unit of implementation

`## Verify` holds a numbered list, in **both** templates, and `/work` dispatches one numbered case per
turn as `<story-file-stem>#V<n>`. Three rules follow, and they are what make a story executable:

- **Every case is written as a case, never as prose.** It quotes the `it` name the test-engineer uses
  verbatim, and it states the assertion by value. A story whose `## Verify` is a paragraph gives the
  loop nothing to open as RED.
- **`## Change` is the whole-story implementation contract.** Its `###` steps order the work for a
  reader; they are never scheduled one per turn, because a step is a slice of one operation and is not
  independently green. Do not number the steps to the cases, and do not add a mapping line.
- **Every `## Change` obligation is proven by a numbered case or by an assertion of the epic's gate.**
  An obligation neither proves is an authoring defect, and you report it rather than inventing a case
  for it. A case whose proof is the build states the build check instead of a test, and the loop runs
  it as a build-only check.

The numbering freezes when implementation starts, because a case id is written into the discussion
file. A later regression case appends; it never renumbers.

### `index.md` template

```
# EPIC <NNN> — <name> — stories

Epic: `.agents/plan/epics/<epic-slug>.md`
Prereq: EPIC <N-1> (sequence order). <what each story reads from it>

<one-sentence capability restatement>

## One story, one path

<how many stories carry a diagram, and which>

## Dispatch order

<the order /work takes the stories, the coupled pairs, and one workable serial
order proving no story depends on a later one>

## Stories

- <X> — <one line> → `NN-<slug>.md` — draws `<id>` and `<baseline-id>`
- ...

## Facts (needed for implementation)

- <terse, load-bearing, each with a file:line>

## Decisions taken during authoring, and now recorded in the EPIC

- **<the ruling>.** <the evidence, at file:line> See `NN-<slug>.md`.

```

A decision you had to take while authoring goes here **and** into the EPIC's
`## Decisions` — by asking the human, never by deciding alone. See Step 7.

## Step 6 — Self-check, and prove it

Run `node scripts/verify-epic-sequence.ts` when it exists. When it does not,
perform its checks yourself over what you wrote, and report each result:

1. every story declares a kind; a `story-foundation` carries none of the three
   declared lines, and a `story-implement` carries them;
2. every backticked `###` heading holds one `sequenceDiagram`, its ordinals are
   dense from 1, and no unnumbered arrow appears between two non-end participants;
3. no diagram repeats a token, and none holds `loop` or `opt`;
4. every diagram states one terminal, or ends with a well-formed pinned-tail note
   naming a diagram id that exists;
5. every diagram id is unique across every epic in the gate's range;
6. every live diagram is named by exactly one `Diagrams:` line, and every story
   owning a diagram holds the exact path `test/sequence/scenarios/<id>.ts`;
7. every baseline carries `Superseded by:` and holds no scenario file;
8. every `Seams:` token carries one sign; a `+` or `~` token appears verbatim in a
   diagram that line names; a `+` token appears in no baseline of it; a `-` token
   appears in no live diagram and appears in its baseline or in a citation; every
   token of a live diagram that is no context token of its baseline is `+` or `~`
   in exactly one story;
9. every `Supersedes:` names a document and an id that resolve;
10. `## Verify` holds a numbered case list in every story, each case quoting its `it` name and
    stating its assertion by value;
11. every `## Change` obligation is proven by a numbered case or by an assertion of the epic's gate,
    and no story carries a step-to-case mapping line;
12. every edit names a concrete file and site; every behaviour a test depends on
    is pinned; every `Verify` lists exact commands and its Proof line; no sentence
    asks the implementer to design, choose or decide at build time; no
    motivation, history or debate prose remains.

A failure here is yours to fix before you report, not the reader's to find.

## Step 7 — Report

Print the story files created, the diagram ids with their owning story, the
dispatch order, the seams this epic now owns that no interface declares yet, and
every open item as a bullet list in the house format:

```text
<B1/S1> - status:<FIXED/OPEN> - action:<YES/NO> - <name> - <description> - fix:<recommended change> - why:<reason>
```

Report a behaviour question the diagrams exposed as a **blocker**, not as a note.
A diagram that forces a decision the EPIC avoided is this skill working, and a
person decides it. Ambiguity is never handed to `/work`.

Do **not** commit — the human reviews and commits.

## What this skill refuses

- a diagram message that is not a seam call;
- `loop`, `opt`, or any notation that admits more than one trace;
- a diagram with no scenario file, and a scenario file with no diagram;
- an unsigned `Seams:` token, and a context token declared as a change;
- a `story-implement` that draws no pair for a shipped path, and a
  `story-foundation` that draws anything;
- a story with no kind;
- a `## Verify` written as prose instead of a numbered case list;
- a `## Change` obligation no case and no gate assertion proves;
- a gate bullet claiming a property the trace does not prove, in particular "the
  operation wrote nothing" and "every branch is drawn";
- renaming or renumbering a live diagram id another epic references;
- editing the EPIC, production code, a test, or any file outside
  `.agents/plan/stories/<epic-slug>/` and the one diagram a supersession retires.

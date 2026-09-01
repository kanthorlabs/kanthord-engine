---
name: plan
description: Turn one source of truth — a proposal, an issue, a stated goal — into the epic files under .agents/plan/epics/. An epic states what was decided and how the result is proven, and nothing else in it is heavy. Sizes the range by counting the paths whose seam trace moves, splits at ten stories, and refuses to persist a diagram. Writes no story and no code.
---

# /plan — write the epic range

> **Harness note.** This skill runs under Claude Code, opencode and pi from the
> one file. Where a step says "dispatch a subagent", use the harness's dispatch
> tool: `Agent` under Claude Code, `Task` under opencode, the equivalent under
> pi. Where a step names a persona file, read it from `.claude/agents/<name>.md`
> or `.opencode/agents/<name>.md`, whichever exists.

Arguments: `$ARGUMENTS` — `<source> [--from <NNN>]`. `<source>` is a proposal
path, an issue reference, or the goal in prose. `--from` is the first epic
number to allocate. A harness that does not substitute `$ARGUMENTS` passes the
same text with the invocation; read it from there.

**Read `.agents/plan/authoring.md` first. It is the standard, and it wins over
this file.** This file gives the procedure.

You write epic files under `.agents/plan/epics/` and nothing else. You do not
write a story, you do not implement, you do not run a build, and you do not
commit. `/author` expands each epic you write.

**What an epic carries.** Two sections carry weight: `## Decisions` and
`## Verification gate`. A decision states the ruling, the constraint it imposes
and the evidence that forced it. The gate states every assertion that proves the
epic shipped what it decided, and every assertion is owned by exactly one story.
Everything else is light.

**What an epic never carries.** A sequence diagram. A diagram is the contract of
one path, a path belongs to one story, and an epic that draws one has taken work
that belongs to a story. The range gate refuses a mermaid block in an epic file.

## Step 1 — Parse and pre-flight

1. Resolve `<root> = $(git rev-parse --show-toplevel)` once. Every path resolves
   under `<root>`.
2. Read `<source>`. Unreadable or absent: print usage and stop.
3. List `.agents/plan/epics/` and find the highest allocated number. Allocate
   from `--from`, else from the next whole number.
4. **Number with a decimal when the whole numbers after the insertion point are
   already authored**, so no cross-reference moves.
5. An epic file at a number you allocate already exists: stop and report it. Do
   not clobber.

## Step 2 — Read what already decides the answer

Read in this order, because a later source is interpreted through an earlier
one:

1. the `## Architecture` section of `AGENTS.md`, plus the gotcha files;
2. `docs/proposal/`, which is the source of truth for behaviour;
3. the epics this range follows, for the capability they already deliver;
4. `.agents/plan/pending/`, for a question a person still owes an answer to.

**Epics are sequence order.** Epic N depends on epic N-1. An epic you write may
rely on N-1's capability existing, and it never re-specifies it.

## Step 3 — Map the code surface, read-only

Dispatch a read-only explorer subagent per area in scope, all in one message so
they run concurrently. Ask each for, and require it to return:

- the commands, queries and nested commands the source changes, at `file:line`;
- the dependency type of each, and every key on it, at `file:line`;
- the current ordered seam calls of each path, quoted, at `file:line`;
- the migration version the repository is at, and the test convention;
- every seam call the source implies that no interface declares yet.

Tell each explorer: **map what exists, do not propose changes.**

A seam the source needs and no interface declares is a decision an epic of this
range now owns. Name it in that epic's `## Decisions` and give it a story.

## Step 4 — Sketch the path, and discard the sketch

This step sizes the range. It produces no file.

- **On existing source**: draw the shipped seam order of each path from the
  explorer's citations, then draw the order the source demands. The difference is
  the boundary of the change.
- **On nothing**: draw the target seam order alone.

Then count. **The count is the number of commands, queries and nested commands
whose seam trace moves.** That count is the number of `story-implement` stories,
because an implement story is one changed path. Foundation work — a migration, a
schema, a pure function, a service interface, a configuration budget, a proposal
document — takes the remaining slots.

- **An epic holds no more than ten stories.** Eleven is a split, not a judgement
  call. Split by cutting the range at a point where the earlier epic's gate stands
  on its own, and record in the later epic's `## Non-goals` what went where.
- **Discard the sketch.** No epic file holds a mermaid block, and the sketch is
  not written to any other file either. `/author` draws the real pair per story,
  from the same code, under the standard.

## Step 5 — Write the epic files

One file per epic, at `.agents/plan/epics/<NNN>-<kebab-slug>.md`:

````
# EPIC <NNN> — <name>

Status: **draft**. It follows EPIC <N-1> by sequence order, and it runs before
EPIC <N+1>. It consumes <the capability of each prior epic it needs>.

## Goal

<the properties that hold when this epic lands, one bullet each, short>

## Non-goals

- **No <thing>.** <the epic or document that owns it instead, and why it is not here>

## Decisions

- **<the ruling, in one bold sentence>.** <the constraint it imposes on the
  implementation, and the evidence that forced it, with `file:line` or a
  `docs/proposal/` citation>

## Stories

Each entry is a name and the output it contributes. The story file holds the
change and the tasks, and it declares its kind. `.agents/plan/authoring.md` is the
standard.

1. **<name>** — <the output, with the exact file or symbol it produces>. `story-foundation`.
2. **<name>** — <the path it changes>. `story-implement`.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  <every test file the epic adds or changes> \
  && echo "PASS EPIC-<NNN>"
```

Hermetic coverage required beyond the Proof:

- <one assertion, stating both directions where a boundary is involved>. Story <n>.
````

Rules for the text you write:

- **A decision states a constraint, not a preference.** "We use X" is not a
  decision. "X, because Y at `file:line` makes the alternative illegal" is.
- **A decision records the decision, not the search for it.** Cut the
  alternatives, the rejections and the comparisons.
- **A `## Stories` entry is a name and an output.** The change, the tasks and the
  diagrams belong to the story file. An entry that runs to a paragraph is
  `/author`'s work done in the wrong place.
- **Every entry declares its kind**, `story-foundation` or `story-implement`, so
  the pair rule is decidable before the story is written.
- **Every gate assertion names its owning story**, and exactly one.
- **The Proof passes on exit 0 and its sentinel.** A printed string alone is not
  a pass.
- Cut motivation, history and background everywhere.

## Step 6 — Self-check

Confirm, per epic file you wrote:

1. no mermaid block, and no `## Sequence` section;
2. ten stories or fewer;
3. every story entry declares a kind;
4. the number of `story-implement` entries equals the number of paths Step 4
   counted for that epic;
5. every `Hermetic coverage` assertion names exactly one story, and every story
   is named by at least one assertion or delivers a Proof test file;
6. every `## Non-goals` bullet names where the work went instead;
7. every `## Decisions` bullet carries evidence at `file:line` or a
   `docs/proposal/` citation;
8. no sentence leaves a design choice to `/author` or to build time.

A failure here is yours to fix before you report.

## Step 7 — Report

Print the epic files you created, the story count and the implement-story count
per epic, and every open item as a bullet list in the house format:

```text
<B1/S1> - status:<FIXED/OPEN> - action:<YES/NO> - <name> - <description> - fix:<recommended change> - why:<reason>
```

Report a behaviour question the sketch exposed as a **blocker**, not as a note. A
path that forces a decision the proposal avoided is this skill working, and a
person decides it.

Do **not** commit — the human reviews and commits.

## What this skill refuses

- a diagram in an epic file, in any form;
- an epic with more than ten stories;
- a story entry with no kind;
- a gate assertion owned by no story or by two;
- a decision with no evidence;
- writing a story file, a test, production code, or any document outside
  `.agents/plan/epics/`.

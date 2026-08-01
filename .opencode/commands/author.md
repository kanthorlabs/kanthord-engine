---
description: Expand one EPIC into deterministic, /work-ready Story/Task files grounded in read-only code exploration.
agent: build
subtask: false
---

# /author — expand an EPIC into deterministic Story/Task files

Arguments: `$ARGUMENTS`

Act as the **planner**. Turn one EPIC's `## Stories` bullet list into the
detailed Story/Task files `/work` consumes, under
`.agent/plan/stories/<epic-slug>/`. Do **not** implement, run tests, edit the
EPIC, or touch production code. Do **not** commit.

Two AGENTS.md rules are binding and are the whole point of this command:

- **Sequence order.** Epics are sequence order only; epic N always depends on
  epic N-1. A story for epic N may rely on N-1's capability existing. Never
  re-specify it.
- **Deterministic stories.** Story/Task files are execution scripts, not briefs.
  Every story states the **exact edit** (file + site), the **exact tests** to
  write, and the **pass/fail** check. Leave no ambiguity to resolve at build
  time. Include **only** what is needed to implement and verify. Cut motivation,
  history, debate, and background. Implementation and testing must be
  deterministic (same graph -> same order -> same result). **If a story cannot
  be made deterministic, that is a planning defect. Fix the story; do not push
  the decision onto the implementing agent.**

## Step 1 — Parse arguments

- **First positional** = EPIC file path (required). If missing, print usage and
  stop.
- Resolve `<root> = $(git rev-parse --show-toplevel)` once. All paths resolve
  under `<root>`.

## Step 2 — Pre-flight

Abort with a clear message on any failure:

1. The EPIC file exists, is readable, and is under `.agent/plan/epics/`.
2. Derive `<epic-slug>` from the EPIC basename without `.md`, for example
   `007.12-initiative-branch-workflow`.
3. If `.agent/plan/stories/<epic-slug>/` exists and is non-empty, report
   `already expanded` and stop. Do not clobber it. The human re-runs only after
   moving the old directory aside.
4. Identify the previous epic (N-1) by number. If its EPIC file does not exist,
   abort because epic N depends on N-1. If N-1's story directory does not exist,
   warn because the human may be authoring ahead, then continue.

## Step 3 — Read the EPIC

The EPIC is the source of truth. Read it and extract:

- **Goal**: the capability that exists after the epic.
- **Verification Gate**: the `Gates:` line and the full copy-paste **Proof**
  block. The Proof is binding. Every `PASS <X>` or story marker in it must be
  delivered by a story, and each story names which Proof lines it delivers.
- **Stories**: the bullet list. Each bullet becomes exactly one Story/Task file.
- **Non-goals**: scope fences the stories must respect.

If the EPIC has no program-level `Proof:` block, stop. It is not a valid epic to
expand under AGENTS.md. Tell Ulrich to fix the EPIC first.

## Step 4 — Map the code surface

Determinism requires real anchors, not guesses. For each story, or a small
group, dispatch a read-only `explore` subagent with the `task` tool. Launch
independent explorations concurrently in one message. Each prompt must ask for:

- exact **file paths + line numbers** of every site the story will edit;
- **class / method / function signatures** and the **current behavior** at
  those sites, with quoted snippets;
- the **test file** that covers each site and the **test convention**, including
  framework, fakes versus real SQLite or Git, and hermetic temporary folders;
- any **greenfield gap or gotcha**, including missing code, a contract that must
  change, or a shared mechanism with unexpected behavior.

Tell each subagent: **map what exists, do not propose changes**. Wait for all
findings before writing.

## Step 5 — Write the Story/Task files

Create `.agent/plan/stories/<epic-slug>/` through `apply_patch`. Write **one file
per EPIC Story bullet**, named `NN-<kebab-slug>.md` in the epic's story order,
plus `index.md`. Every file is **execution-only**. Include no motivation,
history, or debate.

### Per-story file template

```markdown
# Story <X> — <name>

Epic: `.agent/plan/epics/<epic-slug>.md`
[Depends on: Story <Y> / EPIC <N-1>] ← only if a real ordering constraint exists

## Change

- <exact edit, with file:line and the current code it replaces>
- <new file / new type with its exact signature>
- ... (concrete enough that two implementers would produce the same edit)

## Constraints

- <correctness-critical only: surgical scope, invariants, "do not break X">

## Verify

- <exact test command(s), e.g. `node --test src/.../foo.test.ts`, and the
  precise assertion each must make>
- `npm run verify` exits 0
- Proof: <which PASS line(s) of the EPIC Proof this story delivers>
```

Apply these rules to each story:

- **Exact site.** Name the file and line or symbol for every edit. "Somewhere in
  the landing code" is a defect; `src/landing/git.ts:95-261` is a specification.
- **Exact tests.** State the test file path and what each new test asserts,
  including regression guards. The implementer writes tests to this list, not
  from imagination.
- **Deterministic behavior.** If the feature involves ordering, pin the order
  rule, such as "topological, tie-broken by explicit order then id". Do not say
  "the agent decides".
- **Only what is needed.** Cut backstory. Keep a load-bearing fact only as a
  terse bullet, never a paragraph.

### index.md template

```markdown
# EPIC <NNN> — <name> — stories

Epic: `.agent/plan/epics/<epic-slug>.md`
Prereq: EPIC <N-1> (sequence order).

<one-sentence capability restatement>

## Dispatch order

<the order /work should take the stories, and which are a coupled pair>

## Stories

- <X> — <one line> → `NN-<slug>.md`
- ...

## Facts (needed for implementation)

- <terse, load-bearing facts shared across stories: greenfield gaps, gotchas,
  the migration-version rule, the capability template to mirror — each with a
  file:line>
```

## Step 6 — Determinism self-check

Re-read each story and confirm:

1. Every edit names a concrete file and site.
2. Every behavior a test depends on is pinned, including order, states, and
   error types.
3. The `Verify` section lists exact test files, commands, and Proof lines.
4. No sentence asks the implementer to design, choose, or decide at build time.
5. No motivation, history, or debate remains.

If a story fails this check and the EPIC plus exploration cannot make it
deterministic, stop. Report the specific planning defect to Ulrich. Do not ship
a vague story or hand ambiguity to `/work`.

## Step 7 — Report

Print:

- the created index and story files under
  `.agent/plan/stories/<epic-slug>/`;
- the dispatch order;
- planning defects or open questions that block a clean `/work` handoff, using
  one bullet per item in this exact format:
  `<B1/S1> - action:<YES/NO> - <name> - <description>`.

Do **not** commit. Ulrich reviews and commits.

## Planner constraints

- Use shell commands only for path checks.
- Use file tools to read the EPIC and source files.
- Use read-only `explore` subagents to map the code.
- Use `apply_patch` only to create files under
  `.agent/plan/stories/<epic-slug>/`.
- Never edit the EPIC, production sources, tests, or config.
- The EPIC Proof is the contract. If no story delivers a Proof line, a story is
  missing.
- Keep `/work` mechanical. Implementing agents follow steps; they do not design.

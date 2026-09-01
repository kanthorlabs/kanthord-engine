# Epic and story authoring

This document is the standard for every epic in `.agents/plan/epics/` and every story in
`.agents/plan/stories/`. It is a planning convention, so it lives here and not in `docs/proposal/`.
`AGENTS.md` names the mechanism that enforces it.

## The epic

An epic states **what was decided** and **how the result is proven**. Nothing else in it is heavy.

- **An epic holds no sequence diagram.** A diagram is the contract of one path, a path belongs to one
  story, and an epic that draws one has taken work that belongs to a story.
- **Two sections carry weight: `## Decisions` and `## Verification gate`.** A decision states the
  ruling and the constraint it imposes, with the evidence that forced it. The gate states every
  assertion that proves the epic shipped what it decided, and **every assertion in it is owned by
  exactly one story**.
- **Everything else is light.** `## Goal` is a short list of the properties that hold when the epic
  lands. `## Non-goals` names what a reader would otherwise expect here and where it went instead.
  `## Stories` is a list of names and outputs, one entry per story, and the story file carries the
  change, the tasks and the diagrams.
- **An epic holds no more than ten stories.** Eleven is a split, not a judgement call. Number the new
  epic with a decimal when the whole numbers after it are already authored, so no cross-reference
  moves.

## The story, and its two kinds

Every story declares its kind on the line under its title. The kind decides what it draws.

### `story-foundation`

Work that changes no drawn path: a migration, a schema, a pure function, a service interface and its
implementation, a configuration budget, a contract registration, a proposal document.

- **It draws nothing.** It carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
- The pair rule does not reach it, and it is never "too small" for holding no diagram.
- It is proven by its own unit test and by the epic's gate, never by a trace.

### `story-implement`

Work that changes one path of one operation.

- **It draws exactly one pair**: the baseline, which is the shipped code, and the ship diagram, which
  is the replacement. The difference between the two is the boundary of the change, and the story
  states it.
- **Fewer than one pair is too small.** A story that changes a path and draws no baseline is
  unverifiable, because its removals are measured against nothing. Either draw the pair or the work
  is foundation work wearing the wrong label.
- **More than one pair is too big.** It splits by path, one command per story.
- **A path this epic writes from nothing draws the ship diagram alone**, and its prior set is empty.
  That is the one case where an implement story holds a single diagram.
- **A path an earlier epic already drew has no `baseline-` diagram.** Its prior set is the live
  diagram it supersedes, and the story declares `Supersedes:` where a first change declares
  `Baselines:`.

## The arithmetic of an epic

The story count is the sum of both kinds, and it is capped at ten. An implement story is one changed
path, so an epic changes at most ten paths and in practice fewer, because foundation work takes
slots. Counting the paths before authoring is what decides whether an epic splits, and the count is
the number of commands, queries and nested commands whose seam trace moves.

## What a diagram may say

- **A message is a seam call, and nothing else is a message.** The recorder wraps the dependency
  object a command receives, so it observes exactly one thing: a call on an injected capability. A
  pure-domain call is invisible at that seam, so it is never a message. What a pure function decides
  is proven by its own unit test, never by a trace.
- **A participant is a dependency key, capitalized.** The parser checks every participant against the
  keys of the dependency object of the scenario. `Command` is the operation under test, `Client` is
  the caller of a wire operation, and `Caller` is the caller of a nested command.
- **A step is `<n> <key>.<method>` or `<n> <key>.<method>:<label>`.** `n` is the ordinal, and it is
  dense from 1. The label is the projection of that call, colon-separated.
- **No two steps of one diagram carry the same token.** The parser refuses a repeat. A method called
  twice needs a projection that separates the calls, so no diagram passes by counting method names.
- **A projection is declared once, per method, in the harness.** The table is data, not a per-test
  literal. A projection names a value the call actually receives: a run-scoped method projects the
  run id, and a node-scoped method projects the node id. A method with no projection admits one call
  per diagram.
- **A nested command is one step.** The scenario binds the nested command to unrecorded dependencies.
  That nested command carries its own diagrams and its own scenarios.
- **There is no `loop` and no `opt`.** Both admit the regression the diagram exists to catch. A count
  is unrolled against a fixed fixture, and a branch is a separate diagram with its own id.
- **A diagram states one terminal, `ok` or `refuse:<code>`, and the harness derives it from the real
  result.** A scenario passes no expected terminal. A refusal path is its own diagram.
- **`note over Command: tail pinned by EPIC <nnn> <diagram-id>` ends the pinned prefix.** It exists
  for an operation one story amends at its prelude while a later story owns its body. Nothing after
  the note is compared.
- **`note over Command: tail unchanged by EPIC <nnn>` ends a prefix nobody else owns.** It exists for
  a long shipped command a story amends at one point, where no later epic redraws the rest. Nothing
  after the note is compared, and the story states in prose what the tail holds and why it does not
  move. A diagram that pins a tail proves the insertion point and the order before it; it proves
  nothing about the tail, and the story's own tests carry that.

  **The note claims one thing: no seam call after it moves.** It does not claim the source after it is
  untouched. A story may delete a pure array push, a domain call or a field read inside the pinned
  tail and the note stays true, because none of those is a message. A story that moves, adds or
  removes a **seam call** inside the tail must say so, and the only legal way to say it is a `~` token
  with a citation, which declares exactly which call left the tail. A note beside no such token
  asserts the tail's trace is byte-identical.

- **The trace is invocation order.** Every command in this range is synchronous inside one
  `storage.transact` callback, so invocation order is completion order.

## A baseline says what the grammar otherwise refuses

Shipped code carries no obligation to be drawable, and a baseline records it as it is.

- A baseline id starts with `baseline-`, and every step cites the source file and line that makes the
  call.
- A baseline runs no scenario. It holds no `test/sequence/scenarios/<id>.ts` file, because the code
  it describes is deleted by the story that draws it. A reviewer checks a baseline against its
  citations.
- A function-valued dependency is drawn as `<key>.call`.
- A second call that one projection cannot separate carries the discriminator `:#<n>`.
- A live diagram that needs `<key>.call` or `:#<n>` is a defect, and the story removes the cause.
  The parser refuses both outside a `baseline-` id.
- A baseline carries `Superseded by: <document-id> <diagram-id>` naming the ship diagram that
  replaces it, and the ship diagram carries `Supersedes: <document-id> <baseline-id>`.
- A refusal diagram of a changed path names the baseline of that path. Its signs are measured only
  over the tokens it holds, because a baseline token the refusal never reaches is not a removal.
- **A path an earlier epic already drew has no `baseline-` diagram.** Its prior set is the live
  diagram it supersedes, and the story declares `Supersedes:` where a first change declares
  `Baselines:`. The two lines never appear together for one diagram: shipped code is drawn once, and
  after that the previous epic's diagram is the record of what shipped. A story that draws a
  `baseline-` diagram for a path an earlier epic owns is claiming that epic never landed.

## A diagram is addressed by its heading

A `###` heading holding a kebab-case id in backticks names the diagram in the fenced block below it.
A `###` heading with no backticks is prose and holds no diagram. The id is unique across every story
of the range, and it is the file name of its scenario.

## The seams a story moves

A diagram nobody implements and a story that implements something nobody drew are the same defect,
so the two texts are bound by declared lines under the story title:

```text
Diagrams: claim-success-task
Baselines: claim-success-task <- baseline-claim-task
Seams: claim-success-task: +plan.setNodeAssignment, ~lease.read, -execution.adoptRun @src/commands/node/claim-node.ts:479
```

- **`Diagrams:` names the live diagram ids this story owns.** Exactly one story owns each live
  diagram. That story adds the diagram's scenario file at `test/sequence/scenarios/<id>.ts`, and the
  gate checks the story text holds that exact path.
- **`Baselines:` maps a live diagram to the shipped path it replaces**, one `<live> <- <baseline>`
  pair per entry. A live diagram named in no pair is a path written from nothing, and its prior set
  is empty.
- **`Seams:` is one line per live diagram**, prefixed by that diagram id, because a call removed from
  one path survives on another. A token carries one sign per diagram.
- **A sign is decided over token sets**, never over ordinals: `+` names a token the diagram holds and
  its baseline does not, `-` names a token the baseline holds and the diagram does not, and `~` names
  a token both hold at a changed count or a changed label. Order is proven by the diagram comparison
  itself. An unsigned token is refused.
- **A context token is not declared.** A token the baseline and its ship diagram both hold, at one
  count and one label, belongs to no story.
- **A removal from a path no baseline draws cites its source**, as
  `-<key>.<method> @<file>:<line>`. A removal is never legal without evidence.
- **A story that changes no drawn path carries none of the three lines.**

## What a diagram does not prove

- **It does not prove a refusal code.** Two refusals that stop at the same step are one diagram, and
  the code that separates them is proven by the refusal test.
- **It does not prove the behaviour a guard adds.** A story that inserts a refusal draws the path that
  still succeeds, because that is the path whose order changed. The refusal itself is one branch of a
  fixture the diagram does not hold, and drawing it would give the story a second live diagram. What
  proves the refusal is the refusal test and the byte-identical database comparison, and the story
  says which case carries it.
- **It does not prove branch coverage.** A fixed fixture is one example. That the drawn set is every
  branch of a path is a claim the story makes in prose, and a reviewer checks it.
- **It does not prove refusal precedence.** A refusal is decided by pure predicates the recorder
  cannot see. Precedence is proven by a decision table over every pair of refusals that can trigger
  at once.
- **It does not prove a transaction property.** `storage.transact` as step 1 proves one transaction
  is opened. That a nested command receives that same transaction is a separate case.
- **A refusal diagram proves no write seam is reached after the refusal point.** It does not prove
  the operation wrote nothing. What proves that is the byte-identical database assertion of the
  epic's verification gate. Both are required, and neither replaces the other.

## Precedence

For a path a story draws, the seam calls and their order are authoritative over the prose of that
story. A story that names a seam call it does not draw is a defect in the story, and an implementing
agent reports it rather than editing a diagram to match the code it wrote.

The precedence stops there. A diagram carries no value, no predicate, no state change and no error
semantics, so a disagreement about any of those does not resolve to the diagram: it makes the epic
invalid, and a human resolves it before implementation.

## The gate

`scripts/verify-epic-sequence.ts` reads every story of the range and refuses when:

- a diagram fails the parser above;
- an epic file holds a mermaid block;
- a diagram id repeats across live diagrams;
- a `Supersedes` line names an id no story declares;
- an unpinned tail names a story that declares no such diagram id;
- a live diagram is owned by no `Diagrams:` line or by two;
- a story owning a diagram does not hold the exact path `test/sequence/scenarios/<id>.ts`;
- a baseline id holds a scenario file, or carries no `Superseded by:` line;
- a `Seams:` line names a diagram the same story does not own;
- a token carries no sign or two signs for one diagram;
- a `+` or `~` token appears in no diagram that line names;
- a `+` token appears in that diagram's baseline;
- a `-` token appears in that diagram, or appears neither in its baseline nor in a citation;
- a token of a live diagram that is no context token of its baseline is `+` or `~` in no story or in
  two;
- a story that changes an existing command declares no baseline. That a path is shipped is not
  machine-decidable, so the epic's story list is where a reviewer checks the set;
- an epic file holds more than ten stories;
- a story declares no kind, or a `story-foundation` carries a `Diagrams:`, `Baselines:` or `Seams:`
  line, or a `story-implement` carries none.

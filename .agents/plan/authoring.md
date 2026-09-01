# Epic and story authoring

This document is the standard for every epic in `.agents/plan/epics/` and every story in
`.agents/plan/stories/`. It is a planning convention, so it lives here and not in `docs/proposal/`.
`AGENTS.md` names the mechanism that enforces it.

Two skills consume it and nothing else authors a plan document: `/plan` writes the epics, and
`/author` writes the stories and their diagrams. Where a skill and this file disagree, this file wins,
and the disagreement is a defect to report.

## The seam, in this repository

| Concept          | Engine                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| plan document    | `.agents/plan/epics/<NNN>-<slug>.md`                                               |
| work item        | one story file in `.agents/plan/stories/<epic-slug>/`                              |
| document id      | `EPIC <nnn>`                                                                       |
| the seam         | the dependency object a command receives, per `## The shape of a command`          |
| participant keys | the keys of that object, capitalized — `Plan`, `Lease`, `Execution`, `Events`, ... |
| the two ends     | `Command`, plus `Client` for a wire operation and `Caller` for a nested command    |
| the recorder     | `test/helpers/sequence-conformance.ts`, a proxy over the dependency object         |
| a scenario       | `test/sequence/scenarios/<diagram-id>.ts`, exporting the fixture and the run       |
| the runner       | `test/sequence/conformance.test.ts`, on `node:test`                                |
| the range gate   | `scripts/verify-epic-sequence.ts`, in `pnpm run verify`                            |

A command runs inside one `storage.transact` callback and is synchronous, so the trace is invocation
order and invocation order is completion order. An asynchronous seam needs begin and end records; do
not introduce one inside a drawn path without saying so.

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

**The unit of implementation is one numbered case under `## Verify`**, addressed as
`<story-file-stem>#V<n>`, and `/work` dispatches one case per turn. `## Change` is the whole-story
implementation contract, read whole and never scheduled step by step, because a `## Change` step is a
slice of one operation and is not independently green. Every obligation of `## Change` is proven by a
numbered case or by an assertion of the epic's gate, and the numbering freezes when implementation
starts.

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

## Which paths are drawn

- **A diagram covers one path of one operation, and it states one terminal.** A branch is a separate
  diagram with its own id, never an optional block.
- **Draw a path only when its seam set or its seam order differs from a path already drawn.** Two
  refusals that stop at the same step are one diagram. A branch that changes a value and not the call
  set is not a diagram.
- **A path whose seam order is legitimately not fixed is not drawn.** Two concurrent requests with no
  ordering rule are asserted as a set or a partial order by the story that makes them, and the story
  says so in one sentence. Never invent an order in production to satisfy a notation, and never draw a
  diagram that admits two traces.

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
- **Only a numbered step is compared.** The arrow that enters from an end and the arrow that returns
  the terminal carry no ordinal, so a client call and the terminal are drawn without being recorded
  calls. An unnumbered arrow between two other participants is refused, because it reads as a message
  the recorder never saw.
- **A diagram with no step is legal, and it is the strongest statement available.** It asserts the
  path reaches no seam at all, so any call the implementation makes fails the comparison. A path that
  differs from another only by calling nothing is drawn this way, never described in prose.
- **No two steps of one diagram carry the same token.** The parser refuses a repeat. A method called
  twice needs a projection that separates the calls, so no diagram passes by counting method names.
- **A method called twice with no natural projection is a decomposition signal, not a notation
  problem.** Never add a parameter to a production interface so a diagram can separate two calls, and
  never number the occurrences: an occurrence number means a different call on every path, and
  inserting one call renames every later one. A command that calls one seam method repeatedly with
  nothing to distinguish the calls is doing several things, and each becomes a nested command with its
  own diagram, where the call appears once. Where that decomposition is wrong for the product, the
  path is not drawn and the story says why in one sentence.
- **A call repeated over a list is drawn against a fixture whose length is stated**, and the
  projection separates the iterations by their own data. A list whose items produce identical tokens
  is not drawable: the fixture states a length of one, and the story says the longer list is asserted
  by the command's own test.
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
- **A `Seams:` token is the exact token the diagram draws, label included.**
  `+plan.setNodeState:T:done` is one token and `+plan.setNodeState:O:ancestor-started` is another.
  Stripping the label collapses two calls into one declaration, and the gate can no longer tell which
  of them a sign governs.
- **A sign is relative to the path, not to the range.** A token is new to a path when the prior
  diagram of that path does not hold it, and a diagram with an empty prior set is wholly new, so every
  one of its tokens is `+`. A method drawn on another operation's path is not context here: a
  `storage.transact` in one command says nothing about the first transaction of a different one.
- **A renumbered call is not a moved call.** `~` states that a call's position changed relative to the
  other calls of the path. Inserting one step renumbers every later ordinal and moves nothing, so
  those tokens stay context and no story declares them.
- **A story that only composes carries `Diagrams:` and no `Seams:` line.** A composed path's steps are
  the nested commands, and each command's tokens belong to the story that writes that command. The
  composing story still owns its diagram and its scenario, because the order of the commands is what
  it decides.
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
  at once. A pair table does not cover a three-way interaction; an epic whose refusals interact three
  ways says so and adds the cases.
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
- a diagram holds an unnumbered arrow between two participants that are not an end;
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
- a story holds no numbered case list under `## Verify`;
- a story declares no kind, or a `story-foundation` carries a `Diagrams:`, `Baselines:` or `Seams:`
  line, or a `story-implement` declares no `Diagrams:` line. A `story-implement` that only composes
  declares `Diagrams:` and no `Seams:`, so the gate requires the first line and never the second.

## What makes this standard the default

A skill produces a compliant story when it is invoked. It is not the mechanism that makes the story
compliant. Three mechanisms carry that, and a repository holding only the first has an aspiration:

1. **The range gate** — `scripts/verify-epic-sequence.ts` in `pnpm run verify`, refusing every
   inconsistency listed above.
2. **The declared kind** — every story states `story-foundation` or `story-implement` on the line
   under its title. A story that draws nothing is a visible decision, never a silent omission, and the
   gate refuses a story with no kind.
3. **The consuming skills** — `/author` refuses to write a story with no kind, `/work` refuses to
   implement one, and `/review` refuses to pass one.

## Rollout, and what is grandfathered

- **The harness is proven on a slice before it is required anywhere.** The recorder, one scenario and
  the runner land against two paths of the first epic that needs them, and the implementation is
  mutated to confirm the comparison fails. This standard is revised from what that slice teaches.
- **The gate's range is explicit data**, and an epic outside it is grandfathered with no annotation.
  An epic inside the range carries stories that satisfy this file.
- **The gate enters `pnpm run verify` only when every epic in its range satisfies it.** A gate that
  lands red teaches the team to skip it.

# The sequence standard

Standard-version: 2

This file is normative and it is repository-neutral. Both kanthord repositories carry a
byte-identical copy, and each binds it to its own seam in its own `SKILL.md`, section
`## Repository binding`. Change this file in one repository and copy it to the other in the same
change; the two copies drifting is a defect.

**Vocabulary.** A **plan document** is the document that describes one change: an EPIC in the engine,
an objective in apps. A **work item** is one unit inside it: a story in the engine, a task in apps. A
**seam** is the boundary a test can observe, named by the binding. A **token** is one recorded seam
call. A **trace** is the ordered token list one run produced.

## 1 — One diagram per path, and a path is exact

- A diagram covers one path of one operation: one success path, or one refusal. A diagram states one
  terminal.
- A branch is a separate diagram with its own id, never an optional block. A count is unrolled
  against a fixed fixture, never a repetition block.
- **The notation `loop` and `opt` is forbidden.** Both admit the regression the diagram exists to
  catch: an optional block admits a path that skipped the step, and a repetition block admits zero
  repetitions and proves nothing about the order inside it.
- **Draw a path only when its seam set or seam order differs from a drawn one.** Two refusals that
  stop at the same step are one diagram, and the refusal code that separates them is proven by the
  refusal tests, never by a trace. A branch that changes a value and not the call set is not a
  diagram.
- **A path whose seam order is legitimately not fixed is not drawn as a diagram.** Two concurrent
  requests with no ordering rule are asserted as a set or a partial order, in the work item that
  makes them, and the plan document says so in one sentence. Do not invent a sequence in production
  to satisfy a notation, and do not draw a diagram that admits two traces.

## 2 — A message is a seam call, and nothing else is a message

The recorder observes exactly one thing: a call on the seam the binding names. A pure function is
invisible there, so it is never a message. A diagram that draws one cannot be checked. What a pure
function decides is proven by its own unit test, or by a decision table.

## 3 — The token grammar

- A step is `<n> <key>.<method>` or `<n> <key>.<method>:<label>`. `n` is dense from 1.
- **A diagram with no step is legal, and it is the strongest statement available.** It asserts that
  the path reaches no seam at all, so any call the implementation makes fails the comparison. A path
  that differs from another only by calling nothing is drawn this way rather than described in prose.
- **Only a numbered step is compared.** The arrow that enters from an end and the arrow that returns
  the terminal carry no ordinal, so a user action, a render or a call into the unit is drawn without
  being a recorded call. An unnumbered arrow between two participants is refused, because it would
  read as a message the recorder never saw.
- **No two steps of one diagram carry the same token.** A method called twice needs a projection that
  separates the calls, so no diagram passes by counting method names.
- **A method called twice with no natural projection is a decomposition signal, not a notation
  problem.** Never add a parameter to a production interface so a diagram can tell two calls apart,
  and never number the occurrences: an occurrence number is the method-name counting this rule exists
  to forbid, it means a different call on every path, and inserting one call renames every later one.
  A unit that calls one seam method repeatedly with nothing to distinguish the calls is doing several
  things, and each becomes a nested unit obeying the repository's own one-transaction rule and
  carrying its own diagram, where the call appears once. Where that decomposition is wrong for the
  product, the path is not drawn and the document says why in one sentence.
- **A call repeated over a list is drawn against a fixture whose length is stated**, and the
  projection separates the iterations by their own data. A list whose items produce identical tokens
  is not drawable: the fixture states a length of one, and the document says that the longer list is
  asserted by the unit's own test.
- A projection is declared once per method, in the harness, and never per test. It renders behaviour
  and renders an id through the scenario alias map, so a token holds `T` and never a ULID.
- A participant is a seam key, capitalized, and the parser checks it against the keys the recorder
  saw. No document holds a global participant list.
- A nested unit is one message, bound to an unrecorded seam, and it carries its own diagrams.
- A diagram is addressed by a `###` heading holding its id **in backticks**. A heading with no
  backticks is prose.
- **A diagram id is globally unique** across every plan document the range gate reads, because the
  scenario file is named after it. The gate refuses a repeat, so no document may assume its ids are
  local.

## 4 — The two escape hatches, and their limits

- `note over <Unit>: tail pinned by <document-id> <diagram-id>` ends the pinned prefix, for an
  operation this document amends at its prelude while a later document owns its body. The parser
  requires that exact form, and the gate refuses when the named document declares no such diagram id.
- `Supersedes: <document-id> <diagram-id>` claims a path an earlier document drew, and it names both
  halves, because an id alone does not resolve across documents. Exactly one diagram of a path is
  live at any commit: the superseded diagram stays in its own document as the record of what that
  document changed, gains a `Superseded by: <document-id> <diagram-id>` line, and holds no scenario
  file. Supersession therefore edits two documents and deletes one file, and it is the one operation
  that reaches outside the document being authored.

## 5 — Precedence, and its limit

Write this into the section: **for a path this section draws, the seam calls and their order are
authoritative over the prose of a work item.** A work item that names a seam call this section does
not draw is a defect in the work item.

The precedence stops there, because a diagram is deliberately lossy. It carries no value, no
predicate, no state change and no error semantics. A disagreement about any of those is **not**
resolved by the diagram: it makes the plan document invalid, and a human resolves it before
implementation. A gate that silently picks the diagram would only make a stale mistake executable.

## 6 — Every work item declares the seams it moves, with a sign

Directly under the work item's heading, before its prose, one per line:

```text
Diagrams: <id>, <id>
Seams: +<key>.<method>:<label>, ~<key>.<method>, -<key>.<method>
```

- `Diagrams:` names the live ids this work item changes. Exactly one work item owns each live
  diagram. **The scenario path is derived, never declared**: the binding gives the scenario root and
  the file is named after the diagram id, so the gate builds the path and checks the file exists. A
  declared path restates a derivable fact and then drifts from it.
- **A `Seams:` token is the exact token the diagram draws, alias included.**
  `+plan.setNodeState:T:done` is one token and `+plan.setNodeState:O:ancestor-started` is another.
  Stripping the alias collapses two calls into one declaration, and the gate can no longer tell which
  of them a sign governs.
- `+` adds a call, `~` moves one, and `-` removes one. An unsigned token is refused.
- **A renumbered call is not a moved call.** `~` states that a call's position changed relative to the other calls of the path. Inserting one step renumbers every later ordinal and moves nothing, so those tokens stay context and no work item declares them. A rule that read the ordinal instead would make a one-line insertion declare the whole path.
- **A sign is relative to the path, not to the range.** A token is new to a path when the diagram
  this one supersedes does not hold it, and a diagram that supersedes nothing is wholly new, so every
  one of its tokens is `+`. A method drawn on another operation's path is not context here: a
  `storage.transact` in one command says nothing about the first transaction of a different one.
- **A context token is not declared.** A call the superseded diagram already held, in the position it
  held, belongs to no work item of this document.
- The gate checks four things: a `+` or `~` token appears verbatim in a diagram this work item names;
  a `-` token appears in no live diagram; every token of a live diagram that its superseded diagram
  does not hold is `+` in exactly one work item; and no token carries two signs.
- **A work item that composes carries `Diagrams:` and no `Seams:` line.** A composed path's steps
  are the nested units, and each unit's tokens belong to the work item that writes that unit. The
  composing item still owns its diagram and its scenario, because the order of the units is what
  it decides.
- A work item that changes no drawn path carries neither line. A schema, a type, a pure function and
  a documentation item move no seam.

## 7 — What a diagram does not prove

State these limits in the section, because a gate that overclaims is worse than no gate:

- **Not a refusal code, and not precedence.** A refusal is decided by pure predicates the recorder
  cannot see. The code is proven by the refusal test, and the precedence by a decision table over
  every pair of refusals that can trigger at once. A pair table does not cover a three-way
  interaction; a document whose refusals interact three ways says so and adds the cases.
- **Not a transaction or lifecycle property.** The seam that opens the transaction appears as a step,
  which proves one is opened. That a nested pass receives the same context, and that a refusal rolls
  everything back, are separate cases.
- **Not "the operation wrote nothing".** A refusal diagram proves no write seam is reached after the
  refusal point. A nested maintenance pass is hidden behind one step by design, so what proves
  nothing committed is a state comparison before and after.
- **Not branch coverage.** A fixed fixture is one example. That the drawn set is every branch of the
  path is a claim the document makes in prose and a reviewer checks.

## 8 — What makes the standard the default

A skill produces a compliant section when it is invoked. It is not the mechanism that makes the
section mandatory. Three mechanisms carry that, and a repository that holds only the first has an
aspiration:

1. **The range gate** — a script in `verify` that refuses a plan document in its declared range with
   no `## Sequence` section, and refuses every inconsistency of standards 3, 4 and 6.
2. **A declared exemption** — `Sequence: not applicable — <reason>` in place of the section, for a
   document that moves no seam. The gate accepts the line and nothing else, so an exemption is a
   visible decision rather than a silent omission.
3. **The consuming skills** — the skill that expands a plan document into work items, the skill that
   implements them, and the skill that reviews the result each refuse a document that satisfies
   neither 1 nor 2.

## 9 — Rollout, and what is grandfathered

- **Prove the harness on a slice before requiring it anywhere.** Implement the recorder, one
  scenario and the runner against two paths of the first document, and mutate the implementation to
  confirm the comparison fails. Revise this standard from what that slice teaches, and raise
  `Standard-version`. A format nothing has executed is a guess.
- **The gate's range is explicit data**, and a document outside it is grandfathered with no
  annotation. A document inside the range carries the section or the exemption of standard 8.
- **Wire the gate into `verify` only when every document in its range satisfies it.** A gate that
  lands red teaches the team to skip it.

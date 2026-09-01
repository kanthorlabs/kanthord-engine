# Story 9 — The proposal records the claim

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: every prior story of this epic, and EPIC 050 Story 9 (which creates the document). This document states what the code does; write it last.
Kind: story-foundation

EPIC 050 Story 9 created `docs/proposal/phase-2/runs-and-exclusion.md` and recorded the run model.
This story adds the claim half. EPIC 050.2 Story 9 adds the authority half. It draws no path.

## Change

**Extend `docs/proposal/phase-2/runs-and-exclusion.md`.** Keep its structure: every section is a
`##` heading written as a sentence, unnumbered, and a section body is one declarative paragraph or a
numbered list with one owner per step. Insert each new section after
`## One active run per objective branch`, in this order:

- **`## A claim opens exactly one run`** — the daemon writes `node.assignment` and inserts the run in one storage transaction, at the first claim on an unassigned node. State why one operation: a crash between two would leave an assignment with no run, and the next claim would read an assignment nobody holds. State that the claim runs as an immediate write transaction, so two sibling claims serialise and the loser sees the winner's run.

- **`## An unassigned node routes, and an assigned node compares`** — routing takes the first worker of the capable, authorized and available intersection. A mismatch refuses `assignment-held`, and the refusal offers a human switch. State that an ordinary failure never changes an assignment, and that the worker switch of a later epic is the only writer that does.

- **`## The caller asserts availability, and the daemon never probes`** — a worker runs a self health check before it claims. The claim request carries `available`. A `false` value refuses `unroutable` with `failedSet: "available"`. A caller that asserts `true` when it is not available is trusted, and the guarantees table records that.

- **`## The claim has one path`** — every node carries a deliverable, so the claim does not dispatch on one. A claim opens exactly one run covering the claimed node and its descendants, and it never adopts an existing run. A task claim opens no parent objective run. State that a second claim by the same worker on a node with an active run is refused, and that retrying a lost response is the transport's job.

- **`## The refusal order is fixed`** — state the one total order, the twelve steps from `node-not-found` to `ancestor-not-startable`. A claim that fails two conditions reports the earlier one, so a client sees the cause it can act on first. State that every refusal is evaluated before the first mutation: before a lease is taken, a run is opened, an attempt is opened, a node state changes or an event is appended. State that a refusal writes nothing. State the one exemption: a node whose deliverable is `expansion` is exempt from the completeness check for its own missing children, because producing those children is the work.

- **`## A review claim is refused until the workspace exists`** — a review run records the commit it judges at claim time, this phase creates no workspace record, and no head can therefore be pinned. The refusal is `review-head-unavailable`. State why a null pin is not an option: a value written later records a commit chosen after the claim, which is the retrospective choice the pin prevents.

- **`## Every run operation evaluates expiry first`** — the claim runs the expiry pass before anything else, inside its one transaction. Sweeping only at the next claim would leave an expired run able to renew itself back to life. The expiry is a conditional update, so two racing sweeps cannot raise the fence twice, and the transition and its event are one transaction. State that the expiry is transactional maintenance: a command that expires a run and then refuses rolls the expiry back with everything else, because a refusal writes nothing, and the next operation sweeps the run again. State that the renew, the release and the report run the same pass, and name the epic that adds them.

## Constraints

- Extend the shipped document. Do not create a second one.
- **Write no section this epic does not implement.** Run authority, the renew formula, the release and the one-terminal-event rule belong to EPIC 050.2 Story 9. A section written here that a later epic implements makes this story unprovable in dispatch order.
- Do not restate the run kinds, the fence column, the exclusion rules, the base set, the provenance or the budgets. EPIC 050 Story 9 owns all seven sections.
- Record no implementation detail: no file path, no dependency key, no SQL.
- The document records the decision, not the search for it. A "why" sentence is admitted only where the rule is surprising without it, as in the refusal order and the review refusal above.
- ASD-STE100 style, matching the sibling phase-2 documents: simple tenses, active voice, one instruction per sentence.

## Verify

```
node --test test/helpers/proposal.test.ts
```

Add both cases to `test/helpers/proposal.test.ts`, beside the three EPIC 050 Story 9 added.

1. `"the run model document names every ordered claim refusal"` — read the file and assert it contains each member of the exported claim refusal list. Build the expected list by importing that list from `src/commands/node/claim-node.ts`, the same export Story 3 asserts against, rather than restating the twelve literals, so the document and the union cannot drift. Assert the count is twelve, so a thirteenth code added later fails until the document records it.

2. `"the claim sections state the order and the one-path rule"` — assert the document holds a `## The refusal order is fixed` section, a `## The claim has one path` section, and that the refusal order section names `node-not-found` before `ancestor-not-startable` by byte offset. The order is the claim's contract, so its direction is asserted and not assumed.

`pnpm run verify` exits 0. `pnpm run format` runs prettier over `docs`.

Proof: no PASS line of its own. This story is the documentation half of `PASS EPIC-050.1` and is gated by `pnpm run verify`.

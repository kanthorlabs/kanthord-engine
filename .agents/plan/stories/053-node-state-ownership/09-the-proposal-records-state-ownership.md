# Story 9 — The proposal records state ownership

Epic: `.agents/plan/epics/053-node-state-ownership.md`
Depends on: every earlier story of this epic, because it records behaviour they settled;
EPIC 047 (sequence order), for the `stateOwner` column of the pair table this document explains.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

**It is last in dispatch order, and it edits no range.** Story 8
(`08-the-accepted-settle-aggregates-the-parent`) carries the `shippedEpics` entry, because that entry
must land in the same turn as the superseded scenario file is deleted. This story records behaviour
every earlier story settled, so nothing depends on it and it goes last.

## Change

**Create `docs/proposal/phase-2/node-state-ownership.md`.** `AGENTS.md` makes `docs/proposal/` the
source of truth for behaviour, and no phase-2 document states the ownership rules today: the only
occurrence of the subject in the tree is the `State owner` column heading at
`docs/proposal/phase-2/deliverables-and-pairs.md:11` — `State owner`, which names three values and
explains none of them.

Follow the house shape of the newest document in the directory,
`docs/proposal/phase-2/runs-and-exclusion.md:1` — `Runs and exclusion`: a `#` title, a one-line
reviewer, phase and scope banner on line 3 that names what the document does **not** cover, then flat
`##` sections whose headings are declarative sentences. Use no `###`, matching
`docs/proposal/phase-2/gates-and-approval.md`, which holds none.

Write one section per rule, each stating the rule and nothing about how it is implemented:

- **the state owner per pair** — `report` for a task, `attestation-then-human` for an atomic
  objective, `aggregate` for a parent objective and for an initiative, which is the column of
  `docs/proposal/phase-2/deliverables-and-pairs.md:11` — `State owner` read as a rule rather than as a
  table cell;
- **the three parent-objective rows**, as a table: `done` and `partial` both give
  `awaiting_approval`, `discarded` gives `discarded`. State the transition-table evidence in prose —
  `src/domain/transition.ts:156` — `every task is terminal` admits `running -> awaiting_approval` for an
  objective with the condition "every task is terminal, and at least one task is `done`", and
  `src/domain/transition.ts:172` — `an objective always passes the human gate` refuses a `running` objective reaching `partial` with the
  note "an objective always passes the human gate";
- **why a `partial` projection still satisfies that condition** — a task is never `partial`, so a
  `partial` aggregate always carries at least one `done`;
- **the all-`discarded` exception**, which is the one terminal state a parent objective reaches with
  no human. Nothing remains to approve, and an objective that could reach neither the gate nor a
  terminal state would be unreachable state;
- **the aggregation rules** — every child `done` gives `done`, every child `discarded` gives
  `discarded`, a mixture gives `partial`, which is `docs/workflow/worker.md:363` — `aggregate` in
  prose;
- **the terminal-state tuple** — `done`, `partial`, `discarded`, and that `awaiting_approval` is not
  in it;
- **the two-deep roll-up and its stop condition** — a task report aggregates its parent objective;
  that objective moves the initiative only when it reaches `discarded`; an initiative has no parent.
  State that no ordered transition list and no generic ancestor walk exists, and that the depth is a
  property of the graph rather than a limit anyone enforces;
- **the precedence carried by the state guard** — human input overrides aggregation, and aggregation
  overrides attestation, which is `docs/workflow/worker.md:367` — `Human input overrides`. State
  that the precedence needs no provenance column: an aggregation writes only from `running`, and a
  closed objective is `done` or `partial` while an attested atomic objective is `awaiting_approval`,
  so neither is reachable by a later aggregation;
- **the event contract** — a parent-objective transition appends exactly one event, in the report
  transaction, subject the objective, actor the daemon. The type is `node.awaitingApproval` for the
  first two rows and `node.discarded` for the third, and the payload names the reason
  `tasks-terminal`, the ordered task states and the projection.

**State no `closed_at` column and no provenance column.** No epic builds one, and
`.agents/plan/epics/056.1-the-close-and-the-human-boundary.md` records the same ruling for the close.

**Add a row to `docs/proposal/phase-2/README.md`.** `test/helpers/proposal.test.ts:71` — `the phase-2 file table and the phase-2 directory agree`
compares the linked file set of the `## Files` table against the directory listing, so the new
document is a failing test until the row exists. The row must begin at column 0 in the form
`| [node-state-ownership.md](node-state-ownership.md) | … |`, because
`test/helpers/proposal.test.ts:80` — `matchAll` reads exactly that shape. Position in the table is
free: both sides are sorted before comparison.

## Constraints

- The proposal states behaviour, never a file name, a function name, a trigger id or a seam. A trigger
  id is contract data and belongs to the epic.
- Do not touch `docs/proposal/api/README.md`. Its error-code matrix is a contract register, and this
  epic registers no error code.
- Do not restate the pair table of `docs/proposal/phase-2/deliverables-and-pairs.md:11` — `State owner`.
  Cite the rule and name the document; a second copy of a twelve-row table drifts.
- `npx prettier --check docs` exits 0. It is the first step of `pnpm run verify` at
  `package.json:28` — `prettier --check src test scripts docs`, and it is why every table in these
  documents is column-aligned.
- Do not touch `scripts/epic-sequence-range.ts`. Story 8
  (`08-the-accepted-settle-aggregates-the-parent`) owns both range entries.

## Verify

```
node --test test/helpers/proposal.test.ts
```

Extend `test/helpers/proposal.test.ts`, whose content assertions read a document and assert
`includes` per heading with an `indexOf` ordering check, per
`test/helpers/proposal.test.ts:96` onward.

Add, each as a separate `it`:

1. `"the phase-2 README links node-state-ownership.md and the directory agrees"` — extend
   `test/helpers/proposal.test.ts:71` — `the phase-2 file table and the phase-2 directory agree`
   rather than adding a case beside it. It already compares both sides by sorted deep equality, so it
   passes once the row lands and fails on the row alone or on the file alone. **The control is the
   failure direction**: assert in the same case that the linked set has nine members and that
   `linkedFiles` holds `"node-state-ownership.md"` by value, so a row whose link target is misspelt
   fails rather than passing on the count.

2. `"node-state-ownership.md states every rule the epic settled"` — read the document and assert it
   `includes` each of its declared `##` headings, then assert by `indexOf` that the ownership section
   precedes the parent-objective table, that the table precedes the all-`discarded` exception, and
   that the precedence section precedes the event contract. Assert the document holds the three
   literal strings `awaiting_approval`, `discarded` and `tasks-terminal`, and that it holds **no**
   occurrence of `closed_at` and none of `objective-aggregated`, which is the "behaviour, never
   contract data" constraint asserted rather than trusted.

`pnpm run verify` exits 0.

Proof: this story delivers no PASS line of its own. Its obligations are the
`npx prettier --check docs` and `test/helpers/proposal.test.ts` steps of `pnpm run verify`, plus the
reading a human does. The epic's gate names no row for it, and this story invents none.

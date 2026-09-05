# Story 10 — The proposal records the structural acceptance

Epic: `.agents/plan/epics/052.1-the-structural-acceptance.md`
Depends on: Story 9 (`09-the-accepted-patch`), for the settled refusal set and the settled write
order; EPIC 051.4 Story 9 (`09-the-contract-and-the-proposal`), for
`docs/proposal/phase-2/checkpoints.md`, which this story amends rather than creates.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

**It stays in this epic and not in EPIC 052.2.** `AGENTS.md` makes `docs/proposal/` the source of
truth for behaviour, and this epic is where the behaviour is decided. EPIC 052.2 carries the wire
contract, which is a different document with a different obligation: it travels with the route that
honours it. `docs/proposal/api/README.md` is the one proposal file this story does **not** touch,
because its error-code matrix is a contract register and EPIC 052.2 Story 1
(`01-the-contract-carries-the-patch`) owns it.

**The file does not exist yet.** EPIC 051.4 Story 9 (`09-the-contract-and-the-proposal`) creates it.
An implementing agent that finds no `docs/proposal/phase-2/checkpoints.md` stops and reports the gap
rather than creating the document, because the sections this story adds sit beside sections that
story writes and an invented skeleton would collide with them.

## Change

**`docs/proposal/phase-2/checkpoints.md` — the structural sections.**

Amend the document EPIC 051.4 Story 9 (`09-the-contract-and-the-proposal`) created, adding one
section per rule, each stating the rule and nothing about how it is implemented:

- the mutation algebra: three operations, their field sets, and `update` as a partial replacement of
  named fields;
- the staged-graph rule: every legality question is asked of the graph the patch would leave;
- the three scope rules, named by role: mutation-subject authority over the pinned graph; written-
  parent placement over the staged graph, for a `create` and for an `update` naming `parentId`
  alike; and written-dependency reach over the staged graph. A null `parentId` on a node that is not
  the claimed node is `parent-missing`, and so a graph finding rather than a scope refusal;
- the project rule, and that it is decided before graph validation;
- the reference classification: scope judges a reference that resolves, a reference the projection
  holds and the staged graph does not is a project refusal, and a reference neither holds is a graph
  finding — the same three-way rule decides an `update` or a `delete` target;
- the fixed refusal order, as the ten groups of
  `.agents/plan/epics/052.1-the-structural-acceptance.md:39` — `The refusal order is fixed`;
- the currentness guard, and that equality against the pinned `graph_revision` is the only
  comparison;
- the at-least-one-child rule, which is unconditional and reads the staged graph alone;
- the pair-fixing rule, that a checkpoint of any kind fixes the pair, that the fix is permanent, and
  that `has-accepted-checkpoint` precedes `has-child` in the reported reason order because a
  checkpoint never goes away and a child sometimes can;
- the repository key space: a patch carries a repository id, validation compares in the id space, a
  finding renders the registered name, and a failed lookup splits by provenance — a patch naming an
  unknown id refuses, a document naming an unknown name is a finding, and a stored node naming a
  missing repository row is an invariant failure;
- the delete rule: a structural patch deletes a node only when the node is `pending`, `ready` or
  `blocked` and no durable row names it, with the blocker vocabulary stated in full;
- the correction-unit aggregation rule: every refusal of the family reports each independent
  correction unit of its own group and never the first, `expansion-empty` excepted because a patch
  has exactly one claimed node; and the complete sort key of every such list — bytewise by mutation
  or node id, then by the declared reason order, then bytewise by the offending reference id;
- the canonical patch serialisation, that submitted mutation order is never the oracle, and that
  `checkpoint.patch_blob` holds its bytes.

`.agents/plan/authoring.md` and `AGENTS.md` both make `docs/proposal/` the source of truth for
behaviour, so each rule appears here in full and no rule is left only in an epic.

## Constraints

- The proposal states behaviour, never a file name, a function name or a seam.
- Do not touch `docs/proposal/api/README.md`. Its error-code matrix is EPIC 052.2 Story 1
  (`01-the-contract-carries-the-patch`)'s, and `test/helpers/proposal.ts:89` — `readErrorCodeMatrix`
  reads it as a contract register.
- Do not restate a refusal code's HTTP status or its CLI exit code. Both are contract data, and both
  belong to EPIC 052.2 Story 1 (`01-the-contract-carries-the-patch`).
- `npx prettier --check docs` exits 0.

## Verify

```
node --test src/commands/node/claim-node.test.ts
```

This story's own oracle is `pnpm run verify`, which parses every proposal document, plus the reading
a human does. It adds one hermetic case, because the epic's gate row 33 names no other owner.

Add, as a separate `it`:

1. `"against the production registry, a claim on any expansion node refuses unroutable"` — extend
   `src/commands/node/claim-node.test.ts`, driving a claim against `workerRegistry` at
   `src/domain/worker-registry.ts` rather than the fixture at
   `test/helpers/worker-registry.ts:3` — `expansionCapableRegistry`. Assert the refusal is
   `unroutable` and `error.details.failedSet` is `"capable"`. This is the epic's gate row 33, and it
   is what stops a reader taking this epic's fixture for production behaviour. It sits beyond the
   epic's Proof block, which names no claim test.

`pnpm run verify` exits 0.

Proof: this story delivers no PASS line of its own. Its obligations are the epic's gate row 33 and
the `pnpm run verify` proposal parse.

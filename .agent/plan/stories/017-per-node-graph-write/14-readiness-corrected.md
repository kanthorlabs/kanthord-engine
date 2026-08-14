# Story 14 — Readiness, corrected

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: Stories 9, 10 and 11. This story writes no production code; it pins the readiness contract of the three routes.

## Change

No production file changes. EPIC 016 deleted `readinessObligated`, `readinessExempt`, `upsertNode`, `insertEdge` and `deleteEdge`, and it fenced every node and edge write into `src/services/plan/sqlite.ts` with an eslint rule (`016-readiness-applied.md:51`). The three commands write through `mutateGraph`, so readiness applies inside the store and no obligation registry exists.

**No command of this epic calls `setNodeState`, and no command of this epic names a trigger.** `MutateGraphInput` takes no trigger, and `deriveReadiness` stamps each transition it returns: a `pending → ready` transition carries `readiness-promoted` and a `ready → pending` transition carries `readiness-demoted`, which `016-readiness-applied.md:42` decides.

The transition inventory is exactly this, and it runs in both directions.

| write                                           | transition                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| create, no dependency                           | the new node `pending → ready` in the same mutation                                                        |
| create, unsatisfied dependency                  | none; the node stays `pending`                                                                             |
| create naming an existing node in `dependsOn`   | no other node changes; the new node has in-degree zero                                                     |
| update removing a `depends_on` entry            | the edited node may go `pending → ready`                                                                   |
| update adding an unsatisfied `depends_on` entry | the edited node goes `ready → pending`                                                                     |
| delete                                          | a `pending` dependent of a deleted node may reach `ready`; a delete never demotes, because it adds no edge |

**This epic is the routine consumer of the `ready → pending` cell that EPIC 014 flipped** (`014-external-drive-contract.md:23`), and EPIC 016 already computes both directions in one pass (`016-readiness-applied.md:33`). One pass stays a fixed point in both directions, so no write of this epic cascades. A write that leaves an objective with no task succeeds, and the objective keeps its state.

## Constraints

- Add no readiness code and no trigger constant.
- Do not weaken the eslint fence of `016-readiness-applied.md:51`.
- Do not add a second readiness pass to any command.

## Verify

**Create no new test file.** The Proof block at `.agent/plan/epics/017-per-node-graph-write.md:103-129` names every test file this epic creates, and it names no readiness test under `src/commands/node/`. Add each assertion below to the command test file it covers: a create assertion to `src/commands/node/create-node.test.ts`, an update assertion to `update-node.test.ts`, a delete assertion to `delete-node.test.ts`. An assertion covering all three goes in all three files, driven from a shared local helper in each.

- **No `setNodeState` call.** A recording `PlanStore` fake counts every mutation call of `createNode`, `updateNode` and `deleteNode` over one fixture each. Assert the recorded call name list is exactly `["mutateGraph"]` for each command, and that `setNodeState` was called zero times.
- **No trigger named.** Assert the recorded `MutateGraphInput` object holds no `trigger` key, for all three commands, using `Object.hasOwn`.
- **Each transition carries its own trigger.** Assert `readiness-promoted` on every promotion and `readiness-demoted` on every demotion, read from the transitions the store returns. Assert no other trigger value appears on any of the three routes.
- **A mismatched trigger fails.** Drive one transition through `setNodeState` with a pair that disagrees with `triggerTransition`, assert the store throws, and assert the write commits nothing. This proves the stamped pair is checked rather than trusted.
- The six inventory rows above, one test each, asserting the returned transitions and the stored `state` of every node in the fixture:
  - a create with no dependency promotes the new node;
  - a create with an unsatisfied dependency writes no transition;
  - a create naming existing nodes in `dependsOn` changes no other node's `state`, `revision` or `updated_at`;
  - an update removing a `depends_on` entry promotes the edited node;
  - an update adding an unsatisfied `depends_on` entry to a `ready` node demotes it, and `showNode` returns `pending`;
  - a delete promotes a dependent and writes no demotion.
- **One pass is a fixed point.** Over a chain of three nodes, assert that a single write produces at most one transition per node and that a second identical derivation over the resulting graph produces none.
- **An empty objective keeps its state.** An update that moves the last task out of an objective leaves the objective's `state` byte-identical.
- `node --test src/commands/node/create-node.test.ts src/commands/node/update-node.test.ts src/commands/node/delete-node.test.ts` exits 0.
- `npm run lint` exits 0, proving the EPIC 016 mutation fence still holds.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through the three `src/commands/node/*.test.ts` files. Hermetic coverage bullets `.agent/plan/epics/017-per-node-graph-write.md:154`, `:155`, `:156` and `:157`.

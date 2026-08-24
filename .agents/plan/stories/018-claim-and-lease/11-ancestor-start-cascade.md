# Story 11 — The ancestor start cascade

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 10. **Coupled with Story 10.** No verify gate between them.

## Change

The cascade lives **inside** `src/commands/node/claim-node.ts`, in the same transaction, on the same `now`, through `plan.setNodeState`. It is not a second command and not a service.

`docs/proposal/phase-1/state-machine.md:71` marks `ready → running` valid at all three levels, and `src/domain/transition.ts:79-85` carries that row with `task`, `objective` and `initiative` all `true`.

### The walk

Build the ancestor chain from the node set already read in step 2 of Story 10, by following `parentId` upward. A task claim walks to the objective and then to the initiative. An objective claim walks to the initiative. **Write the ancestors in order from the nearest to the farthest**: objective first, then initiative. Order is explicit so the event sequence of one claim is reproducible.

For each ancestor, in that order:

- state `ready` — `plan.setNodeState(transaction, { id, from: "ready", to: "running", trigger: "ancestor-started", blockReason: null, at: now, cause })`.
- state `running` — leave it untouched, write no state and append no event. This is the state `docs/proposal/phase-1/state-machine.md:55` requires while any child is non-terminal.
- any other state — `pending`, `blocked`, `awaiting_approval`, `done`, `partial` or `discarded` — raise `ClaimNodeError("ancestor-not-startable")` and refuse the **whole** claim, with `details` `{ ancestorId, state, admitted: ["ready", "running"] }`. A `pending` ancestor is a refusal and not a silent start, because `pending` means a sibling dependency of the ancestor is unsatisfied.

The refusal maps to `409 illegal-transition` in Story 14, the same code the claimed node's own bad state takes.

**There is one refusal for a bad ancestor state, and it is `ancestor-not-startable`.** Story 10's `illegal-transition` refusal covers the **claimed node's own** state and carries `{ state, admitted }` with no `ancestorId`. This one covers an **ancestor's** state and always carries `ancestorId`. Both map to HTTP `409 illegal-transition`, so a client sees one code, and `details.ancestorId` is what distinguishes them. A claim on a task whose objective is in a bad state is therefore `ancestor-not-startable`, never the claimed-node variant — the claimed task itself is `ready`. Story 10's own six-state loop drives the **claimed node** through those states; this story's loop drives the **objective**. Both suites keep their loop, and each asserts its own refusal and its own `details` shape.

### The events

Each cascade transition writes one `node.running` event with `actorKind: "daemon"`, `actorId: dependencies.instanceId` and payload reason `child-started`, which follows the derived-transition attribution rule of EPIC 016. **The claimed node's own transition keeps the calling actor**, because it is the decision, and the cascade is a consequence.

### Ordering inside the claim

The whole event order of one successful `ready` claim is therefore, exactly:

1. any `recovery.leaseRecovered` of the step-1 sweep, in `subject_id` order.
2. `lease.claimed`.
3. one `node.running` per started ancestor, nearest first.
4. `node.running` for the claimed node.

The ancestor refusal is evaluated **before** any node state is written, so a refused claim writes no partial cascade. Compute the whole ancestor verdict list first, then write.

## Constraints

- No new file. The cascade is a private function in `src/commands/node/claim-node.ts`.
- One transaction and one `now`, shared with the claim.
- The cascade calls `plan.setNodeState` and nothing else. It runs no SQL and appends no event of its own beyond the one `node.running` per transition, which `setNodeState` does not append — `claimNode` appends it.
- The cascade never moves an ancestor out of `running`, and it never writes `awaiting_approval`.
- The cascade never writes a `task` node. `ancestor-started` declares `levels` without `task`, and `setNodeState` throws on the disagreement.
- Do not cascade along a dependency edge. Containment only.

## Verify

Add to `src/commands/node/claim-node.test.ts`:

- `a task claim starts the objective and then the initiative` — assert both states by identity, and assert the two `node.running` events appear objective-first.
- `an objective claim starts the initiative only` — assert the initiative moved and no task moved.
- `each cascade write records trigger ancestor-started` — assert through the recording `PlanStore` fake, and assert no other trigger appears on the cascade path.
- `each cascade event is attributed to the daemon with reason child-started` — assert `actorKind`, `actorId` and the payload reason.
- `the claimed node's own event keeps the calling actor` — assert `actorKind` is `harness` and `actorId` is the claiming actor id on that one event.
- `an ancestor already running is left untouched` — the recording `PlanStore` fake recorded no call for it, and no event names it.
- `an ancestor in any of six other states refuses the whole claim` — loop `pending`, `blocked`, `awaiting_approval`, `done`, `partial`, `discarded`. For each: assert `ancestor-not-startable`, assert `details` names the ancestor identity, its state and `["ready", "running"]`, and assert the database is deep-equal before and after, including the `lease`, `run` and `attempt` tables.
- `a refused cascade writes no partial cascade` — a task whose objective is `ready` and whose initiative is `done`; assert the objective is still `ready` afterwards.
- `a cascade with the ancestor-started trigger on a task node throws` — drive `setNodeState` with `ancestor-started` on a `task` node and assert it throws, because the declared `levels` list refuses it.
- `the full event order of one claim is exact` — one fixture with an expired sibling lease so the sweep fires, and assert the event type list of the transaction equals `["recovery.leaseRecovered", "lease.claimed", "node.running", "node.running", "node.running"]` in that order, with the subject of each `node.running` asserted.

Run:

- `node --test src/commands/node/claim-node.test.ts src/domain/transition.test.ts src/domain/external-transition.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/node/claim-node.test.ts` and `src/domain/transition.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:186-188`, `:208`.

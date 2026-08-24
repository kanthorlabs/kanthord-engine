# Story 13 — `eventTypes`, the closed list

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Stories 7, 8, 9, 10, 11, which write the five event types this epic adds. **Coupled with Story 14**, which declares one payload schema per member and lands the honesty test that keeps the list total.

This is the first half of the EPIC bullet at `019-outcome-report.md:80`.

## Change

### A new `src/domain/event-type.ts`

```ts
export const eventTypes = [ ... ] as const;
export type EventType = (typeof eventTypes)[number];

export const retiredEventTypes: readonly EventType[] = [];
```

`eventTypes` is the **append-only historical registry**: every type any build ever wrote. `retiredEventTypes` names the members no producer in this build writes any more. It is empty in this epic, and it exists because the two ideas conflict otherwise: an append-only registry cannot stay equal to a scan of the current source tree once a producer is retired. Story 14 therefore asserts a **subset** relation plus this named difference, never a bare equality.

**Append-only means no member is ever removed. It does not mean appended at the end.** A new member takes its bytewise position in the tuple, and the tuple stays sorted; the file's history is not its order.

The list is sorted **bytewise** and holds no duplicate. Write it as a flat tuple of string literals in exactly this order. This is the expected list at authoring time, 36 members:

```
actor.registered
actor.revoked
actor.tokenRotated
lease.claimed
lease.released
lease.renewed
node.awaitingApproval
node.created
node.deleted
node.discarded
node.done
node.imported
node.partial
node.pending
node.ready
node.running
node.unblocked
node.updated
outcome.reported
plan.imported
project.created
project.repositoriesReplaced
provider.defaultSet
provider.registered
provider.removed
provider.renamed
recovery.childReaped
recovery.journalReconciled
recovery.leaseBlocked
recovery.leaseRecovered
recovery.publishReconcilePending
recovery.remnantRefused
recovery.remnantRemoved
repository.outsideWriter
repository.register.credentialRejected
repository.registered
```

**The scan is the authority over the producers, not over the registry.** Story 14's scan derives the set of types this build writes. Reconcile in one direction only:

- a type the scan finds and `eventTypes` omits is **added** to `eventTypes`, in its bytewise position;
- a type `eventTypes` holds and the scan does not find is **kept** and added to `retiredEventTypes`, never deleted, because a durable `event` row may hold it.

Report every reconciliation in the story hand-off. `retiredEventTypes` is expected to stay empty in this epic; a non-empty value means one of EPICs 015 to 018 landed differently from its story, and that is a finding for the human.

The 36 members come from these producers:

- eighteen literals under `src/commands/` today, including the two `recovery.leaseRecovered` and `recovery.leaseBlocked` literals of the ternary at `src/commands/startup/recover-expired-leases.ts:157-160`;
- `actor.registered`, `actor.revoked` and `actor.tokenRotated` of EPIC 015 (`015-actor-identity.md:68`);
- `node.ready` and `node.pending` of EPIC 016, written in `src/services/readiness/dependency.ts`;
- `node.created`, `node.updated` and `node.deleted` of EPIC 017;
- `lease.claimed`, `lease.renewed`, `lease.released` and `node.running` of EPIC 018 (`018-claim-and-lease.md:94,98`);
- `outcome.reported`, `node.awaitingApproval`, `node.done`, `node.partial` and `node.discarded` of this epic;
- `node.unblocked` of this epic, written by `unblockNode` of Story 19a. `eventTypes` holds it from this story, and Story 19a is the story whose command first writes it. A registry member with no producer yet is legal, because the two relations of Story 14 are subset relations and never a bare equality.

## Constraints

- `domain/` is pure. This file imports nothing, `zod` included, and it reads no clock.
- `eventTypes` is **append-only**. Never remove a member. A build that no longer writes a type still serves the rows that hold it.
- Declare the tuple `as const` and derive `EventType` from it. Do not hand-write a second union.
- Do not add a type this repository does not write. A speculative member breaks the honesty test in the other direction.

## Verify

Create `src/domain/event-type.test.ts`, suite name `"src/domain/event-type.test"`.

- `it("eventTypes is sorted bytewise", ...)` — compare each adjacent pair through `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))` and assert every result is `-1`. Do not use `Array.prototype.sort` with the default comparator.
- `it("eventTypes holds no duplicate", ...)` — `new Set(eventTypes).size === eventTypes.length`.
- `it("every member is a non-empty dotted name", ...)` — each member matches `/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/`.
- `it("retiredEventTypes is a subset of eventTypes", ...)` — every member is a member of `eventTypes`, and the array holds no duplicate.
- `it("the six types of this epic are present", ...)` — assert `outcome.reported`, `node.awaitingApproval`, `node.done`, `node.partial`, `node.discarded` and `node.unblocked` by name.
- `node --test src/domain/event-type.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/domain/event-type.test.ts`. Hermetic coverage: `019-outcome-report.md:176` (the sorted and duplicate clauses).

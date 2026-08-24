# Story 6 — The external transition rows

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: EPIC 014, which authors `src/domain/external-transition.ts`, `ExternalPrecondition`, `externalTransitions`, `externalTriggerConsumer` and `src/domain/node-trigger.ts`.

## Change

### `src/domain/external-transition.ts`

Add exactly **two** rows to `externalTransitions`. Both are `task running → ready`. Every one of the seven `ExternalPrecondition` fields is required, so no field is omitted and no field is `undefined`.

`claim-released`:

```
level: "task"
from: "running"
to: "ready"
runDriver: "external"
activeRun: true
leaseFence: "valid"
actorKind: "harness"
attemptLimit: "under"
reportedObjectId: "absent"
childAggregation: "not-applicable"
```

`claim-expired`: identical, except `leaseFence: "none"` and `actorKind: "daemon"`.

Two rows and not one, because a release presents a valid fence and an expiry presents none, and `leaseFence` admits exactly `"valid" | "none"`.

Add two entries to `externalTriggerConsumer`:

```
"claim-released": "src/commands/node/release-node.ts"
"claim-expired": "src/commands/startup/recover-expired-leases.ts"
```

Both values start with `src/commands/`, which that map requires.

Place the two rows after the six EPIC 014 rows, in the order `claim-released` then `claim-expired`, and place the two map entries in the same order. Order is only documentation here, because the test asserts the id **set**; keep it stable so a later diff reads clean.

### The exact-count assertion

`src/domain/external-transition.test.ts` asserts the external trigger id set exactly. EPIC 014 pins it at six ids. Raise it to **eight** in this story, and add the two new ids to the asserted literal list. `.agents/plan/epics/014-external-drive-contract.md` states that EPIC 018 raises the assertion to eight and EPIC 019 raises it to ten, so the edit belongs here.

**This epic admits no file to a source scan, because no source scan exists.** EPIC 014 deleted it. The required `trigger` parameter of `PlanStore.setNodeState` replaces the mechanism: each node state write of this epic names `claim-taken`, `ancestor-started`, `claim-released`, `claim-expired`, `recovery-requeued` or `recovery-blocked`, and `setNodeState` throws when the declared row of that trigger disagrees with the pair written. Write no allow list, and restore no scan.

## Constraints

- Add no third external row, and add no internal row. The fifteen internal triggers are exact at the close of EPIC 014.
- Change no field of an existing row.
- `canTransition("task", "running", "ready")` is already `true` at `src/domain/transition.ts:135-141`. Change no matrix cell.
- Do not create `src/commands/node/release-node.ts` here. Story 12 creates it; `externalTriggerConsumer` names a path and EPIC 014's own assertion checks only the `src/commands/` prefix. EPIC 019 owns the on-disk existence assertion.

## Verify

`src/domain/external-transition.test.ts`:

- `externalTransitions holds eight trigger ids` — assert the id list exactly, as an ordered literal, and assert each id appears once.
- `the claim-released row carries every ExternalPrecondition field` — assert all ten members of the row (`level`, `from`, `to` and the seven preconditions) field by field with `assert.deepEqual` against a literal object.
- `the claim-expired row carries every ExternalPrecondition field` — the same, and assert it differs from `claim-released` in exactly `leaseFence` and `actorKind`.
- `both new rows name a legal matrix cell` — `canTransition("task", "running", "ready")` is `true`.
- `externalTriggerConsumer is total over the eight trigger ids` — no key missing, no extra key.
- `claim-released names the release command and claim-expired names the sweep` — assert the two exact path strings.
- `every externalTriggerConsumer value starts with src/commands/` — unchanged EPIC 014 assertion, now over eight entries.

`src/domain/node-trigger.test.ts`:

- `triggerTransition returns the declared triple for claim-released and for claim-expired` — each returns a one-member `levels` list holding `task`, `from: "running"` and `to: "ready"`.
- `the external id set and the internal id set stay disjoint` — unchanged EPIC 014 assertion, now over eight external ids.

Run:

- `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/transition.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/domain/external-transition.test.ts` and `src/domain/transition.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:207`.

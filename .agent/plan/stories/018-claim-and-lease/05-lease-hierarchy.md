# Story 5 — The lease hierarchy as a pure function

Epic: `.agent/plan/epics/018-claim-and-lease.md`

## Change

One new file `src/domain/lease-hierarchy.ts`. It imports `zod` at most, reads no clock, runs no SQL and mints no identity. `src/domain/layout.test.ts:57` asserts the file holds no `Date.now(`, no `new Date(` and no `Math.random(`.

```ts
export const leaseRelations = [
  "self",
  "ancestor",
  "descendant",
  "sibling",
] as const;
export type LeaseRelation = (typeof leaseRelations)[number];

export type LiveLease = Readonly<{
  subjectId: string;
  owner: string;
  ownerKind: LeaseOwnerKind;
  fence: number;
  expiresAt: number;
}>;

export type LeaseHierarchyInput = Readonly<{
  targetId: string;
  targetKind: NodeKind;
  parentId: string | null;
  childIds: readonly string[];
  siblingIds: readonly string[];
  owner: string;
  liveLeases: readonly LiveLease[];
}>;

export type LeaseRefusal = Readonly<{
  subjectId: string;
  holder: string;
  holderKind: LeaseOwnerKind;
  fence: number;
  relation: LeaseRelation;
  expiresAt: number;
}>;

export function liveLeaseRefusal(
  input: LeaseHierarchyInput,
): LeaseRefusal | null;
```

`NodeKind` comes from `src/domain/state.ts`. `LeaseOwnerKind` and its runtime list `leaseOwnerKinds` come from `src/domain/lease.ts`, where EPIC 014 declares them beside the `ownerKind` member of `leaseRow`. When EPIC 014 declared the type without the runtime list, add

```ts
export const leaseOwnerKinds = ["daemon", "actor"] as const;
```

to `src/domain/lease.ts` and derive the type from it. Declare it in exactly one place: `src/services/lease/index.ts` (Story 7), `src/http/contract/error-details.ts` (Story 14) and `src/services/storage/migration-0007-external-execution.test.ts` (Story 4) all import that one list.

### The rule

The function ignores every lease whose `owner` equals `input.owner`. **A lease held by the claiming owner is never a refusal, at any relation.** Without this rule an actor deadlocks itself between its own objective claim and its own task claim.

For a lease of another owner, the relation is computed in this exact precedence, and the **first** match wins:

1. `self` — its `subjectId` equals `input.targetId`.
2. `ancestor` — its `subjectId` equals `input.parentId`.
3. `descendant` — its `subjectId` is a member of `input.childIds`.
4. `sibling` — its `subjectId` is a member of `input.siblingIds`.

A lease matching none of the four is ignored.

The admitted relation set depends on `targetKind`:

- `task` — `self`, `ancestor` and `sibling` refuse. `descendant` cannot arise, because a task holds no child; when it does arise the function ignores it.
- `objective` — `self` and `descendant` refuse. `ancestor` and `sibling` do not: an initiative is never claimed, and a sibling objective is a separate scope.
- `initiative` — the function returns `null` unconditionally. An initiative is never claimed, and `claimNode` refuses it before it reaches this function.

**Selection when more than one lease refuses, in this exact order.** Relation precedence wins first, and identity breaks a tie inside one relation:

1. Group the refusing leases by relation.
2. Take the group of the **earliest** relation in `leaseRelations` order — `self`, then `ancestor`, then `descendant`, then `sibling`.
3. Inside that group return the lease whose `subjectId` is smallest under `Buffer.compare`.

**Precedence first, identity second.** A bare "smallest `subjectId`" rule contradicts the intent: `self` is the refusal that names why the claim cannot proceed, and an identity comparison would report an `ancestor` or a `sibling` instead whenever its identity happens to sort lower. Both halves are needed and neither alone is deterministic across relations.

Ordering is explicit and never the input order.

The `sibling` relation is redundant in the acquisition path, because the objective lease of Story 10 already excludes a second actor. It is computed so the refusal message names the sibling a human sees, and so the rule reads whole.

### Liveness

The function decides no liveness. `input.liveLeases` holds unexpired rows only, and the caller is what filters them. `expiresAt` travels only so the refusal can report it.

## Constraints

- Return type is `LeaseRefusal | null`. Do not return a list.
- The function is total: every `targetKind` and every empty-list combination returns a value and throws never.
- Declare `leaseRelations` as a `const` tuple in this file. `src/http/contract/error-details.ts` reads it in Story 14, and `http/contract/` may import `domain/`.
- Import no service interface and no `Transaction`.
- Add no SQL, no `expiresAt` comparison, and no `now` member.

## Verify

New test file `src/domain/lease-hierarchy.test.ts`, suite name `src/domain/lease-hierarchy.test`. Use fixed identities: objective `node_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E`, tasks `node_01JQ8ZDV5W6X7Y8Z9A0B1C2D40`, `node_01JQ8ZDV5W6X7Y8Z9A0B1C2D41`, initiative `node_01JQ8ZDV5W6X7Y8Z9A0B1C2D42`; owners `actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D50` and `actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D51`.

- `leaseRelations holds exactly four members in the declared order` — `assert.deepEqual(leaseRelations, ["self", "ancestor", "descendant", "sibling"])`.
- `an empty live lease set is never a refusal` — every `targetKind`, `null` returned.
- `a task claim is refused on another owner's lease over the task itself` — refusal carries `relation: "self"`, the other owner, its owner kind and its expiry.
- `a task claim is refused on another owner's lease over its parent objective` — `relation: "ancestor"`.
- `a task claim is refused on another owner's lease over a sibling task` — `relation: "sibling"`, and `subjectId` names the sibling.
- `an objective claim is refused on another owner's lease over the objective itself` — `relation: "self"`.
- `an objective claim is refused on another owner's lease over one of its tasks` — `relation: "descendant"`.
- `an objective claim is not refused on another owner's lease over a sibling objective` — `null`.
- `a same-owner lease is never a refusal at any relation` — one `it` that loops the four relations for a `task` target and the two for an `objective` target, each with `owner` equal to the lease owner, and asserts `null` every time.
- `an initiative claim is never refused` — `targetKind: "initiative"` with another owner's lease at every relation returns `null`.
- `relation precedence beats identity order` — a `task` target with one refusing lease at `self`, one at `ancestor` and one at `sibling`, all of another owner, and the **`ancestor` objective identity deliberately sorts before the `self` task identity** under `Buffer.compare`. Assert the result is `relation: "self"`. With the fixed identities above the objective is `...D3E` and the task is `...D40`, so the objective does sort first; assert that fact through `Buffer.compare` in the test body, then assert the refusal is still `self`. This is the case a bare identity rule gets wrong.
- `identity order breaks a tie inside one relation` — two **sibling** leases of another owner, supplied in descending identity order, and the refusal names the smaller identity. Assert through `Buffer.compare` on the two identities so the expectation is not a hand-guessed order.
- `the refusal carries the holder's fence` — assert `fence` on the returned refusal equals the `fence` of the refusing `LiveLease`, so `leaseHeldDetails` of Story 14 has every member it needs.
- `the function reads no clock` — a lease whose `expiresAt` is `0` and a lease whose `expiresAt` is `Number.MAX_SAFE_INTEGER` produce the same relation, so liveness is the caller's decision.

Run:

- `node --test src/domain/lease-hierarchy.test.ts src/domain/layout.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/domain/lease-hierarchy.test.ts`.

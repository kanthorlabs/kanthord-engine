# Story 3 — `services/readiness`

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: Story 2. **Coupled with Story 9**, which pins the event fields of the same file. Implement Story 3 then Story 9 with no verify gate between them.

## Change

### A new `src/services/readiness/index.ts`

The interface file. It imports `domain/` and service interfaces only, and it holds no `implements`. `src/domain/layout.test.ts:159-175` forbids the string `implements ` in every `src/services/*/index.ts`.

```ts
import type { Transaction } from "../storage/index.ts";
import type {
  ReadinessNode,
  ReadinessTransition,
} from "../../domain/readiness.ts";
import type { StoredEdge } from "../../domain/plan-graph.ts";

export type ReadinessCause = Readonly<{
  revision: string;
  importId: string | null;
}>;

export type ReadinessInput = Readonly<{
  projectId: string;
  nodes: readonly ReadinessNode[];
  edges: readonly StoredEdge[];
  at: number;
  cause: ReadinessCause;
}>;

export interface Readiness {
  apply(
    transaction: Transaction,
    input: ReadinessInput,
  ): readonly ReadinessTransition[];
}
```

`ReadinessTransition` is re-exported for a consumer's convenience by a type-only `export type { ReadinessTransition };` line. Declare no second copy of it.

`ReadinessInput` carries **no** `instanceId`. The daemon instance identity reaches the implementation through its constructor, so the store never holds one. `.agents/plan/epics/016-readiness-applied.md:48` names `instanceId` on the input and `:55` names it on the constructor; the constructor wins, because `SqlitePlanStore` calls `apply` and holds no identity of its own.

### A new `src/services/readiness/dependency.ts`

```ts
export type DependencyReadinessDependencies = Readonly<{
  events: EventLog;
  instanceId: string;
}>;

export class DependencyReadiness implements Readiness {
  constructor(private readonly dependencies: DependencyReadinessDependencies) {}

  apply(
    transaction: Transaction,
    input: ReadinessInput,
  ): readonly ReadinessTransition[];
}
```

`apply` does exactly this, in this order.

1. Call `deriveReadiness(input.nodes, input.edges)`.
2. For each returned transition, in the returned order, call `this.dependencies.events.append(transaction, ...)` once. Story 9 pins every field of that call.
3. Return the transitions unchanged, in the same order.

It writes no node row and no edge row. It calls no clock, mints no identity and holds no `PlanStore`.

### `src/domain/layout.test.ts`

The test title at `src/domain/layout.test.ts:101` reads `src/services/ holds exactly the fourteen capabilities plus home-lock` in the current tree. EPIC 015 Story 2 changes it to `fifteen` and inserts `"secret"`. This story changes it to **exactly** this string:

```
src/services/ holds exactly the sixteen capabilities plus home-lock
```

The `assert.deepEqual` array becomes **exactly** this seventeen-entry list, in this order:

```ts
assert.deepEqual(directoryNames, [
  "agent",
  "blob",
  "clock",
  "config",
  "crypto",
  "document",
  "event",
  "git",
  "graph",
  "home-lock",
  "ids",
  "lease",
  "plan",
  "readiness",
  "secret",
  "storage",
  "verify",
]);
```

Sixteen capabilities plus `home-lock` is seventeen entries. The array is sorted, so `"readiness"` sits between `"plan"` and `"secret"`. `.agents/plan/epics/016-readiness-applied.md:48` and `:105` say "fifteen"; that count predates EPIC 015 adding `secret`.

## Constraints

- `src/services/readiness/index.ts` may import `domain/` and other service interfaces only. It must not import `./dependency.ts`.
- `src/services/readiness/dependency.ts` may import `domain/`, any service interface, and an implementation in the `readiness` capability only. It must not import `../plan/sqlite.ts`, `../event/sqlite.ts` or any other capability's implementation.
- `apply` runs inside the caller's transaction. Do not call `storage.transact`. `src/services/storage/sqlite.ts:36` refuses a nested transaction.
- The capability needs no `not-implemented.ts`. `src/domain/layout.test.ts:144-157` requires one for `agent`, `verify` and `lease` only.
- Add no `PlanStore` member and no `Storage` member to `DependencyReadinessDependencies`.
- Do not wire the capability into `src/main.ts`. Story 10 owns composition.

## Verify

Add `src/services/readiness/dependency.test.ts` with the suite name `"src/services/readiness/dependency.test"`.

Build a hand-written recording `EventLog` fake in the pattern of `src/commands/plan/import-plan.test.ts:260-291`: `append(transaction, input)` pushes `{ transaction, input }` onto a local array and returns a fixed `RecordedEvent`. Use a `Transaction` stub whose `run`, `get` and `all` throw, so a database touch fails the test.

Assert each of these.

- `apply` over a node set that yields no transition returns `[]` and appends nothing.
- `apply` over a promotion fixture returns the transitions `deriveReadiness` returns, deep-equal and in the same order.
- `apply` appends exactly one event per returned transition. Assert `recorded.length === result.length`.
- `apply` passes the caller's transaction to every append. Assert every `recorded[i].transaction` is the same object identity the test handed to `apply`.
- `apply` writes no row: the stubbed `Transaction` throws on `run`, `get` and `all`, and the call still succeeds.
- The event order equals the transition order, which is bytewise by node identity. Use the identities `node_Z`, `node_a` and `node_B` and assert the recorded `subjectId` order is `["node_B", "node_Z", "node_a"]`.
- `apply` over the mixed fixture of Story 2 returns both directions from one call, and appends two events.
- `src/services/readiness/index.ts` contains no occurrence of `implements ` — assert by source read, in the pattern of `src/domain/layout.test.ts:159-175`.
- `node --test src/services/readiness/dependency.test.ts src/domain/layout.test.ts src/domain/readiness.test.ts` exits 0.
- `src/domain/layout.test.ts` asserts the capability inventory as the exact seventeen-entry array above, and its title names `sixteen`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/services/readiness/dependency.test.ts` and `src/domain/layout.test.ts`. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:96` and `:105`.

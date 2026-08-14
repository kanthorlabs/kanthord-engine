# Story 10 — Composition and the daemon instance identity

Epic: `.agent/plan/epics/016-readiness-applied.md`
Depends on: Story 3, Story 4 and Story 8.

**Member of the atomic unit 04 + 05 + 07 + 08 + 10.** Run every member before `npm run verify`; no intermediate state of the unit typechecks. See `index.md` for why.

## Change

### `src/main.ts` — hoist the instance identity

`src/main.ts:136` mints `ulid()` inline inside the `held.publishIdentity({...})` literal at `:131-137` and discards it. Declare it above that call:

```ts
const instanceId = ulid();
held.publishIdentity({
  version: 1,
  pid: process.pid,
  host: hostname(),
  startedAt: new Date().toISOString(),
  instanceId,
});
```

`ulid` is already imported at `src/main.ts:15`. The published bytes stay identical: `renderIdentity` at `src/services/home-lock/identity.ts:3-12` writes the same five keys in the same order.

### `src/main.ts` — construction order

`src/main.ts:163` reads `const plan = new SqlitePlanStore();` and `:165` reads `const events = new SqliteEventLog({ storage, ids });`. `SqlitePlanStore` now needs a `Readiness`, and `DependencyReadiness` needs the `EventLog`, so the order inverts. Replace `:161-166` with, in exactly this order:

```ts
const ids = new UlidIdGenerator();
const graph = new GraphologyGraph();
const reader = new YamlDocumentReader();
const events = new SqliteEventLog({ storage, ids });
const readiness = new DependencyReadiness({ events, instanceId });
const plan = new SqlitePlanStore({ readiness });
const blobs = new SqliteBlobStore({ storage, clock });
```

`events` before `readiness`, `readiness` before `plan`. Construction is one way and holds no cycle.

Add the import beside the other implementation imports:

```ts
import { DependencyReadiness } from "./services/readiness/dependency.ts";
```

### `src/main.ts` — the recovery step

`src/main.ts:191-195` calls `recoverExpiredLeases`. Add `plan` to its dependency bag:

```ts
        leases: () =>
          recoverExpiredLeases(
            { storage, plan, git, events, clock },
            { actor: "daemon" },
          ),
```

`plan` is in scope at `:191`, because the whole block moved above `recoverHome` at `:167`.

## Constraints

- Change no other line of `src/main.ts`. The four `actor: "daemon"` bindings at `:179`, `:184`, `:189` and `:194` stay.
- Register no CLI command. Add no row to `src/cli/inventory.ts` and no command to `src/cli/program.ts`.
- Change no entry of `src/http/contract/`. No operation is added, removed or relifecycled, so `src/http/contract/parity.ts` needs no edit.
- Pass `instanceId` to `DependencyReadiness` only. Do not pass it to `SqlitePlanStore`, to a command or to a handler.
- Do not call `ulid()` a second time. One daemon process publishes one instance identity, and the readiness events must carry that same value.

## Verify

- `npm run typecheck` exits 0.
- `node --test src/main.test.ts` exits 0. Every routed operation still answers, and the SIGTERM case at `src/main.test.ts:278-288` still exits 0 and releases the home lock.
- Add `it("main.ts mints one instance identity and passes it to readiness", ...)` to `src/main.test.ts`, asserted by source read of `src/main.ts`:
  - `ulid()` appears exactly once — `assert.equal(source.split("ulid()").length - 1, 1)`.
  - the source contains `const instanceId = ulid();`.
  - the source contains `new DependencyReadiness({ events, instanceId })`.
  - the source contains `new SqlitePlanStore({ readiness })`.
  - the index of `new SqliteEventLog` is lower than the index of `new DependencyReadiness`, which is lower than the index of `new SqlitePlanStore`.
  - `actor: "daemon"` appears exactly four times.
- `node --test src/http/contract/parity.test.ts` exits 0 with no edit to `src/http/contract/`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/main.readiness.test.ts` of Story 11, which cannot pass unless this composition binds the real `DependencyReadiness`.

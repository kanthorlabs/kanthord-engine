# Story 3 — Routing

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 2

## Change

- Add `src/domain/worker-routing.ts`. Export:
  - `WorkerRoutingError extends Error` with `readonly code: "worker-unknown-id" | "worker-duplicate-id" | "authorized-not-capable" | "available-not-authorized"`.
  - `capableWorkers(registry: typeof workerRegistry, input: { kind: string; deliverable: string }): readonly string[]` — returns every entry whose `claims` array includes `input.kind` and whose `deliverables` array includes `input.deliverable`, in registry declaration order. Returns the `worker` id strings. Pure function; throws nothing.
  - `routeWorker(input: { registry: typeof workerRegistry; kind: string; deliverable: string; authorized: readonly string[]; available: readonly string[] }): { routed: true; worker: WorkerEntry } | { routed: false; refusal: "unroutable"; failedSet: "capable" | "authorized" | "available" }`.

- `routeWorker` validation sequence (in this exact order — stop at first failure and throw):
  1. Collect all worker ids from `registry` into a set. For each id in `authorized` and `available`: throw `WorkerRoutingError("worker-unknown-id")` if the id is absent from the registry id set.
  2. Throw `WorkerRoutingError("worker-duplicate-id")` if `authorized` contains a duplicate or `available` contains a duplicate (check each array independently).
  3. Throw `WorkerRoutingError("authorized-not-capable")` if any id in `authorized` is not in the capable set for this `(kind, deliverable)` pair.
  4. Throw `WorkerRoutingError("available-not-authorized")` if any id in `available` is not in `authorized`.

- After validation, `routeWorker` computes:
  1. `capable = capableWorkers(registry, { kind, deliverable })`.
  2. If `capable` is empty, return `{ routed: false, refusal: "unroutable", failedSet: "capable" }`.
  3. `authorizedCapable = capable.filter(id => authorized.includes(id))`.
  4. If `authorizedCapable` is empty, return `{ routed: false, refusal: "unroutable", failedSet: "authorized" }`.
  5. `availableAuthorized = authorizedCapable.filter(id => available.includes(id))`.
  6. If `availableAuthorized` is empty, return `{ routed: false, refusal: "unroutable", failedSet: "available" }`.
  7. Return `{ routed: true, worker: registry.find(e => e.worker === availableAuthorized[0])! }` — the first entry by registry order.

## Constraints

- `capableWorkers` preserves registry declaration order in its return value; it does not sort.
- `routeWorker` returns the first id in `availableAuthorized`, which is already in registry order because `capable` is built from `capableWorkers` (registry order) and filtering preserves order.
- This file imports only from `./worker-registry.ts`. It imports no node builtins, no vendor packages, no other domain files.

## Verify

- Add `src/domain/worker-routing.test.ts`.
- Suite name: `"src/domain/worker-routing"`.
- Import `workerRegistry` from `./worker-registry.ts`.
- Assert `capableWorkers(workerRegistry, { kind: "task", deliverable: "implementation" })` deep-equals `["claude@1", "opencode@1"]`.
- Assert `capableWorkers(workerRegistry, { kind: "initiative", deliverable: "expansion" })` deep-equals `[]`.
- Assert `capableWorkers(workerRegistry, { kind: "objective", deliverable: "expansion" })` deep-equals `[]`.
- Assert routing `(kind: "initiative", deliverable: "expansion", authorized: [], available: [])` returns `{ routed: false, refusal: "unroutable", failedSet: "capable" }` (full object, deep equal).
- Assert routing `(kind: "task", deliverable: "implementation", authorized: [], available: [])` returns `{ routed: false, refusal: "unroutable", failedSet: "authorized" }` (full object, deep equal).
- Assert routing `(kind: "task", deliverable: "implementation", authorized: ["claude@1"], available: [])` returns `{ routed: false, refusal: "unroutable", failedSet: "available" }` (full object, deep equal).
- Assert routing `(kind: "task", deliverable: "implementation", authorized: ["claude@1", "opencode@1"], available: ["claude@1", "opencode@1"])` returns `{ routed: true, worker: workerRegistry[0] }`, asserted by `result.routed === true && result.worker.worker === "claude@1"`.
- Assert routing `(kind: "task", deliverable: "implementation", authorized: ["opencode@1"], available: ["opencode@1"])` returns `routed: true` with `worker.worker === "opencode@1"` (the earlier capable entry is absent from `authorized`).
- Assert `routeWorker({ registry: workerRegistry, kind: "task", deliverable: "implementation", authorized: ["unknown@1"], available: [] })` throws `WorkerRoutingError` with `code === "worker-unknown-id"`.
- Assert `routeWorker({ ..., authorized: ["claude@1", "claude@1"], available: [] })` throws `WorkerRoutingError` with `code === "worker-duplicate-id"`.
- Assert `routeWorker({ registry: workerRegistry, kind: "objective", deliverable: "expansion", authorized: ["claude@1"], available: [] })` throws `WorkerRoutingError` with `code === "authorized-not-capable"`. No registry entry declares `"expansion"` in `deliverables`, so capable is `[]` and `"claude@1"` is outside the capable set. The pair `(objective, expansion)` is legal per EPIC 047, so the case exercises routing and not pair legality.
- Assert `routeWorker({ ..., authorized: ["claude@1"], available: ["opencode@1"] })` throws `WorkerRoutingError` with `code === "available-not-authorized"`.
- Assert precedence: routing `{ kind: "objective", deliverable: "expansion", authorized: ["unknown@1"], available: [] }` throws `code === "worker-unknown-id"` (unknown-id check runs before authorized-not-capable check, so the unknown id wins).
- Assert `routeWorker({ kind: "objective", deliverable: "implementation", authorized: ["claude@1"], available: ["claude@1"] })` returns `{ routed: true, worker: workerRegistry[0] }`.
- Run: `node --test src/domain/worker-routing.test.ts`
- Proof: `PASS EPIC-048` line `src/domain/worker-routing.test.ts`

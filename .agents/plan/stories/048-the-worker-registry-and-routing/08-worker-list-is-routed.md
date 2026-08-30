# Story 8 — `worker.list` is routed

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 2, Story 4

## Change

- Edit `src/http/contract/execution.ts` lines 239–245. Replace the `worker.list` entry:
  - Change `status: "stubbed"` to `status: "routed"`.
  - Add `response` schema. Export `workerListItem` (the per-entry zod object) and `workerListResponse` (the wrapper) as named exports from `src/http/contract/execution.ts`:
    ```ts
    export const workerListItem = z.object({
      worker: z.string(),
      driver: z.enum(["internal", "external"]),
      agents: z.array(z.string()),
      claims: z.array(z.string()),
      deliverables: z.array(z.string()),
      harness: z.string().nullable(),
      metadata: z.object({
        composition: z.enum(["single", "composed", "self-managed"]),
      }),
    });
    export const workerListResponse = z.object({
      workers: z.array(workerListItem),
    });
    ```
    Set `response: workerListResponse` on the operation.
  - Add `errors: { ...baselineErrors }` (match the `errors` field of the adjacent `node.claim` operation at `src/http/contract/execution.ts:266`).
  - Add `examples: [{ id: "claude@1-list", request: {}, response: { workers: [{ worker: "claude@1", driver: "external", agents: [], claims: ["objective", "task"], deliverables: ["test", "implementation", "review"], harness: "claude-code", metadata: { composition: "self-managed" } }] } }]` — one exact example entry matching the registry.

- Add `src/queries/worker/list-workers.ts`. Export:
  - `WorkerListItem` type — `z.infer<typeof workerListItem>` imported from `src/http/contract/execution.ts`.
  - `ListWorkersDependencies` type — `Readonly<Record<string, never>>` (no dependencies; the registry is a module-level import).
  - `ListWorkersInput` type — `Readonly<Record<string, never>>`.
  - `listWorkers(_dependencies: ListWorkersDependencies, _input: ListWorkersInput): readonly WorkerListItem[]` — maps `workerRegistry` to the response shape in registry declaration order. The `metadata.composition` read in this function is one of the three permitted sites (covered by the lint exemption in Story 4).

- Add `src/http/server/worker/` directory. Add `src/http/server/worker/list-workers.ts`. Export `listWorkerHandler(dependencies: ListWorkerHandlerDependencies): Handler` following the pattern of `src/http/server/node/list-node.ts`. Dependencies: `{ listWorkers: (input: ListWorkersInput) => readonly WorkerListItem[] }`. Returns `{ kind: "json", status: 200, body: { workers: results } }`.

- Edit `src/main.ts` in the `handlers` object (lines 382–677). Add the `"worker.list"` entry:
  ```ts
  "worker.list": listWorkerHandler({
    listWorkers: (input) => listWorkers({}, input),
  }),
  ```
  Import `listWorkers` from `./queries/worker/list-workers.ts` and `listWorkerHandler` from `./http/server/worker/list-workers.ts`.

## Constraints

- The `listWorkers` function maps `workerRegistry` in its declaration order; it does not sort or filter.
- The `worker` field of the response entry holds the worker id string, not renamed to `id`.
- The `metadata.composition` read inside `listWorkers` is permitted by the lint exemption in Story 4 (`src/queries/worker/list-workers.ts` is one of the three allowed files).

## Verify

- Add `src/queries/worker/list-workers.test.ts`.
  - Suite name: `"src/queries/worker/list-workers"`.
  - Assert `listWorkers({}, {})` deep-equals the exact two-entry array:
    ```
    [
      { worker: "claude@1", driver: "external", agents: [], claims: ["objective", "task"], deliverables: ["test", "implementation", "review"], harness: "claude-code", metadata: { composition: "self-managed" } },
      { worker: "opencode@1", driver: "external", agents: [], claims: ["objective", "task"], deliverables: ["test", "implementation", "review"], harness: "opencode", metadata: { composition: "self-managed" } },
    ]
    ```
  - Assert `workerListResponse.parse({ workers: listWorkers({}, {}) })` does not throw (the full response shape validates).
- Add an integration case to `src/http/server/app.test.ts` asserting `GET /v1/worker` with a valid auth token returns `200` and the response body `workers[0].worker === "claude@1"` and `workers[1].worker === "opencode@1"`. Assert the route no longer answers `501`.
- `pnpm run verify` exits 0.
- Run: `node --test src/queries/worker/list-workers.test.ts`
- Proof: `PASS EPIC-048` lines `src/queries/worker/list-workers.test.ts` and the integration assertion.

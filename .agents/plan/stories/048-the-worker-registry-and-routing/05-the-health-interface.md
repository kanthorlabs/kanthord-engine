# Story 5 — The health interface

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`

## Change

- Add `src/services/worker-health/index.ts`. Export:
  - `WorkerInstance` type — `Readonly<{ worker: string; instanceId: string }>`.
  - `WorkerHealthErrorCode` type — `"not-implemented"`.
  - `WorkerHealthError extends Error` with `readonly code: WorkerHealthErrorCode`. Constructor: `(code: WorkerHealthErrorCode, message: string)`.
  - `WorkerHealth` interface — one method: `check(instance: WorkerInstance): Promise<{ available: boolean; reason: string | null }>`.
  - Mirror the structure of `src/services/agent/index.ts` exactly: export the error class and the interface from the same file.

- Add `src/services/worker-health/not-implemented.ts`. Export `NotImplementedWorkerHealth implements WorkerHealth`. Its `check` method: `void instance; throw new WorkerHealthError("not-implemented", "the worker health service is not implemented");`. Mirror `src/services/agent/not-implemented.ts` (lines 1–16) exactly in structure.

## Constraints

- `check` throws synchronously (the `void instance` line runs before any `async` suspension). Mirror the pattern of `NotImplementedAgent.invoke` at `src/services/agent/not-implemented.ts:10-14`.
- `src/services/worker-health/not-implemented.ts` imports only from `./index.ts`.
- Do not add `WorkerInstance` or `WorkerHealth` to `src/domain/`; both live in the service interface file.

## Verify

- Add `src/services/worker-health/not-implemented.test.ts`.
- Suite name: `"src/services/worker-health/not-implemented"`.
- Assert `new NotImplementedWorkerHealth().check({ worker: "claude@1", instanceId: "i1" })` throws `WorkerHealthError` with `code === "not-implemented"`. Use `assert.throws` with a predicate function that checks `e instanceof WorkerHealthError && e.code === "not-implemented"`.
- Run: `node --test src/services/worker-health/not-implemented.test.ts`
- Proof: `PASS EPIC-048` line `src/services/worker-health/not-implemented.test.ts`

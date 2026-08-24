# Story 10 — The daemon constructs the adapter and reports it

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 2, Story 3, Story 7.

## Change

- In `src/main.ts`, add imports for `PiAi` from `./services/model/pi-ai.ts`, `createPiAiModels` from `./services/model/pi-ai-models.ts`, and `SystemDeadline` from `./services/clock/system-deadline.ts`.
- In the `serve` action, move the `reporters` array (`src/main.ts:200-208`) to below the `crypto` construction (`src/main.ts:209-212`), because `PiAi` takes `crypto` and `reporters` must name `model`.
- After `crypto`, construct `const model = new PiAi({ crypto, clock, deadline: new SystemDeadline(), models: createPiAiModels() });`.
- Build `reporters` after that construction, with the existing `storage` entry unchanged plus `{ name: "model", probe: (): DependencyStatus => model.probe() }`.

## Constraints

- `src/main.ts` is the only file that names `PiAi`, per `AGENTS.md`.
- Keep the `storage` reporter body exactly as it is (`storage.ping(); return "ok";`).
- Add no entry to `handlers`. No phase-2 operation is a bare model call, and no route moves to `routed`.
- Change no contract file and no schema. `systemHealthResponse` types `name` as `z.string().min(1)` (`src/http/contract/system.ts:18-26`), not an enum, and `system.health` is already `routed` (`src/http/contract/system.ts:140-148`).
- Do not change `src/queries/system/read-health.ts`. It already sorts lines bytewise by name (`:32-34`) and turns a throwing probe into `"failed"` (`:25-29`), so `model` precedes `storage` with no edit.
- `readHealth` degrades only on `"failed"`, so a healthy daemon still answers `status: "ok"`.

## Verify

- In `src/services/model/pi-ai.test.ts`, add tests asserting:
  - `probe()` returns `"ok"` on a `PiAi` built over `createPiAiModels()`.
  - `probe()` returns `"failed"` on a `PiAi` built over `createModels({ authContext: { env: async () => undefined, fileExists: async () => false } })` with no registered provider.
- In `src/main.test.ts`, add one test named `the health route reports the model and storage dependencies`, which calls `call(clientDependencies(), { operationId: "system.health" })` against the daemon started by the existing `before` hook (`src/main.test.ts:152-170`) and asserts `result.status === 200` and `result.body` deep-equal to `{ status: "ok", dependencies: [{ name: "model", status: "ok" }, { name: "storage", status: "ok" }] }`.
- Run `node --test --test-timeout=60000 src/main.test.ts src/services/model/pi-ai.test.ts`; it exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-102` for `src/main.test.ts`, and Hermetic coverage lines 76 and 78.

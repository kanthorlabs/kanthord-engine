# EPIC 023 — Version compatibility policy — stories

Epic: `.agents/plan/epics/023-version-compatibility-policy.md`
Prereq: EPIC 022 (sequence order). EPIC 018 supplies `node.claim`, `node.heartbeat` and `node.release`; EPIC 019 supplies `node.report`; EPIC 022 supplies `project.nodes` and `project.graph`. All six are `routed` before this epic starts.

`docs/proposal/api/README.md` states the `/v1` compatibility policy, and `GET /v1/health` returns `version` and `capabilities`, so a client asks the daemon what it can do instead of comparing two version strings.

## Dispatch order

`01`, `02`, `03`, `04`, `05`.

- **1 and 2 are independently green.** `npm run verify` exits 0 at the close of each.
- **3, 4 and 5 are one coupled block.** Take no `npm run verify` gate between them. The red set moves in two steps, and neither story closes it alone:
  - After Story 3, `version` and `capabilities` are required members of `systemHealthResponse`, so the `safeParse` case of `src/queries/system/read-health.test.ts` and the `parse` case of `src/http/server/system/health.test.ts` fail. `src/http/contract/coverage.test.ts` also fails, because the reviewed fixture in `src/http/contract/field-decisions.fixture.ts` enumerates every registry field and now misses two rows.
  - After Story 4, those files are repaired, and `src/main.ts:245,255` fails the typecheck because `ReadHealthDependencies` now has two required members.
  - Story 5 repairs the composition root and closes the block. `src/services/home-lock/startup.test.ts` fails until that point: it deep-equals the live daemon's `/v1/health` body, so it turns red the moment the composition root supplies the two members, and not before.
- **A response-shape change has a red set the compiler cannot see.** A body-shape consumer names no symbol from the query and no schema label, so no grep finds it reliably. `npm run verify` runs `npm test`, and that full suite at the close of the block is the only exact answer. Story 4 carries the two greps that give a head start, and records that they are not a completeness proof.
- Story 2 precedes Story 3, because `system.ts` imports `capabilityName` from `capability.ts`.
- Story 5 is last; it runs the whole Proof block.

## Stories

- 1 — the proposal states the policy → `01-proposal-states-the-policy.md`
- 2 — the capability map, the zod enum and the derivation → `02-capability-map-and-derivation.md`
- 3 — `systemHealthResponse`, its example and the field-decision rows → `03-health-response-carries-them.md`
- 4 — `readHealth` gains two injected values, and the handler stays a pass-through → `04-query-and-handler.md`
- 5 — the composition root and `src/main.capability.test.ts` → `05-composition-root-and-acceptance.md`

The EPIC lists six Story bullets. The sixth — `023-version-compatibility-policy.md:181-184`, the `kanthord-apps` commit — is a commit in the client repository, and the EPIC already records it as an Open item rather than a story. It has no file here. **The five stories therefore cannot close the EPIC**: `023-version-compatibility-policy.md:246-248` says the epic does not close before that commit lands. `/work` reports the block green; a human closes the epic after the client commit.

Story 1 also edits `docs/proposal/api/system.md`, which the EPIC bullet does not name. The `## system.health` section restates the response body and states that the daemon version is on `system.status`; both become false when the two members land.

## Facts (needed for implementation)

- **`capability.ts` must not import `registry.ts`.** `registry.ts:23` imports `system.ts`, and Story 3 makes `system.ts` import `capability.ts`. `system.ts` reads `capabilityName` at module initialization, so the cycle `capability -> registry -> system -> capability` is a temporal-dead-zone `ReferenceError` at daemon start, not a style problem. `declaredCapabilities` therefore takes `readonly Operation[]` as an argument, and `src/main.ts` passes `registry`. `operation.ts` is a leaf: it imports only `zod`, `domain/actor.ts`, `errors.ts` and `path.ts`.
  **This changes the D5 signature.** `023-version-compatibility-policy.md:135,143` writes `declaredCapabilities()` with no argument. Amend the EPIC before `/work` starts, or accept the argument form as a recorded deviation.
- **`src/http/server/start.test.ts:92`** calls `readHealth({ reporters })` in its own handler map. It is the one red site outside `read-health.test.ts`, `health.test.ts` and `main.ts`, and neither the EPIC nor its Proof block names it. Story 4 edits it.
- **A cited line number is the current tree.** EPICs 018 to 022 land first and shift many of them. The symbol name governs; when a line number and a symbol disagree, follow the symbol.
- **`Operation`** — `src/http/contract/operation.ts:33-49`. The lifecycle field is `status: "routed" | "stubbed"`; there is no `lifecycle` field. `"deferred"` exists in `statusValues` at `:18` but not in the `Operation` type.
- **`findOperation`** — `src/http/contract/registry.ts:41-43`: `findOperation(operationId: string): Operation | undefined`.
- **`registry`** — `src/http/contract/registry.ts:25`, already sorted bytewise by `operationId`.
- **`system.health`** — `src/http/contract/system.ts:139-149`, `allowedActors: ["human", "harness"]`. **`system.status`** — `:162-171`, `allowedActors: ["human"]`. Neither actor set changes in this epic.
- **`systemHealthResponse`** is `src/http/contract/system.ts:18-26`; `systemHealthExamples` is `:77-88`. `KANTHORD_VERSION` is already imported at `:6`.
- **`KANTHORD_VERSION`** — `src/domain/version.ts:1`, `"27.8.1"`.
- **Field decisions are derived and exact.** `src/http/contract/coverage.test.ts:209-305` walks every `query`, `request` and `response` of the whole registry, sorts bytewise at `:301-303`, and `assert.deepEqual`s against `src/http/contract/field-decisions.fixture.ts`. `walk` emits no row for an array's `items` (`:252-254`, `emit: false`), so `z.array(capabilityName)` adds exactly one row. `system.health` rows are `:383-386`.
- **Count literals move with the prior epics.** `src/http/contract/parity.test.ts:16` and `:24`, and `src/http/contract/example.test.ts:16-17`, hold values EPICs 018 to 022 change. This epic adds no operation, so every one of them stays at whatever value it holds when the block starts. Do not restate a number.
- **`ReadHealthResult`** — `src/queries/system/read-health.ts:18`, today `= HealthResult`. `HealthResult` is `src/domain/health.ts:11-14`.
- **`readStatus` calls `readHealth`.** `src/main.ts:255` binds `health: () => readHealth({ reporters })`, and `ReadStatusDependencies.health` is `() => HealthResult` at `src/queries/system/read-status.ts:8`. The widened `ReadHealthResult` is assignable, so `read-status.ts` needs no edit — but both `src/main.ts` call sites need the two new dependency members.
- **`queries/` cannot import `http/contract/`.** `eslint.config.js:276-300` restricts `src/queries/**`, and the `boundaries` policy at `:193-212` lets `query` reach `domain` and service interfaces only. That is why `capabilities` is injected as `readonly string[]`.
- **`healthHandler`** — `src/http/server/system/health.ts:8-12`: `() => ({ status: 200, body: dependencies.readHealth() })`. It parses nothing and branches on nothing, and it stays that way.
- **`Vary: Origin`** — `src/http/server/origin.ts:37` calls `context.vary("Origin")` in a `finally` block, so it is present with or without an `Origin` request header. `x-kanthord-client` appears server-side only in the CORS allow-list at `src/http/server/preflight.ts:7`, and `src/http/server/dispatch.ts:33-39` copies every header into the handler context without reading one.
- **`launchDaemon`** — `test/helpers/daemon.ts:29`, spawns `src/main.ts serve` with `--config` and `--home`, and `ready()` waits for `"kanthord: ready\n"` on stdout with a 5 s timeout.
- **No raw-response helper exists.** `call` in `src/cli/client.ts` returns a parsed body and no headers. `src/main.capability.test.ts` uses `globalThis.fetch` directly for the byte and header assertions.
- **No `PRAGMA data_version` helper exists.** Open `DatabaseSync(join(home.path, "kanthord.db"))` in the test, as `src/main.test.ts:323-360` does.
- **The human token is the literal `"test-token"`** written by `home.writeConfig`. A harness token comes from `call(…, { operationId: "actor.register", body: { name } })`, as `src/main.test.ts:372-380` does.
- **`actor.register`** is `POST /v1/actor` (`src/http/contract/actor.ts:105-107`), the POST route the `Vary` assertion uses.

# Plan 05: Custody and Worker Service — the refresh lease

## Scope

This plan makes one execution at a time refresh one OAuth revision (decision D14, ruling O2).

Today each execution holds its own copy of the tokens in its execution store (`src/custody/execution-store.ts:27-122`). Two executions that pin one revision can refresh it at once with one refresh token. A provider that rotates refresh tokens then refuses the second refresh, and can end the credential.

The digest rule of the report writes only the first value (`src/custody/handover.ts:194-247`). It acts after the provider call. Design pages name this race a provider constraint today (`custody.impl.md:219-220`).

pi-ai already treats `CredentialStore.modify` as the lock of a refresh. It calls `modify` only for a token that expires within 5 minutes. It checks the expiry again inside the lock (`node_modules/@earendil-works/pi-ai/dist/auth/resolve.js:47-94`).

This plan makes `modify` of the execution store take a lease from the server. The lease reuses the registry of the server-side check refresh (`src/custody/service.ts:1044-1073`).

Out of scope:

- The machine copy. The lease covers every OAuth revision at every placement, so a machine copy needs no extra rule. Plan 03 adds `holder` to the sealed item.
- A lease that survives a server restart. The registry is in memory, as the check refresh registry is.
- The check refresh of the server. Its rules do not change (`llm.impl.md:279-297`).

## Model

Opus at medium effort. The change crosses custody, the Worker Service, the `worker` application and the execution store at every placement.

## Sources

- Root pull request of plan 01: `custody.impl.md` "The credential handover"; `worker-service.impl.md` "The credential handover"; `docs/reference/worker/handover.html`.
- `src/worker/contract.ts:72-76`, `:928`, `:1657-1706` — the handover timeouts, `HandoverRefreshInFlight`, `worker.handover` and `worker.credential`.
- `src/worker/service.ts:288-317`, `:1099-1158` — `refreshInFlight`, `settledBefore` and the handlers of the handover and the report.
- `src/custody/service.ts:570`, `:1044-1073`, `:1187-1260`, `:1393-1430` — the refresh registry, the handover and the report.
- `src/custody/handover.ts:57-69`, `:194-247` — `plainItem` and `applyReport`.
- `src/custody/execution-store.ts:27-129` — the execution store.
- `src/custody/instance-copy.ts:72-93` — `sealedCopyReporter`.
- `src/apps/worker/handover.ts:92-224` — `executionItems`, `retryableRefreshInFlight` and `takeHandover`. `takeHandover` zeroes `keys.handover` after the first envelope (`:190`).
- `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:39-41`, `:76` — `AuthOperationOptions.signal` and `modify`.

## Depends on

The approval of the root pull request of plan 01. Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plan 02 runs at the same time in other files. When plan 02 merges first, rebase on it and regenerate `static/` in task 05.5.

## Provides

- `worker.credential.lease`: `POST /api/worker/credential/lease`, policy `client`, secret mutation, live execution, body `{ execution_id, credential_id }`. The answer is a handover envelope of `{ item, expires_at }`.
- `WorkerErrorCode.CredentialLeaseHeld` (`worker.credential.lease_held`) and `custody.handover.lease_invalid`.
- `itemOfRow(tx, row)` of custody: the one builder of a plain or a sealed handover item. Plan 03 adds `holder` in it.
- An execution store whose `modify` takes the lease and adopts the stored value.

## Tasks

### 05.1 Write the tests of the lease

- Files: `src/custody/handover.test.ts`, `src/custody/execution-store.test.ts`, `src/apps/worker/handover.test.ts`, `src/apps/server/handover-integration.test.ts` (edit)
- Do:
  1. Custody: a lease of a pinned revision answers the stored value and `expires_at` at `now + 30000`.
  2. Custody: a second lease of another execution answers `worker.credential.lease_held` until the first lease ends. A lease of the same execution renews.
  3. Custody: a lease during a check refresh of the revision answers `lease_held`.
  4. Custody: a lease of a revision that the execution does not pin answers `custody.handover.lease_invalid`. A lease of an ended revision answers `credential.revision.revoked`.
  5. Custody: a report of the lease holder ends the lease. A report of another execution keeps it. A lease past `expires_at` lets another execution take a new lease.
  6. Execution store: `modify` calls the lease once, passes the leased value to the pi-ai function, and sends one report.
  7. Execution store: a function that answers `undefined` still sends one report. Two `modify` calls of one store run in order.
  8. Execution store: the store renews the lease before each retry of its report.
  9. Worker application: two executions that pin one OAuth revision and refresh at once make one refresh call. The second execution reads the refreshed value and refreshes nothing.
  10. Worker application: run the test of step 9 at the `server` placement with a plain item and at the `worker` placement with a sealed item.
  11. Worker application: a `lease_held` answer retries with a new key until the lease ends. An abort of the `modify` signal ends the retry.
  12. Worker application: a lease after the first envelope opens with the handover key. `discard()` zeroes the handover key.
- Verify: each edited test file fails on the new tests only, with `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 <file>`.

### 05.2 Declare the operation

- Files: `src/worker/contract.ts`, `src/custody/contract.ts` (edit)
- Do:
  1. Add `"credential.lease"` after `credential` (`src/worker/contract.ts:1683-1706`). Copy its fields.
  2. Set `secret: true`, the output `handoverEnvelopeSchema`, and the body `{ execution_id, credential_id }`.
  3. Add `CredentialLeaseHeld: "worker.credential.lease_held"` to `WorkerErrorCode` (`:928`).
  4. Add `CREDENTIAL_LEASE_MS = 30000` and `CUSTODY_LEASE_INVALID` to `src/custody/contract.ts`.
  5. Add `leasePayloadSchema` (`{ item, expires_at }`) to `src/custody/contract.ts`. `item` is a plain or a sealed handover item.
  6. Add `CredentialLeaseHeld` beside `CredentialRefreshInFlight` (`:638-645`).
- Cite: D14.
- Verify: `pnpm run typecheck`.

### 05.3 Keep the lease in custody

- Files: `src/custody/service.ts`, `src/custody/handover.ts`, `src/worker/service.ts` (edit)
- Do:
  1. Extract `itemOfRow(tx, row)` from `plainItem` (`src/custody/handover.ts:57-69`) and the item of `sealedItem` (`src/custody/service.ts:858-920`). The handover and the lease call it.
  2. Add `leases = new Map<string, { execution_id: string; expires_at: number }>()` beside `refreshes` (`src/custody/service.ts:570`).
  3. Add `lease(tx, identity, claim, credentialId, now)` to `CustodyComponent`. Call `requireRunning`.
  4. Refuse a revision outside `credentials` of the execution and an ended row by decision D14.
  5. Throw `CredentialLeaseHeld` when `refreshes` holds the revision. Throw it also when another execution holds a lease that has not expired.
  6. Set the lease, and seal `{ item: itemOfRow(tx, row), expires_at }` with the handover key.
  7. In `report` (`src/custody/service.ts:1393-1430`), delete the lease of the revision after `applyReport`. Do it only when the execution of the report holds the lease.
  8. In `src/worker/service.ts`, register `workerOperations["credential.lease"]` after the report handler (`:1143-1158`). Map `CredentialLeaseHeld` to 503 `worker.credential.lease_held`.
- Cite: D14.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/handover.test.ts` passes.

### 05.4 Take the lease in the execution store

- Files: `src/custody/execution-store.ts`, `src/custody/instance-copy.ts`, `src/apps/worker/handover.ts` (edit)
- Do:
  1. Add a `lease: (signal?: AbortSignal) => Promise<Credential>` argument to `executionCredentialStore` (`src/custody/execution-store.ts:124-129`).
  2. In `modify` (`:88-106`), call `lease(options?.signal)` inside the queue. Set `#current` and `#reported` to the leased value.
  3. Call the pi-ai function with the leased value. Set `#current` to a changed answer.
  4. Call `#send()` once at the end, also for an unchanged value, so that the report ends the lease.
  5. Before each retry of the report, call `lease()` again to renew the lease. Keep the value of the report.
  6. Add `adopt(sealed, opened)` to the reporter of `sealedCopyReporter` (`src/custody/instance-copy.ts:72-93`). It sets the stored sealed object and the held credential.
  7. In `takeHandover` (`src/apps/worker/handover.ts:137-224`), build the lease function of each view. Call `api.worker["credential.lease"]` with the retry of `retryIndeterminate`. Pass the signal of `modify` to the retry.
  8. Map `worker.credential.lease_held` to an indeterminate result, after the pattern of `retryableRefreshInFlight` (`:123-135`).
  9. Open the lease envelope with the handover key. For a sealed item, open it with the instance key and call `adopt`.
  10. Remove `keys.handover.fill(0)` after the first envelope (`:190`). Zero the handover key in `discard()` and in the error path.
- Cite: D14.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/custody/execution-store.test.ts src/apps/worker/handover.test.ts src/apps/server/handover-integration.test.ts` passes.

### 05.5 Update the CLI page and the OpenAPI document

- Files: `docs/cli/worker.md`, `static/` (edit, generated)
- Do:
  1. In `docs/cli/worker.md` "MCP and repository actions" (`:743`), add `worker.credential.lease` beside the handover and the report. It is an operation outside the CLI inventory.
  2. Add `worker.credential.lease_held` and `custody.handover.lease_invalid` to the error table (`:877`).
  3. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the result.
- Verify: `pnpm exec prettier --check docs/cli/worker.md`; `git status --porcelain static/` prints nothing after the commit.

### 05.E Run the gate

- Do: run the gate row 05 of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

No new row. The tests of task 05.1 steps 9 and 10 drive two executions through the operation registry at two placements.

## Blockers

None.

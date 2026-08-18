# EPIC 021 — Provider contract and default transfer — stories

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`
Prereq: EPIC 020 (sequence order). This epic shares no file with EPICs 014 to 020.

The client generates a provider payload model from the published contract, and a human moves the llm default without removing a registration.

## Dispatch order

Run Story 1, then Story 2, then Story 3, then Story 4, in that order. Each passes the full gate on its own.

Story 2 depends on Story 1: the coverage guard at `src/http/contract/coverage.test.ts:92-134` asserts `additionalProperties: false` on every object node of every registered schema, and a bare `z.object` emits no `additionalProperties` at all, so registering `llmPayload` before it is strict fails the gate.

Story 3 follows Story 2 for ordering only, with no technical dependency: `provider.register` is phase-1 routed and already inside the current example scope, so the widened filter adds `provider.rename`, `provider.remove` and `provider.setDefault` and nothing else. Story 2 is what makes the `provider.register` request example verifiable, by typing `payload`. Run Story 3 second so the corrected `token` example sits under the widened guard from the first run.

Story 4 depends on Story 2: its two handler cases assert the behaviour of the typed request schema.

Then run Stories 5, 6 and 7 as one coupled unit, in that order, with no full gate between them. Story 5 deletes `"default-already-set"` from `SetDefaultProviderRefusal`, which makes the comparison at `src/http/server/credential/refusals.ts:24` a type error until Story 7 deletes that branch. Story 6 has no file of its own; it is the event half of Story 5's clearing loop. Story 7 closes the unit and runs the gate.

Then run Story 8, then Story 9.

Story 10 runs last. D8 is amended, so it is unblocked. It narrows `ids` rather than deleting it: the baseline drops the field and `plan.import` keeps it in its own details schema. It is independent of Stories 1 to 9 and changes no wire response.

## Stories

- 1 — `llmPayload` becomes strict → `01-llm-payload-strict.md`
- 2 — `provider.register` declares its payload per kind → `02-register-payload-per-kind.md`
- 3 — `example.test.ts` validates every published example → `03-example-guard-covers-every-published-example.md`
- 4 — The register handler is untouched → `04-register-handler-untouched.md`
- 5 — `provider.setDefault` transfers → `05-set-default-transfers.md`
- 6 — `provider.defaultUnset` → `06-default-unset-event.md`
- 7 — The refusal map shrinks → `07-refusal-map-and-error-shape-shrink.md`
- 8 — The proposal records the transfer → `08-proposal-records-the-transfer.md`
- 9 — Inherited provider regressions → `09-inherited-provider-regressions.md`
- 10 — `ids` narrows to `plan.import` → `10-ids-narrows-to-plan-import.md`

## Facts (needed for implementation)

- `src/domain/provider-payload.ts:9-14` declares `llmPayload` as a bare `z.object`. `gitHttpBasicPayload:17-24` and `gitSshPayload:26-31` already carry `.strict()`. `gitPayload:33-36` is a `z.discriminatedUnion("transport", …)`.
- `src/http/contract/credential.ts:35-39` declares `providerRegisterRequest` with `payload: z.unknown()`. Its example at line 73 sends `password`, which `gitHttpBasicPayload` refuses, so the published fixture is refused by the daemon it documents.
- `src/http/contract/graph.ts:179-182` is the only top-level discriminated union in the contract today. It proves the outer shape publishes; it has no nested union, so the nested git transport branches need their own assertion.
- `src/http/contract/registry.ts:25-39` sorts the registry bytewise by `operationId`, so any list derived from `registry` is already in that order.
- 39 registry entries carry examples: the 36 phase-1 routed entries other than `blob.show`, plus `provider.remove`, `provider.rename` and `provider.setDefault`. The counts EPIC 018 and EPIC 019 moved are the ones above; re-derive them from `registry` and never from this line if a later epic adds a routed operation. `blob.show` is the only routed entry with no example. No stubbed entry carries examples.
- `scripts/publish-contract.ts:76-96` publishes every entry whose `examples` is defined, whatever its `status`. That is why the example guard scopes on `examples`, not on `status` or `introducedIn`.
- `src/http/contract/field-decisions.fixture.ts` holds 537 rows of the form `<operationId>.<slot>#<pointer> required=… nullable=… enum=…`, and `src/http/contract/coverage.test.ts:9,305` deep-equals a live walk against it. The walk covers the query, request and response slots only, so `error-details.ts` edits do not move a row. Regenerate with `node scripts/field-decisions-probe.mjs --write`; compare with the same command and no flag.
- `src/commands/provider/set-default-provider.ts:98` is the single `clock.now()` call, and lines 99-102 write both `set_default_at` and `updated_at` from it. Line 100 and `src/commands/provider/register-provider.ts:69` are the only two statements in the tree that write `set_default_at`.
- `src/commands/provider/register-provider.ts:61-67` stamps only when no `llm` row exists at all, so `register` cannot create a second holder.
- `src/services/storage/index.ts` declares `Transaction` with `run`, `get` and `all`. `all` returns `readonly unknown[]`.
- `src/services/storage/sqlite.ts:143-150` throws `new StorageError("storage-transaction-failed", "a transaction is already open")` from `assertIdle`. `src/services/storage/connection.ts:35` opens `BEGIN IMMEDIATE` and takes the write lock before the first read.
- `src/services/event/index.ts` declares `append(transaction, input)`, so an event is written inside the command's transaction. `src/domain/event.ts` declares `type: z.string()` and there is no event-type registry to extend.
- `src/commands/provider/remove-provider.ts:48-52` sorts ids with `Buffer.compare` in the command. Match it.
- `src/commands/provider/set-default-provider.test.ts` uses `createMigratedStorage()`, `createMockClock({ start: 1700000000000, step: 1000 })`, `createMockIdGenerator`, a real `AesGcmCrypto` keyed `Buffer.alloc(32, 7)` at version 1, a real `SqliteEventLog`, and local `readProvider` / `readEvents` / `countRows` helpers. Its provider ids are `provider_01HZY8QF3M4N5P6R7S8T9V0W1X` and `provider_01HZY8QF3M4N5P6R7S8T9V0W20`.
- `src/http/server/credential/*.test.ts` builds the app through `createTestApp({ handlers: { "<operationId>": handler } })` from `test/helpers/app.ts` and drives it with a supertest agent. The command is a stub lambda; these tests inspect no database.
- **`ids` is a shared field with a live second producer.** `src/http/contract/error-baseline.ts:5` assigns `invalidRequestDetails.optional()` to the shared `invalid-request` code, and `src/http/server/plan/refusals.ts:33-36` emits `ids` for the three `choice-*` refusals of `importPlan`, built at `src/commands/plan/import-plan.ts:566`. `src/http/contract/error-details.test.ts:359-363` and `src/http/server/plan/refusals.test.ts:133` assert it. Story 10 narrows the field to `plan.import` instead of deleting it.
- **`plan.import` is the whole of the `ids` surface.** `src/http/server/plan/refusals.ts` is imported by exactly one handler, `src/http/server/plan/import-plan.ts:6`; `validate-plan.ts`, `export-plan.ts` and `list-revision.ts` do not import it. So one operation-specific override covers every producer that survives this epic.
- An operation overrides a baseline error code by declaring it after the `...baselineErrors` spread. `src/http/contract/credential.ts` already adds `"binding-in-use"` that way, and no operation overrides `invalid-request` today.
- **The emitted union is `oneOf`, and a literal emits as `{ type: "string", enum: [...] }`.** The EPIC's Hermetic bullet 4 says `anyOf` and `{ const: "llm" }`; both are wrong for the `openapi-3.0` target. `src/http/contract/field-decisions.fixture.ts:64-69` already proves it: `node.create.request#/properties/node/oneOf/0/…` with `enum=initiative`.
- **An unrecognized key reports `path: ["payload"]` and `keys: ["<key>"]`.** The EPIC's Hermetic bullet 2 says `path: ["payload", "<the extra key>"]`; zod reports the issue against the holding object, not the key. For `parsePayload("llm", …)` the resulting `PayloadError.detail` is exactly `'.Unrecognized key: "apikey"'`, leading dot included, because `src/domain/provider-payload.ts:100-105` joins an empty path onto the message.
- `src/commands/provider/set-default-provider.test.ts:113-119` reads events with `SELECT … FROM event` and **no `ORDER BY`**, and the suite mints ids from `createMockIdGenerator`, not the production monotonic factory. Story 5 adds `ORDER BY id ASC` and pins an ascending literal ULID list; every event-order assertion of Stories 5 and 6 depends on both.
- `docs/proposal/api/credential.md:15-22` is the route matrix `src/http/contract/parity.test.ts` reads. No status changes in this epic, so parity is unaffected.

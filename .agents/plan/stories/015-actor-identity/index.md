# EPIC 015 — Actor identity and authorization — stories

Epic: `.agents/plan/epics/015-actor-identity.md`
Prereq: EPIC 014 (sequence order).

A `human` registers a `harness` through a bound `POST /v1/actor`; the harness authenticates with the disclosed token, reads the graph, and is refused every operation its kind does not admit — before the handler runs. The configured bearer token of phase 1 keeps working and resolves to a bootstrap `human` actor.

## Dispatch order

**Every story passes `npm run verify` standing alone. There is no coupled pair and no story that knowingly leaves the gate red.**

`15 → 1 → 3 → 2 → 4 → 5 → 6 → 8 → 7 → 9 → 10 → 12 → 11 → 13 → 14`

- **Story 15 first.** It touches nothing else in the epic — a new pure domain module, the config loader and `config generate`. Landing it first keeps the allow-list change out of the authentication work.
- **Story 1**, then **Story 3**. Story 1 owns the whole vocabulary widening in one change: the domain enum, both field-decision pins and the two `http/contract/event.ts` call sites. Story 3 needs `bootstrapActorId` from Story 1.
- **Stories 2, 4, 5** in that order, each gating on its own. **The EPIC's Story-2 bullet assigns the `tokensMatch` deletion to Story 2; these stories move it to Story 5**, which is the change that removes the last caller. Deleting it in Story 2 would leave `npm run typecheck` red across two dispatched stories, and a "coupled unit" does not make three stories atomic under per-story verification. Story 2 adds the capability, Story 4 adds the resolver that nothing calls yet, Story 5 switches the middleware and deletes the function.
- **Story 6**, then **Story 8**, then **Story 7**. Story 8 precedes Story 7 because `authorize.ts` cannot throw a code the contract does not hold. Story 8 also carries the `src/cli/exit-code.ts` parity edit, without which Story 8 itself would leave the gate red. Story 7 makes `allowedActors` required, so it edits all 54 existing rows in one change.
- **Story 9**, **Story 10**, **Story 12**, **Story 11**, **Story 13**, **Story 14**.
- Story 12 precedes Story 11 for a **product** reason, not a test-setup one: Hermetic coverage line 149 requires a real registered harness token, which only the bound `actor.register` route can mint.
- Story 13 is independent of 9–12 and may move earlier, but it must follow Story 5.

## Proof ownership

The EPIC's `Proof` block is one `node --test <paths> && echo "PASS EPIC-015"`. A named path that does not exist makes `node --test` exit non-zero, so **the Proof is satisfied only if every path it names exists at the epic's close**. Each is created or already exists:

| Proof path                                                       | Owner                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/domain/actor.test.ts`                                       | Story 1 (new)                                                           |
| `src/domain/identity.test.ts`, `src/domain/event.test.ts`        | exist; Story 1 edits                                                    |
| `src/domain/host-authority.test.ts`                              | Story 15 (new)                                                          |
| `src/services/storage/migration-0005-actor.test.ts`              | Story 3 (new)                                                           |
| `src/services/secret/node-crypto.test.ts`                        | Story 2 (new)                                                           |
| `src/commands/actor/**/*.test.ts`                                | Story 10 (new)                                                          |
| `src/commands/startup/ensure-bootstrap-actor.test.ts`            | Story 6 (new)                                                           |
| `src/queries/actor/**/*.test.ts`                                 | Story 4 and Story 10 (new)                                              |
| `src/http/contract/**/*.test.ts`                                 | exist; Story 7 extends `registry.test.ts`, Story 9 adds `actor.test.ts` |
| `src/http/server/auth.test.ts`                                   | exists; Story 5 edits                                                   |
| `src/http/server/authorize.test.ts`                              | Story 7 (new)                                                           |
| `src/http/server/idempotency-key.test.ts`, `idempotency.test.ts` | exist; Story 13 edits                                                   |
| `src/http/server/actor/**/*.test.ts`                             | Story 10 and Story 12 (new)                                             |
| `src/services/config/convict.test.ts`, `refusals.test.ts`        | exist; Story 15 edits                                                   |
| `src/cli/actor/**/*.test.ts`                                     | Story 14 (new)                                                          |
| `src/cli/config/generate.test.ts`                                | exists; Story 15 edits                                                  |

Three test files these stories create are **outside** the Proof block and are reached by the `Gates:` line (`npm run verify`) only: `src/services/event/index.test.ts` (Story 11), `src/cli/secret-file.test.ts` (Story 14) and every count-pin edit listed below. That is expected — the Proof is a subset of the gate, not a replacement for it.

## Stories

- 1 — Actor vocabulary in `domain/` → `01-actor-vocabulary.md`
- 2 — The `secret` service capability → `02-secret-service.md`
- 3 — Migration 0005, the actor table and the event widening → `03-migration-0005-actor.md`
- 4 — `resolveActor`, the one authentication query → `04-resolve-actor.md`
- 5 — The auth path keeps its refusals and gains an actor → `05-auth-path-actor.md`
- 6 — The bootstrap actor and the startup order → `06-bootstrap-actor-startup.md`
- 7 — Authorization as registry data, under one rule → `07-authorization-registry.md`
- 8 — `403 actor-forbidden` → `08-actor-forbidden-error.md`
- 9 — The actor routes → `09-actor-routes.md`
- 10 — The actor commands and handlers → `10-actor-commands-handlers.md`
- 11 — Event attribution through the authenticated actor → `11-event-attribution.md`
- 12 — The application binding → `12-application-binding.md`
- 13 — The idempotency record key carries the actor → `13-idempotency-actor-key.md`
- 14 — The CLI actor commands, and the file capture → `14-cli-actor-commands.md`
- 15 — Derived `http.allowedHosts` and the generated configuration → `15-derived-allowed-hosts.md`

## Facts (needed for implementation)

Every fact below was read from the tree, not inferred. Where it corrects the EPIC, that is stated.

### Corrections to the EPIC text

- **`src/http/contract/provider.ts` does not exist.** The `provider.*` rows live in `src/http/contract/credential.ts`, and their proposal document is `docs/proposal/api/credential.md`. There is no `docs/proposal/api/provider.md`. Story 9 mirrors `credential.ts`.
- **`src/http/server/provider/` does not exist.** The provider handlers live in `src/http/server/credential/`. Story 10 mirrors them.
- **`src/http/contract/authorization.test.ts` belongs to EPIC 020, not to this epic.** `015-actor-identity.md:39` calls it "the authorization inventory of `src/http/contract/authorization.test.ts`", which reads as though 015 creates it — but `020-wiring-and-scenarios.md:48` calls it "a new" file, and `017-per-node-graph-write.md:90` states twice that EPIC 015's nine-name harness assertion lives **in `src/http/contract/registry.test.ts`** and that "the registry-wide total belongs to EPIC 020 alone, which owns `src/http/contract/authorization.test.ts`". EPIC 015's own normative text (`:62`, hermetic `:125-126`) names no file. **Story 7 therefore extends `registry.test.ts` and creates no new file**, which is the only reading consistent with all three epics and the one that makes EPIC 017's stated obligation executable: 017 edits the `harnessOperations` constant Story 7 exports from `registry.test.ts`.
- **The `recordKey` separator is U+FFFD, not U+241F (`␟`).** `src/http/server/idempotency-key.ts:73` uses U+FFFD and `idempotency-key.test.ts:266,314` pin it. The EPIC writes `␟`. **Checked against the behavioural authority:** `docs/proposal/api/README.md` specifies the idempotency policies, the join and replay semantics and the `plan.import` key rule, and it mandates **no separator character** — verified by grep. The separator is therefore an implementation detail, not proposal-normative, so existing code governs and the EPIC's `␟` is loose prose. Story 13 keeps U+FFFD; changing it would break pinned tests for no product gain.
- **`src/main.ts:179-194` holds four `{ actor: "daemon" }` bindings, not eight.** The eight bindings are `actor: settings.actor`, at `:234`, `:239`, `:244`, `:248`, `:276`, `:288`, `:302`, `:335`. Only the EPIC's arithmetic is wrong, not its instruction: Story 11 removes the eight `settings.actor` bindings and leaves every `"daemon"` binding untouched, which is exactly what the EPIC intends.
- **`system.health`'s response schema is at `src/http/contract/system.ts:18-26`; its operation row is at `:139-148`.** `system.status`'s response schema is at `:39-75` and its row at `:160-168`.
- **`errors.test.ts` already holds an ordered key list** at `:28-31` (`"pins the twenty-two codes in table order"`). Story 8 adds the member and drops the count from the title; it does not author a new mechanism.
- There is **no shared 501 handler file.** Both `501` paths are inline in `src/http/server/dispatch.ts:17-31`. Because `authorize` runs before `dispatch`, a stubbed route answers `403` to a disallowed actor and `501` otherwise, with no stub-handler edit.

### Decisions taken beyond the EPIC text

Each is stated in its story, and each is **derived from an existing mechanism or precedent rather than chosen**. No open question remains for the human.

- **The empty-configured-token mode resolves inside `resolveActor` (Story 4, step 0).** The EPIC says that branch "resolves to the bootstrap actor", but a resolver that returns `null` for an empty presented value cannot serve it. Rather than add a second identity dependency to `authMiddleware` — which would put identity policy in two places and risk divergent handling of a revoked or absent bootstrap row — `resolveActor` owns the mode. `authMiddleware` therefore has exactly **one** resolution path.
- **Migration 0005 is rename-first** (Story 3), because `proposalStatements` compares the `CREATE` statement against the proposal fence, so the statement must carry the final name `event`.
- **The bootstrap id is a frozen SQL literal** in the migration (Story 3). An applied migration must never change its bytes, so the test asserts the current domain constant still equals the frozen literal; a divergence is a defect in the domain change.
- **`createStorageAtVersion(version)` is a new test helper** (Story 3). Hermetic line 106 needs a version-4 database and no helper offers one. The story pins its exact implementation, so nothing is left to the implementer; an inline `migrations.filter(...)` would work equally and is not chosen because a named helper matches the convention of `test/helpers/database.ts`.
- **`src/domain/actor-view.ts`** (Story 1), because `commands/` and `queries/` cannot import `src/http/contract/` and need a return type in `domain/`. It mirrors `provider-view.ts` and its fields are enumerated in the story.
- **Lease fencing is vacuous, not implemented** (Story 10). `leasesFenced` is `0` because no actor can own a lease before EPIC 018 adds `lease.owner_kind`. The story states this is a recorded count and not the rule's implementation.
- **`404` for an unknown actor id** (Story 10), derived from unanimous precedent: every id-addressed operation in the repository already answers `404`. `provider.rename` is the exact parallel — refusals `"not-found" | "name-taken"` (`src/commands/provider/rename-provider.ts:25`) mapped to `404` and `400` respectively (`src/http/server/credential/refusals.ts:21-22`). Message shape `` `no actor ${id}` ``. Answering `400` would make the actor routes the only id-addressed operations that disagree with every sibling.
- **Exit code `132` for `actor-forbidden`** (Story 8), uniquely determined by the allocation all 22 existing codes obey with no gap: each status owns a base (400→110, 401→120, 403→130, 404→140, 409→150, 422→160, 500→210, 501→220, 503→230) and its codes take consecutive integers from that base in `errorStatuses` insertion order. `actor-forbidden` enters the 403 group at position 3, so `130 + 2 = 132`. Story 8 replaces the coarse band assertion at `src/cli/exit-code.test.ts:76-82` with one that encodes this rule, so no later epic can append an arbitrary number.
- **The authorization assertions extend `src/http/contract/registry.test.ts`** (Story 7) and create no new file, per `017-per-node-graph-write.md:90`. See the correction above.

### Pins the EPIC does not name, and the story that moves each

Nine **files** carry a pinned count, list or test title that these stories move. Several files carry more than one assertion each; the story that owns the file names every one.

- `src/domain/identity.test.ts:17-27` — three assertions and three titles pin **17** kinds → 18. Story 1.
- `src/domain/rows.test.ts:10-14` — pins **19** table names and the sorted list → 20, `actor` first. Story 1.
- `src/domain/layout.test.ts:101-124` — an exact 15-entry service-directory array and the title `fourteen capabilities plus home-lock` → 16 entries, `fifteen`. Story 2.
- `src/services/storage/migration-0004-event-indexes.test.ts:35-49` — pins the version array `[1,2,3,4]` and the four names → five. Story 3.
- `src/services/storage/migration-0003-execution-and-journal.test.ts:464` — `the table inventory maps to the nineteen names in order` → twenty; and `:500` `all eighteen product tables are STRICT` → nineteen. Story 3.
- `src/http/contract/coverage.test.ts:332` — `scoped.length === 23`, the phase-1 routed operations other than `blob.show` that carry a response schema → **28**. Story 9.
- `src/cli/exit-code.ts` and `src/cli/exit-code.test.ts:14-36,51,61` — `exitCodes` keys must equal `errorStatuses` keys bytewise (`:44-48`), and a 4xx code must land in 100–199 (`:77-82`). `actor-forbidden: 132`. Story 8. **The EPIC names neither file.**
- `src/cli/parity.test.ts:74-80,112-122` — 15 paths → 20; 12 calling entries → 17; 17 distinct ids → 22. Story 14.

### Greenfield gaps

- **No migration rebuilds a table today.** Migrations 0001–0004 only `CREATE TABLE ... STRICT` and `CREATE INDEX`. Story 3 writes the first rename/insert-select/drop sequence, and it uses **rename-first** so the new table's `CREATE` statement carries the final name `event` and stays comparable with `docs/proposal/database/event.md`.
- **No helper migrates to a version below the head.** `createMigratedStorage()` at `test/helpers/database.ts:35-50` always runs the full array. Story 3 adds `createStorageAtVersion(version)`, which Hermetic coverage line 106 requires.
- `src/services/secret/`, `src/domain/actor.ts`, `src/domain/actor-view.ts`, `src/domain/host-authority.ts`, `src/commands/actor/`, `src/queries/actor/`, `src/http/server/actor/`, `src/http/contract/actor.ts`, `src/cli/actor/`, `src/cli/secret-file.ts`, `docs/proposal/api/actor.md` and `docs/proposal/database/actor.md` are all new.
- `src/domain/actor-view.ts` is a **deliberate addition** beyond the EPIC's story text. Commands and queries cannot import `src/http/contract/`, so they need a return type in `domain/`. It mirrors `src/domain/provider-view.ts`. Story 1.

### Mechanisms and conventions

- `Migration` is `{ version: number; name: string; statements: readonly string[] }` (`src/services/storage/migration.ts`) — raw SQL only, no function. Registration is appending to the array in `src/services/storage/migrations.ts:7-12`. Head version is **4**; naming is `migration-000N-<slug>.ts`.
- `runInTransaction` (`src/services/storage/sqlite.ts:77-85`) runs one migration's statements **plus its `migration` row** inside one `BEGIN IMMEDIATE` (`src/services/storage/connection.ts:35`), so a mid-migration failure rolls back everything including the version record.
- `PRAGMA foreign_keys = ON` (`src/services/storage/connection.ts:8`).
- `proposalStatements(table)` (`test/helpers/proposal.ts:8-27`) reads the **first** ` ```sql ` fence of `docs/proposal/database/<table>.md`, strips `--` comments, splits on `;` and collapses whitespace. Comparison is **normalize-then-`deepEqual`**, not bytewise, so inline DDL comments in the document are free. The normalizer to copy is at `migration-0003-execution-and-journal.test.ts:402-407`.
- `readRouteMatrix` (`test/helpers/proposal.ts:57`) reads every `.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, so a new `actor.md` enters parity with no helper change.
- Registry counts today: **54** operations, **27** routed, **27** stubbed, **4** deferred proposal rows. After Story 9: **59**, **32** routed, **27** stubbed, **4** deferred. `registry` is sorted bytewise by `operationId` after the spread at `src/http/contract/registry.ts:24-37`, so spread position is irrelevant.
- `Operation` has **no** `phase` or `lifecycle` field. The phase is `introducedIn`; the lifecycle is `status`, narrowed to `"routed" | "stubbed"`.
- Middleware order (`src/http/server/app.ts:70-90`): `envelope → origin → host → preflight → auth → route → bodyParserForHandled → idempotency → dispatch`. Story 7 inserts `authorize` between `route` and `bodyParserForHandled`.
- `registryFaults` (`src/http/contract/registry.ts`) fails the build on a plural resource segment, a free-form segment, an ambiguous path, a `query` on a `stubbed` row, and a `replayable` without `idempotency: "memory"`.
- `registry.test.ts:639-644` asserts `replayable` deep-equals `[200]` on **every** `memory` entry.
- `buildErrorEnvelope` (`src/http/contract/errors.ts:40-60`) walks `Object.keys(errorStatuses)` in **insertion order**, which fixes the member order of every operation's discriminated union and therefore the bytes of the generated OpenAPI document. This is why Story 8's insert position is contract.
- `coverage.test.ts:190-287` walks every authored schema with `z.toJSONSchema(schema, { target: "openapi-3.0", io })` and compares one row per field with `src/http/contract/field-decisions.fixture.ts`. Story 9 reuses that walker for the token-field assertion; the way to get the fixture rows right is to run the test once and insert exactly the rows the diff reports.
- Test convention for a command or query: **real SQLite** through `createMigratedStorage()`, with `createMockClock` (`test/helpers/clock.ts:5`) and `createMockIdGenerator` faked; storage is never faked. Template: `src/commands/provider/register-provider.test.ts`.
- Handler convention: a factory `xHandler(dependencies) => Handler`, `schema.safeParse(context.body)`, one command or query call, `{ status, body }` returned, and every command error funnelled through a per-domain `toHttpError`. Templates: `src/http/server/credential/register-provider.ts` (POST) and `list-provider.ts` (GET).
- CLI convention: `harness()` in `src/cli/repository/register.test.ts:82-127` — a real `Command`, a recording `client.call`, accumulating `stdout`/`stderr`, and `fail`/`exit` counters. `src/cli/db/status.ts` is the GET template, `src/cli/credential/register.ts` the POST template. There is no `src/cli/provider/`.
- `test/helpers/app.ts` defaults `token` to `"test-token"` and pre-sets `Host` and `Authorization` on every convenience method. Story 5 adds `resolveActor` and `bootstrapActor` overrides plus an exported `BOOTSTRAP_ACTOR_FIXTURE` that Stories 7, 10 and 13 reuse.
- `tableCounts(storage)` (`test/helpers/database.ts:52-68`) reads every table of `src/domain/rows.ts` sorted bytewise — the tool for every "byte-identical before and after" assertion.
- `eslint.config.js:230-247` bans `node:*`, `ulid`, `yaml` and every vendor package in `src/domain/`. `:208-229` bans only `node:child_process` outside `src/services/git/launcher.ts`, so `src/services/secret/node-crypto.ts` may import `node:crypto`. `:250-274` additionally bans `node:sqlite` and `node:fs` in `commands/` and `queries/`.
- `src/domain/layout.test.ts:50-66` scans every non-test file directly under `src/domain/` for `Date.now(`, `new Date(` and `Math.random(`. `:159-175` forbids the string `implements ` in every `src/services/*/index.ts`. `:144-157` requires `not-implemented.ts` for `agent`, `verify` and `lease` only, so the new `secret` capability needs none.
- `npm run verify` is `typecheck → node --test --test-timeout=60000 → eslint . → node scripts/verify-db-status.ts`. **No OpenAPI emit runs in `verify`**; `contract:publish` is separate. The final step migrates a real home and calls `db status` over HTTP, so a broken migration or a broken auth path fails there too.
- Every direct `node --test` command in these stories passes `--test-timeout=60000`, matching the `test` script, so a hang fails instead of stalling.
- `bootstrapActorId` is `"actor_"` plus twenty-six `0` characters. Twenty-six zeros satisfy `ulidPattern` (`/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`), verified by running it, so the id parses as a real `actor` identity and sorts first under `ORDER BY id ASC` with SQLite's default `BINARY` collation.

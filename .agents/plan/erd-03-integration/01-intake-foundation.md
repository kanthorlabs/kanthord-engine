# Plan 01: Intake Service — foundation

## Scope

This plan delivers:

- The service identity of the kernel: `ServiceIdentity`, `isServiceIdentity` and `mintServiceIdentity` in `src/kernel/service-mint.ts` (decision D7). A test that needs a minted service identity sits under `src/apps/server/` and imports the factory there, because only `src/apps/server/` imports `service-mint.ts` (`architecture.impl.md:817`, `:936`).
- The `service` access policy in the operation registry, the invocation chain, the HTTP adapter and the OpenAPI emitter (decision D7).
- The `src/intake` module: `contract.ts` with the service name and the closed sets, `index.ts`, `service.ts` with the lifecycle and the `intake` health probe, `migrations.ts`, and the empty configuration fragment.
- The migration of `intake_inbound`, `intake_inbound_event` and `intake_outbound_request` with their two unique indexes.
- The bounded `error` array helper.
- The composition of the Intake Service with the service identity that the composition root mints.
- The `services.intake` owner of the resource health report, fed by an Intake inventory that answers no entry until plan 10.

Out of scope:

- Every Intake operation (plans 02 to 09). This plan registers no route and no CLI group (ERD 1 decision D12).
- The Mission service identity (plan 03) and every other service identity: the composition root mints an identity for a service when that service first calls a peer (decision D7).
- The inbound entries of the health report (plan 10).

## Sources

- `docs/reference/erd/03-integration.md:50–84` — the columns of the three tables.
- `docs/reference/erd/03-integration.md:86–92`, `:166–172` — the references; `inbound_id` is the one foreign key.
- `docs/reference/erd/03-integration.md:124–151` — the constraints of the Intake Service.
- `docs/reference/erd/README.md:100`, `:114–121` — `kanthord.db` holds ERD 3; the conventions.
- `docs/brainstorm/intake-service.md:46` — one Intake Service serves every project.
- `docs/brainstorm/intake-service.vocabulary.md:14–27`, `:50–53`, `:57–60`, `:73–76` — the closed sets: inbound kind, consumer, inbound event state, outbound operation, outbound request state.
- `docs/brainstorm/intake-service.impl.md:13–15` — the composition root mints the service identity; every acquisition and the dispatcher call a peer with it.
- `docs/brainstorm/intake-service.impl.md:28`, `:160` — the identity prefixes `inbound_` and `outbound_request_`.
- `docs/brainstorm/intake-service.impl.md:80`, `:163` — the shape and the byte bound of `error`.
- `docs/brainstorm/architecture.impl.md:123–149` — the migration rules.
- `docs/brainstorm/architecture.impl.md:159–165` — the identity form.
- `docs/brainstorm/architecture.impl.md:415–428`, `:457–478` — the construction order and the four stop phases.
- `docs/brainstorm/architecture.impl.md:644–646`, `:662–669` — the delivery policy mints no identity; the `service` policy.
- `docs/brainstorm/architecture.impl.md:679–692` — caller propagation and the minted service identity.
- `docs/brainstorm/architecture.impl.md:715` — the idempotency record of a service identity holds the service name.
- `docs/brainstorm/architecture.impl.md:812`, `:817`, `:819–823` — the conformance test exempts a `service` operation; the lint rule of `service-mint.ts`; the tests of the `service` policy.
- `docs/brainstorm/architecture.impl.md:877`, `:880`, `:934–941` — `service-mint.ts`, the `intake/` directory and the import boundaries.
- `docs/brainstorm/gateway-service.impl.md:41–44` — the five policy values; a `service` operation has no route and answers 404.
- `docs/brainstorm/gateway-service.impl.md:214–219` — the forwarding contract and the identity factories.
- `docs/brainstorm/gateway-service.impl.md:316`, `:325`, `:328` — the component maps of the liveness answer (blocker B4).
- `docs/brainstorm/gateway-service.impl.md:353–356`, `:376` — `services.intake` and the collection of the inventories.
- `engine/AGENTS.md` "Add a service", "Add a migration" — the contributor steps.
- `engine/src/kernel/caller.ts:1–36`, `engine/src/kernel/caller-mint.ts`, `engine/src/kernel/test-identity.ts` — the identity types and factories.
- `engine/src/kernel/operation.ts:8–14`, `:105–166` — `AccessPolicy` and the registry rules.
- `engine/src/gateway/invocation.ts:260–420` — the chain: recheck, authentication, idempotency caller.
- `engine/src/gateway/authentication.ts:84–109` — `recheck` refuses an identity that is neither human nor machine.
- `engine/src/gateway/service.ts:376–490`, `engine/src/gateway/openapi.ts:195–225` — route registration and the emitter.
- `engine/src/gateway/contract.ts:25–39`, `engine/src/gateway/health-report.ts:34–64`, `:202–246` — the inventory owners and the report assembly.
- `engine/src/apps/server/index.ts:74–319`, `:375–403` — the composition root, the migration list and the service list.
- `engine/src/apps/server/test-support.ts:385–470` — `gatewayFixture`.
- `engine/eslint.config.js:24–35` — the `service` element pattern.
- `engine/.agents/plan/erd-03-integration/00-index.md`, `decisions.md` — decisions D1 to D24.
- Root `AGENTS.md` "Database design", "Contracts".

### Contract keys

| Key                                                                                                                              | Where                                                 | Owner line                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `kind`, `service`                                                                                                                | `ServiceIdentity`                                     | `architecture.impl.md:690` "A service identity names its service and nothing else" |
| `id`, `project_id`, `kind`, `platform`, `consumer`, `credential`, `configuration`, `registration_id`, `checkpoint`, `created_at` | `intake_inbound`                                      | `docs/reference/erd/03-integration.md:50–61`                                       |
| `id`, `inbound_id`, `event_id`, `event`, `metadata`, `state`, `error`, `created_at`                                              | `intake_inbound_event`                                | `docs/reference/erd/03-integration.md:63–72`                                       |
| `id`, `project_id`, `operation`, `request_key`, `credential`, `state`, `result`, `error`, `created_at`                           | `intake_outbound_request`                             | `docs/reference/erd/03-integration.md:74–84`                                       |
| `code`, `message`, `created_at`                                                                                                  | an item of `error`                                    | `docs/reference/erd/03-integration.md:138`                                         |
| `intake`                                                                                                                         | `services` of the health report and the component map | `gateway-service.impl.md:354`; blocker B4                                          |

## Depends on

- ERD 1 and ERD 2, committed: the operation registry, the invocation chain, both adapters, `collectInventories`, `gatewayFixture`, the composition root and the `unwired` mechanism (ERD 2 decision D6).
- No stand-in. This plan adds no `unwired` entry.

## Provides

| Seam                   | TypeScript signature                                                                                                                                                                                                                         | Owner file                                           | Consumer plans |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- |
| Service identity       | `ServiceIdentity = { readonly kind: "service"; readonly service: string }`; `isServiceIdentity(value: unknown): value is ServiceIdentity`; `mintServiceIdentity(service: string): ServiceIdentity`; `CallerIdentity` gains `ServiceIdentity` | `src/kernel/caller.ts`, `src/kernel/service-mint.ts` | 02–10          |
| `AccessPolicy.Service` | `"service"`; registered in the registry, absent from the HTTP routes and from OpenAPI                                                                                                                                                        | `src/kernel/operation.ts`, `src/gateway/*`           | 03, 08         |
| Intake contract        | `INTAKE_SERVICE_NAME = "intake"`; `InboundKind`, `InboundPlatform`, `Consumer`, `InboundEventState`, `OutboundOperation`, `OutboundRequestState` as `as const` objects with their `z.enum` schemas                                           | `src/intake/contract.ts`                             | 02–10          |
| `intakeMigrations`     | the one migration of the three tables                                                                                                                                                                                                        | `src/intake/migrations.ts`                           | 10             |
| `appendError`          | `(current: string \| null, item: { code: string; message: string; created_at: number }): string`                                                                                                                                             | `src/intake/error-array.ts`                          | 02, 09         |
| `IntakeService`        | `constructor(dependencies: { store; logger; health; identity: ServiceIdentity })`; `resourceInventory(tx): ResourceEntry[]`                                                                                                                  | `src/intake/service.ts`, `src/intake/index.ts`       | 02–10          |
| Inventory owner        | `ResourceInventories.intake`; `OWNER_INTAKE = "intake"`                                                                                                                                                                                      | `src/gateway/contract.ts`                            | 10             |

## Tasks

### 01.1 Add the service identity to the kernel

- Files: `src/kernel/caller.ts`, `src/kernel/service-mint.ts` (create), `src/gateway/authentication.ts`, `src/apps/server/service-identity.test.ts` (create), `src/apps/server/import-boundaries.test.ts` (create), `eslint.config.js`, `engine/AGENTS.md` (all edit unless marked)
- Do:
  1. In `src/kernel/caller.ts`, add `Service: "service"` to `IdentityKind`, declare `ServiceIdentity { readonly kind: typeof IdentityKind.Service; readonly service: string }`, add it to `CallerIdentity`, add a module-private `WeakSet` `services`, export `isServiceIdentity`, and add `service` to `callerProvenance`.
  2. Create `src/kernel/service-mint.ts` with `mintServiceIdentity(service)`: assert that `service` matches `SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/`, freeze `{ kind, service }`, record it through `callerProvenance.service`, and answer it.
  3. In `recheck` (`src/gateway/authentication.ts:84–109`), narrow the machine branch with `isMachineIdentity` and refuse every other value with `unauthorized()`, so the file typechecks once `CallerIdentity` holds three kinds; task 01.2 adds the service branch.
  4. In `eslint.config.js`, restrict an import of `src/kernel/service-mint.ts` to `src/apps/server/`, beside the `caller-mint.ts` rule.
  5. Add tests in `src/apps/server/service-identity.test.ts`: a minted identity passes `isServiceIdentity` and fails `isHumanIdentity` and `isMachineIdentity`; a structural copy `{ kind: "service", service: "intake" }` fails `isServiceIdentity`; the value is frozen; an invalid name throws.
  6. Add `src/apps/server/import-boundaries.test.ts`: run the ESLint API over an in-memory file at `src/intake/probe.ts` and at `src/kernel/probe.ts` that imports `service-mint.ts`, and assert one boundary error each; assert no error for the same import from `src/apps/server/probe.ts`.
  7. Add `service-mint.ts  # Service identity factory reserved for the server composition root` to the `src/kernel/` entry of `engine/AGENTS.md`.
- Rules:
  - The composition root mints one frozen service identity for each service, and a service identity names its service and nothing else. `architecture.impl.md:689–690`.
  - `caller.ts` holds `ServiceIdentity` and `isServiceIdentity` with a module-private `WeakSet`; `service-mint.ts` holds the factory, and only `src/apps/server/` imports it. `architecture.impl.md:934–936`, `:941`.
  - The lint test rejects an import of `service-mint.ts` outside `src/apps/server/`. `architecture.impl.md:817`. The page admits `test-identity.ts` for `caller-mint.ts` alone, so no test factory of a service identity exists outside `src/apps/server/`.
  - A value that no authority mints authorizes nothing on either adapter. `architecture.impl.md:692`.
- Done when: `node --test --test-timeout=30000 src/apps/server/service-identity.test.ts src/apps/server/import-boundaries.test.ts` passes; `pnpm run verify` passes.

### 01.2 Add the `service` access policy

- Files: `src/kernel/operation.ts`, `src/gateway/invocation.ts`, `src/gateway/authentication.ts`, `src/gateway/service.ts`, `src/gateway/openapi.ts`, `src/gateway/openapi.test.ts`, `src/apps/server/adapter-conformance.test.ts` (all edit), `src/apps/server/service-policy.test.ts` (create)
- Do:
  1. Add `Service: "service"` to `AccessPolicy` (`src/kernel/operation.ts:8–13`). A `service` operation keeps its `method` and its `/api/` path as the identity of its declaration, so the path rule and the duplicate checks of `register` apply unchanged. In `register`, refuse a `service` operation that declares `requiresExecution`, `requiresRegistration`, `delivery` or `secret`.
  2. In `recheck` (`src/gateway/authentication.ts:84–109`), answer a minted service identity unchanged; keep the refusal of every other value.
  3. In `execute` (`src/gateway/invocation.ts:312–340`), for a `service` operation require `isServiceIdentity(identity)` and throw `unauthorized()` otherwise; never read the authorization header for it. For a `human` or `client` operation, refuse a service identity with `unauthorized()`.
  4. In the idempotency caller (`:342–347`), take `identity.service` for a service identity.
  5. In `registerRoutes` (`src/gateway/service.ts:376`), skip every `service` operation, so its path answers 404 `gateway.routing.not_found`. In `src/gateway/openapi.ts`, exclude every `service` operation from the emitted files.
  6. In the conformance test, skip every `service` operation by policy (`architecture.impl.md:812`).
  7. Add tests with a test registry that declares the `service` mutation `test.service.ping` at `POST /api/test/ping`, whose handler answers `{ pong: true }` through `caller.commit`. The tests sit in `src/apps/server/service-policy.test.ts`, mint the identities with `mintServiceIdentity` and `testHumanIdentity`, and pass a fresh ULID as the idempotency key: the direct adapter with a minted service identity completes and replays a repeated key; a human identity, a machine identity and a structural copy each answer 401 `gateway.authentication.unauthorized`; the HTTP adapter answers 404 for its path; the emitted OpenAPI holds no path of it; a `human` operation refuses a service identity with 401.
- Rules:
  - The `service` policy serves a service identity; the operation is reachable through the direct adapter alone; the Gateway registers no HTTP route and the emitter excludes it. `architecture.impl.md:664–667`; `gateway-service.impl.md:44`.
  - The `service` policy alone grants no operation, and the owning service authorizes the calling service by name. `architecture.impl.md:669`. The owning handlers add that check (plans 03, 08).
  - No operation accepts two caller kinds. `architecture.impl.md:670`.
  - The `caller` field of an idempotency record holds the service name for a service identity. `architecture.impl.md:715`.
  - A test covers a `service` operation through the HTTP adapter and asserts 404 and no route in OpenAPI; a test covers an identity value that no authority minted. `architecture.impl.md:819–823`.
- Done when: `node --test --test-timeout=30000 src/apps/server/service-policy.test.ts src/gateway/openapi.test.ts src/apps/server/adapter-conformance.test.ts` passes; `pnpm run verify` passes.

### 01.3 Create the Intake module and its contract

- Files: `src/intake/contract.ts`, `src/intake/index.ts`, `src/intake/service.ts`, `src/intake/service.test.ts` (all create); `src/config/index.ts`, `eslint.config.js`, `engine/AGENTS.md` (edit)
- Do:
  1. In `src/intake/contract.ts`, declare `INTAKE_SERVICE_NAME = "intake"` and the closed sets with their schemas: `InboundKind = { Webhook: "webhook", Poll: "poll" }`; `InboundPlatform = { GitHub: "github" }`; `Consumer = { MissionDeliveryAdmit: "mission.delivery.admit" }`; `InboundEventState` and `OutboundRequestState`, each `{ Pending: "pending", Succeeded: "succeeded", Failed: "failed", Discarded: "discarded" }`; `OutboundOperation = { GitHubPullRequest: "github.pull_request", GitMergePush: "git.merge_push", S3DeleteObject: "s3.delete_object" }`; the identity prefixes `INBOUND_ID_PREFIX = "inbound"`, `INBOUND_EVENT_ID_PREFIX = "inbound_event"`, `OUTBOUND_REQUEST_ID_PREFIX = "outbound_request"`; and the constants of decision D12.
  2. In `src/intake/service.ts`, implement `IntakeService implements Service` with `Dependencies = { store: Store; logger: Logger; health: HealthRegistry; identity: ServiceIdentity }`, all required. `start()` asserts that `identity.service` equals `INTAKE_SERVICE_NAME`; `run()`, `quiesce()`, `drain()` and `stop()` follow the four phases; `declare(registry)` registers nothing yet. After the ruling of B4, `healthcheck()` answers `{ events: 200 }` while the service runs, and `start()` registers the probe under `intake`, adding `intake` to any closed name list of `HealthRegistry` (`src/kernel/health.ts:51`).
  3. Implement `resourceInventory(tx): ResourceEntry[]` that answers `[]`.
  4. In `src/intake/index.ts`, export `IntakeService`, `Dependencies`, `intakeMigrations` (an empty list until task 01.4, `engine/AGENTS.md` "Add a service" step 2) and the empty configuration fragment `intakeConfigSchema = {}`. Import the fragment in `src/config/index.ts`; an empty fragment adds no YAML section.
  5. Add `intake` to the `service` element pattern of `eslint.config.js:28–30`.
  6. Add the `src/intake/` entry to the project structure of `engine/AGENTS.md`.
  7. Add tests: the lifecycle runs `start`, `run`, `quiesce`, `drain`, `stop` once each; a second `start` after `stop` answers `intake.lifecycle.stopped`; `start` with an identity of another service throws; the probe answers 200 while running and 503 after `stop`.
- Rules:
  - A service has `contract.ts`, `index.ts` and `service.ts`; `index.ts` exports the service, `Dependencies`, the migrations and the configuration fragment. `engine/AGENTS.md` "Add a service"; `architecture.impl.md:899–913`.
  - `contract.ts` imports the kernel and `zod` only. `architecture.impl.md:902`, `:944`.
  - Every closed value set is an enum in code, and the service validates before the write. Root `AGENTS.md` "Database design"; `docs/reference/erd/03-integration.md:127`, `:142`.
  - The vocabulary fixes each closed set: inbound kind, consumer, inbound event state, outbound operation, outbound request state. `intake-service.vocabulary.md:16–17`, `:27`, `:53`, `:59–60`, `:76`.
  - The platform set holds `github` alone. `docs/reference/erd/03-integration.md:19`; `engine/docs/cli/intake.md:153`, `:195`.
  - Every service stops its timers in phase 1, and the stop releases resources in phase 4. `architecture.impl.md:457–478`.
  - `intake.lifecycle.stopped` follows the form of the shared lifecycle codes (`engine/docs/cli/other.md` rows `worker.lifecycle.stopped`, `project.lifecycle.stopped`); the condition is ruled by `architecture.impl.md:446`. Gap: `engine/docs/cli/other.md` holds no `intake.lifecycle.stopped` row (blocker B4 carries the liveness repair; the task reuses the lifecycle form and lists the row for Ulrich).
  - Gap: the component map `intake` is absent from `gateway-service.impl.md:316`, `:325`, `:328` (blocker B4). Steps 2 and 7 that register and test the probe wait for the ruling of B4 (decision D1); the rest of the task does not.
- Done when: `node --test --test-timeout=30000 src/intake/service.test.ts` passes; `pnpm run verify` passes.

### 01.4 Add the migration of the three tables

- Files: `src/intake/migrations.ts` (create), `src/intake/migrations.test.ts` (create), `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. Declare one migration that runs:
     ```sql
     CREATE TABLE intake_inbound (
       id TEXT NOT NULL PRIMARY KEY,
       project_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       platform TEXT NOT NULL,
       consumer TEXT NOT NULL,
       credential TEXT,
       configuration TEXT NOT NULL,
       registration_id TEXT,
       checkpoint TEXT,
       created_at INTEGER NOT NULL
     );
     CREATE TABLE intake_inbound_event (
       id TEXT NOT NULL PRIMARY KEY,
       inbound_id TEXT NOT NULL REFERENCES intake_inbound(id),
       event_id TEXT NOT NULL,
       event BLOB NOT NULL,
       metadata TEXT NOT NULL,
       state TEXT NOT NULL,
       error TEXT,
       created_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX intake_inbound_event_inbound_event ON intake_inbound_event (inbound_id, event_id);
     CREATE TABLE intake_outbound_request (
       id TEXT NOT NULL PRIMARY KEY,
       project_id TEXT NOT NULL,
       operation TEXT NOT NULL,
       request_key TEXT NOT NULL,
       credential TEXT,
       state TEXT NOT NULL,
       result TEXT,
       error TEXT,
       created_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX intake_outbound_request_operation_key ON intake_outbound_request (operation, request_key);
     ```
  2. Export `intakeMigrations: readonly Migration[]` with that one migration.
  3. Add the migration list to both ownership checks of `src/apps/server/migrations.test.ts` (prefix and isolation) and the three tables to the expected list.
  4. Add tests in `src/intake/migrations.test.ts`: a second row with the same `(inbound_id, event_id)` throws; a second row with the same `(operation, request_key)` throws; two inbounds with equal columns insert; an event of an absent inbound throws; `sqlite_master` holds no `CHECK`; the indexes outside `sqlite_autoindex%` are exactly the two named ones, both unique, on their columns; `pragma_foreign_key_list` holds the one reference.
- Rules:
  - The columns, their types and their nullability are the columns of the ERD. `docs/reference/erd/03-integration.md:50–84`.
  - `intake_inbound` holds no unique index other than its key. `docs/reference/erd/03-integration.md:126`; `intake-service.impl.md:31`.
  - The unique `(inbound_id, event_id)` and `(operation, request_key)` are the only indexes. `docs/reference/erd/03-integration.md:134`, `:144`; decision D20.
  - `inbound_id` takes the one foreign key, inside one owner; `project_id` and `credential` take none. `docs/reference/erd/03-integration.md:86–90`; decision D20.
  - `project_id` is the second column of the two project-scoped tables. Root `AGENTS.md` "Database design".
  - No SQL `CHECK` and no non-unique index. Root `AGENTS.md` "Database design".
  - A published migration is immutable; the owning service exports its list from `index.ts`. `architecture.impl.md:125–135`.
- Done when: `node --test --test-timeout=30000 src/intake/migrations.test.ts src/apps/server/migrations.test.ts` passes; `pnpm run verify` passes.

### 01.5 Add the bounded `error` array

- Files: `src/intake/error-array.ts` (create), `src/intake/error-array.test.ts` (create)
- Do:
  1. Implement `appendError(current, item)`: start empty only for `null`; parse any other value with a strict schema of the item array and throw on malformed stored JSON; cut `item.message` to at most `ERROR_MESSAGE_MAX_BYTES` UTF-8 bytes on a code-point boundary; append `{ code, message, created_at }`; while the canonical JSON of the array exceeds `ERROR_ARRAY_MAX_BYTES`, drop the oldest item; answer the canonical JSON.
  2. Assert, before any eviction, that the canonical JSON of the newest item alone fits the bound; bound the eviction loop by the array length; measure UTF-8 bytes of canonical JSON.
  3. Add tests: the first failure answers one item; an append to a full array drops the oldest item and keeps the newest; an append that evicts several items; a message of escaping-heavy characters and a multibyte character at the bound cuts on a code point; malformed stored JSON throws; the answer is canonical JSON with snake_case `created_at`.
- Rules:
  - `error` is null until the first failure; each failure appends `{ code, message, created_at }`; the array has a bound in bytes; an append beyond the bound drops the oldest items. `docs/reference/erd/03-integration.md:138`; `intake-service.impl.md:80`.
  - A message beyond its own bound is cut at that bound. `intake-service.impl.md:80`.
  - The outbound request uses the same shape and bound. `intake-service.impl.md:163`.
  - A JSON column holds canonical JSON. `docs/reference/erd/README.md:118`.
  - Gap: the values of both bounds are open (`docs/brainstorm/HANDOFF.md:39`); the constants follow decision D12.
- Done when: `node --test --test-timeout=30000 src/intake/error-array.test.ts` passes; `pnpm run verify` passes.

### 01.6 Compose the Intake Service

- Files: `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/index.test.ts` (all edit)
- Do:
  1. In `composeServices`, mint `intakeIdentity = mintServiceIdentity(INTAKE_SERVICE_NAME)` and construct `new IntakeService({ store, logger, health, identity: intakeIdentity })` after the Project Service and before the Gateway; call `intake.declare(registry)` before `registry.seal`; answer `intake`.
  2. In `Server.open` (`:375–382`), add `{ service: INTAKE_SERVICE_NAME, migrations: intakeMigrations }` after `project`. Insert `intake` into the service list after `project` (`:401`).
  3. In `gatewayFixture`, add the same migration entry, answer `intake` from the construction, start and run it with the other services, add it to the quiescence list, drain it with the Gateway before `invocation.stop()`, and stop it after `gateway` and before `project`.
  4. Add a test in `src/apps/server/index.test.ts`: the composed services hold `intake`; during the drain a direct call of a peer stays available; the stop releases `intake` before `project` and after `gateway`.
- Rules:
  - The composition root constructs the services in a fixed order, supplies collaborations and clients, calls `declare` for each, then seals. `architecture.impl.md:415–428`.
  - Every domain service starts before the Gateway listener opens; the stop runs in reverse construction order. `architecture.impl.md:432`, `:473–474`.
  - The composition root mints the service identity of the Intake Service. `intake-service.impl.md:15`; `architecture.impl.md:689`.
  - The migrations run in a fixed service order. `architecture.impl.md:101`, `:134`.
- Done when: `node --test --test-timeout=30000 src/apps/server/index.test.ts` passes; `pnpm run verify` passes.

### 01.7 Add the `intake` owner to the inventory collection

- Files: `src/gateway/contract.ts`, `src/gateway/health-report.ts`, `src/gateway/health-report.test.ts`, `src/apps/server/index.ts` (all edit)
- Do:
  1. Add `OWNER_INTAKE = "intake"` to `src/gateway/contract.ts`, add it to `InventoryOwner`, and add `intake: (tx) => ResourceEntry[]` to `ResourceInventories`.
  2. In `src/gateway/health-report.ts`, add `OWNER_INTAKE` to `INVENTORY_OWNERS`, assemble `services.intake` from its entries, and remove the orphan `INTAKE_EMPTY_OWNER` use in `assembleReport` (keep the empty-owner constructor under a name that no longer says Intake).
  3. In `composeServices`, pass `intake: options.inventoryOverrides?.intake ?? ((tx) => intake.resourceInventory(tx))` to `collectInventories`.
  4. Add tests: an `intake` entry lands at `services.intake.projects.<project>.<name>`; a throwing Intake inventory answers 503 `gateway.healthcheck.inventory_failed` with `missingInventories` `["intake"]`; an empty inventory answers `{ global: {}, projects: {} }`.
- Rules:
  - `services` holds exactly `project`, `intake` and `worker`, each with `global` and `projects`. `gateway-service.impl.md:354`, `:356`.
  - The composition root reads the inventories in one transaction and answers `{ entries, missingInventories }`; an owner failure adds that owner. `gateway-service.impl.md:376–377`.
  - An Intake resource name is its inbound identity. `gateway-service.impl.md:365`. Plan 10 adds the entries.
- Done when: `node --test --test-timeout=30000 src/gateway/health-report.test.ts` passes; `pnpm run verify` passes.

### 01.E E2E proof

- Files: `src/apps/server/e2e-intake-foundation.test.ts` (create)
- Do:
  1. Start `gatewayFixture` with `inventoryOverrides: { custody: () => [] }`.
  2. Write one `test` block for each scenario E01.1 to E01.3 of `## E2E`.
- Rules:
  - The liveness answer and the health report have no CLI command, so the test reads them over HTTP. ERD 1 decision D13.
  - The `service` operation of E01.3 is the test registry operation of task 01.2, because this plan declares no operation.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-intake-foundation.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-intake-foundation.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store. `H` names the human token `fixture.token`.
- Rules: the state check reads over HTTP where no CLI command exists; a refusal asserts the exact status and the error code.

| Id    | Commands                                                                                                                                                                                                                                                                                              | Exit      | Expect                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01.1 | `GET /api/liveness`                                                                                                                                                                                                                                                                                   | 200       | `services.intake` = `{ "events": 200 }` beside the existing maps                                                                                     |
| E01.2 | `GET /api/healthcheck` with H                                                                                                                                                                                                                                                                         | 200       | `services.intake` = `{ "global": {}, "projects": {} }`                                                                                               |
| E01.3 | On a second `gatewayFixture` whose registry holds the `service` mutation `test.service.ping` of task 01.2: `POST /api/test/ping` with H; the direct adapter with `mintServiceIdentity("intake")` and a fresh idempotency key; the direct adapter with `testHumanIdentity("ulrich", "Ulrich", <ulid>)` | 404, —, — | first `gateway.routing.not_found`; second completed with `{ pong: true }`; third a failure with status 401 and `gateway.authentication.unauthorized` |

## Blockers

- B4 of `00-index.md`: the component map `intake` of the liveness answer is absent from `gateway-service.impl.md:316`, `:325`, `:328`. The probe of task 01.3, its tests and scenario E01.1 wait for its ruling and land in the commit that follows it; the recommendation is `{ events: 200 }`.

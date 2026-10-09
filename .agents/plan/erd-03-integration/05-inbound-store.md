# Plan 05: Intake Service — inbounds

## Scope

This plan delivers:

- The inbound store of `src/intake/inbound-store.ts`: the insert with its credential check, the reads, the projection and the delete of an inbound with its events.
- The `configuration` schema per `(kind, platform)` (decision D14).
- The verification secret of a webhook inbound, derived from `masterKey` and the inbound identity.
- The inbound credential release in custody: the grant kind `inbound`, the requester check of the Intake service identity and the one inbound operation `poll`.
- The collaboration `inboundsNaming`, which replaces the stand-in of custody for the credential archive.
- The operations `intake.inbound.create` (the webhook inbound in this plan), `intake.inbound.list`, `intake.inbound.get` and `intake.inbound.delete` (the webhook inbound and the poll), with their OpenAPI and their CLI leaves `inbound create`, `inbound list`, `inbound get` and `inbound delete`.

Out of scope:

- The request of a poll create (plan 07). Until plan 07, the create schema admits a webhook inbound alone, so the closed set of the CLI page widens in plan 07.
- The receipt and the event writes (plans 06, 07, 09).
- The credential archive itself: `credential.archive` exists (`engine/docs/cli/credential.md:192–199`); this plan replaces the `inboundsNaming` stand-in alone.
- The display, redaction and cache contract of the secret (`engine/docs/cli/intake.md:244–247`, blocked there), and the `configuration` fields beyond `resource` (`docs/brainstorm/HANDOFF.md:60`).

## Sources

- `docs/reference/erd/03-integration.md:50–60`, `:114`, `:123–132` — the inbound columns, the derived secret, the inbound constraints.
- `docs/brainstorm/intake-service.md:34`, `:36–39`, `:44`, `:46` — `inboundsNaming`; the service identity; the release per call; the derived secret.
- `docs/brainstorm/intake-service.md:49–70` — inbounds: the create, the webhook inbound with no credential, the delete with no platform call.
- `docs/brainstorm/intake-service.md:184`, `:194–197` — the delete of an inbound removes its events; the human authority; the consumer set.
- `docs/brainstorm/intake-service.vocabulary.md:9–25` — inbound, inbound kind, consumer.
- `docs/brainstorm/intake-service.impl.md:17–35` — the credential release of an inbound and the inbound store.
- `docs/brainstorm/intake-service.impl.md:42–48` — the verification secret and its return by `intake.inbound.get`.
- `docs/brainstorm/intake-service.impl.md:94–115` — the error codes.
- `docs/brainstorm/intake-service.impl.md:219–220`, `:224` — the tests of the create and the delete.
- `docs/brainstorm/custody.impl.md:31–37`, `:91–97`, `:108–117`, `:126–137`, `:260` — the archive dependents, suitability, the facility, the release, the release tests.
- `engine/docs/cli/credential.md:192–199` — `credential.archive` and its dependents `inbounds: [{ inboundId }]`.
- `docs/brainstorm/project-service.impl.md:75`, `:83` — the resource identity of a GitHub repository.
- `docs/brainstorm/architecture.impl.md:297–306` — `masterKey` and the derivation of a key.
- `docs/brainstorm/architecture.impl.md:179–189` — pagination.
- `engine/docs/cli/intake.md:50–55`, `:78–91`, `:137–201`, `:203–263` — the inbound commands, their flags, the create file schema, the projection and the statuses.
- `engine/docs/cli/intake.md:443–473` — the error codes.
- `engine/src/custody/service.ts:107`, `:607–620`, `engine/src/custody/contract.ts:154–169`, `engine/src/apps/server/index.ts:189` — `inboundsNaming`, `credentialDependents`, `InboundDependent` and the stand-in.
- `engine/src/project/store.ts:38–39` — the repository address pattern.
- Decisions D7, D9, D14, D15, D20, D23, D24 of `decisions.md`.

### Contract keys

| Key                                                                                                         | Where                                     | Owner line                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `projectId`, `kind`, `platform`, `consumer`, `credential`, `configuration`                                  | the create file                           | `engine/docs/cli/intake.md:191–198`                              |
| `resource`                                                                                                  | `configuration`                           | `engine/docs/cli/intake.md:198`; decision D14                    |
| `id`, `projectId`, `kind`, `platform`, `consumer`, `credential`, `configuration`, `checkpoint`, `createdAt` | the inbound read projection               | `engine/docs/cli/intake.md:205–207`                              |
| `address`, `secret`                                                                                         | the answer of `inbound get` for a webhook | `intake-service.impl.md:48`; `engine/docs/cli/intake.md:244–247` |
| `inboundId`                                                                                                 | path parameter                            | `engine/docs/cli/intake.md:149`                                  |
| `projectId`, `kind`, `platform`, `limit`, `cursor`                                                          | query of `inbound list`                   | `engine/docs/cli/intake.md:151–153`                              |

## Depends on

- Plan 01: the Intake module, `intake_inbound`, `intake_inbound_event`, the closed sets and the identity.
- Plan 02: the `intake` CLI group.
- Plan 03: the generalized facility and `GrantRequest`.
- ERD 1: `project.get` (`engine/docs/cli/project.md`), `custodySuitability`, `credentialDependents`.
- No stand-in.

## Provides

| Seam                                  | TypeScript signature                                                                                                                                                                                                   | Owner file                                                   | Consumer plans |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- |
| Inbound store                         | `allocateInboundId(): string`; `insertInbound(tx, id, row): void`; `readInbound(tx, id): InboundRow \| null`; `inboundRecord(row): Inbound`; `pendingEventCount(tx, inboundId): number`; `deleteInbound(tx, id): void` | `src/intake/inbound-store.ts`                                | 06, 07, 09, 10 |
| `configurationSchemaOf`               | `(kind: InboundKind, platform: InboundPlatform) => z.ZodType<{ resource: string }>`                                                                                                                                    | `src/intake/configuration.ts`                                | 06, 07, 08     |
| `webhookSecret`                       | `(masterKey: string, inboundId: string): string`                                                                                                                                                                       | `src/intake/webhook-secret.ts`                               | 06, 10         |
| Inbound grant                         | `GrantRequest` kind `{ kind: "inbound"; identity: ServiceIdentity; inbound: { inboundId; credential; platform; resource }; operation: InboundOperation }` with `InboundOperation = "poll"`                             | `src/custody/contract.ts`                                    | 07, 10         |
| `IntakeCollaborations.inboundsNaming` | `(tx, credentialName): { inboundId: string }[]`, the `InboundDependent` of custody                                                                                                                                     | `src/intake/contract.ts` (declared), `src/intake/service.ts` | custody        |
| Inbound operations                    | `intake.inbound.create`, `list`, `get`, `delete`                                                                                                                                                                       | `src/intake/contract.ts`                                     | 06, 07, 10     |
| Create steps                          | `remoteValidation` per kind, a private function of `src/intake/inbound-create.ts`, with the webhook inbound alone in this plan; `commitInbound`; `credentialRefusal`                                                   | `src/intake/`                                                | 07             |

## Tasks

### 05.1 Add the inbound store and the configuration schema

- Files: `src/intake/inbound-store.ts` (create), `src/intake/inbound-store.test.ts` (create), `src/intake/configuration.ts` (create), `src/intake/configuration.test.ts` (create), `src/intake/contract.ts` (edit)
- Do:
  1. In `src/intake/configuration.ts`, declare `GITHUB_RESOURCE_PATTERN = /^[^/\s:]+\/[^/\s:]+$/` from the address pattern of the Project Service and `githubConfigurationSchema = z.strictObject({ resource: z.string().regex(GITHUB_RESOURCE_PATTERN) })`; answer it from `configurationSchemaOf` for both kinds of `github`; declare `resourceIdentityOf(platform, configuration) = "repository:github:" + resource`.
  2. In `src/intake/contract.ts`, declare `inboundSchema` for the projection of `engine/docs/cli/intake.md:205–207` and `webhookInboundSchema` that adds `address` and `secret`.
  3. In `src/intake/inbound-store.ts`, implement `allocateInboundId()` with `createIdentity("inbound")`, and `insertInbound(tx, id, row)` with the allocated identity, the canonical JSON of `configuration`, `checkpoint` from the caller, and `created_at`; `readInbound`; `inboundRecord`, which parses `configuration` and `checkpoint`; `pendingEventCount`; and `deleteInbound`, which deletes the events of the inbound and the row in the caller transaction.
  4. Add tests: a configuration with an extra field or a resource without a slash refuses; two inserts with one configuration both succeed; the projection holds no secret; `deleteInbound` removes the events and the row.
- Rules:
  - `id` is `inbound_` and a ULID; `configuration` is JSON text validated per `(kind, platform)` with a `zod` schema before the write, holding `resource`; every property name is snake_case. `intake-service.impl.md:28–29`.
  - No column of an inbound changes after its insert except `checkpoint`. `docs/reference/erd/03-integration.md:124`.
  - The table holds no unique index other than its key, because a duplicate serves a rotation. `intake-service.impl.md:31`; `intake-service.md:58`.
  - No row holds credential material or a webhook secret. `docs/reference/erd/03-integration.md:131`.
  - A platform implementation derives the resource of a call from the inbound. `repository.md:43`, `:47`. The resource identity form is `project-service.impl.md:75`.
  - Gap: the fields beyond `resource` wait for HANDOFF (`docs/brainstorm/HANDOFF.md:60`); decision D14.
- Done when: `node --test --test-timeout=30000 src/intake/inbound-store.test.ts src/intake/configuration.test.ts` passes; `pnpm run verify` passes.

### 05.2 Add the verification secret

- Files: `src/intake/webhook-secret.ts` (create), `src/intake/webhook-secret.test.ts` (create), `src/intake/service.ts`, `src/apps/server/index.ts` (edit)
- Do:
  1. Implement `webhookSecret(masterKey, inboundId)`: `hkdfSync("sha256", Buffer.from(masterKey, "base64"), Buffer.alloc(0), "webhook/" + inboundId, 32)` encoded in base64url.
  2. Add `masterKey: string` to the Intake `Dependencies` and pass `options.config.masterKey` from `composeServices`.
  3. Add tests: two inbound identities answer two secrets; one identity answers one secret on every call; the secret differs from the record cipher key and the JWT signing key derived from the same `masterKey`.
- Rules:
  - The Intake Service derives its keys with `crypto.hkdfSync`, SHA-256 and an empty salt from `masterKey`; `HKDF(masterKey, info = "webhook/<inbound id>")` is the verification secret; no store holds it. `intake-service.impl.md:44–45`; `architecture.impl.md:301–305`.
  - A new secret is a new inbound, and a replacement of `masterKey` invalidates every derived secret. `intake-service.impl.md:46–47`.
  - A test covers the derivation of a webhook secret and asserts that two labels produce two different secrets. `project-service.impl.md:283`.
- Done when: `node --test --test-timeout=30000 src/intake/webhook-secret.test.ts` passes; `pnpm run verify` passes.

### 05.3 Add the inbound credential release to custody

- Files: `src/custody/contract.ts`, `src/custody/facility.ts`, `src/custody/service.ts`, `src/apps/server/index.ts` (all edit), `src/apps/server/custody-inbound-release.test.ts` (create)
- Do:
  1. Add the grant kind `inbound` to `GrantRequest` and the closed set `InboundOperation` with the one value `poll`.
  2. Add `intakeServiceName: string` to the custody `Dependencies` and pass `INTAKE_SERVICE_NAME` from `composeServices`.
  3. In `authorizeOperation`, for `inbound`: require `isServiceIdentity(identity)` and `identity.service === intakeServiceName`, and the operation `poll`, else throw `FacilityError`; check suitability with `{ credential, platform }`; mint a grant with the inbound facts, no execution and no pin.
  4. Add server-composition tests in `src/apps/server/custody-inbound-release.test.ts`, which mint the service identities there (decision D7): a release for `poll` decrypts the newest live revision and pins nothing; the Mission service identity and an operation other than `poll` throw `FacilityError` before the decryption; a platform mismatch refuses; a consumed grant refuses a second release.
- Rules:
  - Each remote call of an inbound takes one single-use operation grant under the service identity of the Intake Service; the one inbound operation is `poll`. `intake-service.impl.md:19–20`.
  - The facility checks that the requester is the Intake service identity and that the operation is `poll`, and it needs no Project decision. `intake-service.impl.md:21`; `custody.impl.md:115`.
  - The Intake Service supplies the inbound facts from its own row, or from the validated input at a create. `intake-service.impl.md:22`.
  - Custody resolves the newest live revision, checks the platform suitability and releases the material. `intake-service.impl.md:23`; decision D24.
  - Tests assert that `release` refuses an inbound operation under another service identity. `custody.impl.md:260`.
- Done when: `node --test --test-timeout=30000 src/apps/server/custody-inbound-release.test.ts` passes; `pnpm run verify` passes.

### 05.4 Add `inboundsNaming` to the credential dependents

- Files: `src/intake/contract.ts`, `src/intake/service.ts`, `src/intake/service.test.ts`, `src/custody/service.test.ts`, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/custody-inbound-release.test.ts` (all edit)
- Do:
  1. Declare inline `IntakeCollaborations { inboundsNaming(tx, credentialName): { inboundId }[] }` in `src/intake/contract.ts`, the shape of `InboundDependent` (`src/custody/contract.ts:154–156`), and implement it in `IntakeService` with one read of `intake_inbound` by `credential`.
  2. Custody already holds `inboundsNaming` in its `Dependencies` and in `credentialDependents` (`src/custody/service.ts:107`, `:607–620`). In `composeServices`, replace the stand-in `options.standIns?.inboundsNaming ?? (() => [])` (`src/apps/server/index.ts:189`) with `(tx, name) => intake.inboundsNaming(tx, name)`, and delete the `inboundsNaming` member of `standIns`.
  3. Removed: the wiring of step 2 covers it.
  4. Add tests: an inbound that names the credential is a dependent; a webhook inbound, which names no credential, is no dependent; the collaboration opens no transaction; in `src/apps/server/custody-inbound-release.test.ts`, `credential.archive` of a credential that an inserted poll row names answers 409 `credential.credential.in_use` with `inbounds: [{ inboundId }]` in `error.details`.
- Rules:
  - An archive calls the Intake collaboration `inboundsNaming(tx, credentialName)` in its transaction, and it answers every inbound that names the credential. `custody.impl.md:33`.
  - A credential archive is refused while an inbound names the credential; the refusal lists `inbounds: [{ inboundId }]`. `docs/reference/erd/03-integration.md:127`; `engine/docs/cli/credential.md:195–196`.
  - The plan that wires the real peer deletes the stand-in. Decision D6.
  - The Intake Service declares one collaboration, `inboundsNaming`. `intake-service.md:34`.
- Done when: `node --test --test-timeout=30000 src/intake/service.test.ts src/custody/service.test.ts src/apps/server/custody-inbound-release.test.ts` passes; `pnpm run verify` passes.

### 05.5 Declare and implement `intake.inbound.create` for the webhook inbound

- Files: `src/intake/contract.ts`, `src/intake/inbound-create.ts` (create), `src/intake/inbound-create.test.ts` (create), `src/intake/service.ts`, `src/apps/server/index.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.create`: `POST /api/intake/inbound`, `access: Human`, `mutation: true`, `status: 201`, body `z.strictObject({ projectId: identitySchema("project"), kind: z.enum(InboundKind), platform: z.enum(InboundPlatform), consumer: z.enum(Consumer), credential: z.string().min(1).optional(), configuration: z.record(z.string(), z.unknown()) })`, output `inboundSchema`.
  2. Add `projects: { get(input, options) }` to the Intake `Dependencies`, a client of `project.get` over `directClient(projectOperations, invocation)`.
  3. Implement the handler: parse `configuration` with `configurationSchemaOf(kind, platform)` and answer 400 `gateway.request.validation_failed` with the issue list on a failure; call `projects.get` with the forwarded human identity and answer 404 `intake.inbound.project_not_found` for a 404; refuse a webhook with a `credential` with 400 `gateway.request.validation_failed`; refuse a `poll` with the same code until plan 07 widens the schema; in `caller.commit`, insert the webhook inbound with a null `credential` and a null `checkpoint`. The create calls no platform.
  4. Keep the shared insert step `commitInbound(tx, id, input, checkpoint)`, which plan 07 calls with the identity that it allocated before its remote validation; it runs `custodySuitability` for a named credential. Add `credentialRefusal(error)`, which maps the custody refusals `credential.credential.not_found` and `credential.platform.mismatch` to 422 `intake.inbound.credential_invalid` and lets every other error pass; `commitInbound` and the release step of plan 07 use it.
  5. Add tests: a webhook inbound inserts one row with no platform call; a webhook with a `credential` answers 400 and inserts nothing; and the answer `id` equals the allocated identity; an unknown project answers 404 and inserts nothing; an unknown consumer and an extra configuration field answer 400; two equal creates with two keys insert two rows; a repeat with the same idempotency key answers the same inbound and inserts nothing; a machine token answers 401 `gateway.authentication.unauthorized`.
- Rules:
  - The create validates the inbound before its insert, and a row exists only for a validated inbound. `intake-service.md:60–61`.
  - A poll names its credential by its name, and a webhook names no credential; kanthord registers no webhook at a platform; a webhook inbound is the one exception to the validation before the insert, and its create validates the project, the platform and the configuration only. `intake-service.md:54`, `:63–65`; `intake-service.impl.md:32`; `docs/reference/erd/03-integration.md:127–128`; `engine/docs/cli/intake.md:197`.
  - The insert transaction checks that the credential name exists and that its platform suits the inbound. `docs/reference/erd/03-integration.md:130`; `intake-service.impl.md:33`.
  - The Intake Service reaches a peer through an operation only. `intake-service.md:33`. The project check uses `project.get` with the forwarded human identity.
  - An inbound names its consumer from the closed set of admission operations. `intake-service.md:196–197`.
  - Statuses: 201; 400; 404 `intake.inbound.project_not_found`; 422 `intake.inbound.credential_invalid`. `engine/docs/cli/intake.md:222–226`.
  - A repeat with the same idempotency key returns the recorded answer; a new invocation creates another inbound. `engine/docs/cli/intake.md:218–220`. The inbound create is the second exception to the natural-key rule beside an evidence submission. `architecture.impl.md:507`, `:726`; `gateway-service.impl.md:412`.
- Done when: `node --test --test-timeout=30000 src/intake/inbound-create.test.ts src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 05.6 Declare and implement `intake.inbound.list` and `intake.inbound.get`

- Files: `src/intake/contract.ts`, `src/intake/inbound-read.ts` (create), `src/intake/inbound-read.test.ts` (create), `src/intake/service.ts`, `src/kernel/log.ts`, `src/kernel/log.test.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.list` (`GET /api/intake/inbound`, `human`, query `{ projectId?, kind?, platform?, limit?, cursor? }`, output a page of `inboundSchema`) and `inbound.get` (`GET /api/intake/inbound/:inboundId`, `human`, output `z.union([webhookInboundSchema, inboundSchema])`).
  2. Implement the list under decision D23 with the filters combined by AND.
  3. Implement the get: 404 `intake.inbound.not_found` for an absent row; for a webhook, add `address: "/hooks/" + id` and `secret: webhookSecret(masterKey, id)`.
  4. Add `"secret"` to the redaction paths of `src/kernel/log.ts` when it is absent, and assert that the log of a get holds no secret.
  5. Add tests: the list pages newest first; each filter; a webhook get answers the address and the secret, a poll get answers neither; an unknown identity answers 404; an identity of another prefix answers 400 `gateway.request.validation_failed` through the HTTP adapter; no log record holds the secret.
- Rules:
  - `intake.inbound.get` returns the address and the secret of a webhook inbound to a human; a `GET` is no mutation, so the idempotency middleware records no secret. `intake-service.impl.md:48`; `engine/docs/cli/intake.md:244–247`.
  - The list is a bounded page filtered by project, kind and platform. `engine/docs/cli/intake.md:53`, `:233–237`.
  - The projection exposes no credential material. `engine/docs/cli/intake.md:205–207`.
  - Gap: the display, redaction and cache contract of the secret is blocked on `engine/docs/cli/intake.md:244–247`; the operation answers it as `intake-service.impl.md:48` rules.
- Done when: `node --test --test-timeout=30000 src/intake/inbound-read.test.ts` passes; `pnpm run verify` passes.

### 05.7 Declare and implement `intake.inbound.delete`

- Files: `src/intake/contract.ts`, `src/intake/inbound-delete.ts` (create), `src/intake/inbound-delete.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `inbound.delete`: `DELETE /api/intake/inbound/:inboundId`, `human`, `mutation: true`, `status: HttpStatus.NoContent`, `output: z.null()`.
  2. Implement the handler in one `caller.commit`: read the row, 404 `intake.inbound.not_found` when absent; 409 `intake.inbound.events_pending` when `pendingEventCount` is above zero; otherwise `deleteInbound`. The delete calls no platform for any kind. Notify the poll loop of plan 07 through `IntakeService.inboundRemoved(id)`, a no-op until plan 07.
  3. Add tests: a delete removes the row and its `succeeded`, `failed` and `discarded` events; a pending event refuses with 409 and keeps the row; a repeat after a success answers 404.
- Rules:
  - A delete calls no platform; a human removes a webhook at the platform after the delete of its webhook inbound. `intake-service.md:67–68`; `engine/docs/cli/intake.md:258`.
  - A delete of an inbound is refused while the inbound holds a pending event; one transaction deletes the events of the inbound and the row. `docs/reference/erd/03-integration.md:132`; `intake-service.md:184`.
  - A delete refuses with 409 when a pending event exists; otherwise one transaction deletes the events and the row. `intake-service.impl.md:34`.
  - Statuses: 204; 404 `intake.inbound.not_found`; 409 `intake.inbound.events_pending`. `engine/docs/cli/intake.md:261–263`.
- Done when: `node --test --test-timeout=30000 src/intake/inbound-delete.test.ts` passes; `pnpm run verify` passes.

### 05.8 Add the CLI leaves of the inbound

- Files: `src/apps/cli/intake.ts`, `src/apps/cli/index.test.ts` (edit)
- Do:
  1. Add the subgroup `inbound` with the leaves of `engine/docs/cli/intake.md:78–91`: `inbound create --file <path> [M] [R]`, `inbound list [--project <id>] [--kind <kind>] [--platform <platform>] [L] [R]`, `inbound get <inbound-id> [R]`, `inbound delete <inbound-id> [M] [R]`.
  2. Read the create file through the shared file helper (`cli.file.*` codes) and send it as the body unchanged.
  3. Validate each positional identity with `identitySchema("inbound")` and refuse it with `cli.intake.inbound.<command>.invalid_inbound_id` (`engine/docs/cli/intake.md:474`).
  4. Print the answer as JSON; a mutation adds `idempotencyKey`; `inbound delete` prints `{ "idempotencyKey": <key> }` for its 204, as the evidence deletes of ERD 2 do (`src/apps/cli/mission-evidence.ts`).
  5. Add tests: help of each leaf without a server; `inbound get bad` exits 1 with `cli.intake.inbound.get.invalid_inbound_id`; `inbound create` without `--file` exits 1.
- Rules:
  - The synopses, the flags and the file schema of the CLI page. `engine/docs/cli/intake.md:78–91`, `:137–201`.
  - The file accepts no verification secret, checkpoint, state, error or arbitrary consumer operation. `engine/docs/cli/intake.md:199–200`; the closed body schema of task 05.5 refuses them.
  - Mutation results include the effective `idempotencyKey`. `engine/docs/cli/intake.md:428`.
  - Gap: the CLI page names no stdout for the 204 of `inbound delete`; step 4 follows the form of the ERD 2 evidence deletes.
- Done when: `node --test --test-timeout=30000 src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 05.E E2E proof

- Files: `src/apps/server/e2e-inbound-store.test.ts` (create)
- Do:
  1. Start `gatewayFixture` and run E05.1 to E05.7 through the CLI in table order.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read. ERD 1 decision D13.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-inbound-store.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-inbound-store.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`; `kanthord(args, env)`; `H` names the human token.
- `webhook.json` names `{ "projectId": <projectId>, "kind": "webhook", "platform": "github", "consumer": "mission.delivery.admit", "configuration": { "resource": "owner/repo" } }`.

Setup: `kanthord project create --name inbounds` → `projectId`.

| Id    | Commands                                                                                                                                                                                                                                                                                                                                         | Exit    | Expect                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E05.1 | `kanthord intake inbound create --file webhook.json`                                                                                                                                                                                                                                                                                             | 0       | `id` matches `^inbound_`, `kind` `webhook`, `credential` null, `checkpoint` null, `configuration` `{ "resource": "owner/repo" }`, `idempotencyKey` a ULID → `W` |
| E05.2 | `kanthord intake inbound create --file webhook.json`                                                                                                                                                                                                                                                                                             | 0       | a second identity `W2` different from `W`                                                                                                                       |
| E05.3 | `kanthord intake inbound get W`; `kanthord intake inbound list --project <projectId>`                                                                                                                                                                                                                                                            | 0, 0    | first `address` `/hooks/W`, `secret` a nonempty string; second `items[].id` `[W2, W]` and no item holds `secret`                                                |
| E05.4 | `kanthord intake inbound create --file unknown-project.json` (`webhook.json` with `"projectId": "project_01ARZ3NDEKTSV4RRFFQ69G5FAV"`); `--file bad-consumer.json` (`webhook.json` with `"consumer": "mission.node.check"`); `--file extra-field.json` (`webhook.json` with `"configuration": { "resource": "owner/repo", "events": ["push"] }`) | 1 each  | stderr starts with `intake.inbound.project_not_found:`, `cli.file.schema_invalid:`, `gateway.request.validation_failed:`                                        |
| E05.5 | `kanthord intake inbound delete W2`; `kanthord intake inbound get W2`; `kanthord intake inbound delete W2`                                                                                                                                                                                                                                       | 0, 1, 1 | first `idempotencyKey` a ULID; then `intake.inbound.not_found:` twice                                                                                           |
| E05.6 | `kanthord intake inbound get bad`                                                                                                                                                                                                                                                                                                                | 1       | stderr starts with `cli.intake.inbound.get.invalid_inbound_id:`                                                                                                 |
| E05.7 | `kanthord intake inbound list --kind push`                                                                                                                                                                                                                                                                                                       | 1       | stderr starts with `gateway.request.validation_failed:`                                                                                                         |

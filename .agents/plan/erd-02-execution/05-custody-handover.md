# Plan 05: Custody component — handover and pin

## Scope

This plan delivers:

- The handover codec of `src/kernel/handover.ts`: the two HKDF keys from the client secret, the additional authenticated data and the AES-256-GCM envelope (decision D13).
- The handover contract of custody: the payload, the refresh report, the pi-ai credential form and the execution credential store builder of the `worker` placement.
- The Worker authorization of a model inference credential for an execution, with the refusal `worker.authorization.refused`.
- The protected facility of custody: the frozen grant in a module-private `WeakSet`, `authorize`, `release(tx, grant, now)` and `Material` with `drop()`.
- The pin at first use through `pinCredential`, the drain check through `liveExecutionsPinning` at each pin, rotation, revoke and credential read, and the refusal 409 `credential.revision.revoked`.
- The custody collaborations `handover` and `report`, with their log records and their redaction paths.
- The operations `worker.handover` and `worker.credential` with their handlers, their OpenAPI and the integration tests through both adapters.
- The CLI leaf `kanthord worker handover <execution-id>`.

Out of scope:

- The `server` placement and the in-process execution view of custody (decision D8; `custody.impl.md:136`).
- The acquisition grant and the presigned storage grant (ERD 3; `project-service.impl.md:218–250`). `release` accepts the one grant kind of this plan.
- The use of the builder inside the native runtime (plan 07) and the handover call, the report calls and the discard inside the `worker` application (plan 09).
- A repository platform key in a handover (decision D19).
- Every B9 item and every open HANDOFF item (decision D1). Each task that meets one states the gap in one line.

## Sources

- `docs/reference/erd/02-execution.md:32`, `:68`, `:303` — the handover is an API answer; the pin is the `credentials` list of `scheduler_execution`; custody appends each pinned revision through `pinCredential`.
- `docs/brainstorm/custody.md:29–35` — the rotation, the pin at first use, the drain, the revoke and the refusal of a revoke of the newest live revision.
- `docs/brainstorm/custody.md:61–78` — secret use, the release inside the server process, the handover, the refresh report, the disablement and the external harness.
- `docs/brainstorm/custody.vocabulary.md:31–45`, `:89–98` — the revision, the drain, the revoke, the protected facility and the handover.
- `docs/brainstorm/custody.impl.md:11–36` — the credential store record, the rotation, the drain and the revoke set `ended_at`, the OAuth refresh in place.
- `docs/brainstorm/custody.impl.md:38–42` — the secret shapes `api_key`, `oauth`, `s3_access_key`.
- `docs/brainstorm/custody.impl.md:85–92` — the two handover keys and their HKDF info.
- `docs/brainstorm/custody.impl.md:94–110` — the protected facility.
- `docs/brainstorm/custody.impl.md:112–125` — `release(grant)`, `Material` and `drop()`.
- `docs/brainstorm/custody.impl.md:127–138` — the credential store of an execution.
- `docs/brainstorm/custody.impl.md:140–157` — the credential handover and the refresh report.
- `docs/brainstorm/custody.impl.md:159–167` — the pin of an execution and the drain check.
- `docs/brainstorm/custody.impl.md:218–233` — the tests of custody.
- `docs/brainstorm/worker-service.impl.md:283–303` — the credential store of an execution and the credential handover.
- `docs/brainstorm/worker-service.impl.md:90–103` — the pi adapter id of each provider.
- `docs/brainstorm/worker-service.md:88`, `:217` — the disablement recalls no handover; a `worker` placement takes its credentials through the handover.
- `docs/brainstorm/gateway-service.impl.md:186–192` — the client secret, derived again from the verified `sub`.
- `docs/brainstorm/gateway-service.impl.md:392–431` — the idempotency of a mutation, the secret route and its redacted record.
- `docs/brainstorm/project-service.md:91–134` — authorization and credential custody.
- `docs/brainstorm/project-service.md:147–156` — the pinned revision and the resolution at each use.
- `docs/brainstorm/architecture.impl.md:592–596` — a Kind 2 collaboration takes the caller transaction and serves an atomic invariant across two owners.
- `docs/brainstorm/project-service.impl.md:186–195`, `:212–216` — the resolution of a binding and the authorization integration.
- `docs/brainstorm/scheduler-service.impl.md:35–40` — `credentials` in `ExecutionRecord`, `pinCredential` and `liveExecutionsPinning`.
- `docs/brainstorm/architecture.impl.md:205–212` — the credential envelope.
- `docs/brainstorm/architecture.impl.md:341–349` — the error code form and the CLI code form.
- `docs/brainstorm/architecture.impl.md:646–659`, `:694–699` — the execution proof and the one commit of a handler.
- `docs/brainstorm/architecture.impl.md:730–731`, `:807` — the handover carries material under encryption; the conformance test exempts it by name.
- `engine/docs/cli/worker.md:104–140`, `:228–238` — the command inventory, `worker.credential` and `handover`.
- `engine/docs/cli/worker.md:711–748` — the error codes of the Worker CLI.
- `engine/docs/cli/credential.md:245–267` — the error codes of the credential group.
- `engine/docs/cli/other.md:186–200`, `:769`, `:785`, `:791`, `:803`, `:834–835` — the output rules, the shared codes and the CLI template codes.
- `engine/docs/cli/common-flags.md:47–48` — `[M]` and `[R]`.
- `engine/.agents/plan/erd-02-execution/00-index.md`, `decisions.md` — the boundary, the seams and decisions D1 to D26.
- `engine/.agents/plan/erd-02-execution/02-worker-registration.md` "Provides" — `MachineIdentity.resourceIdentity`, the no-content answer, the E2E forms.
- `engine/.agents/plan/erd-02-execution/03-scheduler-execution.md` "Provides", tasks 03.5, 03.6 and 03.14, "E2E" — `requireRunning`, `pinCredential`, `liveExecutionsPinning`, the execution proof and the fixture forms.
- `.dev/erd-02/decisions-log.md` entry of 2026-09-30 for plan 05 — the three debate verdicts.
- Root `AGENTS.md` "Contracts", "Database design" and "Rejected proposals".

### Contract keys

Every external key of this plan, with its owner:

| Key                                           | Where                                             | Owner line                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executionId`                                 | body of `worker.handover` and `worker.credential` | `engine/docs/cli/mission.md:717` (`ExecutionContext`); decision D10; debate Q1                                                                         |
| `nonce`, `ciphertext`                         | the envelope of a handover and of a report        | `architecture.impl.md:211`; `src/custody/migrations.ts:10–11`                                                                                          |
| `items`                                       | the handover payload                              | `custody.impl.md:144` "Each item"                                                                                                                      |
| `credentialId`                                | a payload item and a report                       | `custody.impl.md:161` (`pinCredential(tx, executionId, credentialId)`)                                                                                 |
| `providerId`                                  | a payload item                                    | `custody.impl.md:130` (`read(providerId)`); pi-ai 0.86.0 `CredentialInfo.providerId` (`node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:34–37`) |
| `credential`                                  | a payload item and a report: the pi-ai credential | `custody.impl.md:144` "pi-ai credential"; pi-ai `Credential` (`types.d.ts:15–32`)                                                                      |
| `type`, `key`, `refresh`, `access`, `expires` | the pi-ai credential                              | pi-ai `ApiKeyCredential`, `OAuthCredential` (`types.d.ts:15–30`); `custody.impl.md:40–41`                                                              |
| `digest`                                      | a report                                          | `custody.impl.md:149` "the digest of the credential value that it replaces"                                                                            |
| `received`, `idempotencyKey`                  | stdout of `worker handover`                       | `engine/docs/cli/worker.md:235` "prints only a status"; `engine/docs/cli/other.md:199–200`                                                             |

## Depends on

- ERD 1, merged. `CustodyComponent` (`src/custody/service.ts:78–930`), the envelope (`src/custody/envelope.ts:25–66`), the secret schemas (`src/custody/platforms.ts:18–45`), `deriveKey`, `digest` and `canonicalJSON` (`src/kernel/json.ts:12–62`), `deriveClientSecret` (`src/gateway/local.ts:56–60`), `workerAgentView` (`src/worker/service.ts:560–605`), `readBindingRevision`, `readLatestBinding` and `hasBindingTombstone` (`src/project/store.ts:356`, `:562–592`), the redaction paths (`src/kernel/log.ts:16–39`) and the composition root (`src/apps/server/index.ts:62–191`).
- Plan 02, through `00-index.md` "Seams": `MachineIdentity.resourceIdentity`; `kanthord worker register` over `worker_instance`; the no-content answer of an operation with `status: HttpStatus.NoContent`.
- Plan 03, through `00-index.md` "Seams": `SchedulerClaims.requireRunning(tx, executionId, runtimeIdentity, now): ExecutionRow`, whose row holds `credentials`; `pinCredential` and `liveExecutionsPinning`; the execution proof with `requiresExecution`, `caller.execution` and the body field `executionId` (task 03.6); the proof before the idempotency reservation; the CLI leaves `scheduler work pull`, `execution get` and `execution release`.
- No stand-in. Every seam that this plan consumes exists before it runs, and this plan adds no `unwired` entry (decision D6).

## Approved client-entry repair

Ulrich approved the Plan05 B1 repair on 2026-10-02. `architecture.impl.md` "Application source layout" and its import-boundary rules permit `apps/worker` to import Custody's public `client.ts`. `custody.impl.md` "The credential store of an execution" owns its three exports: `executionCredentialStore`, `ExecutionStoreError` and `ExecutionCredentials`. Schemas and types remain declared directly in `contract.ts`, which imports only kernel and `zod`. Internal normalization and secret conversion remain in `payload.ts`; the builder imports schemas from `contract.ts` and normalization from `payload.ts`. The client entry exposes the builder without importing the server composition entry. Task05.3 adds the narrow `apps/worker` to `custody/client.ts` lint permission.

This repair also names the private revision helper `drainRevisions`, avoiding the existing lifecycle `Service.drain`. It grants no publication of a missing CLI error declaration. Preserve the original Plan05 review baseline `53e6f6a4759a5b5bb43e0ef98c34a8b598ef93f9` and all already-verified independent task commits.

## Provides

### Approved serialized-credential budget refinement

Ulrich approved P05-B1 on 2026-10-02. `custody.impl.md` "Serialized credential budget" owns the maximum 48,915 UTF-8 bytes of normalized canonical pi-ai credential JSON for `api_key` and `oauth`, excluding `s3_access_key`. `worker-service.impl.md` "The credential handover" retains the 65,536-byte report body limit and unconditional release reporting. The bound includes JSON structure and escaping, not merely credential string lengths.

- Task05.2 refines the shared credential schema and platform admission so creation, rotation and OAuth login persistence enforce the same budget. Existing HTTP 400 `credential.input.invalid` covers create/rotate; OAuth completion uses the existing sanitized failed-session path and stores nothing.
- Task05.3 enforces that schema at execution-store construction and refresh normalization before changing any state. Oversized local inputs reject without material in errors; no oversized replacement changes stored material or execution-store state.
- Tasks05.7/05.8 validate the budget in decrypted reports with existing HTTP 400 `custody.handover.report_invalid`. Keep the request limit and Gateway's pre-handler413 refusal unchanged.
- The accepted-fix batch may edit the owning Custody schema, payload, platform, login, store and handover implementation/tests and the composition-owned integration tests needed to prove these paths. It adds no new task identity, error code or import-boundary exception. Preserve all completed-task evidence and record the repair under05.R.
- Boundary proof covers both credential shapes, aggregate OAuth fields, multibyte UTF-8 and JSON escaping. The maximum credential yields a65,533-byte compact report through the public builder and HTTP204; one more canonical byte would yield65,537 and must refuse at every applicable admission gate without a write or replacement. Cover direct decrypted-report refusal and HTTP413 separately with offline provider fakes.
- After the accepted repair passes focused checks and full verification, rerun fullE05 and independent acceptance. P05-B2's missing review coverage remains a separate gate; this ruling neither completes that coverage nor authorizes changes to the reviewer guard. Original baseline `53e6f6a4759a5b5bb43e0ef98c34a8b598ef93f9` remains permanent.

### Provided seams

| Seam                                    | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                 | Owner file                                                                               | Consumer plans |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------- |
| Handover codec                          | `deriveHandoverKeys(clientSecret: string): { handover: Buffer; report: Buffer }`; `handoverAad(executionId: string, runtimeIdentity: string): Buffer`; `sealEnvelope(key: Buffer, aad: Buffer, value: unknown): HandoverEnvelope`; `openEnvelope(key: Buffer, aad: Buffer, envelope: HandoverEnvelope): unknown`; `handoverEnvelopeSchema` = `{ nonce: string; ciphertext: string }` | `src/kernel/handover.ts`                                                                 | 05, 09         |
| Handover contract                       | `piCredentialSchema`; `handoverPayloadSchema` = `{ items: { credentialId; providerId; credential }[] }`; `refreshReportSchema` = `{ credentialId; digest; credential }`; internal `normalizeCredential(credential: Credential): Credential`                                                                                                                                          | Schemas/types in `src/custody/contract.ts`; internal helpers in `src/custody/payload.ts` | 07, 09         |
| `executionCredentialStore`              | `(payload: HandoverPayload, report: (report: RefreshReport) => Promise<void>) => { store: CredentialStore; release(): Promise<void>; discard(): void }`                                                                                                                                                                                                                              | `src/custody/execution-store.ts`, exported by `src/custody/client.ts`                    | 07, 09         |
| `WorkerService.authorizeModelInference` | `(tx: Transaction, identity: MachineIdentity, execution: { executionId: string; projectId: string; workerBindingId: string; resourceIdentity: string }): { credential: string; platform: string; providerId: string; agentProvider: string }`                                                                                                                                        | `src/worker/service.ts`                                                                  | 05             |
| `CustodyComponent.authorize`, `release` | `authorize(tx: Transaction, identity: MachineIdentity, execution: CustodyExecution): Grant`; `release(tx: Transaction, grant: Grant, now: number): Material`, with `Material = { credentialId; platform; value(): unknown; drop(): void }`                                                                                                                                           | `src/custody/service.ts`                                                                 | 05, ERD 3      |
| `CustodyComponent.handover`, `report`   | `handover(tx: Transaction, identity: MachineIdentity, execution: { executionId: string; runtimeIdentity: string }, now: number): HandoverEnvelope`; `report(tx: Transaction, identity: MachineIdentity, execution: { executionId: string; runtimeIdentity: string }, envelope: HandoverEnvelope, now: number): void`                                                                 | `src/custody/service.ts`                                                                 | 05 (Worker)    |
| `worker.handover`, `worker.credential`  | Operations of `workerOperations` (task 05.8)                                                                                                                                                                                                                                                                                                                                         | `src/worker/contract.ts`                                                                 | 09, 10         |

Four differences from `00-index.md` "Seams":

- The protected facility consumes Worker authorization for model inference and Mission authorization for a FrozenAction, request evidence or evidence asset. Custody mints its own grant; callers supply no association. See `worker-service.impl.md` "The credential store of an execution" and `mission-service.impl.md` "Authorization integration".
- `Custody.executionStorePayload(tx, executionId, agentProvider)` of the index is `Custody.handover`, which answers the sealed envelope. The payload never leaves custody in plaintext on the server.
- The builder `executionCredentialStore` is a new row. Its consumers are plans 07 and 09.
- `release` takes the transaction and the clock reading of its caller (`00-index.md` "The clock of a transaction").

## Tasks

### 05.1 Add the handover codec

- Files: `src/kernel/handover.ts` (create), `src/kernel/handover.test.ts` (create), `engine/AGENTS.md` (edit)
- Do:
  1. Declare `HANDOVER_KEY_INFO = "handover/server-to-worker/v1"`, `REPORT_KEY_INFO = "handover/worker-to-server/v1"`, `HANDOVER_CIPHER = "aes-256-gcm"`, `HANDOVER_NONCE_BYTES = 12`, `HANDOVER_TAG_BYTES = 16` and `HANDOVER_AAD_LENGTH_BYTES = 4`.
  2. Implement `deriveHandoverKeys(clientSecret)`: `{ handover: deriveKey(clientSecret, HANDOVER_KEY_INFO), report: deriveKey(clientSecret, REPORT_KEY_INFO) }` with `deriveKey` of `src/kernel/json.ts:52–62`.
  3. Implement `handoverAad(executionId, runtimeIdentity)`: the concatenation of each value as a 4-byte big-endian length and its UTF-8 bytes, in that order.
  4. Export `handoverEnvelopeSchema = z.strictObject({ nonce: z.string().min(1), ciphertext: z.string().min(1) })` and `type HandoverEnvelope`.
  5. Implement `sealEnvelope(key, aad, value)`: a random 12-byte nonce from `randomBytes`, `createCipheriv` with a 16-byte tag, `setAAD(aad)`, the UTF-8 bytes of `canonicalJSON(value)`, and the answer `{ nonce, ciphertext }` in canonical base64, where `ciphertext` holds the encrypted bytes followed by the tag.
  6. Implement `openEnvelope(key, aad, envelope)`: decode both fields; refuse a value that is not canonical base64, a nonce of another length and a ciphertext of 16 bytes or fewer; decrypt with the tag; answer `JSON.parse` of the plaintext. Every failure throws `HandoverOpenError`, a class of this module that holds no plaintext, no key and no cause.
  7. Add tests: a round trip; another execution identity, another runtime identity, the other key, a changed byte, a truncated ciphertext, a short nonce and a value that is not base64 each throw `HandoverOpenError`; two seals of one value answer different nonces; the keys equal `hkdfSync("sha256", Buffer.from(clientSecret, "base64"), Buffer.alloc(0), info, 32)` for each info; the AAD of `("ab", "c")` differs from the AAD of `("a", "bc")`.
  8. Add `handover.ts  # Handover keys, additional authenticated data and envelope codec` to the `src/kernel/` entry of `engine/AGENTS.md`.
- Rules:
  - The kernel module owns the codec alone; custody owns the payload selection and the pin. Decision D13.
  - The keys derive from the client secret through `crypto.hkdfSync` with SHA-256 and an empty salt; the info of each direction is fixed. `custody.impl.md:88–89`.
  - AES-256-GCM uses the key of its direction, a random 12-byte nonce and a 16-byte tag. `custody.impl.md:145`; `architecture.impl.md:211`.
  - The AAD concatenates the length-prefixed execution identity and runtime identity. `custody.impl.md:146`; decision D13.
  - An error of the codec holds no material. `custody.impl.md:119`.
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
- Done when: `node --test --test-timeout=30000 src/kernel/handover.test.ts` passes; `pnpm run verify` passes.

### 05.2 Declare the handover contract of custody

- Files: `src/custody/payload.ts` (create), `src/custody/payload.test.ts` (create), `src/custody/contract.ts` (edit), `src/custody/platforms.ts` (edit)
- Do:
  1.  In `src/custody/contract.ts`, use `zod` and `identitySchema` from `../kernel/identity.ts` for the handover schemas. Declare `SecretShape` there and re-export it from `platforms.ts` for existing internal consumers. In `src/custody/payload.ts`, import `type Credential` from `@earendil-works/pi-ai` and the schemas from `./contract.ts`; the contract imports no payload implementation.
  2.  In `contract.ts`, export `piCredentialSchema = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("api_key"), key: <nonblank string> }), z.strictObject({ type: z.literal("oauth"), refresh: z.string().min(1), access: z.string().min(1), expires: z.number().int() })])`. The `type` values are the members `api_key` and `oauth` of `SecretShape`.
  3.  In `contract.ts`, export `handoverPayloadSchema = z.strictObject({ items: z.array(z.strictObject({ credentialId: identitySchema("credential"), providerId: z.string().min(1), credential: piCredentialSchema })) })`, `refreshReportSchema = z.strictObject({ credentialId: identitySchema("credential"), digest: z.string().regex(SHA256_HEX_PATTERN), credential: piCredentialSchema })` with `SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/`, and the types `HandoverPayload`, `RefreshReport`.
  4.  In the internal `payload.ts`, export `normalizeCredential(credential: Credential): Credential`: an `api_key` credential answers `{ type, key }`, an `oauth` credential answers `{ type, refresh, access, expires }`, and every other field drops. A credential that `piCredentialSchema` refuses throws.
  5.  Export `credentialOfSecret(shape, secret)` and `secretOfCredential(credential)`: the maps between a stored secret of shape `api_key` or `oauth` and its normalized pi-ai credential. An `s3_access_key` shape throws, because no handover carries it.
  6.  Add tests: each map round-trips both shapes; `normalizeCredential` drops an extra OAuth field; the digest of `normalizeCredential` of a credential with an extra field equals the digest of the credential without it; each schema refuses an extra key; the payload refuses a credential identity of another prefix.
- Rules:
  - The payload is canonical JSON of the provider credential that the execution requires; each item holds the record identity, the pi adapter id and the pi-ai credential. `custody.impl.md:143–144`.
  - The handover carries the credential of the effective agent provider alone. Decision D19; `worker-service.impl.md:285`.
  - The OAuth secret shape is `{ refresh, access, expires }`. `custody.impl.md:41`; `src/custody/platforms.ts:39–43`.
  - A refresh report carries the digest of the credential value that it replaces. `custody.impl.md:149`. The digest is `digest` of `src/kernel/json.ts:46–50` over the normalized credential, so both ends compute one value.
  - The payload schema lives directly in Custody's `contract.ts`, not in the kernel, because the kernel owns the codec alone. Decision D13. The contract imports only kernel and `zod`; internal `payload.ts` imports the schemas. The worker application imports schemas from `contract.ts` and the builder through `client.ts` under the approved client-entry repair. No contract-to-implementation re-export or import cycle forms.
  - Every field name follows the table "Contract keys". Root `AGENTS.md` "Contracts".
- Done when: `node --test --test-timeout=30000 src/custody/payload.test.ts` passes; `pnpm run verify` passes.

### 05.3 Add the execution credential store builder

- Files: `src/custody/execution-store.ts` (create), `src/custody/execution-store.test.ts` (create), `src/custody/client.ts` (create), `eslint.config.js` (edit), `engine/AGENTS.md` (edit)
- Do:
  1. Implement `executionCredentialStore(payload, report)`. Assert that `payload.items` holds one item. Keep `current` and `reported`, both the normalized credential of the item.
  2. `read(providerId)`: a copy of `current` when `providerId` equals the `providerId` of the item, else `undefined`.
  3. `list()`: `[{ providerId, type }]` of the item.
  4. `modify(providerId, fn)`: serialize every call on one promise chain. Throw for another `providerId`. Call `fn(current)`. An `undefined` answer changes nothing. Otherwise normalize the answer, throw when its `type` differs from the `type` of `current`, and set `current`. When the digest of `current` differs from the digest of `reported`, await `report({ credentialId, digest: digest(reported), credential: current })` and then set `reported = current`. Answer a copy of `current`.
  5. `delete(providerId)`: throw `ExecutionStoreError` with the message "The execution credential store refuses deletion.".
  6. `release()`: await `report({ credentialId, digest: digest(reported), credential: current })` once and set `reported = current`.
  7. `discard()`: drop `current` and `reported`; every later `read` answers `undefined`, and every later `modify` and `release` throws.
  8. Import schemas/types from `./contract.ts` and `normalizeCredential` from `./payload.ts`. Export `executionCredentialStore`, `ExecutionStoreError` and `type ExecutionCredentials` from `src/custody/client.ts` with `export { … } from "./execution-store.ts"`. Add only the `apps-worker` permission for Custody's `client.ts` in `eslint.config.js`; preserve the contract import restrictions and other service-private boundaries. Verify that the public entry resolves and is assignable to the required client API.
  9. Add tests: `read` of another adapter id answers `undefined`; `list` holds no secret; two concurrent `modify` calls run one after the other and each `fn` sees the result of the first; a refresh calls `report` once with the digest of the handed-over value; an unchanged answer calls no `report`; a second refresh reports the digest of the first refreshed value; `release` reports the current value with the digest of the last reported value; a rejected `report` rejects `modify`; `delete` throws; `discard` clears the store; two builders of two payloads share no value.
  10. Add `payload.ts`, `execution-store.ts` and the public `client.ts` to the `src/custody/` entry of `engine/AGENTS.md`.
- Rules:
  - The view exposes only the credential of the effective agent provider under the pi adapter id; `read(providerId)` answers `undefined` for every other id. `worker-service.impl.md:286–287`.
  - `list()` answers the non-secret pair of adapter id and credential type. `custody.impl.md:132`.
  - `modify()` serializes and writes the pi-ai result in place; the view refuses `delete()`. `custody.impl.md:134–135`.
  - At the `worker` placement the view reads the decrypted handover; the store holds the credential of one execution. `custody.impl.md:137`; `worker-service.impl.md:289`.
  - The application reports after each refresh and once at the release, and holds the plaintext in memory alone. `worker-service.impl.md:296–298`.
  - Custody implements the `CredentialStore` of pi-ai 0.86.0. `custody.impl.md:129–130`; `types.d.ts:57–79`.
  - Gap: a report that the application cannot deliver leaves the server with the replaced value; the builder propagates the rejection, and the retry policy stays with the `worker` application under B9 "Cannot progress" (`docs/brainstorm/HANDOFF.md:89`).
- Done when: `node --test --test-timeout=30000 src/custody/execution-store.test.ts` passes; `pnpm run verify` passes.

### 05.4 Add the Worker authorization of a model inference credential

- Files: `src/worker/contract.ts` (edit), `src/worker/service.ts` (edit), `src/worker/authorization.ts` (add), `src/worker/authorization.test.ts` (add)
- Do:
  1. Add `AuthorizationRefused: "worker.authorization.refused"` to `WorkerErrorCode` (`src/worker/contract.ts`). Declare the closed set `AuthorizationRefusal` with `binding_mismatch`, `binding_removed`, `binding_disabled` and `no_native_agent`.
  2. Implement `authorizeModelInference(tx, identity, execution)` in `WorkerService`:
     1. Resolve the pinned worker row through Project's `workerBindingRowOf(tx, execution.workerBindingId)`. Refuse with `binding_mismatch` when absent or when its project or resource identity differs from the execution or machine identity.
     2. Refuse a tombstoned row with `binding_removed` and a disabled row with `binding_disabled`. Project resolves current removal and disablement for the pinned revision.
     3. Resolve the native agent from the Worker declaration. Refuse with `no_native_agent` if absent.
     4. Select its pinned entry and call `workerAgentView`. When `view.valid` is false, throw `OperationError(400, view.issues[0].code, "The agent configuration is not valid.", { issues: view.issues })`.
     5. Answer `{ credential: effective.credential, platform: effective.provider, providerId: effective.provider, agentProvider: effective.agentProvider }`.
  3. Each refusal throws `OperationError(403, "worker.authorization.refused", "The facility refuses the operation.", { reason })`.
  4. Add tests: a valid chain answers the credential and the adapter id of the entry; the entry override wins over the default; each reason of `AuthorizationRefusal` refuses; a disabled enablement answers 400 `worker.agent.enablement.unavailable` with `details.issues`; a revision of the binding after the claim keeps the entry of the pinned row.
- Rules:
  - For a machine identity, the facility checks the binding of that project for the operation and consults custody after that check. `project-service.md:120–121`.
  - The chain holds: the JWT names the client identity and the worker binding, and the live claim names that binding. A break refuses before ciphertext access. `custody.impl.md:106–109`.
  - A model inference call resolves through the worker binding and the selected agent provider, never a credential relationship with a project. `custody.impl.md:110`; `custody.md:65–66`.
  - Every use reads the configuration of the pinned revision; a disablement and a removal refuse every use whatever revision a record pins. `project-service.md:147–150`; `project-service.impl.md:189–191`.
  - For an agent configuration the Project Service asks the Worker Service and merges no configuration itself. `project-service.impl.md:189–190`.
  - A disablement takes effect at the next resolution. `custody.md:73`; `worker-service.md:88`. The issue codes are the 400 codes of `engine/docs/cli/worker.md:728–732`, `:742`.
  - No credential reaches an external harness. `custody.md:74`; `project-service.md:88`. A worker without a native agent answers `no_native_agent`.
  - `worker.authorization.refused`: 403; the four reasons are ruled by `worker-service.impl.md` "The credential store of an execution" and published in `engine/docs/cli/worker.md`.
  - The registrations of a removed or disabled worker binding end in the write of the binding set (plan 02 task 02.14), so the proof of the chain meets most breaks first; this check stays as the page rule.
  - `authorizeModelInference` is a Kind 2 collaboration of custody on the Worker Service. A pin names a revision resolved in the same transaction, so no disablement or removal commits between the check and pin. See `worker-service.impl.md` "The credential store of an execution".
  - Gap: the resolution records the identity of every revision of the chain (`project-service.impl.md:192`); no page names that record, so this plan records the credential revision in `credentials` and the log record of task 05.7 alone.
- Done when: `node --test --test-timeout=30000 src/worker/authorization.test.ts` passes; `pnpm run verify` passes.

### 05.5 Wire the custody collaborations and add the drain check

- Files: `src/custody/contract.ts` (edit), `src/custody/service.ts` (edit), `src/custody/service.test.ts` (edit), `src/apps/server/index.ts` (edit), `src/apps/server/e2e-custody.test.ts` (edit)
- Do:
  1. Declare inline in `src/custody/contract.ts`: `CustodyExecution = { executionId: string; projectId: string; workerBindingId: string; resourceIdentity: string; runtimeIdentity: string; credentials: string[] }`; `CustodyExecutions { requireRunning(tx, executionId, runtimeIdentity, now): CustodyExecution; pinCredential(tx, executionId, credentialId): void; liveExecutionsPinning(tx, credentialId): string[] }`; `ModelInferenceAuthorization = { credential; platform; providerId; agentProvider }`; `CustodyAuthorization { authorizeModelInference(tx, identity: MachineIdentity, execution: { executionId; projectId; workerBindingId; resourceIdentity }): ModelInferenceAuthorization }`.
  2. Add `executions: CustodyExecutions`, `authorization: CustodyAuthorization` and `clientSecret: (clientId: string) => string` to `Dependencies` (`src/custody/service.ts:78–88`) as required fields.
  3. Implement the private `drainRevisions(tx, name, now)`: read the live rows of the name ordered by `revision` descending; for each row after the first, set `ended_at = now` when `liveExecutionsPinning(tx, row.id)` answers an empty list. Keep the existing `Service.drain` lifecycle hook distinct.
  4. Call `drainRevisions` in the transaction of `rotate` after the insert, of `revoke` after the update, of `get` before the answer, and of `list` for each name of the page before its answer. Each transaction reads `Date.now()` once.
  5. In `src/apps/server/index.ts`, pass `executions: { requireRunning: (tx, e, r, now) => scheduler.requireRunning(tx, e, r, now), pinCredential: (tx, e, c) => scheduler.pinCredential(tx, e, c), liveExecutionsPinning: (tx, c) => scheduler.liveExecutionsPinning(tx, c) }`, `authorization: { authorizeModelInference: (tx, i, e) => worker.authorizeModelInference(tx, i, e) }` and `clientSecret: (clientId) => deriveClientSecret(options.config.masterKey, clientId)` with `deriveClientSecret` of `src/gateway/local.ts:56–60`.
  6. In `src/custody/service.test.ts`, give `fixture()` (`:94–128`) the option `pins: Map<string, string[]>` and the defaults: `liveExecutionsPinning` answers `pins.get(id) ?? []`, `pinCredential` records its call, `requireRunning` and `authorizeModelInference` throw `UNEXPECTED_COLLABORATION`, and `clientSecret` answers a fixed canonical base64 value of 32 bytes.
  7. Rewrite the unit tests that revoke revision 1 after a rotation (`:549–579`, `:581–613`, `:615–662`) so that `pins` holds a live execution for revision 1 before the rotation.
  8. Add unit tests: a rotation with no pin drains revision 1 in its transaction and a revoke of it answers 409 `credential.revision.ended`; a rotation keeps a pinned revision 1 live; `get` drains revision 1 after its pin ends; `list` drains each name of the page; a revoke drains an unpinned older revision beside the revoked one; the newest live revision never drains.
  9. Rewrite E01.10 of `src/apps/server/e2e-custody.test.ts` (`:250–274`) as "E01.10 a rotation drains an unpinned revision 1": create, rotate, `credential get` shows `endedAt` of revision 1 as a number and of revision 2 as null, and `credential revoke <name> 1` exits 1 with stderr that starts with `credential.revision.ended:`. E01.11 stays unchanged.
- Rules:
  - The drain check calls `liveExecutionsPinning` for each live revision that is not the newest and drains a revision that no live execution pins; custody runs it at each pin, rotation, revoke and credential read. `custody.impl.md:165–166`.
  - The rotation transaction drains each older revision that no live execution pins; the revoke of a pinned revision moves to scenario E05.8. `custody.md:29`; `custody.impl.md:24` (ruled 2026-09-30).
  - A drain and a revoke set `ended_at`. `custody.impl.md:25`.
  - Custody refuses a revoke of the newest live revision. `custody.md:35`; `src/custody/service.ts:707–717`.
  - One store connection runs every transaction to its end, so no pin interleaves with a rotation. `architecture.impl.md:106–112`.
  - A collaboration takes the caller transaction and opens none. `architecture.impl.md:592–598`.
  - Every collaboration is required; the colocated tests inject fakes. Decision D4.
  - The composition root is the only file that imports cross-service code. `00-index.md` "Collaboration-type contract rule".
  - Gap: `deriveClientSecret` uses the fixed info `worker/client-secret/v1/` (`src/gateway/local.ts:19`), not `v<tokenVersion>` (`gateway-service.impl.md:189`); this is a pre-existing deviation (decision D26).
- Done when: `node --test --test-timeout=30000 src/custody/service.test.ts src/apps/server/e2e-custody.test.ts` passes; `pnpm run verify` passes.

### 05.6 Add the protected facility and the release

- Files: `src/custody/facility.ts` (create), `src/custody/facility.test.ts` (create), `src/custody/service.ts` (edit), `src/custody/contract.ts` (edit)
- Do:
  1. In `src/custody/facility.ts`, keep a module-private `WeakSet<object>` of grants. Export `mintGrant(fields)`, which freezes `{ credential, platform, execution }` and adds it to the set, and `consumeGrant(grant)`, which throws `FacilityError` unless the set holds the grant and deletes it before it answers.
  2. Export `class MaterialBuffer` that holds the UTF-8 bytes of `canonicalJSON(secret)`: `value()` answers `JSON.parse` of the bytes, `drop()` fills the buffer with zero, and `value()` after `drop()` throws `FacilityError`.
  3. Declare `type Grant` and `type Material = { readonly credentialId: string; readonly platform: string; value(): unknown; drop(): void }` in `src/custody/contract.ts`.
  4. Implement `authorize(tx, identity, execution)` in `CustodyComponent`: call `authorization.authorizeModelInference(tx, identity, execution)` and answer `mintGrant({ credential, platform, execution })`.
  5. Implement `release(tx, grant, now)` in this order:
     1. `consumeGrant(grant)`.
     2. Read every row of `grant.credential`. Take the row whose `id` the list `grant.execution.credentials` holds.
     3. For such a pinned row, throw 409 `credential.revision.revoked` when its `ended_at` is set.
     4. With no pinned row, take the newest live row (`newestLive`, `src/custody/service.ts:183–189`), throw 404 `credential.credential.not_found` when it is absent, call `executions.pinCredential(tx, grant.execution.executionId, row.id)`, and call `drainRevisions(tx, name, now)`.
     5. Throw 400 `credential.platform.mismatch` when the row platform differs from `grant.platform`.
     6. Decrypt the row with `decrypt` (`src/custody/envelope.ts:44–66`) and answer a `MaterialBuffer` with the row identity and platform.
  6. Add tests: a first release pins the newest live revision and appends one identity; a second release in the same execution reads the pinned revision after a rotation; another execution pins the new revision; a revoked pinned revision answers 409 `credential.revision.revoked`; a consumed grant, a fabricated grant of the same shape and a frozen copy each throw `FacilityError`; `drop()` clears the buffer after a success and after a failure of the holder in a `finally` block; a platform mismatch refuses before decryption; a refusal of the Worker authorization reaches no decryption; no answer and no error holds the secret.
- Rules:
  - A module-private `WeakSet` records each frozen grant, so a caller cannot fabricate one; custody consumes a grant at its first use, and a consumed grant authorizes no second operation. `custody.impl.md:98–100`.
  - The facility consumes Worker authorization for inference and Mission authorization for a FrozenAction, request evidence or evidence asset, before ciphertext access.
  - `release` checks and consumes the grant, resolves the pinned or the newest live revision, checks suitability, decrypts and returns `Material` inside the process. `custody.impl.md:114–117`.
  - At the first use of a credential name in an execution custody resolves the newest live revision and pins it in the same transaction; a later use reads the pinned revision; a use of a revoked revision answers 409 `credential.revision.revoked`. `custody.impl.md:161–164`; `engine/docs/cli/credential.md:267`.
  - Suitability compares the record platform with the requested platform before any remote call. `custody.impl.md:78–80`; `engine/docs/cli/credential.md:260`.
  - The holder clears the buffer through `drop()` in a `finally` block. `custody.impl.md:121`.
  - An older revision takes no new pin. `custody.md:33`.
  - Gap: the acquisition grant is ERD 3, so the test "release refuses an acquisition grant" of `custody.impl.md:229` waits for the ERD 3 plan set.
- Done when: `node --test --test-timeout=30000 src/custody/facility.test.ts src/custody/service.test.ts` passes; `pnpm run verify` passes.

### 05.7 Add the custody handover and the refresh report

- Files: `src/custody/handover.ts` (create), `src/custody/handover.test.ts` (create), `src/custody/service.ts` (edit), `src/kernel/log.ts` (edit)
- Do:
  1. Implement `handover(tx, identity, execution, now)` in `CustodyComponent`:
     1. `row = executions.requireRunning(tx, execution.executionId, execution.runtimeIdentity, now)`.
     2. `grant = authorize(tx, identity, row)`; `material = release(tx, grant, now)`.
     3. In a `try` block, build the payload `{ items: [{ credentialId: material.credentialId, providerId, credential: credentialOfSecret(PLATFORM_SECRET_SHAPE[platform], material.value()) }] }` and seal it with `sealEnvelope(deriveHandoverKeys(clientSecret(identity.clientId)).handover, handoverAad(row.executionId, row.runtimeIdentity), payload)`. Call `material.drop()` in the `finally` block.
     4. Log `{ executionId, workerBindingId, credentialId }` with the message `credential handover`. Answer the envelope.
  2. Implement `report(tx, identity, execution, envelope, now)`:
     1. `row = executions.requireRunning(…)`.
     2. Open the envelope with the report key and the AAD of the row. A `HandoverOpenError` throws 400 `custody.handover.report_invalid`.
     3. Parse `refreshReportSchema`. A failure throws 400 `custody.handover.report_invalid`.
     4. Throw 400 `custody.handover.report_invalid` when `row.credentials` does not hold `credentialId`.
     5. Read the stored row by identity. Throw 409 `credential.revision.revoked` when its `ended_at` is set. Throw 400 `custody.handover.report_invalid` when `PLATFORM_SECRET_SHAPE[platform]` differs from `credential.type`.
     6. Decrypt the stored secret. When `digest(credentialOfSecret(shape, stored))` differs from `report.digest`, log `{ executionId, credentialId }` with the message `credential report stale` and write nothing.
     7. Otherwise encrypt `secretOfCredential(report.credential)` with `encrypt(envelopeKey, id, platform, …)` and update `nonce` and `ciphertext` of that row alone. Log `{ executionId, credentialId }` with the message `credential report`.
  3. Declare `CUSTODY_REPORT_INVALID = "custody.handover.report_invalid"` (`code: proposed`) and `REVISION_REVOKED = "credential.revision.revoked"` in `CustodyErrorCode` (`src/custody/service.ts:90–105`).
  4. Put the payload and report steps in `src/custody/handover.ts` as functions over their inputs, and keep the two methods in `service.ts` as the transaction steps, so `service.ts` grows by fewer than about 80 lines.
  5. Add `"payload"`, `"material"` and `"report"` to `redactionPaths` (`src/kernel/log.ts:16–39`); `src/kernel/log.test.ts:16` asserts each path.
  6. Add tests with fakes of `requireRunning` and `authorizeModelInference`: the round trip opens with the keys of the client secret and the AAD of the execution; another execution identity and the report key refuse; a truncated ciphertext refuses; a report writes the new value in place and adds no revision; a replayed earlier report writes nothing; a report sealed with the handover key, a report of an unpinned revision, a report of another type and a report of a malformed digest answer 400 `custody.handover.report_invalid`; a report of a revoked revision answers 409; a `requireRunning` refusal reaches no decryption; each log record holds the execution identity and the record identity and no secret; a refusal of `authorizeModelInference` pins nothing.
- Rules:
  - The payload holds the provider credential that the execution requires; each item holds the record identity, the pi adapter id and the pi-ai credential. `custody.impl.md:143–144`; decision D19.
  - Custody derives the client secret again from the verified `sub`; the handover uses the handover key and a report uses the refresh-report key. `custody.impl.md:145–148`; `gateway-service.impl.md:191`.
  - A report writes the new value in place only when the stored value has its digest, in the same transaction, so a replayed earlier report writes nothing. `custody.impl.md:149`.
  - An OAuth refresh writes the pinned revision in place and adds no revision. `custody.impl.md:26`.
  - The handover carries the revisions that the execution pins, and two executions can hold one revision at once. `custody.impl.md:152`, `:154`.
  - Custody refreshes no pinned revision on the server while a live execution at the `worker` placement holds it. `custody.impl.md:153`. The server of ERD 2 performs no OAuth refresh at all: the healthcheck refreshes nothing (`custody.impl.md:213`) and no `server` placement exists (decision D8).
  - Every execution mutation repeats the full proof in its write transaction and answers 409 `scheduler.execution.not_running`. `architecture.impl.md:656–657`; `engine/docs/cli/scheduler.md:506`.
  - Custody logs the execution identity and the record identity of each handover and report, never material; `pino` redacts the payload paths. `custody.impl.md:156–157`, `:119–120`.
  - `custody.handover.report_invalid` (`code: proposed`, `00-index.md` "Codes for Ulrich"): 400; the conditions are a failed tag, a malformed envelope, a malformed report, a revision that the execution does not pin and a credential type that differs from the secret shape of the platform. `custody.impl.md:148–149`. No shared code covers it: `gateway.request.validation_failed` checks the operation input only, and the envelope opens inside the handler.
  - Gap: two live processes of one machine JWT pass every proof and each receives a handover; Ulrich accepts the risk until the B9 item lands (`docs/brainstorm/HANDOFF.md:115`).
- Done when: `node --test --test-timeout=30000 src/custody/handover.test.ts src/kernel/log.test.ts` passes; `pnpm run verify` passes.

### 05.8 Declare `worker.handover` and `worker.credential`

- Files: `src/worker/contract.ts` (edit), `src/worker/service.ts` (edit), `src/worker/service.test.ts` (edit), `src/apps/server/index.ts` (edit), `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml` (regenerated), `static/openapi/**` (regenerated)
- Do:
  1. In `src/worker/contract.ts`, declare `HANDOVER_TIMEOUT_MS = 30000`, `HANDOVER_MAX_BODY_BYTES = 1024` and `CREDENTIAL_REPORT_MAX_BODY_BYTES = 64 * 1024`, and declare inline `CustodyHandover { handover(tx, identity: MachineIdentity, execution: { executionId: string; runtimeIdentity: string }, now: number): HandoverEnvelope; report(tx, identity: MachineIdentity, execution: { executionId: string; runtimeIdentity: string }, envelope: HandoverEnvelope, now: number): void }`.
  2. Append `handover` to `workerOperations`: id `worker.handover`, `POST /api/worker/handover`, `access: AccessPolicy.Client`, `requiresExecution: true`, `lifetime: Unary`, `store: Operational`, `timeoutMs: HANDOVER_TIMEOUT_MS`, `mutation: true`, `secret: true`, `body: true`, `maxBodyBytes: HANDOVER_MAX_BODY_BYTES`, `status: HttpStatus.OK`, input `{ params: {}, query: {}, body: z.strictObject({ executionId: identitySchema("execution") }) }`, output `handoverEnvelopeSchema` of `src/kernel/handover.ts`.
  3. Append `credential`: id `worker.credential`, `POST /api/worker/credential`, `access: Client`, `requiresExecution: true`, `lifetime: Unary`, `timeoutMs: HANDOVER_TIMEOUT_MS`, `mutation: true`, `body: true`, `maxBodyBytes: CREDENTIAL_REPORT_MAX_BODY_BYTES`, `status: HttpStatus.NoContent`, input body `z.strictObject({ executionId: identitySchema("execution"), nonce: z.string().min(1), ciphertext: z.string().min(1) })`, output `z.null()`.
  4. Add `custodyHandover: CustodyHandover` to `Dependencies` (`src/worker/service.ts:158–166`) as a required field.
  5. In `declare` (`:681–739`), register both handlers. Each asserts a machine identity and `caller.execution`, reads `Date.now()` once inside one `caller.commit`, and calls `custodyHandover.handover(tx, identity, caller.execution, now)` or `custodyHandover.report(tx, identity, caller.execution, { nonce, ciphertext }, now)`. The report handler answers `null`.
  6. In `src/apps/server/index.ts`, pass `custodyHandover: { handover: (tx, i, e, now) => custody.handover(tx, i, e, now), report: (tx, i, e, env, now) => custody.report(tx, i, e, env, now) }` to `WorkerService` (`:116–124`).
  7. In `src/worker/service.test.ts`, give the harness a `custodyHandover` default that throws `UNEXPECTED_COLLABORATION`. Add tests: each handler passes the proven execution and not the body values; the report handler answers `null`; a human identity answers 401 `gateway.authentication.unauthorized`.
  8. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit `static/openapi.yaml` and the regenerated fragments. In `openapi-integration.test.ts`, assert the operation ids of `/api/worker/handover` and `/api/worker/credential`, the 204 answer of `worker.credential` with no content, and the `executionId` property of both request bodies.
- Rules:
  - `worker.handover` is a `client` operation of `unary` lifetime that requires a live execution at `POST /api/worker/handover`; `worker.credential` is a `client` mutation at `POST /api/worker/credential` that requires a live execution. `worker-service.impl.md:294`, `:297`; `engine/docs/cli/worker.md:113`, `:140`.
  - The body `{ executionId }` names the execution that the chain proves, and the report body adds the sealed report. `worker-service.impl.md:327`, `:331–332` (ruled 2026-09-30); decision D10.
  - `worker.handover` is a secret mutation: the idempotency record holds a redacted body and a repeat of the key answers 409 with no envelope. `worker-service.impl.md:327–328` (ruled 2026-09-30); `gateway-service.impl.md:429–430`; `src/gateway/idempotency.ts:102–118`.
  - A mutation is idempotent by its own natural key: the pin by the execution identity and the credential name, the report by the digest of the replaced value. `gateway-service.impl.md:410`; `custody.impl.md:149`, `:163`.
  - The chain passes the proven claim to the handler, and the handler reads none of it from the input. `architecture.impl.md:654`; decision D10.
  - An operation that answers 204 declares `status: HttpStatus.NoContent` and `output: z.null()`. `00-index.md` "Seams" (no-content answer); plan 02.
  - Each task publishes exactly the operations that it registers. `00-index.md` "Shared files"; ERD 1 decision log 05.4.
  - The Worker Service imports no custody type for its `Dependencies`. `00-index.md` "Collaboration-type contract rule".
- Done when: `node --test --test-timeout=30000 src/worker/service.test.ts src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 05.9 Add the integration tests through both adapters

- Files: `src/apps/server/handover-integration.test.ts` (create)
- Do:
  1. Build a fixture with one credential `anthro-1`, the enablement of `swe@1`, one project with the bindings `repo` and `general`, one objective, one registered instance and one claimed execution X, through the direct adapter of `gatewayFixture`, as the `## E2E` setup does.
  2. Test through the direct adapter and the HTTP adapter: the handover opens with the client secret of the machine JWT and the AAD of X and holds one item; a repeat of the idempotency key answers 409 and no `ciphertext`; a new key answers the same `credentialId`; a handover after the release of X answers 403 `gateway.invocation.execution_proof_failed` and reserves no key; a report after the release answers 403; a handover body of 1025 bytes answers 413 `gateway.request.body_too_large`; a body with an extra field answers 400 `gateway.request.validation_failed`.
  3. Test the answer of `worker.handover` holds no plaintext of the secret, and every answer of every other operation of the test holds none.
- Rules:
  - Both adapters enter one invocation chain and meet the same replay and the same refusals. `gateway-service.impl.md:401–402`; `architecture.impl.md:613–617`.
  - The conformance test asserts that no answer holds credential material, and it exempts the credential handover by name. `architecture.impl.md:807`.
  - A failed proof answers 403 before the handler and reserves no key. `architecture.impl.md:655`; plan 03 task 03.6.
  - Tests cover the handover round trip, another execution identity, truncated ciphertext and a refresh report without a live execution. `custody.impl.md:228`.
- Done when: `node --test --test-timeout=30000 src/apps/server/handover-integration.test.ts` passes; `pnpm run verify` passes.

### 05.10 Add the CLI leaf `worker handover`

- Files: `src/apps/cli/worker.ts` (edit), `src/apps/cli/index.test.ts` (edit)
- Do:
  1. Add the leaf `handover <execution-id>` to the `worker` group beside `register` (`src/apps/cli/worker.ts:293–305`), with `--token <jwt>` and `--idempotency-key <ulid>`.
  2. Implement the action: refuse an `<execution-id>` that `identitySchema("execution")` refuses with `cli.worker.handover.invalid_execution_id` (`worker-service.impl.md` "Handover CLI validation"); `requireToken(token, "cli.worker.handover.token_required")`; `key = resolveKey(options)` (`src/apps/cli/shared.ts:132–137`); call `httpClient(workerOperations, endpoint, token).handover({ params: {}, query: {}, body: { executionId } }, { idempotencyKey: key })`.
  3. An indeterminate result throws `cli.worker.handover.indeterminate` with the message "worker handover: result is indeterminate; retry with a new --idempotency-key.". A failure throws its code with the idempotency key. A success prints `{"received":true,"idempotencyKey":"<key>"}` and a newline.
  4. Add tests: `worker handover --help` exits 0 and names `<execution-id>`; `worker handover` without the argument exits nonzero; the stdout of a success holds neither `nonce` nor `ciphertext`.
- Rules:
  - The command calls `POST /api/worker/handover` with `client` access, prints only a status and never prints the envelope. `engine/docs/cli/worker.md:231–235`.
  - A remote mutation includes `[M]` and `[R]`, and its success metadata holds the effective idempotency key. `engine/docs/cli/common-flags.md:47–48`; `engine/docs/cli/other.md:199–200`; debate Q3.
  - A secret mutation answers 409 on a repeat of its key, so the recovery of a lost answer takes a new key. `gateway-service.impl.md:429–430`.
  - The CLI code of one command names that command. `architecture.impl.md:348`. `cli.worker.handover.invalid_execution_id` is declared in `worker-service.impl.md` "Handover CLI validation" and `engine/docs/cli/worker.md` "Error codes".
  - `cli.worker.handover.token_required` and `cli.worker.handover.indeterminate` follow the templates `cli.<group>.<command>.token_required` and `cli.<group>.<command>.indeterminate`. `engine/docs/cli/other.md:834–835`. `cli.idempotency_key.invalid` is the shared code. `engine/docs/cli/other.md:769`.
- Done when: `node --test --test-timeout=30000 src/apps/cli/index.test.ts` passes; `pnpm run verify` passes.

### 05.E E2E proof

- Files: `src/apps/server/e2e-custody-handover.test.ts` (create)
- Do:
  1. Build the setup of the `## E2E` section through the CLI on one `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }`.
  2. Write one `test` block for each scenario E05.1 to E05.12, in table order, on the shared setup.
  3. Parse stdout as JSON for every success. Assert the exit code and the start of stderr for every refusal.
  4. Open each envelope in the test process with `openEnvelope`, `deriveHandoverKeys(S)` and `handoverAad(X, G)` of `src/kernel/handover.ts`. Seal each report with the report key of S. Keep S, the keys and every opened value in local variables; never print or log them.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read, never a store read. ERD 1 decision D13.
  - The handover answer and the report have no CLI projection, so E05.2 to E05.7 call `worker.handover` and `worker.credential` through `httpClient(workerOperations, fixture.endpoint, generalToken)` from the test process, as decision D17 does for a request.
  - The fixture inputs are the inputs that the committed validation accepts. Decision D16; plan 03 "E2E".
  - Named constants for every fixed string and number in a comparison. `architecture.impl.md:15–19`.
  - Tests assert no secret in outputs, logs or errors. `custody.impl.md:233`.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-custody-handover.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-custody-handover.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state. A human command uses `KANTHORD_TOKEN = fixture.token`. A command with the suffix `[general]` uses `generalToken`.
- Machine tokens: `kanthord jwt generate` needs a terminal on stdout, so the test runs it through the spawn of `src/apps/server/e2e-worker-app.test.ts:291–305` with `process.stdout.isTTY = true`. The server configuration file for `--config` holds `configuration({ masterKey: fixture.config.masterKey }).getProperties()` as private YAML (`e2e-worker-app.test.ts:281–287`). The test parses `token` and `clientSecret` from the fragment.
- Rules: setup goes through the CLI only; the state check is a CLI read; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON.
- `H(body, key)` names `httpClient(workerOperations, fixture.endpoint, generalToken).handover({ params: {}, query: {}, body }, { idempotencyKey: key })`. `C(body, key)` names the same call of `credential`. `open(E)` names `handoverPayloadSchema.parse(openEnvelope(keys.handover, handoverAad(X, G), E))` for the execution of the scenario. `seal(R)` names `sealEnvelope(keys.report, handoverAad(X, G), R)`. `K1` names a fresh ULID of E05.2. Every other `H` and `C` call takes a new ULID.

Setup, in order (each command exits 0):

1. `kanthord credential create --file anthropic.json` with `{ "name": "anthro-1", "platform": "anthropic", "metadata": null, "secret": { "key": "e2e-handover-secret-one" } }`.
2. `kanthord credential create --file github.json` with `{ "name": "github", "platform": "github", "metadata": null, "secret": { "key": "test-secret" } }`.
3. `kanthord worker agent enablement put swe@1 --file enablement.json` with `{ "agentProviders": [{ "name": "default", "provider": "anthropic", "credential": "anthro-1" }], "defaultConfiguration": { "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" } }` → `revision` 1.
4. `kanthord project create --name handover` → `projectId` = `id`.
5. `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "general": { "kind": "worker", "config": { "worker": "general@1", "instanceCount": 1, "entries": [{ "agent": "swe@1", "agentProvider": "default", "modelIdentifier": "claude-sonnet-4-5", "reasoningEffort": "off" }] } } } }` → `bindingSetVersion` 2.
6. `kanthord mission get <projectId>` → `missionId` = `id`.
7. `kanthord mission node create <missionId> --file initiative.json` with `{ "filename": "initiative-1.md", "kind": "initiative", "content": { "name": "Recover accounts", "requirement": "Recover accounts", "criterion": "Accounts recover", "verifications": ["true"], "bindings": [] }, "reason": "plan", "expectedMissionVersion": 1 }` → `initiativeId` = `revisions[0].nodeId`.
8. `kanthord mission node create <missionId> --file objective.json` with the content, the reason and the verifications of step 7 and `"filename": "objective-1.md"`, `"kind": "objective"`, `"bindings": ["repo"]`, `"parentId": <initiativeId>`, `"expectedParentRevision": 1`, `"expectedMissionVersion": 2` → `objectiveId`.
9. `kanthord jwt generate --project <projectId> --binding general --name general-a --config server.yaml` → `generalToken`, `S` = `clientSecret`; the same with `--name general-b` → `spareToken`.
10. `kanthord worker register` [general] → `G` = `runtimeIdentity`.
11. `kanthord scheduler work pull --file pull.json` [general] with `{ "resourceIdentity": "worker:kanthord:general", "runtimeIdentity": G }` → `kind` `claimed`, `X` = `execution.executionId`.
12. `kanthord credential get anthro-1` → `C1` = `revisions[0].id`.

`further.json` holds `{ "furtherWork": true }`. `rotate(n, key)` names the file `{ "expectedRevision": n, "secret": { "key": key } }`. `A(key)` names the pi-ai credential `{ "type": "api_key", "key": key }`, and `D(key)` names `digest(A(key))` of `src/kernel/json.ts`. `one`, `two`, `three`, `refreshed`, `second` and `third` name the keys `e2e-handover-secret-one`, `e2e-handover-secret-two`, `e2e-handover-secret-three`, `e2e-handover-refreshed`, `e2e-handover-second` and `e2e-handover-third`.

| Id     | Commands                                                                                                                                                                                                                                                                                                                                            | Exit          | Expect                                                                                                                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E05.1  | `kanthord worker handover X` [general]; then `kanthord scheduler execution get X`                                                                                                                                                                                                                                                                   | 0, 0          | first stdout `received` true, `idempotencyKey` a ULID, no key `nonce` or `ciphertext`; `credentials` `[C1]`; neither stdout nor stderr holds `e2e-handover-secret-one`                                                                                                                                                                             |
| E05.2  | `H({ executionId: X }, K1)`; then `open` of its data; then `openEnvelope` of the same data with `handoverAad("execution_01ARZ3NDEKTSV4RRFFQ69G5FAA", G)`; then with `keys.report`                                                                                                                                                                   | —             | completed; `items` equals `[{ credentialId: C1, providerId: "anthropic", credential: { type: "api_key", key: "e2e-handover-secret-one" } }]`; the second and the third open throw `HandoverOpenError`; `fixture.logs` holds a `credential handover` record with `executionId` X and `credentialId` C1, and no line holds `e2e-handover-secret-one` |
| E05.3  | `H({ executionId: X }, K1)` of E05.2 again; then `H({ executionId: X }, <new ULID>)`                                                                                                                                                                                                                                                                | —             | first a failure with status 409 whose JSON holds no `ciphertext`; second completed, `open` answers `credentialId` C1                                                                                                                                                                                                                               |
| E05.4  | `kanthord credential rotate anthro-1 --file rotate(1, two)`; then `kanthord credential get anthro-1`; then `H({ executionId: X }, <new ULID>)`                                                                                                                                                                                                      | 0, 0, —       | revisions 2 and 1 with `endedAt` null each; `open` answers `credentialId` C1 and `key` `e2e-handover-secret-one` → `C2` = the `id` of revision 2                                                                                                                                                                                                   |
| E05.5  | `C({ executionId: X, ...seal(R1) }, <new ULID>)` with `R1 = { credentialId: C1, digest: D(one), credential: A(refreshed) }`; `C(… seal(R2) …)` with `R2 = { credentialId: C1, digest: D(refreshed), credential: A(second) }`; `C(… seal(R1) …)` with a new key; then `H({ executionId: X }, <new ULID>)`; then `kanthord credential get anthro-1`   | —, —, —, —, 0 | three completed answers with data null; `open` answers `key` `e2e-handover-second`; the revisions stay 2 and 1                                                                                                                                                                                                                                     |
| E05.6  | `C({ executionId: X, ...sealEnvelope(keys.handover, handoverAad(X, G), R2) }, …)`; `C({ executionId: X, nonce: <nonce of seal(R2)>, ciphertext: "AAAA" }, …)`; `C(… seal({ ...R2, credentialId: C2 }) …)`; `C(… seal({ ...R2, credential: { type: "oauth", refresh: "r", access: "a", expires: 1 } }) …)`                                           | —             | four failures with status 400 and code `custody.handover.report_invalid`                                                                                                                                                                                                                                                                           |
| E05.7  | `kanthord worker handover X --token <human token>`; `kanthord worker handover X --token <spareToken>`; `kanthord worker handover execution_01ARZ3NDEKTSV4RRFFQ69G5FAA` [general]; `kanthord worker handover invalid` [general]; `kanthord worker handover X --idempotency-key bad` [general]; `kanthord worker handover X` with `KANTHORD_TOKEN=""` | 1 each        | stderr starts with `gateway.authentication.unauthorized:`, `gateway.registration.required:`, `gateway.invocation.execution_proof_failed:`, `cli.worker.handover.invalid_execution_id:`, `cli.idempotency_key.invalid:`, `cli.worker.handover.token_required:`                                                                                      |
| E05.8  | `kanthord credential revoke anthro-1 1`; then `kanthord worker handover X` [general]; then `C({ executionId: X, ...seal(R3) }, <new ULID>)` with `R3 = { credentialId: C1, digest: D(second), credential: A(third) }`                                                                                                                               | 0, 1, —       | revision 1 `endedAt` a number, revision 2 `endedAt` null; stderr starts with `credential.revision.revoked:`; a failure with status 409 and code `credential.revision.revoked`                                                                                                                                                                      |
| E05.9  | `kanthord scheduler execution release X --file further.json` [general]; then `kanthord worker handover X` [general]; then `C({ executionId: X, ...seal(R2) }, <new ULID>)`                                                                                                                                                                          | 0, 1, —       | `endedAt` a number; stderr starts with `gateway.invocation.execution_proof_failed:`; a failure with status 403 and code `gateway.invocation.execution_proof_failed`                                                                                                                                                                                |
| E05.10 | `kanthord scheduler work pull --file pull.json` [general]; then `kanthord worker handover X2` [general]; then `kanthord scheduler execution get X2`; then `kanthord credential rotate anthro-1 --file rotate(2, three)`; then `kanthord credential get anthro-1`                                                                                    | 0, 0, 0, 0, 0 | `kind` `claimed` → `X2` = `execution.executionId`; `received` true; `credentials` `[C2]`; revision 3 and revision 2 with `endedAt` null                                                                                                                                                                                                            |
| E05.11 | `kanthord scheduler execution release X2 --file further.json` [general]; then `kanthord credential get anthro-1`                                                                                                                                                                                                                                    | 0, 0          | revision 2 `endedAt` a number, revision 3 `endedAt` null                                                                                                                                                                                                                                                                                           |
| E05.12 | `kanthord scheduler work pull --file pull.json` [general]; then `kanthord worker agent enablement disable swe@1 --expected-revision 1`; then `kanthord worker handover X3` [general]; then `kanthord scheduler execution get X3`                                                                                                                    | 0, 0, 1, 0    | `kind` `claimed` → `X3` = `execution.executionId`; stderr starts with `worker.agent.enablement.unavailable:`; `credentials` `[]`                                                                                                                                                                                                                   |

E05.6 asserts `custody.handover.report_invalid`, declared in `custody.impl.md` "The credential handover". E05.7 asserts `cli.worker.handover.invalid_execution_id`, declared in `worker-service.impl.md` "Handover CLI validation" following Ulrich's publication approval on 2026-10-02. Both codes also appear in their CLI references, satisfying ruling R3. E05.12 depends on the Project refusal of task 05.4 before the release, so no pin follows the disablement (`custody.md:73`).

## Blockers

None open. The debate engine settled three questions:

- DEBATE: the execution identity of `worker.handover` and `worker.credential` against the empty body of the pages - rounds:1 - verdict: (b), the body `{ executionId }` for the handover and `{ executionId, nonce, ciphertext }` for the report, because a proof of the current execution of the registration pins credentials for a later execution when a request of an earlier one arrives late, and the AAD protects the answer but does not undo the pin; D10 and the ruled routes stay; the CLI leaf takes `<execution-id>`. ruled 2026-09-30. Ruled 2026-09-30 on `worker-service.impl.md:327–332`.
- DEBATE: the drain at a rotation against "a rotation keeps the older revisions live" - rounds:1 - verdict: (a), the rotation transaction drains each older revision that no live execution pins under the specific trigger of `custody.impl.md:166`; E01.10 becomes the no-pin case, the revoke of a pinned revision moves to E05.8, and the unit tests pin revision 1 through a fake. ruled 2026-09-30. Ruled 2026-09-30 on `custody.md:29` and `custody.impl.md:24`.
- DEBATE: the mutation flag of `worker.handover` - rounds:1 - verdict: (b), a secret mutation, because natural-key idempotence is required of every mutation and grants no exemption, and `gateway-service.impl.md:429–430` rules the redacted record and the 409 on a repeated key; a lost answer takes a new key. Ruled 2026-09-30 on `worker-service.impl.md:327–328`.

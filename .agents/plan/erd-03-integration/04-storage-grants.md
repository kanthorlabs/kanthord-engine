# Plan 04: Intake Service — presigned storage

## Scope

This plan delivers:

- The S3 implementation of the Repository component: the presigned PUT and GET, the object metadata read and the object delete, over `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` at 3.1139.0 (decision D10).
- The Mission authorization of an evidence asset and of an object PUT for the protected facility, and their grant kinds in custody (decisions D8, D9).
- The operations `intake.storage.put`, `intake.storage.check` and `intake.execution.storage.get` (`client`), `intake.storage.get` (`human`) and `intake.storage.delete` (`human`, outbound operation `s3.delete_object` with its read-back).
- The replacement of the five ERD 2 seams of `IntakeStorage` and the move of the Mission call sites to entity inputs (decisions D6, D8).
- The fixture `fakeS3`, which replaces `objectSink` and `sinkStorage`, and the move of the ERD 2 tests that used them (decision D17).

Out of scope:

- The upload helper of the `worker` application and of an external harness (ERD 2 plan 09; `mission-service.impl.md:298–302`).
- A cleanup of expired uploads: a human deletes an expired asset (root `AGENTS.md` "Rejected proposals"; `mission-service.impl.md:324–325`).
- Object immutability and a store capability probe (`mission-service.impl.md:329–332`).

## Sources

- `docs/brainstorm/intake-service.md:42`, `:139`, `:148` — the bytes travel through a presigned URL; the Intake Service signs, checks and deletes for the Mission Service; a presign records no outbound request.
- `docs/brainstorm/intake-service.impl.md:118–119`, `:125–127`, `:134–135` — the storage operations, their caller kinds and their authorization.
- `docs/brainstorm/intake-service.impl.md:138–156` — the presigned storage grants and their tests.
- `docs/brainstorm/intake-service.impl.md:160–172`, `:178` — the outbound record and the read-back of `s3.delete_object`.
- `docs/reference/erd/03-integration.md:23`, `:31`, `:141–151` — `s3.delete_object`; a presign writes no row; the outbound constraints.
- `docs/brainstorm/mission-service.impl.md:296–340` — object evidence: the server-generated key, the 1 hour PUT, the optional checksum, the check at complete, the GET of the recorded version.
- `docs/brainstorm/mission-service.impl.md:342–366` — evidence retention: the content first, the request key of the object delete is the asset identity, the read-back on a repeat, the binding authorization.
- `docs/brainstorm/mission-service.impl.md:557–563` — the Mission authorization of an evidence asset for a human identity and an execution identity.
- `docs/brainstorm/project-service.impl.md:153–178` — the storage binding.
- `docs/brainstorm/custody.impl.md:43`, `:57`, `:62` — the `s3_access_key` shape; the S3 client of custody.
- `docs/brainstorm/custody.impl.md:95–126`, `:161–170` — the facility, the release, the pin.
- `docs/brainstorm/project-service.vocabulary.md:67` — a presigned grant reaches the component, never the agent context.
- `docs/brainstorm/repository.md:36–51`, `:78–83` — the platform connector and the result classes.
- `engine/docs/cli/intake.md:411–419`, `:457–458` — `intake.storage.delete` has no CLI command; its 409 codes.
- `engine/src/mission/contract.ts:95–149` — `IntakeCall`, `StorageBinding`, `IntakeStorage`.
- `engine/src/mission/evidence-submit.ts:100–215`, `engine/src/mission/evidence-complete.ts:80–130`, `engine/src/mission/evidence-content-read.ts:150–200`, `engine/src/mission/evidence-delete.ts:70–140` — the four call sites.
- `engine/src/mission/evidence-content.ts:213–242` — `objectKey`, `objectLocation`, `keyOfLocation`.
- `engine/src/mission/authorization.ts:34–112` — `authorizeBinding`, `authorizeClaim`, `authorizeStorage`.
- `engine/src/custody/resource-healthcheck.ts:160–180` — the S3 client configuration of custody.
- `engine/src/apps/server/test-support.ts:66–167` — `objectSink` and `sinkStorage`.
- Decisions D6, D8, D9, D10, D11, D12, D17, D24 of `decisions.md`.

### Contract keys

| Key                                                       | Where                                                     | Owner line                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `executionId`                                             | path of the three `client` operations                     | ERD 2 decision D10                                                                               |
| `nodeId`, `assetId`, `storageBindingId`, `size`, `sha256` | body of `intake.storage.put`                              | `mission-service.impl.md:304`, `:308–309`; decision D8                                           |
| `assetId`                                                 | path of `check`, `get`, `execution.storage.get`, `delete` | `mission-service.impl.md:358` (the asset identity is the request key)                            |
| `putUrl`, `headers`, `expiresAt`                          | answer of `intake.storage.put`                            | `engine/src/mission/contract.ts:118–122`; `engine/docs/cli/mission.md` "Object evidence schemas" |
| `location`, `version`                                     | answer of `intake.storage.check`                          | `engine/src/mission/contract.ts:129`; `mission-service.impl.md:318`                              |
| `getUrl`, `expiresAt`                                     | answer of the two GET operations                          | `engine/src/mission/contract.ts:135`, `:141`                                                     |

## Depends on

- Plan 01: the Intake module and its identity.
- Plan 02: `runOutbound`, `ResultClass`.
- Plan 03: the generalized facility, `GrantRequest`, `grantFacts`, the `MissionAuthorization` declaration and its wiring.
- ERD 2 plan 04: object evidence, the content reads, the deletes and `storageBindingOf` (`engine/src/mission/evidence-*.ts`).
- No stand-in.

## Provides

| Seam                          | TypeScript signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner file                                                | Consumer plans |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------- |
| `S3Platform`                  | `presignPut(call, { endpoint; bucket; region; key; size; sha256 \| null }): Promise<{ putUrl; headers; expiresAt }>`; `presignGet(call, { …; key; version \| null }): Promise<{ getUrl; expiresAt }>`; `headObject(call, { …; key; version \| null }): Promise<S3Answer<{ size; sha256 \| null; version \| null } \| null>>`; `deleteObject(call, { …; key; version \| null }): Promise<S3Answer<{ version \| null }>>`; `S3Call = { accessKeyId; secretAccessKey; signal; deadlineAt }` | `src/repository/s3.ts`                                    | 04             |
| `MissionAuthorization` (rest) | `evidenceAsset(tx, identity, assetId, claim \| null, use: AssetUse): Authorized<AssetFacts>` with the closed set `AssetUse = { Check: "check", Get: "get", ExecutionGet: "execution_get", Delete: "delete" }` as an `as const` object; `objectPut(tx, identity, claim, { nodeId; assetId; storageBindingId; size; sha256 }): Authorized<AssetFacts>`; `AssetFacts = { storage: { bindingId; endpoint; bucket; region }; key; location; version \| null; size; sha256 \| null }`          | `src/mission/authorization.ts`; `src/custody/contract.ts` | custody        |
| Grant kinds                   | `evidence_asset`, `object_put` of `GrantRequest`                                                                                                                                                                                                                                                                                                                                                                                                                                         | `src/custody/contract.ts`                                 | 04             |
| Storage operations            | `intake.storage.put`, `intake.storage.check`, `intake.execution.storage.get`, `intake.storage.get`, `intake.storage.delete`                                                                                                                                                                                                                                                                                                                                                              | `src/intake/contract.ts`                                  | 10             |
| `IntakeStorage` (changed)     | `put(call: IntakeExecutionCall, input: { nodeId; assetId; storageBindingId; size; sha256 })`; `check(call: IntakeExecutionCall, assetId)`; `get(call: IntakeCall, assetId)`; `executionGet(call: IntakeExecutionCall, assetId)`; `delete(call: IntakeCall, assetId)`; `IntakeExecutionCall = IntakeCall & { executionId: string }`                                                                                                                                                       | `src/mission/contract.ts`                                 | Mission        |
| `fakeS3`                      | `fakeS3(t): Promise<{ endpoint; bucket; objects: Map<string, { version; bytes; sha256 }[]>; calls; failNext(status) }>` — every version of a key stays addressable                                                                                                                                                                                                                                                                                                                       | `src/apps/server/test-support.ts`                         | 04, 10         |
| `OBJECT_MAX_BYTES`            | `5 * 1024 ** 3`, the single-object limit of `mission-service.impl.md:306`, declared inline in `src/intake/contract.ts`                                                                                                                                                                                                                                                                                                                                                                   | `src/intake/contract.ts`                                  | 04             |

## Tasks

### 04.1 Add the S3 implementation

- Files: `package.json`, `pnpm-lock.yaml`, `src/repository/s3.ts` (create), `src/repository/s3.test.ts` (create), `src/repository/index.ts`, `engine/AGENTS.md` (edit)
- Do:
  1. Add `@aws-sdk/s3-request-presigner` at exactly `3.1139.0`.
  2. Build one `S3Client` per call with the binding `endpoint` and `region`, `forcePathStyle: true`, the released `accessKeyId` and `secretAccessKey`, and `maxAttempts: 1`, so one write sends one request; destroy it in `finally`. A read retries a transport error itself until the absolute deadline `deadlineAt`.
  3. `presignPut`: sign `PutObjectCommand` with `ContentLength` = `size` and, only when `sha256` is given, `ChecksumSHA256` = the base64 of the hexadecimal digest; `expiresIn` = `PRESIGN_LIFETIME_S`. Answer `putUrl`, the headers that the signature binds and that the PUT must send, and `expiresAt` = now plus the lifetime in milliseconds.
  4. `presignGet`: sign `GetObjectCommand` with `VersionId` when `version` is given; answer `getUrl` and `expiresAt`.
  5. `headObject`: send `HeadObjectCommand` with `ChecksumMode: "ENABLED"` and `VersionId` when given; a 404 answers `{ ok: true, value: null }`; answer the size, the SHA-256 in hexadecimal when the store returns one, and the version. `deleteObject`: send `DeleteObjectCommand` with `VersionId` when given.
  6. Map a failure under decision D11: a transport error before a write leaves answers `confirmed_failure`; a 429 or a `SlowDown` answers `retryable_refusal`; another 4xx answers `final_refusal`; a 5xx, a lost answer and the deadline of the delete answer `unknown_outcome`; a read answers `retryable_refusal` for a 5xx and at the deadline. The code is `repository.platform.s3.<class>` (`code: proposed`).
  7. Add `s3` to `platformImplementations`; add `s3.ts` to the `src/repository/` entry of `engine/AGENTS.md`.
  8. Add tests against a local HTTP server that counts the requests: the PUT URL expires after 3600 s and binds the content length; the checksum appears only with a SHA-256; the GET URL names the version; `headObject` maps 404 to null and a 403 to `final_refusal`; `deleteObject` sends the version and one request for a 503; no URL, error or log holds the secret access key.
- Rules:
  - A PUT grant authorizes one object upload, expires after 1 hour, and requires the checksum header only when the submission supplies a SHA-256; the GET addresses the recorded version. `intake-service.impl.md:143–147`; `mission-service.impl.md:310–311`, `:335`.
  - The Intake Service derives the endpoint and the bucket from the storage binding, and custody releases its credential. `intake-service.impl.md:141`.
  - The read-back of `s3.delete_object` reads the recorded object version, and a not-found answer is a match. `intake-service.impl.md:178`.
  - Every platform operation goes through a platform implementation of the Repository component, which retries no write. `intake-service.md:29–30`; `repository.md:82–83`; decision D10.
  - The holder builds its client for one call and caches no client and no token. `intake-service.impl.md:119`.
  - Gap: no page names the presigner package (decision D10) or the addressing style; path-style addressing serves an S3-compatible endpoint by its URL (`custody.impl.md:62`) and the fixture endpoint of decision D17. The report lists both for Ulrich.
  - Gap: `repository.impl.md:26` names the code form of GitHub alone; `repository.platform.s3.<class>` is `code: proposed`.
- Done when: `node --test --test-timeout=30000 src/repository/s3.test.ts` passes; `pnpm run verify` passes.

### 04.2 Add the Mission authorization of an evidence asset and an object PUT

- Files: `src/mission/authorization.ts`, `src/mission/authorization.test.ts`, `src/mission/evidence-complete.ts`, `src/mission/evidence-content-read.ts`, `src/mission/service.ts`, `src/custody/contract.ts`, `src/custody/service.ts`, `src/custody/service.test.ts`, `src/apps/server/index.ts` (all edit)
- Do:
  1. Implement `authorizeObjectPut(tx, identity, claim, input)`: `authorizeClaim(tx, deps, claim, input.nodeId)`; refuse with `node_mismatch` an `assetId` that an asset row already holds; refuse a `size` above the single-object limit of `mission.evidence.submit` (`engine/src/mission/contract.ts:1017–1022`) with `gateway.request.validation_failed`; read the storage binding of the pinned revision (`storageBindingIdOf`, `src/mission/evidence-submit.ts:113`) and refuse with `node_mismatch` when it differs from `input.storageBindingId`; `authorizeStorage`; derive `key = objectKey(binding, claim.projectId, node.mission_id, node.id, claim.attempt, input.assetId)` and `location = objectLocation(binding, key)`. Answer the storage credential, `platform: "s3"`, the project and the facts.
  2. Implement `authorizeEvidenceAsset(tx, identity, assetId, claim, use)`: an absent asset answers 404 `mission.record.not_found`; refuse a non-`object` asset with `node_mismatch`. For `check`, require a machine identity and run the admission of `mission.evidence.asset.complete` that `prepareComplete` holds (`src/mission/evidence-complete.ts:49–65`): the claim names the node of the evidence, the attempt of the evidence equals the attempt of the claim, the asset is unpublished and not expired; extract that admission into one shared function. For `execution_get`, require a machine identity and call `executionContentBound` of `src/mission/evidence-content-read.ts` directly, which authorizes the claim of its own node and the permitted evidence relation. For `get` and `delete`, require a human identity. Then `authorizeStorage` on `storageBindingId` of the content and derive the key with `keyOfLocation`. Answer the facts with `version` = `objectVersion` or null, `size` and `sha256`.
  3. In custody, add the grant kinds `evidence_asset` and `object_put` to `GrantKind` and `GrantRequest`, dispatch them to `missionAuthorization`, and wire both functions in `composeServices`. `grantFacts` answers the project and the credential name of the storage binding.
  4. Add tests: a claim of another node refuses a PUT and a check before the release; a PUT names the server key of the claim attempt; a PUT that names the identity of a recorded asset refuses; a PUT of another storage binding and a PUT one byte above the limit refuse; a check of a pending asset of an earlier attempt and of an expired asset refuses; an initiative claim reads the object of a current objective outcome through `execution_get`, and a claim reads no object outside its bound; a disabled or removed storage binding refuses every use, `delete` included; a human identity refuses `check` and `execution_get`; a machine identity refuses `get` and `delete`; the release under a claim pins the storage credential, and the release under a human pins nothing.
- Rules:
  - The Mission Service supplies the server-generated object key, never an agent-selected destination. `intake-service.impl.md:142`; decision D8. The PUT contract waits for B5.
  - For an execution identity the Mission authorization follows the live claim to the node, the open attempt and the evidence; for a human identity it follows the evidence asset to its storage binding revision; it takes no association from the caller. `mission-service.impl.md:559–562`.
  - The server checks the live claim, the storage binding of the pinned revision and the 5 GiB single-object limit; a pending asset expires 1 hour after the submission. `mission-service.impl.md:306`, `:321–322`.
  - `s3.delete_object`: the Mission Service authorizes the forwarded human identity through the evidence asset and its storage binding revision. `intake-service.impl.md:134`.
  - A disabled or removed storage binding refuses the object delete, and `force` bypasses no binding authorization. `mission-service.impl.md:359`.
  - Tests refuse grants for unauthorized readers or executions without a live claim. `intake-service.impl.md:156`.
  - The pin of an execution and the newest live revision of a human. Decision D24.
- Done when: `node --test --test-timeout=30000 src/mission/authorization.test.ts src/custody/service.test.ts` passes; `pnpm run verify` passes.

### 04.3 Declare and implement the presign and check operations

- Files: `src/intake/contract.ts`, `src/intake/storage.ts` (create), `src/apps/server/storage-operations.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare, each `unary`, `mutation: false`, on the operational store with the default timeout:
     - `storage.put`: `POST /api/intake/execution/:executionId/storage/put`, `access: Client`, `requiresExecution: true`, body `z.strictObject({ nodeId: identitySchema("node"), assetId: identitySchema("evidence_asset"), storageBindingId: identitySchema("binding"), size: z.number().int().nonnegative().max(OBJECT_MAX_BYTES), sha256: sha256Schema.nullable() })`, output `{ putUrl, headers, expiresAt }`.
     - `storage.check`: `GET /api/intake/execution/:executionId/storage/asset/:assetId/check`, `access: Client`, `requiresExecution: true`, output `{ location, version }`.
     - `execution.storage.get`: `GET /api/intake/execution/:executionId/storage/asset/:assetId`, `access: Client`, `requiresExecution: true`, output `{ getUrl, expiresAt }`.
     - `storage.get`: `GET /api/intake/storage/asset/:assetId`, `access: Human`, output `{ getUrl, expiresAt }`.
  2. Implement each handler: in one `store.transaction`, authorize the grant kind with the caller identity and `caller.execution`, and release the material; outside it, run the S3 call; drop the material in `finally`; answer through one `caller.commit` that writes nothing.
  3. The check compares the `headObject` answer with the facts: a null answer, another size, or a SHA-256 that differs from a given one answers 409 `intake.storage.object_mismatch` (`code: proposed`); a match answers `{ location, version }`. A result class of `headObject` throws `OperationError(502, code, message, { class })` (`code: proposed`) and is no mismatch; a 401 or 403 reaches `reportRefusal`.
  4. Regenerate OpenAPI; assert the four paths, their policies and the absence of every URL in the request schemas.
  5. Add tests through both adapters: a PUT, a check and two GETs; a PUT that names the identity of a recorded asset refuses through each adapter; the presigned URLs appear only in the answer and in no log record; a missing object, a short object and a wrong checksum answer the mismatch; a refused HEAD answers 502; no outbound request is recorded; the material drops on every path.
- Rules:
  - `intake.storage.put` and `intake.storage.check` are `client` operations that the Mission Service calls with the identity of the execution; `intake.storage.get` is `human` and `intake.execution.storage.get` is `client`; each signs at the recorded object version. `intake-service.impl.md:125–126`.
  - The Intake Service checks the object size and, when given, the checksum, and a mismatch prevents publication. `mission-service.impl.md:315–316`.
  - The API answer carries the URL directly to the component, never through the credential handover; the storage credential stays inside the server process. `intake-service.impl.md:148–149`.
  - A read, a check and a presign record no outbound request. `intake-service.md:148`.
  - Tests assert that no storage credential or presigned URL enters the handover, logs or agent context. `intake-service.impl.md:155`.
  - Gap: no page names the four routes (blocker B5), and the ERD names the `service` policy for every peer call (blocker B6); step 1 waits for both rulings. The PUT waits for the ruling of B5 on its allocation authority. The pin and the drain of the release before the call wait for B1 (decision D3).
  - The Mission refusals that the authorization raises reach the caller: `mission.authorization.refused`, `mission.execution.context_mismatch`, `mission.evidence.upload_expired` and `mission.record.not_found`. Their rows on `engine/docs/cli/intake.md` are `code: proposed`.
- Done when: `node --test --test-timeout=30000 src/apps/server/storage-operations.test.ts src/apps/server/openapi-integration.test.ts` passes; `pnpm run verify` passes.

### 04.4 Declare and implement `intake.storage.delete`

- Files: `src/intake/contract.ts`, `src/intake/storage-delete.ts` (create), `src/apps/server/storage-delete.test.ts` (create), `src/intake/service.ts`, `src/apps/server/openapi-integration.test.ts` (edit), `static/openapi.yaml`, `static/openapi/**` (regenerated)
- Do:
  1. Declare `storage.delete`: `DELETE /api/intake/storage/asset/:assetId`, `access: Human`, `mutation: true`, `status: HttpStatus.NoContent`, `output: z.null()`.
  2. Implement the handler with `runOutbound`: `requestKey = assetId`; the result codec is the identity of `{ location, version }`, whose properties are single words; `authorize` authorizes the `evidence_asset` kind with `use: "delete"`, releases the storage credential, and answers `operation: "s3.delete_object"` with the project and the credential name of `grantFacts`; the call runs `deleteObject` at the recorded version and answers `{ location, version }`; the read-back runs `headObject` at the recorded version and a null answer is a match with the same result; a result class of the read-back keeps the request unchanged.
  3. `finalize` maps `ok: true` to `{ kind: "answer", body: null }` and `ok: false` to `{ kind: "error", error: OperationError(502, code, message, { class }) }` with the Repository code (`code: proposed`); the runner commits the `failed` state before it throws. The 409 codes of the runner propagate.
  4. Add tests: a failed delete commits `failed` and answers 502; a 401 or 403 reaches `reportRefusal`; a delete records one `succeeded` `s3.delete_object` request whose key is the asset identity; a repeat answers null with no second delete; a delete whose answer is lost and whose object is gone answers 204 at the repeat through the read-back; a refusal of the binding records no request.
- Rules:
  - `intake.storage.delete` is a `human` operation that the Mission Service calls with the identity of the human and the evidence asset identity as the request key; its outbound operation is `s3.delete_object`. `intake-service.impl.md:127`.
  - A failed content delete keeps the row; a repeat after a failed delete runs the read-back; a human deletes the outbound request to send the delete again. `mission-service.impl.md:358`.
  - The repeat rules and the 409 codes of a repeat. `intake-service.impl.md:170–171`; `engine/docs/cli/intake.md:411–415`, `:457–458`.
  - Gap: no page names the route (blocker B5). A route of this `human` operation lets a human delete the object of a live evidence without the `force`, the reason and the mission version of `mission.evidence.asset.delete` (`mission-service.impl.md:350–354`); B5 carries that residue, and the route waits for its ruling. The `pending` insert before the call waits for B1 (decision D3). The HTTP status of a result class is `code: proposed`.
- Done when: `node --test --test-timeout=30000 src/apps/server/storage-delete.test.ts` passes; `pnpm run verify` passes.

### 04.5 Add `fakeS3`

- Files: `src/apps/server/test-support.ts`, `src/apps/server/intake-fixtures.test.ts` (edit)
- Do:
  1. Add `fakeS3(t)`: an in-process path-style S3 emulation on `127.0.0.1` for one bucket. `PUT /<bucket>/<key>` checks the signed headers of the presigned URL, stores the bytes as a new version with the next version identity, checks `x-amz-checksum-sha256` when the signature binds it and answers 400 on a mismatch; `HEAD` and `GET` answer the version that `versionId` names, else the newest one, with `Content-Length`, `x-amz-version-id` and, with `x-amz-checksum-mode: ENABLED`, the checksum; `DELETE` removes the named version. It records the method, the key and the version of each call, never a signature value, and it can script one failure status.
  2. Add tests of the fixture alone: a PUT with and without a SHA-256; a second PUT of one key keeps the first version addressable; a GET and a DELETE of the first version after a second PUT target the first version.
- Rules:
  - A remote service is faked through a fixture injection point. ERD 1 decision D13; decision D17.
- Done when: `node --test --test-timeout=30000 src/apps/server/intake-fixtures.test.ts` passes; `pnpm run verify` passes.

### 04.6 Wire the Mission storage and move the ERD 2 tests

- Files: `src/mission/contract.ts`, `src/mission/evidence-submit.ts`, `src/mission/evidence-complete.ts`, `src/mission/evidence-content-read.ts`, `src/mission/evidence-delete.ts`, their colocated tests, `src/apps/server/index.ts`, `src/apps/server/test-support.ts`, `src/apps/server/e2e-mission-execution-operations.test.ts`, `src/apps/server/intake-fixtures.test.ts`, `src/apps/server/unwired-import.test.ts` (all edit)
- Do:
  1. Change `IntakeStorage` to the entity inputs of "Provides" and add `IntakeExecutionCall`.
  2. In `submitEvidence`, call `put({ context, identity, executionId: claim.executionId }, { nodeId, assetId, storageBindingId, size, sha256 })` for each object asset. In `completeEvidence`, call `check(call, assetId)` and keep the assertion on `location`. In the content read, call `get(call, assetId)` for a human and `executionGet(call, assetId)` for an execution. In `deleteObject`, call `delete(call, asset.id)`.
  3. In `composeServices`, pass `intakeStorage` over `directClient(intakeOperations, invocation)` with the forwarded identity, the context, the execution identity in the path, and a fresh ULID as the idempotency key of `delete`; map each result through `resultOf` of task 03.7.
  4. Delete the five `unwired("IntakeStorage.*")` literals, the `intakeStorage` member of `standIns`, `objectSink` and `sinkStorage`; set `UNWIRED_SEAMS` of `unwired-import.test.ts` to `[]`.
  5. Move `e2e-mission-execution-operations.test.ts` and `intake-fixtures.test.ts` onto `fakeS3`: create the storage credential with the metadata `{ endpoint: s3.endpoint, bucket: s3.bucket, region: "eu-central-1" }` and the storage binding with the same endpoint and bucket, and assert the same evidence records and contents. Update the colocated Mission tests to the new inputs.
- Rules:
  - The Mission Service calls `intake.storage.put` in `mission.evidence.submit` and `intake.storage.check` in `mission.evidence.asset.complete` with the identity of the execution, and `intake.storage.delete` with the identity of the human. `intake-service.impl.md:125–127`.
  - An authorized reader gets a presigned GET through its component, signed by `intake.storage.get` or `intake.execution.storage.get`. `mission-service.impl.md:334`.
  - The plan that implements a seam deletes its `unwired` literal, its `standIns` member and its fake, and moves their tests in the same commit. Decision D6.
  - A handler runs its client calls before its one commit. `architecture.impl.md:699–704`.
- Done when: `node --test --test-timeout=30000 src/mission/*.test.ts src/apps/server/e2e-mission-execution-operations.test.ts src/apps/server/unwired-import.test.ts` passes; `pnpm run verify` passes.

### 04.E E2E proof

- Files: `src/apps/server/e2e-storage-grants.test.ts` (create)
- Do:
  1. Start `fakeS3(t)` and `gatewayFixture` with `repositoryConnector: { gitLsRemote: async () => {} }`.
  2. Build the setup of `## E2E` through the CLI and run E04.1 to E04.8 in one test in table order.
  3. Drive `mission.evidence.submit` with an `object` asset, the PUT and `mission.evidence.asset.complete` through `httpClient(missionOperations, fixture.endpoint, T)` and `fetch` from the test process, because the CLI refuses an `object` asset (ERD 2 decision D17). Give each mutation a fresh idempotency key.
- Rules:
  - Setup goes through the CLI; the state check is a CLI read. ERD 1 decision D13.
  - No output holds the secret access key; a presigned URL appears only in the answer that carries it.
- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-storage-grants.test.ts` passes; `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-storage-grants.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture`, `fakeS3`, `kanthord(args, env)`, `generateMachineToken`. `H` names the human token; `[T]` names the machine token of the binding `harness` of `claude@1`.
- `ctx(e, x)`, `pull.json` and `M` follow plan 03 "E2E". `submit(x)` names the body `{ ctx(e, x), "subject": "hello object", "assets": [{ "kind": "object", "mediaType": "text/plain", "size": 5 }] }`; `complete` names the body `{ ctx(e, x) }` of `mission.evidence.asset.complete`.

Setup, in order (each command exits 0, token H unless marked):

1. `kanthord credential create --file store.json` with `{ "name": "store", "platform": "s3", "metadata": { "endpoint": <s3.endpoint>, "bucket": "evidence", "region": "eu-central-1" }, "secret": { "accessKeyId": "AKIAEXAMPLE", "secretAccessKey": "e2e-storage-secret" } }`; `kanthord credential create --file github.json` of plan 03.
2. `kanthord project create --name storage` → `projectId`; `kanthord mission get <projectId>` → `missionId`; `kanthord project binding apply <projectId> --file bindings.json` with `{ "version": 1, "bindings": { "repo": { "kind": "repository", "config": { "available": true, "platform": "github", "address": "git@github.com:owner/repo.git", "strategy": { "baseBranch": "main" }, "credential": "github" } }, "store": { "kind": "storage", "config": { "available": true, "endpoint": <s3.endpoint>, "bucket": "evidence", "region": "eu-central-1", "prefix": "kanthord", "credential": "store" } }, "harness": { "kind": "worker", "config": { "worker": "claude@1", "instanceCount": 1 } } } }`.
3. An initiative `I` and an objective `A` with `"bindings": ["repo", "store"]` under `I` (the node files of ERD 2 plan 10 fixture X); `generateMachineToken` → `T`; `kanthord worker register` [T] → `rid`; `kanthord scheduler work pull --file pull.json` [T] → `x`, `e`, with `x.nodeId` = A.

| Id    | Commands                                                                                                                                           | Exit      | Expect                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E04.1 | `mission.evidence.submit` of A with `submit(x)` [T]                                                                                                | —         | completed; `uploads[0].putUrl` starts with `<s3.endpoint>/evidence/kanthord/<projectId>/<missionId>/<A>/1/`; `uploads[0].expiresAt` within one hour → `assetId`, `putUrl`, `headers` |
| E04.2 | `mission.evidence.asset.complete` of `assetId` with `complete` [T]                                                                                 | —         | a failure with status 409 and `intake.storage.object_mismatch`                                                                                                                       |
| E04.3 | `fetch(putUrl, { method: "PUT", headers, body: "hello" })`; `mission.evidence.asset.complete` of `assetId` with `complete` and a new key [T]       | 200, —    | completed; `uri` `s3://evidence/kanthord/<projectId>/<missionId>/<A>/1/<assetId>` → `v1` = the version that `fakeS3` recorded                                                        |
| E04.4 | A second `PUT` of the same key with the body `world` through the fixture; `kanthord mission evidence asset content get <assetId>`; `fetch(getUrl)` | —, 0, 200 | `getUrl` names `versionId` = `v1`; the body is `hello`                                                                                                                               |
| E04.5 | `kanthord mission get <projectId>` → M; `kanthord mission evidence asset delete <assetId> --force --reason "e2e" --expected-mission-version <M>`   | 0, 0      | `idempotencyKey` a ULID; `fakeS3` holds no version `v1` and keeps the second version                                                                                                 |
| E04.6 | `kanthord intake outbound list --operation s3.delete_object`                                                                                       | 0         | one item, `state` `succeeded`, `requestKey` = `assetId`, `result` `{ "location": "s3://evidence/…/<assetId>", "version": "<v1>" }`                                                   |
| E04.7 | `GET /api/intake/storage/asset/<assetId>` with T; with H                                                                                           | 401, 404  | first `gateway.authentication.unauthorized`; second `mission.record.not_found`                                                                                                       |
| E04.8 | `kanthord scheduler execution release <e> --file release(true)` [T]                                                                                | 0         | `endedAt` a number                                                                                                                                                                   |

E04.2 asserts the `code: proposed` code `intake.storage.object_mismatch`; the task waits for its publication (decision D2). E04.1 to E04.3 wait for the ruling of B5 on the PUT.

## Blockers

- B1, B5 and B6 of `00-index.md`: tasks 04.3 and 04.4 wait for their rulings. The PUT contract as a whole (`object_put` of task 04.2, `intake.storage.put` of task 04.3, the `put` call site of task 04.6 and E04.1 to E04.3) waits for the ruling of B5 on the allocation authority of the destination.
- `code: proposed`: `intake.storage.object_mismatch` (task 04.3) and `repository.platform.s3.<class>` with HTTP 502 (tasks 04.1, 04.4).

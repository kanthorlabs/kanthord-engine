# Plan 01: Custody Component

## Scope

This plan delivers:

- The `credential` table, its `(name, revision)` unique index and its migration.
- The AES-256-GCM credential envelope with HKDF-derived key and length-prefixed AAD.
- Platform validators: platform enum, secret-shape schemas, metadata schemas, local validation.
- All 9 `credential.*` operations: `create`, `list`, `get`, `rotate`, `update_metadata`,
  `revoke`, `login`, `login_code`, `login_status`.
- The `custodySuitability` and `credentialMetadata` output collaborations (consumed by Plans
  03 and 03 respectively).
- The `credentialDependents` internal call, with inline dependency types for
  `agentProvidersDependentOn` and `enablementsDependentOnModel` (Plan 03) and `bindingsNaming`
  (Plan 05). Plan 07 injects the implementations.
- OAuth login sessions as in-memory records with no persisted table.
- The `src/custody` ESLint service element and the `credential` migration prefix exemption
  in `src/apps/server/migrations.test.ts`.
- The resource healthcheck: `resourceInventory` method and `modelListCheck` collaboration on
  `CustodyComponent`; five platform probes; types
  `ResourceEntry`, `ResourceCheck` and `ResourceStatusValue` from `src/kernel/health.ts`
  (consumed by Plan 07).

This plan does not deliver:

- ERD 2 pin and handover calls (`pinCredential`, `liveExecutionsPinning`, execution store
  view, handover envelope).
- An HTTP removal route (no removal operation in ERD 1 CLI spec).
- Real `agentProvidersDependentOn` and `enablementsDependentOnModel` implementations (Plan 03 provides them).
- Real `bindingsNaming` implementation (Plan 05 provides it).

## Sources

- `docs/brainstorm/custody.md` — component scope, credential record rules, suitability,
  login sessions, resource healthcheck ownership.
- `docs/brainstorm/custody.vocabulary.md` — platform enum, secret shapes, login session
  state and mode sets.
- `docs/brainstorm/custody.impl.md` — credential store record, platform validators,
  envelope crypto, keys, operations, OAuth login, resource healthcheck.
- `docs/brainstorm/architecture.impl.md#the-credential-table` — AES-256-GCM envelope,
  masterKey derivation label `custody/aes-256-gcm/v1`, AAD encoding.
- `docs/brainstorm/architecture.impl.md#the-identity-and-the-time` — identity prefixes
  `credential_` and `login_session_`.
- `docs/brainstorm/architecture.impl.md#the-error-codes` — three-part error code rule;
  every page code holds three parts after Ulrich's 2026-09-27 ruling.
- `docs/brainstorm/architecture.impl.md#named-comparison-values` — no bare literals.
- `docs/reference/erd/01-setup.md#custody` — `credential` table columns, unique index,
  Custody constraints, additional authenticated data rule.
- `engine/docs/cli/credential.md` — 9 operations, HTTP routes, error codes, record schemas.
- `engine/docs/cli/common-flags.md` — flag resolution order, pagination contract,
  single-use enforcement.
- `engine/AGENTS.md#add-a-service`, `#add-a-migration`, `#add-an-operation` — file
  structure and migration rules.
- `engine/.agents/plan/erd-01-setup/00-index.md` — ESLint element rule, migration prefix exemption,
  seam table, ownership table.

## Depends on

None. The `credential` table has no ERD 1 peer dependency.

The injected collaborations `agentProvidersDependentOn` and `enablementsDependentOnModel`
come from Plan 03, and `bindingsNaming` comes from Plan 05. Plan 01 declares their types
inline and accepts them as required dependencies. Plan 01 places `unwired` stubs for all
three in the composition root and in `gatewayFixture`. Plan 03 replaces
`agentProvidersDependentOn` and `enablementsDependentOnModel`. Plan 05 replaces
`bindingsNaming`.

## Provides

| Seam                           | TypeScript signature                                                                                                                                                                                                                                                                                                                                    | Owner file               | Consumer plans |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------- |
| `custodySuitability`           | `(tx: Transaction, req: { credential: string; platform: string }): void` — reads newest live revision; throws on absent credential or platform mismatch                                                                                                                                                                                                 | `src/custody/service.ts` | 03, 05         |
| `credentialMetadata`           | `(tx: Transaction, credentialName: string): CredentialMetadata \| null` — nonsecret metadata read; returns `null` for unknown name                                                                                                                                                                                                                      | `src/custody/service.ts` | 03             |
| `CustodyComponent` constructor | `new CustodyComponent({ envelopeKey: Buffer, logger: Logger, health?: HealthRegistry, agentProvidersDependentOn: AgentProvidersDependentOnFn, bindingsNaming: BindingsNamingFn, enablementsDependentOnModel: EnablementsDependentOnModelFn })` — Plan 07 calls `deriveEnvelopeKey(config.masterKey)` and passes the result; collaborations are required | `src/custody/index.ts`   | 07             |
| `resourceInventory`            | `(tx: Transaction): ResourceEntry[]` — synchronous; one global `ResourceEntry` per credential name (newest live revision, `ended_at IS NULL`); `target` = `credential:<revision id>`; `check` closure decrypts and runs the platform probe                                                                                                              | `src/custody/service.ts` | 07             |
| `modelListCheck`               | `(tx: Transaction, credentialName: string): ResourceCheck` — reads the newest live revision of the name inside `tx`; returns a closure that runs the `GET /models` probe (anthropic, openai-compatible); a missing revision or a non-model-list platform returns a closure that answers `unknown` without a remote call                                 | `src/custody/service.ts` | 03, 07         |

## Tasks

### 01.0 Fix the read commit gate in `src/gateway/invocation.ts`

- Files:
  - `engine/src/gateway/invocation.ts` (edit)
  - `engine/src/gateway/invocation.test.ts` (create or edit)
- Do:
  1. In `engine/src/gateway/invocation.ts`, change line 326.
     Current: `if (!reservation || committed) throw new Error("A mutation commits exactly once.")`.
     Replace with: `if (committed) throw new Error("caller.commit: called twice.")`.
  2. At line 340, change `this.idempotency.complete(reservation!, committed, operation.secret)` to
     `if (reservation) this.idempotency.complete(reservation, committed, operation.secret)`.
  3. In `src/gateway/invocation.test.ts` (create in `src/gateway/` or add to the existing test if one exists), add two tests using a minimal fake operation registry and fake store:
     - `"read operation commits once"`: register a read operation (mutation false) with no `Idempotency-Key` header; call the handler which calls `caller.commit`; assert the call returns successfully with HTTP 200.
     - `"second commit throws"`: register any operation; in the handler closure call `caller.commit` twice; assert the second call (inside the handler) throws an error whose message contains `"called twice"`. Do not assert HTTP status or invocation return value for this test — `Invocation.execute` catches errors and converts them to a generic failure response; the throw must be asserted at the handler level.
- Rules:
  - Every operation (read and mutation alike) may call `caller.commit` exactly once (`architecture.impl.md:618`).
  - The idempotency record completes only when a reservation exists (reads have no reservation; `architecture.impl.md:683`).
  - No code comments.
- Done when:
  - `node --test src/gateway/invocation.test.ts` passes both new tests.
  - The existing read handlers in Plans 01–06 (for example `credential.get`, `credential.list`) can call `caller.commit` without the error.
  - `pnpm run verify` passes.

### 01.1 Create scaffold: table migration, operation contracts, ESLint element, migration test

- Files:
  - `engine/src/custody/contract.ts`
  - `engine/src/custody/migrations.ts`
  - `engine/src/custody/index.ts`
  - `engine/eslint.config.js`
  - `engine/AGENTS.md`
  - `engine/src/apps/server/migrations.test.ts`
- Do:
  1. Create `engine/src/custody/migrations.ts`. Import `Migration` from `../kernel/store.ts`.
     Declare one `Migration` function that executes:
     ```sql
     CREATE TABLE credential (
       id         TEXT    NOT NULL PRIMARY KEY,
       name       TEXT    NOT NULL,
       platform   TEXT    NOT NULL,
       revision   INTEGER NOT NULL,
       nonce      BLOB    NOT NULL,
       ciphertext BLOB    NOT NULL,
       metadata   TEXT,
       created_at INTEGER NOT NULL,
       ended_at   INTEGER
     );
     CREATE UNIQUE INDEX credential_name_revision ON credential (name, revision);
     ```
     Export `custodyMigrations: readonly Migration[]` containing that function.
  2. Create `engine/src/custody/contract.ts`. Declare and export:
     - `const CUSTODY_SERVICE_NAME = "custody"` — used as the migration service name in `migrations.ts` and in the migration test entry `{ service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations }`.
     - `const CREDENTIAL_OPERATION_SERVICE = "credential"` — used as the `service` value of every operation declaration in `custodyOperations`; required by `engine/src/gateway/openapi.ts:51`, which refuses an operation id that does not start with `<operation.service>.`.
     - `const CREDENTIAL_TIMEOUT_MS = 30000`.
     - `const CREATE_MAX_BODY_BYTES = 64 * 1024`.
     - `const METADATA_MAX_BODY_BYTES = 16 * 1024`.
     - `const REVOKE_MAX_BODY_BYTES = 0` (no body; route `credential.revoke` is body-absent).
     - All 9 operation declarations in `custodyOperations satisfies Record<string, Operation>`.
       Every operation: `service: CREDENTIAL_OPERATION_SERVICE`, `access: AccessPolicy.Human`,
       `store: StoreName.Operational`, `lifetime: OperationLifetime.Unary`,
       `timeoutMs: CREDENTIAL_TIMEOUT_MS`.

       | Id                           | Method | Path                                                        | Mutation | Input body                                          | maxBodyBytes              |
       | ---------------------------- | ------ | ----------------------------------------------------------- | -------- | --------------------------------------------------- | ------------------------- |
       | `credential.create`          | POST   | `/api/credential`                                           | true     | `{ name, platform, metadata, secret }` closed       | `CREATE_MAX_BODY_BYTES`   |
       | `credential.list`            | GET    | `/api/credential`                                           | false    | null; query `{ platform?, limit?, cursor? }` closed | —                         |
       | `credential.get`             | GET    | `/api/credential/:credentialName`                           | false    | null; params `{ credentialName }` closed            | —                         |
       | `credential.rotate`          | POST   | `/api/credential/:credentialName/revision`                  | true     | `{ expectedRevision, secret, metadata? }` closed    | `CREATE_MAX_BODY_BYTES`   |
       | `credential.update_metadata` | PUT    | `/api/credential/:credentialName/metadata`                  | true     | `{ expectedRevision, metadata }` closed             | `METADATA_MAX_BODY_BYTES` |
       | `credential.revoke`          | POST   | `/api/credential/:credentialName/revision/:revision/revoke` | true     | null; params `{ credentialName, revision }` closed  | —                         |
       | `credential.login`           | POST   | `/api/credential/login`                                     | true     | `{ platform, name, mode? }` closed                  | `METADATA_MAX_BODY_BYTES` |
       | `credential.login_code`      | POST   | `/api/credential/login/:sessionId/code`                     | true     | `{ value }` closed; params `{ sessionId }`          | `METADATA_MAX_BODY_BYTES` |
       | `credential.login_status`    | GET    | `/api/credential/login/:sessionId`                          | false    | null; params `{ sessionId }` closed                 | —                         |

       Each schema is a `z.strictObject`. Read operations have `body: false` and no maxBodyBytes.

     - Export `CredentialMetadata` type: `{ id: string; name: string; platform: string; metadata: Record<string, unknown> | null }`.
     - Export `CustodySuitabilityFn` type:
       `(tx: Transaction, req: { credential: string; platform: string }) => void`.
     - Export `CredentialMetadataFn` type:
       `(tx: Transaction, credentialName: string) => CredentialMetadata | null`.
  3. Create `engine/src/custody/index.ts`. Export only `custodyMigrations` from
     `./migrations.ts`. The `CustodyComponent` and `Dependencies` exports are added in
     task 01.4 when the class exists.
  4. Edit `engine/eslint.config.js`. In the `service` element pattern, add `custody` to the
     alternation: change `src/(project|mission|scheduler|worker|tracking|gateway)` to
     `src/(custody|project|mission|scheduler|worker|tracking|gateway)`.
  5. Edit `engine/AGENTS.md`. In the project structure block, add:
     `src/custody/` — Custody component: credential envelope, platform validators, OAuth
     login sessions, and platform probes.
  6. Edit `engine/src/apps/server/migrations.test.ts`:
     - Import `custodyMigrations` from `../../custody/index.ts`.
     - Import `CUSTODY_SERVICE_NAME` from `../../custody/contract.ts`.
     - Add `{ service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations }` before the
       `gateway` entry in `services`.
     - Declare `const CREDENTIAL_TABLE = "credential"` in the test file.
     - In the prefix ownership loop, compute `const isCredentialException = service.service === CUSTODY_SERVICE_NAME && name === CREDENTIAL_TABLE`. Skip the `name.startsWith(...)` and `prefixes.filter(...)` assertions when `isCredentialException` is true.
     - Update the final `assert.deepEqual(tables(store), [...])` to include `"credential"`.
- Rules:
  - `credential` carries no `custody_` prefix; it is the one permitted unprefixed table
    (architecture.impl.md:98; 00-index.md shared-conventions table).
  - Unique index on `(name, revision)` only; no other index (01-setup.md Custody constraints;
    CLAUDE.local.md: no non-unique index).
  - No SQL CHECK constraint (CLAUDE.local.md).
  - `metadata TEXT` is nullable; platforms with no metadata schema store SQL NULL.
  - Migration version 1 of service `CUSTODY_SERVICE_NAME` (AGENTS.md#add-a-migration).
  - The migration test imports `CUSTODY_SERVICE_NAME` from contract.ts; it never re-declares
    the service name as a bare literal (architecture.impl.md:17).
- Done when:
  - `node --test src/apps/server/migrations.test.ts` passes, including the isolation test for
    `custody` alone and the prefix test with the `credential` exemption.
  - After isolation: `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('credential')` produces exactly the 9 columns with correct nullability.
  - `SELECT name FROM sqlite_master WHERE type='index'` on the custody-only store returns only `credential_name_revision`.
  - `pnpm run verify` passes.

### 01.2 Create credential envelope (AES-256-GCM)

- Files:
  - `engine/src/custody/envelope.ts`
  - `engine/src/custody/envelope.test.ts`
- Do:
  1. Create `engine/src/custody/envelope.ts`. Import `createCipheriv`, `createDecipheriv`,
     `randomBytes` from `node:crypto` and `deriveKey` from `../kernel/json.ts`.
     - Export `const CIPHER_ALGORITHM = "aes-256-gcm"`.
     - Export `const CIPHER_KEY_LABEL = "custody/aes-256-gcm/v1"`.
     - Export `const NONCE_BYTES = 12`.
     - Export `const TAG_BYTES = 16`.
     - Export `const AAD_LENGTH_FIELD_SIZE = 4`.
     - Export `function deriveEnvelopeKey(masterKey: string): Buffer` — calls
       `deriveKey(masterKey, CIPHER_KEY_LABEL)`.
     - Export `function buildAad(id: string, platform: string): Buffer` — encodes each field
       as a 4-byte big-endian length followed by UTF-8 bytes, concatenated.
     - Export `function encrypt(key: Buffer, id: string, platform: string, secret: unknown): { nonce: Buffer; ciphertext: Buffer }` — generates `NONCE_BYTES` random bytes nonce,
       builds AAD with `buildAad`, creates cipher with `createCipheriv(CIPHER_ALGORITHM, key, nonce)`,
       calls `cipher.setAAD(aad)`, encrypts the canonical JSON of `secret`, appends the
       `TAG_BYTES`-byte `getAuthTag()` to the ciphertext buffer.
     - Export `function decrypt(key: Buffer, id: string, platform: string, nonce: Buffer, ciphertext: Buffer): unknown`:
       - Throw if `nonce.length !== NONCE_BYTES`.
       - Throw if `ciphertext.length <= TAG_BYTES`.
       - Slice tag from the last `TAG_BYTES` bytes of `ciphertext`.
       - Create decipher with `createDecipheriv(CIPHER_ALGORITHM, key, nonce)`.
       - Call `decipher.setAAD(buildAad(id, platform))` then `decipher.setAuthTag(tag)`.
       - Call `decipher.update` then `decipher.final`.
       - Return `JSON.parse` of the plaintext.
  2. Create `engine/src/custody/envelope.test.ts`. Test:
     - Round-trip for each secret shape: `decrypt(key, id, platform, nonce, ciphertext)` returns
       the original secret value.
     - Wrong `id` in decrypt throws.
     - Wrong `platform` in decrypt throws.
     - Nonce length not equal to `NONCE_BYTES` throws.
     - Ciphertext length equal to `TAG_BYTES` throws.
     - One modified ciphertext byte throws (tag failure).
     - Two encryptions of the same input produce different nonces.
- Rules:
  - Cipher key label `"custody/aes-256-gcm/v1"` (custody.impl.md#the-keys;
    architecture.impl.md#the-credential-table).
  - AAD = length-prefixed row identity then length-prefixed platform
    (01-setup.md Custody constraints: "the row identity and the platform").
  - 12-byte random nonce per write (architecture.impl.md#the-credential-table).
  - Ciphertext = AES-256-GCM output + 16-byte tag (architecture.impl.md#the-credential-table).
  - `createDecipheriv` verifies the tag before the caller reads plaintext
    (architecture.impl.md#the-credential-table). A read of another length fails the record
    (architecture.impl.md:210).
  - `masterKey` is not used directly; `deriveEnvelopeKey` derives the cipher key
    (custody.impl.md#the-keys).
- Done when:
  - `node --test src/custody/envelope.test.ts` passes all round-trip and error cases including
    nonce-length and modified-byte tests.
  - `pnpm run verify` passes.

### 01.3 Create platform validators (local schema)

- Files:
  - `engine/src/custody/platforms.ts`
  - `engine/src/custody/platforms.test.ts`
- Do:
  1. Create `engine/src/custody/platforms.ts`.
     - Export `const Platform = { GitHub: "github", GitHubCopilot: "github-copilot", Anthropic: "anthropic", OpenAICompatible: "openai-compatible", S3: "s3" } as const`.
     - Export `type Platform = (typeof Platform)[keyof typeof Platform]`.
     - Export `const SecretShape = { ApiKey: "api_key", OAuth: "oauth", S3AccessKey: "s3_access_key" } as const`.
     - Export `type SecretShape = (typeof SecretShape)[keyof typeof SecretShape]`.
     - Export `const PLATFORM_SECRET_SHAPE: Record<Platform, SecretShape>` mapping each
       platform to its shape (GitHub→ApiKey, GitHubCopilot→OAuth, Anthropic→ApiKey,
       OpenAICompatible→ApiKey, S3→S3AccessKey).
     - Export `const OAUTH_PLATFORMS: readonly Platform[] = [Platform.GitHubCopilot]`.
     - Export `const RESERVED_NAME_LOGIN = "login"`.
     - Export `function isNonblank(s: string): boolean` — returns `s.trim().length > 0`.
     - Export Zod schemas (all `z.strictObject`):
       - `apiKeySecretSchema`: `{ key: z.string().min(1).refine(isNonblank) }`.
       - `oauthSecretSchema`: `{ refresh: z.string().min(1), access: z.string().min(1), expires: z.number().int() }` (OAuth material is arbitrary token bytes; no nonblank refine on access/refresh).
       - `s3AccessKeySecretSchema`: `{ accessKeyId: z.string().min(1).refine(isNonblank), secretAccessKey: z.string().min(1).refine(isNonblank) }` (no `sessionToken` field).
     - Export `const ReasoningLevel = { Off: "off", Minimal: "minimal", Low: "low", Medium: "medium", High: "high", Xhigh: "xhigh", Max: "max" } as const`.
     - Export `type ReasoningLevel = (typeof ReasoningLevel)[keyof typeof ReasoningLevel]`.
     - Export `const MODEL_DEFAULT_CONTEXT_WINDOW = 128000`.
     - Export `const MODEL_DEFAULT_MAX_TOKENS = 16384`.
     - Export `const MODEL_DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = [ReasoningLevel.Off]`.
     - Export Zod `approvedModelSchema`: closed object with required `id: z.string().min(1).refine(isNonblank)`, optional `contextWindow: z.number().int().positive()`, optional `maxTokens: z.number().int().positive()`, optional `reasoningLevels: z.array(z.nativeEnum(ReasoningLevel))`. Add a `.refine(m => { const cw = m.contextWindow ?? MODEL_DEFAULT_CONTEXT_WINDOW; const mt = m.maxTokens ?? MODEL_DEFAULT_MAX_TOKENS; return mt <= cw; })`.
     - Export Zod `openaiCompatibleMetadataSchema`: closed object `{ baseUrl: z.string().regex(/^https?:\/\/[^?#]+[^?#/]$/), models: z.array(approvedModelSchema) }`.
     - Export Zod `s3MetadataSchema`: closed object `{ endpoint: z.string().url(), bucket: z.string().min(1).refine(isNonblank), region: z.string().min(1).refine(isNonblank) }`.
     - Export `function secretSchemaForPlatform(platform: Platform): z.ZodType` returning the matching schema.
     - Export `function metadataSchemaForPlatform(platform: Platform): z.ZodType | null` returning `openaiCompatibleMetadataSchema`, `s3MetadataSchema`, or `null`.
     - Export `function validateNameForm(name: string): boolean` — true when name is 1-63
       chars, starts with a lower-case letter, then contains only lower-case letters, digits
       and hyphens.
  2. Create `engine/src/custody/platforms.test.ts`. Test:
     - `PLATFORM_SECRET_SHAPE` maps each platform to the correct shape.
     - `OAUTH_PLATFORMS` contains only `Platform.GitHubCopilot`.
     - `secretSchemaForPlatform` returns the correct schema for each platform.
     - `openai-compatible` metadata requires `baseUrl` and `models`.
     - `models: []` is valid.
     - Model with all optional fields omitted passes schema validation.
     - Model with `maxTokens` set to `contextWindow` passes; `maxTokens > contextWindow` fails.
     - Model `id` of whitespace-only string fails `isNonblank`.
     - `metadataSchemaForPlatform` returns `null` for github, github-copilot, anthropic.
     - `s3` `bucket` and `region` of whitespace-only string fail.
     - `validateNameForm`: valid examples pass; name exceeding 63 chars fails; name starting
       with a digit fails; name with uppercase letters fails; empty string fails.
- Rules:
  - Closed platform set; unsupported platform is refused at the service layer
    (custody.md#credential-records; custody.vocabulary.md#platform).
  - `oauth` shape entered only through a login session; `credential.create` refuses
    oauth platforms (custody.impl.md#operations).
  - Model defaults: `contextWindow 128000`, `maxTokens 16384`, `reasoningLevels ["off"]`
    (custody.impl.md#platform-validators).
  - `maxTokens` must not exceed `contextWindow` after defaults apply
    (custody.impl.md#platform-validators).
  - `s3_access_key` holds no session token (custody.impl.md#platform-validators).
  - Nonblank rule applies to every human-supplied label field (bucket, region, model id)
    (engine/docs/cli/credential.md:110, 119–120).
  - Named constants for every fixed numeric value (architecture.impl.md:17).
- Done when:
  - `node --test src/custody/platforms.test.ts` passes all schema, enum and validation tests.
  - `pnpm run verify` passes.

### 01.4 `credential.create`, `credential.get`, `credential.list` handlers

- Files:
  - `engine/src/custody/service.ts`
  - `engine/src/custody/service.test.ts`
  - `engine/src/custody/index.ts`
- Do:
  1. Create `engine/src/custody/service.ts`. Import `Logger` from `pino`.
     Declare `export class CustodyComponent implements Service`.
     Constructor accepts `{ envelopeKey: Buffer; logger: Logger; health?: HealthRegistry }`.
     The constructor calls `health?.register("custody", () => this.healthcheck())`.
     `healthcheck()` returns `{ credential: this.started && !this.shutdown.err() ? HealthStatus.Healthy : HealthStatus.Unavailable }`.
     Add `declare(registry: OperationRegistry): void` that binds handlers for all 9 operations.
     Implement the full `Service` lifecycle (`start`, `quiesce`, `stop`, `run`)
     following the pattern in `engine/src/project/service.ts`.
     Implement three handlers in this task:
     - `credential.create` handler (all steps run inside the transaction `caller.commit` supplies):
       - Parse body; catch Zod parse failure and throw `OperationError(400, "credential.input.invalid", "Invalid input.", null)`.
       - Validate name form with `validateNameForm`; throw `OperationError(400, "credential.input.invalid", ...)` on failure.
       - Refuse name equal to `RESERVED_NAME_LOGIN`; throw `OperationError(400, "credential.input.invalid", ...)`.
       - Validate platform against `Platform` values; throw `OperationError(400, "credential.platform.unsupported", ...)`.
       - Refuse `platform` in `OAUTH_PLATFORMS`; throw `OperationError(400, "credential.entry.unsupported", ...)`.
       - Check for existing row with the same `name`; throw `OperationError(409, "credential.name.conflict", ...)` with the identity of the newest revision in `details`.
       - Validate secret with `secretSchemaForPlatform(platform).parse(body.secret)`; catch parse error → `OperationError(400, "credential.input.invalid", ...)`.
       - Validate metadata: if `metadataSchemaForPlatform(platform)` is not null, parse and throw on failure; if platform is `OpenAICompatible`, refuse nonempty `models` array (first revision starts with no models). If schema is null, require `metadata === null`.
       - Mint `id = createIdentity("credential")`. Encrypt secret with `encrypt(envelopeKey, id, platform, secret)`.
       - Insert row: `id`, `name`, `platform`, `revision = 1`, `nonce`, `ciphertext`, `metadata` as canonical JSON or SQL NULL, `created_at = Date.now()`, `ended_at = NULL`.
       - Call `this.logger.info({ credentialId: id, humanIdentity: caller.identity }, "credential created")`.
       - Return credential answer: `{ name, platform, revisions: [{ id, revision, metadata, createdAt, endedAt: null }] }` with no `secret`.
     - `credential.get` handler (runs inside `caller.commit`):
       - Query all rows for `params.credentialName`, ordered by `revision` descending.
       - Throw `OperationError(404, "credential.credential.not_found", ...)` if none.
       - Return credential answer with all revisions, newest first.
     - `credential.list` handler (runs inside `caller.commit`):
       - Query rows applying optional `platform` filter from `query.platform`.
       - Return one answer per distinct `name`, ordered by `name` ascending (`docs/brainstorm/architecture.impl.md` pagination: a list of group keys orders by that key in ascending alphabetical order, and the next page reads the keys greater than the cursor).
       - Return `{ items: CredentialAnswer[], nextCursor: string | null }` following the cursor pagination contract: the cursor is the base64url `name` of the last item, and the next page selects `name > cursor`.
  2. Edit `engine/src/custody/index.ts`. Add exports:
     - `export { CustodyComponent, type Dependencies } from "./service.ts"`.
  3. Create `engine/src/custody/service.test.ts`. Test:
     - `credential.create` for each non-OAuth platform with valid input.
     - Name conflict: second create with the same name returns 409 with the existing id in details.
     - Name `login` refused with 400 `credential.input.invalid`.
     - `openai-compatible` create with nonempty `models` refused.
     - Platform `github-copilot` refused with 400 `credential.entry.unsupported`.
     - Unknown platform refused with 400 `credential.platform.unsupported`.
     - Invalid secret schema refused with 400 `credential.input.invalid`.
     - No `secret` key in any answer.
     - `credential.get` returns all revisions newest first; unknown name returns 404.
     - `credential.list` returns names in order; platform filter narrows results.
     - Audit log call emitted for create (assert logger spy receives `credentialId` and `humanIdentity`).
- Rules:
  - Identity prefix `credential_<ulid>` (architecture.impl.md:159; 00-index.md identity prefixes).
  - No secret in any answer (custody.impl.md#the-credential-store-record; custody.md#credential-records).
  - `revision = 1` for a new name (custody.impl.md#the-credential-store-record).
  - Every comparison uses a named constant (architecture.impl.md:17).
  - No code comment (user global instructions).
  - Zod parse failures map to `OperationError(400, "credential.input.invalid", ...)`;
    they never escape as unhandled errors (engine/docs/cli/credential.md:252).
  - Validate schema before dereferencing fields (to avoid undefined-access crashes before error mapping).
  - `openai-compatible` first revision starts with `models: []` (custody.impl.md:63).
  - Audit log records human identity and row identity, never the secret
    (custody.impl.md:36).
- Done when:
  - `node --test src/custody/service.test.ts` passes all create, get, list cases.
  - `pnpm run verify` passes.

### 01.5 `credential.rotate`, `credential.update_metadata`, `credential.revoke` handlers

- Files:
  - `engine/src/custody/service.ts`
  - `engine/src/custody/service.test.ts`
- Do:
  1. In `engine/src/custody/service.ts`, add three handlers:
     - `credential.rotate` handler (runs inside transaction):
       - Read newest live revision for `params.credentialName`; throw `OperationError(404, "credential.credential.not_found", ...)` if absent.
       - Verify `body.expectedRevision === newestLiveRevision.revision`; throw `OperationError(409, "credential.revision.conflict", ...)` with current revision in `details` when stale.
       - Parse and validate `body.secret` with `secretSchemaForPlatform(platform)`.
       - Determine new metadata: use `body.metadata` if present, else copy `newestLiveRevision.metadata`. Validate with `metadataSchemaForPlatform`. For `openai-compatible`: collect removed model ids (present in current, absent in new); call model removal check (stub returns empty until 01.7); refuse if dependents returned.
       - Mint new `id = createIdentity("credential")` FIRST. Encrypt new secret with `encrypt(envelopeKey, id, platform, secret)`. Insert next revision with `revision = newestLiveRevision.revision + 1`, new `id`, `nonce`, `ciphertext`, new metadata, `ended_at = NULL`. Keep all older revisions untouched.
       - Call `this.logger.info({ credentialId: id, humanIdentity: caller.identity }, "credential rotated")`.
       - Return credential answer.
     - `credential.update_metadata` handler (runs inside transaction):
       - Read newest live revision; throw `OperationError(404, "credential.credential.not_found", ...)` if absent.
       - Verify `body.expectedRevision`; throw `OperationError(409, "credential.revision.conflict", ...)` when stale.
       - Parse and validate `body.metadata` with `metadataSchemaForPlatform`; catch parse error → `OperationError(400, "credential.input.invalid", ...)`.
       - For `openai-compatible`: after validation, check `body.metadata.baseUrl !== newestLiveRevision.parsedMetadata.baseUrl`; throw `OperationError(409, "credential.metadata.base_url_fixed", ...)` if so. Collect removed model ids; call model removal check stub; refuse if dependents.
       - Mint new `id = createIdentity("credential")` FIRST. Decrypt `newestLiveRevision.ciphertext` with the old id and platform. Re-encrypt using the new `id`. Insert next revision with new metadata, same secret material, `ended_at = NULL`.
       - Call `this.logger.info({ credentialId: id, humanIdentity: caller.identity }, "credential metadata updated")`.
       - Return credential answer.
     - `credential.revoke` handler (runs inside transaction):
       - Read row by `params.credentialName` and `params.revision`; throw `OperationError(404, "credential.revision.not_found", ...)` if absent.
       - Throw `OperationError(409, "credential.revision.ended", ...)` if `ended_at` is not null.
       - Throw `OperationError(409, "credential.revision.newest_live", ...)` if no later row with null `ended_at` exists.
       - Set `ended_at = Date.now()` for that row.
       - Return credential answer.
  2. In `engine/src/custody/service.test.ts`, add tests:
     - Rotation without metadata: copies metadata of newest live revision.
     - Rotation with metadata: uses supplied metadata.
     - Rotation on `openai-compatible` with new `baseUrl` succeeds.
     - Stale `expectedRevision` on rotate returns 409 `credential.revision.conflict` with current value.
     - Two concurrent rotations of the same credential: second returns 409 `credential.revision.conflict`.
     - Metadata edit inserts next revision with same decrypted secret (decrypt and compare).
     - Metadata edit changing `baseUrl` on `openai-compatible` returns 409 `credential.metadata.base_url_fixed`.
     - Stale `expectedRevision` on metadata edit returns 409 `credential.revision.conflict`.
     - Two concurrent metadata edits: second returns 409 `credential.revision.conflict`.
     - Revoke of a non-newest revision sets `ended_at`.
     - Revoke of newest live revision returns 409 `credential.revision.newest_live`.
     - Revoke of already ended revision returns 409 `credential.revision.ended`.
     - No secret in any answer.
     - Audit log emitted for rotate and update_metadata.
- Rules:
  - Mint new row identity BEFORE encryption, because the AAD uses the identity
    (architecture.impl.md#the-credential-table; 01-setup.md Custody constraints).
  - `expectedRevision` names the newest live revision; stale value → 409
    `credential.revision.conflict` (custody.impl.md:29).
  - `baseUrl` is fixed for the life of a revision; change only at rotation
    (custody.impl.md#platform-validators).
  - Rotation keeps older revisions live (custody.md#credential-records).
  - Revoke refuses the newest live revision (custody.md; 01-setup.md Custody).
  - `revision = max(current) + 1` in the inserting transaction (architecture.impl.md:167).
  - Validate schema before dereferencing fields.
  - Audit log records human identity and row identity, never the secret
    (custody.impl.md:36).
- Done when:
  - `node --test src/custody/service.test.ts` passes all rotate, update_metadata, revoke cases.
  - `pnpm run verify` passes.

### 01.6 `custodySuitability` and `credentialMetadata` collaborations

- Files:
  - `engine/src/custody/contract.ts`
  - `engine/src/custody/service.ts`
  - `engine/src/custody/service.test.ts`
- Do:
  1. In `engine/src/custody/contract.ts`, the types `CustodySuitabilityFn` and
     `CredentialMetadataFn` are already declared in 01.1. No addition needed if they were
     included; verify and add if missing.
  2. In `engine/src/custody/service.ts`, add two public methods:
     - `custodySuitability(tx: Transaction, req: { credential: string; platform: string }): void`:
       - Select the newest live revision row for `req.credential` using `tx.database`.
       - Throw `OperationError(404, "credential.credential.not_found", ...)` if absent.
       - Throw `OperationError(400, "credential.platform.mismatch", ...)` if `row.platform !== req.platform`.
     - `credentialMetadata(tx: Transaction, credentialName: string): CredentialMetadata | null`:
       - Select the newest live revision row for `credentialName` using `tx.database`.
       - Return `null` if absent.
       - Parse stored metadata: `row.metadata === null ? null : JSON.parse(row.metadata)`.
       - Return `{ id: row.id, name: row.name, platform: row.platform, metadata }`.
  3. In `engine/src/custody/service.test.ts`, add tests:
     - `custodySuitability` passes for matching platform.
     - `custodySuitability` throws code `credential.credential.not_found` for unknown name.
     - `custodySuitability` throws code `credential.platform.mismatch` for wrong platform.
     - `credentialMetadata` returns the metadata object for a known credential.
     - `credentialMetadata` returns `null` for unknown credential.
     - `credentialMetadata` result contains no secret.
- Rules:
  - Suitability compares record platform with requested platform; reads no secret; makes no
    remote call (custody.impl.md#suitability; custody.md#suitability-and-authority).
  - `credentialMetadata` returns nonsecret fields only (00-index.md seam table).
  - Newest live revision = greatest `revision` with null `ended_at`
    (custody.impl.md#the-credential-store-record).
  - Outgoing collaboration function types are declared in `contract.ts` so consumers can
    reference them without importing `service.ts` (00-index.md collaboration-type contract rule).
- Done when:
  - `node --test src/custody/service.test.ts` passes all suitability and metadata tests.
  - `pnpm run verify` passes.

### 01.7 Injected dependency types and `credentialDependents`

- Files:
  - `engine/src/custody/contract.ts`
  - `engine/src/custody/service.ts`
  - `engine/src/custody/service.test.ts`
- Do:
  1. In `engine/src/custody/contract.ts`, add inline dependency type declarations:
     - `AgentProviderDependent`: `{ agentName: string; providerName: string }` — a nontombstoned
       enablement row whose `agent_providers` names the credential.
     - `BindingRevision`: `{ bindingId: string; projectId: string }` — a binding revision that
       is a dependent.
     - `AgentEnablement`: `{ agentName: string }` — an enablement whose default or entry
       references the model; Plan 01 needs only `agentName` for the refusal detail list.
     - `AgentProvidersDependentOnFn`: `(tx: Transaction, credentialName: string) => AgentProviderDependent[]`.
     - `BindingsNamingFn`: `(tx: Transaction, credentialName: string) => BindingRevision[]`.
     - `EnablementsDependentOnModelFn`: `(tx: Transaction, credentialName: string, modelId: string) => AgentEnablement[]`.
  2. In `engine/src/custody/service.ts`, declare `export interface Dependencies`:
     - `envelopeKey: Buffer`
     - `logger: Logger`
     - `health?: HealthRegistry`
     - `agentProvidersDependentOn: AgentProvidersDependentOnFn`
     - `bindingsNaming: BindingsNamingFn`
     - `enablementsDependentOnModel: EnablementsDependentOnModelFn`
       Update the constructor to accept `Dependencies` and store each field. The three
       collaboration fields are required; tests pass fake implementations; Plan 07 passes
       the real ones.
  3. Add private method `credentialDependents(tx: Transaction, credentialName: string): { agentProviders: AgentProviderDependent[]; bindings: BindingRevision[] }`:
     - Returns `{ agentProviders: this.agentProvidersDependentOn(tx, credentialName), bindings: this.bindingsNaming(tx, credentialName) }`.
  4. Replace the stub model removal checks in `credential.rotate` and `credential.update_metadata`:
     - For each model id present in the current metadata but absent in the new metadata, call
       `this.enablementsDependentOnModel(tx, credentialName, modelId)`.
     - If any enablement is returned, throw `OperationError(409, "credential.metadata.model_in_use", ...)` with the list of dependent `agentName` values in `details`.
     - The check and the metadata insert commit in one transaction (custody.impl.md#platform-validators).
  5. In `engine/src/custody/service.test.ts`, add tests:
     - Metadata edit removing a model: stub `enablementsDependentOnModel` returns one dependent →
       returns 409 `credential.metadata.model_in_use` with dependent details.
     - Metadata edit removing a model: stub returns empty → succeeds.
     - Rotation dropping a model: same checks.
- Rules:
  - Inline dependency types in Custody's own `contract.ts`; no import from a peer
    service's `contract.ts` (00-index.md collaboration-type contract rule).
  - Injected collaborations are required; tests pass fake implementations (D4); Plan 07
    wires the real implementations. A missing dependency must not silently permit a write.
  - Model removal check and metadata update commit in one transaction
    (custody.impl.md#platform-validators).
  - Dependency refusals list dependents in `error.details` (custody.md#credential-records).
- Done when:
  - `node --test src/custody/service.test.ts` passes model removal tests with stubs.
  - `pnpm run verify` passes.

### 01.8 OAuth login session store

- Files:
  - `engine/src/custody/sessions.ts`
  - `engine/src/custody/sessions.test.ts`
- Do:
  1. Create `engine/src/custody/sessions.ts`.
     - Export `const LoginSessionState = { Pending: "pending", Completed: "completed", Failed: "failed", Expired: "expired" } as const`.
     - Export `type LoginSessionState = (typeof LoginSessionState)[keyof typeof LoginSessionState]`.
     - Export `const LoginSessionMode = { Browser: "browser", Device: "device" } as const`.
     - Export `type LoginSessionMode = (typeof LoginSessionMode)[keyof typeof LoginSessionMode]`.
     - Export `const SESSION_EXPIRY_MS = 15 * 60 * 1000`.
     - Export `interface LoginSession`:
       `{ id: string; platform: string; mode: string; humanIdentity: string; credentialName: string; state: LoginSessionState; address: string | null; code: string | null; lastMessage: string | null; failureReason: string | null; expiresAt: number }`.
     - Export `class LoginSessionStore` backed by an in-memory `Map<string, LoginSession>`:
       - `start(platform: string, mode: string, humanIdentity: string, credentialName: string, now: number): LoginSession`:
         Throw `OperationError(409, "credential.login.pending", ...)` if another non-expired `Pending` session exists for the same `platform` and `humanIdentity` (check `session.expiresAt > now` to treat expired sessions as absent).
         Mint `id = createIdentity("login_session")`. Set `state = LoginSessionState.Pending` and `expiresAt = now + SESSION_EXPIRY_MS`. Store in map. Return session.
       - `get(id: string): LoginSession | undefined`.
       - `pendingForPlatformAndHuman(platform: string, humanIdentity: string, now: number): LoginSession | undefined` — returns the session if non-expired and pending.
       - `complete(id: string): void` — sets state to `Completed`.
       - `fail(id: string, reason: string): void` — sets state to `Failed` and `failureReason`.
       - `expire(id: string): void` — sets state to `Expired`.
       - `updateAddress(id: string, address: string | null, code: string | null): void`.
       - `updateLastMessage(id: string, message: string): void`.
  2. Create `engine/src/custody/sessions.test.ts`. Test:
     - `start` creates a session with `expiresAt = now + SESSION_EXPIRY_MS`.
     - `start` with non-expired pending session for same platform+human throws `credential.login.pending`.
     - `start` with expired pending session for same platform+human succeeds (treated as absent).
     - Different human identity gets a separate session.
     - `get` returns session for known id; returns `undefined` for unknown id.
     - `complete`, `fail`, `expire` set state correctly.
     - `updateAddress` sets address and code.
- Rules:
  - Login session identity `login_session_<ulid>` (custody.impl.md#the-oauth-login;
    00-index.md identity prefixes).
  - Session expiry 15 minutes after start (custody.impl.md#the-oauth-login).
  - At most one non-expired pending session per platform and human
    (custody.impl.md#the-oauth-login).
  - Named constants for state strings (architecture.impl.md:17).
- Done when:
  - `node --test src/custody/sessions.test.ts` passes all session lifecycle tests.
  - `pnpm run verify` passes.

### 01.9 OAuth login handlers and session completion

- Files:
  - `engine/src/custody/service.ts`
  - `engine/src/custody/service.test.ts`
- Do:
  1. In `engine/src/custody/service.ts`, add `private readonly sessions = new LoginSessionStore()`.
     Update `quiesce()` and `stop()` to cancel any running pi-ai login interactions (cancel the
     `CancellationContext` that owns background login work).
     Implement three handlers:
     - `credential.login` handler:
       - Verify `platform` is in `OAUTH_PLATFORMS`; throw `OperationError(400, "credential.entry.unsupported", ...)` otherwise.
       - Validate name form; throw `OperationError(400, "credential.input.invalid", ...)` on failure.
       - Refuse name equal to `RESERVED_NAME_LOGIN`; throw `OperationError(400, "credential.input.invalid", ...)`.
       - Check existing row by name; throw `OperationError(409, "credential.name.conflict", ...)` with newest-revision id if name taken.
       - Map requested `mode` (`"browser"` → `"browser"`, `"device"` → `"device_code"`, absent → platform default). If the platform supports only one mode, ignore the requested mode.
       - Call `this.sessions.start(platform, mappedMode, caller.identity, credentialName, Date.now())`.
       - Start pi-ai `models.login(providerId, "oauth", interaction)` asynchronously, where the interaction adapter:
         - On `select`: returns the mapped mode; records `address` and `code` in the session with `updateAddress`.
         - On `progress` or `info`: records the message with `updateLastMessage`.
         - On `manual_code`, `text` or `secret` prompt: waits for a value supplied through `credential.login_code`.
         - On login success: calls the completion transaction (see below).
         - On failure or expiry: calls `this.sessions.fail(id, reason)` or `this.sessions.expire(id)`.
       - Completion transaction (called by the interaction adapter on success):
         - Begin a new store transaction.
         - Re-check name conflict; throw `OperationError(409, "credential.name.conflict", ...)` with details if name taken (commit-time race).
         - Mint `id = createIdentity("credential")`.
         - Encrypt the received OAuth secret `{ refresh, access, expires }` with `encrypt(envelopeKey, id, platform, secret)`.
         - Insert credential row with `revision = 1`, `metadata = NULL`, `ended_at = NULL`.
         - Call `this.sessions.complete(sessionId)`.
         - Call `this.logger.info({ credentialId: id, humanIdentity }, "credential login completed")`.
       - Before `caller.commit`, await the first interaction event that records the address: `auth_url` in browser mode, `device_code` in device mode (`docs/brainstorm/custody.impl.md` "the OAuth login": the adapter records `auth_url` as the address and `device_code` as the code and address). Bound the wait by the operation timeout and the caller `Context`. If the session fails first, answer its failure.
       - Return `{ sessionId, address, code, expiresAt }`: `address` is always set; `code` is `null` in browser mode. `credential.login` answers address and code, and `credential.login_status` answers no address (`custody.impl.md` "the OAuth login", `engine/docs/cli/credential.md:237`).
     - `credential.login_code` handler:
       - Read session by `params.sessionId`; throw `OperationError(404, "credential.login.not_found", ...)` if absent.
       - Check expiry: if `session.expiresAt <= Date.now()`, throw `OperationError(404, "credential.login.not_found", ...)`.
       - Throw `OperationError(409, "credential.login.value_not_awaited", ...)` if session is not awaiting a value.
       - Supply the value to the pending pi-ai prompt. Return `{ sessionId }`.
     - `credential.login_status` handler:
       - Read session by `params.sessionId`; throw `OperationError(404, "credential.login.not_found", ...)` if absent.
       - Return `{ sessionId, state, lastMessage, failureReason }`.
  2. In `engine/src/custody/service.test.ts`, add tests:
     - Login start for `github-copilot` creates a session; answer includes `sessionId`, `expiresAt`.
     - Login start for non-OAuth platform returns 400 `credential.entry.unsupported`.
     - Login start with name `login` returns 400 `credential.input.invalid`.
     - Second login start for same platform and human (non-expired) returns 409 `credential.login.pending`.
     - Name conflict at login start returns 409 `credential.name.conflict`.
     - Name conflict at login commit (simulated via stub interaction adapter) returns 409 `credential.name.conflict`.
     - Successful completion inserts credential row with `revision = 1` and null metadata.
     - Failed session creates no credential row.
     - Expired session creates no credential row.
     - No token, ciphertext or secret in any login answer.
     - Login status returns current state; `login_status` of expired session returns 404.
- Rules:
  - Login session identity `login_session_<ulid>` (custody.impl.md#the-oauth-login).
  - Expiry 15 minutes after start; expired sessions answer 404 (custody.impl.md#the-oauth-login).
  - At most one non-expired pending session per platform and human (custody.impl.md#the-oauth-login).
  - Failed or expired session stores no credential row (custody.md#login-sessions).
  - Name conflict at login start or commit answers 409 `credential.name.conflict` (custody.impl.md:20).
  - Mode mapping: `device` → `device_code`; `browser` → `browser`; platform with one mode
    ignores the requested mode (custody.impl.md:185).
  - `RESERVED_NAME_LOGIN` refused at login (custody.impl.md:19).
  - Output exposes no token; session holds no token (custody.impl.md:199).
  - `github-copilot` is the only implemented OAuth platform in ERD 1 (custody.impl.md:182).
- Done when:
  - `node --test src/custody/sessions.test.ts` passes all session lifecycle tests.
  - `node --test src/custody/service.test.ts` passes all login handler tests, including
    successful completion inserting a credential row and commit-time name conflict.
  - `pnpm run verify` passes.

### 01.10 Resource healthcheck

- Files:
  - `engine/src/kernel/health.ts`
  - `engine/src/kernel/health.test.ts`
  - `engine/src/custody/resource-healthcheck.ts`
  - `engine/src/custody/resource-healthcheck.test.ts`
  - `engine/src/custody/service.ts`
  - `engine/package.json`
  - `engine/pnpm-lock.yaml`
- Do:
  1. Edit `engine/src/kernel/health.ts`. Add after the existing exports:
     - `export const ResourceStatus = { Healthy: "healthy", Unhealthy: "unhealthy", Unknown: "unknown" } as const`.
     - `export type ResourceStatusValue = (typeof ResourceStatus)[keyof typeof ResourceStatus]`.
     - `export const HealthScope = { Global: "global", Project: "project" } as const`.
     - `export type HealthScopeValue = (typeof HealthScope)[keyof typeof HealthScope]`.
     - `export type ResourceCheck = (context: Context) => Promise<ResourceStatusValue>`.
     - `export interface ResourceEntry { scope: HealthScopeValue; project: string | null; name: string; target: string; capability: string; check: ResourceCheck }`.
       Rules for `ResourceEntry`:
       `project` holds the project name when `scope` is `project`, and `null` when `scope` is `global`.
       `name` holds each segment percent-encoded with `encodeURIComponent`, joined by `/`.
       `target` is the deduplication key; form: `<target kind>:<identifier>`.
       `capability` is known at inventory time and never depends on the check result.
       `check` honours the `Context` it receives and never throws; a failure maps to a `ResourceStatusValue`.
       A cancelled or expired context maps to `ResourceStatus.Unknown`.
       Edit `engine/src/kernel/health.test.ts`. Add tests:
     - `ResourceStatus` values are `"healthy"`, `"unhealthy"` and `"unknown"`.
     - `HealthScope` values are `"global"` and `"project"`.
  2. Create `engine/src/custody/resource-healthcheck.ts`.
     Import `Platform` from `"./platforms.ts"`.
     Import `ResourceStatus`, `type ResourceStatusValue`, `type Context` from the kernel.
     Export four named capability constants:
     - `CAPABILITY_RATE_LIMIT_READ = "rate-limit read"` — github (`custody.impl.md` "The resource healthcheck").
     - `CAPABILITY_COPILOT_TOKEN_READ = "copilot token read"` — github-copilot.
     - `CAPABILITY_MODEL_LIST_READ = "model-list read"` — anthropic and openai-compatible.
     - `CAPABILITY_BUCKET_HEAD = "bucket head"` — s3.
       Export `TARGET_KIND_CREDENTIAL = "credential"` — the target kind for deduplication.
       Export five async probe functions. Each accepts a `Context` and aborts when it cancels.
       A network error or cancellation returns `ResourceStatus.Unknown` for every probe.
       A 403 response returns `ResourceStatus.Unknown` for every probe (a forbidden probe proves
       no invalid credential, `custody.impl.md` "The resource healthcheck").
     - `probeGitHub(apiKey: string, context: Context): Promise<ResourceStatusValue>`:
       Send `GET https://api.github.com/rate_limit` with `Authorization: Bearer <apiKey>`.
       HTTP 200 → `ResourceStatus.Healthy`. HTTP 403 → `ResourceStatus.Unknown`.
       Any other status → `ResourceStatus.Unhealthy`.
       Network error or cancellation → `ResourceStatus.Unknown`.
     - `probeGitHubCopilot(access: string, expires: number, context: Context): Promise<ResourceStatusValue>`:
       If `expires <= Date.now()`, return `ResourceStatus.Unknown` without a remote call
       (`custody.impl.md` "No check refreshes an OAuth record").
       Send `GET https://api.github.com/copilot_internal/v2/token` with `Authorization: Bearer <access>`.
       HTTP 200 → `ResourceStatus.Healthy`. HTTP 403 → `ResourceStatus.Unknown`.
       Any other status → `ResourceStatus.Unhealthy`.
       Network error or cancellation → `ResourceStatus.Unknown`.
     - `probeAnthropic(apiKey: string, context: Context): Promise<ResourceStatusValue>`:
       Send `GET https://api.anthropic.com/v1/models` with `x-api-key: <apiKey>`.
       HTTP 200 → `ResourceStatus.Healthy`. HTTP 403 → `ResourceStatus.Unknown`.
       Any other status → `ResourceStatus.Unhealthy`.
       Network error or cancellation → `ResourceStatus.Unknown`.
     - `probeOpenAICompatible(apiKey: string, baseUrl: string, context: Context): Promise<ResourceStatusValue>`:
       Send `GET <baseUrl>/models` with `Authorization: Bearer <apiKey>`.
       HTTP 200 → `ResourceStatus.Healthy`. HTTP 403 → `ResourceStatus.Unknown`.
       Any other status → `ResourceStatus.Unhealthy`.
       Network error or cancellation → `ResourceStatus.Unknown`.
     - `probeS3(accessKeyId: string, secretAccessKey: string, endpoint: string, bucket: string, region: string, context: Context): Promise<ResourceStatusValue>`:
       Add `@aws-sdk/client-s3` to `dependencies` in `engine/package.json` at an exact version, like every other dependency.
       Construct `new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey } })`.
       Bridge the `Context` to an `AbortController`.
       Call `client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal })`.
       Read the status from `$metadata.httpStatusCode` of the answer or of the thrown error.
       HTTP 200 → `ResourceStatus.Healthy`. HTTP 404 → `ResourceStatus.Unhealthy`.
       HTTP 403 → `ResourceStatus.Unknown` (a write-only key can work despite a forbidden probe).
       Network error, cancellation or any other status → `ResourceStatus.Unknown`.
       Call `client.destroy()` in a `finally` block.
  3. In `engine/src/custody/service.ts`, add two methods to `CustodyComponent`:
     - `resourceInventory(tx: Transaction): ResourceEntry[]` (synchronous):
       Import `ResourceEntry`, `HealthScope`, `ResourceStatus`, `type ResourceCheck` from
       `"../kernel/health.ts"`, and `TARGET_KIND_CREDENTIAL`, the four probe functions
       and capability constants from `"./resource-healthcheck.ts"`.
       Query one row per credential name: the row with null `ended_at` and the highest `revision`.
       For each row, capture `id`, `name`, `platform`, `nonce`, `ciphertext` and parsed `metadata` now.
       Build and return one `ResourceEntry` per row:
       `scope: HealthScope.Global`, `project: null`,
       `name: encodeURIComponent(credentialName)`,
       `target: TARGET_KIND_CREDENTIAL + ":" + id`,
       `capability` from the platform (see probe-to-capability mapping below),
       `check` closure: decrypts the captured `nonce` and `ciphertext` using `id`, dispatches
       to the probe for `platform`. Return `ResourceStatus.Unknown` on decryption failure.
       Probe dispatch inside the closure:
       `Platform.GitHub` → `probeGitHub(secret.key, context)`.
       `Platform.GitHubCopilot` → `probeGitHubCopilot(secret.access, secret.expires, context)`.
       `Platform.Anthropic` → `probeAnthropic(secret.key, context)`.
       `Platform.OpenAICompatible` → `probeOpenAICompatible(secret.key, metadata.baseUrl, context)`.
       `Platform.S3` → `probeS3(secret.accessKeyId, secret.secretAccessKey, metadata.endpoint, metadata.bucket, metadata.region, context)`.
       Capability mapping (named constants, not bare strings):
       `Platform.GitHub` → `CAPABILITY_RATE_LIMIT_READ`.
       `Platform.GitHubCopilot` → `CAPABILITY_COPILOT_TOKEN_READ`.
       `Platform.Anthropic` → `CAPABILITY_MODEL_LIST_READ`.
       `Platform.OpenAICompatible` → `CAPABILITY_MODEL_LIST_READ`.
       `Platform.S3` → `CAPABILITY_BUCKET_HEAD`.
     - `modelListCheck(tx: Transaction, credentialName: string): ResourceCheck`:
       Read the newest live revision of `credentialName` inside `tx`.
       If no live revision exists, or the platform is not `anthropic` or `openai-compatible`,
       return a closure that returns `ResourceStatus.Unknown` without a remote call.
       Otherwise, capture `id`, `nonce`, `ciphertext` and `metadata.baseUrl` now.
       Return a closure that decrypts the captured secret and calls `probeAnthropic` or
       `probeOpenAICompatible` depending on `platform`. Return `ResourceStatus.Unknown` on
       decryption failure.
  4. Create `engine/src/custody/resource-healthcheck.test.ts`. Test:
     - `probeGitHub` returns `Healthy` on HTTP 200 and `Unhealthy` on HTTP 401.
     - `probeGitHub` returns `Unknown` on HTTP 403 and on a network error.
     - `probeGitHubCopilot` returns `Unknown` for an expired token without a network call.
     - `probeGitHubCopilot` returns `Healthy` on HTTP 200 for a valid token.
     - `probeGitHubCopilot` returns `Unknown` on HTTP 403.
     - `probeAnthropic` returns `Healthy` on HTTP 200 and `Unhealthy` on HTTP 401.
     - `probeAnthropic` returns `Unknown` on HTTP 403.
     - `probeOpenAICompatible` returns `Healthy` on HTTP 200 and `Unhealthy` on HTTP 401.
     - `probeOpenAICompatible` returns `Unknown` on HTTP 403.
     - `probeS3` maps 200 to `Healthy`, 404 to `Unhealthy` and 403 to `Unknown` against a stubbed `S3Client.send`.
     - `resourceInventory` returns one `ResourceEntry` per credential name (newest live
       revision, `ended_at IS NULL`), `scope` is `global`, `project` is `null`.
     - `resourceInventory` excludes names whose every revision has a non-null `ended_at`.
     - `resourceInventory` assigns the correct capability constant per platform.
     - A `check` closure from `resourceInventory` returns `Unknown` for a decryption failure.
     - `modelListCheck` returns a closure that answers `Unknown` for a missing revision.
     - `modelListCheck` returns a closure that answers `Unknown` for a non-model-list platform.
     - No secret appears in any probe result, inventory entry or error.
- Rules:
  - Import `ResourceStatus`, `ResourceEntry`, `ResourceCheck`, `HealthScope` from `../kernel/health.ts`.
    No plan declares its own `ResourceStatus` (`00-index.md` "Resource healthcheck entry").
  - `resourceInventory` is synchronous. It opens no transaction, performs no network call,
    and returns closures. A closure captures all row values at inventory time and performs
    no later store read (`00-index.md` Seams, `resourceInventory`).
  - HTTP 403 reports `Unknown` for every probe: a forbidden probe proves no invalid credential
    (`custody.impl.md` "The resource healthcheck").
  - No check refreshes an OAuth record; an expired access token reports `Unknown` without a
    remote call (`custody.impl.md` "The resource healthcheck").
  - The GitHub rate-limit probe spends no rate limit (`custody.impl.md` "The resource healthcheck").
  - The S3 probe uses `HeadBucketCommand` of `@aws-sdk/client-s3` with the metadata `endpoint` and `region`, so it serves every S3-compatible provider (`custody.impl.md` "Platform validators").
  - No check result persists; checks run on demand
    (`architecture.md` "No service stores the result of a check.").
  - Named constants for every capability string and target kind (`engine/CLAUDE.local.md`).
  - No background check, no freshness cache (2026-09-25 Ulrich ruling in `engine/.agents/plan/erd-01-setup/00-index.md`).
  - Plan 07 places each entry in the health report.
- Done when:
  - `node --test src/kernel/health.test.ts` passes the new `ResourceStatus` and `HealthScope` tests.
  - `node --test src/custody/resource-healthcheck.test.ts` passes all probe, inventory and
    dispatch tests.
  - `pnpm run verify` passes.

### 01.11 Create the `unwired` module

- Files:
  - `engine/src/apps/server/unwired.ts` (create)
  - `engine/src/apps/server/unwired.test.ts` (create)
- Do:
  1. Create `engine/src/apps/server/unwired.ts`. Import `CodedError` from
     `../../kernel/errors.ts`. Export `function unwired(seam: string): (...args: never[]) => never`.
     The returned function throws
     `new CodedError("system.composition.unwired", seam + " is not wired.")` when called.
  2. Create `engine/src/apps/server/unwired.test.ts`. Write one test using `node:test` and
     `node:assert/strict`: calling the function returned by `unwired("agentProvidersDependentOn")`
     throws a `CodedError` with code `"system.composition.unwired"`.
- Rules:
  - The returned function never returns; it always throws when called.
  - Error code `"system.composition.unwired"` has three parts (`architecture.impl.md:339`).
  - No code comments.
- Done when:
  - `node --test src/apps/server/unwired.test.ts` passes.
  - `pnpm run verify` passes.

### 01.12 Create `src/apps/server/cli-support.ts`

- Files:
  - `engine/src/apps/server/cli-support.ts` (create)
  - `engine/src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. Create `engine/src/apps/server/cli-support.ts`. Import `execFile` from `node:child_process`,
     `join` from `node:path`, `existsSync` from `node:fs`, `isNumber` from
     `../../kernel/values.ts`, and `assert` from `node:assert/strict`.
     Export two functions:
     - `kanthord(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }>`:
       Assert `args.length > 0` and `env.XDG_CONFIG_HOME`. Run the entry at
       `new URL("../../main.ts", import.meta.url).href` as a subprocess with
       `execFile(process.execPath, ["--input-type=module", "-e", ...], { env, timeout: 10000 }, ...)`.
       Return `{ code, stdout, stderr }` with the subprocess exit code.
     - `environment(directory: string): NodeJS.ProcessEnv`:
       Assert `directory.startsWith("/")` and `existsSync(directory)`. Return
       `{ ...process.env, XDG_CONFIG_HOME: directory, KANTHORD_CONFIG: join(directory, "absent.yaml"), KANTHORD_ENDPOINT: "http://127.0.0.1:1", KANTHORD_TOKEN: undefined }`.
  2. Edit `engine/src/apps/server/cli-worker.test.ts`.
     Remove the local `command` function definition and the local `environment` function definition.
     Add `import { kanthord as command, environment } from "./cli-support.ts"`. No other logic
     changes.
- Rules:
  - `KANTHORD_ENDPOINT` defaults to a dead address; E2E tests override it with the fixture endpoint.
  - No code comments.
- Done when:
  - `node --test src/apps/server/cli-worker.test.ts` passes without logic changes.
  - `pnpm run verify` passes.

### 01.13 Add shared CLI helper module

- Files:
  - `engine/src/apps/cli/shared.ts` (create)
  - `engine/src/apps/cli/shared.test.ts` (create)
- Do:
  1. Export `detectDuplicateKeys(text: string): void`.
     Walk `text` character by character; maintain a nesting stack of `Set<string>`.
     Push a new `Set` on `{`; pop on `}`.
     When inside an object, scan each JSON string key: read from `"` through the next unescaped `"`,
     interpret `\\` escape sequences to produce the key value. After the `:`, check the key
     against the current `Set`; throw `Diagnostic("cli.file.duplicate_key", key)` if found;
     otherwise add the key. Skip strings that are values (after `:` or in arrays).
     Throw `Diagnostic("cli.file.not_json", "...")` on any tokenizer error.
  2. Export `readJsonFile(path: string, requirePrivate = false): unknown`.
     Throw `Diagnostic("cli.file.invalid_path", "stdin is not accepted")` when `path === "-"`.
     When `requirePrivate` is false: call `statSync(path, { throwIfNoEntry: false })` from
     `node:fs`; throw `Diagnostic("cli.file.not_found", "...")` when undefined; throw
     `Diagnostic("cli.file.not_regular", "...")` when `stat.isFile()` is false; call
     `readFileSync(path)`; decode with `new TextDecoder("utf-8", { fatal: true }).decode(buffer)`;
     catch `TypeError` and throw `Diagnostic("cli.file.encoding_invalid", "...")`.
     When `requirePrivate` is true: call `statSync(path, { throwIfNoEntry: false })`; throw
     `Diagnostic("cli.file.not_found", "...")` when undefined; throw
     `Diagnostic("cli.file.not_regular", "...")` when not a file; call `readPrivate(path)` from
     `../../kernel/files.ts`; its `system.files.invalid_permissions` propagates unmodified.
     Call `detectDuplicateKeys(text)`. Call `JSON.parse(text)`; catch `SyntaxError` and throw
     `Diagnostic("cli.file.not_json", "...")`. Throw `Diagnostic("cli.file.not_object", "...")`
     when the parsed value is not a plain object. Return the parsed value.
  3. Export `readJsonFileAs<S extends z.ZodTypeAny>(path: string, schema: S, requirePrivate = false): z.infer<S>`.
     Call `readJsonFile(path, requirePrivate)` → `raw`. Call `schema.safeParse(raw)`; throw
     `Diagnostic("cli.file.schema_invalid", JSON.stringify(result.error))` on failure.
     Return `result.data`.
  4. Export `resolveKey(options: { idempotencyKey?: string }): string`.
     When `options.idempotencyKey` is present, validate with `ulidSchema.safeParse`; throw
     `Diagnostic("cli.idempotency_key.invalid", "...")` on failure; return the value.
     When absent, return `ulid()`.
  5. Export `handleMutationResult<T>(result: OperationResult<T>, indeterminateCode: string, key: string): T`.
     On `OperationResultType.Completed` return `result.data`. On `OperationResultType.Failure`
     throw `Diagnostic(result.error.error.code, JSON.stringify({ ...result.error.error, idempotencyKey: key }))`.
     On `OperationResultType.Indeterminate` throw
     `Diagnostic(indeterminateCode, "retry with --idempotency-key " + key)`.
  6. Export `handleReadResult<T>(result: OperationResult<T>, indeterminateCode: string): T`.
     On `OperationResultType.Completed` return `result.data`. On `OperationResultType.Failure`
     throw `Diagnostic(result.error.error.code, JSON.stringify(result.error.error))`.
     On `OperationResultType.Indeterminate` throw
     `Diagnostic(indeterminateCode, "retry the command")`.
  7. Export `requireToken(token: string | undefined, code: string): asserts token is string`.
     Throw `Diagnostic(code, "a token is required")` when token is undefined or blank.
  8. Export `parsePositiveInt(value: string, code: string): number`.
     Parse with `Number(value)`; throw `Diagnostic(code, "not a positive integer")` when not
     a finite positive safe integer.
  9. Export `singleUse(name: string): (value: string, previous: string | undefined) => string`.
     Return a Commander coercion. When `previous` is not undefined, throw
     `Diagnostic("cli.option.duplicate", name + " may not be repeated")`. Otherwise return `value`.
  10. In `src/apps/cli/shared.test.ts` add unit tests using `node:test` and `node:assert/strict`.
- Rules:
  - `readPrivate` from `../../kernel/files.ts`; its missing-path behavior throws
    `system.files.inspect_failed`, not ENOENT — always check existence with `statSync` before
    calling it.
  - `ulidSchema` from `../../kernel/identity.ts`; `ulid` from `ulid`.
  - `OperationResultType` from `../../kernel/operation.ts`.
  - `z` from `zod`.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `readJsonFile("-")` throws `cli.file.invalid_path`.
  - Test: `readJsonFile("/nonexistent/path.json")` throws `cli.file.not_found`.
  - Test: `readJsonFile` on a regular file with `{"a":1}` returns `{ a: 1 }`.
  - Test: `readJsonFile` on a file with `[1,2]` throws `cli.file.not_object`.
  - Test: `readJsonFile` on a file with `{"a":1,"a":2}` throws `cli.file.duplicate_key`.
  - Test: `readJsonFile` on a file with `{"x":{"a":1,"a":2}}` throws `cli.file.duplicate_key`
    (nested duplicate).
  - Test: `resolveKey({ idempotencyKey: "not-a-ulid" })` throws `cli.idempotency_key.invalid`.
  - Test: `resolveKey({ idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA" })` returns the key.
  - Test: `resolveKey({})` returns a 26-character string.
  - Test: `parsePositiveInt("0", "cli.test.bad_int")` throws `cli.test.bad_int`.
  - Test: `parsePositiveInt("1", "cli.test.bad_int")` returns 1.
  - Test: `singleUse("--endpoint")("a", "b")` throws `cli.option.duplicate`.
  - Test: `singleUse("--endpoint")("a", undefined)` returns `"a"`.
  - Test: `handleMutationResult` on Failure includes `idempotencyKey` in the thrown diagnostic's
    message.

### 01.14 Wire Custody into the composition root, extend `gatewayFixture`, and publish OpenAPI

- Files:
  - `engine/src/custody/index.ts` (edit)
  - `engine/src/apps/server/index.ts` (edit)
  - `engine/src/apps/server/test-support.ts` (edit)
  - `engine/src/apps/cli/index.ts` (edit, line 298)
  - `engine/static/openapi.yaml` (regenerate)
  - `engine/static/openapi/**` (regenerate)
  - `engine/src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. In `engine/src/custody/index.ts`, add
     `export { deriveEnvelopeKey } from "./envelope.ts"`.
  2. In `engine/src/apps/server/index.ts`:
     a. Add imports: `CustodyComponent`, `custodyMigrations`, `deriveEnvelopeKey` from
     `../../custody/index.ts`; `CUSTODY_SERVICE_NAME` from `../../custody/contract.ts`;
     `unwired` from `./unwired.ts`.
     b. Add `{ service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations }` before the
     `gateway` entry in `store.migrate([...])`.
     c. Add `standIns?: { agentProvidersDependentOn?: AgentProvidersDependentOnFn; enablementsDependentOnModel?: EnablementsDependentOnModelFn; bindingsNaming?: BindingsNamingFn }` to the
     `Options` type of `composeServices`. `AgentProvidersDependentOnFn`,
     `EnablementsDependentOnModelFn` and `BindingsNamingFn` are the dependency function types
     from `../../custody/index.ts`. The server application never passes `standIns`.
     d. In `composeServices`, add
     `const envelopeKey = deriveEnvelopeKey(options.config.masterKey)` before any service
     construction.
     e. Declare `let custody: CustodyComponent` as a hoisted variable.
     f. Reorder construction so that `custody` is assigned first, before `worker` and `project`.
     Assign `custody = new CustodyComponent({ envelopeKey, logger: options.logger, health: options.health, agentProvidersDependentOn: options.standIns?.agentProvidersDependentOn ?? ((tx, name) => unwired("agentProvidersDependentOn")(tx, name)), enablementsDependentOnModel: options.standIns?.enablementsDependentOnModel ?? ((tx, name, model) => unwired("enablementsDependentOnModel")(tx, name, model)), bindingsNaming: options.standIns?.bindingsNaming ?? ((tx, name) => unwired("bindingsNaming")(tx, name)) })`.
     g. Call `custody.declare(registry)` before `project.declare(registry)` and
     `worker.declare(registry)`.
     h. Set `services = [custody, worker, project, gateway]`. Push releases in the same order;
     the reverse-pop sequence stops `gateway` first and `custody` last.
     i. Update `engine/src/apps/server/index.test.ts` to match the new construction and stop
     order.
     j. Return `{ custody, project, worker, gateway, invocation, registry }` from
     `composeServices`.
  3. In `engine/src/apps/server/test-support.ts`:
     a. Import `custodyMigrations` from `../../custody/index.ts` and `CUSTODY_SERVICE_NAME` from
     `../../custody/contract.ts`.
     b. Add `{ service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations }` before the
     `gateway` entry in `store.migrate([...])`.
     c. Add `standIns?: Parameters<typeof composeServices>[0]["standIns"]` to the
     `gatewayFixture` options type. Forward `standIns` to `composeServices`.
     d. Extract `custody` from the `composeServices` result.
     e. Start services in construction order: `[custody, worker, project, gateway]`.
     f. Add `custody` to the quiesce call.
     g. Stop in reverse construction order: `[gateway, project, worker, custody]`.
     h. Return `custody` from the fixture.
  4. In `engine/src/apps/cli/index.ts` at line 298 where `const apiOperations` is declared:
     a. Add import for `custodyOperations` from `../../custody/contract.ts`.
     b. Replace the object spread with an array, because two operation sets share short client keys such as `list` and `get`, and an object spread keeps only the last one:
     `const apiOperations = [...Object.values(gatewayOperations), ...Object.values(custodyOperations), ...Object.values(workerOperations)]`.
     c. Change `writeOpenAPI(Object.values(apiOperations), ...)` at line 278 to `writeOpenAPI(apiOperations, ...)`.
  5. In `engine/src/apps/server/openapi-integration.test.ts`:
     a. Import `custodyOperations` from `../../custody/contract.ts`.
     b. Replace the test's `apiOperations` object with the same array form as step 4b, and change `emitOpenAPIFiles(Object.values(apiOperations))` to `emitOpenAPIFiles(apiOperations)`.
     c. Add an assertion for at least one `credential.*` path.
  6. Run `pnpm run build && node bin/kanthord.mjs gateway openapi` from the `engine/` directory.
     Commit the regenerated files under `static/`.
- Rules:
  - Construction order: custody before worker, worker before project, project before gateway
    (`architecture.impl.md:427–430`).
  - Stop order: gateway first, then project, then worker, then custody
    (`architecture.impl.md:449–469`).
  - `standIns` keys override `unwired` stubs; the server application never passes `standIns`.
    Plan 03 removes `agentProvidersDependentOn` and `enablementsDependentOnModel` from the type.
    Plan 05 removes `bindingsNaming`. Plan 07 removes `standIns` when no key remains.
  - `deriveEnvelopeKey(config.masterKey)` derives the cipher key; `CustodyComponent` never
    receives `masterKey` itself.
  - `engine/AGENTS.md` (Regenerate OpenAPI): change declarations first; run the command;
    commit; verify. `service: "credential"` on all custody operations (D9).
  - No code comments.
- Done when:
  - `pnpm run verify` passes.
  - `src/apps/server/index.test.ts` passes with the updated construction and stop order.
  - `custody` is available from `composeServices` and `gatewayFixture`.
  - The emitted OpenAPI document includes all 9 `credential.*` paths.

### 01.15 Add credential read commands

- Files:
  - `engine/src/apps/cli/credential.ts` (create)
  - `engine/src/apps/cli/constants.ts` (edit)
  - `engine/src/apps/cli/index.ts` (edit)
- Do:
  1. Create `engine/src/apps/cli/credential.ts`. Import `custodyOperations` from
     `../../custody/contract.ts`. Import helpers from `./shared.ts`. Import `resolveClient`
     from `./resolver.ts`.
  2. Export `addCredentialCommand(program: Command): void`. Add group `credential` with
     `--endpoint <url>` (coercion `singleUse("--endpoint")`) and `--token <token>` (coercion
     `singleUse("--token")`). Set action to help.
  3. All `httpClient` calls: `httpClient(custodyOperations, endpoint, token)`.
     All read commands define no `--idempotency-key`. Commander rejects an unknown
     `--idempotency-key` on read commands.
  4. Add leaf `list`:
     - Options: `--platform <platform>` (coercion `singleUse("--platform")`),
       `--limit <count>` (coercion `singleUse("--limit")`),
       `--cursor <cursor>` (coercion `singleUse("--cursor")`).
     - `requireToken(opts.token, "cli.credential.list.token_required")`.
     - Validate `--limit`: when present,
       `parsePositiveInt(opts.limit, "cli.pagination.limit_invalid")`; clamp to 1–1000;
       throw `Diagnostic("cli.pagination.limit_out_of_range", "...")` when outside range.
       Default to 100.
     - Call client `["list"]({ params: {}, query: { platform: opts.platform, limit, cursor: opts.cursor }, body: null })`.
     - `handleReadResult(result, "cli.credential.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  5. Add leaf `get <credential-name>`:
     - `requireToken(opts.token, "cli.credential.get.token_required")`.
     - Call client `["get"]({ params: { credentialName: name }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.credential.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  6. Add leaf `login-status <session>`:
     - `requireToken(opts.token, "cli.credential.login_status.token_required")`.
     - Call client `["login_status"]({ params: { sessionId: session }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.credential.login_status.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  7. In `engine/src/apps/cli/constants.ts`: add `Credential = "credential"` to `CommandName`.
  8. In `engine/src/apps/cli/index.ts`: import `addCredentialCommand`; call it inside
     `createProgram` after `addJWTCommand`.
- Rules:
  - Read commands define no `--idempotency-key`; Commander's unknown-option rejection applies.
  - Operation keys are short, no `credential.` prefix.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.

### 01.16 Add credential mutation commands

- Files:
  - `engine/src/apps/cli/credential.ts` (edit)
- Do: Inside `addCredentialCommand`, after the read commands, add these six mutation commands.
  All accept `--idempotency-key <key>` (coercion `singleUse("--idempotency-key")`).
  1. Add leaf `create --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken(opts.token, "cli.credential.create.token_required")`.
     - `resolveKey(opts)` → `key`.
     - `readJsonFileAs(opts.file, credentialCreateSchema, true)` → body.
     - Call client `["create"]({ params: {}, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.create.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `rotate <credential-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, credentialRotateBodySchema, true)` → body (private file;
       body contains the new secret material).
     - Call client `["rotate"]({ params: { credentialName: name }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.rotate.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  3. Add leaf `update-metadata <credential-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, credentialUpdateMetadataBodySchema)` → body (ordinary file).
     - Call client `["update_metadata"]({ params: { credentialName: name }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.update_metadata.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  4. Add leaf `revoke <credential-name> <revision>`:
     - `parsePositiveInt(revision, "cli.credential.revoke.invalid_revision")` → `rev`.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["revoke"]({ params: { credentialName: name, revision: rev }, query: {}, body: null }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.revoke.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  5. Add leaf `login <platform> --name <name>`:
     - `--name` coercion: `singleUse("--name")`; required.
     - `--mode <mode>` coercion: `singleUse("--mode")`; optional; accepted values `browser`
       and `device`; throw `Diagnostic("cli.credential.login.invalid_mode", "...")` on other
       value.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["login"]({ params: {}, query: {}, body: { platform, name: opts.name, mode: opts.mode } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.login.indeterminate", key)` → data.
     - Print one line per field to `process.stdout`: `sessionId`, `address`, `code`,
       `expiresAt`, then `idempotencyKey: key`. A `null` `code` (browser mode) prints an
       empty line. The command never polls (`credential.md` line-output exception).
  6. Add leaf `login-code <session> <value>`:
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["login_code"]({ params: { sessionId: session }, query: {}, body: { value } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.login_code.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
- Rules:
  - `create` and `rotate` pass `requirePrivate = true` to `readJsonFileAs`.
  - `update-metadata` passes `requirePrivate = false`.
  - `idempotencyKey` goes in the second argument of the client call, not in `body`.
  - Field name is `expiresAt`, not `expiry` (`credential.md` login response fields).
  - No code comments.
- Done when:
  - `pnpm run verify` is green.

### 01.E E2E proof

- Files:
  - `engine/src/apps/server/e2e-custody.test.ts` (create)
- Do:
  Create `engine/src/apps/server/e2e-custody.test.ts` using `node:test`.
  Each test uses one fresh `gatewayFixture` (no `standIns` needed; see `## E2E` Harness).
  The env is built with `environment(temporary(t))` extended with
  `KANTHORD_ENDPOINT: fixture.endpoint` and `KANTHORD_TOKEN: fixture.token`. Every JSON
  stdout is parsed with `JSON.parse`; every refusal asserts exit code 1 and that
  `stderr.startsWith("<code>:")`. Write one test per scenario in the table in `## E2E`.
  Local-validation cases (file not found, duplicate option, invalid revision, invalid mode)
  do not start a server; they run in the same file with `environment(temporary(t))` and a
  dead `KANTHORD_ENDPOINT`.
- Rules:
  - Setup goes through the CLI only.
  - State checks are CLI reads, never store reads.
  - No code comments. Each test is self-contained; every test creates its own credentials and
    runs all setup commands inside that test.
- Done when:
  - `node --test --test-timeout=30000 src/apps/server/e2e-custody.test.ts` passes.
  - `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-custody.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on
  a loopback port with an in-memory store; `kanthord(args, env)` from
  `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state,
  `KANTHORD_ENDPOINT = fixture.endpoint` and `KANTHORD_TOKEN = fixture.token`. No `standIns`
  are needed: E01.7 rotates with no model removal and E01.9 adds a model without removing one,
  so `enablementsDependentOnModel` is not reached; no E01 path deletes a credential, so
  `agentProvidersDependentOn` and `bindingsNaming` are not reached. Plan 03 replaces
  `agentProvidersDependentOn` and `enablementsDependentOnModel`. Plan 05 replaces
  `bindingsNaming`.
- Rules: setup goes through the CLI only; the state check is a CLI read, never a store read;
  a refusal asserts the exact exit code and the error code at the start of stderr; stdout is
  parsed as JSON where the CLI page says the command prints JSON.

| Id     | Commands                                                                                                                                                               | Exit | Expect                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| E01.1  | `credential create --file <anthropic.json>` then `credential get <name>`                                                                                               | 0, 0 | stdout JSON: `name`, `platform === "anthropic"`, `revisions[0].revision === 1`; no `secret` field in either response |
| E01.2  | `credential create --file <same-name.json>` with a different `--idempotency-key` (same name)                                                                           | 1    | stderr starts `credential.name.conflict:`                                                                            |
| E01.3  | `credential create --file <anthropic.json>` with same `--idempotency-key` as first create in E01.3's own setup                                                         | 0    | stdout JSON identical to the first create in this test; `revisions` still has 1 entry                                |
| E01.4  | `credential list`                                                                                                                                                      | 0    | stdout JSON: `items` array contains the created name; no `secret`                                                    |
| E01.5  | `credential list --platform anthropic` then `credential list --platform github`                                                                                        | 0, 0 | first `items` contains the anthropic name; second `items` is empty                                                   |
| E01.6  | `credential get nonexistent`                                                                                                                                           | 1    | stderr starts `credential.credential.not_found:`                                                                     |
| E01.7  | `credential rotate <github-name> --file <rotate.json>` (`expectedRevision: 1`; same secret; no model removal) then `credential get <github-name>`                      | 0, 0 | stdout JSON: `revisions` has 2 entries; no `secret` in any revision                                                  |
| E01.8  | `credential rotate <github-name> --file <stale.json>` (`expectedRevision: 0`; stale)                                                                                   | 1    | stderr starts `credential.revision.conflict:`                                                                        |
| E01.9  | `credential update-metadata <oai-name> --file <meta.json>` (openai-compatible; add model `gpt-4o`, no removal; `expectedRevision: 1`) then `credential get <oai-name>` | 0, 0 | stdout JSON: `revisions` has 2 entries; newest revision `metadata.models` contains `gpt-4o`; no `secret`             |
| E01.10 | create `<github-name>`, rotate (`expectedRevision: 1`) to get revision 2, then `credential revoke <github-name> 1` then `credential get <github-name>`                 | 0, 0 | stdout JSON: revision 1 has `endedAt` non-null; revision 2 has `endedAt === null`                                    |
| E01.11 | create `<github-name>`, rotate to get revision 2, then `credential revoke <github-name> 2` (newest live)                                                               | 1    | stderr starts `credential.revision.newest_live:`                                                                     |
| E01.12 | `credential login github --name n`                                                                                                                                     | 1    | stderr starts `credential.entry.unsupported:` (`github` does not accept OAuth entry)                                 |
| E01.13 | `credential login-status login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV` (valid format, absent)                                                                              | 1    | stderr starts `credential.login.not_found:`                                                                          |
| E01.14 | `credential login-code login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV value` (valid format, absent)                                                                          | 1    | stderr starts `credential.login.not_found:`                                                                          |

Model-removal refusal on `rotate` and `update-metadata` (`credential.metadata.model_in_use`)
is tested in plan 03, which provides the real `enablementsDependentOnModel` implementation.
Binding-naming refusal is tested in plan 05, which provides the real `bindingsNaming`
implementation. The `login` and `login-code` success paths require pi-ai OAuth interaction;
plan 01 tests refusal paths only for those commands.

## Blockers

None.

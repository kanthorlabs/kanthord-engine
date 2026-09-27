# Plan 08: CLI app

## Scope

This plan adds per-group CLI command files for every service and component
Plans 01–06 deliver. It edits `src/apps/cli/index.ts` to remove help-only stubs
and to register real command groups for `credential`, `project`, `mission`,
`scheduler`. It extends `src/apps/cli/worker.ts` with eight agent enablement
sub-commands.

Per D11: every ERD 1 Mission command is implemented; no command is BLOCKED for
`Text` bounds. Per D12: no BLOCKED command is registered; no Intake or Tracking
stub is added; `worker agent get` is absent; a command outside ERD 1 is absent.
Per D13: each CLI group has one subprocess test file under
`src/apps/server/cli-<group>.test.ts`; Plan 08 does not run `generate:openapi`.

In scope (ERD 1 commands):

- `credential` group: 9 commands.
- `project` group: 11 commands (`source secret get` is absent — Plan 05 has no
  `sourceSecret.get` operation).
- `mission` group: 19 commands (`graph get` and `criterion list` are absent —
  Plan 06 declares no matching operations).
- `worker` group extension: 8 agent enablement commands.
- `scheduler` group: `queue list` and `queue peek`.

Out of scope:

- Human controls (pause, resume, block, unblock, ready, override, discard): ERD 2.
- Evidence, assessment, outcome, attempt, execution-scoped commands: ERD 2.
- Worker instance lifecycle, heartbeat, handover, catalog reads, provider check:
  ERD 2.
- Tracking and Intake command groups: no ERD 1 commands; no stubs.

## Sources

- `engine/docs/cli/credential.md` — 9 credential commands, error codes,
  line-output exception for `login`. Operation IDs use underscore separators.
- `engine/docs/cli/project.md` — 11 project commands (rows 1–11; row 12
  `source secret get` absent). CLI page marks rows 5–8 "blocked" due to HANDOFF;
  D12 requires implementation because Plan 05 declares all four operations.
- `engine/docs/cli/mission.md` — ERD 1 command inventory (rows 1–22; rows 23–31
  are human controls, ERD 2).
- `engine/docs/cli/worker.md` — 8 agent enablement commands.
- `engine/docs/cli/scheduler.md` — queue list, queue peek.
- `engine/docs/cli/common-flags.md` — flag resolution order, pagination contract,
  single-use enforcement. Every option except `--kind` in project.md is
  single-use.
- `docs/brainstorm/architecture.impl.md:339–349` — error code form (3+ parts).
- `docs/reference/erd/01-setup.md` — ERD 1 table and constraint rules.
- `engine/AGENTS.md` — CLI imports contracts and adapter only.
- `engine/.agents/plan/00-index.md` — plan order and seam ownership.
- `engine/.agents/plan/01-custody.md` — `custodyOperations` keys (short, no prefix):
  `create`, `list`, `get`, `rotate`, `update_metadata`, `revoke`, `login`,
  `login_code`, `login_status`.
- `engine/.agents/plan/02-scheduler-job.md` — `schedulerOperations` keys (camelCase):
  `queueList`, `queuePeek`.
- `engine/.agents/plan/03-worker-agent-enablement.md` — `workerOperations` keys
  (dotted, no prefix): `agent.enablement.list`, `agent.enablement.get`,
  `agent.enablement.put`, `agent.enablement.enable`, `agent.enablement.disable`,
  `agent.enablement.remove`, `agent.enablement.provider.add`,
  `agent.enablement.provider.remove`.
- `engine/.agents/plan/05-project-service.md` — `projectOperations` keys (short,
  no prefix): `create`, `list`, `get`, `rename`, `binding.list`, `binding.get`,
  `bindingSet.get`, `bindingSet.write`, `bindingRevision.list`,
  `agentConfiguration.list`, `agentConfiguration.get`. Route params use
  `bindingId`, not `workerBindingId`.
- `engine/.agents/plan/06-mission-service.md` — `missionOperations` keys (short,
  no prefix). `export` and `import.preview` are `mutation: false`.
- `engine/src/apps/cli/worker.ts` — Commander pattern to follow.
- `engine/src/apps/server/cli-worker.test.ts` — subprocess test pattern.
- `engine/src/gateway/client-result.ts` — `createClient` maps JS object keys to
  client methods; the key is the method name, not the operation ID.
- `engine/src/kernel/files.ts` — `readPrivate`, `audit`; missing-path converts to
  `system.files.inspect_failed`, not ENOENT.

## Depends on

- Plan 01 — `src/custody/contract.ts` exports `custodyOperations`.
- Plan 02 — `src/scheduler/contract.ts` exports `schedulerOperations`.
- Plan 03 — `src/worker/contract.ts` exports `workerOperations`.
- Plan 05 — `src/project/contract.ts` exports `projectOperations`.
- Plan 06 — `src/mission/contract.ts` exports `missionOperations`.
- Plan 07 — server assembled; subprocess tests run against it.

## Provides

None. Plan 08 is a terminal layer.

## Operation key to command mapping

| CLI group  | CLI command                        | `httpClient` key                     | Operation ID                              |
| ---------- | ---------------------------------- | ------------------------------------ | ----------------------------------------- |
| credential | `create`                           | `"create"`                           | `credential.create`                       |
| credential | `list`                             | `"list"`                             | `credential.list`                         |
| credential | `get`                              | `"get"`                              | `credential.get`                          |
| credential | `rotate`                           | `"rotate"`                           | `credential.rotate`                       |
| credential | `update-metadata`                  | `"update_metadata"`                  | `credential.update_metadata`              |
| credential | `revoke`                           | `"revoke"`                           | `credential.revoke`                       |
| credential | `login`                            | `"login"`                            | `credential.login`                        |
| credential | `login-code`                       | `"login_code"`                       | `credential.login_code`                   |
| credential | `login-status`                     | `"login_status"`                     | `credential.login_status`                 |
| project    | `create`                           | `"create"`                           | `project.create`                          |
| project    | `list`                             | `"list"`                             | `project.list`                            |
| project    | `get`                              | `"get"`                              | `project.get`                             |
| project    | `rename`                           | `"rename"`                           | `project.rename`                          |
| project    | `binding list`                     | `"binding.list"`                     | `project.binding.list`                    |
| project    | `binding get`                      | `"binding.get"`                      | `project.binding.get`                     |
| project    | `binding export`                   | `"bindingSet.get"`                   | `project.bindingSet.get`                  |
| project    | `binding apply`                    | `"bindingSet.write"`                 | `project.bindingSet.write`                |
| project    | `binding revision list`            | `"bindingRevision.list"`             | `project.bindingRevision.list`            |
| project    | `agent list`                       | `"agentConfiguration.list"`          | `project.agentConfiguration.list`         |
| project    | `agent get`                        | `"agentConfiguration.get"`           | `project.agentConfiguration.get`          |
| mission    | `get`                              | `"get"`                              | `mission.get`                             |
| mission    | `node list`                        | `"node.list"`                        | `mission.node.list`                       |
| mission    | `node get`                         | `"node.get"`                         | `mission.node.get`                        |
| mission    | `node revision list`               | `"node.revision.list"`               | `mission.node.revision.list`              |
| mission    | `node revision get`                | `"node.revision.get"`                | `mission.node.revision.get`               |
| mission    | `edge list`                        | `"edge.list"`                        | `mission.edge.list`                       |
| mission    | `node retire preview`              | `"node.retire.preview"`              | `mission.node.retire.preview`             |
| mission    | `export`                           | `"export"`                           | `mission.export`                          |
| mission    | `node create`                      | `"node.create"`                      | `mission.node.create`                     |
| mission    | `node update`                      | `"node.update"`                      | `mission.node.update`                     |
| mission    | `node move`                        | `"node.move"`                        | `mission.node.move`                       |
| mission    | `dependency add`                   | `"dependency.add"`                   | `mission.dependency.add`                  |
| mission    | `dependency remove`                | `"dependency.remove"`                | `mission.dependency.remove`               |
| mission    | `criterion set`                    | `"criterion.set"`                    | `mission.criterion.set`                   |
| mission    | `node rebind`                      | `"node.rebind"`                      | `mission.node.rebind`                     |
| mission    | `node priority set`                | `"node.priority.set"`                | `mission.node.priority.set`               |
| mission    | `node retire`                      | `"node.retire"`                      | `mission.node.retire`                     |
| mission    | `import preview`                   | `"import.preview"`                   | `mission.import.preview`                  |
| mission    | `import apply`                     | `"import.apply"`                     | `mission.import.apply`                    |
| scheduler  | `queue list`                       | `"queueList"`                        | `scheduler.queue.list`                    |
| scheduler  | `queue peek`                       | `"queuePeek"`                        | `scheduler.queue.peek`                    |
| worker     | `agent enablement list`            | `"agent.enablement.list"`            | `worker.agent.enablement.list`            |
| worker     | `agent enablement get`             | `"agent.enablement.get"`             | `worker.agent.enablement.get`             |
| worker     | `agent enablement put`             | `"agent.enablement.put"`             | `worker.agent.enablement.put`             |
| worker     | `agent enablement enable`          | `"agent.enablement.enable"`          | `worker.agent.enablement.enable`          |
| worker     | `agent enablement disable`         | `"agent.enablement.disable"`         | `worker.agent.enablement.disable`         |
| worker     | `agent enablement remove`          | `"agent.enablement.remove"`          | `worker.agent.enablement.remove`          |
| worker     | `agent enablement provider add`    | `"agent.enablement.provider.add"`    | `worker.agent.enablement.provider.add`    |
| worker     | `agent enablement provider remove` | `"agent.enablement.provider.remove"` | `worker.agent.enablement.provider.remove` |

## Tasks

### 08.1 Add shared CLI helper module

- Files: `src/apps/cli/shared.ts` (new), `src/apps/cli/shared.test.ts` (new)
- Do:
  1. Export `detectDuplicateKeys(text: string): void`.
     - Walk `text` character by character; maintain a nesting stack of `Set<string>`.
     - Push a new `Set` onto the stack on `{`; pop on `}`.
     - When inside an object (stack is non-empty), scan each JSON string key: read
       from `"` through the next unescaped `"`, interpret `\\` escape sequences to
       produce the key value. After the `:`, check the key against the current
       `Set`; throw `Diagnostic("cli.file.duplicate_key", key)` if found; otherwise
       add the key. Skip strings that are values (after `:` or in arrays).
     - Throw `Diagnostic("cli.file.not_json", "...")` on any tokenizer error.
  2. Export `readJsonFile(path: string, requirePrivate = false): unknown`.
     - Throw `Diagnostic("cli.file.invalid_path", "stdin is not accepted")` when
       `path === "-"`.
     - When `requirePrivate` is false:
       - Call `statSync(path, { throwIfNoEntry: false })` from `node:fs`; throw
         `Diagnostic("cli.file.not_found", "...")` when the result is undefined.
       - Throw `Diagnostic("cli.file.not_regular", "...")` when
         `stat.isFile()` is false.
       - Call `readFileSync(path)`; decode with
         `new TextDecoder("utf-8", { fatal: true }).decode(buffer)`; catch
         `TypeError` and throw `Diagnostic("cli.file.encoding_invalid", "...")`.
     - When `requirePrivate` is true:
       - Call `statSync(path, { throwIfNoEntry: false })`; throw
         `Diagnostic("cli.file.not_found", "...")` when undefined.
       - Throw `Diagnostic("cli.file.not_regular", "...")` when not a file.
       - Call `readPrivate(path)` from `../../kernel/files.ts`; its
         `system.files.invalid_permissions` propagates unmodified.
     - Call `detectDuplicateKeys(text)`.
     - Call `JSON.parse(text)`; catch `SyntaxError` and throw
       `Diagnostic("cli.file.not_json", "...")`.
     - Throw `Diagnostic("cli.file.not_object", "...")` when the parsed value is
       not a plain object (`typeof v !== "object" || v === null || Array.isArray(v)`).
     - Return the parsed value.
  3. Export `readJsonFileAs<S extends z.ZodTypeAny>(path: string, schema: S, requirePrivate = false): z.infer<S>`.
     - Call `readJsonFile(path, requirePrivate)` → `raw`.
     - Call `schema.safeParse(raw)`; throw
       `Diagnostic("cli.file.schema_invalid", JSON.stringify(result.error))` on
       failure.
     - Return `result.data`.
  4. Export `resolveKey(options: { idempotencyKey?: string }): string`.
     - When `options.idempotencyKey` is present, validate with
       `ulidSchema.safeParse`; throw
       `Diagnostic("cli.idempotency_key.invalid", "...")` on failure; return the
       value.
     - When absent, return `ulid()`.
  5. Export `handleMutationResult<T>(result: OperationResult<T>, indeterminateCode: string, key: string): T`.
     - On `OperationResultType.Completed` return `result.data`.
     - On `OperationResultType.Failure` throw
       `Diagnostic(result.error.error.code, JSON.stringify({ ...result.error.error, idempotencyKey: key }))`.
     - On `OperationResultType.Indeterminate` throw
       `Diagnostic(indeterminateCode, "retry with --idempotency-key " + key)`.
  6. Export `handleReadResult<T>(result: OperationResult<T>, indeterminateCode: string): T`.
     - On `OperationResultType.Completed` return `result.data`.
     - On `OperationResultType.Failure` throw
       `Diagnostic(result.error.error.code, JSON.stringify(result.error.error))`.
     - On `OperationResultType.Indeterminate` throw
       `Diagnostic(indeterminateCode, "retry the command")`.
  7. Export `requireToken(token: string | undefined, code: string): asserts token is string`.
     - Throw `Diagnostic(code, "a token is required")` when token is undefined or
       blank.
  8. Export `parsePositiveInt(value: string, code: string): number`.
     - Parse with `Number(value)`; throw `Diagnostic(code, "not a positive integer")`
       when not a finite positive safe integer.
  9. Export `singleUse(name: string): (value: string, previous: string | undefined) => string`.
     - Return a Commander coercion. When `previous` is not undefined, throw
       `Diagnostic("cli.option.duplicate", name + " may not be repeated")`.
     - Otherwise return `value`.
  10. In `src/apps/cli/shared.test.ts` add unit tests using `node:test` and
      `node:assert/strict`.
- Rules:
  - `readPrivate` from `../../kernel/files.ts`; its missing-path behavior throws
    `system.files.inspect_failed`, not ENOENT — always check existence with
    `statSync` before calling it.
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
  - Test: `readJsonFile` on a file with `{"x":{"a":1,"a":2}}` throws
    `cli.file.duplicate_key` (nested duplicate).
  - Test: `resolveKey({ idempotencyKey: "not-a-ulid" })` throws
    `cli.idempotency_key.invalid`.
  - Test: `resolveKey({ idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA" })` returns the
    key.
  - Test: `resolveKey({})` returns a 26-character string.
  - Test: `parsePositiveInt("0", "cli.test.bad_int")` throws `cli.test.bad_int`.
  - Test: `parsePositiveInt("1", "cli.test.bad_int")` returns 1.
  - Test: `singleUse("--endpoint")("a", "b")` throws `cli.option.duplicate`.
  - Test: `singleUse("--endpoint")("a", undefined)` returns `"a"`.
  - Test: `handleMutationResult` on Failure includes `idempotencyKey` in the
    thrown diagnostic's message.

### 08.2 Add credential read commands

- Files: `src/apps/cli/credential.ts` (new), `src/apps/cli/constants.ts` (edit),
  `src/apps/cli/index.ts` (edit), `src/apps/server/cli-credential.test.ts` (new)
- Do:
  1. Import `custodyOperations` from `../../custody/contract.ts`. Import helpers
     from `./shared.ts`. Import `resolveClient` from `./resolver.ts`.
  2. Export `addCredentialCommand(program: Command): void`. Add group `credential`
     with `--endpoint <url>` (coercion `singleUse("--endpoint")`) and
     `--token <token>` (coercion `singleUse("--token")`). Set action to help.
  3. All `httpClient` calls: `httpClient(custodyOperations, endpoint, token)`.
     All read commands define no `--idempotency-key` option. Commander rejects
     an unknown `--idempotency-key` on read commands.
  4. Add leaf `list`:
     - Options: `--platform <platform>` (coercion `singleUse("--platform")`),
       `--limit <count>` (coercion `singleUse("--limit")`),
       `--cursor <cursor>` (coercion `singleUse("--cursor")`).
     - `requireToken(opts.token, "cli.credential.list.token_required")`.
     - Validate `--limit`: when present,
       `parsePositiveInt(opts.limit, "cli.pagination.limit_invalid")`; clamp
       to 1–1000; throw `Diagnostic("cli.pagination.limit_out_of_range", "...")`
       when outside range. Default to 100.
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
  7. In `src/apps/cli/constants.ts`: add `Credential = "credential"` to `CommandName`.
  8. In `src/apps/cli/index.ts`: import `addCredentialCommand`; call it inside
     `createProgram` after `addJWTCommand`.
  9. Write `src/apps/server/cli-credential.test.ts` using subprocess invocation.
- Rules:
  - Read commands define no `--idempotency-key`; Commander's natural unknown-option
    rejection applies.
  - Operation keys are short, no `credential.` prefix.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `credential list --help` exits 0; stdout matches `--platform`.
  - Test: `credential get --help` exits 0.
  - Test: `credential login-status --help` exits 0.
  - Test subprocess against live server: `credential list --endpoint http://localhost:31415 --token <valid-token>` exits 0; stdout is valid JSON with a `rows` array.
  - Test: `credential list --endpoint http://localhost:31415` exits nonzero (no token).
  - Test: `credential list --endpoint http://localhost:31415 --token t --limit 0` exits nonzero; stderr matches `cli.pagination.limit_out_of_range`.

### 08.3 Add credential mutation commands

- Files: `src/apps/cli/credential.ts` (edit),
  `src/apps/server/cli-credential.test.ts` (edit)
- Do: Inside `addCredentialCommand`, after the read commands, add these six
  mutation commands. All accept `--idempotency-key <key>` (coercion
  `singleUse("--idempotency-key")`).
  1. Add leaf `create --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken(opts.token, "cli.credential.create.token_required")`.
     - `resolveKey(opts)` → `key`.
     - `readJsonFileAs(opts.file, credentialCreateSchema, true)` → body.
       (`credentialCreateSchema` is the body zod schema from Plan 01.)
     - Call client `["create"]({ params: {}, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.create.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `rotate <credential-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, credentialRotateBodySchema, true)` → body
       (private file; body contains the new secret material).
     - Call client `["rotate"]({ params: { credentialName: name }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.rotate.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  3. Add leaf `update-metadata <credential-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, credentialUpdateMetadataBodySchema)` → body
       (ordinary file; contains `{ metadata }`).
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
     - `--mode <mode>` coercion: `singleUse("--mode")`; optional; accepted values
       `browser` and `device`; throw
       `Diagnostic("cli.credential.login.invalid_mode", "...")` on other value.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["login"]({ params: {}, query: {}, body: { platform, name: opts.name, mode: opts.mode } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.login.indeterminate", key)` → data.
     - Print one line per field to `process.stdout`: `sessionId`, `address`,
       `code`, `expiresAt`, then `idempotencyKey: key`. (Line-output exception for
       OAuth flow; field names match Plan 01's login response.) A `null` `code`
       (browser mode) prints an empty line. The command never polls.
  6. Add leaf `login-code <session> <value>`:
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["login_code"]({ params: { sessionId: session }, query: {}, body: { value } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.credential.login_code.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  7. Add tests.
- Rules:
  - `create` and `rotate` pass `requirePrivate = true` to `readJsonFileAs`.
  - `update-metadata` passes `requirePrivate = false`.
  - `idempotencyKey` goes in the second argument of the client call, not in `body`.
  - Field name is `expiresAt`, not `expiry` (matches Plan 01 login response).
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `credential create --endpoint http://localhost:31415 --token t --file /nonexistent.json` exits nonzero; stderr matches `cli.file.not_found`.
  - Test: `credential create --endpoint http://localhost:31415 --token t --file /some/file --file /dup` exits nonzero; stderr matches `cli.option.duplicate`.
  - Test: `credential revoke --endpoint http://localhost:31415 --token t name abc` exits nonzero; stderr matches `cli.credential.revoke.invalid_revision`.
  - Test: `credential login --endpoint http://localhost:31415 --token t ssh --name n --mode invalid` exits nonzero; stderr matches `cli.credential.login.invalid_mode`.
  - Test subprocess against live server with a valid idempotency key re-sent: exit 0 with same output (idempotency).

### 08.4 Add project core commands

- Files: `src/apps/cli/project.ts` (new), `src/apps/cli/index.ts` (edit),
  `src/apps/server/cli-project.test.ts` (new)
- Do:
  1. Import `projectOperations` from `../../project/contract.ts`. Import helpers.
  2. Export `addProjectCommand(program: Command): void`. Add group `project` with
     `--endpoint <url>` (coercion `singleUse`) and `--token <token>` (coercion
     `singleUse`). Set action to help.
  3. All read commands define no `--idempotency-key`.
  4. Export a `validateProjectId(id: string, code: string): void` helper
     (internal to `project.ts`): throw `Diagnostic(code, "...")` when `id` does
     not match `/^project_[0-9A-HJKMNP-TV-Z]{26}$/`.
  5. Add leaf `create --name <name>`:
     - `--name` coercion: `singleUse("--name")`; required.
     - Validate name matches `/^[a-z][a-z0-9-]{0,62}$/`; throw
       `Diagnostic("cli.project.create.invalid_name", "...")`.
     - `requireToken(opts.token, "cli.project.create.token_required")`.
     - `resolveKey(opts)` → `key`.
     - Call client `["create"]({ params: {}, query: {}, body: { name } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.project.create.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  6. Add leaf `list`:
     - Options: `--limit`, `--cursor` with `singleUse` coercions.
     - `requireToken`; validate pagination; default limit 100.
     - Call client `["list"]({ params: {}, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.project.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  7. Add leaf `get <project-id>`:
     - `validateProjectId(projectId, "cli.project.get.invalid_project_id")`.
     - `requireToken`.
     - Call client `["get"]({ params: { projectId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.project.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  8. Add leaf `rename <project-id> --name <name>`:
     - `--name` coercion: `singleUse("--name")`; required.
     - `validateProjectId(projectId, "cli.project.rename.invalid_project_id")`.
     - Validate name pattern. `requireToken`; `resolveKey` → `key`.
     - Call client `["rename"]({ params: { projectId }, query: {}, body: { name } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.project.rename.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  9. In `src/apps/cli/constants.ts`: add `Project = "project"` to `CommandName`.
  10. In `src/apps/cli/index.ts`: import `addProjectCommand`; replace the
      `CommandName.Project` help-only stub with a call to `addProjectCommand(program)`.
  11. Write `src/apps/server/cli-project.test.ts`.
- Rules:
  - `get` and `list` define no `--idempotency-key`.
  - `idempotencyKey` goes in the second arg of mutation client calls.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `project create --help` exits 0; stdout matches `--name`.
  - Test: `project create --endpoint http://localhost:31415 --token t --name INVALID` exits nonzero; stderr matches `cli.project.create.invalid_name`.
  - Test: `project create --endpoint http://localhost:31415 --name valid-name` exits nonzero; stderr matches `cli.project.create.token_required`.
  - Test subprocess against live server: `project create --token <tok> --name my-proj` exits 0; stdout is JSON with `projectId`.
  - Test: re-send same request with same `--idempotency-key`; exits 0 with same `projectId`.
  - Test: `project get --endpoint http://localhost:31415 --token t invalid-id` exits nonzero; stderr matches `cli.project.get.invalid_project_id`.

### 08.5 Add project binding commands

- Files: `src/apps/cli/project.ts` (edit),
  `src/apps/server/cli-project.test.ts` (edit)
- Do: Inside `addProjectCommand`, add a `binding` sub-group. Set action to help.
  1. Add leaf `binding list <project-id>`:
     - Options: `--kind <kind>` (repeatable: `.option("--kind <kind>", ..., (v, acc: string[] = []) => [...acc, v])`),
       `--state <state>` (coercion `singleUse("--state")`),
       `--limit` and `--cursor` (coercions `singleUse`).
     - `validateProjectId(projectId, "cli.project.binding.list.invalid_project_id")`.
     - Validate each supplied `--kind` value against the `BindingKind` enum; throw
       `Diagnostic("cli.project.binding.list.invalid_kind", "...")` on unknown value.
     - Validate `--state` against `current | removed | all`; throw
       `Diagnostic("cli.project.binding.list.invalid_state", "...")` on other value.
     - `requireToken`; validate pagination; default limit 100.
     - Call client `["binding.list"]({ params: { projectId }, query: { kind: opts.kind, state: opts.state, limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.project.binding.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  2. Add leaf `binding get <project-id> <binding-id>`:
     - Validate `projectId` prefix + ULID suffix; validate `bindingId` matches
       `/^binding_[0-9A-HJKMNP-TV-Z]{26}$/`; throw
       `Diagnostic("cli.project.binding.get.invalid_binding_id", "...")`.
     - `requireToken`.
     - Call client `["binding.get"]({ params: { projectId, bindingId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.project.binding.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  3. Add leaf `binding export <project-id>`:
     - `validateProjectId(projectId, "cli.project.binding.export.invalid_project_id")`.
     - `requireToken`.
     - Call client `["bindingSet.get"]({ params: { projectId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.project.binding.export.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  4. Add leaf `binding apply <project-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateProjectId(projectId, "cli.project.binding.apply.invalid_project_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, bindingSetWriteSchema)` → body.
       (`bindingSetWriteSchema` is the body schema from Plan 05.)
     - Call client `["bindingSet.write"]({ params: { projectId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.project.binding.apply.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  5. Add leaf `binding revision list <project-id> <binding-id>`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`).
     - Validate both IDs. `requireToken`; validate pagination.
     - Call client `["bindingRevision.list"]({ params: { projectId, bindingId }, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.project.binding.revision.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  6. Add tests.
- Rules:
  - `binding list`, `binding get`, `binding export`, `binding revision list` define
    no `--idempotency-key`.
  - `binding apply` passes `idempotencyKey` in the second arg of the client call.
  - `BindingKind` enum from Plan 05's contract; validate each `--kind` value.
  - `--kind` is the only repeatable option (CLI page: project.md).
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `project binding list --help` exits 0; stdout matches `--kind`, `--state`.
  - Test: `project binding list --endpoint http://localhost:31415 --token t invalid --kind repo` exits nonzero; stderr matches `cli.project.binding.list.invalid_project_id`.
  - Test: `project binding apply --help` exits 0; stdout matches `--file`.
  - Test subprocess against live server: `project binding list --token <tok> <projectId>` exits 0; stdout is JSON with `rows`.
  - Test: `project binding apply --token <tok> <projectId> --file <valid-binding-set.json>` exits 0; stdout is JSON with `idempotencyKey`.

### 08.6 Add project agent commands

- Files: `src/apps/cli/project.ts` (edit),
  `src/apps/server/cli-project.test.ts` (edit)
- Do: Inside `addProjectCommand`, add an `agent` sub-group. Set action to help.
  1. Add leaf `agent list <project-id> <worker-binding-id>`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`).
     - `validateProjectId(projectId, "cli.project.agent.list.invalid_project_id")`.
     - Validate `workerBindingId` matches `/^binding_[0-9A-HJKMNP-TV-Z]{26}$/`; throw
       `Diagnostic("cli.project.agent.list.invalid_binding_id", "...")`.
     - `requireToken`; validate pagination; default limit 100.
     - Call client `["agentConfiguration.list"]({ params: { projectId, bindingId: workerBindingId }, query: { limit, cursor }, body: null })`.
       (Route param is `bindingId`; CLI arg is `workerBindingId` for display.)
     - `handleReadResult(result, "cli.project.agent.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  2. Add leaf `agent get <project-id> <worker-binding-id> <agent-name>`:
     - Validate `projectId` and `workerBindingId`. `requireToken`.
     - Call client `["agentConfiguration.get"]({ params: { projectId, bindingId: workerBindingId, agentName }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.project.agent.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  3. Add tests.
- Rules:
  - Route param is `bindingId` (not `workerBindingId`); Plan 05 schema uses `bindingId`.
  - Both commands define no `--idempotency-key`.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `project agent list --help` exits 0.
  - Test: `project agent get --endpoint http://localhost:31415 --token t project_01ARZ3NDEKTSV4RRFFQ69G5FAA invalid` exits nonzero; stderr matches `cli.project.agent.list.invalid_binding_id` (or `agent.get` equivalent).
  - Test subprocess against live server: `project agent list --token <tok> <projectId> <bindingId>` exits 0; stdout is JSON with `rows`.

### 08.7 Add mission read commands

- Files: `src/apps/cli/mission.ts` (new), `src/apps/cli/index.ts` (edit),
  `src/apps/server/cli-mission.test.ts` (new)
- Do:
  1. Import `missionOperations` from `../../mission/contract.ts`. Import helpers.
  2. Export `addMissionCommand(program: Command): void`. Add group `mission` with
     `--endpoint <url>` and `--token <token>` using `singleUse` coercions. Set
     action to help.
  3. All read commands define no `--idempotency-key`.
  4. Export a `validateMissionId(id: string, code: string): void` internal helper.
     Throw `Diagnostic(code, "...")` when `id` does not match
     `/^mission_[0-9A-HJKMNP-TV-Z]{26}$/`.
  5. Export a `validateNodeId(id: string, code: string): void` internal helper.
     Throw `Diagnostic(code, "...")` when `id` does not match
     `/^node_[0-9A-HJKMNP-TV-Z]{26}$/`.
  6. Add leaf `get <project-id>`:
     - Validate `projectId` matches `/^project_[0-9A-HJKMNP-TV-Z]{26}$/`; throw
       `Diagnostic("cli.mission.get.invalid_project_id", "...")`.
     - `requireToken(opts.token, "cli.mission.get.token_required")`.
     - Call client `["get"]({ params: { projectId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.mission.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  7. Add leaf `node list <mission-id>`:
     - Options: `--kind <kind>` (coercion `singleUse("--kind")`),
       `--state <state>` (coercion `singleUse("--state")`),
       `--parent <node-id>` (coercion `singleUse("--parent")`),
       `--include-retired` (boolean flag),
       `--limit` and `--cursor` (coercions `singleUse`).
     - `validateMissionId(missionId, "cli.mission.node.list.invalid_mission_id")`.
     - Validate `--kind` against `initiative | objective | task`; throw
       `Diagnostic("cli.mission.node.list.invalid_kind", "...")` on other value.
     - When `--kind task` and `--state` are both supplied, throw
       `Diagnostic("cli.mission.node.list.kind_state_conflict", "tasks have no independent state")`.
     - When `--parent` is supplied, `validateNodeId(opts.parent, "cli.mission.node.list.invalid_parent_id")`.
     - `requireToken`; validate pagination; default limit 100.
     - Call client `["node.list"]({ params: { missionId }, query: { kind, state, parentId: opts.parent, includeRetired: opts.includeRetired ?? false, limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.mission.node.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  8. Add leaf `node get <node-id>`:
     - `validateNodeId(nodeId, "cli.mission.node.get.invalid_node_id")`.
     - `requireToken`.
     - Call client `["node.get"]({ params: { nodeId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.mission.node.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  9. Add leaf `node revision list <node-id>`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`).
     - `validateNodeId`. `requireToken`; validate pagination.
     - Call client `["node.revision.list"]({ params: { nodeId }, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.mission.node.revision.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  10. Add leaf `node revision get <node-id> <revision>`:
      - `validateNodeId(nodeId, "cli.mission.node.revision.get.invalid_node_id")`.
      - `parsePositiveInt(revision, "cli.mission.node.revision.get.invalid_revision")` → `rev`.
      - `requireToken`.
      - Call client `["node.revision.get"]({ params: { nodeId, revision: rev }, query: {}, body: null })`.
      - `handleReadResult(result, "cli.mission.node.revision.get.indeterminate")` → data.
      - Print `JSON.stringify(data)`.
  11. Add leaf `edge list <mission-id>`:
      - Options: `--kind <kind>` (coercion `singleUse("--kind")`),
        `--node <node-id>` (coercion `singleUse("--node")`),
        `--limit` and `--cursor` (coercions `singleUse`).
      - `validateMissionId(missionId, "cli.mission.edge.list.invalid_mission_id")`.
      - Validate `--kind` against `containment | dependency`; throw
        `Diagnostic("cli.mission.edge.list.invalid_kind", "...")`.
      - When `--node` supplied, `validateNodeId(opts.node, "cli.mission.edge.list.invalid_node_id")`.
      - `requireToken`; validate pagination.
      - Call client `["edge.list"]({ params: { missionId }, query: { kind, nodeId: opts.node, limit, cursor }, body: null })`.
      - `handleReadResult(result, "cli.mission.edge.list.indeterminate")` → data.
      - Print `JSON.stringify(data)`.
  12. Add leaf `node retire preview <node-id>`:
      - `--force` is a boolean flag (no value), default false.
      - `validateNodeId(nodeId, "cli.mission.node.retire.preview.invalid_node_id")`.
      - `requireToken`.
      - Call client `["node.retire.preview"]({ params: { nodeId }, query: { force: String(opts.force ?? false) }, body: null })`.
      - `handleReadResult(result, "cli.mission.node.retire.preview.indeterminate")` → data.
      - Print `JSON.stringify(data)`.
  13. Add leaf `export <mission-id>`:
      - Options: `--format <markdown|json>` (coercion `singleUse("--format")`; required),
        `--out <path>` (coercion `singleUse("--out")`; required).
      - `validateMissionId(missionId, "cli.mission.export.invalid_mission_id")`.
      - Validate `--format` against `markdown | json`; throw
        `Diagnostic("cli.mission.export.invalid_format", "...")`.
      - `requireToken`.
      - Call client `["export"]({ params: { missionId }, query: { format: opts.format }, body: null })`.
      - `handleReadResult(result, "cli.mission.export.indeterminate")` → data.
      - When `format === "markdown"`:
        - Call `statSync(opts.out, { throwIfNoEntry: false })`; throw
          `Diagnostic("cli.mission.export.not_a_directory", "...")` when undefined
          or `!stat.isDirectory()`.
        - Throw `Diagnostic("cli.mission.export.directory_not_empty", "...")`
          when `readdirSync(opts.out).length > 0`.
        - Write each `{ filename, content }` from `data.files` to
          `join(opts.out, entry.filename)` with `writeFileSync`.
      - When `format === "json"`:
        - Write `JSON.stringify(data)` to `opts.out` with `writeFileSync`.
      - Print `JSON.stringify({ missionId: data.missionId, missionVersion: data.missionVersion })`.
  14. In `src/apps/cli/index.ts`: import `addMissionCommand`; replace the
      `CommandName.Mission` help-only stub with a call to `addMissionCommand(program)`.
  15. Write `src/apps/server/cli-mission.test.ts`.
- Rules:
  - All read commands define no `--idempotency-key`.
  - `export` is `mutation: false` (Plan 06); no `--idempotency-key`.
  - Operation keys use short form without `mission.` prefix.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `mission get --help` exits 0; stdout matches `<project-id>`.
  - Test: `mission node list --help` exits 0; stdout matches `--kind`, `--state`, `--parent`, `--include-retired`.
  - Test: `mission node list --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA --kind task --state Available` exits nonzero; stderr matches `cli.mission.node.list.kind_state_conflict`.
  - Test: `mission node revision get --endpoint http://localhost:31415 --token t node_01ARZ3NDEKTSV4RRFFQ69G5FAA notanint` exits nonzero; stderr matches `cli.mission.node.revision.get.invalid_revision`.
  - Test: `mission export --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA --format xml --out /tmp/x` exits nonzero; stderr matches `cli.mission.export.invalid_format`.
  - Test subprocess against live server: `mission get --token <tok> <projectId>` exits 0; stdout is JSON with `missionId`.
  - Test: `mission export --token <tok> <missionId> --format markdown --out <existing-empty-dir>` exits 0; directory contains exported files.

### 08.8 Add mission node edit commands

- Files: `src/apps/cli/mission.ts` (edit),
  `src/apps/server/cli-mission.test.ts` (edit)
- Do: Inside `addMissionCommand`, add three node mutation commands. All accept
  `--idempotency-key <key>` (coercion `singleUse("--idempotency-key")`).
  1. Add leaf `node create <mission-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateMissionId(missionId, "cli.mission.node.create.invalid_mission_id")`.
     - `requireToken(opts.token, "cli.mission.node.create.token_required")`.
     - `resolveKey(opts)` → `key`.
     - `readJsonFileAs(opts.file, nodeCreateBodySchema)` → body.
       Body shape per Plan 06 `NodeCreate`:
       `{ filename, kind, content, reason, expectedMissionVersion, parentId?, expectedParentRevision? }`.
     - Call client `["node.create"]({ params: { missionId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.create.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `node update <node-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateNodeId(nodeId, "cli.mission.node.update.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, nodeUpdateBodySchema)` → body.
       Body shape per Plan 06 `NodeUpdate`:
       `{ filename, content, reason, expectedRevision, expectedMissionVersion }`.
     - Call client `["node.update"]({ params: { nodeId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.update.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  3. Add leaf `node move <node-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateNodeId(nodeId, "cli.mission.node.move.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, nodeMoveBodySchema)` → body.
       Body shape per Plan 06 `Move`:
       `{ newParentId, reason, expectedMissionVersion, expectedRevision, expectedOldParentRevision, expectedNewParentRevision }`.
     - Call client `["node.move"]({ params: { nodeId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.move.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  4. Add tests.
- Rules:
  - `idempotencyKey` goes in the second arg of client calls.
  - `readJsonFileAs` validates against the Plan 06 body schemas; no unchecked cast.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `mission node create --help` exits 0; stdout matches `--file`.
  - Test: `mission node create --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA --file /nonexistent.json` exits nonzero; stderr matches `cli.file.not_found`.
  - Test: `mission node create --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA --file <invalid-schema.json>` exits nonzero; stderr matches `cli.file.schema_invalid`.
  - Test subprocess against live server: `mission node create --token <tok> <missionId> --file <valid.json>` exits 0; stdout is JSON with `nodeId` and `idempotencyKey`.
  - Test: re-send same request with same `--idempotency-key`; exits 0 with same `nodeId`.

### 08.9 Add mission graph and rebind commands

- Files: `src/apps/cli/mission.ts` (edit),
  `src/apps/server/cli-mission.test.ts` (edit)
- Do: Inside `addMissionCommand`, add five mutation commands.
  1. Add leaf `dependency add <node-id> <depends-on-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateNodeId(nodeId, "cli.mission.dependency.add.invalid_node_id")`.
     - `validateNodeId(dependsOnId, "cli.mission.dependency.add.invalid_depends_on_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, graphEditBodySchema)` → body.
       Body shape per Plan 06 `GraphEdit`: `{ reason, expectedMissionVersion }`.
     - Call client `["dependency.add"]({ params: { nodeId, dependsOnId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.dependency.add.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `dependency remove <node-id> <depends-on-id> --file <path>`:
     - Same as add but calls client `["dependency.remove"]`.
     - Diagnostic codes: `cli.mission.dependency_remove.*`.
  3. Add leaf `criterion set <node-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateNodeId(nodeId, "cli.mission.criterion.set.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, criterionSetBodySchema)` → body.
       Body shape per Plan 06 `CriterionSet`:
       `{ criterion, verifications, reason, expectedRevision, expectedMissionVersion }`.
     - Call client `["criterion.set"]({ params: { nodeId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.criterion.set.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  4. Add leaf `node rebind <mission-id> <binding-id> --file <path>`:
     - Options: `--node <node-id>` (coercion `singleUse("--node")`),
       `--file` (coercion `singleUse("--file")`; required),
       `--idempotency-key` (coercion `singleUse`).
     - `validateMissionId(missionId, "cli.mission.node.rebind.invalid_mission_id")`.
     - Validate `bindingId` matches `/^binding_[0-9A-HJKMNP-TV-Z]{26}$/`; throw
       `Diagnostic("cli.mission.node.rebind.invalid_binding_id", "...")`.
     - When `--node` supplied,
       `validateNodeId(opts.node, "cli.mission.node.rebind.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, rebindFileSchema)` → fileBody.
       `rebindFileSchema` validates `{ reason: z.string().min(1), expectedMissionVersion: z.number().int() }`.
     - Build body: `{ bindingId, reason: fileBody.reason, expectedMissionVersion: fileBody.expectedMissionVersion, ...(opts.node ? { nodeId: opts.node } : {}) }`.
     - Call client `["node.rebind"]({ params: { missionId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.rebind.indeterminate", key)` → data.
     - Print `JSON.stringify({ nodeChange: data.nodeChange, skipped: data.skipped, idempotencyKey: key })`.
  5. Add leaf `node priority set <node-id> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `validateNodeId(nodeId, "cli.mission.node.priority.set.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, prioritySetBodySchema)` → body.
       Body shape per Plan 06 `PrioritySet`:
       `{ value: z.number().int(), expectedMissionVersion: z.number().int() }`.
       Field is `value` (not `priority`); no `expectedRevision` field.
     - Call client `["node.priority.set"]({ params: { nodeId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.priority.set.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  6. Add tests.
- Rules:
  - `node.rebind` body field is `bindingId` (not `bindingRevisionId`); the
    positional `<binding-id>` injects it.
  - `PrioritySet` body field is `value`, not `priority`; no `expectedRevision`.
  - The file for rebind is validated with `rebindFileSchema`, not the full `Rebind`
    schema; `bindingId` comes from the positional, `nodeId` from `--node`.
  - `idempotencyKey` goes in the second arg of client calls.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `mission dependency add --help` exits 0.
  - Test: `mission criterion set --help` exits 0; stdout matches `--file`.
  - Test: `mission node rebind --help` exits 0; stdout matches `--node`.
  - Test: `mission node priority set --help` exits 0; stdout matches `--file`.
  - Test: `mission node rebind --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA invalid_bid --file f.json` exits nonzero; stderr matches `cli.mission.node.rebind.invalid_binding_id`.
  - Test subprocess against live server: `mission dependency add --token <tok> <nodeId> <dependsOnId> --file <graphedit.json>` exits 0.

### 08.10 Add mission retire and import commands

- Files: `src/apps/cli/mission.ts` (edit),
  `src/apps/server/cli-mission.test.ts` (edit)
- Do: Inside `addMissionCommand`, add these three operations. Note: per B(retire-tree)
  in Blockers, the Commander structure for `node retire` needs Ulrich's ruling;
  implement `node retire` as a sibling leaf of `node retire preview` (same parent
  group `node`), not as a parent of `preview`.
  1. Add leaf `node retire <node-id> --file <path>`:
     - Options: `--force` (boolean flag, default false),
       `--file` (coercion `singleUse("--file")`; required),
       `--idempotency-key` (coercion `singleUse`).
     - `validateNodeId(nodeId, "cli.mission.node.retire.invalid_node_id")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, retireFileSchema)` → fileBody.
       `retireFileSchema` validates `{ reason: z.string().min(1), expectedMissionVersion: z.number().int(), previewDigest: z.string().min(1) }`.
       The file never carries `force`.
     - Build body: `{ reason: fileBody.reason, expectedMissionVersion: fileBody.expectedMissionVersion, previewDigest: fileBody.previewDigest, force: opts.force ?? false }`.
     - Call client `["node.retire"]({ params: { nodeId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.node.retire.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `import preview <mission-id> --file <path> [<plan-file>...]`:
     - This command is `mutation: false` (Plan 06); define no `--idempotency-key`.
     - `--file` coercion: `singleUse("--file")`; required.
     - `validateMissionId(missionId, "cli.mission.import.preview.invalid_mission_id")`.
     - `requireToken`.
     - `readJsonFileAs(opts.file, importManifestBaseSchema)` → manifest.
       `importManifestBaseSchema` validates `{ format: z.enum(["markdown","json"]), missionVersion: z.number().int().positive(), reason: z.string().min(1) }`.
     - When `format === "markdown"`:
       - When positional plan files are provided and `manifest.files` also exists,
         throw `Diagnostic("cli.mission.import.files_conflict", "...")`.
       - When positional files are provided: for each `planPath`, call `statSync` to
         confirm it is a regular file; call `readFileSync` with `{encoding:"utf8"}`;
         collect `{ filename: basename(planPath), content }`.
       - Build body: `{ format: "markdown", missionId, missionVersion: manifest.missionVersion, reason: manifest.reason, files: positionalFiles.length > 0 ? positionalFiles : manifest.files ?? [] }`.
     - When `format === "json"`:
       - Throw `Diagnostic("cli.mission.import.positionals_not_accepted", "...")`
         when positional plan files are present.
       - `readJsonFileAs(opts.file, importJsonManifestSchema)` → fullManifest.
         (`importJsonManifestSchema` includes `entries` field.)
       - Build body: `{ format: "json", missionId, missionVersion: fullManifest.missionVersion, reason: fullManifest.reason, entries: fullManifest.entries }`.
     - Call client `["import.preview"]({ params: { missionId }, query: {}, body })`.
       (Body is the built import snapshot; `mutation: false` does not mean bodyless.)
     - `handleReadResult(result, "cli.mission.import.preview.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  3. Add leaf `import apply <mission-id> --file <path> [<plan-file>...]`:
     - Same manifest parsing as `import preview`.
     - `--file` provides: `{ format, missionVersion, reason, previewDigest, confirmedRetirements, files? (markdown), entries? (json) }`.
     - Validate with `importApplyManifestSchema` (extends base with `previewDigest` and `confirmedRetirements`).
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["import.apply"]({ params: { missionId }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.mission.import.apply.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  4. Add tests.
- Rules:
  - `import preview` defines no `--idempotency-key` (read).
  - `force` flag on `node retire` injects into body; file never carries `force`.
  - `import.preview` body is not null; it is the full `ImportSnapshotBase`.
  - `idempotencyKey` on `import.apply` goes in the second arg of the client call.
  - `node retire` and `node retire preview` are sibling leaves under the `node`
    sub-group; neither is a parent of the other (see B-retire-tree in Blockers).
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `mission node retire --help` exits 0; stdout matches `--force`, `--file`.
  - Test: `mission import preview --help` exits 0; stdout matches `--file`.
  - Test: `mission import apply --help` exits 0; stdout matches `--file`, `--idempotency-key`.
  - Test: `mission import preview --endpoint http://localhost:31415 --token t mission_01ARZ3NDEKTSV4RRFFQ69G5FAA --file manifest.json plan1.md plan2.md` with `manifest.json` containing `files` → exits nonzero; stderr matches `cli.mission.import.files_conflict`.
  - Test subprocess against live server: Markdown import round-trip — `import preview`, confirm digest, then `import apply` — exits 0 with updated `missionVersion`.

### 08.11 Add worker agent enablement read commands

- Files: `src/apps/cli/worker.ts` (edit),
  `src/apps/server/cli-worker.test.ts` (edit)
- Do:
  1. Add `--token <token>` (coercion `singleUse("--token")`) to the top-level
     `worker` group so leaf commands inherit it.
  2. After the `register` command, add sub-group `agent`. Within it add sub-group
     `enablement`. Both set action to help.
  3. Import helpers from `./shared.ts`. Import `workerOperations` from
     `../../worker/contract.ts` (already imported if present).
  4. Add leaf `agent enablement list`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`).
     - `requireToken(opts.token, "cli.worker.agent.enablement.list.token_required")`.
     - Validate pagination; default limit 100.
     - Call `httpClient(workerOperations, endpoint, token)["agent.enablement.list"]({ params: {}, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.worker.agent.enablement.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  5. Add leaf `agent enablement get <agent-name>`:
     - `requireToken`.
     - Call client `["agent.enablement.get"]({ params: { agentName }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.worker.agent.enablement.get.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  6. Add tests.
- Rules:
  - Both commands define no `--idempotency-key`.
  - Do not remove or change the existing `register` command.
  - Operation keys use dotted form without the `worker.` prefix.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `worker agent enablement list --help` exits 0.
  - Test: `worker agent enablement get --help` exits 0.
  - Test: `worker register --help` still exits 0 (register unchanged).
  - Test subprocess against live server: `worker agent enablement list --token <tok>` exits 0; stdout is JSON with `rows`.

### 08.12 Add worker agent enablement mutation commands

- Files: `src/apps/cli/worker.ts` (edit),
  `src/apps/server/cli-worker.test.ts` (edit)
- Do: Inside `addWorkerCommand`, after read commands, add six mutation commands.
  All accept `--idempotency-key <key>` (coercion `singleUse`).
  1. Add leaf `agent enablement put <agent-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, agentEnablementPutBodySchema)` → body.
       Body shape: `{ expectedRevision?, agentProviders, defaultConfiguration }`.
     - Call client `["agent.enablement.put"]({ params: { agentName }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.put.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  2. Add leaf `agent enablement enable <agent-name> --expected-revision <revision>`:
     - `--expected-revision` coercion: `singleUse("--expected-revision")`; required.
     - `parsePositiveInt(opts.expectedRevision, "cli.worker.agent.enablement.enable.invalid_revision")` → `rev`.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["agent.enablement.enable"]({ params: { agentName }, query: {}, body: { expectedRevision: rev } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.enable.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  3. Add leaf `agent enablement disable <agent-name> --expected-revision <revision>`:
     - Same as enable. Calls `["agent.enablement.disable"]`.
     - Diagnostic codes: `cli.worker.agent.enablement.disable.*`.
  4. Add leaf `agent enablement remove <agent-name> --expected-revision <revision>`:
     - Same revision validation. Calls `["agent.enablement.remove"]`.
     - Print `JSON.stringify({ agentName: data.agentName, idempotencyKey: key })`.
     - Diagnostic codes: `cli.worker.agent.enablement.remove.*`.
  5. Add sub-group `provider` under `enablement`. Set action to help.
  6. Add leaf `agent enablement provider add <agent-name> --file <path>`:
     - `--file` coercion: `singleUse("--file")`.
     - `requireToken`; `resolveKey` → `key`.
     - `readJsonFileAs(opts.file, providerAddBodySchema)` → body.
       Body shape: `{ expectedRevision, name, provider, credential }`.
     - Call client `["agent.enablement.provider.add"]({ params: { agentName }, query: {}, body }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.provider.add.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  7. Add leaf `agent enablement provider remove <agent-name> <provider-name> --expected-revision <revision>`:
     - `--expected-revision` coercion: `singleUse`; required.
     - `parsePositiveInt(opts.expectedRevision, "cli.worker.agent.enablement.provider.remove.invalid_revision")` → `rev`.
     - `requireToken`; `resolveKey` → `key`.
     - Call client `["agent.enablement.provider.remove"]({ params: { agentName, providerName }, query: {}, body: { expectedRevision: rev } }, { idempotencyKey: key })`.
     - `handleMutationResult(result, "cli.worker.agent.enablement.provider.remove.indeterminate", key)` → data.
     - Print `JSON.stringify({ ...data, idempotencyKey: key })`.
  8. Add tests.
- Rules:
  - `idempotencyKey` goes in the second arg of all client calls.
  - `readJsonFileAs` validates against Plan 03 body schemas.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `worker agent enablement put --help` exits 0; stdout matches `--file`.
  - Test: `worker agent enablement enable swe@1 --endpoint http://localhost:31415 --token t --expected-revision abc` exits nonzero; stderr matches `cli.worker.agent.enablement.enable.invalid_revision`.
  - Test: `worker agent enablement put swe@1 --endpoint http://localhost:31415 --file f.json` exits nonzero; stderr matches `cli.worker.agent.enablement.put.token_required`.
  - Test subprocess against live server: full put → enable → disable → remove cycle exits 0 with consistent `agentName`.
  - Test: provider add → remove round-trip exits 0.

### 08.13 Add scheduler command group

- Files: `src/apps/cli/scheduler.ts` (new), `src/apps/cli/constants.ts` (edit),
  `src/apps/cli/index.ts` (edit), `src/apps/server/cli-scheduler.test.ts` (new)
- Do:
  1. Import `schedulerOperations` from `../../scheduler/contract.ts`. Import helpers.
  2. Export `addSchedulerCommand(program: Command): void`. Add group `scheduler` with
     `--endpoint <url>` and `--token <token>` using `singleUse` coercions. Set
     action to help.
  3. Add sub-group `queue`. Set action to help.
  4. Add leaf `queue list <project-id>`:
     - Options: `--limit` and `--cursor` (coercions `singleUse`).
     - Validate `projectId` matches `/^project_[0-9A-HJKMNP-TV-Z]{26}$/`; throw
       `Diagnostic("cli.scheduler.queue.list.invalid_project_id", "...")`.
     - `requireToken(opts.token, "cli.scheduler.queue.list.token_required")`.
     - Validate pagination; default limit 100.
     - Call `httpClient(schedulerOperations, endpoint, token)["queueList"]({ params: { projectId }, query: { limit, cursor }, body: null })`.
     - `handleReadResult(result, "cli.scheduler.queue.list.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  5. Add leaf `queue peek <project-id>`:
     - Validate `projectId`; throw
       `Diagnostic("cli.scheduler.queue.peek.invalid_project_id", "...")`.
     - `requireToken(opts.token, "cli.scheduler.queue.peek.token_required")`.
     - Call client `["queuePeek"]({ params: { projectId }, query: {}, body: null })`.
     - `handleReadResult(result, "cli.scheduler.queue.peek.indeterminate")` → data.
     - Print `JSON.stringify(data)`.
  6. In `src/apps/cli/constants.ts`: add `Scheduler = "scheduler"` to `CommandName`.
  7. In `src/apps/cli/index.ts`: import `addSchedulerCommand`; replace the
     `CommandName.Scheduler` help-only stub with a call to `addSchedulerCommand(program)`.
  8. Write `src/apps/server/cli-scheduler.test.ts`.
- Rules:
  - Operation keys are `"queueList"` and `"queuePeek"` (camelCase, Plan 02).
  - Both commands define no `--idempotency-key`.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - Test: `scheduler queue list --help` exits 0; stdout matches `<project-id>`.
  - Test: `scheduler queue peek --help` exits 0.
  - Test: `scheduler queue peek` with no positional exits nonzero (Commander parse error).
  - Test: `scheduler queue list --endpoint http://localhost:31415 --token t badid` exits nonzero; stderr matches `cli.scheduler.queue.list.invalid_project_id`.
  - Test subprocess against live server: `scheduler queue list --token <tok> <projectId>` exits 0; stdout is JSON with `jobs` array.
  - Test: `scheduler queue peek --token <tok> <projectId>` exits 0; stdout is JSON with `job` or null.

### 08.14 Complete dispatcher

- Files: `src/apps/cli/index.ts` (edit)
- Do:
  1. Plan 07 task 07.6 already adds imports for `custodyOperations`, `schedulerOperations`,
     `projectOperations` and `missionOperations` in `src/apps/cli/index.ts`. Verify those
     imports are present. Do not duplicate them.
  2. Plan 07 task 07.6 already expands the spread at line 298 to include all six operation
     sets. Do not modify it.
  3. Add an operation ID uniqueness assertion that checks across all six contracts:
     ```ts
     const allOperationIds = [
       ...Object.values(gatewayOperations).map((op) => op.id),
       ...Object.values(workerOperations).map((op) => op.id),
       ...Object.values(custodyOperations).map((op) => op.id),
       ...Object.values(projectOperations).map((op) => op.id),
       ...Object.values(missionOperations).map((op) => op.id),
       ...Object.values(schedulerOperations).map((op) => op.id),
     ];
     assert.equal(
       new Set(allOperationIds).size,
       allOperationIds.length,
       "operation ID collision",
     );
     ```
  4. In the existing help-only loop at `src/apps/cli/index.ts:164`, remove
     `CommandName.Project`, `CommandName.Mission` and `CommandName.Scheduler`,
     because their real groups are now registered. Keep `CommandName.Tracking`
     and its help-only entry unchanged: it predates ERD 1, and Plan 08 adds no
     group (D12) and removes no existing one.
  5. Verify the count assertion
     `assert.equal(names.length, Object.keys(CommandName).length)` still passes
     after removing `Tracking`/`Intake`.
- Rules:
  - No `generate:openapi` step (D13; Plan 07 owns it).
  - No Tracking or Intake stub (D12).
  - The ID uniqueness assertion checks globally unique operation IDs, not client
    keys. Client keys are per-service scoped; IDs are globally unique.
  - No code comments.
- Done when:
  - `pnpm run verify` is green.
  - `kanthord --help` output includes `credential`, `project`, `mission`, `scheduler`.
  - `kanthord credential --help` exits 0 and shows 9 leaves.
  - `kanthord project --help` exits 0 and shows `create`, `list`, `get`, `rename`,
    `binding`, `agent`.
  - `kanthord scheduler queue --help` exits 0 and shows `list` and `peek`.
  - Operation ID uniqueness assertion passes at startup.

## Blockers

- **B1** - status:FIXED - action:YES - BindingSet export/apply schema compatibility - `project.bindingSet.get` answers exactly the `bindingSetWriteInputSchema` shape (Plan 05), so `binding export` output applies unchanged. - fix: none left. - why: `engine/docs/cli/project.md:232–236` rules the export shape.

- **B2** - status:FIXED - action:YES - OAuth login response fields - `credential.login` answers `address` always and `code` in device mode, because the handler awaits the address before it answers (Plan 01). The CLI never polls: `login-status` "does not poll until completion" (`engine/docs/cli/credential.md:239`). - fix: `login` prints `sessionId`, `address`, `code`, `expiresAt` and the key, one per line; a `null` code prints an empty line, so each value keeps its line position. - why: `engine/docs/cli/credential.md:210–212` rules the line output.

- **B3** - status:FIXED - action:YES - Commander `node retire` sub-tree conflict -
  `node retire preview <node-id>` (task 08.7) and `node retire <node-id>` (task
  08.10) share the `node retire` prefix. Commander routes to a subcommand when the
  first argument matches a registered subcommand name. Because `preview` is a
  valid first argument to `node retire`, users who type `node retire preview ...`
  reach the preview command, not the retire-with-arg form. Users who type
  `node retire <node-id>` reach the leaf command. No valid node ID starts with
  the string `"preview"`: every node identity has the form `node_<ulid>` where
  `<ulid>` is a 26-character Crockford base-32 string; none can equal `"preview"`.
  Task 08.10 implements both leaves as siblings; the visual asymmetry in help
  output is acknowledged and acceptable. - fix: No code change required; sibling-leaf
  layout in task 08.10 is the resolved design. - why: Runtime routing is
  unambiguous; no ULID matches the string `"preview"`.

# Story 03 — The schema inventory

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 02 (`src/domain/identity.ts`), Story 04 (`src/domain/worker.ts`, `src/domain/agent.ts`).

Scope: the value schemas, and 18 of the 19 persisted row schemas. `profile` is Story 05.

## Change

### 1. `src/domain/column.ts` (new) — the column primitives

```ts
import { z } from "zod";

export const epochMillis = z.int();
export const bytes = z.instanceof(Uint8Array);
export const jsonText = z.string();
export const objectId = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
```

`objectId` is `docs/proposal/database/README.md:43`. `jsonText` is the unparsed document text of a `_json` column.

### 2. `src/domain/state.ts` (new) — the state value schemas

```ts
import { z } from "zod";

export const nodeKinds = ["initiative", "objective", "task"] as const;
export const nodeKind = z.enum(nodeKinds);
export type NodeKind = z.infer<typeof nodeKind>;

export const nodeStates = [
  "pending",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;
export const nodeState = z.enum(nodeStates);
export type NodeState = z.infer<typeof nodeState>;

export const terminalStates = ["done", "partial", "discarded"] as const;
export type TerminalState = (typeof terminalStates)[number];

export const blockReasons = [
  "attempt-limit",
  "dependency-discarded",
  "stale-base",
  "dirty-recovery",
  "e2e-failed",
  "abandoned",
] as const;
export const blockReason = z.enum(blockReasons);
export type BlockReason = z.infer<typeof blockReason>;
```

Members and order are the `CHECK` clauses of `docs/proposal/database/node.md:21-30`, which match `docs/proposal/phase-1/state-machine.md:9-23`.

### 3. `src/domain/blob.ts` (new) — the blob reference and the `blob` row

```ts
export const blobHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const blobRow = z.object({
  hash: blobHash,
  size: z.int(),
  content: bytes,
  createdAt: epochMillis,
});
export type BlobRow = z.infer<typeof blobRow>;
```

`blobHash` is `docs/proposal/database/blob.md:14`: the algorithm name, a colon, and the lowercase hex sha256. Every `*_blob` column carries this form.

### 4. The 17 remaining row files (new)

One file per table, named after the table in kebab case, each exporting `<table>Row` (lowerCamel) and `type <Table>Row` (Pascal) via `z.infer`:

`src/domain/repository.ts`, `project.ts`, `project-binding.ts`, `provider.ts`, `node.ts`, `edge.ts`, `plan-revision.ts`, `workspace.ts`, `lease.ts`, `run.ts`, `attempt.ts`, `agent-invocation.ts`, `candidate.ts`, `check-result.ts`, `git-operation.ts`, `event.ts`, `migration.ts`.

**Column mapping, applied with no exception.** A snake_case column becomes a lowerCamelCase key. The schema comes from this table:

| DDL form                                             | schema                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `TEXT` primary key that mints an identity            | `identity("<kind>")`                                         |
| `TEXT` foreign key to a table that mints an identity | `identity("<kind>")` of the target table                     |
| a `TEXT` polymorphic id with a companion kind column | `anyIdentity`                                                |
| a column named `*_blob`, and `blob.hash`             | `blobHash`                                                   |
| a column named `*_oid`                               | `objectId`                                                   |
| a column named `*_json`                              | `jsonText`                                                   |
| `TEXT` with an enumerated `CHECK`                    | `z.enum([...])`, members and order verbatim from the `CHECK` |
| any other `TEXT`                                     | `z.string()`                                                 |
| `INTEGER` naming a time (`*_at`)                     | `epochMillis`                                                |
| any other `INTEGER`                                  | `z.int()`                                                    |
| `BLOB`                                               | `bytes`                                                      |
| a nullable column                                    | the schema above, then `.nullable()`                         |

A multi-column `CHECK` becomes one `.refine(predicate, { message })` chained on the `z.object`, with `message` equal to the `CHECK` expression collapsed to a single line with single spaces. Chain one `.refine` per `CHECK`.

The exact object bodies:

**`repository.ts`** — `id: identity("repository")`, `name: z.string()`, `remoteUrl: z.string()`, `credentialId: identity("provider")`, `homePath: z.string()`, `upstreamBranch: z.string()`, `landingBranch: z.string()`, `publishRef: z.string()`, `publishOnApproval: z.int()`, `state: z.enum(["ready", "needs-reconcile"])`, `divergedLandingOid: objectId.nullable()`, `divergedUpstreamOid: objectId.nullable()`, `fetchedUpstreamOid: objectId.nullable()`, `updatedAt: epochMillis`.
Refine: `(row.state === "needs-reconcile") === (row.divergedLandingOid !== null && row.divergedUpstreamOid !== null)`.

**`project.ts`** — `id: identity("project")`, `name: z.string()`, `worker: workerKind.nullable()`, `e2eJson: jsonText.nullable()`, `updatedAt: epochMillis`. No refine.

**`project-binding.ts`** — `projectId: identity("project")`, `kind: z.enum(["git", "provider"])`, `targetId: anyIdentity`, `createdAt: epochMillis`. No refine.

**`provider.ts`** — `id: identity("provider")`, `name: z.string()`, `kind: z.enum(["llm", "git"])`, `setDefaultAt: epochMillis.nullable()`, `payloadCiphertext: bytes`, `payloadIv: bytes.refine((value) => value.length === 12, { message: "length(payload_iv) = 12" })`, `payloadTag: bytes.refine((value) => value.length === 16, { message: "length(payload_tag) = 16" })`, `keyVersion: z.int()`, `updatedAt: epochMillis`. No object-level refine.

**`node.ts`** — `id: nodeIdentity`, `projectId: identity("project")`, `kind: nodeKind`, `parentId: nodeIdentity.nullable()`, `title: z.string()`, `instructionBlob: blobHash`, `acceptanceBlob: blobHash.nullable()`, `worker: workerKind.nullable()`, `repositoryId: identity("repository").nullable()`, `state: nodeState`, `blockReason: blockReason.nullable()`, `discardReason: z.string().nullable()`, `revision: identity("planRevision")`, `updatedAt: epochMillis`.
Six refines, in this order:

1. `(row.kind === "initiative") === (row.parentId === null)`
2. `(row.kind === "objective") === (row.repositoryId !== null)`
3. `(row.kind === "task") === (row.acceptanceBlob !== null)`
4. `(row.state === "blocked") === (row.blockReason !== null)`
5. `row.state !== "awaiting_approval" || row.kind === "objective"`
6. `row.state !== "partial" || row.kind !== "task"`
7. `parseIdentity(row.id)?.kind === row.kind`, message `"the id prefix names the node kind"`. This one has no `CHECK` counterpart — `docs/proposal/database/README.md:71` puts the rule in the prefix grammar instead, and the epic requires prefix-to-kind agreement. `node.ts` already imports `src/domain/identity.ts` for `nodeIdentity`.

**`edge.ts`** — `id: identity("edge")`, `fromNode: nodeIdentity`, `toNode: nodeIdentity`, `waivedAt: epochMillis.nullable()`.
Refine: `row.fromNode !== row.toNode`.

**`plan-revision.ts`** — `id: identity("planRevision")`, `projectId: identity("project")`, `parentId: identity("planRevision").nullable()`, `importId: z.string()`, `submittedBlob: blobHash`, `choicesBlob: blobHash`, `acceptedBlob: blobHash`. No refine.

**`workspace.ts`** — `id: identity("workspace")`, `nodeId: nodeIdentity`, `repositoryId: identity("repository")`, `path: z.string()`, `cloneBaseOid: objectId`, `upstreamOidAtClone: objectId`, `profileBlob: blobHash`, `conventionVersion: z.string()`, `ambientBlob: blobHash.nullable()`, `state: z.string()`, `updatedAt: epochMillis`. No refine — `docs/proposal/database/workspace.md` declares no `CHECK` on `state`, so the schema declares no enum.

**`lease.ts`** — `subjectKind: z.enum(["node", "repository"])`, `subjectId: anyIdentity`, `owner: z.string().nullable()`, `fence: z.int()`, `acquiredAt: epochMillis.nullable()`, `renewedAt: epochMillis.nullable()`, `expiresAt: epochMillis.nullable()`. No refine.

**`run.ts`** — `id: identity("run")`, `kind: z.enum(["objective", "task"])`, `nodeId: nodeIdentity`, `parentRunId: identity("run").nullable()`, `workspaceId: identity("workspace")`, `worker: workerKind`, `leaseFence: z.int()`, `attemptLimit: z.int()`, `baseOid: objectId`, `headOid: objectId.nullable()`, `state: z.enum(["active", "ended"])`, `outcome: z.string().nullable()`, `endedAt: epochMillis.nullable()`.
Refine: `(row.kind === "objective") === (row.parentRunId === null)`.
`outcome` carries no `CHECK` in `docs/proposal/database/run.md`, so it stays `z.string().nullable()`.

**`attempt.ts`** — `id: identity("attempt")`, `runId: identity("run")`, `attemptNo: z.int()`, `providerId: identity("provider")`, `providerModel: z.string()`, `timeoutMs: z.int()`, `baseOid: objectId`, `headOid: objectId.nullable()`, `outcome: attemptOutcome.nullable()`, `endedAt: epochMillis.nullable()`. No refine.
`attempt.ts` additionally exports the vocabulary, so Story 10 imports it rather than restating it:

```ts
export const attemptOutcomes = [
  "accepted",
  "rejected",
  "failed",
  "timed-out",
  "cancelled",
] as const;
export const attemptOutcome = z.enum(attemptOutcomes);
export type AttemptOutcome = z.infer<typeof attemptOutcome>;
```

**`agent-invocation.ts`** — `id: identity("agentInvocation")`, `attemptId: identity("attempt")`, `agent: agentKind`, `adapterVersion: z.string()`, `promptBlob: blobHash`, `sourcesJson: jsonText`, `toolDefinitionsBlob: blobHash`, `toolTraceBlob: blobHash.nullable()`, `diffBlob: blobHash.nullable()`, `verdict: z.enum(["accept", "reject"]).nullable()`, `reasonBlob: blobHash.nullable()`, `usageJson: jsonText.nullable()`, `errorBlob: blobHash.nullable()`, `endedAt: epochMillis.nullable()`. No refine.

**`candidate.ts`** — `id: identity("candidate")`, `nodeId: nodeIdentity`, `runId: identity("run")`, `workspaceId: identity("workspace")`, `revision: z.string()`, `candidateOid: objectId`, `landingBaseOid: objectId`, `mergeOid: objectId.nullable()`, `projectedOutcome: z.enum(["done", "partial"])`, `evidenceBlob: blobHash`, `profileBlob: blobHash`, `conventionVersion: z.string()`, `state: z.enum(["open", "approved", "invalidated"])`, `acknowledgedPartial: z.int().nullable()`, `publishRequested: z.int().nullable()`, `approvedActor: z.string().nullable()`, `approvedAt: epochMillis.nullable()`, `invalidatedAt: epochMillis.nullable()`, `invalidatedReason: z.string().nullable()`, `updatedAt: epochMillis`.
Refine: `row.state !== "approved" || row.projectedOutcome === "done" || row.acknowledgedPartial === 1`.
`revision` is a freeze label, **not** a `plan_revision` identity — `docs/proposal/database/candidate.md:46` shows `cand-4`. It stays `z.string()`.

**`check-result.ts`** — `id: identity("checkResult")`, `subjectKind: z.enum(["candidate", "merge", "task-diagnostic", "reconcile", "profile-gate", "initiative-e2e"])`, `subjectId: anyIdentity.nullable()`, `nodeId: nodeIdentity.nullable()`, `runId: identity("run").nullable()`, `commitOid: objectId.nullable()`, `manifestBlob: blobHash.nullable()`, `checkName: z.string()`, `commandJson: jsonText`, `cwd: z.string()`, `envIdentity: z.string()`, `toolchainVersion: z.string()`, `timeoutMs: z.int()`, `authoritative: z.int()`, `result: z.enum(["running", "passed", "failed", "error", "timed-out", "cancelled", "not-applicable"])`, `exitCode: z.int().nullable()`, `outputBlob: blobHash.nullable()`, `profileBlob: blobHash.nullable()`, `conventionVersion: z.string()`, `invalidatedAt: epochMillis.nullable()`, `endedAt: epochMillis.nullable()`.
Refine: `row.result === "not-applicable" || row.commitOid !== null || row.manifestBlob !== null`.

**`git-operation.ts`** — `id: identity("gitOperation")`, `repositoryId: identity("repository")`, `intent: z.enum(["merge", "sync", "publish", "revert"])`, `nodeId: nodeIdentity.nullable()`, `runId: identity("run").nullable()`, `candidateId: identity("candidate").nullable()`, `leaseFence: z.int()`, `ref: z.string()`, `baseOid: objectId`, `proposedHeadOid: objectId`, `resultHeadOid: objectId.nullable()`, `expectedRemoteOid: objectId.nullable()`, `state: z.enum(["open", "complete", "discarded"])`, `outcome: z.string().nullable()`, `detailBlob: blobHash.nullable()`, `completedAt: epochMillis.nullable()`. No refine.

**`event.ts`** — `id: identity("event")`, `subjectKind: z.string()`, `subjectId: anyIdentity`, `type: z.string()`, `actorKind: z.enum(["human", "daemon"])`, `actorId: z.string()`, `payloadJson: jsonText`. No refine. `subjectKind` and `type` carry no `CHECK` in `docs/proposal/database/event.md`, so neither is an enum.

**`migration.ts`** — `version: z.int()`, `name: z.string()`, `appliedAt: epochMillis`. No refine. This is the one table with no identity.

### 5. `src/domain/rows.ts` (new) — the inventory

```ts
export const rows = {
  agent_invocation: agentInvocationRow,
  attempt: attemptRow,
  blob: blobRow,
  candidate: candidateRow,
  check_result: checkResultRow,
  edge: edgeRow,
  event: eventRow,
  git_operation: gitOperationRow,
  lease: leaseRow,
  migration: migrationRow,
  node: nodeRow,
  plan_revision: planRevisionRow,
  project: projectRow,
  project_binding: projectBindingRow,
  provider: providerRow,
  repository: repositoryRow,
  run: runRow,
  workspace: workspaceRow,
} as const;

export type TableName = keyof typeof rows;
```

Keys are the SQL table names, sorted lexicographically. Story 05 inserts `profile` between `plan_revision` and `project`.

## Constraints

- Every row schema mirrors its DDL and nothing more. A `TEXT NOT NULL` column with no `CHECK` is `z.string()` — do not add `.min(1)`, a trim, or a format the DDL does not state.
- No schema is stricter than its column. `repository.publish_on_approval`, `candidate.acknowledged_partial`, `candidate.publish_requested` and `check_result.authoritative` are plain `INTEGER` with no `0`/`1` `CHECK`, so each is `z.int()`. A `0 | 1` union would reject a row SQLite accepts, and EPIC 003 reads real rows. The one exception is refinement 7 of `node.ts`, which the prefix grammar states in prose instead of a `CHECK`.
- Do not add a `created_at` key to a table that has none. `docs/proposal/database/README.md:38` puts creation time in the ULID.
- Every `z.object` is left open — no `.strict()`. EPIC 003 decides row-shape strictness when it reads real SQLite rows.
- `zod`, `./identity.ts`, `./column.ts`, `./state.ts`, `./blob.ts`, `./worker.ts` and `./agent.ts` are the only imports allowed in a row file.
- `lease.owner` is the daemon instance identity in prose, but no prefix for it appears in `docs/proposal/database/README.md:51-67`. It stays `z.string().nullable()`. The same rule keeps `plan_revision.import_id` and `event.actor_id` as `z.string()`.

## Verify

Fixed literals every test file uses, so two implementers produce the same fixture:

- `ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X"`, `ULID_B = "01HZY8QF3M4N5P6R7S8T9V0W2Y"`
- `HASH = "sha256:" + "0".repeat(64)`
- `OID = "a".repeat(40)`

`node --test src/domain/column.test.ts` — suite `"src/domain/column.test"`:

- `objectId` accepts `"a".repeat(40)` and `"a".repeat(64)`; rejects `"a".repeat(39)`, `"a".repeat(41)`, `"A".repeat(40)`, `""`.
- `epochMillis` accepts `0` and `1735689600000`; rejects `1.5` and `"0"`.
- `bytes` accepts `new Uint8Array(3)`; rejects `[0, 0, 0]` and `"abc"`.

`node --test src/domain/state.test.ts` — suite `"src/domain/state.test"`:

- `nodeStates` deep-equals the eight states in the order above; `nodeStates.length === 8`.
- `blockReasons` deep-equals the six reasons in the order above; `blockReasons.length === 6`.
- `nodeKinds` deep-equals `["initiative", "objective", "task"]`.
- `terminalStates` deep-equals `["done", "partial", "discarded"]`, and every member also appears in `nodeStates`.
- Read `docs/proposal/database/node.md` with `node:fs`; for every member of `nodeStates` and of `blockReasons`, assert the file contains `'<member>'` (the member wrapped in single quotes). A DDL edit then breaks this test.
- `nodeState.safeParse("awaiting-approval").success` is `false` — the state uses an underscore.

`node --test src/domain/blob.test.ts` — suite `"src/domain/blob.test"`:

- `blobHash` accepts `HASH`; rejects `"0".repeat(64)` (no algorithm prefix), `"sha256:" + "0".repeat(63)`, `"sha256:" + "A".repeat(64)`, `"sha1:" + "0".repeat(40)`.
- `blobRow` accepts `{ hash: HASH, size: 3, content: new Uint8Array(3), createdAt: 0 }`.
- `blobRow` rejects the same object with `hash` set to `"0".repeat(64)`.

One test file per row module, named after it (`src/domain/repository.test.ts`, …, `src/domain/migration.test.ts`), suite named after the test path. Each asserts:

1. A literal valid row parses, built from the fixed literals above.
2. Removing each required key in turn fails — a `for (const key of Object.keys(validRow))` loop that deletes one key from a shallow copy and asserts `safeParse(...).success === false`.
3. Every identity-typed key rejects an identity of the wrong kind. Example, `repository.test.ts`: `credentialId: "repo_" + ULID_A` fails.
4. Every enum key rejects one value outside its set and accepts every value inside it.

These files additionally assert their refinements:

- `repository.test.ts` — `{ state: "needs-reconcile", divergedLandingOid: null, divergedUpstreamOid: null }` fails; `{ state: "ready", divergedLandingOid: OID, divergedUpstreamOid: OID }` fails; `{ state: "needs-reconcile", divergedLandingOid: OID, divergedUpstreamOid: OID }` passes; `{ state: "ready", divergedLandingOid: null, divergedUpstreamOid: null }` passes.
- `node.test.ts` — one failing case and one passing case per refinement, six pairs:
  - an `initiative` with a non-null `parentId` fails; an `objective` with a null `parentId` fails.
  - an `objective` with a null `repositoryId` fails; a `task` with a non-null `repositoryId` fails.
  - a `task` with a null `acceptanceBlob` fails; an `objective` with a non-null `acceptanceBlob` fails.
  - `state: "blocked"` with `blockReason: null` fails; `state: "ready"` with `blockReason: "abandoned"` fails.
  - `kind: "task"`, `state: "awaiting_approval"` fails; `kind: "objective"`, `state: "awaiting_approval"` passes.
  - `kind: "task"`, `state: "partial"` fails; `kind: "objective"`, `state: "partial"` passes.
  - refinement 7: `{ id: "task_" + ULID_A, kind: "objective", … }` fails, and `{ id: "objective_" + ULID_A, kind: "objective", … }` passes. A loop over the three node kinds asserts that the two mismatched pairings fail and the matching one passes.
  - `id` accepts each of `initiative_`, `objective_` and `task_` and rejects `repo_`.
- `edge.test.ts` — `fromNode === toNode` fails; two different node ids pass.
- `provider.test.ts` — `payloadIv` of length 11 and of length 13 fail, length 12 passes; `payloadTag` of length 15 and 17 fail, length 16 passes.
- `run.test.ts` — `kind: "objective"` with a non-null `parentRunId` fails; `kind: "task"` with a null `parentRunId` fails; the two matching combinations pass.
- `candidate.test.ts` — `{ state: "approved", projectedOutcome: "partial", acknowledgedPartial: null }` fails; the same with `acknowledgedPartial: 1` passes; `{ state: "approved", projectedOutcome: "done", acknowledgedPartial: null }` passes; `{ state: "open", projectedOutcome: "partial", acknowledgedPartial: null }` passes.
- `check-result.test.ts` — `{ result: "failed", commitOid: null, manifestBlob: null }` fails; the same with `commitOid: OID` passes; with `manifestBlob: HASH` passes; `{ result: "not-applicable", commitOid: null, manifestBlob: null }` passes.
- `project.test.ts` and `run.test.ts` — `worker: "mr@1"` fails, `worker: "general@1"` passes.
- `agent-invocation.test.ts` — `agent: "tdd@1"` fails, each of the four agent kinds passes.
- `migration.test.ts` — `version: 1` passes; `version: "1"` fails; the row carries no `id` key.

`node --test src/domain/rows.test.ts` — suite `"src/domain/rows.test"`:

- `Object.keys(rows).length` equals `18`.
- `Object.keys(rows)` deep-equals the 18 table names sorted lexicographically, as a literal array in the test.
- `Object.keys(rows)` deep-equals `[...Object.keys(rows)].sort()` — the inventory stays sorted.
- Read `docs/proposal/phase-1/domain.md` with `node:fs`; for every key of `rows`, assert the file contains `` `\`${key}\`` `` — every schema names a table the proposal declares.

`npm run verify` exits 0.

Proof: contributes every `src/domain/*.test.ts` above to `node --test src/domain/**/*.test.ts`.

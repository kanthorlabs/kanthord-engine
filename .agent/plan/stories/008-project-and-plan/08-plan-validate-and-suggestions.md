# Story 08 — `plan.validate` and the suggestion engine

Epic: `.agent/plan/epics/008-project-and-plan.md`
Depends on: Stories 02, 02.5, 03-07, 10, 12. **Not** on Story 09: this story returns the local suggestion per node, and Story 09 adds the set-level repair on top of it. That keeps the two edges one-way.

`plan.validate` writes nothing and returns the suggestion set a client pre-selects. The table at `docs/proposal/phase-1/plan-format.md:98-114` is normative: a case absent from it is a defect rather than a judgment.

## Change

### 1. `src/domain/plan-choice.ts` (new — pure)

```ts
export const choices = ["submitted", "database"] as const;
export type Choice = (typeof choices)[number];

export type DifferingField =
  "title" | "body" | "depends_on" | "worker" | "repo" | "parent";

export const proseFields = ["body", "title"] as const;
export const structuralFields = [
  "depends_on",
  "parent",
  "repo",
  "worker",
] as const;

export type Presence = "both" | "document-only" | "database-only";

export type ChoiceFacts = Readonly<{
  presence: Presence;
  state: NodeState | null;
  fields: readonly DifferingField[];
  containmentMovable: boolean;
}>;

export type ChoiceLegality = Readonly<{
  legal: boolean;
  reason: string | null;
}>;

export type ChoiceVerdict = Readonly<{
  suggested: Choice;
  submitted: ChoiceLegality;
  database: ChoiceLegality;
}>;

export function choiceVerdict(facts: ChoiceFacts): ChoiceVerdict;
```

`fields` is bytewise sorted and de-duplicated. `state` is `null` exactly when `presence === "document-only"`.

`containmentMovable` is `true` when the node and every descendant hold no lease, no workspace, no attempt commit and no retained commit. It is read only when `fields` holds `parent` or `repo`. Story 10 computes it; this function consumes it.

The verdict, and nothing else:

| facts                                                           | `suggested`                                                                       | `submitted.legal`                                      | `database.legal`            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| `database-only`                                                 | `database`                                                                        | `false` — "a deletion is node.discard"                 | `true`                      |
| `document-only`                                                 | `submitted`                                                                       | `true`                                                 | `true` — "do not create it" |
| `both`, `fields` empty                                          | `database`                                                                        | `true` — "equivalent"                                  | `true`                      |
| `both`, prose only, any state                                   | `submitted` when `state` is `pending`, `blocked` or `ready`; otherwise `database` | `true`                                                 | `true`                      |
| `both`, any structural field, `state` is `pending` or `blocked` | `submitted` when `structuralLegal`; otherwise `database`                          | `structuralLegal`                                      | `true`                      |
| `both`, any structural field, any other state                   | `database`                                                                        | `false` — "a structural edit needs pending or blocked" | `true`                      |

where `structuralLegal` is `true` unless `fields` holds `parent` or `repo` and `containmentMovable` is `false`, in which case the reason is "the node or a descendant holds a lease, a workspace or a commit".

Two consequences the table encodes and a test pins:

- `database` is legal in every case. There is no case in which the daemon's own row cannot be kept.
- A node carrying both a prose and an illegal structural change falls whole to `database`, and the legal prose edit is lost with it (`plan-format.md:110,114`). That is why the verdict reports `fields`.

### 2. `src/domain/plan-diff.ts` (new — pure)

`StoredNode` is Story 02.5's, from `src/domain/plan-graph.ts`.

```ts
export function differingFields(
  stored: StoredNode,
  submitted: ResolvedDocument,
  blobs: Readonly<{ instruction: string; acceptance: string | null }>,
): readonly DifferingField[];
```

- `title` differs on a bytewise string inequality.
- `body` differs when the submitted `instruction` hashes to something other than `stored.instructionBlob`, or the submitted `acceptance` hashes to something other than `stored.acceptanceBlob`. The comparison is on the `sha256:` hash, computed by `BlobStore.put`'s own rule (`src/services/blob/sqlite.ts:25`) — so `differingFields` takes the two hashes rather than the two texts, and the caller computes them. Comparing hashes is what makes a body diff independent of blob size.
- `depends_on` differs when the two bytewise-sorted, de-duplicated identity arrays are unequal.
- `worker` and `repo` differ on a strict inequality with `null` treated as a value.
- `parent` differs when `submitted.parentIdentity !== stored.parentId`. A path that moves without changing the derived parent produces no `parent` difference, which is `plan-format.md:123`'s cosmetic rule made mechanical.

### 3. `src/domain/plan-hash.ts` (new — pure)

```ts
export function canonicalDocumentsJson(
  documents: readonly RenderedDocument[],
): string;

export function canonicalChoicesJson(
  choices: readonly Readonly<{ id: string; take: Choice }>[],
): string;
```

`canonicalDocumentsJson` sorts by `comparePaths` on `path` and emits `JSON.stringify(sorted.map(({ path, content }) => ({ path, content })))`. The key order inside each entry is `path` then `content`, built as a fresh literal so a request body's insertion order cannot leak in.

`canonicalChoicesJson` sorts the choices by `comparePaths` on `id` and emits `JSON.stringify(sorted.map(({ id, take }) => ({ id, take })))`. It carries the choice set and nothing else, which is what `docs/proposal/database/plan_revision.md:26` says `choices_blob` holds.

These two strings are two of the four inputs of Story 11's idempotency fingerprint, and they are two of the three blobs it stores. The other two fingerprint inputs, `fromRevision` and `validatedRevision`, are both compared against `plan_revision.parent_id`, so no field of the request goes uncovered and no column is added. Hashing is `BlobStore`, so no hashing expression is added anywhere.

### 4. `src/queries/plan/validate-plan.ts` (new)

`plan.validate` writes nothing, so it is a query. `repository.inspect` is the precedent: a `POST` route served by `src/queries/repository/inspect-repository.ts`.

```ts
export type ValidatePlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  reader: DocumentReader;
  graph: Graph;
  ids: IdGenerator;
}>;

export type ValidatePlanInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  documents: readonly Readonly<{ path: string; content: string }>[];
}>;

export type ChoiceEntry = Readonly<{
  id: string;
  kind: NodeKind;
  presence: Presence;
  state: NodeState | null;
  suggested: Choice;
  fields: readonly DifferingField[];
  submitted: ChoiceLegality;
  database: ChoiceLegality;
}>;

export type ValidatePlanResult = Readonly<{
  findings: readonly Finding[];
  documents: readonly RenderedDocument[];
  documentsHash: string;
  revision: string | null;
  choices: readonly ChoiceEntry[];
}>;

export type ValidatePlanRefusal = "project-not-found";
```

The sequence, all inside one `storage.transact` because every read must observe one snapshot:

1. `SELECT id FROM project WHERE id = ?` — the one statement this query owns; absent is `project-not-found`.
2. `plan.readValidationContext(transaction, projectId)`.
3. `plan.newestRevision(transaction, projectId)` — `null` on an empty project. That is `result.revision`, the topology revision the validation ran against (`docs/proposal/api/graph.md:33`).
4. `plan.readGraph(transaction, projectId)`.
5. `validateDocuments({ readFrontmatter: (text) => reader.read(text), findCycles: (g) => graph.cycles(g), mint: (kind) => ids.mint(kind) }, …)` (Stories 05, 06).
6. The required choice set is the union of the resolved document identities and the stored node identities, bytewise ascending. One `ChoiceEntry` per member.
7. Per member, `differingFields` when it is on both sides, then `choiceVerdict`. `containmentMovable` comes from `plan.readContainmentFacts` for a task and `plan.readSubtreeContainmentFacts` for an objective or an initiative (Story 10).
8. `ChoiceEntry.suggested` is the **local** verdict of step 7. Story 09 replaces this step with the set-level repair; until it lands, `plan.validate` returns local suggestions and the tests below assert them.
9. `result.documents` is the **normalized** documents: `renderDocumentSet` over the resolved documents alone, at their canonical paths, with the minted identities in place and `depends_on` rewritten to identities. `documentsHash` is `blobs.hash(new TextEncoder().encode(canonicalDocumentsJson(result.documents)))`. That member is new — section 5 adds it, because this route must hash without inserting a row.

### 5. `src/services/blob/index.ts` — add `hash`

```ts
export interface BlobStore {
  put(transaction: Transaction, content: Uint8Array): string;
  get(hash: string, transaction?: Transaction): BlobRecord | null;
  hash(content: Uint8Array): string;
}
```

`hash` returns `sha256:<hex>` and touches no transaction. `src/services/blob/sqlite.ts:25` already computes exactly that expression; extract it into a method and have `put` call it. `plan.validate` writes nothing, so it needs the hash without the row, and duplicating the expression in a query would put a hashing rule in two places.

`src/services/blob/sqlite.test.ts` gains: `hash` equals the `put` return value for the same content; `hash` writes no row, asserted with `SELECT COUNT(*) FROM blob` before and after.

### 6. `src/http/contract/graph.ts` — two schemas

```ts
export const planDocument = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const planFinding = z.object({
  code: z.enum(findingCodes),
  path: z.string().nullable(),
  id: z.string().nullable(),
  message: z.string(),
});

export const planChoiceEntry = z.object({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(["both", "document-only", "database-only"]),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(
    z.enum(["body", "depends_on", "parent", "repo", "title", "worker"]),
  ),
  submitted: z.object({ legal: z.boolean(), reason: z.string().nullable() }),
  database: z.object({ legal: z.boolean(), reason: z.string().nullable() }),
});

export const planValidateRequest = z.object({
  fromRevision: z.string().nullable(),
  documents: z.array(planDocument).min(1),
});

export const planValidateResponse = z.object({
  findings: z.array(planFinding),
  documents: z.array(planDocument),
  documentsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  revision: z.string().nullable(),
  choices: z.array(planChoiceEntry),
});
```

`findingCodes`, `nodeKinds`, `nodeStates` and `choices` are imported from `src/domain/`, which `http/contract/` may do (`eslint.config.js:131-138`). The enums are therefore one source, and a new finding code cannot ship without appearing in the contract.

Attach both to `plan.validate` at `src/http/contract/graph.ts:6-16`.

### 7. `src/http/server/plan/validate-plan.ts` and `refusals.ts` (new)

Parses `planValidateRequest`, calls the one query, returns `{ status: 200, body: result }`. A `422` is **not** raised for a non-empty `findings` array: `plan.validate` reports and never refuses, which is what makes it usable as the pre-flight of the handshake. `project-not-found` maps to `not-found`.

### 8. `src/main.ts` — bind `plan.validate`

Wire `validatePlan({ storage, plan, blobs, reader, graph, ids }, input)`. `plan` is Story 02.5's `SqlitePlanStore`, `blobs` a new `SqliteBlobStore` beside `events` at `:141`, `reader` a new `YamlDocumentReader`, `graph` the `GraphologyGraph` of Story 02.

### 9. Contract test counts after this story

This story is dispatched after Story 12, so the counts step from Story 12's values.

- `registry.test.ts:78-99` — requests 6: `["plan.validate","project.create","project.repositories","provider.register","repository.inspect","repository.register"]`. Responses 16: Story 12's fifteen plus `plan.validate`, bytewise sorted.
- `openapi.test.ts:205-224` — 23 schema keys.
- `system.test.ts:173-196` — the same two lists; `withResponse.length` is 16.
- `system.test.ts:212-214` (`plan.import carries no request schema today`) stays green. Story 11 removes it.

## Constraints

- `plan.validate` writes no row. A test compares every table's row count before and after, including `blob`.
- The whole read runs in one `storage.transact`, so the revision, the nodes, the edges and the bindings are one snapshot.
- `suggested` is the local verdict in this story. Story 09 makes it the repaired verdict, and only then is the "a client that pre-selects it is never rejected" guarantee true.
- `database` legality is `true` in every entry. A test asserts it over every case in the suite.
- The choice set order is bytewise ascending by identity.
- No hashing expression exists outside `src/services/blob/sqlite.ts`.
- `src/queries/plan/validate-plan.ts` holds exactly one SQL statement, the project read. Every other read is a `PlanStore` member, so the same statements serve `plan.import`.
- `src/domain/plan-choice.ts`, `plan-diff.ts` and `plan-hash.ts` import only `domain/`.

## Verify

```
node --test src/domain/plan-choice.test.ts src/domain/plan-hash.test.ts \
  src/domain/plan-diff.test.ts src/queries/plan/validate-plan.test.ts \
  src/services/blob/sqlite.test.ts src/http/server/plan/validate-plan.test.ts \
  src/http/contract/registry.test.ts src/http/contract/openapi.test.ts \
  src/http/contract/system.test.ts
```

### `plan-choice.test.ts`

- **Every row of the normative table is one named case.** Eleven cases, each asserting the whole `ChoiceVerdict`, including both `reason` strings.
- The eight states are each exercised for a prose-only change and for a structural change: sixteen cases, asserting `suggested` and `submitted.legal`.
- `pending` and `blocked` with `fields: ["parent"]` and `containmentMovable: false` are illegal with the containment reason; with `true`, legal.
- `pending` with `fields: ["depends_on"]` and `containmentMovable: false` is **legal** — the containment facts are read only for `parent` and `repo`.
- A node with `fields: ["body","parent"]` at `running` is `database`, `submitted.legal === false`, and `fields` still reports both. This is the last-row cost.
- `database.legal` is `true` in every case, asserted in a loop over the case table.
- `fields` is returned sorted and de-duplicated.
- `discarded` with `fields: ["title"]` is `suggested: "database"` and `submitted.legal === true`. A prose edit on a discarded node is legal (`plan-format.md:112`).

### `plan-hash.test.ts`

- `canonicalDocumentsJson` on three documents submitted in reverse order equals the string for the forward order, byte for byte.
- The emitted JSON holds `path` before `content` even when the input literal holds them reversed.
- A document set differing only in one content byte produces a different string.
- `canonicalChoicesJson` sorts by id, is stable across two calls, and emits `id` before `take` even when the input literal holds them reversed.
- `canonicalChoicesJson`'s output holds neither `fromRevision` nor `validatedRevision`, asserted with `includes`. Those two are fingerprinted against `parent_id` in Story 11.
- Two choice sets differing in one `take` produce different strings.
- Both functions are pure: the input arrays are unchanged after the call.

### `plan-diff.test.ts`

- No difference returns `[]`.
- Each of the six fields is returned by one named case.
- A `depends_on` reordering returns `[]`.
- A `depends_on` duplicate returns `[]`.
- `worker` moving from `null` to `"tdd@1"` and back both return `["worker"]`.
- **A cosmetic path move returns `[]`.** A task whose submitted path changed but whose derived parent identity did not.
- A real parent move returns `["parent"]`.
- Two changes return two fields, sorted.

### `validate-plan.test.ts`

Real SQLite through `createMigratedStorage()`, `seedRegistry` plus `seedGraph` for the re-import cases, a mock id generator, the real `YamlDocumentReader`, `GraphologyGraph`, `SqliteBlobStore` and `SqlitePlanStore`.

- **A first validation of a valid plan on an empty project.** `findings` is `[]`, `revision` is `null`, every `ChoiceEntry` is `presence: "document-only"` with `suggested: "submitted"`, and `documents` are the canonical renderings.
- `documentsHash` equals `blobs.hash(new TextEncoder().encode(canonicalDocumentsJson(result.documents)))`, asserted against the value the test computes itself.
- **Nothing is written.** Row counts of `project`, `node`, `edge`, `plan_revision`, `blob` and `event` are equal before and after, for a valid plan and for an invalid one.
- **A re-import of the exported documents suggests `database` everywhere.** Seed `seedGraph`, export (Story 12), validate the exported documents, and assert every entry has `fields: []` and `suggested: "database"`.
- A prose edit to the `pending` task suggests `submitted` with `fields: ["body"]`.
- A structural edit to a node moved to `running` directly suggests `database` with `submitted.legal === false`.
- **A database-only node appears in the choice set.** Validating a submission that omits the seeded task returns an entry with `presence: "database-only"`, `suggested: "database"` and `submitted.legal === false`.
- **A kind change is an addition and a retention.** Submitting an objective document in place of the seeded task returns two entries: the new objective as `document-only`, and `task_a` as `database-only`. Both facts in one response (`plan-format.md:135`).
- `revision` equals the greatest `plan_revision.id` when two revisions exist, proved by inserting a second row whose id sorts above the first.
- An unknown project id throws `ValidatePlanError` with `refusal === "project-not-found"`.
- The choice set is bytewise ascending, and its size equals the union size.
- Determinism: the whole query is run twice with a fresh mock generator and the two results `deepEqual`.

### `validate-plan.test.ts` (handler)

- `POST /v1/project/:id/plan/validate` with a valid body answers `200` and `planValidateResponse` parses it.
- A body with an empty `documents` array answers `400`.
- A plan with three faults answers `200` with three findings — validate reports and never refuses.
- An unknown project answers `404`.
- Row counts before and after are equal for every request in the suite.

`npm run verify` exits 0.

Proof: contributes `src/queries/plan/validate-plan.test.ts`, `src/domain/plan-choice.test.ts`, `plan-diff.test.ts` and `plan-hash.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.

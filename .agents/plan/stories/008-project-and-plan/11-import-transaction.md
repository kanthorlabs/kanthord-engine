# Story 11 — the import transaction

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Stories 02.5, 08, 09, 10, 12.

One transaction: parse, validate, mint, resolve, compare, commit, respond (`docs/proposal/database/plan_revision.md:32`). A half-applied plan is a graph no human authored.

## Change

### 1. `src/commands/plan/import-plan.ts` (new)

```ts
export type ImportPlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  reader: DocumentReader;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
}>;

export type ImportPlanInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  importId: string;
  documents: readonly Readonly<{ path: string; content: string }>[];
  choices: readonly Readonly<{ id: string; take: Choice }>[];
  validatedRevision: string | null;
  documentsHash: string;
  actor: string;
}>;

export type ImportPlanResult = Readonly<{
  revision: string;
  documents: readonly RenderedDocument[];
  absent: readonly string[];
  retried: boolean;
}>;

export type ImportPlanRefusal =
  | "project-not-found"
  | "plan-invalid"
  | "choices-invalid"
  | "choices-stale"
  | "choices-changed"
  | "stale-revision"
  | "idempotency-mismatch"
  | "documents-hash-mismatch"
  | "choice-duplicate"
  | "choice-missing"
  | "choice-extra";

export class ImportPlanError extends Error {
  readonly refusal: ImportPlanRefusal;
  readonly details: unknown;
}

export function importPlan(
  dependencies: ImportPlanDependencies,
  input: ImportPlanInput,
): ImportPlanResult;
```

**Before the transaction**, one check, because it needs no snapshot: `assertChoiceSet`'s duplicate half (Story 10) — `choice-duplicate`.

**Nothing is minted and no clock is read before the refusals.** The revision id comes from `ids.mint("planRevision")` and the timestamp from one `clock.now()` call, both at the start of the write of step 11 — after every refusal has passed. A mint before the `importId` lookup would let a legitimate retry consume an identity, advance a mock clock or fail with `ids-exhausted` before discovering the import it is retrying, which contradicts "the lookup runs first". Every `node.updated_at` written by this import is that one clock value, so a revision has one timestamp.

**Inside one `storage.transact`**, in this exact order:

1. `SELECT id FROM project WHERE id = ?` → `project-not-found`. This is the one statement this command owns; every other read is a `PlanStore` member, so the same statements serve `plan.validate`.
2. **The `importId` lookup, first.** `plan.findByImportId(transaction, projectId, importId)`.

   A row exists → this is a retry. The fingerprint of `docs/proposal/api/graph.md:72` covers the documents, the choices, `fromRevision` and `validatedRevision`, and all four are comparable against the stored row with no schema change:

   - `blobs.hash(utf8(canonicalDocumentsJson(input.documents)))` against `submitted_blob`;
   - `blobs.hash(utf8(canonicalChoicesJson(input.choices)))` against `choices_blob`;
   - `input.fromRevision` against `parent_id`;
   - `input.validatedRevision` against `parent_id` as well. Steps 4 and 5 both compare against the same `newest`, so any committed import had `fromRevision === validatedRevision`. `parent_id` therefore records both, and `choices_blob` stays what `docs/proposal/database/plan_revision.md:26` says it is — the choice set and nothing else.

   All four equal → return `{ revision: row.id, documents: JSON.parse(utf8Decode(blobs.get(row.accepted_blob).content)), absent: [], retried: true }` and write nothing. Any differing → `idempotency-mismatch` with `details` naming which of the four differed.

   The lookup runs **before** the `fromRevision` comparison, so a genuine retry is never rejected as stale (`docs/proposal/api/graph.md:70`).

3. `plan.newestRevision(transaction, projectId)` — `null` on an empty project.
4. `input.fromRevision !== newest` → `stale-revision`, `details: { current: newest }`. `docs/proposal/api/graph.md:64`.
5. `input.validatedRevision !== newest` → `choices-stale`, `details` carrying a fresh conflict set: the required identity union and the current verdict per identity. `plan-format.md:142`.
6. `plan.readValidationContext` and `plan.readGraph`, then `validateDocuments` with the three adapter functions of Story 08 step 5 (Stories 05, 06). Any finding → `plan-invalid` with every finding in `details`.
7. `blobs.hash(utf8(canonicalDocumentsJson(rendered)))` over the normalized documents must equal `input.documentsHash` → otherwise `documents-hash-mismatch`, mapped to `400 invalid-request`. The submission binds to what the human saw (`docs/proposal/api/graph.md:54`).
8. `assertChoiceSet`'s missing and extra halves against the union → `choice-missing`, `choice-extra`.
9. **The legality recompute.** Per identity of the union, `differingFields`, then — only when the differing fields hold `parent` or `repo`, exactly the condition of Story 08:52 and Story 10:65 — `plan.readContainmentFacts` for a task or `plan.readSubtreeContainmentFacts` for an objective and an initiative, and `choiceVerdict` — against the **current** rows, not against what `plan.validate` saw. `choiceVerdict` is the one rule: the command holds no private copy of it, so a suggestion `plan.validate` returns can never be refused here for a reason `plan.validate` did not see. A selected `take` whose legality is `false` → `choices-changed`, `details` naming those identities and their reasons. A state change alone is not a rejection: `running` becoming `awaiting_approval` invalidates nothing when the choice was `database` (`plan-format.md:143`).
10. `buildCandidate` then `validateCandidate` (Story 09). Any finding → `choices-invalid` with the findings in `details`. Nothing is repaired here: `plan-format.md:129` — the daemon never repairs a choice by itself.
11. **The write**, in exactly these five steps. The order is forced by the foreign keys: `node.instruction_blob` references `blob(hash)`, `node.revision` references `plan_revision(id)`, and `edge.from_node` references `node(id)`.

    0. Mint the revision id and read the clock, once each.
    1. `blobs.put` every instruction and acceptance body of a `submitted` node, ascending by canonical path, **and the three revision documents**: `canonicalDocumentsJson(input.documents)`, `canonicalChoicesJson(input.choices)` and `canonicalDocumentsJson(accepted)`, each UTF-8 encoded. `plan_revision`'s three columns are `NOT NULL REFERENCES blob(hash)` (`migration-0002-graph-and-plan.ts:7`), so they carry the **hashes `put` returns**, never the JSON itself. Writing the revision row without inserting these three blobs first violates the foreign key.
    2. `plan.insertRevision` with `parent_id = input.fromRevision` and the three hashes step 1 returned.
    3. `plan.upsertNode` per candidate node, ascending by id. `NodeWrite` has no `state`, `block_reason` or `discard_reason` member and the statement's update list names none of the three (Story 02.5). A choice of `submitted` never writes a state (`plan-format.md:84`), and a prose edit does not clear `discard_reason`. A new node inserts with `state = 'pending'` and both reasons `null`, because import is one of the two writers of `pending` (`docs/proposal/phase-1/state-machine.md:19`).
    4. The edge set is written as a **diff**, never as a delete-and-reinsert. The stored edges come from the `plan.readGraph` of step 6. Then:
       - a stored pair absent from the candidate → `plan.deleteEdge(transaction, id)`;
       - a candidate pair absent from the store → `plan.insertEdge` with `id = ids.mint("edge")`, ascending by `(from_node, to_node)`;
       - a pair on both sides → no statement at all.

       An unchanged pair therefore keeps its `id` and its `waived_at`. `docs/proposal/api/outcome.md:39` has a human name an edge by its `edgeId`, so a re-import must not renumber an edge it did not touch, and a waiver is never cleared (`docs/proposal/database/edge.md:18`). A rewired dependency is a new row, which is what that line requires.

    5. One event per written node: `{ subjectKind: "node", subjectId: id, type: "node.imported", actorKind: "human", actorId: input.actor, payload: { revision, source } }`, plus one `{ subjectKind: "project", type: "plan.imported", payload: { revision, importId, nodes: <count>, absent } }`. Appended through `EventLog.append(transaction, …)` inside the same transaction.

12. `absent` is every stored node id that is not in the submission and took `database`. It is reported, never deleted (`docs/proposal/api/graph.md:82`).
13. `documents` is `renderDocumentSet` over the **whole resulting graph** — it holds database-only nodes that were never submitted and omits document-only nodes that took `database` (`docs/proposal/database/plan_revision.md:28`).

Every `PlanStore` member takes this transaction. `Transaction` is synchronous (`src/services/storage/index.ts:1-5`) and `sqlite.ts:37` refuses a nested one, so every step above is synchronous and no `await` appears inside the callback.

### 2. `src/http/contract/graph.ts` — the import schemas

```ts
export const planImportRequest = z.object({
  fromRevision: z.string().nullable(),
  importId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\x21-\x7E](?:[\x20-\x7E]{0,98}[\x21-\x7E])?$/),
  documents: z.array(planDocument).min(1),
  choices: z.array(z.object({ id: z.string().min(1), take: z.enum(choices) })),
  validatedRevision: z.string().nullable(),
  documentsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const planImportResponse = z.object({
  revision: z.string(),
  documents: z.array(planDocument),
  absent: z.array(z.string()),
});
```

`retried` is **not** a response member. `docs/proposal/api/graph.md:70` says a retry returns the original revision and the original documents with `200`, and a client that could see the difference would be tempted to branch on it. The command returns it for the handler's log line only.

`importId` is a client-chosen string of one to a hundred **printable ASCII** characters, with no leading or trailing space. `plan_revision.import_id` is `TEXT NOT NULL` with `UNIQUE (project_id, import_id)` and no format constraint, and `src/domain/plan-revision.ts:10` declares `importId: z.string()` — the row schema stays unconstrained, because the database holds whatever was already written. The example in `docs/proposal/api/graph.md:44` is `import_01JQ8Z7G3H`, which is not a minted identity of this product, so no prefix is enforced.

The character set is not decoration. EPIC 010.6 requires a supplied `Idempotency-Key` on `plan.import` to **equal** `importId` (`docs/proposal/api/README.md`, "Every other `POST` takes `Idempotency-Key`"), and an HTTP field value is ASCII — RFC 9110 deprecates `obs-text`. A free-form `importId` of `café` would therefore be legal in the body and unsendable in the header, so the keyed path would be closed to it for no reason a client could discover. The edge-space rule follows from the same place: HTTP strips the optional whitespace around a field value, so an `importId` of `" a"` could never survive as a header and would silently become a different key.

The regex bound is `98` interior characters rather than `253`, because `.max(100)` already caps the whole value; the header grammar in `src/http/server/idempotency-key.ts` allows 255 and is therefore never the refusing side.

### 3. `src/http/server/plan/import-plan.ts` and `refusals.ts`

The refusal map:

| refusal                                                | `httpError`                                            |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `project-not-found`                                    | `not-found`                                            |
| `plan-invalid`                                         | `plan-invalid`, `details.findings`                     |
| `choices-invalid`                                      | `choices-invalid`, `details.findings`                  |
| `choices-stale`                                        | `choices-stale`, `details` = the fresh conflict set    |
| `choices-changed`                                      | `choices-changed`, `details` = the illegal selections  |
| `stale-revision`                                       | `stale-revision`, `details.current`                    |
| `idempotency-mismatch`                                 | `idempotency-mismatch`, `details.differed`             |
| `documents-hash-mismatch`                              | `invalid-request`, `details.refusal`                   |
| `choice-duplicate` / `choice-missing` / `choice-extra` | `invalid-request`, `details.refusal` and `details.ids` |

Every `409` code takes a mandatory `details` argument (`src/http/contract/errors.ts:59-75`), and all five used here are already declared: `stale-revision`, `idempotency-mismatch`, `choices-stale`, `choices-changed` at `errors.ts:8,14,15,16`, and the two `422` codes at `:18,19`. **This story adds no error code**, so `errors.test.ts:25-49`, `:51-85` and the count of twenty-one are unchanged.

### 4. `src/main.ts` — bind `plan.import`

`importPlan({ storage, plan, blobs, reader, graph, ids, clock, events }, input)` with `actor: settings.actor`.

### 5. Contract test counts after this story

- `registry.test.ts:78-99` — requests 7: `["plan.import","plan.validate","project.create","project.repositories","provider.register","repository.inspect","repository.register"]`. Responses 17: Story 08's sixteen plus `plan.import`.
- `openapi.test.ts:205-224` — 25 schema keys.
- `system.test.ts:173-196` — the two lists; `withResponse.length` is 17.
- **`system.test.ts:212-214` is deleted.** `it("plan.import carries no request schema today")` asserts `findOperation("plan.import")?.request === undefined`, which this story falsifies. Delete the whole `it` block; the request list at `:173-196` is the assertion that replaces it.

## Constraints

- One transaction. Every read and every write of the import is inside it and every `PlanStore` call receives it, and the `fromRevision` comparison is inside it (`docs/proposal/database/plan_revision.md:20`).
- The `importId` lookup is the first thing after the project read, and **nothing is minted and no clock is read before it**.
- The three revision columns carry blob hashes. Every one of the three blobs is `put` before the revision row is inserted.
- `choices_blob` holds the canonical choice set alone. `validatedRevision` is compared against `parent_id`.
- `state`, `block_reason` and `discard_reason` are never written by an update. A test reads the module source and asserts the `UPDATE SET` list names none of the three.
- Every refusal writes nothing. Every refusal test compares the full row set of `node`, `edge`, `plan_revision`, `blob` and `event` before and after.
- One `clock.now()` call per import.
- A waiver survives a re-import that rewires the same pair.
- `absent` is reported and nothing is deleted.

## Verify

```
node --test src/commands/plan/import-plan.test.ts \
  src/http/server/plan/import-plan.test.ts \
  src/http/contract/registry.test.ts src/http/contract/openapi.test.ts \
  src/http/contract/system.test.ts src/http/contract/errors.test.ts
```

Real SQLite through `createMigratedStorage()`, `seedRegistry` for the project and the bound repository, a mock id generator with a named ULID list, `createMockClock({ start: 1700000000000, step: 1000 })`, the real blob store, reader and graph, and a recording event fake.

A helper in the test file, `snapshot(storage)`, returns the full row set of `node`, `edge`, `plan_revision`, `blob` and `event` ordered by primary key. Every refusal case asserts `deepEqual(before, after)`.

### The round trip

- **A two-objective plan imports.** One initiative, two objectives, three tasks. `revision` is the minted id, `documents` holds six entries at canonical paths, `absent` is `[]`. Every `node` row is asserted field by field, including `state === "pending"`, `revision` equal to the new revision, and `updated_at === 1700000000000` on all six.
- **Export is byte-identical.** `exportPlan` (Story 12) at that revision returns documents `deepEqual` to `result.documents`, and the `accepted_blob` content equals `canonicalDocumentsJson(result.documents)` byte for byte.
- **A re-import at the same revision succeeds.** Submit the accepted documents with `fromRevision = revision`, every choice `database`, a new `importId`: it commits a second revision whose `parent_id` is the first, and `node.updated_at` moves to the second clock value.
- **A re-import at the previous revision is refused by name.** The same submission with `fromRevision = null` throws `stale-revision` and `details.current` is the newest revision. The snapshot is unchanged.

### `importId` grammar

Assert against `planImportRequest.safeParse`, in the `src/http/contract/graph.test.ts` suite that
covers the other schemas of this story.

- Accepted: `import_01JQ8Z7G3H`, `a`, `release candidate`, `"a".repeat(100)`, `!~`.
- Refused: `""`, `"a".repeat(101)`, `" ab"`, `"ab "`, `" "`, `"a\tb"`, `"café"`, `"a\nb"`.

An interior space is legal and an edge space is not, because HTTP strips the whitespace around a
field value. Non-ASCII is refused because EPIC 010.6 requires `Idempotency-Key` to equal this value
and an HTTP field value is ASCII. Dropping either row reopens the case where a legal `importId`
cannot be sent as a header.

### Idempotency

- **A retry returns the original revision.** The first import repeated with the same `importId`, documents and choices returns `retried: true`, the same `revision`, and documents `deepEqual` to the first. `SELECT COUNT(*) FROM plan_revision` is `1`.
- **A reordered document array is still a retry.** The same retry with `documents` reversed returns the same revision. This is the reason the fingerprint sorts by path first.
- A retry with the choices reordered is still a retry.
- **A different choice set under the same id is `idempotency-mismatch`.** `details.differed` names `choices`.
- A different document content under the same id is `idempotency-mismatch` naming `documents`.
- A different `validatedRevision` under the same id is `idempotency-mismatch` naming `validatedRevision`, from the comparison against `parent_id`.
- A different `fromRevision` under the same id is `idempotency-mismatch` naming `fromRevision`.
- **A retry mints nothing.** The mock id generator is constructed with exactly the ULIDs the first import consumes, so a retry that minted a revision id would throw `ids-exhausted`. Assert the retry returns normally and that the mock's remaining list is unchanged. Assert the same for a `stale-revision`: it leaves the generator and the mock clock untouched.

  The rule is the one of section 2 — nothing is minted and no clock is read **before the `importId` lookup** — and it covers the retry and every refusal that precedes validation. It does not extend to `plan-invalid` or `choices-changed`, and it cannot: a document with no `id` is given its identity by step 6, and step 7 hashes the rendered documents **with that identity in them**. A provisional identity is therefore an input to `documentsHash`, so it has to exist before step 7 runs, and `choices-changed` is raised at step 9. Requiring those two refusals to mint nothing would mean `documentsHash` could no longer bind the client to the exact bytes it saw. The wasted identities are the accepted cost; a ULID space is unbounded.

- **The three revision blobs exist.** After a successful import, `blob` holds a row for each of `submitted_blob`, `choices_blob` and `accepted_blob`, and `blobs.get(choices_blob)` decodes to `canonicalChoicesJson(input.choices)` byte for byte — with no `fromRevision` and no `validatedRevision` key in it.
- The same `importId` on a **different project** is not a retry: both commit.
- Every mismatch leaves the snapshot unchanged.

### The choice set

- A missing choice, an extra choice and a duplicate choice each throw the matching refusal, and each leaves the snapshot unchanged. This is the EPIC's `400` coverage line; the handler test asserts the status.

### Structural and prose edits, per state

- **`submitted` on a structural edit is refused at `ready`, `running`, `awaiting_approval`, `done`, `partial` and `discarded`.** Six cases: seed one node, move it to the state with a direct `UPDATE`, submit a `depends_on` change with `take: "submitted"`, and assert `choices-changed` with the node named in `details`. `partial` is set on an objective and `awaiting_approval` on an objective, because the `node` CHECK clauses forbid both on a task (`migration-0002-graph-and-plan.ts:17`).
- **It is accepted at `pending` and `blocked`.** Two cases commit, and the new `depends_on` is readable in `edge`. A `blocked` node keeps its `block_reason` after the import — asserted, because a structural edit must not clear it.
- **A prose edit is accepted at every state, `discarded` included.** Eight cases, each committing a new `title`, each asserting the node's `state` is unchanged. The `discarded` case additionally asserts `discard_reason` is byte-identical before and after. This is the EPIC's discard-reason coverage line.
- A `depends_on` edit on a `pending` task holding a workspace is **accepted** and the new edge commits. Containment gates a `parent` move and a `repo` change only, per Story 08:52 and Story 10:65. A workspace does not make an edge change unsafe.
- An objective whose descendant task holds an attempt commit cannot change `repo`: `choices-changed` with the containment reason.

### The cycle

- **`choices-invalid`, and never a silent repair.** Seed `B → A`; submit documents holding `A → B` and no `B → A`; choose `submitted` for `A` and `database` for `B`. The refusal is `choices-invalid` with one `dependency-cycle` finding, the snapshot is unchanged, and `validatePlan` over the same input returns a suggestion set in which those two are not that combination (asserted here as well as in Story 09, because the EPIC requires both halves in one place).

### The repository binding

- **An objective naming a repository that is not bound to its project is refused.** `repo_b` exists and is not bound: the import throws `plan-invalid` with one `repository-unbound` finding, and the snapshot is unchanged. This proves the binding of Story 01 through import.

### The rest

- `documentsHash` altered by one character throws `documents-hash-mismatch`.
- A `validatedRevision` naming an older revision throws `choices-stale`, and `details` carries the fresh union.
- **A waiver survives.** Import, waive an edge with a direct `UPDATE edge SET waived_at = 1`, re-import the same documents: the row for that pair still carries `waived_at = 1` and its `id` is unchanged where the pair is unchanged.
- **`absent` is reported and nothing is deleted.** A submission omitting one seeded task with `database` for it returns that id in `absent`, and the `node` row survives.
- A document-only node taking `database` is not inserted.
- **Determinism.** The whole import is run twice against two fresh databases with the same mock ULID list, and the two `plan_revision` rows plus every `node` and `edge` row are `deepEqual`, including every id.
- **The bytewise submitted order.** A submission whose paths differ above ASCII — `plan/é--…/initiative.md` against `plan/z--…/initiative.md` — produces a `submitted_blob` whose content byte sequence puts `z` first, and the test asserts the opposite `localeCompare` sign for the same pair. This is the EPIC's bytewise-ordering coverage line on the one path a human authors.
- **No state in an update.** Read `src/commands/plan/import-plan.ts` and assert it contains no `UPDATE`, no `INSERT` and no `DELETE` at all. Every write is a `PlanStore`, `BlobStore` or `EventLog` member, and Story 02.5's test asserts the update list.
- **The right containment reader per kind.** A recording `PlanStore` wrapper asserts that a task's legality recompute called `readContainmentFacts` and an objective's called `readSubtreeContainmentFacts`, and that neither called the other.

### The handler test

- `POST /v1/project/:id/plan/import` with a valid body answers `200`, and `planImportResponse` parses it.
- Each of the eleven refusals answers its declared status and code, asserted as a table: `404`, `422 plan-invalid`, `422 choices-invalid`, `409 choices-stale`, `409 choices-changed`, `409 stale-revision`, `409 idempotency-mismatch`, and four `400 invalid-request` with distinct `details.refusal`.
- Every non-`200` request leaves the snapshot unchanged.
- A retry answers `200`, not `201` and not `409`.

`npm run verify` exits 0.

Proof: delivers `src/commands/plan/import-plan.test.ts` under the EPIC Proof glob. `PASS EPIC-008`.

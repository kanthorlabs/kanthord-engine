# Story 13 — the graph queries

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 02.5 (`PlanStore`).

`node.list`, `node.show` and `edge.list`. These are the routes a human reads state through, because a plan document carries none.

## Change

### 1. `src/queries/node/list-node.ts` (new)

```ts
export type NodeListItem = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  title: string;
  state: NodeState;
  blockReason: string | null;
  discardReason: string | null;
  parentId: string | null;
  dependencies: readonly string[];
}>;

export function listNodes(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<Record<string, never>>,
): readonly NodeListItem[];
```

`plan.readAllNodes(transaction)` inside one `storage.transact`, mapped to `NodeListItem` by a private `toNodeListItem`. The store already fills `dependencies` bytewise ascending and orders by `id ASC`.

**No filter.** `docs/proposal/api/graph.md`'s `node.list` section states it: phase 1 returns every node, ordered by identity, and takes no filter. `HandlerContext` is `{ operation, parameters, body }` (`src/http/server/app.ts:21-25`) and carries no query string, so no list route in this product can read one, and the five filter names stay on record for the phase that adds the mechanism. This is the rule EPIC 007 Story 11 applied to `repository.list`. See index item B3.

**It never holds the body prose.** `NodeListItem` has no blob member, so the mapper drops the two hashes `StoredNode` carries and a member cannot carry prose.

### 2. `src/queries/node/show-node.ts` (new)

```ts
export type NodeView = NodeListItem &
  Readonly<{
    instructionBlob: string;
    acceptanceBlob: string | null;
    worker: string | null;
    repositoryId: string | null;
    revision: string;
    updatedAt: number;
  }>;

export function showNode(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ id: string }>,
): NodeView | null;
```

`plan.readNode(transaction, input.id)`, mapped to `NodeView`. An absent row returns `null`.

The two blob members are **hashes**, per `docs/proposal/api/graph.md:104` and `docs/proposal/api/README.md:132-136`: a large payload travels as a hash and `blob.show` serves it. A task always carries `acceptanceBlob`, an initiative and an objective never do — the `node` CHECK at `migration-0002-graph-and-plan.ts:17` guarantees it, and a test asserts it through the query.

`worker` is the node-level binding. Project-level precedence is not resolved here: `docs/proposal/api/project.md:31` puts resolution at execution time, and a query that resolved it would report a value no row holds.

### 3. `src/queries/edge/list-edge.ts` (new)

```ts
export type EdgeView = Readonly<{
  id: string;
  fromNode: string;
  toNode: string;
  waivedAt: number | null;
}>;

export function listEdges(
  dependencies: Readonly<{ storage: Storage; plan: PlanStore }>,
  input: Readonly<{ projectId: string }>,
): readonly EdgeView[];

export type ListEdgeRefusal = "project-not-found";
```

The project read, then the `edges` half of `plan.readGraph`, returned directly. `EdgeView` is `StoredEdge`. `edge.list` is scoped by the path parameter, so it needs no query filter. A waiver is reported and never hidden: `docs/proposal/api/graph.md:112` — a response that returned only endpoint pairs could not show a waived edge at all. Containment is not an edge here; a node carries its parent.

An unknown project throws `project-not-found`, because `GET /v1/project/:id/edge` names a project and an empty array for a project that does not exist would be a lie.

### 4. `src/http/contract/graph.ts` — three response schemas

```ts
export const nodeListItem = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(nodeKinds),
  title: z.string(),
  state: z.enum(nodeStates),
  blockReason: z.enum(blockReasons).nullable(),
  discardReason: z.string().nullable(),
  parentId: z.string().nullable(),
  dependencies: z.array(z.string()),
});

export const nodeListResponse = z.object({ nodes: z.array(nodeListItem) });

export const nodeShowResponse = nodeListItem.extend({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
  worker: z.string().nullable(),
  repositoryId: z.string().nullable(),
  revision: z.string(),
  updatedAt: z.number(),
});

export const edgeView = z.object({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  waivedAt: z.number().nullable(),
});

export const edgeListResponse = z.object({ edges: z.array(edgeView) });
```

`blockReasons` is imported from `src/domain/state.ts:23-30`, which holds six values, and `docs/proposal/api/README.md:195` now names the same six. The `node` CHECK holds all six (`migration-0002-graph-and-plan.ts:17`), so a schema carrying five would refuse a row the database holds. See index item S3.

Attach them to `node.list` at `src/http/contract/graph.ts:54-59`, `node.show` at `:61-66` and `edge.list` at `:68-73`.

### 5. `src/http/server/node/` and `src/http/server/edge/` (new)

`list-node.ts`, `show-node.ts`, `list-edge.ts`, plus one `refusals.ts` under `edge/`. `show` throws `not-found` on a `null` result and on an absent parameter.

### 6. `src/main.ts` — bind the three handlers

The `handlers` literal reaches twenty entries. The `unimplemented` filter at `:190-193` needs no edit.

### 7. Contract test counts — the final values for this epic

- `src/http/contract/registry.test.ts:78-99` — the `request` list deep-equals

  ```
  plan.import
  plan.validate
  project.create
  project.repositories
  provider.register
  repository.inspect
  repository.register
  ```

  and the `response` list deep-equals

  ```
  edge.list
  node.list
  node.show
  plan.export
  plan.import
  plan.revisions
  plan.validate
  project.create
  project.list
  project.repositories
  project.show
  provider.list
  provider.register
  provider.show
  repository.inspect
  repository.list
  repository.register
  repository.show
  system.db
  system.health
  ```

  Seven requests and twenty responses, both bytewise sorted.

- `src/http/contract/openapi.test.ts:205-224` — `components.schemas` holds **28** keys: `Error`, the seven `<id>.request` keys and the twenty `<id>.response` keys, bytewise sorted. `Error` sorts first because `E` is `0x45`.
- `src/http/contract/system.test.ts:173-196` — the same two lists; `withResponse.length` is 20.
- Unchanged for the whole epic: `registry.test.ts:14-16` (53 entries), `:29-38` (23 routed / 30 stubbed), `:40-57`, `:59-76`, `:101-126`, `:185-197`; `parity.test.ts:12-22` and `:24-37`; `openapi.test.ts:74-80` (47 paths), `:82-110`, `:112-120` (53 ids), `:161-182`, `:184-203` (no entry sets `successStatus`), `:226-257`; `errors.test.ts` in full (21 codes); `path.test.ts:37-42` (13 / 13 / 15 / 3 segments); `app.test.ts:160-165` and `dispatch.test.ts:182-194` (21 unimplemented).

This epic adds no operation, no path segment, no error code and no `successStatus`.

## Constraints

- `node.list` reads no query parameter and returns every node of every project.
- No list or show query selects `instruction_blob` content. The blob members are hashes.
- `node.show` resolves no worker precedence.
- `edge.list` reports `waivedAt` and never filters on it.
- Every order is the store's: `id ASC` for a node, `(from_node, to_node)` for an edge.
- The three queries hold one statement between them, the project existence check of `edge.list`. Every other read is a `PlanStore` member.

## Verify

```
node --test src/queries/node/list-node.test.ts src/queries/node/show-node.test.ts \
  src/queries/edge/list-edge.test.ts src/http/server/node/list-node.test.ts \
  src/http/server/node/show-node.test.ts src/http/server/edge/list-edge.test.ts \
  src/http/contract/registry.test.ts src/http/contract/openapi.test.ts \
  src/http/contract/system.test.ts
```

Real SQLite through `createMigratedStorage()` with `seedRegistry` and `seedGraph`, plus direct writes, and the real `SqlitePlanStore`.

### `list-node.test.ts`

- The seeded graph returns three items ascending by id, each asserted field by field.
- `Object.keys(item)` bytewise sorted deep-equals the nine member names. A field-count assertion catches a member added without a schema.
- **No prose.** `JSON.stringify(items)` contains neither `instruction` nor `acceptance`, and `Object.hasOwn(item, "instructionBlob")` is `false`.
- Nodes of two projects are both returned, ascending by id across the two.
- `dependencies` is filled from `edge`, bytewise ascending, and a waived edge is included.
- A `blocked` node reports its `blockReason`; a `discarded` node reports its `discardReason`; a `pending` node reports both `null`.
- An empty table returns `[]`.
- Every item passes `nodeListItem.safeParse(...).success === true`.
- Read the three module sources and assert none contains the word `SELECT` other than in `list-edge.ts`'s project check.

### `show-node.test.ts`

- The seeded task returns all fifteen members, asserted field by field, with `acceptanceBlob` non-null.
- The seeded objective and initiative both return `acceptanceBlob === null`, and the objective returns `repositoryId === "repo_a"` while the task returns `null`.
- `revision` equals `fixtureIds.planRevision`.
- `updatedAt` is the seeded value, not a wall clock reading.
- An unknown but well-formed id returns `null`.
- The blob members match `/^sha256:[0-9a-f]{64}$/`, and neither carries content.
- `Object.keys(view)` bytewise sorted deep-equals the fifteen member names.
- `nodeShowResponse.safeParse` succeeds.

### `list-edge.test.ts`

- Two edges return ascending by `(from_node, to_node)`, with the insertion order reversed.
- A waived edge returns its `waivedAt` integer.
- An edge of another project is not returned.
- A project with no edge returns `[]`.
- An unknown project throws `project-not-found`.
- Every view passes `edgeView.safeParse`.

### The three handler tests

- `GET /v1/node` answers `200` with `{ nodes: [...] }`, and `nodeListResponse` parses it.
- `GET /v1/node/:id` answers `200` for the seeded task and `404` for an unknown id.
- `GET /v1/project/:id/edge` answers `200` with `{ edges: [...] }`; an unknown project answers `404`.
- `POST /v1/node/:id/discard` answers `501` with a message ending `"ships in phase-3"`, and `SELECT COUNT(*) FROM node` plus `SELECT COUNT(*) FROM event` are equal before and after. `POST /v1/node/:id/unblock` (phase-2), `POST /v1/node/:id/abandon` (phase-2) and `POST /v1/node/:id/waive` (phase-3) are asserted the same way, from `src/http/contract/outcome.ts:4-31`. This is the `AGENTS.md` rule for a `stubbed` route, asserted against database state, and it is what proves the three human controls of `docs/proposal/api/outcome.md` write nothing in this phase.
- No response body names a daemon path.

`npm run verify` exits 0.

Proof: contributes `src/queries/node/**/*.test.ts` and `src/queries/edge/**/*.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.

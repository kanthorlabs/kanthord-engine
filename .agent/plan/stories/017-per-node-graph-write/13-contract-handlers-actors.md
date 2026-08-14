# Story 13 — The contract rows, the handlers and the actors

Epic: `.agent/plan/epics/017-per-node-graph-write.md`
Depends on: Stories 1, 9, 10 and 11. Depends on EPIC 015 Story 7 (`allowedActors` on every row, and the named harness set in `src/http/contract/registry.test.ts`).

## Change

### `src/http/contract/path.ts`

- Add `"node"` to `subresourceSegments` at `src/http/contract/path.ts:19-34`, between `"landing-branch"` and `"plan"`. `edge` already sets the precedent at `graph.md:21`.
- Add `"delete"` and `"update"` to `actionSegments` at `:36-52`, in the existing alphabetical order: `"delete"` between `"cancel"` and `"discard"`, and `"update"` between `"unblock"` and `"validate"`.

### `src/http/contract/graph.ts` — the request schemas

Declare three request schemas and three response schemas above the `operations([...])` call at `:257`.

`nodeCreateRequest` and `nodeUpdateRequest` are each `z.discriminatedUnion("kind", [...])` over three `z.strictObject` members. The union is what makes `repo-on-task` and `repo-missing` unreachable at the validator: the schema answers both with `400 invalid-request`.

- initiative: `kind: z.literal("initiative")`, `title`, `instruction`, `worker: z.string().nullable()`, `dependsOn: z.array(z.string())`. **No `parentId` and no `repo`.**
- objective: `kind: z.literal("objective")`, `title`, `parentId: z.string().min(1)`, `repo: z.string().min(1)`, `instruction`, `worker`, `dependsOn`. **No `acceptance`.**
- task: `kind: z.literal("task")`, `title`, `parentId: z.string().min(1)`, `instruction`, `acceptance: z.string()`, `worker`, `dependsOn`. **No `repo`.**

Each of the two requests wraps the union with `fromRevision`. `nodeCreateRequest.fromRevision` is `z.string().nullable()`; `nodeUpdateRequest.fromRevision` is `z.string()`. `nodeDeleteRequest` is `z.strictObject({ fromRevision: z.string() })`.

Because every member is a `strictObject`, an omitted editable field on an update is `400 invalid-request` rather than a silent keep.

Responses:

```ts
export const nodeCreateResponse = z.strictObject({
  revision: z.string(),
  id: z.string(),
  completeness: z.array(planFinding),
});

export const nodeUpdateResponse = z.strictObject({
  revision: z.string(),
  completeness: z.array(planFinding),
});

export const nodeDeleteResponse = z.strictObject({
  revision: z.string(),
  deleted: z.array(z.string()),
  completeness: z.array(planFinding),
});
```

### `src/http/contract/error-details.ts`

Add two details schemas, in the shape of `staleRevisionDetails`:

- `illegalTransitionDetails` — `{ nodes: z.array(z.strictObject({ id: z.string(), state: z.enum(nodeStates) })) }`.
- `bindingInUseDetails` — `{ blockers: z.array(z.strictObject({ nodeId: z.string(), blocker: z.string() })) }`.

`staleRevisionDetails` gains `guard: z.enum(revisionGuardClasses)` beside its `expected` and `actual` members.

### `src/http/contract/graph.ts` — the three operations

Add three entries to `operations([...])`, after the `edge.list` entry. Each carries:

- `introducedIn: "phase-1"`, `status: "routed"`, `idempotency: "memory"`, `replayable: [200]`.
- `allowedActors: ["human", "harness"]`, because `013-external-drive-overview.md:9` makes graph editing the harness capability this block exists for.
- `errors: { ...baselineErrors, "stale-revision": staleRevisionDetails, "plan-invalid": planInvalidDetails, "illegal-transition": illegalTransitionDetails, "binding-in-use": bindingInUseDetails }`.
- `examples` in the shape of `planImportExamples`.

Paths, built from typed segments and never from a string:

```ts
// node.create
[resource("project"), parameter("project"), sub("node")][
  // node.update
  (resource("node"), parameter("node"), action("update"))
][
  // node.delete
  (resource("node"), parameter("node"), action("delete"))
];
```

All three are `POST`. `DELETE /v1/node/:id` is refused: `docs/proposal/api/README.md:126` gives `DELETE` the `none` idempotency policy, and a `DELETE` carries no body for the revision token.

### `src/http/contract/registry.test.ts`

EPIC 015 Story 7 declares a module-level `harnessOperations` holding nine ids, sorted bytewise. **This story adds `node.create`, `node.update` and `node.delete` to that list and to the count in its assertion message, so the set holds twelve members at the close of this epic.** Keep the list sorted bytewise. Edit the member list only — state no registry-wide total in this file. Without this edit `npm run verify` fails on the EPIC 015 assertion at this epic's close.

The registry-wide total belongs to EPIC 020, which owns `src/http/contract/authorization.test.ts` and its sixteen-name set (`020-wiring-and-scenarios.md:47`).

### `src/http/contract/parity.test.ts`

Raise the row counts at `:16` and `:25` by three: `54` becomes `57`, and `58` becomes `61`.

### The three handlers

Create `src/http/server/node/create-node.ts`, `update-node.ts` and `delete-node.ts`. Each follows `src/http/server/plan/import-plan.ts`: read the path parameter, `safeParse` the request schema, call exactly one command, format the response, and map a thrown refusal through one shared mapper. Each reads the calling actor from `context.actor`, never from a `dependencies.actor` string.

Create `src/http/server/node/refusals.ts`, in the pattern of `src/http/server/plan/refusals.ts`, mapping `NodeWriteError` over its six codes:

| refusal              | http error                                              |
| -------------------- | ------------------------------------------------------- |
| `project-not-found`  | `not-found`                                             |
| `node-not-found`     | `not-found`                                             |
| `kind-mismatch`      | `invalid-request`, details `{ expected, actual }`       |
| `stale-revision`     | `stale-revision`, details `{ guard, expected, actual }` |
| `plan-invalid`       | `plan-invalid`, details `{ findings }`                  |
| `illegal-transition` | `illegal-transition`, details `{ nodes }`               |
| `binding-in-use`     | `binding-in-use`, details `{ blockers }`                |

The switch is exhaustive over `NodeWriteRefusalCode` and ends with `throw error`, exactly as `refusals.ts:39` does.

### `src/main.ts`

Construct `NodeWriteRevision`, bind the three commands, and register the three handlers. This is the only wiring this epic does; EPIC 020 owns the composition-root sweep.

### `src/main.node-write.test.ts` — the route-level acceptance test

One named test, in the pattern of `src/main.readiness.test.ts` of EPIC 016. It migrates one home, launches the real daemon through `launchDaemon` at `test/helpers/daemon.ts:29`, and drives one sequence against one database:

`node.create`, `node.update`, `node.delete`, then `plan.export`, then `plan.revisions`, then a blob fetch of the newest `acceptedBlob`, then `plan.validate`, then `plan.import` at the returned revision.

It asserts the export bytes equal the fetched blob bytes through `Buffer.compare`, that `plan.validate` answers `200` with no structural finding, and that `plan.import` at that revision answers `200`.

It runs the whole sequence twice: once on a complete graph, and once on a graph that the delete left incomplete. Both `plan.import` calls succeed.

## Constraints

- No handler branches on a domain rule. Each parses, invokes one command and formats.
- Every declared operation appears exactly once in `http/contract/`. Add no second entry and no `post-mvp` row.
- The three ids added to `harnessOperations` are added to the member list only. Assert no registry-wide total in `registry.test.ts`.
- The idempotency table at `README.md:122-126` does not change: the three rows are `POST`, so `memory` already covers them. `src/http/server/idempotency.ts:112-114` is process-local and expiring, so this epic claims no durable destructive idempotency.
- `http/contract/` imports no koa.

## Verify

- `node --test src/http/contract/*.test.ts` exits 0, including `parity.test.ts` at the raised counts and `registry.test.ts` at twelve harness members.
- `src/http/contract/registry.test.ts` asserts the harness set holds exactly twelve members and that the three added names are `node.create`, `node.update` and `node.delete`.
- `src/http/contract/path.test.ts` asserts `node` is a subresource segment and that `update` and `delete` are action segments.
- Create `src/http/server/node/create-node.test.ts`, `update-node.test.ts` and `delete-node.test.ts`, suite names matching the module path. Each asserts:
  - the success body against the response schema;
  - the success body parses with a `revision` string member: `nodeCreateResponse`, `nodeUpdateResponse` and `nodeDeleteResponse` each accept the body, and the parsed `revision` is a non-empty string;
  - a `400 invalid-request` for a body missing one editable field, and for a `repo` on a task, and for a missing `repo` on an objective — from the schema, not from the validator;
  - each refusal code with its `details` shape;
  - a repeated `Idempotency-Key` replays the captured `200` and mints no second revision, with the `plan_revision` row count compared before and after; for `node.delete` the replay returns the captured `200` body and not `404`.
- `node.create`, `node.update` and `node.delete` each answer `200` to a harness token, and `provider.list` with the same token stays `403 actor-forbidden`. Assert the three operation ids present in the harness-readable set by name.
- **A client obtains the guard token without calling `plan.revisions`.** In `src/main.node-write.test.ts`, two creates run back to back, and the `revision` of the first response is the `fromRevision` of the second, which answers `200`. A third create at the first revision is `409 stale-revision`; the client then refreshes from `plan.export`, the `revision` of that response equals the `revision` of the second create response, and the third create at that value answers `200`. `plan.revisions` is called nowhere in this assertion.
- `src/main.node-write.test.ts` runs the full sequence twice and exits 0.
- `node --test src/http/contract/*.test.ts src/http/server/node/create-node.test.ts src/http/server/node/update-node.test.ts src/http/server/node/delete-node.test.ts src/main.node-write.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/http/contract/*.test.ts`, the three `src/http/server/node/*.test.ts` files and `src/main.node-write.test.ts`. Hermetic coverage bullets `.agent/plan/epics/017-per-node-graph-write.md:136`, `:146`, `:151`, `:159`, `:169` and `:170`.

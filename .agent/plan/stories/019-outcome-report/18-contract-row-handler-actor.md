# Story 18 — The contract row, the handler and the actor row

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Stories 5, 7, 9, 11.

This story is **atomic with the proposal route row**, which it carries itself. Story 1 deliberately leaves the Routes table alone, so no story between the two leaves `src/http/contract/parity.test.ts` red.

## Change

### `docs/proposal/api/outcome.md`

- Line 5 reads `The operations a human calls to clear a stuck graph.` Replace `a human calls` with `an actor calls`. Keep the second sentence of that paragraph unchanged.
- Add one row to the Routes table at `:9-14`, **first** in the table body, above the `node.unblock` row at `:11`. Match the existing column order `operationId | Method and path | introducedIn | status | Source`, and write the Source cell as free prose exactly as the other rows do:

  ```
  | `node.report`  | `POST /v1/node/:id/report`  | phase-1      | routed  | 013-external-drive-overview.md, external drive report |
  ```

- Reorder and reword no other row.

### `src/http/contract/path.ts:36-52`

Add `"report"` to `actionSegments`, in the existing alphabetical order: between `"rename"` at `:46` and `"resolve"` at `:47`.

### `src/http/contract/outcome.ts`

Add the schemas above `export const outcome` at `:4`, then the operation as the **first** entry of the `operations([...])` array, above `node.unblock` at `:5`.

```ts
const taskReportBase = { fence: z.number().int() };

export const nodeReportRequest = z.discriminatedUnion("report", [
  z.strictObject({
    report: z.literal("accepted"),
    fence: z.number().int(),
    objectId: objectId,
  }),
  z.strictObject({
    report: z.literal("rejected"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000),
  }),
  z.strictObject({
    report: z.literal("failed"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000),
  }),
  z.strictObject({
    report: z.literal("cancelled"),
    fence: z.number().int(),
    reason: z.string().min(1).max(2000).optional(),
  }),
  z.strictObject({
    report: z.literal("attested"),
    fence: z.number().int(),
    objectId: objectId,
  }),
  z.strictObject({
    report: z.literal("closed"),
    acknowledgePartial: z.boolean(),
  }),
]);

export const nodeReportResponse = z.strictObject({
  nodeId: z.string(),
  kind: z.enum(nodeKinds),
  state: z.enum(nodeStates),
  blockReason: z.enum(blockReasons).nullable(),
  attemptId: z.string().nullable(),
  attemptNo: z.number().int().nullable(),
  attemptsRemaining: z.number().int().nullable(),
  objectId: objectId.nullable(),
  objectiveState: z.enum(nodeStates).nullable(),
  objectiveProjection: z.enum(terminalStates).nullable(),
});
```

`nodeReportResponse` is one response shape for all six report kinds. It mirrors `NodeReportResult` of `src/domain/outcome-report.ts` key for key and in the same order, so a member that a branch does not fill is nullable rather than absent.

The six request members follow the `reportKinds` order of Story 5. **No member declares an `owner` key.** `accepted` carries no `reason`; `rejected` and `failed` carry a mandatory `reason`; `cancelled` carries an optional one. `objectId` is the schema at `src/domain/column.ts:6`; hard-code no length. Delete the unused `taskReportBase` if the six literals do not share it — write six full strict objects rather than a spread that weakens strictness.

The operation row:

```ts
  {
    operationId: "node.report",
    method: "POST",
    path: [resource("node"), parameter("node"), action("report")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    idempotency: "memory",
    replayable: [200],
    request: nodeReportRequest,
    response: nodeReportResponse,
    errors: {
      ...baselineErrors,
      "lease-held": leaseHeldDetails,
      "illegal-transition": null,
      "acknowledgement-required": null,
      "actor-forbidden": null,
      "not-found": null,
      "invalid-request": invalidRequestDetails,
    },
    examples: nodeReportExamples,
  },
```

Reuse `leaseHeldDetails` of `018-claim-and-lease.md:115` and `invalidRequestDetails` at `src/http/contract/error-details.ts:75-79`. **Author no new details schema.** Add `nodeReportExamples` in the shape of the existing examples of `src/http/contract/graph.ts:213-240`, using `EXAMPLE_ULID` and a 40-character example object id.

Add the four existing stubbed rows' `allowedActors` only if EPIC 015 has not already; do not re-decide them.

### The authorization assertion

**`src/http/contract/registry.test.ts` holds `harnessOperations`**, per `.agent/plan/stories/015-actor-identity/07-authorization-registry.md:36`, which places the assertion there and forbids creating `src/http/contract/authorization.test.ts` before EPIC 020. Add `"node.report"` to that list, in its bytewise position. **This epic adds exactly one authorization row.** The assertion names that one operation id and states no registry-wide total.

Do not create `src/http/contract/authorization.test.ts` here. EPIC 020 creates it and moves `harnessOperations` into it (`020-wiring-and-scenarios.md:48`); two epics cannot both create one path, and this epic precedes EPIC 020 in sequence order.

### `src/http/contract/parity.test.ts`

`:16` rises from `54` to `55`. `:25` rises from `58` to `59`.

### `src/http/contract/field-decisions.fixture.ts`

`src/http/contract/coverage.test.ts:262-286` derives rows over the whole registry, so `node.report.request` and `node.report.response` each add rows. Run the coverage test and write the derived rows into the fixture. **Review the delta before accepting it**: every added row must start with `node.report.request#` or `node.report.response#`, and **no existing row may be removed or changed**. Diff the fixture against its previous version and assert that by eye; a removal is a regression in another operation, not a fixture update.

### A new `src/http/server/node/report-node.ts`

```ts
export type ReportNodeHandlerDependencies = Readonly<{
  reportOutcome: (input: ReportOutcomeInput) => ReportOutcomeResult;
}>;

export function reportNodeHandler(
  dependencies: ReportNodeHandlerDependencies,
): Handler;
```

The handler does three things and nothing else, in the pattern of `src/http/server/node/show-node.ts`:

1. Read `context.parameters["id"]`; `undefined` throws `httpError("not-found", ...)`.
2. Parse the body with `nodeReportRequest`, read the authenticated actor id and kind from the handler context of EPIC 015, and call `dependencies.reportOutcome` **once**.
3. Return `{ status: 200, body: result }`.

It catches the three command errors and maps them through a new `src/http/server/node/refusals.ts`, in the pattern of `src/http/server/plan/refusals.ts:5-40`:

- `node-not-found` → `not-found`
- `initiative-not-reportable` and `body-kind-mismatch` → `invalid-request`, with `details: { refusal }`
- `actor-forbidden` → `actor-forbidden`
- `illegal-transition` → `illegal-transition`, with the command's `details`
- `lease-held` → `lease-held`, with the command's `details`
- `acknowledgement-required` → `acknowledgement-required`

It handles `ReportOutcomeError`, `ReportObjectiveError` and `CloseObjectiveError`. It re-throws anything else, exactly as `refusals.ts:39` does. **The handler branches on no domain rule**: the kind dispatch lives in the command.

## Constraints

- A body that matches no member is `400 invalid-request` before any command runs.
- Declare `idempotency: "memory"` and `replayable: [200]` together; `src/http/contract/registry.ts` requires the pair.
- Every request member is `z.strictObject`, so a body carrying an `owner` key is refused by the schema.
- Add exactly one operation to `src/http/contract/outcome.ts`. The four stubbed rows are unchanged.
- Add no row to the precondition table of `docs/proposal/api/README.md:98-104`.

## Verify

- Create `src/http/server/node/report-node.test.ts`, suite name `"src/http/server/node/report-node.test"`, over `createTestApp` of `test/helpers/app.ts`.
  - `it("a valid accepted body reaches the command once", ...)` — a recording command fake; assert one call and the parsed input.
  - `it("a body carrying timed-out is invalid-request", ...)`.
  - `it("an accepted body with no objectId, a rejected body with no reason, and an accepted body carrying a reason are each invalid-request", ...)` — three cases, and the command fake records zero calls.
  - `it("a body carrying an owner key is invalid-request", ...)`.
  - `it("a 40-character and a 64-character object id are each accepted", ...)`, and `it("a 39, a 41, a 63-character and an uppercase object id are each invalid-request", ...)`.
  - `it("each refusal maps to its code", ...)` — one case per refusal above, asserting the status and the `details`.
  - `it("the handler branches on no domain rule", ...)` — assert the handler calls the command for every one of the six report kinds, so no kind is decided in the handler.
- Add to `src/http/contract/registry.test.ts`: `it("node.report declares its lifecycle by operation id", ...)` — `allowedActors` deep-equals `["human", "harness"]`, `idempotency === "memory"`, `replayable` deep-equals `[200]`, `introducedIn === "phase-1"`, `status === "routed"`, and `registryFaults(registry)` is empty.
- Add to `src/http/contract/registry.test.ts`: assert `node.report` is in the harness set, and assert `actor.register` still declares `["human"]` alone, so the widening reached this operation only.
- `node --test src/http/contract/path.test.ts src/http/contract/outcome.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/example.test.ts src/http/server/node/report-node.test.ts` exits 0. Create `src/http/contract/outcome.test.ts` only if it does not exist; otherwise extend it.
- `node --test test/helpers/proposal.test.ts` exits 0, and `node --test src/http/contract/parity.test.ts` exits 0, which together prove the Routes-table row and the registry row agree.
- `npm run verify` exits 0.
- Proof: `src/http/contract/path.test.ts`, `src/http/contract/parity.test.ts`, `src/http/contract/registry.test.ts` and `src/http/server/node/report-node.test.ts`. Hermetic coverage: `019-outcome-report.md:150`, `:151`, `:152` (the schema half), `:173` and `:179`.

# Story 1 — The contract carries the patch

Epic: `.agents/plan/epics/052.2-the-structural-report-route.md`
Depends on: EPIC 052.1 Story 8 (`08-an-ineligible-delete-refuses`), for the settled refusal set and
the exact details object every 409 schema must parse; EPIC 052.1 Story 10
(`10-the-proposal-records-the-structural-acceptance`), for the behaviour these codes name.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

**It amends `docs/proposal/api/README.md` and no other proposal document.** That file's error-code
matrix is a contract register, which `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` reads.
`docs/proposal/phase-2/checkpoints.md` carries the behaviour, and EPIC 052.1 Story 10
(`10-the-proposal-records-the-structural-acceptance`) amends it, because `AGENTS.md` makes
`docs/proposal/` the source of truth for behaviour and the behaviour is decided there.

**The contract lands with the route, in this epic and not the one before it.** A `nodeReportRequest`
member declared without the handler that serves it puts a request shape in
`pnpm run contract:publish` that the daemon answers with an undeclared substitute. Story 2
(`02-the-report-route-carries-a-patch`) is that handler, and the two stories are one epic for that
reason.

## Change

### 1 — `src/http/contract/outcome.ts` — the seventh `nodeReportRequest` member

`src/http/contract/outcome.ts:23` — `nodeReportRequest` gains one member at the end of the union:

```ts
z.strictObject({
  report: z.literal("structural"),
  fence: z.number().int(),
  patch: z.unknown().refine((value) => value !== undefined),
}),
```

**The patch is opaque, and the refinement is what makes it required.** `z.unknown()` alone is optional
in zod 4, so a body with no `patch` would parse and the epic's gate row 32 would fail. The refinement
adds the requirement without adding a shape: `z.toJSONSchema` emits `"patch": {}` and lists it under
`required`, with no `$ref` and no `definitions` block, so `scripts/field-decisions-probe.mjs` walks it
flat and `pnpm run contract:publish` emits a self-contained document.

**Embedding `graphPatch` here would break the epic's own proof.** HTTP validation would reject a
malformed patch with `invalid-request` before the authority prelude ran, and the fixed refusal order
requires a stale fence to refuse before the patch is read. Story 2
(`02-the-report-route-carries-a-patch`) case 2 is that proof.

The discriminator is `"structural"`, matching the run kind at `src/domain/run-kind.ts:3` — `runKinds`
and the checkpoint kind.

`src/commands/outcome/report-outcome.ts:25` — `NodeReportRequest` gains the matching member
`Readonly<{ report: "structural"; fence: number; patch: unknown }>`.

### 2 — `src/http/contract/errors.ts` — eight codes

`src/http/contract/errors.ts:7` — `errorStatuses` gains eight keys. The order is pinned by
`src/http/contract/errors.test.ts:41` — `pins`, and the key set and every status are cross-checked
against `docs/proposal/api/README.md` by `src/http/contract/errors.test.ts:17` — `matches`, so the two
files move together and in one order.

Insert the five precondition codes directly after `"subtree-busy"`:

| code                      | status |
| ------------------------- | ------ |
| `patch-target-invalid`    | 409    |
| `patch-scope-invalid`     | 409    |
| `patch-project-invalid`   | 409    |
| `patch-delete-ineligible` | 409    |
| `pair-fixed`              | 409    |
| `expansion-empty`         | 409    |

and the two request-shape codes directly after `"credential-rejected"`:

| code                 | status |
| -------------------- | ------ |
| `patch-unparsable`   | 422    |
| `patch-id-duplicate` | 422    |

Each of the six 409 codes joins `PreconditionCode` at `src/http/contract/errors.ts:41` —
`PreconditionCode` by construction, so `httpError` demands a `details` argument for it. That is the
intent: each names a specific mutation, and a refusal that does not say which mutation is unusable.

The count moves from 29 to 37. `src/http/contract/errors.test.ts:41` — `pins` holds the ordered
literal, `src/http/contract/errors.test.ts:113` — `groups` holds the status grouping, and both take
the eight new entries in the same positions.

### 3 — `docs/proposal/api/README.md` — eight matrix rows

The table is read by `readErrorCodeMatrix` at `test/helpers/proposal.ts:89` — `readErrorCodeMatrix`,
which takes every three-cell row whose first cell is an integer between 400 and 599. Insert six rows
after `docs/proposal/api/README.md:266` — `subtree-busy` and two after
`docs/proposal/api/README.md:270` — `credential-rejected`, in the order of section 2, each with its
meaning:

- `patch-target-invalid` — a mutation names an id the pinned graph cannot mutate that way
- `patch-scope-invalid` — a mutation leaves the claimed subtree
- `patch-project-invalid` — a mutation names a node of another project
- `patch-delete-ineligible` — a deleted node is not in a deletable state, or a durable row
  names it
- `pair-fixed` — the node holds a child or an accepted checkpoint, so its pair no longer moves
- `expansion-empty` — the accepted patch leaves the claimed node with no child
- `patch-unparsable` — the patch is not a graph patch
- `patch-id-duplicate` — two mutations name one id

### 4 — `src/cli/exit-code.ts` — eight exit codes

`src/cli/exit-code.ts:13` — `exitCodes` gains the same eight keys. The key set must equal
`errorStatuses`' key set, asserted bytewise at `src/cli/exit-code.test.ts:53` — `bytewise`; the order
is free, so append the eight after `"subtree-busy"` at `src/cli/exit-code.ts:39` — `subtree-busy`:

`patch-target-invalid` 170, `patch-scope-invalid` 171, `patch-project-invalid` 172,
`patch-delete-ineligible` 173, `pair-fixed` 174, `expansion-empty` 175, `patch-unparsable` 176,
`patch-id-duplicate` 177.

`src/cli/exit-code.test.ts:17` — `expected` holds the literal map and
`src/cli/exit-code.test.ts:60` — `twenty-nine` asserts a count of 29; both move to 36, and the test
name moves with the count. `src/cli/exit-code.test.ts:86` — `no two codes share an exit code` asserts
a set size, which becomes 36.

**`stale-revision` and `plan-invalid` are left alone in both files.** Both already exist, at
`src/http/contract/errors.ts:14` — `stale-revision` and `:30` — `plan-invalid`, and at
`src/cli/exit-code.ts:20` — `stale-revision` and `:30` — `plan-invalid`.

### 5 — `src/http/contract/error-details.ts` and the operation's `errors` record

Add one details schema per new 409 code, shaped like `subtreeBusyDetails` at
`src/http/contract/error-details.ts:175` — `subtreeBusyDetails`:

```ts
export const patchTargetInvalidDetails = z.strictObject({
  violations: z.array(z.strictObject({ mutationId: z.string() })).min(1),
});
export const patchScopeInvalidDetails = z.strictObject({
  claimedNodeId: z.string(),
  violations: z
    .array(
      z.strictObject({
        mutationId: z.string(),
        referenceId: z.string().nullable(),
      }),
    )
    .min(1),
});
export const patchProjectInvalidDetails = z.strictObject({
  projectId: z.string(),
  violations: z
    .array(
      z.strictObject({
        mutationId: z.string(),
        referenceId: z.string().nullable(),
      }),
    )
    .min(1),
});
export const patchDeleteIneligibleDetails = z.strictObject({
  violations: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("node-state"),
          nodeId: z.string(),
          state: z.enum(nodeStates),
          admitted: z.array(z.enum(nodeStates)).min(1),
        }),
        z.strictObject({
          kind: z.literal("binding"),
          nodeId: z.string(),
          blocker: z.enum(structuralDeleteBindings),
        }),
      ]),
    )
    .min(1),
});
export const pairFixedDetails = z.strictObject({
  violations: z
    .array(
      z.strictObject({
        nodeId: z.string(),
        reason: z.enum(["has-accepted-checkpoint", "has-child"]),
      }),
    )
    .min(1),
});
export const expansionEmptyDetails = z.strictObject({
  claimedNodeId: z.string(),
});
```

Every refusal reports each independent correction unit of its own group, never the first.
`expansion-empty` is the one exception, and it is scalar because a patch has exactly one claimed
node. Each `violations` list sorts by mutation id bytewise, then by the declared reason order, then
by the offending reference id bytewise. **Submitted mutation order is never the oracle**:
`renderGraphPatch` sorts mutations bytewise by id, so two submissions that differ only by permutation
render to identical bytes, and evidence that moved with the permutation would contradict the
determinism rule of `AGENTS.md`. `referenceId` is `null` when the offending thing is the mutation
itself, and it names the `dependsOn` entry or the `parentId` when the mutation is legal and its
reference is not.

`src/http/contract/outcome.ts:150` — `errors` gains ten entries: the eight new codes with those
schemas — `patch-unparsable` and `patch-id-duplicate` take `null` — **and** `stale-revision` with
`staleRevisionDetails` at `src/http/contract/error-details.ts:26` — `staleRevisionDetails` and
`plan-invalid` with `planInvalidDetails` at `src/http/contract/error-details.ts:90` —
`planInvalidDetails`. The two shipped codes need the record entry even though they need no new code:
the record is what builds the operation's error envelope, and
`src/http/server/node/report-node.test.ts:24` — `reportErrorEnvelope` parses a real refusal response
against it. An undeclared code therefore fails that parse in Story 2
(`02-the-report-route-carries-a-patch`) case 6, and it would otherwise leave
`pnpm run contract:publish` describing no envelope for a response the daemon returns.
`src/http/contract/coverage.test.ts:536` — `errorStatuses` checks the reverse direction only, that a
declared code is a key of `errorStatuses`, so it catches nothing here.

### 6 — `src/http/contract/coverage.test.ts` — the `operationAdditions` allowlist

`src/http/contract/coverage.test.ts:520` — `only the named operations add codes` asserts that every
code an operation declares beyond `baselineErrors` appears verbatim in `operationAdditions` at
`src/http/contract/coverage.test.ts:19` — `operationAdditions`. Nine entries join the `"node.report"`
list at `src/http/contract/coverage.test.ts:63` — `node.report`: the seven new codes plus
`stale-revision` and `plan-invalid`. The assertion is a `deepEqual` over a sorted array, so an
addition made in `outcome.ts` and not here fails, and the reverse fails too.

### 7 — `src/http/contract/field-decisions.fixture.ts` — regenerate

Run `node scripts/field-decisions-probe.mjs --write`, which rewrites the file from a fresh walk of the
registry. Never hand-edit it. The seventh union member adds three rows, and the walk sorts bytewise.

## Constraints

- The eight codes join `errors.ts`, `exit-code.ts` and `docs/proposal/api/README.md` in one change,
  and the ten record entries join `outcome.ts` and `operationAdditions` in one change. Any one of the
  five edited alone is a red `pnpm run verify`.
- `nodeReportRequest` carries the patch as an opaque value. No member of it names a mutation.
- `field-decisions.fixture.ts` is generated. A hand edit is a defect.
- Every 409 details schema is a `strictObject`, and each parses the exact object EPIC 052.1's command
  builds. A schema that is looser than the command is a contract that describes a response the daemon
  never sends.
- Do not touch `docs/proposal/phase-2/checkpoints.md`. EPIC 052.1 Story 10
  (`10-the-proposal-records-the-structural-acceptance`) owns it.

## Verify

```
node --test src/http/contract/outcome.test.ts src/http/contract/errors.test.ts src/http/contract/coverage.test.ts src/http/contract/error-details.test.ts src/cli/exit-code.test.ts
```

Add, each as a separate `it`:

1. `"nodeReportRequest parses each of the seven members"` — one `safeParse` per member, asserting
   `success` is `true` and the parsed value deep-equals the input. Extend
   `src/http/contract/outcome.test.ts`, whose suite is at `src/http/contract/outcome.test.ts:21` —
   `describe`.

2. `"a structural member missing patch is refused by value"` — `safeParse({ report: "structural",
fence: 1 })` returns `success: false`. Assert the issue path is `["patch"]`. Cases 1 and 2 are the
   epic's gate row 32.

3. `"a structural member accepts any JSON value as the patch"` — a string, a number, `null`, an array
   and an object each parse. This is what makes `patch-unparsable` reachable from the command rather
   than from the schema.

4. `"the error table holds thirty-six codes in the pinned order"` — update
   `src/http/contract/errors.test.ts:41` — `pins` and assert the ordered literal, then update
   `src/http/contract/errors.test.ts:113` — `groups` and assert the status grouping. The mutation test
   at `src/http/contract/errors.test.ts:75` — `rejects` already proves the ordering assertion fires.

5. `"every exit code is unique across thirty-six codes"` — update
   `src/cli/exit-code.test.ts:17` — `expected` and its count assertion, and assert the set size is 36.

6. `"node.report declares every code its handler raises"` — update the `"node.report"` entry of
   `operationAdditions` with the ten codes and assert `src/http/contract/coverage.test.ts` passes.
   The control is one code added to `src/http/contract/outcome.ts` and not to the allowlist, which
   `src/http/contract/coverage.test.ts:520` — `only the named operations add codes` must reject.

7. `"the field decisions fixture equals a fresh walk"` — `node scripts/field-decisions-probe.mjs`
   without `--write` exits 0.

8. `"every 409 details schema parses the object the command builds"` — one case per schema, each
   parsing a literal copied from the refusal EPIC 052.1 raises, asserted value by value and not by
   shape. The control is one object carrying an extra key, which `strictObject` must refuse. Extend
   `src/http/contract/error-details.test.ts`. This is the epic's gate row 32a, and it is what stops
   the six schemas drifting from the six refusals.

9. `"every new code is a key of all three registers"` — iterate the declared tuple of the eight new
   codes and assert each is a key of `src/http/contract/errors.ts:7` — `errorStatuses`, a key of
   `src/cli/exit-code.ts:13` — `exitCodes`, and a row of the `docs/proposal/api/README.md` matrix
   that `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` returns. Iterating the tuple is what
   makes a code added to one register and not the others fail. This is the epic's gate row 32b.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/outcome.test.ts` in `PASS EPIC-052.2`.

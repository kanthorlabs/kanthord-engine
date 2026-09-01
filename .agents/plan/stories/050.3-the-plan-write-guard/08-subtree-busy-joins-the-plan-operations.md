# Story 8 — `subtree-busy` joins the plan operations

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: EPIC 050.1 Story 1 (`subtree-busy` and its details schema exist). Stories 2 to 6 need this story's error registration; implement it before all five.
Kind: story-foundation

This story changes the contract only. It draws no path.

## Change

**Add `"subtree-busy"` to the `errors` record of five operations**: `plan.import`, `node.create`,
`node.update`, `node.delete` and `node.unblock`. EPIC 050.1 registered the code in
`src/http/contract/errors.ts` as a 409 precondition and its details schema in
`src/http/contract/error-details.ts`, so this story defines neither and reuses both.

**Add `"subtree-busy"` to each of the five operations' entries in `operationAdditions`** at
`src/http/contract/coverage.test.ts:19-59`, the closed map of extra codes per operation. Keep each
list in its shipped order and append.

**Remove nothing.** No plan operation declares `lease-held`:
`grep -rn '"lease-held"' src/http/contract/` binds it to `node.claim`, `node.heartbeat`,
`node.release` and `node.report`, and EPIC 050.4 removes it from those four with the mechanism that
raises it. A story that "replaced" `lease-held` here would delete a registration that does not exist.

**Add the five rows to the error-code table** in `docs/proposal/api/README.md`, section `## Errors`.
`src/http/contract/errors.test.ts:16-26` compares the key set and the status of every code against
that table, so the code list and the document must agree. The code itself already has a row; the
change is the per-operation column if the table carries one.

## Constraints

- Add one code to five operations. Define no code, no status and no details schema.
- `subtree-busy` stays a 409 precondition, and `httpError` therefore requires its `details` argument at every throw site.
- Keep the registry at its shipped operation and routed counts. This story adds no operation.
- Do not touch the four run operations' error records.

## Verify

```
node --test src/http/contract/coverage.test.ts src/http/contract/errors.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts
```

Add, each as a separate `it`:

1. `"subtree-busy is declared on all five plan operations"` — assert it against the registry for `plan.import`, `node.create`, `node.update`, `node.delete` and `node.unblock`.

2. `"lease-held is declared on no plan operation"` — assert it, so the epic's claim that nothing is removed is proven rather than assumed.

3. `"lease-held is still declared on the four run operations"` — with case 2, the scope of the code is pinned from both sides, and EPIC 050.4 inherits a stated state.

4. `"subtree-busy is a 409 precondition"` — assert `errorStatuses["subtree-busy"] === 409`, unchanged from EPIC 050.

5. `"the subtree-busy details schema parses what a plan command throws"` — parse `{ relation: "ancestor", nodeId, runId, expiresAt }` and assert success; parse one omitting `runId` and assert failure.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice
in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/coverage.test.ts` in `PASS EPIC-050.3`.

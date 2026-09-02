# Story 8 — `subtree-busy` joins the plan operations

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: EPIC 050.1 Story 1 (01-the-claim-contract), which registers `subtree-busy` and its details schema. Stories 2 to 6 of this epic need this story's error registration; implement it before all five.
Kind: story-foundation

This story changes the contract only. It draws no path.

## Change

**Add `"subtree-busy"` to the `errors` record of five operations.** Each record is one object
literal, and the entry is appended after the last member:

| operation      | record                                        |
| -------------- | --------------------------------------------- |
| `plan.import`  | `src/http/contract/graph.ts:563 — `errors``   |
| `node.create`  | `src/http/contract/graph.ts:652 — `errors``   |
| `node.update`  | `src/http/contract/graph.ts:672 — `errors``   |
| `node.delete`  | `src/http/contract/graph.ts:692 — `errors``   |
| `node.unblock` | `src/http/contract/outcome.ts:171 — `errors`` |

The value is the details schema EPIC 050.1 Story 1 (01-the-claim-contract) exports from
`src/http/contract/error-details.ts` for `subtree-busy`, used exactly as
`src/http/contract/graph.ts:653 — `baselineErrors`` uses the neighbouring schemas. That story also
registered the code in `src/http/contract/errors.ts` as a 409 precondition, so this story defines
neither the code nor the schema and reuses both.

`node.unblock` is the one of the five whose record holds no `staleRevisionDetails`: it carries
`baselineErrors`, `"invalid-request"` and `"illegal-transition"` only, at
`src/http/contract/outcome.ts:172 — `baselineErrors``. Append to it and change nothing else.

**Add `"subtree-busy"` to each of the five operations' entries in `operationAdditions`** at
`src/http/contract/coverage.test.ts:19-59`, the closed map of extra codes per operation. Keep each
list in its shipped order and append.

**Remove nothing.** No plan operation declares `lease-held`:
`grep -rn '"lease-held"' src/http/contract/` binds it to `node.claim`, `node.heartbeat`,
`node.release` and `node.report`, and EPIC 050.4 removes it from those four with the mechanism that
raises it. A story that "replaced" `lease-held` here would delete a registration that does not exist.

**Change no row of the error-code table** in `docs/proposal/api/README.md`, section `## Errors`. That
table is `| Status | Code | Meaning |` at `:241`, one row per code and no per-operation column, and
`subtree-busy` already carries its single row from EPIC 050.1. `readErrorCodeMatrix` at
`test/helpers/proposal.ts:89-107` keys it by code and takes exactly three cells, and
`src/http/contract/errors.test.ts:16-26` asserts that key set equals `errorStatuses`, so a second row
for one code fails the test. The per-operation declaration lives in the registry and in
`operationAdditions`, and it is the whole of this story's change.

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

6. `"each of the five operations' error sets grows by exactly one member"` — pin the shipped set per operation as a literal, and assert the new set deep-equals that literal plus `"subtree-busy"`. Five comparisons, so an operation that gained a second code fails.

7. `"no other operation's error set changes"` — assert every operation outside the five holds the set it shipped, so the four run operations in particular are untouched.

`pnpm run verify` exits 0. It emits and validates the master OpenAPI document and every feature slice
in a temporary directory, so a schema or component drift fails there too.

Proof: PASS line delivered — `src/http/contract/coverage.test.ts` in `PASS EPIC-050.3`.

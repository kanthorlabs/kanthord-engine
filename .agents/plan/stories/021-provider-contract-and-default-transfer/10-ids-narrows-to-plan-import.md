# Story 10 — `ids` narrows to `plan.import`

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 7.

This story replaces D8 as written. **D8's text in the EPIC states that `src/http/server/credential/refusals.ts:27` is the only producer of `ids` and that no path emits it afterwards. That is false**, and the EPIC needs the amendment recorded at the end of this file. `src/http/server/plan/refusals.ts:33-36` emits `ids` for the `choice-duplicate`, `choice-missing` and `choice-extra` refusals of `importPlan`, and `src/commands/plan/import-plan.ts:566` builds the list.

The narrowing D8 wanted is still right; it is a narrowing to one operation, not a deletion. The baseline stops advertising a field that only one operation can emit, and `plan.import` keeps emitting it. **No wire response changes.**

`src/http/server/plan/refusals.ts` is imported by exactly one handler, `src/http/server/plan/import-plan.ts:6`. `validate-plan.ts`, `export-plan.ts` and `list-revision.ts` do not import it. So `plan.import` is the whole of the override.

## Change

- Edit `src/http/contract/error-details.ts:76-80`. Remove `ids` from `invalidRequestDetails`, leaving

```ts
export const invalidRequestDetails = z.strictObject({
  refusal: z.string().min(1),
  detail: z.string().optional(),
});
```

- Add, immediately after it, the operation-specific schema:

```ts
export const planImportInvalidRequestDetails = z.strictObject({
  refusal: z.string().min(1),
  detail: z.string().optional(),
  ids: z.array(z.string()).optional(),
});
```

`ids` stays optional, because `documents-hash-mismatch` reaches the same code with `refusal` alone (`src/http/server/plan/refusals.ts:27-29`), and a request-schema failure reaches it with no details at all.

- Edit the `plan.import` entry at `src/http/contract/graph.ts:439-447`. Add `"invalid-request": planImportInvalidRequestDetails.optional(),` to its `errors` object, after the `...baselineErrors` spread so the spread order overrides the baseline. Import `planImportInvalidRequestDetails` from `./error-details.ts` alongside the schemas that file already imports.
- Change `src/http/server/plan/refusals.ts` in no way. It keeps emitting `ids`, and that emission is now covered by the operation's own schema.
- Change `src/http/contract/error-baseline.ts` in no way beyond what the `invalidRequestDetails` edit gives it.

## Constraints

- Override `invalid-request` for `plan.import` and for no other operation. This is the first per-operation override of a baseline code in the tree; a second one is a separate decision.
- Place the override after the `...baselineErrors` spread. Before it, the spread wins and the override is silently dead.
- Change no handler, no command and no wire response. This story changes the published contract so that it matches what the daemon already sends.
- Do not rename the wire field. `choiceIds` would be a clearer name and it changes a live response shape, so it is out of scope here.
- Do not map the three `choice-*` refusals to a different error code. That also changes a live response.
- Do not touch `src/http/server/plan/refusals.ts:35` or `src/commands/plan/import-plan.ts:566`.

## Verify

- Edit `src/http/contract/error-details.test.ts`. Move the case at lines 359-363, `"parses refusal with ids"`, onto `planImportInvalidRequestDetails`. Add to the `invalidRequestDetails` suite a case named `"rejects ids"` asserting `invalidRequestDetails.safeParse({ refusal: "choice-missing", ids: ["a"] }).success === false`. Keep the `refusal`-only and `refusal` plus `detail` cases on both schemas.
- Add to `src/http/server/plan/refusals.test.ts` a case named `"a choice refusal validates against the plan.import details schema"`, asserting that the `details` of `toHttpError(new ImportPlanError("choice-missing", "m", { ids: ["task_a"] }))` parses under `planImportInvalidRequestDetails`, and fails under `invalidRequestDetails`. That pair is the whole point of the story: it pins the emitted shape to the operation that declares it.
- Add to `src/http/contract/coverage.test.ts` a case named `"plan.import is the only operation overriding the baseline invalid-request details"`, asserting that the sorted operation ids of every registry entry whose `errors["invalid-request"]` is not the baseline schema deep-equals `["plan.import"]`. Compare by identity against `baselineErrors["invalid-request"]`.
- Run `node --test --test-timeout=60000 src/http/contract/error-details.test.ts src/http/server/plan/refusals.test.ts src/http/server/plan/import-plan.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/server/credential/*.test.ts scripts/publish-contract.test.ts`; it exits 0.
- `src/http/contract/openapi.test.ts` asserts exactly eighty-two schema components in bytewise order. Error details are inlined into the per-operation `<operationId>.error` component (`src/http/contract/openapi.ts:170`), and this story adds no operation, so the count must be unchanged. If the assertion moves, stop: that means details schemas are registered as components and the story needs the component list updated deliberately.
- Run `grep -rn "ids" src/http/server/credential/`; it returns nothing.
- Run `node scripts/field-decisions-probe.mjs` with no `--write`; it exits 0. The walk covers the query, request and response slots only, so no error edit moves a row.
- Run `npm run verify`; it exits 0.
- Proof: Hermetic coverage "The transfer" bullet 10, in full: the `Object.keys(error).sort()` clause from Story 5, the `invalidRequestDetails.safeParse({ refusal: "x", ids: [] })` failure from this story, and the `grep` clause scoped to `src/http/server/credential/` as this story restates it.

## The EPIC amendment, applied

D8 is rewritten as "`ids` narrows to `plan.import`", and the epic's Goal, Stories list, Hermetic coverage and Open items all match this story. No amendment is outstanding. The Hermetic `grep` bullet now scopes to `src/http/server/credential/`, because over all of `src/http/server/` it is false by design: the plan producer survives.

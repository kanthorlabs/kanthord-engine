# Story 5 — Structural validity, and completeness stops refusing

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: EPIC 014 Story 10 (`findingScope` in `src/domain/plan-finding.ts`, `completenessFindings` in `src/domain/plan-completeness.ts`).

## Change

### `src/domain/plan-candidate.ts`

Add two exported functions below `validateCandidate`, which ends at `src/domain/plan-candidate.ts:264`. Both take the same argument shape as `validateCandidate` at `:85-88` and delegate to it.

```ts
export function validateCandidateStructural(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[] {
  return validateCandidate(dependencies, input).filter(
    (finding) => findingScope[finding.code] === "structural",
  );
}

export function validateCandidateCompleteness(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[] {
  return validateCandidate(dependencies, input).filter(
    (finding) => findingScope[finding.code] === "completeness",
  );
}
```

Import `findingScope` from `./plan-finding.ts`. Neither function sorts; `validateCandidate` already returns sorted findings and `Array.prototype.filter` preserves order.

### `src/domain/plan-candidate.ts:95-120` — the parent-kind rule

`validateCandidate` checks three parent conditions today: an initiative holds no parent, an objective or task holds a parent, and the parent exists in the candidate. **It never checks that the parent is the right kind.** On the import path the path shape carries that rule — `src/domain/plan-path.ts:132-139` makes an objective's derived parent path end in `initiative.md` and a task's end in `objective.md` — so no import can produce a wrong-kind parent. A per-node write carries typed fields and no path, so nothing enforces it, and a task under an initiative would pass structural validation, commit, and then render a canonical path that `plan.import` rejects. That breaks the round-trip guarantee this epic exists for.

Add one check to the parent loop, immediately after the parent-exists check at `:112-119`:

```ts
const parent = node.parentId === null ? undefined : byId.get(node.parentId);
if (parent !== undefined) {
  const required = node.kind === "objective" ? "initiative" : "objective";
  if (node.kind !== "initiative" && parent.kind !== required) {
    findings.push({
      code: "parent-missing",
      path: null,
      id: node.id,
      message: `the parent ${node.parentId} is not an ${required}`,
    });
  }
}
```

`parent-missing` is the existing code for every parent defect, so the closed code set of `src/domain/plan-finding.ts:3-28` does not grow and `findingScope` stays total over 24 codes. The message is distinct, so a test names the case exactly.

**This is behaviour-preserving on the import path**, because a wrong-kind parent cannot survive path derivation. Assert that: no existing test in `src/domain/plan-candidate.test.ts` or `src/commands/plan/import-plan.test.ts` changes.

### `src/domain/plan-candidate.ts:290` — `repairSuggestions`

Change the one call inside the repair loop from `validateCandidate` to `validateCandidateStructural`. The iteration-cap throw at `:307-311` stays exactly as it is. A database baseline is always structurally valid, so a reset to `database` always clears the finding set and the loop terminates.

### `src/commands/plan/import-plan.ts:214-219`

`validateDocuments` returns both scopes. Split the result rather than the function:

- Partition `validation.findings` on `findingScope[finding.code]`.
- Throw `ImportPlanError("plan-invalid", ...)` only when the structural partition is non-empty. The `details.findings` payload carries the structural partition only.
- Carry the completeness partition forward in a local, to be merged into the result at the end of the command.

### `src/commands/plan/import-plan.ts:334-343`

Replace the `validateCandidate` call with `validateCandidateStructural`. Throw `ImportPlanError("choices-invalid", ...)` only on a non-empty result. Call `validateCandidateCompleteness` over the same candidate and context, and carry its result forward.

### `src/commands/plan/import-plan.ts` — the result

`ImportPlanResult` gains one member:

```ts
  completeness: readonly Finding[];
```

Its value is the document-side completeness partition concatenated with the candidate-side completeness findings, then passed through `sortFindings` of `src/domain/plan-finding.ts:39-50` and deduplicated on the triple `(code, path, id)`, keeping the first occurrence. That rule makes the array a pure function of the graph, so the same import always returns the same array.

### `src/http/contract/graph.ts:97-101`

`planImportResponse` gains `completeness: z.array(planFinding)`. Add the same member to `planImportExamples.success`, with an empty array.

### `src/http/server/plan/import-plan.ts`

The handler already spreads the command result minus `retried`, so `completeness` reaches the body with no edit. Confirm by test, change nothing.

### The four named shipped-behaviour tests

- `src/domain/plan-validate.test.ts:1034` — the case that asserts a refusal for a completeness code now asserts the finding is present in `validateDocuments(...).findings` and that its `findingScope` is `completeness`. `validateDocuments` still reports both scopes; it is `import-plan.ts` that stops refusing.
- `src/domain/plan-candidate.test.ts:451-479` and `:694` — assert `validateCandidate` still reports the two completeness codes, and assert `validateCandidateStructural` over the same fixture returns an empty array.
- `src/domain/plan-candidate.test.ts:53-54` — unchanged. The two codes stay in the code list.
- `src/queries/plan/validate-plan.test.ts:536` — the component reset it asserts no longer happens, because the repair loop no longer sees a completeness finding. Change the assertion to name the choices the loop now produces, computed from the fixture by hand and written as literals.

## Constraints

- `plan.validate` still reports both scopes in its own `findings` array. Do not filter `src/queries/plan/validate-plan.ts` output.
- A structural finding still refuses at `plan.import`. Relax nothing outside the two completeness codes.
- The parent-kind rule is the **only** change to `validateCandidate`. `validateDocuments` is unchanged. Both keep returning every finding of both scopes.
- Do not change `sortFindings` or `completenessFindings`.
- `src/domain/plan-candidate.ts` stays pure: no clock, no randomness, no `node:` import.
- `findingScope` is total over the 24 codes, so the two partitions are exhaustive and no finding is silently dropped. Assert that by test.

## Verify

- Extend `src/domain/plan-candidate.test.ts`:
  - `a task under an initiative is parent-missing` — assert the code and the exact message.
  - `an objective under a task is parent-missing` — assert the code and the exact message.
  - `a task under an objective and an objective under an initiative are clean` — assert `[]`.
  - `an initiative is exempt from the parent-kind rule` — an initiative with `parentId: null` yields no parent finding.
  - `the parent-kind rule is structural` — assert `findingScope["parent-missing"] === "structural"`, so it refuses a per-node write.
  - `validateCandidateStructural drops both completeness codes` — a fixture with one empty objective and one empty initiative yields `[]`.
  - `validateCandidateCompleteness keeps both completeness codes and nothing else` — the same fixture yields exactly `["initiative-without-objective", "objective-without-task"]` by code, in `validateCandidate` order.
  - `the two partitions are exhaustive` — over a fixture that triggers one structural code and both completeness codes, assert `structural.length + completeness.length === validateCandidate(...).length`.
  - `repairSuggestions terminates on an incomplete baseline` — build a stored graph holding an objective with no task, drive `repairSuggestions` over it, and assert it returns without throwing and that every verdict resolves.
- Extend `src/commands/plan/import-plan.test.ts`:
  - `an import of a graph with an empty objective succeeds and reports the finding` — assert the result `revision` is a string and `result.completeness` names `objective-without-task` exactly once.
  - `an import of a graph with an empty initiative succeeds and reports the finding` — same shape, code `initiative-without-objective`.
  - `an import with a structural finding still refuses` — assert `ImportPlanError` with refusal `plan-invalid` and that `details.findings` holds the structural code only.
  - `completeness is sorted and deduplicated` — a fixture producing the same code from both the document side and the candidate side yields one entry.
- `node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/import-plan.test.ts src/http/contract/graph.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`, `src/commands/plan/import-plan.test.ts` and `src/queries/plan/validate-plan.test.ts`. Hermetic coverage bullet `.agents/plan/epics/017-per-node-graph-write.md:150`.

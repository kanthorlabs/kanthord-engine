# Story 10 — The validity split

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: Story 1 (both edit `docs/proposal/phase-1/state-machine.md`; this story owns line 47 only).

## Change

### `src/domain/plan-finding.ts`

- Add above `findingCodes`:

```ts
export const validationScopes = ["structural", "completeness"] as const;
export type ValidationScope = (typeof validationScopes)[number];
```

- Add after the `Finding` type at `src/domain/plan-finding.ts:32-37`, a total map over the 24 codes of `src/domain/plan-finding.ts:3-28`, keys in the same order as `findingCodes`:

```ts
export const findingScope: Readonly<Record<FindingCode, ValidationScope>> = {
  "acceptance-heading-duplicated": "structural",
  "acceptance-heading-not-at-line-start": "structural",
  "acceptance-missing": "structural",
  "acceptance-unexpected": "structural",
  "dependency-cross-parent": "structural",
  "dependency-cycle": "structural",
  "dependency-self": "structural",
  "document-unparsable": "structural",
  "frontmatter-invalid": "structural",
  "identity-duplicate": "structural",
  "identity-invalid": "structural",
  "identity-kind-mismatch": "structural",
  "initiative-without-objective": "completeness",
  "objective-without-task": "completeness",
  "parent-missing": "structural",
  "path-duplicate": "structural",
  "path-invalid": "structural",
  "reference-ambiguous": "structural",
  "reference-unresolved": "structural",
  "repo-missing": "structural",
  "repo-on-task": "structural",
  "repository-unbound": "structural",
  "repository-unknown": "structural",
  "worker-unknown": "structural",
};
```

Exactly two codes are `completeness`. Every other code is `structural`.

### A new `src/domain/plan-completeness.ts`

It imports `type NodeKind` from `./state.ts` and `type Finding` from `./plan-finding.ts`, and nothing else.

**The finding type is named `Finding`, not `PlanFinding`.** `src/domain/plan-finding.ts:32-37` declares `Finding`; no `PlanFinding` exists in the repository. An earlier EPIC draft named `PlanFinding` in this contract; `.agent/plan/epics/014-external-drive-contract.md:31` now names `Finding`.

Export three types and one function:

```ts
export type CompletenessParent = Readonly<{
  kind: NodeKind;
  key: string;
  path: string | null;
  id: string | null;
}>;

export type CompletenessChild = Readonly<{
  kind: NodeKind;
  parentKey: string | null;
}>;

export type CompletenessInput = Readonly<{
  subject: "document" | "record";
  parents: readonly CompletenessParent[];
  children: readonly CompletenessChild[];
}>;

export function completenessFindings(
  input: CompletenessInput,
): readonly Finding[];
```

The function is pure. It reads no clock, no file and no random source.

Its exact behaviour:

- Walk `parents` in input order. Emit at most one finding per parent, and return them in that order. Sort nothing.
- A parent of kind `task` emits nothing.
- A parent of kind `initiative` requires a child of kind `objective` whose `parentKey` equals the parent's `key`. When none exists, emit code `initiative-without-objective`.
- A parent of kind `objective` requires a child of kind `task` whose `parentKey` equals the parent's `key`. When none exists, emit code `objective-without-task`.
- The finding is `{ code, path: parent.path, id: parent.id, message }`.
- The message is `` `the ${parent.kind} holds no ${requiredChildKind}` `` when `subject` is `record`, and the same string with the suffix ` document` when `subject` is `document`. So the four reachable messages are exactly `the initiative holds no objective`, `the objective holds no task`, `the initiative holds no objective document` and `the objective holds no task document`. No message changes.
- An empty `parents` list returns an empty array. An empty `children` list emits one finding per non-task parent.

**The child kind is matched, and that is behaviour-preserving.** `src/domain/plan-candidate.ts:126,139` already matches the child kind. `src/domain/plan-validate.ts:244,257` matches only `derivedParentPath`, and adding the kind match there changes nothing for one reason: **the kind is derived from the path.** `src/domain/plan-validate.ts:156` assigns `kind: pathShape.kind`, so a `ParsedDocument` in `kindChecked` always carries the kind its path implies, and `src/domain/plan-path.ts:132-139` makes an objective's `derivedParentPath` always end in `initiative.md` and a task's always end in `objective.md`. Only an objective can name an initiative as its parent, and only a task can name an objective. The kind match is therefore tautological on this side.

Do not justify this with the branch at `src/domain/plan-validate.ts:172`. That branch compares `document.kind` against `pathShape.kind` after `:156` set them equal, so it is dead code and it filters nothing. Mention it in no comment and rely on it in no test.

### `src/domain/plan-validate.ts:241-268`

Delete the whole two-branch block and call the function once in its place, between the `parent-missing` loop that ends at line 240 and the dependency loop that starts at line 270:

```ts
findings.push(
  ...completenessFindings({
    subject: "document",
    parents: resolved.map((document) => ({
      kind: document.kind,
      key: document.path,
      path: document.path,
      id: null,
    })),
    children: kindChecked.map((document) => ({
      kind: document.kind,
      parentKey: document.derivedParentPath,
    })),
  }),
);
```

Add the import of `completenessFindings` from `./plan-completeness.ts`.

### `src/domain/plan-candidate.ts:123-150`

Delete the whole two-branch block and call the function once in its place, between the parent loop that ends at line 121 and the worker loop that starts at line 152:

```ts
findings.push(
  ...completenessFindings({
    subject: "record",
    parents: candidate.nodes.map((node) => ({
      kind: node.kind,
      key: node.id,
      path: null,
      id: node.id,
    })),
    children: candidate.nodes.map((node) => ({
      kind: node.kind,
      parentKey: node.parentId,
    })),
  }),
);
```

Add the import of `completenessFindings` from `./plan-completeness.ts`.

Both lists come from `candidate.nodes`, because a record checks a parent set against the same node set.

### `docs/proposal/phase-1/state-machine.md:47`

The line reads today: `An objective with no tasks, or an initiative with no objectives, is invalid. Import rejects it.`

Replace it with exactly:

```
An objective with no tasks, or an initiative with no objectives, is incomplete. Every write reports the finding and commits. A claim under an incomplete node is refused.
```

## Constraints

- **Behaviour and finding order do not change.** `src/domain/plan-validate.test.ts:1032-1035`, `src/domain/plan-candidate.test.ts:451-467`, `:469-479`, `:688-699` and `src/queries/plan/validate-plan.test.ts:528-544` must all pass with no edit.
- Refuse nothing new, and **relax nothing either.** `src/commands/plan/import-plan.ts:214-219` still throws `plan-invalid` whenever `validation.findings.length > 0`, and `:337-343` still throws `choices-invalid` on any candidate finding. Both branches stay exactly as they are.
- **The amended `state-machine.md:47` states the contract EPIC 017 implements, not the behaviour of the code after this epic.** After this story the document says every write reports a completeness finding and commits, while `import-plan.ts` still refuses one. That gap is deliberate and it is named in `013-external-drive-overview.md:19`, which assigns "Import accepts an incomplete graph and reports the finding instead of refusing" to EPIC 017. Do not close the gap here: this epic ratifies the contract, and EPIC 017 changes the two branches above. State the gap in the commit message so a reviewer does not read it as a defect.
- Add no branch that reads `findingScope`. EPIC 018 reads the map at the claim.
- **Build no structural validity function.** This story classifies codes by scope and extracts completeness only. EPIC 017 owns the structural function, because a per-node structural check needs the stored-graph read EPIC 017 owns.
- `plan-completeness.ts` imports only `./state.ts` and `./plan-finding.ts`. `src/domain/layout.test.ts:55-66` asserts every non-test file in `src/domain/` names no `Date.now(`, `new Date(` or `Math.random(`, and `eslint.config.js:230-247` allows only relative domain imports and `zod`.
- Do not sort inside `completenessFindings`. `sortFindings` at the end of each caller is the one ordering rule and it is unchanged.

## Verify

- Add `src/domain/plan-completeness.test.ts` with the suite name `"src/domain/plan-completeness.test"`.
- Assert both `subject` values for the empty-parent case: `{ subject, parents: [], children: [] }` returns `[]`.
- Assert both `subject` values for the empty-children case: one `initiative` parent and one `objective` parent, `children: []`, returns two findings in `parents` order, with codes `["initiative-without-objective", "objective-without-task"]`, and the exact messages for that subject.
- Assert both `subject` values for the satisfied case: an `initiative` parent keyed `A` with an `objective` child of `parentKey: "A"`, and an `objective` parent keyed `B` with a `task` child of `parentKey: "B"`, returns `[]`.
- Assert a `task` parent emits nothing under both subjects.
- Assert the wrong child kind does not satisfy a parent: an `initiative` parent keyed `A` with only a `task` child of `parentKey: "A"` still yields `initiative-without-objective`.
- Assert a child whose `parentKey` is `null` satisfies no parent.
- Assert `path` and `id` are copied from the parent: a parent with `path: "plan/i--01/initiative.md", id: null` yields a finding with those two values, and a parent with `path: null, id: "initiative_X"` yields the reverse.
- Assert output order equals `parents` order for three parents given in an order that is not sorted by key.
- Extend `src/domain/plan-finding.test.ts`. Assert `validationScopes` deep-equals `["structural", "completeness"]`. Assert `findingScope` is total: `Object.keys(findingScope).length === 24`, every member of `findingCodes` is a key, and every key is a member of `findingCodes`. Assert the completeness set equals exactly `["initiative-without-objective", "objective-without-task"]` by filtering `findingCodes` on `findingScope[code] === "completeness"`.
- `node --test src/domain/plan-completeness.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts` exits 0.
- `grep -c "is invalid. Import rejects it" docs/proposal/phase-1/state-machine.md` returns `0`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`, including `src/domain/plan-completeness.test.ts` and `src/queries/plan/validate-plan.test.ts` named explicitly in the Proof block. Hermetic coverage: the `findingScope` bullet at `.agent/plan/epics/014-external-drive-contract.md:93` and the `completenessFindings` bullet at `:94`.

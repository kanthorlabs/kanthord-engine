# Story 10 — choice completeness and containment legality

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 08 (`choiceVerdict`).

Every node carries a choice, and there is no implicit default (`docs/proposal/phase-1/plan-format.md:86`). A missing, extra or duplicate choice is `400 invalid-request`.

## Change

### 1. `src/domain/plan-choice-set.ts` (new — pure)

```ts
export type ChoiceSetErrorCode =
  "choice-duplicate" | "choice-missing" | "choice-extra";

export class ChoiceSetError extends Error {
  readonly code: ChoiceSetErrorCode;
  readonly ids: readonly string[];
}

export function assertChoiceSet(
  input: Readonly<{
    choices: readonly Readonly<{ id: string; take: Choice }>[];
    required: readonly string[];
  }>,
): ReadonlyMap<string, Choice>;
```

Three checks, in this order, each throwing with every offending id bytewise ascending in `ids`:

1. A repeated `id` in `choices` → `choice-duplicate`.
2. A member of `required` absent from `choices` → `choice-missing`.
3. A member of `choices` absent from `required` → `choice-extra`.

`required` is the union of the document identities and the database identities at the validated revision (`docs/proposal/api/graph.md:54`). All three map to `400 invalid-request` with `details.refusal` and `details.ids`.

The duplicate check runs first because it needs no database read, so a malformed body is refused before the transaction opens. The other two run inside the transaction, because `required` is a snapshot value.

### 2. `src/domain/plan-containment.ts` (new — pure)

```ts
export type ContainmentFacts = Readonly<{
  lease: boolean;
  workspace: boolean;
  attemptCommit: boolean;
  retainedCommit: boolean;
}>;

export function containmentMovable(
  kind: NodeKind,
  facts: ContainmentFacts,
): boolean;
```

`true` when all four members are `false`. The kind decides which reader the caller uses, not the verdict: a task uses `PlanStore.readContainmentFacts`, an objective and an initiative use `PlanStore.readSubtreeContainmentFacts`. `kind` is a parameter so the two call sites share one expression and neither can pick the wrong reader silently.

`plan-format.md:120-121` — a task changes parent only while `pending` or `blocked` and while it holds no lease, no workspace, no attempt commit and no retained commit; an objective changes parent, or changes `repo`, only when that holds for the objective **and for every descendant**.

### 3. The two readers are Story 02.5's

`PlanStore.readContainmentFacts` and `readSubtreeContainmentFacts` hold every statement, and `src/services/plan/sqlite.test.ts` holds every assertion over them. `ContainmentFacts` lives in `domain/` because the service interface, a command and a query all name it.

### 4. `src/queries/plan/validate-plan.ts` and `src/commands/plan/import-plan.ts` — the call sites

Both compute `containmentMovable` for every entry whose `fields` hold `parent` or `repo`, and pass it into `choiceVerdict`. The import recomputes it inside its own transaction, which is the `409 choices-changed` seam of Story 11.

## Constraints

- `src/domain/plan-choice-set.ts` and `plan-containment.ts` import only `domain/`. Neither holds SQL.
- `assertChoiceSet` throws on the first failing check, and the order is duplicate, missing, extra.
- `ids` in the error is bytewise ascending, so a refusal body is deterministic.

## Verify

`node --test src/domain/plan-choice-set.test.ts src/domain/plan-containment.test.ts`

Both modules are pure, so neither test opens a database. The two readers are covered by `src/services/plan/sqlite.test.ts` (Story 02.5).

### `plan-choice-set.test.ts`

- A complete set returns a map of the right size, and reading it by id returns the right `take`.
- One missing id throws `choice-missing` with `ids` deep-equal to that one id.
- Two missing ids throw with both, ascending.
- One extra id throws `choice-extra`.
- One duplicate id throws `choice-duplicate`.
- **The order is pinned.** A body with a duplicate, a missing and an extra id reports `choice-duplicate`. Removing the duplicate reports `choice-missing`. Removing the missing reports `choice-extra`. Three cases over one degrading input.
- An empty `required` with an empty `choices` returns an empty map.
- An empty `required` with one choice throws `choice-extra`.

### `plan-containment.test.ts`

- All four members `false` returns `true`, for each of the three kinds.
- Each of the four members set alone returns `false`, for each of the three kinds: twelve cases from one table.
- All four set returns `false`.
- The verdict does not vary with the kind: the same `facts` with `kind` varied returns the same value, asserted over the table. The kind selects the reader at the call site, and Story 11's test asserts that selection.

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-choice-set.test.ts` and `src/domain/plan-containment.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.

# Story 6 — Write legality, extracted once

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: EPIC 014 Story 3 (`choiceVerdict` accepts a structural change at `ready`).

## Change

### A new `src/domain/node-write-legality.ts`

**The field classifier moves here, and the dependency runs one way.** `nodeWriteLegality` needs `structuralFields` as a runtime value, and `choiceVerdict` calls `nodeWriteLegality`. Importing the tuple from `plan-choice.ts` would make the two modules mutually dependent. Move all three declarations out of `src/domain/plan-choice.ts:6-22` into this file — `proseFields`, `structuralFields`, the `differingFields` tuple and the `DifferingField` type — and re-export them from `plan-choice.ts` with a type-and-value re-export line, so `src/domain/plan-diff.ts:6` and `src/http/contract/graph.ts:22-26` keep their existing import paths and need no edit.

The file then imports `type NodeState` from `./state.ts` and nothing else.

```ts
export const nodeWriteRefusals = ["state", "containment"] as const;
export type NodeWriteRefusal = (typeof nodeWriteRefusals)[number];

export type NodeWriteFacts = Readonly<{
  state: NodeState;
  fields: readonly DifferingField[];
  containmentMovable: boolean;
}>;

export type NodeWriteLegality =
  | Readonly<{ legal: true }>
  | Readonly<{ legal: false; refusal: NodeWriteRefusal }>;

export function nodeWriteLegality(facts: NodeWriteFacts): NodeWriteLegality;
```

Its behaviour, in this exact order:

1. Compute `structural` as `facts.fields.some((field) => structuralFields.includes(field))`, using the `structuralFields` tuple this file now declares.
2. When `structural` is false, return `{ legal: true }`. A prose edit is legal at every state.
3. When `facts.state` is not one of `pending`, `ready` and `blocked`, return `{ legal: false, refusal: "state" }`.
4. When `facts.fields` holds `parent` or `repo` and `facts.containmentMovable` is false, return `{ legal: false, refusal: "containment" }`.
5. Return `{ legal: true }`.

Step 3 precedes step 4, so a `running` node with an immovable containment reports `state`, never `containment`. The order is normative and a test asserts it.

### `src/domain/plan-choice.ts:86-112`

Replace the structural branch of `choiceVerdict` with a call to `nodeWriteLegality`, mapping each outcome to the reason string that branch produces today:

- `{ legal: true }` → `{ suggested: "submitted", submitted: { legal: true, reason: null }, database }`.
- `{ legal: false, refusal: "containment" }` → `{ suggested: "database", submitted: { legal: false, reason: "the node or a descendant holds a lease, a workspace or a commit" }, database }`.
- `{ legal: false, refusal: "state" }` → `{ suggested: "database", submitted: { legal: false, reason: "a structural edit needs pending, blocked or ready" }, database }`.

Pass `{ state: facts.state, fields: facts.fields, containmentMovable: facts.containmentMovable }`.

**That last string is the EPIC 014 string, not the string in the repository today.** `014-external-drive-contract/03-structural-edit-at-ready.md:38` changes the literal from `a structural edit needs pending or blocked` to `a structural edit needs pending, blocked or ready`, and `:48` changes the two test literals at `src/domain/plan-choice.test.ts:172` and `:207` with it. Copy the EPIC 014 string; the pre-EPIC-014 string fails those two tests on this commit.

With the correct string, `src/domain/plan-choice.test.ts` and the assertions of `008-project-and-plan.md:64-65` stay green with no further edit. `plan-choice.ts` still holds exactly five reason values, per `014-external-drive-contract/03-structural-edit-at-ready.md:56`: this story moves two of them behind `nodeWriteLegality` and adds none.

**The three-state set is what keeps them green.** EPIC 014 Story 3 already set the `structural.ready` matrix row to `{ suggested: "submitted", legal: true }`. A `nodeWriteLegality` that refuses at `ready` fails those EPIC 014 tests on this commit.

## Constraints

- The file is pure. It reads no clock, no random source and no `node:` module. `src/domain/layout.test.ts:56-66` scans every non-test file in `src/domain/` for `Date.now(`, `new Date(` and `Math.random(`.
- `eslint.config.js:230-247` allows only relative domain imports and `zod` in `src/domain/`.
- `proseFields` and `structuralFields` keep their exact members. Only their declaration site moves, and `plan-choice.ts` re-exports them, so no consumer's import path changes.
- After the move, `src/domain/plan-choice.ts` imports `node-write-legality.ts` and `node-write-legality.ts` imports nothing from `plan-choice.ts`. Assert the one-way direction by source read.
- Do not change the prose branch of `choiceVerdict` at `:76-84`, the database-only branch at `:48-54`, the document-only branch at `:56-62` or the no-differing-field branch at `:64-70`.
- Do not change `containmentMovable` at `src/domain/plan-containment.ts:4`. The caller computes the boolean and passes it in.
- Declare `nodeWriteRefusals` as a tuple, so a test can assert the value set is exactly two members.

## Verify

Create `src/domain/node-write-legality.test.ts`, suite name `src/domain/node-write-legality.test`.

- `nodeWriteRefusals` deep-equals `["state", "containment"]` and its length is `2`.
- A prose-only edit is legal at all eight states: drive `fields: ["title"]` and `fields: ["body"]` over every member of `nodeStates` from `src/domain/state.ts`, with `containmentMovable: false`, and assert `{ legal: true }` for all sixteen calls.
- A structural edit is legal at exactly three states: drive `fields: ["depends_on"]` with `containmentMovable: true` over all eight states; assert `{ legal: true }` at `pending`, `ready` and `blocked`, and `{ legal: false, refusal: "state" }` at `running`, `awaiting_approval`, `done`, `partial` and `discarded`.
- `containmentMovable: false` refuses a `parent` edit and a `repo` edit at `pending`, `ready` and `blocked`, with refusal `containment`, one assertion per field per state.
- `containmentMovable: false` does **not** refuse a `depends_on` edit or a `worker` edit; both return `{ legal: true }` at the three legal states.
- The refusal order is pinned: `{ state: "running", fields: ["parent"], containmentMovable: false }` returns refusal `state`, never `containment`.
- An empty `fields` array returns `{ legal: true }` at all eight states.
- A mixed edit is structural: `fields: ["title", "parent"]` at `running` returns refusal `state`.
- `node --test src/domain/node-write-legality.test.ts src/domain/plan-choice.test.ts src/domain/layout.test.ts` exits 0.
- `src/domain/plan-choice.test.ts` passes with **no edit**, including the EPIC 014 case named "ready accepts a structural change" and the `structural.ready` matrix row.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-017`, through `src/domain/node-write-legality.test.ts` and `src/domain/plan-choice.test.ts`. Hermetic coverage bullets `.agents/plan/epics/017-per-node-graph-write.md:153` and `:158`.

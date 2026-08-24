# Story 09 — candidate graph validation

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 05 (`validateDocuments`), Story 08 (`choiceVerdict`, and `plan.validate` returning local suggestions).

Two legal choices can build a graph that neither side authored (`docs/proposal/phase-1/plan-format.md:127`). The daemon builds the whole candidate and re-runs the full validation over it, and it applies nothing unless the whole candidate is valid.

## Change

All three functions live in one pure domain module, `src/domain/plan-candidate.ts`, because both `plan.validate` (a query) and `plan.import` (a command) call all three and the two may not import each other. The `Graph` capability arrives as the two plain function types Story 05 declared, `CycleFinder` and a matching `ComponentFinder`.

### 1. `src/domain/plan-candidate.ts` — `buildCandidate`

```ts
export type CandidateNode = Readonly<{
  id: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  instructionBlob: string;
  acceptanceBlob: string | null;
  worker: string | null;
  repositoryId: string | null;
  dependencies: readonly string[];
  source: "submitted" | "database";
}>;

export type Candidate = Readonly<{
  nodes: readonly CandidateNode[];
}>;

export function buildCandidate(
  input: Readonly<{
    submitted: readonly ResolvedDocument[];
    stored: readonly StoredNode[];
    choices: readonly Readonly<{ id: string; take: Choice }>[];
    blobHashes: ReadonlyMap<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >;
  }>,
): Candidate;
```

Per identity of the choice set:

- `take === "submitted"` and the identity is in `submitted` → the submitted node.
- `take === "submitted"` and the identity is only in `stored` → the node is **dropped**. A `database-only` node taking `submitted` means deletion, which is illegal, so the caller has already refused; `buildCandidate` drops it so the illegality is visible as a broken reference rather than as a silent retention.
- `take === "database"` and the identity is in `stored` → the stored node.
- `take === "database"` and the identity is only in `submitted` → the node is **dropped**. That is "do not create it" (`plan-format.md:101`).

`nodes` is bytewise ascending by `id`. A node's `dependencies` are kept as its own side wrote them, which is what produces the cycle of the normative example: the database holds `B → A`, the document holds `A → B`, `A` takes `submitted` and `B` takes `database`, and both edges exist.

A dependency naming a dropped identity survives into the candidate. `validateCandidate` reports it as `reference-unresolved`, which is the correct finding: the human asked for an edge to a node the choice set does not create.

### 2. `src/domain/plan-candidate.ts` — `validateCandidate`

```ts
export function validateCandidate(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[];
```

The full validation over the candidate, using the same `Finding` codes as Story 05. Every check that does not need a document:

- containment: an `initiative` with a non-null parent, an `objective` or `task` with a null parent, a parent naming a dropped or absent identity → `parent-missing`;
- `objective-without-task`, `initiative-without-objective`;
- `repo-on-task`, `repo-missing`;
- `worker-unknown`, `repository-unknown`, `repository-unbound`;
- `reference-unresolved` for a dependency naming an absent identity;
- `dependency-self`, `dependency-cross-parent`;
- `dependency-cycle` from `findCycles`;
- `identity-kind-mismatch` for one ULID payload under two kind prefixes across the candidate.

Findings pass through `sortFindings`. The document-shaped codes — `path-*`, `document-unparsable`, `frontmatter-invalid`, `acceptance-*`, `identity-invalid`, `identity-duplicate`, `reference-ambiguous` — cannot arise from a candidate and are never emitted here. A test asserts that the emitted code set is a subset of the twelve above.

### 3. `src/domain/plan-candidate.ts` — `repairSuggestions`

```ts
export type ComponentFinder = (
  input: Readonly<{
    nodes: readonly Readonly<{ id: string; parentId: string | null }>[];
    edges: readonly Readonly<{ from: string; to: string }>[];
  }>,
) => readonly (readonly string[])[];

export function repairSuggestions(
  dependencies: Readonly<{
    findCycles: CycleFinder;
    findComponents: ComponentFinder;
  }>,
  input: Readonly<{
    submitted: readonly ResolvedDocument[];
    stored: readonly StoredNode[];
    verdicts: ReadonlyMap<string, ChoiceVerdict>;
    blobHashes: ReadonlyMap<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >;
    context: ValidationContext;
  }>,
): ReadonlyMap<string, Choice>;
```

The loop of `plan-format.md:131`:

1. Start from the local suggestion of every verdict.
2. `buildCandidate`, then `validateCandidate`.
3. No finding → return the set.
4. Otherwise take `findComponents` over the candidate — undirected, over the dependency edges and the containment pairs (Story 02) — and for every component holding a node named by a finding, set **every** node of that component to `database`.
5. Repeat.

A node already at `database` is unchanged, so each iteration moves at least one node to `database` or the finding set is empty. The all-`database` set is the stored graph, which is valid by construction, so the loop terminates. The iteration cap is the choice-set size, and exceeding it throws — that is a defect in this module, not a rejection of the human's plan.

Components are visited in the bytewise order `findComponents` returns, so the same input produces the same repaired set.

A finding whose `id` is `null` names no node. In that case every component is reset, which is the whole choice set falling to `database`. That is the safe direction and the only one available.

### 4. `src/queries/plan/validate-plan.ts` — replace step 8

Story 08 ships step 8 as "`suggested` is the local verdict". This story replaces it with a `repairSuggestions` call, so each `ChoiceEntry.suggested` becomes the repaired value. `submitted.legal` and `database.legal` stay the **local** verdict, because legality is a property of the node and the repair is a property of the set.

Two assertions in `src/queries/plan/validate-plan.test.ts` move with it: the re-import case whose every entry suggests `database` is unchanged, and a new case asserts that the normative cycle input returns a repaired set rather than the local combination. Story 08's other assertions are unaffected, because a valid local set is returned unchanged.

## Constraints

- `src/domain/plan-candidate.ts` imports only `domain/`. The graph capability arrives as two function parameters, never as the `Graph` interface.
- `validateCandidate` is the same finding vocabulary as Story 05. No second code list exists.
- `buildCandidate` drops rather than throws. Illegality is reported by the validator, never by the builder.
- `repairSuggestions` never moves a node to `submitted`. It only resets to `database`.
- The repaired set is what `plan.validate` returns, and the raw local suggestion is not returned anywhere. A client must never be handed a combination the import will reject.
- Determinism: components in `findComponents` order, nodes bytewise, findings through `sortFindings`.

## Verify

`node --test src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts`

`findCycles` and `findComponents` come from `createPlanGraph()` in `test/helpers/plan.ts`, which returns the real `GraphologyGraph` — a fake would re-implement Tarjan, and `AGENTS.md`'s test rule forbids a domain test from importing the implementation directly. No storage: all three functions are pure over their input. The suite holds three nested `describe` blocks, one per function.

### `buildCandidate`

- All `submitted` on a document-only set returns every submitted node, ascending by id.
- All `database` on a stored set returns every stored node.
- A `database-only` node taking `submitted` is dropped.
- A `document-only` node taking `database` is dropped.
- A mixed set returns the right `source` per node, asserted as an exact table.
- **The cycle construction.** Stored holds `B → A`; submitted holds `A → B` and no `B → A`. `A: submitted`, `B: database` produces a candidate whose edge set holds both pairs. Asserted on the two nodes' `dependencies` arrays.
- A dependency naming a dropped identity survives in `dependencies`.

### `validateCandidate`

- A valid candidate returns `[]`.
- **The cycle case is refused.** The candidate built above returns exactly one `dependency-cycle` naming both ids.
- Each of the twelve emitted codes is produced by one named case.
- The emitted code set over the whole suite is a subset of the twelve, asserted as a set difference against `findingCodes`.
- An objective whose `repo` is known but unbound returns `repository-unbound`.
- A task whose parent was dropped returns `parent-missing`.
- Findings are returned sorted, asserted on a case producing three.

### `repairSuggestions`

- A set whose local suggestions build a valid graph is returned unchanged.
- **The normative cycle.** Stored `B → A`, submitted `A → B`, with `A` locally suggesting `submitted` and `B` locally suggesting `database`: the repaired set has both at `database`, and `validateCandidate` over the repaired set returns `[]`. This is the EPIC's coverage line "the suggestion set for that same input is not that combination", asserted directly.
- The reset is by component, not by node: a third node in the same component and with no finding of its own is also reset to `database`.
- A node in a **different** component keeps its `submitted` suggestion. This is what makes the repair minimal, and it is the assertion that a whole-set reset would fail.
- Two independent invalid components are both reset in one pass, and the result is valid.
- A repair needing two iterations terminates: construct a set where resetting component one makes a reference in component two unresolved. Assert the final set is valid and that both components are at `database`.
- The all-`database` set is always valid, asserted on a seeded stored graph with an empty submission.
- Determinism: every case runs twice and the two maps `deepEqual`, and a case run with the `submitted` array reversed returns the same map.
- A finding with a `null` id resets every node.

### `validate-plan.test.ts` — the two cases this story adds

- The re-import case whose every entry suggested `database` still does.
- **The normative cycle through the route.** The database holds `B → A`, the submitted documents hold `A → B`: the returned suggestion set is not `{A: submitted, B: database}`, and feeding the returned set to `validateCandidate` yields `[]`. That is the EPIC's "the suggestion set for that same input is not that combination" line, asserted at the level a client sees.

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-candidate.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.

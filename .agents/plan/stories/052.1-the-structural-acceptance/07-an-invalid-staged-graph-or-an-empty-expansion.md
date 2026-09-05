# Story 7 — An invalid staged graph or an empty expansion

Epic: `.agents/plan/epics/052.1-the-structural-acceptance.md`
Depends on: Story 5 (`05-an-unresolved-reference-reaches-the-resolver`), for the pinned graph, the
staged graph and the three shape verdicts; Story 6 (`06-a-fixed-pair-refuses-before-the-validator`),
for the pair policy that precedes validation; EPIC 052 Story 4 (`04-the-two-structural-policies`),
for `expansionVerdict`.
Kind: story-implement

Diagrams: accept-structural-refusal-graph-invalid

Seams: accept-structural-refusal-graph-invalid: +plan.newestRevision, +plan.readGraph, +plan.readValidationContext, +graph.cycles

This story adds the shipped structural validator and the at-least-one-child rule that follows it.
Story 8 (`08-an-ineligible-delete-refuses`) adds the delete guard, and Story 9
(`09-the-accepted-patch`) adds the writes.

## The path

`acceptStructural` is written from nothing, so this diagram has an empty prior set, it draws no
`baseline-` diagram, and all four of its tokens are `+`.

### `accept-structural-refusal-graph-invalid`

Fixture: a claimed expansion node `N` running under run `R`, the pinned revision equal to the newest,
`N` holding two children `C1` and `C2` with the one edge `C1 -> C2`, and a patch that replaces `C2`'s
`dependsOn` with `[C1]` while leaving `C1`'s `dependsOn` as `[C2]`. The staged graph therefore holds
the two-node cycle `C1 -> C2 -> C1`, and every earlier verdict passes because both ids are inside the
claimed subtree and inside the project, no pair changes, and the patch holds no `delete`.

The `expansion-empty` case reuses the fixture with the patch replaced by one `create` whose final
parent is a node other than `N`, over a pinned `N` that holds no child. **It holds no `delete`
either**, so `plan.structuralDeleteBindings` does not fire between step 4 and its terminal, and the
two refusals stop at the same step.

```mermaid
sequenceDiagram
    participant Caller
    participant Command
    participant Plan
    participant Graph
    Caller->>Command: acceptStructural
    Command->>Plan: 1 plan.newestRevision
    Command->>Plan: 2 plan.readGraph
    Command->>Plan: 3 plan.readValidationContext
    Command->>Graph: 4 graph.cycles
    Command-->>Caller: refuse:plan-invalid
```

**Step 4 is the only message the validator makes.** `validateCandidateStructural` is a pure domain
function, so its own decisions are invisible at this seam. It reaches the recorder exactly once,
through the `findCycles` capability the command injects, and
`src/domain/plan-candidate.ts:292` — `findCycles` calls it once per validation.

**Two refusals stop at step 4, so they are one diagram.** `plan-invalid`, whatever finding carries
it, and `expansion-empty` are both decided by pure predicates after step 4. `findingScope` at
`src/domain/plan-finding.ts:44` — `findingScope` scopes every structural finding to the one code, so
`pair-illegal` is a finding here and not a second refusal:
`src/domain/plan-finding.ts:59` — `pair-illegal` is scoped `structural`. The diagram states the first
terminal, and cases 1, 3, 6 and 10 carry the code that separates them.

**`expansion-empty` is group 10 and `patch-delete-ineligible` is group 9, and the two are not
reordered here.** The declared `expansion-empty` fixture holds no `delete`, so the group-9 seam is
not reached on it. A patch that is both delete-ineligible and expansion-empty refuses
`patch-delete-ineligible`, which Story 8 (`08-an-ineligible-delete-refuses`) case 3 asserts.

**The drawn set is every branch of this path.** A fixture of either refusal that also names an
unresolved id, changes a pair, or holds a `delete` reaches a longer trace; each is asserted by a case
rather than drawn, per `.agents/plan/authoring.md:187`, and case 9 carries the resolver one.

Add `test/sequence/scenarios/accept-structural-refusal-graph-invalid.ts`.

## Change

**`src/commands/checkpoint/accept-structural.ts` — express the staged graph as a `Candidate` and pass
it to the shipped validator, exactly as `create-node` does.**

### 1 — the validation context and the candidate

```ts
const context = dependencies.plan.readValidationContext(
  transaction,
  input.node.projectId,
);
const candidate: Candidate = { nodes: staged.nodes.map(toCandidateNode) };
```

`src/services/plan/index.ts:90` — `readValidationContext` returns `workerKinds`,
`boundRepositories` and `knownRepositories`. `toCandidateNode` maps one staged node to the
`CandidateNode` shape at `src/domain/plan-candidate.ts:15` — `CandidateNode`, carrying `source:
"database"` for a node the pinned graph already held and `source: "submitted"` for one the patch
creates. `repositoryId` on a `CandidateNode` is the repository **name**, as
`src/commands/node/create-node.ts:212` — `repositoryId` shows, so the map resolves each id to its name
from the rows `readValidationContext` already named.

**`CandidateNode` requires three fields the staged graph does not carry, and each has one source.**
`StagedNode` holds nine fields and none of `title`, `instructionBlob` or `acceptanceBlob`.

| field             | source                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `title`           | the mutation, when it names `title`; the pinned row otherwise                                     |
| `instructionBlob` | `dependencies.blobs.hash(encoder.encode(prose))` for named prose; the pinned row's hash otherwise |
| `acceptanceBlob`  | the same rule, and `null` for a node that is not a task                                           |

**The hash is read, and the blob is not written.** `src/services/blob/index.ts:24` — `hash` computes a
content hash and writes nothing, and `src/services/blob/sqlite.ts:24` — `put` returns that same hash
for the same bytes. So the candidate carries the true hash of a node the patch creates, while every
`blobs.put` stays after the last refusal, which is the epic's Decision at
`.agents/plan/epics/052.1-the-structural-acceptance.md:62` — `orphan`. A fabricated empty string would
be inert — nothing structural reads the field — and it would still be a false value in a domain value.

`blobs.hash` is a seam call, so a patch that creates a node with prose draws it. **No fixture of this
epic creates such a node**: this story's patch replaces a `dependsOn` list, Story 6
(`06-a-fixed-pair-refuses-before-the-validator`)'s changes a
`deliverable`, and Story 9 (`09-the-accepted-patch`)'s changes a `title`. The create path's hash calls are asserted by Story 9
(`09-the-accepted-patch`) case 8.

### 2 — the validator, and the shipped refusal

```ts
const findings = validateCandidateStructural(
  { findCycles: (graphInput) => dependencies.graph.cycles(graphInput) },
  { candidate, context },
);
if (findings.length > 0) {
  throw new AcceptStructuralError(
    "plan-invalid",
    "the patch builds an invalid graph",
    { findings },
  );
}
```

`src/commands/node/create-node.ts:220` — `validateCandidateStructural` is the shipped call, and
`src/commands/node/create-node.ts:226` — `plan-invalid` is the shipped refusal with its `findings`
details. This epic adds no second code for a condition the validator already names.

**Completeness is not checked here.** `validateCandidateStructural` at
`src/domain/plan-candidate.ts:304` — `validateCandidateStructural` filters to the `structural` scope,
so `initiative-without-objective` and `objective-without-task` never reach this refusal.
`.agents/plan/epics/052.1-the-structural-acceptance.md:26` — `claim-node.ts` states this epic touches
neither the claim nor `src/domain/plan-completeness.ts`, and section 3 below is what bounds the
exemption instead.

### 3 — the at-least-one-child rule

```ts
const empty = expansionVerdict({
  claimedNodeId: input.node.id,
  stagedGraph: staged,
});
if (empty !== null) {
  throw new AcceptStructuralError(
    "expansion-empty",
    empty.message,
    empty.details,
  );
}
```

`.agents/plan/epics/052-the-graph-patch-and-its-policies.md:55` — `expansionVerdict` refuses when the
claimed node holds no direct child in the **staged** graph, whatever it held at claim time. The rule
is unconditional and reads the staged graph alone.
`../docs/workflow/worker.md:385` — `expansion` states that an accepted expansion checkpoint creates
at least one child, and that this closes the completeness exemption of
`src/commands/node/claim-node.ts:180` — `expansion`.

**The delete guard is inserted above this block by Story 8
(`08-an-ineligible-delete-refuses`), not below it.** The refusal order at
`.agents/plan/epics/052.1-the-structural-acceptance.md:49` puts `patch-delete-ineligible` at group 9
and `expansion-empty` at group 10. This story writes this block directly after the validator; that
story inserts its guard between the two, and its case 3 asserts the precedence.

## Constraints

- `plan.readValidationContext` is called once, after the three shape verdicts and after the pair
  policy, and before the validator.
- `expansionVerdict` reads the staged graph alone. It takes no pinned graph and never the mutation
  set, so it counts neither history nor `create` mutations by construction.
- `graph.cycles` reaches the recorder exactly once. A second call is a duplicate token the parser
  refuses, and it is also a second answer to one question inside one transaction.
- The refusal carries `{ findings }` and nothing else, matching
  `src/commands/node/create-node.ts:228` — `findings`.
- No finding code becomes a refusal code of its own.

## Verify

```
node --test src/commands/checkpoint/accept-structural.test.ts test/sequence/conformance.test.ts
```

Extend `src/commands/checkpoint/accept-structural.test.ts`. Use the real `GraphologyGraph` through
`createPlanGraph` at `test/helpers/plan.ts:136` — `createPlanGraph`, never the stub at
`test/helpers/graph.ts:27` — `createGraphService`, because that stub returns `[]` for `cycles` and
would make case 1 pass against a validator that finds nothing.

Add, each as a separate `it`:

1. `"a staged dependency cycle refuses plan-invalid carrying the dependency-cycle finding"` — the
   fixture states the exact initial edge set `[C1 -> C2]` and the exact final closure
   `[C1 -> C2, C2 -> C1]`. Assert `error.refusal` is `"plan-invalid"` and that
   `error.details.findings.map((finding) => finding.code)` deep-equals `["dependency-cycle"]`.

2. `"a patch removing edge A to B while adding B to A passes"` — the same two children, the patch
   replacing `C1`'s `dependsOn` with `[]` and `C2`'s with `[C1]`. Assert the command returns a result
   and throws nothing. Cases 1 and 2 are the epic's gate row 13: staging judges the final graph, never
   a transient one.

3. `"a created node whose kind and deliverable are an illegal pair refuses plan-invalid carrying
pair-illegal"` — a `create` of a task whose `deliverable` is `expansion`, which
   `src/domain/node-pair.ts:54` — `expansion` refuses. Assert `error.refusal` is `"plan-invalid"` and
   the finding codes deep-equal `["pair-illegal"]`. This is the epic's gate row 14: the pair table
   reaches the patch through the shipped validator and not a second code.

4. `"a created node carries the true hash of its instruction prose in the candidate"` — a patch
   creating one node with prose. Assert the `CandidateNode` the command built holds
   `blobs.hash(encoder.encode(instruction))` by value, and assert the `blob` table is unchanged, so
   the hash is read and nothing is written before validation.

5. `"the plan-invalid refusal reads the context and the cycles once each"` — case 1 behind the
   recorder. Assert `recorder.tokens` deep-equals
   `["plan.newestRevision", "plan.readGraph", "plan.readValidationContext", "graph.cycles"]`.

6. `"a childless expansion claim whose patch creates no direct child refuses expansion-empty"` — a
   claimed node with no child in the pinned graph, and a patch whose only `create` is finally
   parented on a node other than the claimed node. Assert `error.refusal` is `"expansion-empty"`.
   This is the epic's gate row 16.

7. `"the control: the same patch leaving the created node under the claimed node passes"` — without
   it, case 6 passes for a command that refuses `expansion-empty` unconditionally.

8. `"the expansion-empty refusal stops at the same step as plan-invalid"` — case 6 behind the
   recorder. Assert `recorder.tokens` deep-equals
   `["plan.newestRevision", "plan.readGraph", "plan.readValidationContext", "graph.cycles"]`, the
   identical list case 5 asserts. This is what makes the two refusals one diagram.

9. `"an unresolved dependsOn entry no project holds reaches plan-invalid"` — the Story 5
   (`05-an-unresolved-reference-reaches-the-resolver`) case 1 fixture with the foreign node removed
   from the second project. Assert `error.refusal` is `"plan-invalid"` and that the finding codes
   deep-equal `["reference-unresolved"]`, and behind the recorder assert `recorder.tokens`
   deep-equals `["plan.newestRevision", "plan.readGraph", "plan.nodeProjects",
"plan.readValidationContext", "graph.cycles"]`. This is the control Story 5
   (`05-an-unresolved-reference-reaches-the-resolver`) case 3 names, owned here
   because this is the story that raises `plan-invalid`, and it is the reachable trace this diagram
   does not draw.

10. `"a task parented under an atomic objective refuses plan-invalid carrying pair-shape-violated"` —
    an `update` that reparents an existing task under an objective whose `deliverable` is
    `implementation`. Assert `error.refusal` is `"plan-invalid"` and the finding codes deep-equal
    `["pair-shape-violated"]`. Then the same reparent under an objective whose `deliverable` is
    `expansion` returns a result. This is the epic's gate row 14a, and the second half is the control
    that proves the rule is not vacuous.
    `docs/proposal/phase-2/deliverables-and-pairs.md:28` — `Shape and children` states the rule.

Add `test/sequence/scenarios/accept-structural-refusal-graph-invalid.ts`, building the
`plan-invalid` fixture the diagram names, running the real `acceptStructural` directly over real SQLite and the real
`GraphologyGraph` behind the recorder, and catching the `AcceptStructuralError` and returning it as
`result`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/checkpoint/accept-structural.test.ts` in
`PASS EPIC-052.1`.

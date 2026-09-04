# EPIC 052 — The graph patch and its policies — stories

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Prereq: EPIC 051.6 (sequence order). No story of this epic reads anything from it. Story 5
(`05-the-seams-the-acceptance-needs`) reads EPIC 051 Story 1 (`01-migration-13`) and EPIC 051.3
Story 1 (`01-migration-14`) for the `checkpoint` table, and EPIC 051.3 Story 2
(`02-the-checkpoint-row`) for `WriteCheckpointInput`, `CheckpointRecord` and the `checkpoint`
identity kind. Stories 1 to 4 read nothing outside this epic.

The mutation set is a value with settled legality, and nothing consumes it yet.

## One story, one path

**No story of this epic draws a diagram.** All five are `story-foundation`: three add pure-domain
modules, one appends two pure functions to two of them, and one widens two service interfaces and
their implementations. Nothing here opens a transaction and nothing here is a command, so no seam
trace moves. `.agents/plan/authoring.md:92` makes that a declared decision rather than an omission,
and `.agents/plan/authoring.md:94` makes the epic's gate the proof.

The paths this work will change are drawn by EPIC 052.1, which owns `acceptStructural` and its seven
diagrams.

This epic holds no story `00`. Every path its stories edit is `src/domain/**` or
`src/services/**`, and `scripts/lane-check.sh` allows each one to both TDD engineers, so no locked
path exists and no groundwork story is manufactured.

## Dispatch order

**1, 2, 3, 4, 5.** The order is forced at the head, and no story depends on a later one.

- **Story 1 first.** It declares `graphPatch`, `GraphPatch` and `GraphMutation`, which Stories 2, 3
  and 4 all read. It reads nothing.
- **Story 2 second.** It creates `src/domain/graph-patch-stage.ts` and declares `PatchGraph`,
  `StagedNode`, `StagedEdge` and `StagedGraph`. Stories 3 and 4 both read those four types, and
  Story 4 appends to that file.
- **Story 3 third.** It reads Story 2's types and its test file reuses no file Story 4 touches.
- **Story 4 fourth.** It appends `expansionVerdict` to Story 2's module and `pairChangeVerdict` to
  `src/domain/node-pair.ts`, and it extends Story 2's test file. Running it after Story 3 keeps one
  writer per file per turn.
- **Story 5 anywhere, and last by dependency weight.** It shares no file with Stories 1 to 4 and no
  story of this epic depends on it. It is last because it is the one story blocked on two unshipped
  migrations, so a blocked dispatch stops nothing else.

**Two stories reach one test file.** Story 4 case 4 onward extends
`src/domain/graph-patch-stage.test.ts`, which Story 2 creates. Both assignments come from the epic's
own gate — rows 6 to 8 name Story 2 and rows 15 to 18 name Story 4 — and a test file is one lane, so
no dispatch conflict follows.

## Stories

- 1 — the patch shape, its canonical form and the duplicate-id verdict → `01-the-patch-shape-and-its-canonical-form.md` — draws nothing
- 2 — the staged graph, its two types and target legality → `02-the-staged-graph-and-target-legality.md` — draws nothing
- 3 — the three scope rules and the project rule that must precede the validator → `03-scope-and-project.md` — draws nothing
- 4 — the pair-fixed and expansion-empty policies → `04-the-two-structural-policies.md` — draws nothing
- 5 — the `NodeWrite` fields, the structural checkpoint write and its predicate → `05-the-seams-the-acceptance-needs.md` — draws nothing

## Gate rows, by owner

Every row of the epic's hermetic-coverage list is delivered by a numbered case, and every case
either delivers a row or is the control a row's own text demands.

| story | numbered case | gate row | note                                          |
| ----- | ------------- | -------- | --------------------------------------------- |
| 1     | 1             | 1        |                                               |
| 1     | 2             | 2        |                                               |
| 1     | 3             | none     | the control for case 2                        |
| 1     | 4             | none     | pins the tuple case 2 reads                   |
| 1     | 5             | 3        | both codes in one case, as the row asks       |
| 1     | 6             | none     | the control for case 5                        |
| 1     | 7             | 4        |                                               |
| 1     | 8             | none     | the omit-versus-null rule                     |
| 1     | 9             | 5        | one case, as the row asks                     |
| 1     | 10            | none     | the control for case 9                        |
| 1     | 11            | none     | non-ASCII order and the round trip            |
| 2     | 1 to 4        | 6        | one quarter of the row each                   |
| 2     | 5             | none     | the one-representation control                |
| 2     | 6             | none     | a dangling reference survives staging         |
| 2     | 7 to 9        | 7        | three cases, as the row asks                  |
| 2     | 10            | none     | the control for cases 7 to 9                  |
| 2     | 11            | 8        |                                               |
| 2     | 12            | none     | the control for case 11                       |
| 3     | 1             | 9        |                                               |
| 3     | 2             | none     | the control for case 1                        |
| 3     | 3             | 10       | both directions in one case, as the row asks  |
| 3     | 4             | none     | a created parent chain is in scope            |
| 3     | 5             | 11       |                                               |
| 3     | 6             | none     | the control for case 5                        |
| 3     | 7             | 12       |                                               |
| 3     | 8             | none     | the third way a mutation reaches a foreign id |
| 3     | 9             | 13       | the row that proves the ordering ruling       |
| 3     | 10            | none     | the control for cases 7 to 9                  |
| 3     | 11            | none     | an unresolved id is not the project refusal   |
| 3     | 12            | none     | the walk terminates on a parent cycle         |
| 4     | 1 to 3        | 14       | three cases from the one predicate            |
| 4     | 4, 5          | 15       | one half of the row each                      |
| 4     | 6             | 16       |                                               |
| 4     | 7             | 17       |                                               |
| 4     | 8             | 18       |                                               |
| 4     | 9             | none     | the direct-child control                      |
| 5     | 1             | 19       |                                               |
| 5     | 2             | 20       | extends a shipped case, plus its control      |
| 5     | 3             | 21       | a build-only check plus four runs             |
| 5     | 4             | 22       |                                               |
| 5     | 5             | none     | the control for case 4                        |
| 5     | 6             | 23       |                                               |
| 5     | 7             | 24       | **blocked; write no case until ruled**        |
| 5     | 8             | 25       |                                               |
| 5     | 9             | none     | the control for case 8                        |

**A numbered case is one `/work` turn, and it is not always one `it`.** Story 5 case 3 is a
build-only check and four named runs, because gate row 21 asks for exactly that. Story 5 case 2
holds two assertions, because its row's own text names the preservation and this authoring adds the
overwrite control that makes it non-vacuous.

**Fifty-three cases across five stories, and twenty of them carry no gate row.** Every one of the
twenty is a control, and every one is demanded by `.agents/plan/authoring.md` — a proof whose only
oracle is absence ships with a case proving the assertion detects a nearby forbidden case. Most of
this epic's rows are refusals, and a refusal asserted alone passes for a function that refuses
everything.

## Facts (needed for implementation)

- **There is no graph type in `src/domain/`.** `src/domain/plan-graph.ts:3` — `StoredNode` and
  `src/domain/plan-graph.ts:24` — `StoredEdge` are the only node and edge shapes, and the pair is
  written inline at `src/services/plan/index.ts:71` — `readGraph`. Story 2 declares `PatchGraph`.
- **`readGraph` is project-scoped by SQL.** `src/services/plan/sqlite.ts:154` — `project_id`. A node
  of another project is absent from a `PatchGraph`, which is why `patchProjectVerdict` takes a
  cross-project projection and not the graph.
- **`StoredNode.dependencies` is derived from the edge rows**, at
  `src/services/plan/sqlite.ts:162` — `buildNodes`, so the staged graph carries one representation
  and derives the other.
- **The structural validator reads nine node fields and no blob.**
  `src/domain/plan-candidate.ts:96` — `validateCandidate` reads `id`, `kind`, `parentId`, `worker`,
  `repositoryId`, `deliverable`, `verifyJson`, `dependencies` and the candidate node set. Nothing
  structural reads `title`, `instructionBlob` or `acceptanceBlob`.
- **`CandidateNode` carries no `projectId`**, at `src/domain/plan-candidate.ts:15` — `CandidateNode`,
  while `StoredNode` does, at `src/domain/plan-graph.ts:5` — `projectId`.
- **`src/domain/` holds no downward walk.** The three subtree reads are recursive CTEs; the closest
  is `src/services/plan/sqlite.ts:330` — `readSubtree`. The one domain hierarchy walk is upward, at
  `src/domain/plan-ancestry.ts:10` — `terminalAncestor`, and its `seen` guard is at
  `src/domain/plan-ancestry.ts:17` — `seen`.
- **`src/domain/` holds no children helper.** Every caller filters `parentId` inline —
  `src/commands/outcome/aggregate-initiative.ts:36` — `parentId` and
  `src/commands/node/claim-node.ts:656` — `parentId`. The seam-level
  `src/services/graph/index.ts:67` — `children` is a service the domain may not import.
- **`Buffer.compare` is already a domain idiom**, at
  `src/domain/readiness.ts:83` — `Buffer.compare` and
  `src/domain/lease-hierarchy.ts:76` — `Buffer.compare`. `src/domain/plan-path.ts:106` —
  `comparePaths` is the different, code-point comparator, and `renderVerifyBlock` uses it.
- **A pure-domain refusal needs no registration.** `src/domain/node-write-legality.ts:3` —
  `nodeWriteRefusals` appears in no registry. `src/http/contract/errors.ts:7` — `errorStatuses`
  drives `src/cli/exit-code.ts:13` — `exitCodes` through a `Record<ErrorCode, number>`, so a code
  added there forces an exit code, and EPIC 052.1 Story 9 (`09-the-contract-and-the-proposal`) owns
  both.
- **The two-space, one-trailing-newline canonical form ships at**
  `src/services/home-lock/identity.ts:3` — `renderIdentity`, and its byte-exact test with a
  different-key-order companion is at
  `src/services/home-lock/identity.test.ts:16` — `renderIdentity`.
  `src/domain/plan-hash.ts:5` — `canonicalDocumentsJson` is the destructure-and-rebuild key
  normalisation; there is no generic recursive key sorter in the tree.
- **The has-flag write is key presence, not value.**
  `src/services/plan/sqlite.ts:435` — `hasDeliverable` reads `Object.hasOwn`, and
  `src/services/plan/sqlite.ts:46` — `CASE` is the upsert arm it drives. A caller that spreads a
  pinned node sets both keys and overwrites both columns.
- **Gate row 20 is already shipped**, at `src/services/plan/sqlite.test.ts:711` — `it`. Gate row 19's
  nearest sibling is `src/services/plan/sqlite.test.ts:558` — `it`, which passes both fields through
  a `const` binding and therefore escapes excess-property checking. Story 5 case 1 inlines the
  literal, which is what makes the seam change observable.
- **`Execution` has three implementations**, not one:
  `src/services/execution/sqlite.ts:92` — `SqliteExecution`,
  `test/helpers/execution.ts:43` — `Execution` and
  `test/helpers/execution.ts:247` — `Execution`. No `as Execution` escape exists.
- **`src/services/execution/sqlite.ts` has no boolean method today.** The shipped existence idiom is
  `src/services/plan/sqlite.ts:586` — `anyRow`.
- **The two SQLite services disagree on SQL-constant convention.**
  `src/services/plan/sqlite.ts:43` — `INSERT_NODE` names whole statements;
  `src/services/execution/sqlite.ts:22` — `RUN_COLUMNS` names column lists and inlines statements.
  Follow each file's own convention.
- **Two shipped tests scan `src/services/plan/` source text.**
  `src/services/plan/sqlite.test.ts:1198` — `MutateGraphInput` slices `index.ts` from that
  declaration, and `src/services/plan/sqlite.test.ts:1742` — `ON CONFLICT` finds the first occurrence
  in `sqlite.ts`. Story 5 disturbs neither, and the constraints say so.
- **`worker.md` is outside this repository**, at
  `/Users/tuanatelsa/Projects/kanthorlabs/kanthord/docs/workflow/worker.md`. Every citation of it in
  these stories was verified against that file and no engine-side check pins it.
- **The gate range does not hold `"052"`.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` ends
  at `"051.6"`, so `scripts/verify-epic-sequence.ts` grandfathers this epic and checks none of its
  citations.

## Decisions taken during authoring, and now recorded in the EPIC

- **All five verdicts use one shape, `{ ok: true } | { ok: false; refusal; <evidence> }`, and the
  refusal carries the offending id.** The epic names five functions and settles no return type.
  `src/domain/` holds three conventions: `legal` with a `refusal` field
  (`src/domain/node-write-legality.ts:30` — `NodeWriteLegality`), a refusal object or `null`
  (`src/domain/run-exclusion.ts:20` — `SubtreeExclusionRefusal`), and `ok` with a `reason`
  (`src/domain/origin.ts:11` — `OriginCanonicalization`). The five are one ordered chain in EPIC
  052.1, at `.agents/plan/epics/052.1-the-structural-acceptance.md:44` — `patch-target-invalid`, and
  a chain that alternates `legal` and `ok` discriminants is a defect the type checker cannot catch
  because both are booleans. The chosen shape is the one EPIC 051.1 Story 6
  (`06-the-acceptance-verdicts`) already used for the same kind of ordered gate. It also resolves
  `pairChangeVerdict`'s otherwise unused `nodeId` parameter, which would fail `pnpm run lint`.
  `nodePairLegality` keeps its own shape untouched. See all four domain stories.

- **`stagePatch` returns a `StagedNode`, which is the structural projection of a node and not a
  `StoredNode`.** A `create` carries no `instructionBlob`, no `assignment`, no `state`, no `revision`
  and no `updatedAt`, so the staged set cannot be `StoredNode[]`. The nine projected fields are
  exactly those `src/domain/plan-candidate.ts:96` — `validateCandidate` reads on a structural
  finding, so the projection loses nothing this epic asks. **This epic therefore builds no
  `Candidate`**; the epic's phrase "the staged graph is expressed as a `Candidate`" is EPIC 052.1
  Story 5's obligation, and that story supplies the blob fields the validator ignores. See
  `02-the-staged-graph-and-target-legality.md`.

- **A created node's `worker` is `null` and its `projectId` comes from the pinned graph.** The patch
  carries neither field. `src/domain/plan-candidate.ts:163` — `node.worker` fires `worker-unknown`
  only for a non-null value, so `null` reaches no refusal, and routing assigns a worker. Every node
  of a project-scoped `PatchGraph` carries one `projectId`, so a created node inherits it. See
  `02-the-staged-graph-and-target-legality.md`.

- **`StagedEdge` carries no `id` and no `waivedAt`, and the edge set is derived from the staged
  `dependencies` lists.** `src/domain/` is pure and cannot mint an edge id, and EPIC 052.1 Story 1
  (`01-the-lowering`) mints them. Deriving the edge set removes the second representation of one
  fact that `src/services/plan/sqlite.ts:162` — `buildNodes` already avoids in the store. See
  `02-the-staged-graph-and-target-legality.md`.

- **A patch is `{ mutations: [ … ] }` and not a bare array.** The epic requires keys sorted bytewise
  at every level and gives the document no top level. `checkpoint.patch_blob` stores it as standalone
  evidence, and `.agents/plan/epics/052.1-the-structural-acceptance.md:70` — `nodeReportRequest`
  carries it as an opaque `patch` member, so a self-describing object is what a human reads back.
  See `01-the-patch-shape-and-its-canonical-form.md`.

- **The at-least-one-field rule lives in the schema and the duplicate-id rule does not.** Gate row 2
  names no code, and gate row 3 requires `patch-unparsable` and `patch-id-duplicate` to stay
  distinct. A `superRefine` carrying both would fold them into one `safeParse` failure. The split
  copies `src/domain/verify-block.ts:67` — `decodeVerifyBlock`, where the schema owns one rule and
  the function beside it owns another. The rule is written over an exported `updateFields` tuple and
  not over a key count, because a key present with an `undefined` value survives a zod
  `strictObject` parse. See `01-the-patch-shape-and-its-canonical-form.md`.

- **`renderGraphPatch` sorts keys by construction and adds no generic sorter.** The algebra is
  closed, so the renderer builds one explicit literal per `op` with its keys in bytewise order, on
  the pattern of `src/domain/plan-hash.ts:5` — `canonicalDocumentsJson`. An `update` omits an absent
  field rather than emitting `null`, because `null` is the value that clears a nullable column. See
  `01-the-patch-shape-and-its-canonical-form.md`.

- **`patchProjectVerdict` takes a cross-project `{ id, projectId }` projection, and the seam that
  supplies it is EPIC 052.1's to choose.** With a project-scoped pinned graph, a node of another
  project is simply absent, so `patchTargetVerdict` refuses it first as
  `patch-target-invalid` and gate row 12 is unreachable — the same class of defect the epic itself
  found for the project-versus-`plan-invalid` order. `src/services/plan/index.ts:79` — `readAllNodes`
  answers it in one call and `src/services/plan/index.ts:78` — `readNode` answers it per id. **This
  is a blocker against EPIC 052.1**, whose seam list at
  `.agents/plan/epics/052.1-the-structural-acceptance.md:79` — `plan.newestRevision` names neither.
  See `03-scope-and-project.md`.

- **`hasAcceptedCheckpoint` is a bare existence test on `node_id`.** The `checkpoint` table has no
  `accepted` column, and every row is written only on an acceptance. `worker.md:447` makes a review
  verdict of `reject` a delivered verdict, so a rejected review checkpoint counts. A reader who
  expects a `WHERE accepted = 1` clause would look for a column the schema will never have. See
  `05-the-seams-the-acceptance-needs.md`.

- **`WriteCheckpointInput` widens to a discriminated union rather than gaining a second method.**
  EPIC 051.3 Story 2 (`02-the-checkpoint-row`) states that EPIC 052 widens the input, and
  `.agents/plan/epics/052.1-the-structural-acceptance.md:162` — `execution.writeCheckpoint` draws one
  step, so a second method would give that path a second token. See
  `05-the-seams-the-acceptance-needs.md`.

- **Gate row 24 is unimplementable as the schema stands, and Story 5 case 7 is marked blocked.**
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:47` — `node_id` declares
  `node_id TEXT NOT NULL REFERENCES node(id)` with no `ON DELETE` clause, and
  `src/services/storage/connection.ts:8` — `foreign_keys` turns the pragma on at every open. SQLite
  applies `NO ACTION` immediately, so deleting a node a checkpoint names raises
  `FOREIGN KEY constraint failed` and the delete does not happen. The epic's ruling that a delete
  carries no checkpoint condition is therefore false today. A human rules; see the report. See
  `05-the-seams-the-acceptance-needs.md`.

- **Gate row 25's fixture seeds no run for the nodes it deletes, and Story 5 case 9 is its control.**
  `src/services/storage/migration-0007-external-execution.ts:15` — `node_id` makes `run.node_id` a
  foreign key on `node(id)`, so a node carrying a run row is undeletable whatever its state. A
  fixture that seeded a run for the `running` child would turn an eight-state test into a foreign-key
  test and pass for the wrong reason. See `05-the-seams-the-acceptance-needs.md`.

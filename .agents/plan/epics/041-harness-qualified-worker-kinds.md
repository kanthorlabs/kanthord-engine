# EPIC 041 — Harness-qualified worker kinds

Status: **draft**. It follows EPIC 040 by sequence order and closes Gap 5 of the dashboard handoff.

## Goal

A plan names the harness that runs a node, so an external orchestrator routes a task to the right
persona:

- `workerKinds` admits `claude.swe@1`, `claude.te@1`, `opencode.swe@1` and `opencode.te@1` beside the
  three existing kinds;
- `plan import` accepts a node naming one of the four and raises no `worker-unknown` finding;
- `docs/proposal/phase-2/agents-and-workers.md` defines what a harness-qualified kind is, and states
  that no local worker executes one.

## Non-goals

- **No claim enforcement.** `src/commands/node/claim-node.ts` does not read `node.worker` today and
  does not start. An actor of one harness may claim a node of any worker kind. Arbitration is the
  lease's job, and a harness must stay able to pick up a node another harness abandoned.
- **No local worker.** The daemon gains no execution path for the four values. A harness-qualified
  kind is advisory routing metadata that an external orchestrator reads.
- **No agent change.** The agent set of `docs/proposal/phase-2/agents-and-workers.md` — `general@1`,
  `swe@1`, `te@1`, `re@1` — is unchanged. This epic adds worker kinds, not agents.
- **No `tdd@1` change.** `tdd@1` keeps its declared composition and its deferral in
  `docs/proposal/after-the-mvp.md`. This epic neither implements nor removes it.
- **No contract change.** `node.worker` is `z.string().nullable()` in `src/http/contract/graph.ts`,
  so the wire type already admits the four values and no OpenAPI schema changes.
- **No migration.** The check runs at import. A stored row does not change meaning, and a plan
  already imported is unaffected.

## Decisions

- **The naming convention is `<harness>.<agent>@<version>`.** The harness prefix is the thing the
  existing enum cannot express, and it is what differs between two runners of the same pipeline. The
  four added values are `claude.swe@1`, `claude.te@1`, `opencode.swe@1` and `opencode.te@1`.

- **The array order is existing kinds first, then the four in the order above.** `workerKinds` is a
  `readonly` tuple that `src/services/plan/sqlite.ts:251` spreads into the validation context and
  `src/domain/worker.test.ts:8` asserts by deep equality. Order is therefore observable, and it is
  fixed: `["general@1", "tdd@1", "git@1", "claude.swe@1", "claude.te@1", "opencode.swe@1",
"opencode.te@1"]`.

- **A harness-qualified kind is a third category, and the proposal says so.**
  `docs/proposal/phase-2/agents-and-workers.md:9` states worker kinds are `general@1`, `tdd@1` and
  `git@1`, and separates a worker kind from an agent. That sentence is amended, not deleted. The
  amendment states three things: a harness-qualified kind names an external harness and the persona
  it dispatches; the daemon validates it at import and never executes it; and a node carrying one is
  claimed and reported through the same operations as any other node.

- **The distinction between an agent and a worker kind survives the addition.** `swe@1` and `te@1`
  remain agent names and are not admitted to `workerKinds`. Only the qualified spelling is a worker
  kind, because the harness prefix is what makes it a dispatch target rather than a role.

- **`docs/proposal/phase-2/instructions-and-profiles.md:9` repeats the closed set and is amended to
  match.** Two documents state the same set, so both change or the source of truth disagrees with
  itself.

- **Validation is the only behaviour that changes.** `src/domain/plan-candidate.ts:153` and
  `src/domain/plan-validate.ts:286` are the two places that test membership, and both read the
  context array rather than the constant. Neither file changes.

- **An agent name is refused at the document boundary, and `worker-unknown` reports a context
  omission.** `src/domain/plan-document.ts:22` parses `worker` with `workerKind`, so `swe@1` is
  `frontmatter-invalid` and never reaches a membership check. `worker-unknown` therefore names a
  different fault: a well-formed kind that the project's `context.workerKinds` omits. The two faults
  live at two layers and are proven at two layers. `src/domain/plan-document.ts` does not change.

- **A candidate is not a document.** `src/domain/plan-candidate.ts` reads a node object that no
  frontmatter parse produced, so an agent name does reach its membership check there. The candidate
  layer keeps the `swe@1` case; the document layer cannot hold one.

## Stories

1. **The domain enum admits four harness-qualified kinds.** Extend `workerKinds` in
   `src/domain/worker.ts` with the four values in the fixed order. Update the exact-array assertion
   in `src/domain/worker.test.ts` and add a case asserting that `workerKind` parses each of the four
   and rejects `swe@1`, `te@1`, `claude.swe` and `claude.swe@2`.

2. **Import accepts a harness-qualified worker.** Add cases to `src/domain/plan-candidate.test.ts`,
   `src/domain/plan-validate.test.ts` and `src/domain/plan-document.test.ts` proving that a node
   naming each of the four raises no `worker-unknown` finding. Prove each fault at its own layer: a
   candidate naming `swe@1` raises exactly one `worker-unknown`; a document naming `claude.swe@1`
   against a context that omits that one value raises exactly one `worker-unknown`; `planFrontmatter`
   refuses `swe@1` and `te@1` with the issue path `worker`. No production file under `src/domain/`
   other than `worker.ts` changes.

3. **The plan store passes the extended set through.** Add a case to
   `src/services/plan/sqlite.test.ts` proving the validation context built at
   `src/services/plan/sqlite.ts:251` carries all seven kinds in the fixed order.

4. **An import and an export round-trip a harness-qualified worker.** Add a case to
   `src/commands/plan/import-plan.test.ts` proving a plan document naming `claude.swe@1` imports with
   no finding, and a case to `src/queries/plan/export-plan.test.ts` proving the exported document is
   byte-identical to the imported one. The store-level test of story 3 proves the validation context;
   this story proves the operation a human calls. No production file changes.

5. **A claim ignores the worker kind.** Add a case to `src/commands/node/claim-node.test.ts`
   proving that a task whose `worker` is `opencode.te@1` is claimed by an actor that names no
   harness, and that the returned lease is identical to the lease the same claim produces for a task
   whose `worker` is `general@1`. Both fixtures set `worker` explicitly through a `seedNodeWorker`
   helper in `test/helpers/rows.ts`, because a null baseline compares an unassigned node against a
   worker kind rather than one worker kind against another. No production file changes. The case is
   the regression that holds the first Non-goal: it fails the moment a claim starts reading
   `node.worker`.

6. **The proposal defines a harness-qualified kind.** Amend
   `docs/proposal/phase-2/agents-and-workers.md` and
   `docs/proposal/phase-2/instructions-and-profiles.md` with the definition of the Decisions above.
   Name the four values, state the `<harness>.<agent>@<version>` convention, state that the daemon
   validates and never executes one, and state that claim is not restricted by worker kind.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/domain/worker.test.ts \
  src/domain/plan-document.test.ts \
  src/domain/plan-candidate.test.ts \
  src/domain/plan-validate.test.ts \
  src/services/plan/sqlite.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/queries/plan/export-plan.test.ts \
  src/commands/node/claim-node.test.ts \
  && echo "PASS EPIC-041"
```

Hermetic coverage required beyond the Proof:

- `workerKinds` deep-equals the seven-element array in the fixed order. The assertion names every
  element; no test asserts a length or a membership check alone.
- `workerKind` parses each of the four added values and rejects `swe@1`, `te@1`, `claude.swe` and
  `claude.swe@2`. Each rejection is asserted by value, not by "throws".
- A plan candidate whose node names each of the four produces a finding list that is deep-equal to
  the empty array. A candidate naming `swe@1` produces exactly one `worker-unknown` finding, with
  `id` equal to the task identity and `path` equal to `null`.
- A plan document naming each of the four, validated against the full context, produces a finding
  list that is deep-equal to the empty array.
- A plan document naming `claude.swe@1`, validated against a context that omits that one value and
  keeps the other six, produces exactly one `worker-unknown` finding on that document path. The
  context is built by filtering `workerKinds`, so the value under test is the only variable.
- `planFrontmatter.safeParse` refuses `swe@1` and refuses `te@1`, each with the issue path `worker`,
  and parses each of the four. This is the boundary rejection; no plan-level assertion stands in for
  it, because a refused task document also raises `objective-without-task`.
- A round trip through `plan import` and `plan export` of a document naming `claude.swe@1` produces
  byte-identical output.
- `src/commands/node/claim-node.ts` is unchanged, and a claim of a node whose worker is
  `opencode.te@1` by an actor with no harness association succeeds.

# Story 6 — The import-plan guard

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: Story 1 (01-the-run-covers-node-rule), for `plan.runCoversNode`; Story 8 (08-subtree-busy-joins-the-plan-operations), for `subtree-busy` on `plan.import`; EPIC 050.1 Story 6 (06-the-conformance-harness) and EPIC 050.1 Story 7 (07-the-conformance-runner), which this story's scenario file runs on.
Kind: story-implement

Diagrams: import-plan-guard

Baselines: import-plan-guard <- baseline-import-plan

Seams: import-plan-guard: +plan.runCoversNode, ~clock.now @src/commands/plan/import-plan.ts:395

## The shipped path

### `baseline-import-plan`

Superseded by: EPIC 050.3 import-plan-guard

Shipped path: `src/commands/plan/import-plan.ts:149-205`. Fixture: project `P` holding initiative
`I`, objective `O` and task `T`. The import submits one changed document for `T`, deletes nothing,
carries a fresh `importId`, and `fromRevision` and `validatedRevision` both name the newest revision.

```mermaid
sequenceDiagram
    participant Client
    participant Command
    participant Storage
    participant Plan
    Client->>Command: plan.import
    Command->>Storage: 1 storage.transact
    Command->>Plan: 2 plan.findByImportId
    Command->>Plan: 3 plan.newestRevision
    Command->>Plan: 4 plan.readValidationContext
    Command->>Plan: 5 plan.readGraph
    note over Command: tail unchanged by EPIC 050.3
```

Citations, one per step: `src/commands/plan/import-plan.ts:149 — `storage.transact``,
`src/commands/plan/import-plan.ts:160 — `findByImportId``,
`src/commands/plan/import-plan.ts:169 — `newestRevision``,
`src/commands/plan/import-plan.ts:191 — `readValidationContext``,
`src/commands/plan/import-plan.ts:195 — `readGraph``. The project existence check at `:150` reads
through the transaction object, which is not a dependency key, so it is no message. `plan.readGraph`
also appears at `src/commands/plan/import-plan.ts:182 — `readGraph``, inside the `choices-stale`
branch, and again at `src/commands/plan/import-plan.ts:657 — `readGraph``, inside `retryResult`. Both
are on paths this diagram does not draw.

Callee anchors, one per step: `src/services/storage/index.ts:33 — `transact``,
`src/services/plan/index.ts:80 — `findByImportId``,
`src/services/plan/index.ts:75 — `newestRevision``,
`src/services/plan/index.ts:85 — `readValidationContext``,
`src/services/plan/index.ts:66 — `readGraph``. Steps 3 to 5 are reachable because the fixture carries
a fresh `importId`, so step 2 returns nothing and the replay at `:160-166` does not return, and
because `fromRevision` and `validatedRevision` both equal the newest revision, so neither
`stale-revision` nor `choices-stale` fires.

The prefix reaches `plan.readGraph` because that is where the guard must sit: the ids the import
deletes are the project's nodes no submitted document names, and that set needs the graph.

The tail this note pins runs from the closures the command hands to its domain functions at
`:217-219` — `reader.read`, `graph.cycles` and `ids.mint`, each a seam call whose count depends on the
submitted document set — through `blobs.put` at `:413` to `events.append` at `:543` and `:552`. That is
why this diagram pins its tail rather than unrolling it: the tail is a function of the fixture's
document count. One seam call leaves that tail, the clock read at `:395`, and the `~` token with its
citation is the declaration of exactly that.

### `import-plan-guard`

Supersedes: EPIC 050.3 baseline-import-plan

Fixture: the fixture of `baseline-import-plan`.

```mermaid
sequenceDiagram
    participant Client
    participant Command
    participant Storage
    participant Clock
    participant Plan
    Client->>Command: plan.import
    Command->>Storage: 1 storage.transact
    Command->>Plan: 2 plan.findByImportId
    Command->>Clock: 3 clock.now
    Command->>Plan: 4 plan.newestRevision
    Command->>Plan: 5 plan.readValidationContext
    Command->>Plan: 6 plan.readGraph
    Command->>Plan: 7 plan.runCoversNode
    note over Command: tail unchanged by EPIC 050.3
```

Step 3 is the moved clock read. Step 7 sits after the graph read that supplies the deleted set, and
before the first write, `blobs.put` at `:413`. The idempotency replay at `:160-166` returns its
shipped answer at step 2 without ever reaching the clock or the guard, which is correct: a replay
writes nothing and its trace does not move.

Add `test/sequence/scenarios/import-plan-guard.ts`.

## Change

**`src/commands/plan/import-plan.ts` — insert one guard.** After `plan.readGraph` at `:195`, where
`storedNodes` first exists, and before the choice loop at `:217`:

```ts
const covering = dependencies.plan.runCoversNode(
  transaction,
  seedIds,
  updatedAt,
);
if (covering !== null) {
  throw new ImportPlanError("subtree-busy", "an active run covers the import", {
    relation: covering.relation,
    nodeId: covering.nodeId,
    runId: covering.runId,
    expiresAt: covering.expiresAt,
  });
}
```

**The seed is every submitted id and every id the import deletes.** An import is a graph rewrite, and
both halves are affected: a submitted document changes a node, and a deletion removes it with its
subtree.

Both halves come from `storedNodes`, the graph read at `:195`. The submitted ids are the identities
the request's documents carry; the deleted ids are `storedNodes` minus those identities. **This is
why the guard sits after the graph read and not at the top of the transaction.** Seeding only the
submitted set would drop the half of an import that removes a subtree a worker may hold, and the
deleted set cannot be computed before `:195`. A story that placed the guard earlier would leave the
implementing agent to invent one of four unstated designs, which the determinism rule of `AGENTS.md`
forbids.

The guard still precedes every write: the first is `blobs.put` at `:413`.

**`updatedAt` moves, and that is the one seam call leaving the pinned tail.** The command reads the
clock at `:395`, deep inside the tail. The guard needs a `now`, and a second clock read would give
the command two instants. Move `const updatedAt = dependencies.clock.now();` to immediately after the
idempotency replay returns at `:166`, before `plan.newestRevision` at `:169`, and pass it to the
guard; the value is used unchanged at `:395`. **Do not move it above the replay.** `retryResult`
reads no clock today, so a read at the first statement of the transaction would add a seam call to
the replay path, and no diagram of this epic draws that path.

The ship diagram therefore draws `clock.now` at step 3 where the baseline's prefix holds none. The
sign is `~` with a citation, not `+`: the call exists today, inside the tail this diagram does not
compare, and a `+` would claim the command gained a clock read it always had. No other seam call
leaves the tail, which is what the note asserts.

Add `"subtree-busy"` to `ImportPlanRefusal`.

## Constraints

- The guard sits inside the transaction opened at `:149`. Open no second transaction.
- Read the clock once, and read it below the idempotency replay. The moved `clock.now` is the command's only clock read, and the replay path still reaches none.
- The guard follows the idempotency replay, both revision checks and the graph read, and precedes every write. The first write of this command is `blobs.put` at `:413`.
- Build the deleted set from `storedNodes` at `:195`. Do not add a store method, do not re-read the graph, and do not weaken the seed to the submitted ids alone.
- Seed the submitted ids and the deleted ids. Do not seed their ancestors or descendants: the closure supplies both.
- An import that submits every node of the project and deletes none seeds every node, and a run anywhere in the project therefore refuses it. That is correct and is asserted.
- Change no other refusal, no choice verdict and no response shape.

## Verify

```
node --test src/commands/plan/import-plan.test.ts test/sequence/conformance.test.ts
```

Add, each as a separate `it`:

1. `"an import submitting a node covered by an active run refuses subtree-busy"` — assert the details deep-equal `{ relation: "self", nodeId: T, runId, expiresAt }`.

2. `"an import submitting a node whose ancestor holds an active run refuses, naming the ancestor"` — run on `O`, submit `T`.

3. `"an import deleting a node whose descendant holds an active run refuses, naming the descendant"` — run on `T`, submit a set that omits `O`. Assert `relation === "descendant"`.

4. `"an import touching only unrelated nodes succeeds"` — run on a node of the second project `test/helpers/rows.ts:406 — `seedSecondProjectGraph`` adds, import into `P`. A node of another project is neither above nor below any seed, and it is the only unrelated node available: an import of `P` that submits every node of `P` seeds every node of `P`.

5. `"an import over an expired run succeeds"`, and the same over an `ended` run.

6. `"a subtree-busy refusal leaves the database byte-identical"`.

7. `"an idempotent replay is never refused by the guard"` — an active run on `T` and an `importId` already recorded. Assert the shipped replay response, proving the replay returns before the guard is reached.

8. `"an idempotent replay reads no clock"` — the same fixture, asserting the recorder saw zero `clock.now` calls. The moved read sits below the replay, so the replay path's trace is what it was.

9. `"the deleted set is seeded from the graph read"` — an import that omits `O` from its submitted set while a run covers a task under `O`. Assert `subtree-busy` with `relation === "descendant"`. A guard seeded only from the submitted ids would admit this write.

10. `"the refusal precedence of plan.import"` — one decision table over every pair of `project-not-found`, `stale-revision`, `choices-stale`, `subtree-busy`, `plan-invalid`, `choices-invalid`, `choices-changed` and `idempotency-mismatch` that can trigger at once, with the winner named per pair and every unreachable pair marked unreachable with its reason. The replay returning before the guard is one such unreachable row.

11. `"a stale fromRevision beats a covering run"`.

12. `"the command reads the clock once"` — count the `clock.now` calls of the recorder on the success path and assert `1`.

Add `test/sequence/scenarios/import-plan-guard.ts`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/plan/import-plan.test.ts` in `PASS EPIC-050.3`.

# Story 6 — The report prelude

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 1 (`assertRunAuthority`), Story 2 (`execution.runById`), Story 7 (`runId` and `runFence` on the request), EPIC 050.1 Story 2 (`expireRuns`).
Kind: story-implement

Diagrams: report-authority-prelude

Baselines: report-authority-prelude <- baseline-report-prelude

Seams: report-authority-prelude: +expiry.expireRuns, +execution.runById:R, +plan.readSubtree, -lease.read:T, -execution.activeRunOfNode:T

This story changes the prelude of `node.report` and nothing after it. EPIC 050.4 Story 6 declares
`report-lease-free` and owns the tail. EPIC 051's `report-execution-checkpoint` draws
`acceptExecution`, a nested command on another path, so it never owned this tail.

## The shipped path

### `baseline-report-prelude`

Superseded by: EPIC 050.2 report-authority-prelude

Shipped path: `src/commands/outcome/report-outcome.ts:107-206`. Fixture: task `T` running under run
`R`, the lease held by the caller.

```mermaid
sequenceDiagram
    participant Client
    participant Command
    participant Storage
    participant Clock
    participant Plan
    participant Lease
    participant Execution
    Client->>Command: node.report
    Command->>Storage: 1 storage.transact
    Command->>Clock: 2 clock.now
    Command->>Plan: 3 plan.readNode
    Command->>Lease: 4 lease.read:T
    Command->>Execution: 5 execution.activeRunOfNode:T
    note over Command: tail pinned by EPIC 050.2 report-authority-prelude
```

Citations: `:107`, `:108`, `:110`, `:173`, `:206`. The shipped prelude proves the caller by the lease
and finds the run by the node. Nothing after step 5 is compared, because this story changes nothing
after step 5.

### `report-authority-prelude`

Supersedes: EPIC 050.2 baseline-report-prelude
Superseded by: EPIC 050.4 report-lease-free

```mermaid
sequenceDiagram
    participant Client
    participant Command
    participant Storage
    participant Clock
    participant Expiry
    participant Execution
    participant Plan
    Client->>Command: node.report
    Command->>Storage: 1 storage.transact
    Command->>Clock: 2 clock.now
    Command->>Expiry: 3 expiry.expireRuns
    Command->>Execution: 4 execution.runById:R
    Command->>Plan: 5 plan.readSubtree
    Command->>Plan: 6 plan.readNode
    note over Command: tail pinned by EPIC 050.4 report-lease-free
```

Step 6 is the shipped node read, moved behind the authority check. It stays because the tail reads
`node.kind` at `:122` and `node.state` at `:165`, and `plan.readSubtree` returns ids alone and
supplies neither. It is a context token: the baseline holds it and this diagram holds it, at one
count and one label.

This story pins the prelude, because the prelude is what it changes. EPIC 050.4 Story 6 declares
`report-lease-free`, draws the whole path and owns the tail, and the range gate refuses if it does
not. EPIC 051 then supersedes `report-lease-free`.

Add `test/sequence/scenarios/report-authority-prelude.ts`.

## Change

**`src/commands/outcome/report-outcome.ts` — replace the lease proof with the run proof.** Inside the
existing `storage.transact` at `:107`:

1. `const now = dependencies.clock.now();` — unchanged, at `:108`.
2. `dependencies.expiry.expireRuns(transaction, { now });` — new.
3. `execution.runById(transaction, input.runId)` — new, replacing `execution.activeRunOfNode` at `:206`.
4. `plan.readSubtree(transaction, run.nodeId)` — new. The node the report targets is inside the subtree the run covers, and `assertRunAuthority` needs the whole set.
5. `assertRunAuthority(...)`, throwing `ReportOutcomeError(refusal.refusal, ..., { runId })`. This replaces the lease read at `:173`.
6. `plan.readNode(transaction, input.nodeId)` at `:110`, moved behind the authority check and otherwise unchanged. The tail reads `node.kind` at `:122` and `node.state` at `:165`, and `plan.readSubtree` supplies neither.

Everything after step 5 keeps its shipped shape. EPIC 051 rewrites it.

Add `runId: string` and `runFence: number` to `ReportOutcomeInput` at `:70-75`. The shipped `fence`
field is the **node lease** fence and it stays.

Add the six authority codes to `ReportOutcomeRefusal` at `:79-85`.

**A report never changes `node.assignment`.**

## Constraints

- Change nothing after the node read. The note pins the boundary, and EPIC 050.4 Story 6 owns the tail.
- `plan.readSubtree` is added beside `plan.readNode`; it does not replace it. The subtree serves the authority check and the node row serves the tail, and neither answers the other's question.
- Do not change the existing `fence` field's meaning. Add `runFence` beside it.
- The prelude runs for all six members of the report union, including `closed`.

## Verify

```
node --test src/commands/outcome/report-outcome.test.ts test/sequence/conformance.test.ts
```

Add, each as a separate `it`:

1. `"a report refuses a stale fence"` — assert `refusal === "fence-stale"` and `databaseBytes` unchanged.

2. `"a report refuses an ended run"` — assert `refusal === "run-ended"` and `databaseBytes` unchanged.

3. `"a report on an expired run refuses and writes nothing"` — seed `expires_at: NOW - 1`. Assert the refusal is `run-ended` and `databaseBytes` deep-equals the snapshot.

4. `"a report refuses a target outside the run"` — assert `refusal === "target-outside-run"`.

5. `"a report refusal carries only the run id"` — assert the details key set is exactly `["runId"]` for each of the six.

6. `"the prelude runs for the closed member"` — a `closed` report with a stale fence refuses `fence-stale`, proving the check is not bound to the members that carry a lease fence.

7. `"node.assignment is unchanged after a rejection"`.

8. `"every shipped report case still passes"` — carry the file's existing cases across with `runId` and `runFence` added to their inputs.

Add `test/sequence/scenarios/report-authority-prelude.ts`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/outcome/report-outcome.test.ts` in `PASS EPIC-050.2`.

# Story 15 — The proposal records the run model

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: every prior story. This document states what the code does; write it last.

## Change

**Create `docs/proposal/phase-2/runs-and-exclusion.md`.**

Mirror the structure of `docs/proposal/phase-2/agents-and-workers.md`: line 1 is the `#` title, line 3 is a one-line reviewer-and-scope stanza, and every section below is a `##` heading written as a sentence, unnumbered. A section body is one declarative paragraph, or a numbered list with one owner per step.

```
1: # Runs and exclusion
3: Reviewer: runtime or backend engineer. Phase 2. What a checkpoint is belongs to `checkpoints.md`. This file is the run that carries one.
```

Sections, in this order, each stating the rule the code enforces:

- **`## Three run kinds, selected by the node deliverable`** — `structural`, `execution`, `review`. The mapping table: `expansion` to `structural`; `test` and `implementation` to `execution`; `review` to `review`. State that the worker metadata does not select the kind, and that `research` is absent because this phase defers the deliverable.

- **`## A claim opens exactly one run`** — the daemon writes `node.assignment` and inserts the run in one storage transaction, at the first claim on an unassigned node. State why one operation: a crash between two would leave an assignment with no run, and the next claim would read an assignment nobody holds.

- **`## An unassigned node routes, and an assigned node compares`** — routing takes the first worker of the capable, authorized and available intersection. A mismatch refuses `assignment-held`, and the refusal offers a human switch. State that an ordinary failure never changes an assignment, and that the worker switch of a later epic is the only writer that does.

- **`## The caller asserts availability, and the daemon never probes`** — a worker runs a self health check before it claims. The claim request carries `available`. A `false` value refuses `unroutable` with `failedSet: "available"`. A caller that asserts `true` when it is not available is trusted, and the guarantees table records that.

- **`## The run owns the fence`** — the fence is a counter on the run. Every later write carries the run id and the fence. The daemon raises the fence when it ends a run, and at no other time. A renew never touches it, because rotating it would invalidate the pair the worker already holds.

- **`## Run authority is four conditions, not one`** — active, unexpired, bound to the target, carrying the current fence. State the six refusals in their fixed order: `run-not-found`, `run-ended`, `run-expired`, `run-caller-mismatch`, `target-outside-run`, `fence-stale`. State why the order matters: an ended run presented with its own last fence must fail, and a fence comparison alone admits it. State that a refusal names the run id and the reason only, and never the current fence — handing the replacement value to a writer that just proved it holds a stale one gives back the authority the raise removed.

- **`## A run covers the claimed node and every descendant`** — at most one active run over a node. State that the `run_one_active` partial index defends the same-node case only, and that the subtree rule is evaluated inside the claim transaction. Name the transaction isolation: the claim runs as an immediate write transaction, so two sibling claims serialise.

- **`## One active run per objective branch, and a task claim is refused rather than queued`** — the refusal is `objective-busy` and it names the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when. The daemon holds no queue. A blocking wait would hold one request open for a run lifetime, and a queue would make the daemon a scheduler. The caller retries.

- **`## The claim dispatches on the deliverable`** — a node carrying no deliverable takes the legacy path unchanged while the dual-read window is open; a node carrying one takes a path that opens exactly one run covering the claimed node and its descendants. State that the two models never share a run, and why: one active run per node is a unique index, and two runs over one node leave authority ambiguous.

- **`## The refusal order is fixed`** — state the one total order over both models, the fifteen steps the EPIC lists, from `node-not-found` to `ancestor-not-startable`. A predicate that does not apply to the selected path is skipped, never simulated. A claim that fails two conditions reports the earlier one, so a client sees the cause it can act on first. State that on the new-model path every applicable refusal is evaluated before the first mutation.

- **`## A review claim is refused until the workspace exists`** — a review run records the commit it judges at claim time, this epic creates no workspace record, and no head can therefore be pinned. The refusal is `review-head-unavailable`. State why a null pin is not an option: a value written later records a commit chosen after the claim, which is the retrospective choice the pin prevents.

- **`## A run expires against the daemon clock`** — a renew sets `expires_at = min(now + runTtlMs, max_lifetime_at)` and refuses `lifetime-exceeded` when `now >= max_lifetime_at`. The comparison is `>=`, so the boundary instant is expired. Both budgets are configuration, and both are validated at startup: `runTtlMs` below 1000 is refused, and `runMaxLifetimeMs` below `runTtlMs` is refused.

- **`## Every run operation evaluates expiry first`** — claim, renew, release and report each run the same pass before anything else, inside their one transaction. Sweeping only at the next claim would leave an expired run able to renew itself back to life. The expiry is a conditional update, so two racing sweeps cannot raise the fence twice, and the transition and its event are one transaction. State that the expiry is transactional maintenance: a command that expires a run and then refuses rolls the expiry back with everything else, because a refusal writes nothing, and the next operation sweeps the run again.

- **`## base is a set qualified by repository`** — it lives in `run_base`, keyed by run and repository. An `execution` run holds exactly one row; a `structural` or `review` run holds none, because a structural run claims an initiative, which owns no repository. State that `graph_revision` is recorded on every run and compared only at the structural checkpoint.

- **`## Provenance is two columns, not a blob`** — the run holds the worker id and the agent list from the registry entry. An external run records an empty agent list, because a self-managed harness selects its own agents and the daemon observes none. The daemon knows both at claim time and asks the worker for neither.

- **`## The schema change is additive, and enforcement comes later`** — migration `12` widens the run kind set, adds every new column nullable and creates `run_base`. It removes no column and no enum member; that is what "additive" means here. It does rebuild the table and drop two legacy CHECK groups, because SQLite cannot widen or drop a table-level CHECK in place, and because the backfill and the new provenance contradict both: every shipped row becomes an `execution` run, and an external run now carries a worker. It refuses to run while any run is active, because a schema change under a live run leaves that run holding a fence the new writers do not read. A later epic makes the columns non-null and drops `base_oid` and `lease_fence`.

**Add one row to the `## Files` table in `docs/proposal/phase-2/README.md:19-25`**, in the table's existing two-column form:

```
| [runs-and-exclusion.md](runs-and-exclusion.md)               | run kinds, the fence, run authority, exclusion, expiry            |
```

## Constraints

- The document records the decision, not the search for it. State the rule and the constraint it imposes. Cut every alternative, rejection and comparison. A "why" sentence is admitted only where the rule is surprising without it, as in the refusal order and the no-queue rule above.
- Do not restate the checkpoint contract. `checkpoints.md` of the next epic owns it.
- Do not describe the worker switch or the operator handoff. A later epic owns both.
- Do not name a table column that migration `12` does not create.
- ASD-STE100 style, matching the sibling phase-2 documents: simple tenses, active voice, one instruction per sentence.

## Verify

```
node --test test/helpers/proposal.test.ts src/http/contract/parity.test.ts
```

Add all three cases to `test/helpers/proposal.test.ts`. That suite already reads documents under `docs/proposal/` and is the one home for a proposal-document assertion; there is no separate phase-2 document test.

1. `"the phase-2 file table and the phase-2 directory agree"` — read `docs/proposal/phase-2/README.md`, parse the `## Files` table, and assert every linked file exists on disk and every `*.md` in `docs/proposal/phase-2/` except `README.md` appears in the table. Both directions.

2. `"runs-and-exclusion.md declares no route table"` — `src/http/contract/parity.test.ts` harvests every five-cell markdown table row from `docs/proposal/api/*.md` only, so a phase-2 document adds no route. Assert the new file lives under `docs/proposal/phase-2/` and not under `docs/proposal/api/`, so the parity count stays 73.

3. `"the run model document names every refusal code of this epic"` — read the file and assert it contains each of the six authority refusals (`run-not-found`, `run-ended`, `run-expired`, `run-caller-mismatch`, `target-outside-run`, `fence-stale`), `lifetime-exceeded`, and each of the fifteen ordered claim refusals including `review-head-unavailable`. Build the expected list by importing `runAuthorityRefusals` from `src/domain/run-authority.ts` rather than restating it, so the document and the tuple cannot drift.

`pnpm run verify` exits 0. `pnpm run format` runs prettier over `docs`, so the tables must be prettier-formatted.

Proof: no PASS line of its own. This story is the documentation half of `PASS EPIC-050` and is gated by `pnpm run verify`.

# Story 9 — The proposal records the run model

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: every prior story of this epic. This document states what the code does; write it last.
Kind: story-foundation

This story creates the run-model document and records the half EPIC 050 implements: the run kinds,
the fence column, the exclusion rules, the base set, the provenance and the budgets. EPIC 050.1
Story 9 adds the claim half to the same file, and EPIC 050.2 Story 9 adds the authority half. It
draws no path.

## Change

**Create `docs/proposal/phase-2/runs-and-exclusion.md`.**

Mirror the structure of `docs/proposal/phase-2/agents-and-workers.md`: line 1 is the `#` title, line 3 is a one-line reviewer-and-scope stanza, and every section below is a `##` heading written as a sentence, unnumbered. A section body is one declarative paragraph, or a numbered list with one owner per step.

```
1: # Runs and exclusion
3: Reviewer: runtime or backend engineer. Phase 2. What a checkpoint is belongs to `checkpoints.md`. This file is the run that carries one.
```

Sections, in this order, each stating the rule the code enforces:

- **`## Three run kinds, selected by the node deliverable`** — `structural`, `execution`, `review`. The mapping table: `expansion` to `structural`; `test` and `implementation` to `execution`; `review` to `review`. State that the worker metadata does not select the kind, and that `research` is absent because this phase defers the deliverable.

- **`## The run owns the fence`** — the fence is a counter on the run. Every later write carries the run id and the fence. The daemon raises the fence when it ends a run, and at no other time. What a later write does with the pair belongs to the authority section a later epic adds.

- **`## A run covers the claimed node and every descendant`** — at most one active run over a node. State that the `run_one_active` partial index defends the same-node case only, and that the subtree rule is a pure function over the ancestor, descendant and target sets. State the liveness boundary: a run whose expiry has passed is not counted, and the boundary instant is expired.

- **`## One active run per objective branch, and a task claim is refused rather than queued`** — the refusal is `objective-busy` and it names the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when. The daemon holds no queue. A blocking wait would hold one request open for a run lifetime, and a queue would make the daemon a scheduler. The caller retries. State that one liveness predicate governs this rule and the subtree rule, so the two cannot disagree about an expired run.

- **`## base is a set qualified by repository`** — it lives in `run_base`, keyed by run and repository. An `execution` run holds at most one row, and a `structural` or `review` run holds none, because a structural run claims an initiative, which owns no repository. State that the lower bound rises to exactly one in the epic that writes the row. State that `graph_revision` is recorded on every run and compared only at the structural checkpoint.

- **`## Provenance is two columns, not a blob`** — the run holds the worker id and the agent list from the registry entry. An external run records an empty agent list, because a self-managed harness selects its own agents and the daemon observes none. The daemon knows both at claim time and asks the worker for neither.

- **`## Both run budgets are configuration`** — `runTtlMs` and `runMaxLifetimeMs` are settings, and both are validated at startup: a `runTtlMs` below 1000 is refused, a `runMaxLifetimeMs` below `runTtlMs` is refused, and a non-integer is refused. State that a run carries both as absolute timestamps. The renew formula belongs to the epic that ships the renew.

- **`## Migration 12 lands the final shape`** — there are no deployments, so the migration rebuilds `run` empty rather than backfilling it. State what it removes: `lease_fence`, `base_oid`, the `objective` and `task` members of the kind set, and `node.worker`. State what it makes non-null: `fence`, `agents_json`, `expires_at`, `max_lifetime_at`, `node.deliverable` and `node.verify_json`. State that it discards every `run` and `attempt` row and touches no other table, and that it refuses to run while any node holds a null deliverable.

**Add one row to the `## Files` table in `docs/proposal/phase-2/README.md:19-25`**, in the table's existing two-column form:

```
| [runs-and-exclusion.md](runs-and-exclusion.md)               | run kinds, the fence, run authority, exclusion, expiry            |
```

## Constraints

- The document records the decision, not the search for it. State the rule and the constraint it imposes. Cut every alternative, rejection and comparison. A "why" sentence is admitted only where the rule is surprising without it, as in the no-queue rule above.
- **Write no section this epic does not implement.** The claim, the refusal order, the review refusal and the expiry pass belong to EPIC 050.1 Story 9. Run authority, the renew and the release belong to EPIC 050.2 Story 9. A section written here that a later epic implements makes this story unprovable in dispatch order.
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

3. `"the run model document names both exclusion refusal codes"` — read the file and assert it contains the `refusal` value of each exclusion rule. Build the two expected strings by calling `subtreeExclusion` and `objectiveBusy` with a refusing fixture and reading `result.refusal`, rather than restating the literals, so the document and the two pure functions cannot drift. Do not import a refusal tuple this epic does not export.

`pnpm run verify` exits 0. `pnpm run format` runs prettier over `docs`, so the tables must be prettier-formatted.

Proof: no PASS line of its own. This story is the documentation half of `PASS EPIC-050` and is gated by `pnpm run verify`.

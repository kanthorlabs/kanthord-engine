# Story 18 — What EPIC 110 consumes from this epic

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 7 and Story 3. **This is a planning-document story. It edits no source file and no test.**

`.agents/plan/epics/013-external-drive-overview.md:124` creates the obligation and no other story delivers it.

## Change

### The published surface, stated once

Record in `.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md` that EPIC 018 publishes exactly this, and nothing more:

- `Lease` with `acquire`, `renew`, `release`, `expired`, `expireLeasesOfOwner`, `read` and `assertHeld`.
- `AcquireLeaseResult`, carrying `record` and `acquired`.
- `LeaseRecord`, carrying `ownerKind`.
- Every input carrying `now` and `ownerKind`; `AcquireLeaseInput` and `ReleaseLeaseInput` also carrying `owner`.
- `LeaseError` with the codes `lease-held` and `lease-fenced`.
- `liveLeaseRefusal` in `src/domain/lease-hierarchy.ts`, with `leaseRelations`.

`.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md:73` already names `read` and `assertHeld` and already assumes the `now` member, so those parts agree today and need no edit.

### Three corrections, written into EPIC 110 in this same change

**First — one lease row, not two.** EPIC 110's objective lease is the **same** `lease` row this epic writes, on `subject_kind = 'node'` with the objective identity as `subject_id`. State the consequence in both directions: an external task lease refuses `claimObjective`, and a phase-2 objective lease refuses an external claim. That single row is what makes the hierarchy rule real rather than advisory.

**Second — the migration number.** EPIC 110's migration is no longer `6`. EPIC 017 takes `0006`, this epic takes `0007` and EPIC 105 takes `0008`. The file name becomes `0009-one-objective-run`, and every reference to `6` in that epic's migration story changes with it.

**Third — the objective-run index needs a driver predicate.** EPIC 110's `run_one_active_objective` keys on `kind` alone, so one long-lived external objective run would block the internal worker daemon-wide. It gains the predicate `AND driver = 'internal'`. In the same correction, EPIC 110's `run` and `attempt` writes set `driver: 'internal'` **explicitly**, because `openRun` and `openAttempt` of Story 8 write `external` unconditionally and EPIC 110 is what widens them.

**Lease provenance wording.** EPIC 110's lease provenance text names `owner_kind = 'daemon'` for a worker holding, and `owner_kind = 'actor'` for a harness holding.

## Constraints

- Edit only `.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md`.
- Do not edit `.agents/plan/epics/018-claim-and-lease.md`.
- Do not edit any file under `src/`, `test/` or `docs/`.
- Do not implement any part of EPIC 110.
- Change no decision of EPIC 110 beyond the four corrections above.

## Verify

- `git diff --name-only` lists exactly one path, `.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md`.
- Grep the edited epic and confirm each of these:
  - no occurrence of `0006-one-objective-run` or a migration version `6` in its migration story;
  - one occurrence of `0009-one-objective-run`;
  - every `run_one_active_objective` mention carries `AND driver = 'internal'`;
  - the published-surface list above appears once, and it names all seven `Lease` methods.
- `npm run verify` exits 0, unchanged by this story.
- Proof: this story delivers no `PASS` line of the Proof block. It closes the reconciliation obligation of `.agents/plan/epics/013-external-drive-overview.md:124`, which the Gates line covers through `npm run verify` staying green.

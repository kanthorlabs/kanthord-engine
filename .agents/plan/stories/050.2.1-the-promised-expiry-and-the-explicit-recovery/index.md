# EPIC 050.2.1 — The promised expiry and the explicit recovery

Epic: `.agents/plan/epics/050.2.1-the-promised-expiry-and-the-explicit-recovery.md`

The daemon promises an expiry and keeps it. When a client outlives the authority it was given, the
client is told and chooses. No path recovers on a client's behalf.

## Stories

- 1 — The lost objective run is announced → `01-the-lost-objective-run-is-announced.md`
- 2 — The explicit recovery → `02-the-explicit-recovery.md`

## Decisions taken during authoring, and now recorded in the EPIC

- **A human ruled the rule, and it decided the shape.** Two designs were drawn and refused before this
  one. The first had the renew end the structural objective run and mint a replacement, handing the
  new authority back in the response; the second had the expiry pass renew a due structural run past
  its own maximum lifetime while live work sat under it. Both are silent recovery: one decides that
  the work continues, the other decides that a stated deadline was not meant. What survives is the
  part that keeps the promise and reports the failure.

- **This epic exists because EPIC 050.2 was full.** `scripts/verify-epic-sequence.ts:442` caps an epic
  at ten stories and EPIC 050.2 holds ten. The cap is the right signal: this work is a separate
  ruling arrived at after that epic was authored, and it reads better as its own decision than as an
  eleventh entry under a goal it does not share.

- **Only the objective is widened.** A task whose run expired returns to `ready` when its lease
  expires, at `src/commands/startup/recover-expired-leases.ts:129-133`. Nothing returns an objective
  to `ready`, so an objective whose structural run expired with no claimable task left under it could
  never be attested or closed. The claim admission is objective-shaped because the defect is.

- **The refusal is ordered, not merely added.** EPIC 050.2 Story 3 (`03-the-renew`) moved
  `execution.activeRunOfNode` ahead of the first lease write for this epic's refusal alone. A refusal
  writes nothing, and a read taken after the writes it would roll back cannot serve one.

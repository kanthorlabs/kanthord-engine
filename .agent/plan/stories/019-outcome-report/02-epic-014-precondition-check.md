# Story 2 — The EPIC 014 amendment, verified and not re-landed

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: EPIC 014.

**This story edits no file.** The EPIC 019 bullet at `019-outcome-report.md:60` names three row changes and the drive-mode pin as EPIC 014's work, and EPIC 014's stories already carry all four:

- `.agent/plan/stories/014-external-drive-contract/12-external-transition-table.md` writes the `outcome-accepted` row with `reportedObjectId: "required"` and the `object-reported` row with `leaseFence: "valid"` and `actorKind: "harness"`.
- `.agent/plan/stories/014-external-drive-contract/14-drive-mode-pin.md` writes `objectiveDrivePin`.
- `.agent/plan/stories/014-external-drive-contract/15-trigger-consumer-map.md` maps `object-reported` to `src/commands/outcome/report-objective.ts` and forbids `src/commands/outcome/aggregate-objective.ts`.

The story exists so the pass proves the precondition before Story 5 widens the table. A failure here is an EPIC 014 regression, not work for this epic.

## Change

None. Assert only.

## Constraints

- Do not edit `src/domain/external-transition.ts` in this story. Story 5 owns the two new rows and the two new consumer entries.
- Do not edit any file under `.agent/plan/`.

## Verify

- `node --test src/domain/external-transition.test.ts` exits 0.
- Read `src/domain/external-transition.ts` and confirm each fact by identity, not by count:
  - the `outcome-accepted` row carries `reportedObjectId: "required"`;
  - the `object-reported` row carries `leaseFence: "valid"` and `actorKind: "harness"`;
  - `externalTriggerConsumer["object-reported"] === "src/commands/outcome/report-objective.ts"`;
  - no value of `externalTriggerConsumer` contains `aggregate-objective`;
  - `objectiveDrivePin` is exported.
  - `internalTransitions` holds `initiative-aggregated-done`, `initiative-aggregated-partial` and `initiative-aggregated-discarded`.
- If any fact is false, stop the epic and report it. Do not repair EPIC 014 from here.
- Proof: `src/domain/external-transition.test.ts` of the Proof block, as its precondition.

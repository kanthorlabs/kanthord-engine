# Story 12 — The human gate

Epic: `.agents/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 11. The rehearsal must be green before the drive begins.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:143`. Ulrich drives the `P1B-E2` journey himself, through the CLI, on the commit under test. **This is the acceptance axis, and the block does not exit without it.**

## Change

### The drive

Ulrich drives, through the CLI only, on the commit under test:

- register two harness actors;
- claim and report from each;
- close an objective as the bootstrap `human` actor.

Every step of the drive and every checklist row is one command. `kanthord event list`, which EPIC 020 ships, covers the last read the checklist needed, so **no row needs a hand-authored HTTP request**.

### The six checklist rows

Ulrich answers each row `confirmed` or `rejected`. The coding agent writes each answer into the manifest **input file** as a `checklist` row `{ row, subject, answer, note }`, in row order 1 to 6. Story 13 records the manifest once, with these rows in it.

| #   | Subject                              | What Ulrich confirms                                                                                                                                                                                      |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The graph reads as the plan          | `node list`, `project node`, `node show` and `project graph` describe the same work the imported plan describes. A state he did not expect is a finding, not a lookup.                                    |
| 2   | The work is attributed               | `kanthord event list --type lease.claimed` and `kanthord event list --type outcome.reported`, run with the configured human token, name one actor per action. The two harness actor ids differ.           |
| 3   | The result is readable from the node | `node show` on the finished objective returns the `attestedObjectId` its harness attested and the `projection` the daemon computed, per `019-outcome-report.md:77`. He reads no database and no log file. |
| 4   | The refusal is legible               | The `409 lease-held` a second harness receives says which node is held, and a human reads the reason without a stack trace.                                                                               |
| 5   | The close is a human act             | An objective at `awaiting_approval` is closed by `node close` with the human token, and the command a human recognizes is one command.                                                                    |
| 6   | The block broke nothing he uses      | The phase-1 journey he signed for EPIC 012 still reads the same through the same commands, with the ready frontier of EPIC 016 in place of the all-`pending` import.                                      |

**A `rejected` answer on any row is a blocker.** The manifest row carries the note, and the acceptance note names the row.

### The signature

One invocation signs the drive and the judgment:

```sh
node scripts/e2e/run.mjs --record-acceptance --tag "$TAG" --by Ulrich \
  --drive confirmed --judgment accepted --note-file "$NOTE"
```

`--drive` is `confirmed` or `not-confirmed`. `--judgment` is `accepted` or `rejected`. A note file is mandatory for `not-confirmed` and for `rejected`, enforced at `scripts/e2e/lib/main.ts:322-332`.

## Constraints

- **The signature is written once.** `recordAcceptance` refuses a second write at `scripts/e2e/lib/record/acceptance.ts:96-100` with `tag-reused`, because a signature is not edited. **The manifest is written once too**, at `manifest.ts:291-296`, so correct the checklist in the manifest input file before Story 13 records it. Sign the acceptance record only after the six answers are settled.
- **The signed record carries one `drive`, one `judgment` and one free-form `note`** — `AcceptanceRecord` at `scripts/e2e/lib/record/acceptance.ts:21-31` holds nine fields and no per-row structure. **The manifest is the only place a row appears by itself.**
- Ulrich drives the journey. He does not read a transcript of the rehearsal. That the human drove it is a reviewer judgment, recorded by `--drive confirmed`, per `025-external-drive-acceptance-run.md:46`.
- The checklist answers being truthful is a reviewer judgment. No mechanism checks it.
- Drive through the CLI only. Open no database and read no log file.
- Repair no defect found here. A rejected row opens a fix epic in Story 13.

## Verify

- `.data/acceptance-<tag>/acceptance.json` exists and names `by`, `drive: confirmed`, `judgment: accepted`, the commit under test and the proposal revision.
- A second `--record-acceptance` for the same tag exits `2` with `tag-reused`, and the file on disk stays byte-identical.
- The manifest **input file** holds exactly six `checklist` rows, numbered 1 to 6, each with an `answer` of `confirmed` or `rejected`, and each `rejected` row carries a non-empty `note`.
- `.data/acceptance-<tag>/manifest.json` still does not exist; Story 13 records it. `node scripts/e2e/run.mjs --check-manifest "$TAG"` is Story 13's check on the recorded checklist, and it is the mechanism `025-external-drive-acceptance-run.md:41` names; the acceptance record represents no row by itself.
- The acceptance record names the same commit as every bundle and the verify record.
- Proof: lines `212` and `213` of the run block at `025-external-drive-acceptance-run.md:200-218`.

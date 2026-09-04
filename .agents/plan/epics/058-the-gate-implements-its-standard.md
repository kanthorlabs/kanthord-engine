# EPIC 058 — The gate implements its standard

Status: **draft**. It follows EPIC 057 by sequence order. It consumes the range gate of EPIC 050.1
Story 8 (`08-the-range-gate`), the `authoredEpics` and `shippedEpics` data of EPIC 050.1 Story 7
(`07-the-conformance-runner`), and the `groundwork-engineer` lane of `scripts/lane-check.sh`.

## Goal

- `scripts/verify-epic-sequence.ts` refuses every condition `.agents/plan/authoring.md` states it
  refuses, and `.agents/plan/authoring.md` marks the two it does not.
- The 201 story references and citations that are wrong today resolve, and the gate refuses the next
  one.
- `pnpm run verify` runs the gate directly, and `.agents/plan/authoring.md` describes the mechanism
  that exists.

## Non-goals

- **No conversion of a reference that already carries no stem.** 1177 in-range references write an
  ordinal alone. `.agents/plan/authoring.md` marks that half of bullet 23 as unbuilt, and this epic
  builds the half that resolves a stem already written.
- **No conversion of a citation that already carries no identifier.** 367 in-range citations into
  `src/`, `test/` or `scripts/` write two parts. `.agents/plan/authoring.md` marks that half of
  bullet 24 as unbuilt, and this epic builds the half that resolves an identifier already written.
- **No epic outside `authoredEpics` is touched.** `.agents/plan/authoring.md:420` grandfathers every
  epic outside the range with no annotation. The 614 out-of-range plan files keep their form.
- **No amendment of EPIC 050.1 Story 8.** That story shipped its own sixteen refusals whole, plus
  three more. The six missing refusals entered `.agents/plan/authoring.md` after it, so they are new
  work and not a defect of it.
- **No gate-table conversion for EPIC 054 and EPIC 057.**
  `.agents/plan/pending/gate-table-retrofit.md` owns those, each needs a proof owner Ulrich decides,
  and neither epic is in `authoredEpics`.

## Decisions

- **The six refusals are new work, not unfinished work.** At commit `04376fb`, which built
  `scripts/verify-epic-sequence.ts`, `.agents/plan/authoring.md` carried none of bullets 20 to 25.
  Commit `773587b` added bullets 20, 21 and 22 with no check. Commit `bf633f5`, titled
  `give the standard its mechanisms`, added bullets 23, 24 and 25 as prose.
  `git log 04376fb..HEAD -- scripts/verify-epic-sequence.ts` is empty. The gate implements
  `.agents/plan/stories/050.1-the-claim/08-the-range-gate.md:20`–`:37` exactly.

- **Bullet 23 and bullet 24 each split into a detection half and a conversion half, and this epic
  builds detection only.** Detection refuses a stem or an identifier that is written and wrong, and
  costs 201 repairs. Conversion requires a stem or an identifier where none is written, and costs 1544. Detection catches 201 errors that exist today; conversion catches none, because a reference
  with no stem and a citation with no identifier are unfalsifiable by construction. The conversion
  halves are marked unbuilt in `.agents/plan/authoring.md`, under the honesty discipline of `:406`.

- **A story ordinal is a dispatch position, not a filename prefix.** An epic holding
  `00-groundwork.md` numbers its second file `01-` and calls it Story 2, and
  `.agents/plan/stories/050.6-the-process-capability/00-groundwork.md:86` writes exactly that.
  Bullet 23 therefore resolves the stem against the epic's story set and never compares the ordinal
  to the prefix. A check that compares them refuses 48 correct references.

- **The 20 dead stems are the proof the rule is needed, and 11 of them are one day old.** Commit
  `d5669e4` split EPIC 052.1 and renumbered its stories 4 through 9. Six files still attribute the
  stem `09-the-contract-and-the-proposal` to EPIC 052.1; it moved to EPIC 052.2 and is now that
  epic's first story, `01-the-contract-carries-the-patch`. Two more attribute
  `04-an-illegal-target-scope-or-project` to it, and one attributes `07-the-accepted-patch`. No file
  of those three names exists.

- **A story that quotes a broken reference names the stem alone.** This epic and its stories cite
  dead stems as evidence, and bullet 23 cannot separate a reference from a quotation of one — the
  same limit bullet 22 has, resolved the same way. Write the stem in its own code span and attribute
  it in prose. Never write the refused form to illustrate it, because the gate then refuses the
  document that reports the defect.

- **The range is `authoredEpics`, and the shipped epics are in it.** EPIC 050 and EPIC 050.1 are in
  `shippedEpics` and neither may be excluded. `.agents/plan/authoring.md:426` forbids wiring a gate
  whose range fails, and removing an epic from `authoredEpics` instead makes
  `scripts/verify-epic-sequence.ts:709` throw `scenario ... names no live diagram` for all four files
  under `test/sequence/scenarios/`, every one owned by EPIC 050.1.

- **A check and the repair it forces land in one story.**
  `scripts/verify-epic-sequence.test.ts:880` — `the real plan tree passes the range gate` asserts the
  real tree is green. A refusal added before its repair makes that assertion fail, so no story ends
  with the gate red.

- **Bullet 22 fires only on an explicit edit directive, and exempts every path locked to all roles.**
  As written it is not implementable. It cannot separate an edited path from a quoted one: a
  `## Change` names `AGENTS.md` twenty times, mostly as evidence, and quotes relative import
  specifiers such as `../../domain/pid.ts` that are not repository paths. It also contradicts
  `.agents/plan/authoring.md:125`, which states the plan tree, the pipeline definition and the
  pipeline guards are never in `Paths:` — so its own remedy is forbidden for the sixteen sites naming
  such a path. **The form is a bold directive whose first word is a verb, carrying the path in a code
  span** — `**Create `scripts/x.ts`**`, `**Add a row to `AGENTS.md`**`. A path in ordinary prose is a
  citation, and the gate ignores it.

- **The locked-path exemption is derived, never restated.** The gate calls `scripts/lane-check.sh`
  with `groundwork-engineer` and exempts every path it denies, so the guard list of
  `scripts/lane-check.sh:36`–`:40` lives in one place.

- **EPIC 058 adds its own id to `authoredEpics`.**
  `.agents/plan/stories/050.1-the-claim/08-the-range-gate.md:17` states the epic that authors an id
  adds it in the same change. The id lands only once this epic's story directory exists, because
  `scripts/verify-epic-sequence.ts:436` refuses an id with no directory. The last story makes the
  addition, after every refusal and every repair is green.

- **`pnpm run verify` calls the gate directly, and this epic pulls the trigger.** Two statements
  contradict each other today and both are retired:
  `.agents/plan/stories/050.1-the-claim/08-the-range-gate.md:44` names the last story of EPIC 050.5,
  and `.agents/plan/pending/gate-table-retrofit.md:54` names EPIC 057. The gate reaches CI today only
  through `pnpm test`, so `.agents/plan/authoring.md:24` is false as written.

- **This epic introduces no event type**, changes no command, query or nested command, and moves no
  seam. Every story is `story-foundation`, and the epic holds no diagram and no baseline.

## Stories

Each entry is a name and the output it contributes. The story file holds the change and the tasks,
and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **Groundwork** — `package.json` gains `node scripts/verify-epic-sequence.ts` in the `verify`
   script. `story-foundation`, `Executor: groundwork-engineer`, `Paths: package.json`. First in
   dispatch order, and its effect is verified last, because `.agents/plan/authoring.md:426` refuses a
   gate that lands red.
2. **The lane refusals** — bullets 20 and 21 in `scripts/verify-epic-sequence.ts`, plus the two
   `Paths:` repairs they find: `package.json` in the `Paths:` line of both
   `050.4-the-node-lease-removal/00-groundwork` and `050.5-the-lease-table-removal/00-groundwork`,
   and `eslint.config.js` in both `050.5-the-lease-table-removal/00-groundwork` and
   `050.6-the-process-capability/00-groundwork`. `story-foundation`.
3. **The gate-table refusal** — bullet 25 in `scripts/verify-epic-sequence.ts`, plus the conversion
   of the hermetic-coverage list of `epics/050-the-run-the-fence-and-exclusion.md` and
   `epics/050.1-the-claim.md` from a bullet list to a table. `story-foundation`.
4. **The edit-directive refusal** — the sentence in `.agents/plan/authoring.md` that fixes the edit
   directive form, bullet 22 narrowed to it in `scripts/verify-epic-sequence.ts`, and the 26 repairs
   it then finds. `story-foundation`.
5. **A stem resolves** — the detection half of bullet 23 in `scripts/verify-epic-sequence.ts`, plus
   the 20 dead stems it finds, 11 of them from commit `d5669e4`. `story-foundation`.
6. **A citation resolves** — the detection half of bullet 24 in `scripts/verify-epic-sequence.ts`,
   plus the 181 stale citations it finds: 78 repoint to a unique line, 100 name an identifier on
   several lines and go to a report, 3 name an identifier absent from the file. `story-foundation`.
7. **The standard describes what exists** — `.agents/plan/authoring.md:24`, `:407` and `:417`, the
   two conversion halves marked unbuilt at `:395`–`:398`,
   `.agents/plan/stories/050.1-the-claim/08-the-range-gate.md:44`,
   `.agents/plan/pending/gate-table-retrofit.md`, and `"058"` appended to `authoredEpics` in
   `scripts/epic-sequence-range.ts`. `story-foundation`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 050.1 Story 8 (`08-the-range-gate`), at `:44`.** That story states the `verify` wiring lands
  in the change that completes the last story of EPIC 050.5. This epic's groundwork story
  (`00-groundwork`) takes the wiring instead, so the sentence names a change that will never do it.
  Delete the sentence, or replace it with a pointer to this epic. **Default if no ruling arrives:**
  this epic's last story rewrites the sentence to name EPIC 058, and reports the edit of a shipped
  story in its review. **Cost of a late ruling:** a shipped story keeps a false rollout claim, and
  the next reader of the gate's own story is told the wrong epic wires it.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  scripts/verify-epic-sequence.test.ts \
  && node scripts/verify-epic-sequence.ts \
  && echo "PASS EPIC-058"
```

Hermetic coverage required beyond the Proof. **Every row names exactly one proof owner.**

| #   | assertion                                                                                                                                                                                      | story |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `pnpm run verify` runs `node scripts/verify-epic-sequence.ts` as its own step, asserted by reading the `verify` script of `package.json` for the exact token.                                  | 1     |
| 2   | A story declaring `Executor:` and no `Paths:` is refused, and a story declaring `Paths:` and no `Executor:` is refused. Both directions, one fixture each.                                     | 2     |
| 3   | A `story-implement` carrying `Executor:` is refused, and one carrying `Paths:` is refused. A `story-foundation` carrying both passes, so the refusal is not a blanket ban.                     | 2     |
| 4   | A `Paths:` path that `scripts/lane-check.sh` allows to `test-engineer` is refused, and one it allows to `software-engineer` is refused.                                                        | 2     |
| 5   | A `Paths:` path that `scripts/lane-check.sh` denies to `groundwork-engineer` is refused, and one it allows passes. The control proves the check reads the role and not the path alone.         | 2     |
| 6   | A path in the `Paths:` line of two stories is refused, and the same path in one story passes.                                                                                                  | 2     |
| 7   | The real tree holds no `Paths:` path in two stories after the repair, and the pre-repair tree fails the same assertion. The control that it detects the duplicate.                             | 2     |
| 8   | A hermetic-coverage list that is a bullet list is refused, and one that is a table with a `story` column passes.                                                                               | 3     |
| 9   | A gate table row whose `story` cell names two stories is refused, and a row naming none is refused. Both directions.                                                                           | 3     |
| 10  | Every gate assertion of `epics/050-the-run-the-fence-and-exclusion.md` and `epics/050.1-the-claim.md` survives the conversion, asserted by comparing the assertion set before and after.       | 3     |
| 11  | A `## Change` edit directive naming a both-denied path that no `Paths:` line declares is refused.                                                                                              | 4     |
| 12  | A `## Change` that cites the same path in ordinary prose passes. The control that separates naming from quoting.                                                                               | 4     |
| 13  | A `## Change` edit directive naming a path `scripts/lane-check.sh` denies to `groundwork-engineer` is not refused, because `.agents/plan/authoring.md:125` forbids the remedy.                 | 4     |
| 14  | A reference whose stem names no story of the named epic is refused, and one whose stem resolves passes.                                                                                        | 5     |
| 15  | A reference whose ordinal is the dispatch position of a `00-groundwork` epic passes, over a fixture holding `00-groundwork.md` and `01-*.md`. The control against comparing ordinal to prefix. | 5     |
| 16  | Every stemmed reference of the real tree resolves after the repair, and the pre-repair tree fails on 20 of them.                                                                               | 5     |
| 17  | A citation naming an absent file is refused, one naming a line beyond end of file is refused, and one naming a line that does not hold its identifier is refused. Three directions.            | 6     |
| 18  | A three-part citation whose line holds its identifier passes, over a target under `src/`, `test/`, `scripts/`, `docs/` and `.agents/`. The control that the refusal is not a ban on citations. | 6     |
| 19  | A two-part citation is not refused, in every one of the five trees. The boundary of the detection-only half, asserted so the conversion half cannot land by accident.                          | 6     |
| 20  | Every three-part citation of the real tree resolves after the repair, and the pre-repair tree fails on 181 of them.                                                                            | 6     |
| 21  | `.agents/plan/authoring.md` holds no `Not built.` token for the gate, and marks exactly two refusal halves unbuilt, asserted by value.                                                         | 7     |
| 22  | `.agents/plan/pending/gate-table-retrofit.md` names only the epics that still hold a bullet list, asserted against the gate's own bullet 25 output over the whole plan tree.                   | 7     |
| 23  | `authoredEpics` holds `"058"`, and the gate passes over the range that includes this epic's own stories.                                                                                       | 7     |

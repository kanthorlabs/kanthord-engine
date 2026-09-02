# EPIC 051 — the story tree, and the 22 diagrams that must leave the epic file

**The obligation.** `.agents/plan/epics/051-the-execution-checkpoint.md` holds 22 `mermaid` blocks
and owns no story directory. `.agents/plan/authoring.md:34-36` refuses a diagram in an epic file, and
`.agents/plan/authoring.md:322` lists that refusal in the gate. Create
`.agents/plan/stories/051-the-execution-checkpoint/` and move every diagram into the story that owns
its path. Delete no diagram: the epic's own `## Known defect` section at `:5-36` states which four
things the conversion repairs, and it is the input to the work.

**The owner.** `/author`, invoked on EPIC 051 by Ulrich. It is an epic-sized job, and no smaller
repair discharges it.

**The trigger.** `scripts/verify-epic-sequence.ts` entering the `verify` script of `package.json`.
`.agents/plan/stories/050.1-the-claim/08-the-range-gate.md:39-42` builds the script in EPIC 050.1 and
defers that wiring to _"the change that completes the last story of the range"_. The range is
EPIC 050 to EPIC 057, so EPIC 057 is the change that pulls the trigger. Convert EPIC 051 before that
change, and not after.

**What breaks if the answer arrives late.** The gate refuses an epic file holding a mermaid block on
its first rule, so `pnpm run verify` fails the moment the wiring lands. The wiring change then either
merges a red gate, which `.agents/plan/authoring.md:375` refuses, or reverts, which leaves the range
unenforced for every epic after it.

**What is deliberately not requested.** Do not delete the diagrams to pass the gate, and do not
exempt EPIC 051 from the range. Both trade the contract of 22 paths for a green script.

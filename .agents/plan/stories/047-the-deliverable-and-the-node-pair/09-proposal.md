# Story 09 — The proposal records the model

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`

## Change

Create `docs/proposal/phase-2/deliverables-and-pairs.md`.

The document states, in this order:

1. The four deliverables in the canonical tuple order: `test`, `implementation`, `review`, `expansion`, and a statement that `research` is deliberately absent in this phase. State that a deliverable is an outcome and never an agent name.
2. The complete pair table with all 12 concrete pairs: kind, deliverable, legal (yes/no), shape (`parent` / `atomic`), and state owner (`aggregate` / `attestation-then-human` / `report`). The five illegal pairs are marked explicitly.
3. The `verify` block contract: a strict two-key object with `paths` (sorted set of repository-relative paths) and `commands` (ordered sequence of shell strings). An empty `commands` list asserts nothing. The consequence of an empty `commands` list depends on node shape: for a `parent` initiative or objective it is the correct and final value (no command to run); for an `atomic` node it means the node declares no check, and such a node is ineligible for claim. EPIC 049 records ineligibility in the conversion report; EPIC 050 owns the claim-time rule. This epic stores the value only — it draws no eligibility conclusion.
4. The pair-fixing rule: a pair is fixed once the node holds a child or an accepted checkpoint. In EPIC 047, no writer can change a pair in place because `deliverable` joins neither `proseFields` nor `structuralFields`. EPIC 052 enforces the rule at the structural patch.
5. The transitional meaning of a null `deliverable`: a node imported before EPIC 047 holds a null `deliverable`. It is not subject to pair validation. Claim eligibility for null-deliverable nodes is not defined by this epic — EPIC 050 owns that rule.
6. The legacy `node.worker` field: it remains through EPIC 056. EPIC 057 removes it.

## Constraints

- No code, no tables of file paths. Prose only.
- State decisions and constraints — cut alternatives and history.

## Verify

- `docs/proposal/phase-2/deliverables-and-pairs.md` exists and is non-empty.
- `pnpm run verify` exits 0.

Proof: no Proof line in the EPIC Proof block covers this story — it is a documentation story with no test. `pnpm run verify` passing confirms no build or lint regression.

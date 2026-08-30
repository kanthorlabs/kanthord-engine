# Story 11 — The dependency plan records the moved route

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 9

## Change

- Read `.agents/plan/epics/100-phase-2-overview.md`. Find the EPIC 106 goal paragraph — the one containing the phrase "`agent.list` publishes those allow lists, so the epic closes on a route."
- Replace that phrase with: "`agent.list` closes in EPIC 048. EPIC 106 closes on the adapter: the exclusion computation, the assertion that the session exposes exactly the allow list, and the fail-closed behaviour."
- If the EPIC 106 row in the overview table contains a "closes on" note referencing `agent.list`, update that note to state: "`agent.list` moved to EPIC 048; closes on adapter assertions."

## Constraints

- Edit only the EPIC 106 text. Do not amend any other row or epic.
- Do not alter the table column structure.

## Verify

- `grep -n "agent.list" .agents/plan/epics/100-phase-2-overview.md` produces no output that states EPIC 106 closes on `agent.list`.
- `pnpm run verify` exits 0.
- Proof: none in the `PASS EPIC-048` Proof block. This story satisfies the plan-consistency requirement only.

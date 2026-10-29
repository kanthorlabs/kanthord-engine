# Dogfood fix plan decisions

The plans cite these decisions as D1 to D9. Each decision binds every plan and every task of this set.

## D1 — Source and gaps

The design pages under `docs/brainstorm/` of the root repository at `08f65c9` are the rule (`engine/AGENTS.md:3-6`). The reference pages under `docs/reference/` follow them. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — `holder_mismatch` of a server instance

`worker.instance.list` answers `holder_mismatch: false` for an instance at the `server` or the `container` placement (`docs/brainstorm/worker-service.impl.md:544`). The service runs no agent view for such an instance. A server instance is an instance at the `server` or the `container` placement (`engine/docs/cli/worker.md:41-42`). The value of a `worker` instance does not change.

## D3 — Archive on the worker page

The Archive row action of the worker page follows the same rule as the instance page (`docs/brainstorm/architecture.impl.md:1281-1283`):

- A listing binding disables Archive and names the detach.
- A live execution with no listing binding disables nothing. The dialog holds the checkbox `Stop the live execution`, and the confirm sends `force: true`.

## D4 — Orphans

A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.

## D5 — K2: the budget end in the run report

RULED 2026-10-29 by Ulrich (open item O1, option A): the dogfood run report reads the `worker.task` spans of each trace with `tracking span list` and prints each `kanthord.task.result: budget_end`. Aelita added that section to the local `report.mjs` files of the dogfood run. No plan of this set changes the engine or the dashboard for K2.

## D6 — K3 and K4: one decision for each assessment

RULED 2026-10-29 by Ulrich (open item O2, option B). One operation, `mission.proposal.decide`, takes the approved proposal identities of one assessment. In one transaction it creates every fix node and its dependency, rejects every other open proposal of the assessment and unblocks the proposer once. A repeated or stale decision answers a clean refusal and writes nothing. `mission.proposal.approve` goes away, with no backward compatibility. A node unblock, a node discard or a node override of a `Blocked` proposer rejects every open proposal of the assessment that blocked it. The CLI offers the same decision with the same answers and refusals. Ulrich approved these rules on root pull request #276.

## D7 — Source of plans 03 and 04

The pages of root pull request #276 (branch `docs/assessment-decision`, head `1809726`) are the rule for plans 03 and 04. The rules are in `docs/brainstorm/mission-service.impl.md` "The fix-node proposal" and "The mission screen of the dashboard", and in `docs/reference/mission/assessment.md` "Fix-node proposals". Plan 03 starts after Ulrich approves pull request #276. When a later commit of pull request #276 shifts a line, the executor re-anchors the citation before the task.

## D8 — The proposal record adds `rejected_at`

`mission_proposal` adds the nullable column `rejected_at INTEGER`. The executor edits the `CREATE TABLE mission_proposal` text of `src/mission/migrations.ts` in place and adds no migration (`engine/AGENTS.md` "Code rules"). The project has no deployment, so no data migration exists. A developer discards a local database after the merge.

## D9 — The project of the worker pages

`/workers` and the worker page read the query `?project=<project id>` with `useScopedProject` (apps `src/hooks/use-scoped-project.ts`). A value that names no listed project, or no value, falls back to the current project of `ProjectProvider`, which is the first project of the project list (apps `src/features/projects/project-context.tsx:23`). A link from `/workers` to a worker page keeps the `?project=` value. The design link `Open workers` opens `/workers?project=<project>` (root `docs/brainstorm/architecture.impl.md:1657`).

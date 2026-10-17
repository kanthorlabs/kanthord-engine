# Plan 07: Dashboard — flat nodes, tasks and the match

## Scope

This plan moves the dashboard of `kanthorlabs/kanthord-apps` onto the engine contract of plan 05. It delivers:

- The API types of the flat node, the task content, the edge, the import entry, the dependency reads of an `examine` node, the proposal and the worker catalog.
- The mission graph without initiative bands: one layered graph of nodes, ranked by their dependencies.
- The `Tasks (<count>)` section of an `implement` node card from `node.tasks` (`mission-service.impl.md:496`). A card of a node with no task shows no section.
- The node sheet, the structure section, the proposal copy and the controls without kinds and containment.
- The work and trait match of the "no taker" view.
- The `Traits` field of a worker binding.
- The messages of `mission.node.requires_unmatched`, `mission.node.work_locked`, `project.bindings.worker.node_unmatched` and `project.bindings.worker.traits_invalid`.
- The workers screen with `declared_works`.
- The mock daemon of `mock/`.

Out of scope:

- The persona files `.claude/agents/*.md` and `.opencode/agents/*.md` (decision D21).
- `scripts/lane-check.test.sh`. Its paths name the plan pipeline, not a Mission node (decision D21).
- A requires editor on the node sheet. No node edit form of the dashboard writes `work` or `requires`.

## Model

Opus at medium effort. The graph layout has no design page line for its exact form, and the "no taker" match crosses three API reads.

## Sources

- `docs/brainstorm/mission-service.md:27-38` — `work` and `requires`.
- `docs/brainstorm/mission-service.md:40-46` — tasks are content of an `implement` node.
- `docs/brainstorm/mission-service.md:48-69` — the graph is the dependency edges alone.
- `docs/brainstorm/mission-service.impl.md:493-498` — the node read.
- `docs/brainstorm/mission-service.impl.md:261-312` — the dependency reads, the proposal and its approval.
- `docs/brainstorm/mission-service.impl.md:628-633` — the mission screen of the dashboard and the `Tasks (<count>)` section.
- `docs/brainstorm/scheduler-service.md:233-268` — the match and the unmatched pair.
- `docs/brainstorm/scheduler-service.impl.md:149-171` — `admits` and `covered`.
- `docs/brainstorm/project-service.md:97-109` — the traits of a worker binding.
- `docs/brainstorm/project-service.impl.md:172-173`, `:220` — the `traits` field.
- `docs/brainstorm/worker-service.impl.md:54-55`, `:95` — `declared_works` on the catalog item.
- `apps/AGENTS.md:123`, `:225` — the browser check against the mock daemon and the gate.
- Root `AGENTS.md:172-174` — the web app port, the `ego-browser` skill and the phone width.

## Depends on

- Plan 05 merged to `main` of the engine.
- Plan 06 runs in parallel. No file overlaps.

## Provides

The dashboard of the final engine contract for plan 08. No engine seam.

## Tasks

### 07.1 Rewrite the API types

- Files: `src/api/types.ts` (edit)
- Do:
  1. Replace `NodeKind` (`src/api/types.ts:9`) with `export type Work = "implement" | "examine"`.
  2. Replace `MissionNodeBase`, `MissionRunnableNode`, `MissionTaskNode` and the union `MissionNodeRecord` (`:600-623`) with one interface `MissionNodeRecord`. It holds `id`, `filename`, `mission_id`, `work`, `requires`, `tasks: readonly MissionTaskContent[]`, `state`, `attempt`, `priority`, `depends_on`, `visible_revision`, `content`, `retired_at`, `pinned_by_attempts` and `blocked_context?` (decision D4; `mission-service.impl.md:496`).
  3. `MissionContent` adds `work` and `requires` (decision D4). `MissionRevision.tasks` is required (`:653`).
  4. `MissionEdge` and `MissionRemovedEdge` (`:283-284`, `:625-627`) become `{ dependent_id; depends_on_id }` (decision D6). `MissionRevisionWrite` drops `"node.move"` (`:633`).
  5. `MissionPlanEntry` (`:234-245`) becomes the union of a node entry and a task entry of decision D7.
  6. `MissionAssessment` (`:530-545`): `child_outcome_ids` becomes `dependency_outcome_ids`, `child_node_ids` becomes `dependency_node_ids`.
  7. `MissionProposalContent.objective_id` (`:675`) becomes `dependency_id`. `MissionProposal.objective_node_id` (`:688`) becomes `created_node_id`. `MissionProposalApproveResult` (`:775-778`) becomes `{ created: MissionNodeChange; proposer: MissionControlResult }` (`mission-service.impl.md:307`).
  8. `WorkerCatalogItem` (`:62-67`) drops `required_node_format` and adds `declared_works: readonly Work[]`.
  9. `WorkerBindingConfig` (`:380-386`) adds `traits?: readonly string[]`.
- Cite: decisions D4, D6, D7; `mission-service.impl.md:307`, `:496`; `worker-service.impl.md:95`; `project-service.impl.md:220`.
- Verify: `pnpm exec vitest run src/api` passes.

### 07.2 Move the API resources and their tests

- Files: `src/api/resources/mission.ts`, `src/api/resources/mission.test.ts`, `src/api/resources/workers.test.ts`, `src/api/resources/workbench.test.ts` (edit)
- Do:
  1. `listMissionDependencies` (`src/api/resources/mission.ts:74-78`) sends no `kind` query.
  2. Each fixture record holds the shapes of task 07.1.
- Cite: decision D6.
- Verify: `pnpm exec vitest run src/api/resources`.

### 07.3 Build the flat mission graph model

- Files: `src/lib/mission-graph.ts`, `src/lib/mission-graph.test.ts`, `src/lib/edge-group.ts`, `src/lib/edge-group.test.ts` (edit)
- Do:
  1. Delete `ObjectiveCell`, `InitiativeBlock`, `liftedLinks`, `rankInitiatives`, `ancestorsOf`, `objectiveProgress` and `children` (`src/lib/mission-graph.ts:10-20`, `:93-111`, `:264-275`, `:311-316`).
  2. `GraphModel` holds `rows: readonly (readonly MissionNodeRecord[])[]`. `buildGraph` ranks each live node by the longest dependency path (`rankByLongestPath`) and orders a row by priority, then filename (`byPriorityThenFilename`).
  3. The diagnostic `unplaced-node` goes away. `unresolved-dependency` and `cycle` stay.
  4. `closureOf` answers the direct dependencies alone (`mission-service.md:52-53`). `ClosureMember.via` goes away.
  5. `edgeGroupOf` (`src/lib/edge-group.ts:22-28`) drops the task branch.
- Cite: `mission-service.md:48-69`; `mission-service.impl.md:493-498`.
- Verify: `pnpm exec vitest run src/lib/mission-graph.test.ts src/lib/edge-group.test.ts` with "a node ranks below every node that it depends on" and "the closure holds the direct dependencies alone".

### 07.4 Lay out the graph without bands

- Files: `src/lib/graph-layout.ts`, `src/lib/graph-layout.test.ts`, `src/features/projects/view/components/mission-graph.tsx`, `src/features/projects/view/components/graph-node.tsx`, `src/features/projects/view/components/graph-diagnostics.tsx` (edit)
- Do:
  1. Delete `BandShape`, `bandOf`, `bands` and `BAND_PADDING` (`src/lib/graph-layout.ts:30-41`, `:179-199`, `:212`). `layoutRequest` places each node of `model.rows` as one child of the root.
  2. `mission-graph.tsx` renders one list `Nodes` in row order (`:63-90`). Each node card shows its `work` as a badge.
  3. An `implement` node card ends with a `Tasks (<count>)` section. Each task is a row with its name, and the row opens the node sheet of its node. A card with no task shows no section.
  4. `graph-node.tsx` drops `ObjectiveProgress` (`:9`, `:16`, `:65`). `graph-diagnostics.tsx` drops the unplaced-node line (`:28`).
- Cite: `mission-service.impl.md:496`, `:632`.
- Verify: `pnpm exec vitest run src/lib/graph-layout.test.ts src/features/projects/view/components/mission-panel.test.tsx` with "an implement node card shows Tasks (3)" and "an examine node card shows no Tasks section".

### 07.5 Move the node sheet and its sections

- Files: `src/features/projects/view/components/node-sheet.tsx`, `node-structure.tsx`, `node-details-tab.tsx`, `node-link.tsx`, `attempt-records.tsx`, `mission-panel.tsx` and their tests (edit)
- Do:
  1. Delete each task branch and each `parent_id` read (`node-sheet.tsx:40`, `:82-84`; `node-details-tab.tsx:39`, `:71`, `:108`, `:147`, `:152`, `:175`, `:208`; `node-link.tsx:27`).
  2. `node-structure.tsx` (`:61-93`) shows `Depends on` and `Dependents`, and for an `implement` node `Tasks` from `node.tasks`. It shows no parent, no children and no progress.
  3. The details tab shows `Work` and `Requires`. An empty `requires` shows `None`.
  4. `attempt-records.tsx:226-229` reads `dependency_node_ids` under the label `Dependencies`.
  5. `mission-panel.tsx:107` reads "Import a plan to create its nodes."
- Cite: `mission-service.md:27-46`; `mission-service.impl.md:262`.
- Verify: `pnpm exec vitest run src/features/projects/view/components/node-sheet.test.tsx src/features/projects/view/components/node-controls.test.tsx src/features/projects/view/components/mission-panel.test.tsx`.

### 07.6 Move the proposal section and the approval

- Files: `src/features/projects/view/components/proposal-section.tsx`, `proposal-item.tsx`, `src/features/projects/view/use-node-proposals.ts`, `src/hooks/use-proposal-approve.tsx`, `src/features/overview/read-attention-detail.ts`, `src/features/overview/use-decision-acts.ts` and their tests (edit)
- Do:
  1. An `examine` node reads its proposals. `useNodeProposals(nodeId, examine)` and `read-attention-detail.ts:37` test `work === "examine"`.
  2. `proposal-item.tsx:40-55` labels `content.dependency_id` as `Dependency` and `created_node_id` as `Created node`.
  3. `proposal-section.tsx:52-54` reads: "A judgement of this examine node proposes a fix node for a defect in a completed dependency. Approve creates the fix node with its task, adds it as a dependency of this node and unblocks this node."
  4. `use-proposal-approve.tsx` names the parameter `proposer`. The texts of `:26-44` and `:107-143` name "the proposer" and "the fix node". `CONFLICT_MESSAGES` adds `mission.node.requires_unmatched` (task 07.9).
  5. The approval reads `created` and `proposer` of the answer (`mission-service.impl.md:307`).
- Cite: `mission-service.impl.md:261-312`.
- Verify: `pnpm exec vitest run src/hooks/use-proposal-approve.test.ts src/features/projects/view/components/proposal-section.test.tsx src/features/overview/use-decision-acts.test.ts`.

### 07.7 Move the controls and the readings of state

- Files: `src/hooks/use-node-unblock.tsx`, `src/hooks/use-node-resume.tsx`, `src/lib/resume-target.ts`, `src/lib/attention.ts`, `src/lib/fix-attention.ts`, `src/lib/state-tally.ts`, `src/lib/overview-summary.ts`, `src/features/scheduler/board/read-scheduler-board.ts`, `src/features/scheduler/board/use-scheduler-board.ts` and their tests (edit)
- Do:
  1. Delete each `kind === "task"` and `kind !== "task"` filter (`attention.ts:205`, `:305`; `fix-attention.ts:200`; `state-tally.ts:12`; `overview-summary.ts:26`; `read-scheduler-board.ts:34`; `use-scheduler-board.ts:82`; `claim-takers.ts:31`). A node list holds no task.
  2. `resume-target.ts`: delete the waiting need `objectives`, `objectivesTerminal` and the ancestor walk (`:19`, `:43-49`, `:71-86`). The dependency need reads the direct dependencies. `use-node-resume.tsx:66` loses its `objectives` line.
  3. `use-node-unblock.tsx:46` tests `work === "implement"`. `:82` and `:161` name the examine node and the fix node.
- Cite: `mission-service.md:48-69`, `:513-519`.
- Verify: `pnpm exec vitest run src/lib src/hooks src/features/scheduler src/features/overview`.

### 07.8 Add the work and trait match of the "no taker" view

- Files: `src/lib/claim-takers.ts`, `src/lib/claim-takers.test.ts`, `src/lib/fix-attention.ts`, `src/lib/fix-attention.test.ts` (edit)
- Do:
  1. `uncoveredJobsOf` (`src/lib/claim-takers.ts:23-39`) takes the worker bindings. A job is covered when one registered instance that does not drain belongs to a worker binding whose catalog item admits the node: the state of the node is in `declared_node_states`, `work` is in `declared_works`, and `requires` is a subset of `traits` of the binding.
  2. An instance names its binding through `resource_identity`. A binding with no catalog item admits nothing.
  3. `takerHintOf` (`:54-71`) takes the node facts and answers the first binding by name whose catalog item admits them, regardless of `instance_count`.
  4. The `no_taker` item of `fix-attention.ts:85-117` passes the node facts to `takerHintOf`.
- Cite: `scheduler-service.impl.md:153-171`; `scheduler-service.md:253-259`; `project-service.impl.md:332`.
- Verify: `pnpm exec vitest run src/lib/claim-takers.test.ts src/lib/fix-attention.test.ts` with "a node with requires [platform.macos] has no taker while every binding holds traits []" and "a binding with the trait platform.macos and no instance is the hint".

### 07.9 Map the new error codes

- Files: `src/hooks/use-proposal-approve.tsx`, `src/hooks/use-node-unblock.tsx`, `src/features/projects/view/use-binding-set.ts`, `src/features/credentials/credential-message.ts` and their tests (edit)
- Do:
  1. `mission.node.requires_unmatched`: "No worker binding of the project matches the requires list of this node. Add a worker binding whose traits hold each key, then try again." Add it to `use-proposal-approve.tsx:25-31` and `use-node-unblock.tsx:29-38`.
  2. `mission.node.work_locked`: "The node opened an attempt, so its work cannot change." Add it to `use-node-unblock.tsx`.
  3. `use-binding-set.ts:45-49` treats a 409 as a version conflict only when `failure.detail` is `project.binding_set.version_conflict` (engine `src/project/contract.ts:98`). Another 409 reaches `setError`.
  4. `credential-message.ts:33-44` adds `project.bindings.worker.node_unmatched`: "The change leaves a node with no matching worker binding. Keep a binding whose worker and traits match each listed node." It adds `project.bindings.worker.traits_invalid`: "A trait key is malformed or repeated. Use lower-case dotted keys, each at most 64 bytes, each once."
- Cite: `mission-service.impl.md:65-66`; `project-service.impl.md:133`, `:172`.
- Verify: `pnpm exec vitest run src/hooks/use-proposal-approve.test.ts src/hooks/use-node-unblock.test.ts src/features/projects/view` with "a node_unmatched refusal shows its message and keeps the draft".

### 07.10 Add the traits field of a worker binding

- Files: `src/lib/binding-draft.ts`, `src/lib/binding-draft.test.ts`, `src/features/projects/view/components/binding-sheet.tsx`, `src/features/projects/view/components/bindings-panel.tsx` and their tests (edit)
- Do:
  1. `WorkerDraft` (`src/lib/binding-draft.ts:47-55`) adds `traits: string`, one key per line. `emptyDraft` sets `""`. `draftOf` (`:205-217`) joins `config.traits ?? []`.
  2. `entryOfDraft` (`:373-389`) splits the lines, trims each, drops empty lines and writes `traits`. The draft carries the order unchanged.
  3. `missingForSave` (`:401-429`) names `Traits` when a line fails `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, holds more than 64 bytes or repeats.
  4. `binding-sheet.tsx` shows the field `Traits` in the worker section, with the hint "One key per line, for example platform.macos. A node runs only on a binding that holds every key of its requires list."
  5. The worker row of `bindings-panel.tsx` shows the traits as badges.
- Cite: `project-service.md:98-104`; `project-service.impl.md:172-173`, `:331-332`.
- Verify: `pnpm exec vitest run src/lib/binding-draft.test.ts src/features/projects/view/components/bindings-panel.test.tsx`.

### 07.11 Show the declared works on the workers screen

- Files: `src/features/workers/catalogue/workers-screen.tsx`, `src/features/workers/catalogue/workers-screen.test.tsx` (edit)
- Do: replace the row `Required node format` (`workers-screen.tsx:47`) with `<BadgeList label="Declared works" values={item.declared_works} />`.
- Cite: `worker-service.impl.md:95`.
- Verify: `pnpm exec vitest run src/features/workers`.

### 07.12 Move the mock daemon

- Files: `mock/daemon.mjs`, `mock/fixtures.mjs` (edit)
- Lane: main session (decision D20).
- Do:
  1. Each fixture node holds `work`, `requires` and `tasks`, and no `kind` and no `parent_id`. The fixture tasks move into the `tasks` of their former objective. Each fixture edge is `{ dependent_id, depends_on_id }`.
  2. Each former initiative becomes an `examine` node that depends on its former objectives and names their repository binding. Each node names its own bindings. One `implement` fixture node holds no task.
  3. The proposal approval of `mock/daemon.mjs:1172-1240` creates an `implement` node with one task, adds the dependency of the proposer on it, writes `created_node_id` and answers `{ created, proposer }`.
  4. The task reads of `:796` and `:1009-1032` read `node.tasks`.
  5. The worker catalog fixtures hold `declared_works: ["implement", "examine"]`. One worker binding fixture holds `traits: ["platform.macos"]`, and one fixture node holds `requires: ["platform.macos"]`.
- Cite: decisions D4, D6; `mission-service.impl.md:307`.
- Verify: `node mock/daemon.mjs` starts, and the browser check of task 07.E shows the graph.

### 07.E Run the gate

- Do:
  1. Run the gate row 07 of `00-index.md`.
  2. Start `pnpm dev:all`. With the `ego-browser` skill, open the project of the mock daemon at desktop width and at 390 by 844 (root `AGENTS.md:173-174`).
  3. Check the mission graph, an `implement` node card with its `Tasks (<count>)` section, the node sheet of a task row, the "no taker" item of the node with `requires: ["platform.macos"]`, the `Traits` field and the workers screen.
- Verify: every command of the row exits 0, the `rg` prints nothing, and each screen of step 3 renders with no horizontal page scroll.

## E2E

The apps repository holds no engine E2E. The browser check of task 07.E is the end-to-end proof against the mock daemon (`apps/AGENTS.md:123`).

## Blockers

None.

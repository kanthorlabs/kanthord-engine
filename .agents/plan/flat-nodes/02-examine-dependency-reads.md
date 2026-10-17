# Plan 02: Mission and Worker — the initiative reads its direct dependencies

## Scope

This plan delivers:

- The dependency closure of a node is its direct dependencies. No ancestor step, no wait edge, no child readiness rule, no initiative steps condition.
- The readiness condition holds when the closure holds.
- The dependency edit refusals of a dependent in `Waiting`, `Evaluating`, an `External.*` state, or a `Paused` dependent whose open attempt holds a request evidence.
- An initiative, the later `examine` node, reads its direct dependencies:
  - `dependency_outcome_ids` and the derived `dependency_node_ids` of an assessment;
  - the reads `mission.execution.dependency.list`, `.outcome.list` and `.evidence.list`;
  - its own zero or more read-only repository bindings in write order, checked out at the base-branch head under the layout rule for its steps method and its evaluation, with no derivation from its dependencies (R1, R3);
  - one project prompt part for each of those repository bindings, and the repository list of the work prompt;
  - the fix-node proposal with `dependency_id` and `created_node_id`;
  - the evidence delete scope of the direct `examine` dependents.
- The worker unit and the prompt templates read the dependency reads.

Out of scope:

- `kind`, `parent_id`, containment and `node move` (plan 03). The proposal approval still creates its objective under the proposer initiative in this plan.
- The method file names of the worker unit (plan 04).
- An objective, the later `implement` node, with more than one repository binding (plans 09a and 09b, decision D28).
- The storage binding list and the grant failover (plan 03).

## Model

Opus at medium effort. The currency, the proposal admission and the evidence scopes cross four files with one shared rule.

## Sources

- `docs/brainstorm/mission-service.md:48-69` — the dependency, the closure, the cycle check and the dependency edit rules.
- `docs/brainstorm/mission-service.md:165-171` — the forced retirement and its `mission.node.state_conflict` refusal.
- `docs/brainstorm/mission-service.md:221-225` — only an `examine` execution reads a direct dependency.
- `docs/brainstorm/mission-service.md:316-319`, `:351` — the evidence of an `examine` node and the delete scope.
- `docs/brainstorm/mission-service.md:386-388`, `:402`, `:408`, `:414-419` — the evaluation scope and the context check of the dependency outcomes.
- `docs/brainstorm/mission-service.md:514-520` — the readiness condition.
- `docs/brainstorm/mission-service.md:601-607` — the resume target reads the closure.
- `docs/brainstorm/mission-service.impl.md:199-203`, `:565` — the dependency edit codes and the forced retirement.
- `docs/brainstorm/mission-service.impl.md:236`, `:241`, `:261-273` — `dependency_outcome_ids`, `dependency_node_ids`, the proposal content and `context_matches`.
- `docs/brainstorm/mission-service.impl.md:302-312` — the fix-node proposal.
- `docs/brainstorm/mission-service.impl.md:354-358` — the tested input of an `examine` node.
- `docs/brainstorm/mission-service.impl.md:421-422` — the delete scope.
- `docs/brainstorm/mission-service.impl.md:450`, `:485-486` — the dependency read resolves to the revision of the current outcome; the outcome context.
- `docs/brainstorm/mission-service.impl.md:505-509`, `:527-530` — `node ready`, `node resume` and `unsatisfied_ids`.
- `docs/brainstorm/mission-service.impl.md:670`, `:692`, `:737`, `:752`, `:757-759` — the tests of the dependency set, of the attempt-0 outcome, of the delete scope, of the cycle and of the dependency edit refusals.
- `docs/brainstorm/mission-service.impl.md:880-882` — the CLI codes of the dependency reads.
- `docs/brainstorm/mission-service.vocabulary.md:279`, `:467` — the readiness condition and the dependency closure.
- `docs/brainstorm/mission-service.md:31`, `:79`, `:87` — an `examine` node reads zero or more repositories, changes none and requires no external action.
- `docs/brainstorm/mission-service.impl.md:57-61`, `:108`, `:356` — the rule table, the empty action set of an `examine` node and the tested input list.
- `docs/brainstorm/worker-service.md:86`, `:96-102` — the repository list of the work prompt and one project prompt part for each repository binding.
- `docs/brainstorm/worker-service.md:289-292`, `:301` — the layout rule and the workspace of an `examine` node.
- `docs/brainstorm/worker-service.md:422-431`, `:541-551`, `:560` — the steps method of an `examine` node, the reviewer reads and the proposals.
- `docs/brainstorm/worker-service.impl.md:390`, `:548-552`, `:566`, `:582` — the repositories of an `examine` node, its tests and its workspace.
- `docs/brainstorm/agent.impl.md:268-284` — the template values of `work`, `evaluation` and `examine`.
- `docs/brainstorm/scheduler-service.impl.md:80-93` — the eligibility conditions.

## Depends on

- Plan 01 merged.

## Provides

| Seam or shape                                | Signature                                                                                            | Owner file                | Consumer plans |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| `directDependenciesOf`                       | `(nodeId: string, deps: readonly DepEdge[]): string[]`                                               | `src/mission/graph.ts`    | 03, 05         |
| `mission.execution.dependency.list`          | `GET /api/mission/execution/:execution_id/dependency`, `client`, answers `Page<ExecutionDependency>` | `src/mission/contract.ts` | 04             |
| `mission.execution.dependency.outcome.list`  | `GET /api/mission/execution/:execution_id/dependency/outcome`                                        | `src/mission/contract.ts` | 04             |
| `mission.execution.dependency.evidence.list` | `GET /api/mission/execution/:execution_id/dependency/evidence`                                       | `src/mission/contract.ts` | 04             |
| `ProposalApproveResult`                      | `{ created: NodeChange; proposer: ControlResult }`                                                   | `src/mission/contract.ts` | 07             |

## Tasks

### 02.1 Compute the closure from the direct dependencies

- Files: `src/mission/graph.ts`, `src/mission/routing.ts`, `src/mission/conditions.ts`, `src/mission/control-hold.ts`, `src/mission/admission.ts`, `src/mission/store.ts` (edit)
- Do:
  1. Replace `buildDependencyClosureOf` (`src/mission/graph.ts:40-59`) by `directDependenciesOf(nodeId, deps)`. Delete `waitEdges` (`:61-72`) and `closureEdges` (`:85-101`). `hasDependencyCycle` (`:74-83`) runs `detectCycle` over the dependency edges alone. A self edge is a cycle.
  2. In `claimableMap` (`src/mission/routing.ts:14-46`) delete `nonterminalParents` (`:20-29`) and the initiative child rule (`:34-38`). `Available` admits a steps claim for every node.
  3. `routeMission` (`:48-74`) reads `directDependenciesOf`; delete the parent map (`:53-56`).
  4. `closureUnsatisfied` (`src/mission/conditions.ts:13-29`) reads the direct dependencies. `readinessOf` (`:31-57`) answers `holds` exactly when the closure holds; delete `objectives_not_terminal`.
  5. `requireReady` (`src/mission/control-hold.ts:30-47`) answers `details: { unsatisfied_ids }` alone (`mission-service.impl.md:507-508`).
  6. Delete `computeInitiativeClaimable` (`src/mission/admission.ts:50-56`) and `readCurrentChildStates` (`src/mission/store.ts:485-495`).
- Cite: `mission-service.md:53-56`, `:514-520`, `:601-607`; `mission-service.impl.md:505-509`, `:527-530`; `mission-service.vocabulary.md:467`.
- Verify: `node --test --test-timeout=30000 src/mission/graph.test.ts src/mission/conditions.test.ts src/mission/control-hold.test.ts` with the cases "an initiative with no dependency is Available", "the closure of A holds B alone when A depends on B and B depends on C", "a self dependency is a cycle".

### 02.2 Refuse a dependency edit on a dependent in a guarded state

- Files: `src/mission/dependency.ts`, `src/mission/import.ts`, `src/mission/node-retire.ts` (edit)
- Do:
  1. `dependency add` and `dependency remove` (`src/mission/dependency.ts:97-130`) answer 409 `mission.node.state_conflict` with `details: { state, attempt }` for a dependent in `Waiting`, `Evaluating`, `External.Requested`, `External.Success` or `External.Failed`.
  2. `dependency add` answers the same code for a `Paused` dependent whose open attempt holds a request evidence. The import applies both rules to each dependency edit (`mission-service.impl.md:202`).
  3. Replace `requireNoLiveSubtree` (`src/mission/dependency.ts:170-198`) by `requireNoLiveClaim(tx, dependencies, nodeId, now)` on the dependent alone. `src/mission/import-apply.ts:302` calls it the same way.
  4. A forced retirement that removes a dependency of a dependent in the guarded states answers 409 `mission.node.state_conflict` with `details: { node_id, state, attempt }` (`mission-service.impl.md:565`).
- Cite: `mission-service.md:62-65`, `:167-168`; `mission-service.impl.md:85`, `:201-202`, `:565`, `:757-759`.
- Verify: tests in `src/mission/service.test.ts` "dependency add and remove refuse a Waiting, Evaluating and External dependent", "dependency add refuses a Paused dependent with a request evidence", "forced retirement refuses a guarded dependent and writes nothing".

### 02.3 Rename the assessment and proposal columns

- Files: `src/mission/migrations.ts`, `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. In `createExecutionRecordTables` rename `mission_assessment.child_outcome_ids` to `dependency_outcome_ids` (`src/mission/migrations.ts:89`).
  2. In `createProposalTable` rename `mission_proposal.objective_node_id` to `created_node_id` (`:118`).
  3. Change the foreign key name `mission_proposal.objective_node_id->mission_node.id` of `src/apps/server/migrations.test.ts:452`.
- Cite: decision D2; `mission-service.impl.md:236`, `:309`.
- Verify: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts`.

### 02.4 Rename the assessment and proposal fields of the contract

- Files: `src/mission/contract.ts`, `src/mission/contract.test.ts` (edit)
- Do:
  1. `assessmentSchema` (`src/mission/contract.ts:926-942`): `child_outcome_ids` becomes `dependency_outcome_ids`, `child_node_ids` becomes `dependency_node_ids`.
  2. `assessmentSubmitSchema` (`:1127-1130`): `dependency_outcome_ids`.
  3. `proposalContentSchema` (`:1095-1100`): `objective_id` becomes `dependency_id`.
  4. `proposalSchema` (`:1102-1111`): `objective_node_id` becomes `created_node_id`.
  5. `proposalApproveResultSchema` (`:1118-1121`) becomes `{ created: nodeChangeSchema, proposer: controlResultSchema }` (`mission-service.impl.md:307`).
  6. Replace the three `execution.objective.*` operations (`:1340-1381`) by `execution.dependency.list`, `execution.dependency.outcome.list` and `execution.dependency.evidence.list` with the paths of the Provides table. Rename `executionObjectiveSchema` (`:1264-1268`) to `executionDependencySchema`, built on the runnable node schema.
  7. Rewrite the descriptions of `proposal.list` and `proposal.approve` (`:1793`, `:1809`) to name the fix-node proposal and the proposer.
- Cite: `mission-service.impl.md:236`, `:261-263`, `:302-309`, `:880-882`.
- Verify: `node --test --test-timeout=30000 src/mission/contract.test.ts`.

### 02.5 Admit the dependency outcomes and the proposals of an assessment

- Files: `src/mission/assessment-admit.ts`, `src/mission/assessment-submit.ts`, `src/mission/record-store.ts`, `src/mission/record-read.ts`, `src/mission/control.ts`, `src/mission/proposal-store.ts`, `src/mission/proposal-read.ts` (edit)
- Do:
  1. Replace `requireChildren` (`src/mission/assessment-admit.ts:37-64`) by `requireDependencyOutcomes`: for an initiative, `dependency_outcome_ids` names the current outcome of each direct dependency and no other outcome; for an objective it is empty. Another set answers HTTP 400 with an issue list.
  2. `requireProposals` (`:66-106`): each `dependency_id` names a current direct dependency of the proposer that is an objective. Proposals on another node or with another result answer HTTP 400 at `proposals`.
  3. Write and read `dependency_outcome_ids` in `insertAssessment` (`src/mission/record-store.ts:351-383`), `writeHumanRecords` (`src/mission/control.ts:159`) and `submitAssessment` (`src/mission/assessment-submit.ts:85`, `:138`).
  4. `assessmentRecord` (`src/mission/record-read.ts:237-260`) derives `dependency_node_ids`.
  5. `ProposalRow.created_node_id` and `markProposalApproved(tx, id, createdNodeId, at)` (`src/mission/proposal-store.ts:12-80`).
- Cite: `mission-service.md:402`, `:408`; `mission-service.impl.md:241`, `:261-264`.
- Verify: `node --test --test-timeout=30000 src/mission/assessment-admit.test.ts src/mission/assessment-submit.test.ts src/mission/record-read.test.ts src/mission/proposal.test.ts`.

### 02.6 Check the dependency outcomes in the currency

- Files: `src/mission/currency.ts` (edit)
- Do: replace `childrenMatch` (`src/mission/currency.ts:22-47`) by `dependenciesMatch`. For an initiative, the nodes of `dependency_outcome_ids` equal the direct dependencies of the node, and each named outcome is the current outcome of its node. For an objective the check passes.
- Cite: `mission-service.md:415`; `mission-service.impl.md:270-271`.
- Verify: `node --test --test-timeout=30000 src/mission/currency.test.ts` with the cases "a removed dependency makes an assessment not current" and "a new dependency outcome makes an assessment not current".

### 02.7 Serve the dependency reads of an execution

- Files: `src/mission/execution-read.ts`, `src/mission/evidence-content-read.ts`, `src/mission/service.ts` (edit)
- Do:
  1. Replace `currentObjectivesOf` (`src/mission/execution-read.ts:48-60`) by `currentDependenciesOf(tx, nodeId)`: each direct dependency that is not retired, with its current outcome, resolved to the `node_revision` of that outcome or to the revision current at the human act for an attempt-0 outcome (`mission-service.impl.md:450`).
  2. `executionDependencies`, `executionDependencyOutcomes` and `executionDependencyEvidence` replace the three objective reads (`:84-169`). The reads answer an empty page for an objective claim (`mission-service.md:221`).
  3. A direct dependency that is an initiative answers its outcome and its produced evidence, and no repository (`mission-service.md:223`). No read follows the dependencies of a dependency.
  4. `executionContentBound` (`src/mission/evidence-content-read.ts:41-78`) admits the evidence that the current outcome of a direct dependency names.
  5. Register the three handlers in `declare(registry)` (`src/mission/service.ts:191-220`).
- Cite: `mission-service.md:221-225`; `mission-service.impl.md:450`, `:692`.
- Verify: `node --test --test-timeout=30000 src/mission/execution-read.test.ts src/mission/evidence-content-read.test.ts`.

### 02.8 Let an initiative name its own repository bindings and scope the delete

- Files: `src/mission/content.ts`, `src/mission/evidence-content.ts`, `src/mission/frozen-action.ts`, `src/mission/evidence-delete.ts` and their tests (edit)
- Do:
  1. `bindingRules` (`src/mission/content.ts:36-55`): an initiative takes zero or more repository bindings, with no upper bound. An objective keeps exactly one (decision D28).
  2. `repositoryBindingIdsOf` (`src/mission/evidence-content.ts:122-157`) of an initiative answers the repository bindings of its own pinned revision, in write order. Delete the walk over the objectives.
  3. `requireRepositoryAddress` and `requireTestedInput` (`:93-120`, `:159-202`) check the tested input of an initiative against that list: one address for one binding, else one address for each binding in binding order (`mission-service.impl.md:356`).
  4. The required external actions of an initiative stay empty, whatever repository binding it names (`mission-service.impl.md:108`).
  5. `admitDelete` (`src/mission/evidence-delete.ts:44-74`) requires a terminal state on the node of the evidence and on each direct dependent that is an initiative. It reads no ancestor.
- Cite: `mission-service.md:31`, `:79`, `:87`, `:351`; `mission-service.impl.md:57-61`, `:108`, `:356`, `:421-422`, `:737`.
- Verify: `node --test --test-timeout=30000 src/mission/content.test.ts src/mission/evidence-content.test.ts src/mission/frozen-action.test.ts src/mission/evidence-delete.test.ts` with "an initiative accepts zero, one and two repository bindings", "the tested input of an initiative with two repository bindings is a list in binding order" and "an initiative with a repository binding requires no external action".

### 02.9 Approve a fix-node proposal through a dependency

- Files: `src/mission/proposal-approve.ts` (edit)
- Do:
  1. `approveProposal` (`src/mission/proposal-approve.ts:50-149`) reads `content.dependency_id` (`:82`). It creates the objective with the one task of the proposal under the proposer and copies `bindings` from the node of `dependency_id`.
  2. In the same transaction it adds the dependency of the proposer on the new node, unblocks the proposer into a new attempt with `start_point: node_branch`, and sets `created_node_id` and `approved_at`.
  3. The answer is `{ created, proposer }`.
- Cite: `mission-service.impl.md:302-312`.
- Verify: `node --test --test-timeout=30000 src/mission/proposal.test.ts` with the case "approval adds a dependency of the proposer on the created node and routes the proposer to Pending".

### 02.10 Update the colocated Mission tests

- Files: `src/mission/*.test.ts`, `src/mission/test-support.ts` (edit)
- Do: replace each child fixture of an initiative by a dependency of the initiative on its objectives. Rename every `child_outcome_ids`, `child_node_ids`, `objective_id` and `objective_node_id`. Delete the tests of `objectives_not_terminal`, of the wait edges and of the ancestor closure.
- Cite: decision D19.
- Verify: `node --test --test-timeout=30000 'src/mission/*.test.ts'`.

### 02.11 Read the dependencies in the worker unit

- Files: `src/worker/unit/method-clients.ts`, `src/worker/unit/node-reads.ts`, `src/worker/unit/steps-initiative.ts`, `src/worker/unit/report-facts.ts`, `src/worker/unit/judgement.ts`, `src/worker/unit/evaluation.ts`, `src/worker/unit/evaluation-input.ts` and their tests (edit)
- Do:
  1. `method-clients.ts:14-16` names the three `execution.dependency.*` operations.
  2. `readObjectives` (`src/worker/unit/node-reads.ts:77-99`) becomes `readDependencies`, and `ExecutionObjective` becomes `ExecutionDependency`. Delete `allTerminal` (`:198-204`).
  3. `runStepsInitiative` (`src/worker/unit/steps-initiative.ts:22-109`) reads `readDependencies` and drops the `allTerminal` gate (`:42-43`, `:81`), because readiness already requires every direct dependency to be `Completed` (`worker-service.md:423`). `REPORT_SUBJECT` becomes "Report on current dependency outcomes".
  4. `report-facts.ts:10-71` labels each row as a dependency, with the header `| Dependency | Node | …`.
  5. `judgement.ts`: `proposalSchema` (`:33-44`) names `dependency_id`; `evaluationInstruction` (`:235-257`) passes `examine` and `dependencies`; `reportInstruction` (`:259-272`) passes `dependencies`.
  6. `evaluation.ts:75-212` writes `dependency_outcome_ids` from the dependency outcomes and keeps proposals for an initiative alone.
- Cite: `worker-service.md:422-431`, `:541-543`, `:560`; decision D16.
- Verify: `node --test --test-timeout=30000 'src/worker/unit/*.test.ts'`.

### 02.12 Check out the repositories of an initiative under the layout rule

- Files: `src/worker/unit/workspace.ts`, `src/worker/unit/evaluation-input.ts`, `src/worker/unit/steps-initiative.ts`, `src/worker/unit/native-agent.ts`, `src/agent/prompt-layers.ts`, `src/agent/prompt-composer.ts`, `static/prompt/template/work.md` and their tests (edit)
- Lane: main session for `static/prompt/template/work.md` (decision D20).
- Do:
  1. `prepareInitiative` (`src/worker/unit/workspace.ts:149-200`) clones the base-branch head of each repository binding into `checkouts/<binding name>/` of the execution workspace. The agent root is the one checkout for one binding, `checkouts/` for two or more, and the workspace root for none.
  2. The evaluation of an initiative (`src/worker/unit/evaluation-input.ts:142-152`) uses the same preparation. The tested input holds one commit for each binding, in binding order. An initiative with no binding keeps the evidence-placement rule.
  3. The verifications of the steps method and of the evaluation run from the agent root.
  4. The project prompt of an initiative holds one part for each repository binding in binding order. Each part joins the agent files of that checkout and the `project_prompt` of that binding (`src/worker/unit/native-agent.ts:171-187`, `src/agent/prompt-layers.ts:300-325`). The evaluation takes the `project_prompt` of each binding only.
  5. With two or more bindings, the work prompt lists each repository binding with its directory and its base branch. The work prompt render (`src/agent/prompt-composer.ts:84-93`) passes `repositories: { name; directory; base_branch }[]`, and `work.md` renders the list only when it holds two or more entries.
  6. The steps method of an initiative creates no node branch, makes no commit and pushes nothing.
- Cite: `worker-service.md:86`, `:96-102`, `:289-292`, `:301`, `:422-431`, `:548-551`; `worker-service.impl.md:390`, `:548-552`, `:566`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/workspace.test.ts src/worker/unit/evaluation-input.test.ts src/worker/unit/steps-initiative.test.ts src/agent/prompt-layers.test.ts` with "an initiative with two bindings checks out each base-branch head under checkouts/ and records one tested commit for each", "an initiative with one binding uses the checkout as the agent root" and "an initiative with no binding places the produced evidence".

### 02.13 Rename the report template to `examine` and rewrite the evaluation template

- Files: `static/prompt/template/report.md` → `static/prompt/template/examine.md`; `static/prompt/template/evaluation.md`, `src/agent/contract.ts`, `src/worker/unit/judgement.ts`, `src/worker/unit/steps-initiative.ts`, `src/agent/prompt-templates.test.ts`, `src/worker/unit/judgement.test.ts` (edit)
- Lane: main session for `static/` (decision D20).
- Do:
  1. `git mv static/prompt/template/report.md static/prompt/template/examine.md`. `PromptTemplate.Report: "report"` (`src/agent/contract.ts:114`) becomes `PromptTemplate.Examine: "examine"`. The loader list `TEMPLATE_NAMES` (`src/agent/prompt-templates.ts:22`) and the shipped asset path (`src/agent/prompt-assets.ts:9`) follow the enum, and the operator override file becomes `<agent directory>/prompts/examine.md` (`src/agent/prompt-templates.ts:15`, `:72`). No override reads `report.md` (decision D2).
  2. `reportInstruction` (`src/worker/unit/judgement.ts:259-272`) becomes `examineInstruction(templates, { repositories, verification, dependencies, outcomes, evidence })`. `steps-initiative.ts:69` calls it.
  3. Rewrite `examine.md` for an `examine` node. The agent examines the checkouts of `repositories` with its tools. The execution code runs the node verifications and gives `verification` to the agent. The agent judges the findings against the node criterion and writes them in the full finding format. A section of `dependencies`, `outcomes` and `evidence` renders only when the node has a direct dependency. A list of `repositories` with their directories and base branches renders only when the node names a repository binding.
  4. `evaluation.md`: `{{#if initiative}}` becomes `{{#if examine}}`; "objective context" becomes "dependency context" with `{{json dependencies}}`; the proposal sentence and the proposal JSON name `dependency_id` and "Fix node name".
  5. `src/agent/prompt-templates.test.ts:105-115` renders `examine.md` with and without dependencies, and with zero and two repositories.
- Cite: `agent.impl.md#prompt-templates`; `worker-service.md#executions`; `mission-service.impl.md:263`; decision D16.
- Verify: `node --test --test-timeout=30000 src/agent/prompt-templates.test.ts src/worker/unit/judgement.test.ts src/worker/unit/steps-initiative.test.ts`; `rg -n 'PromptTemplate.Report|reportInstruction|template/report' src static` prints nothing.

### 02.14 Change the CLI leaves of the reads and the proposals

- Files: `src/apps/cli/mission-execution.ts`, `src/apps/cli/mission-proposal.ts` (edit)
- Do:
  1. `addObjectiveReads` (`src/apps/cli/mission-execution.ts:160-205`) becomes `addDependencyReads` with the commands `execution dependency list`, `execution dependency outcome list` and `execution dependency evidence list`. The local codes follow `cli.mission.execution.dependency.*.invalid_execution_id`.
  2. The descriptions of `src/apps/cli/mission-proposal.ts:40`, `:45`, `:68` name the fix-node proposal and the `examine` node.
- Cite: `mission-service.impl.md:880-882`.
- Verify: `node --test --test-timeout=30000 src/apps/cli/completeness.test.ts`.

### 02.15 Move the server fixtures to dependencies

- Files: `src/apps/server/cli-support.ts`, `src/apps/server/journey-support.ts`, `src/apps/server/delivery-support.ts`, `src/apps/server/test-support.ts`, `src/apps/server/e2e-*.test.ts`, `src/apps/server/*-integration.test.ts` (edit)
- Do:
  1. `passingEvaluation` (`src/apps/server/cli-support.ts:373-409`) sends `dependency_outcome_ids`.
  2. Each journey whose initiative reports on its objectives adds a dependency of the initiative on each objective, so the initiative stays `Pending` until each objective is `Completed`.
  3. `e2e-mission-proposals.test.ts` asserts `dependency_id`, `created_node_id`, `{ created, proposer }` and the new dependency edge.
  4. Rename the assertions of the dependency reads.
- Cite: decision D19.
- Verify: `node --test --test-timeout=60000 'src/apps/server/e2e-*.test.ts' 'src/apps/server/*-integration.test.ts'`.

### 02.16 Regenerate OpenAPI

- Files: `static/openapi.yaml`, `static/openapi/mission/*.yaml` (generated), `src/apps/server/openapi-integration.test.ts` (edit)
- Lane: main session (decision D20).
- Do:
  1. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. The writer prunes the three `execution.objective.*.yaml` files (`src/gateway/openapi.ts:318-334`).
  2. Rename the exceptions and the operation rows of `src/apps/server/openapi-integration.test.ts:126-141`, `:353`, `:380-386`, `:404`, `:735-737`, `:1032`, `:1040-1077`.
- Cite: `engine/AGENTS.md:454-463`.
- Verify: `node --test --test-timeout=60000 src/apps/server/openapi-integration.test.ts`.

### 02.17 Update the CLI pages

- Files: `docs/cli/mission.md`, `docs/cli/scheduler.md`, `docs/cli/worker.md` (edit)
- Lane: main session (decision D20).
- Do:
  1. `docs/cli/mission.md`: the readiness and the attempt rules (`:401`, `:405-412`), the fix-node proposal section (`:434-460`), the record rules (`:534-535`), the execution reads (`:608-610`, `:630-632`), the rows `AssessmentBody` (`:826`), `ProposalContent` (`:827`), `Assessment` (`:919`), `Proposal` (`:921`), `ProposalApproveResult` (`:922`), the local codes (`:1011-1013`) and the `mission.node.state_conflict` row for a dependency edit.
  2. `docs/cli/scheduler.md`: delete the conditions `initiative-steps` and `readiness` (`:263-264`); `mission-condition` holds `continuation` or `null` (`:265-270`).
  3. `docs/cli/worker.md:290-303`: the proposal fields `dependency_id` and the fix-node proposal.
- Cite: decisions D22, D23.
- Verify: `pnpm exec prettier --check docs/cli/mission.md docs/cli/scheduler.md docs/cli/worker.md`.

### 02.E Run the gate

- Do: run the gate row 02 of `00-index.md`.
- Verify: every command of the row exits 0, and the `rg` prints nothing.

## E2E

`e2e-mission-service.test.ts` and `e2e-mission-proposals.test.ts` add these rows:

| Id     | Commands                                                                                                                            | Exit    | Expect                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EF02.1 | Create an initiative with no dependency; `kanthord scheduler queue list <projectId>`                                                | 0       | the queue holds a job of the initiative                                                                                                                            |
| EF02.2 | `kanthord mission dependency add` of the initiative on an objective; `kanthord mission graph get <missionId>`                       | 0, 0    | `dependency_closures` of the initiative: `depends_on_ids` = `[<objectiveId>]`, the initiative `Pending`                                                            |
| EF02.3 | `node ready` of the objective; then `dependency add` of the objective on another node                                               | 0, 1    | stderr starts with `mission.node.state_conflict:`                                                                                                                  |
| EF02.4 | The proposal journey with `kanthord mission proposal approve <proposalId>`                                                          | 0       | `created.revisions[0].node_id` = `proposal.created_node_id`; `proposer.node.state` `Pending`; `created.added_edges` holds the edge of the proposer on the new node |
| EF02.5 | `kanthord mission node create` of an initiative with two repository bindings; `node get`; `mission attempt list` after `node ready` | 0, 0, 0 | the revision pins both bindings in write order; `required_external_actions` is `[]`                                                                                |

## Blockers

None.

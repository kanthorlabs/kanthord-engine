# Plan 09: Mission, Worker and Intake — an `implement` node with two or more repository bindings

## Scope

This plan delivers:

- The repository range of `implement` becomes one or more (R3, R13). The limit of decision D28 goes away.
- One evidence snapshot with exactly one `repository` asset for each repository binding of the pinned revision, checked at the submit and at the release. Another set answers `mission.evidence.binding_mismatch`.
- The tested input list for two or more bindings, in binding order, and the action operands of each binding from that list.
- The contained snapshot of a `pull_request` action (R12): the Intake Service opens no pull request when the base branch already contains the snapshot commit, and the Mission Service admits the `branch_push` address of that landing.
- The workspace layout by count for an `implement` node: `workspaces/<node identity>/checkouts/<binding name>/`, one node hold, and one checkout for each binding.
- The steps method with a loop over the bindings in place of each `repositories[0]` read: the same node-branch name in each repository, the head set as the task commit, the canonical head set as the judged value, the all-or-none merge before a release and the push of every node branch before the evidence.
- One prompt part for each binding and the repository list of the work prompt on an `implement` node.
- The reviewer checkout of each repository snapshot, and the stop with `operation_failed` on a snapshot that misses a binding.
- The requested-changes text that names the binding of each change request.

Out of scope:

- An atomic landing across repositories. Each required action resolves on its own (`mission-service.md:568-570`).
- An action order across bindings. `follows` across bindings stays refused (`worker-service.md:570`).
- The `kanthord.commit` telemetry attribute for two or more bindings. `testedCommitOf` already answers `null` for a list (`src/worker/unit/method-telemetry.ts:167-173`).
- The root reference pages and the root `engine` pointer. A root follow-up pull request deletes the limit sentence of plan 08 and moves the pointer after this plan merges.

## Model

Opus at medium effort. The plan changes one invariant across the Mission Service, the Intake Service and the worker unit, and each loop keeps the one-binding path byte-equal.

## Sources

- `docs/brainstorm/mission-service.md:73-87` — an `implement` node names one or more repository bindings; a task acts on every repository of its node.
- `docs/brainstorm/mission-service.md:309-313` — one repository asset for each binding, `mission.evidence.binding_mismatch` and the tested input list.
- `docs/brainstorm/mission-service.md:568-570` — no atomic landing; each action resolves on its own.
- `docs/brainstorm/mission-service.impl.md:57-61` — the rule table.
- `docs/brainstorm/mission-service.impl.md:114` — the `branch_push` address of a `pull_request` request.
- `docs/brainstorm/mission-service.impl.md:317`, `:354-358` — the release obligation and the binding asset rules.
- `docs/brainstorm/mission-service.impl.md:788-792` — the binding, evidence, tested input and contained-snapshot tests.
- `docs/brainstorm/intake-service.impl.md:230-231`, `:311` — the contained snapshot and its test.
- `docs/brainstorm/worker-service.md:86`, `:96-102` — the work prompt list and the prompt parts.
- `docs/brainstorm/worker-service.md:289-300` — the workspace layout rule.
- `docs/brainstorm/worker-service.md:309-357` — the steps method on an `implement` node.
- `docs/brainstorm/worker-service.md:538-552` — the reviewer checkout of each snapshot.
- `docs/brainstorm/worker-service.md:565-575`, `:593-594` — the actions by binding, the contained snapshot and the change-request labels.
- `docs/brainstorm/worker-service.impl.md:390` — one `repositories` row for each binding.
- `docs/brainstorm/worker-service.impl.md:512`, `:521-522` — the judged value and the requested-changes text.
- `docs/brainstorm/worker-service.impl.md:548`, `:552`, `:557`, `:563` — the verification root, the reviewer test, `added_files` and the steps tests.
- `docs/brainstorm/worker-service.impl.md:578-585` — the workspace, the agent root, the scratch directory and the one node hold.

An engine citation of this plan names the file name after plan 04 and the line at `54380cd9`. Before each task, find the cited symbol by name in the merged code of plan 08 and re-anchor its lines (`engine/AGENTS.md:477-479`).

## Depends on

- Plan 08 merged to `main` of the root repository.

## Provides

| Seam or shape       | Signature                                                                                                     | Owner file                        | Consumer plans |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| `WorkspaceCheckout` | `{ binding_id: string; name: string; directory: string; head: string }`                                       | `src/worker/unit/workspace.ts`    | none           |
| `headSetOf`         | `(checkouts: readonly WorkspaceCheckout[]): string` — the commit for one checkout, else `<name>=<commit>,...` | `src/worker/unit/judged-tasks.ts` | none           |
| `testedInputOf`     | `(checkouts: readonly WorkspaceCheckout[]): TestedInput` — one address for one checkout, else the list        | `src/worker/unit/verification.ts` | none           |

## Tasks

### 09.1 Require one repository asset for each repository binding

- Files: `src/mission/evidence-content.ts`, `src/mission/evidence-submit.ts`, `src/mission/transitions.ts` and their tests (edit)
- Do:
  1. `repositoryBindingIdsOf` (`src/mission/evidence-content.ts:122-157`) answers every repository binding of the pinned `implement` revision in binding order.
  2. `prepareEvidence` (`src/mission/evidence-submit.ts:41-151`): an execution evidence of an `implement` node that holds a `repository` asset holds exactly one for each binding of that list, and no other. A missing binding, a repeated binding or a foreign binding answers 400 `mission.evidence.binding_mismatch` with `details: { binding_id }`.
  3. `hasEvidence` (`src/mission/transitions.ts:104-140`) requires, for an `implement` node, one published evidence of the releasing execution with one `repository` asset for every binding of the list. `.some` over the assets becomes a check of every binding.
- Cite: `mission-service.md:309-311`; `mission-service.impl.md:317`, `:354`, `:358`, `:789`.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-submit.test.ts src/mission/transitions.test.ts src/mission/evidence-content.test.ts` with "an implement evidence that misses a binding answers mission.evidence.binding_mismatch", "an implement evidence with a foreign binding answers mission.evidence.binding_mismatch", "a release with one asset for one of two bindings is refused" and "one asset for each of two bindings releases".

### 09.2 Accept the tested input list in binding order

- Files: `src/mission/evidence-content.ts`, `src/mission/control-close.ts`, `src/worker/action-operands.ts` and their tests (edit)
- Do:
  1. `requireTestedInput` (`src/mission/evidence-content.ts:159-203`) accepts one address for a node with one repository binding, and a list with one address for each binding in binding order for two or more. Another form answers `mission.evidence.binding_mismatch` with `details: { binding_id }`.
  2. `landedEvidence` (`src/mission/control-close.ts:50-107`) applies the same form and binding rule to the landed commit of a success override.
  3. `operandsOf` (`src/worker/action-operands.ts:11-40`) takes the address of the action binding from a list. A list without that binding keeps the refusal `WorkerErrorCode.SnapshotAbsent`. `assessedCommitOf` (`src/mission/authorization.ts:220-238`) already reads a list.
- Cite: `mission-service.md:312-313`; `mission-service.impl.md:356-357`, `:790`; `worker-service.md:571`.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-content.test.ts src/mission/control-close.test.ts src/worker/action-operands.test.ts` with "a node with two bindings writes a tested input list in binding order", "a list out of binding order answers mission.evidence.binding_mismatch" and "each action takes the commit of its own binding from the list".

### 09.3 Answer a contained snapshot of a pull request

- Files: `src/intake/action-perform.ts`, `src/intake/action-check.ts`, `src/repository/connector.ts`, `src/mission/evidence-request.ts` and their tests (edit)
- Do:
  1. `createPullRequest` (`src/intake/action-perform.ts:242-266`) first calls `gitWriter.landedOn` with the base branch and the snapshot commit, as `landedMerge` does (`:393-415`). A landing opens no pull request and answers `branchPushAddress(facts, landing.first_parent)`. The read-back of a repeat (`:335-350`) applies the same rule.
  2. `foldBranchPush` (`src/repository/connector.ts:593-602`) accepts the expected end state `pull_request_merged` next to `base_branch_pushed`. A landing folds to the expected end state with the landed commit.
  3. `inspect` (`src/intake/action-check.ts:103-131`) folds a `branch_push` address of a `pull_request` action through `landedOn` and that fold.
  4. The address check of a request (`src/mission/evidence-request.ts:52-70`) admits a `branch_push` address for a `pull_request` action when its `resource_identity` is that of the action binding. Every other kind mismatch keeps `mission.request.address_mismatch`.
- Cite: `intake-service.impl.md:230-231`, `:311`; `mission-service.impl.md:114`, `:792`; `worker-service.md:572`.
- Verify: `node --test --test-timeout=30000 src/intake/action-perform.test.ts src/intake/action-check.test.ts src/repository/connector.test.ts src/mission/evidence-request.test.ts` with "a pull request whose base branch contains the snapshot opens no pull request and answers the branch push address of the oldest first-parent commit", "the check folds that address to pull_request_merged with the landed commit" and "a pull request request admits a branch push address of its binding".

### 09.4 Prepare one checkout for each binding under one node hold

- Files: `src/worker/unit/workspace.ts`, `src/worker/unit/steps-implement.ts`, `src/worker/unit/workspace.test.ts` (edit)
- Do:
  1. `nodeDirectory(nodeId, bindingName)` (`src/worker/unit/workspace.ts:58-63`) answers `workspaces/<node identity>/checkouts/<binding name>/`. The path `workspaces/<node identity>/<repository binding identity>/` goes away (decisions D2, D28).
  2. `prepareImplement` (`:66-147`) takes `repositories: WorkspaceRepository[]`. It holds the node key once (`:213-217`), then proves the identity, clones or fetches and checks out the node branch of the claim in each checkout. It answers `{ root: string; checkouts: WorkspaceCheckout[] }`.
  3. The agent root is the one checkout for one binding and `checkouts/` for two or more. `.kanthord-scratch/` sits at the agent root, and `.git/info/exclude` of each checkout holds it (`:250-261`). `judged-tasks.json` stays in `workspaces/<node identity>/`.
  4. Each checkout reads its own two records of an earlier push: its remote-tracking ref and the asset of its binding in the evidence of the attempt. A missing remote node branch in one checkout stops the execution with `repository.node_branch.missing`.
  5. `prepareStepsWorkspace` (`src/worker/unit/steps-implement.ts:418-446`) passes every row of `setup.repositories` and the node branch of the claim. The node branch has the same name in each repository.
- Cite: `worker-service.md:289-296`, `:311`, `:316`; `worker-service.impl.md:578-585`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/workspace.test.ts src/worker/unit/steps-implement.test.ts` with "two bindings prepare two checkouts under checkouts/ with one hold", "one binding uses the checkout as the agent root", "the scratch directory is excluded in each checkout" and "a missing remote node branch in one checkout stops with repository.node_branch.missing".

### 09.5 Commit each changed checkout and judge the head set

- Files: `src/worker/unit/steps-implement.ts`, `src/worker/unit/judged-tasks.ts`, `src/worker/unit/verification.ts` and their tests (edit)
- Do:
  1. After the task work, the execution commits each checkout that holds a change, with the task commit message (`src/worker/unit/steps-implement.ts:95-110`, `:154-190`). A checkout with no change keeps its head. A revision that changes no checkout counts as no progress.
  2. `state.head` becomes `state.checkouts`. The task commit is the head set after the last commit of the task work.
  3. Add `headSetOf` to `judged-tasks.ts`. `recordJudged` and `judgedAt` (`src/worker/unit/judged-tasks.ts:28-42`) store and compare that value. The key stays the task identity, or the node identity for a node with no task.
  4. Add `testedInputOf` to `verification.ts`. `verifyCommands` (`src/worker/unit/steps-implement.ts:466-496`) runs every verification from the agent root and writes `testedInputOf(state.checkouts)`. `TestedInput` already holds the list form (`src/worker/unit/verification.ts:8-12`).
- Cite: `worker-service.md:325-336`, `:346`; `worker-service.impl.md:512`, `:548`, `:563`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/steps-implement.test.ts src/worker/unit/judged-tasks.test.ts src/worker/unit/verification.test.ts` with "two bindings commit only the checkout with a change", "a revision that changes no checkout counts as no progress", "the judged value is name=commit,... in binding order" and "one binding stores the commit".

### 09.6 Merge every checkout at the claim and before the release

- Files: `src/worker/unit/base-refresh.ts`, `src/worker/unit/base-refresh.test.ts` (edit)
- Do:
  1. `baseBranchOf` (`src/worker/unit/base-refresh.ts:27`) takes a checkout and answers the base branch of its binding.
  2. `refreshAtClaim` (`:49-123`) merges `origin/<base_branch>` into the node branch of each checkout. An unresolved conflict in one checkout aborts that merge and stops the execution with `operation_failed`.
  3. `refreshBeforeRelease` (`:124-186`) merges every checkout, then runs the task verifications on the merged heads. A conflict in one checkout or a failed verification resets every checkout to its head before that merge, and the release carries further work.
- Cite: `worker-service.md:338-340`, `:353-354`; `worker-service.impl.md:563`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/base-refresh.test.ts` with "a claim merges the base branch of each binding", "one conflict before the release resets every checkout" and "a failed verification on the merged heads resets every checkout".

### 09.7 Push every node branch, then submit one evidence

- Files: `src/worker/unit/steps-implement.ts`, `src/worker/unit/steps-implement-release.test.ts` (edit)
- Do:
  1. `settleImplement` (`src/worker/unit/steps-implement.ts:84-153`) and `checkpointOnStop` (`:154-190`) push the node branch of every checkout with the `ssh_identity` of its binding (`:109`, `:168`).
  2. The execution submits the evidence only after every push succeeds. One failed push stops the execution with no evidence.
  3. The evidence holds one `repository` asset for each binding with the head of its node branch, in binding order (`:141`, `:476`).
- Cite: `worker-service.md:322`, `:355-356`; `mission-service.md:309`; `worker-service.impl.md:563`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/steps-implement-release.test.ts` with "two bindings push both node branches before the evidence", "one failed push submits no evidence" and "the evidence holds one asset for each binding".

### 09.8 Compose one prompt part for each binding of an `implement` node

- Files: `src/worker/unit/native-agent.ts`, `src/worker/unit/native-agent.test.ts` (edit)
- Do:
  1. `openNativeAgent` (`src/worker/unit/native-agent.ts:171-187`) builds one repository layer for each row of `setup.repositories` on an `implement` node, as task 02.12 does on an `examine` node. Each part reads the agent files of the checkout of its binding.
  2. The work prompt of an `implement` node with two or more bindings lists each binding with its directory and its base branch, through the render of task 02.12.
- Cite: `worker-service.md:86`, `:96-100`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/native-agent.test.ts src/agent/prompt-layers.test.ts` with "two bindings compose two parts in binding order from their checkouts" and "the work prompt lists both repositories".

### 09.9 Check out each repository snapshot for the reviewer

- Files: `src/worker/unit/evaluation-input.ts`, `src/worker/unit/evaluation-input.test.ts` (edit)
- Do:
  1. `prepareWorkspace` (`src/worker/unit/evaluation-input.ts:96-148`) takes `snapshotOf` (`:18-33`) of each binding of `setup.repositories` and makes a clean isolated checkout of each snapshot under the layout rule.
  2. A snapshot that misses a binding of the pinned revision stops the reviewer execution with `operation_failed`.
  3. The tested input names every commit, one for each binding. `added_files` (`:192`) holds the files that each evidenced commit adds against `origin/<base branch>` of its binding.
- Cite: `worker-service.md:542-547`; `worker-service.impl.md:552`, `:557`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/evaluation-input.test.ts` with "two bindings check out two snapshots and record one tested commit for each" and "a snapshot that misses a binding stops with operation_failed".

### 09.10 Take each required action from its binding

- Files: `src/mission/frozen-action.test.ts`, `src/worker/action-performer.test.ts` (edit)
- Do:
  1. `requiredActionsOf` (`src/mission/frozen-action.ts:21-66`) already reads every repository binding of the pinned revision. Add a test with two bindings and one action each.
  2. The action performer requests every eligible action of both bindings in one reviewer execution. An action of one binding never follows an action of another binding.
  3. One action with the end state other blocks the node, also when the action of the other binding landed (`src/mission/node-check.ts:93-108`).
- Cite: `worker-service.md:568-573`; `mission-service.md:568-570`.
- Verify: `node --test --test-timeout=30000 src/mission/frozen-action.test.ts src/worker/action-performer.test.ts src/mission/node-check.test.ts` with "two bindings freeze one action each", "one reviewer execution requests both actions" and "one other end blocks the node after a sibling landed".

### 09.11 Name the binding of each change request

- Files: `src/worker/unit/judgement.ts`, `src/worker/unit/node-reads.ts` and their tests (edit)
- Do:
  1. `readRequestedChanges` (`src/worker/unit/node-reads.ts:164-178`) passes the binding name of each read.
  2. `requestedChangesText` (`src/worker/unit/judgement.ts:150-170`) writes `Reviewer <reviewer> requests changes on <binding name> at commit <commit>: <body>`. The text still stops at 4 KiB.
- Cite: `worker-service.md:594`; `worker-service.impl.md:521-522`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/judgement.test.ts src/worker/unit/node-reads.test.ts` with "each change request names its binding" and "the text stops at 4 KiB".

### 09.12 Lift the limit of one repository binding

- Files: `src/mission/content.ts`, `src/mission/content.test.ts`, `src/apps/server/e2e-mission-service.test.ts`, `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do:
  1. The repository range of `implement` in `bindingRules` (`src/mission/content.ts:36-55`) becomes one or more (`mission-service.impl.md:59`).
  2. The second half of row EF03.7 and row EF06.16 now answer exit 0 and pin both bindings in binding order.
- Cite: `mission-service.md:77-81`; `mission-service.impl.md:59`, `:788`; decision D28.
- Verify: `node --test --test-timeout=30000 src/mission/content.test.ts` and `node --test --test-timeout=60000 --test-name-pattern 'EF03\.7 |EF06\.16 ' src/apps/server/e2e-mission-service.test.ts src/apps/server/e2e-todoapp-plan.test.ts`.

### 09.13 Write the two-repository journey

- Files: `src/apps/server/e2e-native-methods.test.ts` (edit)
- Do: write the rows EF09.1 to EF09.6 of the section E2E. The setup adds a second local bare repository and a second repository binding `web` next to the existing one, both with the action `pull_request` under the fake GitHub of the suite.
- Cite: `worker-service.impl.md:552`, `:563`; `mission-service.impl.md:789-792`.
- Verify: `node --test --test-timeout=180000 --test-name-pattern 'EF09\.' src/apps/server/e2e-native-methods.test.ts`.

### 09.14 Update the CLI pages

- Files: `docs/cli/mission.md`, `docs/cli/worker.md` (edit)
- Lane: main session (decision D20).
- Do:
  1. `docs/cli/mission.md` states that an `implement` node names one or more repository bindings, the tested input list, and the `branch_push` address of a contained snapshot. Delete the limit sentence of decision D28.
  2. `docs/cli/worker.md` states the checkout layout by count and the binding name in the requested-changes text.
- Cite: decision D22.
- Verify: `pnpm exec prettier --check docs/cli/mission.md docs/cli/worker.md`.

### 09.E Run the gate

- Do: run the gate row 09 of `00-index.md`.
- Verify: every command of the row exits 0, and each `rg` prints nothing.

## E2E

`e2e-native-methods.test.ts` adds these rows. Setup imports one `implement` node `checkout-flow` with `bindings: [api, web]`, one task whose verification reads a file of each checkout, and the covering worker bindings of decision D15.

| Id     | Commands                                                                                                    | Exit | Expect                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| EF09.1 | `kanthord mission node get <checkoutFlowId>`                                                                | 0    | `bindings` holds `api` and `web` in that order                                                                        |
| EF09.2 | one steps execution, then `kanthord mission execution evidence list <executionId>`                          | 0, 0 | `kanthord/<checkoutFlowId>` exists in both bare repositories; one evidence holds two `repository` assets, `api` first |
| EF09.3 | `kanthord mission evidence submit` with one `repository` asset of `api` alone                               | 1    | stderr starts with `mission.evidence.binding_mismatch:`                                                               |
| EF09.4 | one reviewer execution, then `kanthord mission assessment list <checkoutFlowId>`                            | 0, 0 | one `success` assessment; `tested_input` is a list of two addresses in binding order                                  |
| EF09.5 | the fake GitHub merges both pull requests; `kanthord mission node get <checkoutFlowId>`                     | 0    | `state` `Completed`; the outcome holds one landed commit for each binding                                             |
| EF09.6 | a second node on `web` alone whose task the base branch already meets; one steps and one reviewer execution | 0, 0 | no pull request opens; the request evidence holds a `branch_push` address; the check folds to `pull_request_merged`   |

## Blockers

None.

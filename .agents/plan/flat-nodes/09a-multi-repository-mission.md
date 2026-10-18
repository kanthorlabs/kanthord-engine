# Plan 09a: Mission and Intake — the evidence set and the actions of each repository binding

## Scope

This plan delivers the Mission and Intake rules of a multi-repository `implement` node. The rule table keeps the limit of one repository binding on an `implement` node (decision D28), so the node API still refuses a second binding.

- One evidence snapshot with exactly one `repository` asset for each repository binding of the pinned revision, checked at the submit and at the release. Another set answers `mission.evidence.binding_mismatch`.
- The tested input list for two or more bindings, in binding order, and the action operands of each binding from that list.
- The contained snapshot of a `pull_request` action (R12): the Intake Service opens no pull request when the base branch already contains the snapshot commit, and the Mission Service admits the `branch_push` address of that landing.
- The required actions of each binding.

Colocated tests write a revision with two repository bindings through the store harness of `src/mission/test-support.ts`, because the node API refuses it until plan 09b.

Out of scope:

- The worker loops, the workspace layout, the prompt parts, the reviewer checkouts and the lift of the limit (plan 09b).
- An atomic landing across repositories. Each required action resolves on its own (`mission-service.md:569-571`).
- An action order across bindings. `follows` across bindings stays refused (`worker-service.md:573`).

## Model

Opus at medium effort. The plan changes the evidence invariant of the Mission Service and the pull request call of the Intake Service.

## Sources

- `docs/brainstorm/mission-service.md:310-314` — one repository asset for each binding, `mission.evidence.binding_mismatch` and the tested input list.
- `docs/brainstorm/mission-service.md:569-571` — no atomic landing; each action resolves on its own.
- `docs/brainstorm/mission-service.impl.md:114` — the `branch_push` address of a `pull_request` request.
- `docs/brainstorm/mission-service.impl.md:317`, `:354-358` — the release obligation and the binding asset rules.
- `docs/brainstorm/mission-service.impl.md:789-790`, `:795` — the evidence, tested input and contained-snapshot tests.
- `docs/brainstorm/intake-service.impl.md:230-231`, `:311` — the contained snapshot and its test.
- `docs/brainstorm/worker-service.md:568-578` — the actions by binding and the contained snapshot.

An engine citation of this plan names the file name after plan 04 and the line at `54380cd9`. Before each task, find the cited symbol by name in the merged code of the predecessor plan and re-anchor its lines (`engine/AGENTS.md:477-479`). A design citation names a line at root `5fa6db3`.

## Depends on

- Plan 08 merged to `main` of the root repository.

## Provides

No seam. The evidence rules of this plan serve plan 09b.

## Tasks

### 09a.1 Require one repository asset for each repository binding

- Files: `src/mission/evidence-content.ts`, `src/mission/evidence-submit.ts`, `src/mission/transitions.ts` and their tests (edit)
- Do:
  1. `repositoryBindingIdsOf` (`src/mission/evidence-content.ts:122-157`) answers every repository binding of the pinned `implement` revision in binding order.
  2. `prepareEvidence` (`src/mission/evidence-submit.ts:41-151`): an execution evidence of an `implement` node that holds a `repository` asset holds exactly one for each binding of that list, and no other. A missing binding, a repeated binding or a foreign binding answers 400 `mission.evidence.binding_mismatch` with `details: { binding_id }`.
  3. `hasEvidence` (`src/mission/transitions.ts:104-140`) requires, for an `implement` node, one published evidence of the releasing execution with one `repository` asset for every binding of the list. `.some` over the assets becomes a check of every binding.
- Cite: `mission-service.md:310-312`; `mission-service.impl.md:317`, `:354`, `:358`, `:789`.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-submit.test.ts src/mission/transitions.test.ts src/mission/evidence-content.test.ts` with "an implement evidence that misses a binding answers mission.evidence.binding_mismatch", "an implement evidence with a foreign binding answers mission.evidence.binding_mismatch", "a release with one asset for one of two bindings is refused" and "one asset for each of two bindings releases".

### 09a.2 Accept the tested input list in binding order

- Files: `src/mission/evidence-content.ts`, `src/mission/control-close.ts`, `src/worker/action-operands.ts` and their tests (edit)
- Do:
  1. `requireTestedInput` (`src/mission/evidence-content.ts:159-203`) accepts one address for a node with one repository binding, and a list with one address for each binding in binding order for two or more. ~~Another form answers `mission.evidence.binding_mismatch` with `details: { binding_id }`.~~ OD10: a wrong form answers 400 `gateway.request.validation_failed`, and a wrong binding set answers `mission.evidence.binding_mismatch`.
  2. `landedEvidence` (`src/mission/control-close.ts:50-107`) applies the same form and binding rule to the landed commit of a success override.
  3. `operandsOf` (`src/worker/action-operands.ts:11-40`) takes the address of the action binding from a list. A list without that binding keeps the refusal `WorkerErrorCode.SnapshotAbsent`. `assessedCommitOf` (`src/mission/authorization.ts:220-238`) already reads a list.
- Cite: `mission-service.md:313-314`; `mission-service.impl.md:356-357`, `:790`; `worker-service.md:574`.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-content.test.ts src/mission/control-close.test.ts src/worker/action-operands.test.ts` with "a node with two bindings writes a tested input list in binding order", "a list out of binding order answers mission.evidence.binding_mismatch" and "each action takes the commit of its own binding from the list".

### 09a.3 Answer a contained snapshot of a pull request

- Files: `src/intake/action-perform.ts`, `src/intake/action-check.ts`, `src/repository/connector.ts`, `src/mission/evidence-request.ts` and their tests (edit)
- Do:
  1. `createPullRequest` (`src/intake/action-perform.ts:242-266`) first calls `gitWriter.landedOn` with the base branch and the snapshot commit, as `landedMerge` does (`:393-415`). A landing opens no pull request and answers `branchPushAddress(facts, landing.first_parent)`. ~~The read-back of a repeat (`:335-350`) applies the same rule.~~ OD12: the read-back keeps the open pull request rule, because `intake-service.impl.md:234` leaves a human merge `failed`.
  2. `foldBranchPush` (`src/repository/connector.ts:593-602`) accepts the expected end state `pull_request_merged` next to `base_branch_pushed`. A landing folds to the expected end state with the landed commit.
  3. `inspect` (`src/intake/action-check.ts:103-131`) folds a `branch_push` address of a `pull_request` action through `landedOn` and that fold.
  4. The address check of a request (`src/mission/evidence-request.ts:52-70`) admits a `branch_push` address for a `pull_request` action when its `resource_identity` is that of the action binding. Every other kind mismatch keeps `mission.request.address_mismatch`.
- Cite: `intake-service.impl.md:230-231`, `:311`; `mission-service.impl.md:114`, `:795`; `worker-service.md:575`.
- Verify: `node --test --test-timeout=30000 src/intake/action-perform.test.ts src/intake/action-check.test.ts src/repository/connector.test.ts src/mission/evidence-request.test.ts` with "a pull request whose base branch contains the snapshot opens no pull request and answers the branch push address of the oldest first-parent commit", "the check folds that address to pull_request_merged with the landed commit" and "a pull request request admits a branch push address of its binding".

### 09a.4 Take each required action from its binding

- Files: `src/mission/frozen-action.test.ts`, `src/worker/action-performer.test.ts` (edit)
- Do:
  1. `requiredActionsOf` (`src/mission/frozen-action.ts:21-66`) already reads every repository binding of the pinned revision. Add a test with two bindings and one action each.
  2. The action performer requests every eligible action of both bindings in one reviewer execution. An action of one binding never follows an action of another binding.
  3. One action with the end state other blocks the node, also when the action of the other binding landed (`src/mission/node-check.ts:93-108`).
- Cite: `worker-service.md:571-576`; `mission-service.md:569-571`.
- Verify: `node --test --test-timeout=30000 src/mission/frozen-action.test.ts src/worker/action-performer.test.ts src/mission/node-check.test.ts` with "two bindings freeze one action each", "one reviewer execution requests both actions" and "one other end blocks the node after a sibling landed".

### 09a.5 Update the CLI page

- Files: `docs/cli/mission.md` (edit)
- Lane: main session (decision D20).
- Do: state the evidence set of one asset for each repository binding, the tested input list and the `branch_push` address of a contained snapshot. Keep the limit sentence of decision D28.
- Cite: decision D22.
- Verify: `pnpm exec prettier --check docs/cli/mission.md`.

### 09a.E Run the gate

- Do: run the gate row 09a of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

`e2e-worker-action-performer.test.ts` adds these rows. Setup creates one `implement` node on the repository binding of the suite.

| Id      | Commands                                                                              | Exit | Expect                                                                                                              |
| ------- | ------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| EF09a.1 | `kanthord mission evidence submit` with a `repository` asset of a foreign binding     | 1    | stderr starts with `mission.evidence.binding_mismatch:`                                                             |
| EF09a.2 | a node whose task the base branch already meets; one steps and one reviewer execution | 0, 0 | no pull request opens; the request evidence holds a `branch_push` address; the check folds to `pull_request_merged` |

## Blockers

None.

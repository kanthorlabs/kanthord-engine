# Plan 03: Mission Service — one decision for each assessment

## Scope

This plan fixes defects K3 and K4 of the worker-routing dogfood run of 2026-10-29 under the ruling of decision D6.

Root cause of K3: `approveProposal` unblocks the proposer at the first approval (`src/mission/proposal-approve.ts:112-125`). The next approval of the same assessment fails the check `proposer.state !== NodeState.Blocked || proposer.attempt !== proposal.attempt` (`:65-69`) with `mission.node.state_conflict`. In the dogfood run, `proposal_01M62QR9VCDTDVFPQ130KG1A7Y` stayed open, and the review of the next attempt of `g01` never saw it (K4).

The plan delivers:

- The operation `mission.proposal.decide` at `POST /api/mission/assessment/:assessment_id/decide`, with the body `ProposalDecide` and the answer `ProposalDecideResult`.
- `rejected_at` on the proposal record (decision D8).
- The rejection of every open proposal of the blocking attempt at a node unblock, a node discard and a node override of the proposer.
- The act `mission.proposal.decide`. It names the proposer.
- The CLI command `kanthord mission proposal decide <assessment-id> --file <path>`, with the same answers and refusals as the API.
- The removal of `mission.proposal.approve`, `ProposalApprove`, `ProposalApproveResult`, `mission.proposal.already_approved` and `cli.mission.proposal.approve.invalid_proposal_id`.
- `docs/cli/mission.md` and `docs/cli/worker.md`.

Out of scope:

- The dashboard. Plan 04 moves it to the new operation.
- Root `docs/reference/workbench/tools.md`. It is generated from the engine. The root follow-up of `00-index.md` regenerates it.
- The worker. The reviewer writes proposals as before.

## Model

Opus at medium effort. The decision crosses node creation, the dependency edges, the coverage check, the unblock, the discard, the act trace and the gateway contract in one transaction.

## Sources

Root pull request #276 at head `1809726` is the rule (decision D7):

- `docs/brainstorm/mission-service.impl.md` "The fix-node proposal" — the operation, the body, the answer, the order of the writes, the refusals and the rejection at unblock, discard and override.
- `docs/brainstorm/mission-service.impl.md` "The act trace" — `mission.proposal.decide` names the proposer, and `kanthord.node.state.from` is `Blocked`.
- `docs/brainstorm/mission-service.impl.md` "Tests" — the decision test of two of three proposals.
- `docs/reference/mission/assessment.md` "Fix-node proposals" — the CLI text and the record fields.
- `docs/reference/erd/02-execution.md` "Mission Service: proposals" — the column `rejected_at` and the writes that change a proposal row.

## Depends on

- Root pull request #276 approved by Ulrich.
- Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plans 01, 02 and 05 run in parallel. No file overlaps.

## Provides

The contract of plan 04:

| Item                      | Shape                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mission.proposal.decide` | `POST /api/mission/assessment/:assessment_id/decide`, `human` access, idempotent mutation                                                                                  |
| `ProposalDecide`          | `expected_mission_version: positive integer`, `approved_proposal_ids: proposal identity[]` (1 to 10, no duplicate), optional `reason: Text`                                |
| `ProposalDecideResult`    | `created: NodeChange[]` (one for each approved proposal, in the order of `approved_proposal_ids`), `rejected_proposal_ids: proposal identity[]`, `proposer: ControlResult` |
| `Proposal`                | adds `rejected_at: timestamp \| null`                                                                                                                                      |
| New codes                 | 409 `mission.proposal.decided` with `details: { assessment_id }`; 400 `mission.proposal.assessment_mismatch` with `details: { proposal_ids }`                              |
| Removed                   | `mission.proposal.approve`, `mission.proposal.already_approved`                                                                                                            |

## Tasks

### 03.1 Write the reproducing test of K3

- Files: `src/mission/proposal.test.ts` (edit)
- Do:
  1. Add a `decide` helper to `fixture` beside `approve` (`src/mission/proposal.test.ts:187-192`). It invokes `"proposal.decide"` with `params: { assessment_id }`, `query: {}` and `body: { expected_mission_version, approved_proposal_ids }`.
  2. Add the test "a decision approves two of three proposals, rejects the third and unblocks the proposer once". Submit one `undetermined` assessment with three proposals, as the test of `:221` submits them. Decide the first and the third.
  3. Assert two created nodes, in the order of `approved_proposal_ids`. Assert two dependency edges of the proposer, one on each created node. Assert `rejected_proposal_ids` equal to the identity of the second proposal.
  4. Assert with `list()` that the first and the third proposal hold `approved_at` and `created_node_id`, and the second holds `rejected_at` and `approved_at: null`. Assert that the proposer is `Pending` at attempt 2 and that `readOpenAttempt` gives one new attempt.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/mission/proposal.test.ts` fails on the new test only. The registry knows no operation `proposal.decide`.

### 03.2 Add `rejected_at` to the proposal record

- Files: `src/mission/migrations.ts`, `src/mission/proposal-store.ts`, `src/mission/proposal-read.ts`, `src/mission/contract.ts`, `src/mission/assessment-submit.ts` (edit)
- Do:
  1. Add `rejected_at INTEGER` after `approved_at INTEGER` in `CREATE TABLE mission_proposal` (`src/mission/migrations.ts:106-115`). Add no migration (decision D8).
  2. `ProposalRow` (`src/mission/proposal-store.ts:6-15`) adds `rejected_at: number | null`. `insertProposal` asserts `rejected_at === null` and writes the column. `assessment-submit.ts:179-188` passes `rejected_at: null`.
  3. Add `listProposalsOfAssessment(tx, assessmentId): ProposalRow[]`, ordered by `id`.
  4. Add `markProposalsRejected(tx, nodeId, attempt, rejectedAt): string[]`. It sets `rejected_at` of every row of the node and the attempt with `approved_at IS NULL AND rejected_at IS NULL`, and answers the identities that it changed, ordered by `id`.
  5. `markProposalApproved` (`:66-79`) also requires `rejected_at IS NULL` in its `WHERE`.
  6. `proposalSchema` (`src/mission/contract.ts:1302-1311`) adds `rejected_at: timestamp.nullable()` after `approved_at`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/mission/proposal.test.ts src/apps/server/migrations.test.ts` passes, except the test of task 03.1.

### 03.3 Declare the operation and remove the approve

- Files: `src/mission/contract.ts`, `src/mission/act-telemetry.ts` (edit)
- Do:
  1. Replace `proposalApproveSchema` and `proposalApproveResultSchema` (`src/mission/contract.ts:1313-1321`) with `proposalDecideSchema` and `proposalDecideResultSchema` of the table "Provides". `approved_proposal_ids` is `z.array(identitySchema(PROPOSAL_IDENTITY_PREFIX)).min(1).max(PROPOSAL_MAX)` with a refinement that refuses a duplicate. Export the types `ProposalDecide` and `ProposalDecideResult`.
  2. Replace the operation `"proposal.approve"` (`:2013-2028`) with `"proposal.decide"`: id `mission.proposal.decide`, method `POST`, path `/api/mission/assessment/:assessment_id/decide`, params `{ assessment_id: identitySchema("assessment") }`, the same access policy and mutation flags as the approve. Description: "Decide every fix-node proposal of one assessment: create a fix node for each approved proposal, reject the other open proposals and unblock the proposer once."
  3. Replace `ProposalAlreadyApproved` (`:386`) with `ProposalDecided: "mission.proposal.decided"` and add `ProposalAssessmentMismatch: "mission.proposal.assessment_mismatch"`.
  4. Replace `Act.ApproveProposal` (`src/mission/act-telemetry.ts:26`) with `DecideProposals: "mission.proposal.decide"`.
- Verify: `pnpm run typecheck` names only the callers that tasks 03.4 to 03.8 change.

### 03.4 Implement the decision

- Files: `src/mission/proposal-approve.ts` → `src/mission/proposal-decide.ts` (`git mv`, then edit), `src/mission/service.ts` (edit)
- Do:
  1. Rename `approveProposal` to `decideProposals(tx, dependencies, assessmentId, body, actor, now, ends)`.
  2. Read the assessment with `readAssessment` (`src/mission/record-store.ts:461`). An unknown assessment answers 404 `mission.record.not_found`.
  3. Read the proposals with `listProposalsOfAssessment`. The open proposals hold `approved_at === null && rejected_at === null`. No open proposal answers 409 `mission.proposal.decided` with `details: { assessment_id }`.
  4. An approved identity that names no proposal of the assessment answers 400 `mission.proposal.assessment_mismatch` with `details: { proposal_ids }`, the identities that match none. An approved identity of a decided proposal of the assessment answers 409 `mission.proposal.decided`.
  5. Read the proposer from the `node_id` of the proposals. Keep the checks of `proposal-approve.ts:57-69`, with the attempt of the assessment in place of the attempt of one proposal.
  6. For each approved proposal, in the order of `approved_proposal_ids`, run the node creation and `insertDependency` of `:70-111`. Pass the mission version of the previous creation as `expected_mission_version` of the next one. Then call `markProposalApproved`.
  7. Call `unblockNode` once, as `:112-125` does, with the mission version of the last creation. Task 03.5 makes the unblock reject the other open proposals. Answer `rejected_proposal_ids` as the open identities that `approved_proposal_ids` does not hold.
  8. The act names the proposer: `node_id` of the proposer, `attempt` of the unblocked proposer, `from: NodeState.Blocked`, `to` of the unblocked proposer.
  9. In `src/mission/service.ts`, register `"proposal.decide"` in place of `"proposal.approve"` (`:541-561`) with `Act.DecideProposals`. Replace the write scope `{ proposal_id }` (`:179-191`) with `{ assessment_id }`. `projectOf` reads the node of the assessment.
- Cite: decision D6; `mission-service.impl.md` "The fix-node proposal".
- Verify: the test of task 03.1 passes.

### 03.5 Reject the open proposals at unblock, discard and override

- Files: `src/mission/control-unblock.ts`, `src/mission/control-close.ts`, `src/mission/proposal.test.ts` (edit)
- Do:
  1. In `unblockNode` (`src/mission/control-unblock.ts:124`), after the check `requireControlState(node, [NodeState.Blocked])`, call `markProposalsRejected(tx, nodeId, node.attempt, now)`.
  2. In `discardNode` (`src/mission/control-close.ts:298`), when the node is `Blocked` at admission, call `markProposalsRejected` with its attempt before the attempt closes.
  3. In `overrideNode` (`src/mission/control-close.ts:114`), when the node is `Blocked` at admission, call `markProposalsRejected` with its attempt. `OVERRIDE_STATES` holds `Blocked` (`src/mission/contract.ts:471-480`).
  4. Add the tests "an unblock of the proposer rejects every open proposal", "a discard of the proposer rejects every open proposal" and "an override of the proposer rejects every open proposal". Each test submits two proposals, runs the act and asserts `rejected_at` on both.
- Cite: `mission-service.impl.md` "The fix-node proposal", last item.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/mission/proposal.test.ts src/mission/control-unblock.test.ts src/mission/control-close.test.ts` passes.

### 03.6 Move the CLI

Run this task before task 03.7. Task 03.3 removes `proposalApproveSchema`, which `src/apps/cli/mission-proposal.ts:7` imports, so no test of the CLI or the server compiles before this task.

- Files: `src/apps/cli/mission-proposal.ts`, `src/apps/cli/mission-examples.ts`, `docs/cli/mission.md` and the CLI tests that name `proposal approve` (edit)
- Do:
  1. Replace the command `approve <proposal-id>` (`src/apps/cli/mission-proposal.ts:66-90`) with `decide <assessment-id>`. Description: "Decide every fix-node proposal of one assessment and unblock its examine proposer". It takes `proposalDecideSchema` through `addMutationOptions`, so the body comes from `--file <path>` like every mission CLI write.
  2. An argument that is not a canonical `assessment_<ulid>` exits 1 with `cli.mission.proposal.decide.invalid_assessment_id`. Remove `cli.mission.proposal.approve.invalid_proposal_id` (`:23-24`).
  3. `missionExamples.proposalApprove` (`src/apps/cli/mission-examples.ts:115`) becomes `proposalDecide: { expected_mission_version: MISSION_VERSION, approved_proposal_ids: ["proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV"] }`.
  4. The command row 57 of `docs/cli/mission.md:478` becomes `proposal decide <assessment-id> --file <path> [M]`, `POST /api/mission/assessment/:assessment_id/decide`, `mission.proposal.decide`, `H`. The CLI inventory check reads this row.
  5. Find each CLI test with `rg -n 'proposal approve|proposal\.approve|invalid_proposal_id' src/apps` and move it to `decide`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/cli/*.test.ts` passes.

### 03.7 Move the proposal tests to the decision

- Files: `src/mission/proposal.test.ts`, `src/mission/act-telemetry.test.ts`, `src/apps/server/e2e-mission-proposals.test.ts` (edit)
- Do:
  1. Replace the `approve` helper with `decide`. Each test of `src/mission/proposal.test.ts:244-480` that approves one proposal decides it with `approved_proposal_ids: [<that proposal>]`.
  2. "approving twice refuses with already_approved" (`:382`) becomes "a repeated decision refuses with decided" and asserts `MissionErrorCode.ProposalDecided`.
  3. "approving refuses an unknown proposal, a stale version and a changed proposer state" (`:393`) becomes the decision form. It adds an unknown assessment, answered with `mission.record.not_found`, and an identity of another assessment, answered with `ProposalAssessmentMismatch`. It adds an empty list and a duplicate list, answered with `gateway.request.validation_failed` at `approved_proposal_ids`. Each refusal compares `databaseSnapshot` before and after.
  4. The act trace tests (`:425-480`) assert that the trace names the proposer, `kanthord.node.state.from` `Blocked` and the operation `Act.DecideProposals`.
  5. `act-telemetry.test.ts:128` uses `Act.DecideProposals`.
  6. `e2e-mission-proposals.test.ts` (`:315-475`) calls `"proposal.decide"` over HTTP. Its journey decides two proposals of one assessment and asserts the two fix nodes. The refusal for the machine identity (`:367`) stays. Keep every HTTP check.
  7. Prove the parity of the CLI in the same file, with `kanthord` and `cliSession` of `src/apps/server/cli-test-support.ts` (the file already imports them, `:29-38`). Submit three proposals of one assessment. Write a `--file` body with two `approved_proposal_ids`, the current `expected_mission_version` and a `reason`. Run `kanthord mission proposal decide <assessment-id> --file <path>`. Assert exit 0 and a stdout JSON line with two `created` items, one `rejected_proposal_ids` item, `proposer` and `idempotency_key`.
  8. Through the CLI, assert exit 1 and the stderr prefix of each refusal. Run the stale-version refusal and the mismatch refusal against the three-proposal assessment before the decision of step 7. Run the repeated decision after it. The refusals: `mission.proposal.decided:` for the same decision again, `mission.proposal.assessment_mismatch:` for a proposal identity of another assessment, `mission.version.conflict:` for a stale `expected_mission_version`, and `cli.mission.proposal.decide.invalid_assessment_id:` for the argument `node_01ARZ3NDEKTSV4RRFFQ69G5FAV`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=180000 src/mission/proposal.test.ts src/mission/act-telemetry.test.ts src/apps/server/e2e-mission-proposals.test.ts` passes.

### 03.8 Regenerate the OpenAPI document

- Files: `static/openapi.yaml`, `static/openapi/mission/*` (generated), `src/apps/server/openapi-integration.test.ts` (edit)
- Do:
  1. In `openapi-integration.test.ts`, replace `"proposal.approve"`, `"mission.proposal.approve"` (`:389-390`) and `["mission.proposal.approve", AccessPolicy.Human]` (`:785`) with the decide entries.
  2. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. `static/openapi/mission/proposal.approve.yaml` goes away, and `proposal.decide.yaml` comes. `proposal.list.yaml` adds `rejected_at`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/apps/server/openapi-integration.test.ts` passes.

### 03.9 Update the CLI pages

- Files: `docs/cli/mission.md`, `docs/cli/worker.md` (edit)
- Do:
  1. `docs/cli/mission.md:69`: "proposal approve" becomes "proposal decide".
  2. Rewrite `:490-502` from `docs/reference/mission/assessment.md` "Fix-node proposals" of root pull request #276: the body, the answer, the order of the writes, the refusals, and the rejection at unblock, discard and override. Delete "No operation rejects a proposal." (`:502`).
  3. In the control texts, add one sentence to Unblock (`:431-443`), Override (`:455-462`) and Discard (`:463-467`): "From `Blocked`, it rejects every open fix-node proposal of the assessment that blocked the node." Link "fix-node proposal" to root `docs/reference/mission/assessment.md#fix-node-proposals`, with the GitHub URL form of the other root links of the page.
  4. Replace the rows `ProposalApprove` (`:868`) and `ProposalApproveResult` (`:1022`) with `ProposalDecide` and `ProposalDecideResult` of the table "Provides". The `Proposal` row adds `rejected_at`.
  5. In the error tables, replace `cli.mission.proposal.approve.invalid_proposal_id` (`:1120`) with `cli.mission.proposal.decide.invalid_assessment_id`, and `mission.proposal.already_approved` (`:1211`) with `mission.proposal.decided`. Add the row 400 `mission.proposal.assessment_mismatch`.
  6. `docs/cli/worker.md:349`: "See `mission proposal decide` in the [Mission CLI](mission.md)."
- Verify: `pnpm exec prettier --check docs/cli/mission.md docs/cli/worker.md`.

### 03.E Run the gate

- Do: run the gate row 03 of `00-index.md`.
- Verify: every command of the row exits 0, and each check prints nothing.

## E2E

`src/apps/server/e2e-mission-proposals.test.ts` decides two proposals of one assessment through the gateway and through the CLI (task 03.7).

## Blockers

None.

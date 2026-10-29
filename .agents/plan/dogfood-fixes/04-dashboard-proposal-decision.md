# Plan 04: Dashboard — one decision for each assessment

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan moves the dashboard from `mission.proposal.approve` to `mission.proposal.decide` of plan 03 (decision D6). Today the dashboard approves one proposal at a time:

- `approveProposal` sends `POST /api/mission/proposal/:proposal_id/approve` (`src/api/resources/mission.ts:138-150`).
- `useProposalApprove` targets one proposal (`src/hooks/use-proposal-approve.tsx:55-157`), and `ProposalApproveDialog` confirms one proposal (`src/components/proposal-approve-dialog.tsx`).
- The node sheet shows an approve button in each proposal row (`src/features/projects/view/components/proposal-item.tsx:84-88`). The Overview decision item shows one approve button for each open proposal (`src/features/overview/components/decision-item.tsx:140-155`).

The plan delivers:

- The API types and the resource of the decision.
- One `Decide` action on the section `Fix proposals` and on the Overview decision item of a `Blocked` proposer.
- One dialog that lists each open proposal of the assessment with a checkbox and holds the optional reason.
- The badges `open`, `approved` and `rejected`.
- The mock daemon of `mock/`.

Out of scope:

- The engine. Plan 03 owns the operation.
- The Unblock and Discard dialogs. The engine rejects the open proposals at these acts, and the dashboard reads the result after its reload.

## Model

Sonnet at high effort. The plan replaces one hook, one dialog and two call sites, and it follows a fixed contract.

## Sources

Root pull request #276 at head `14bc18a` is the rule (decision D7):

- `docs/brainstorm/mission-service.impl.md` "The mission screen of the dashboard" — the badges, the one `Decide` action, the dialog text, the disabled confirm and its reason.
- `docs/brainstorm/mission-service.impl.md` "The fix-node proposal" — the body, the answer and the refusals.
- `docs/brainstorm/architecture.impl.md:1461` — the act label `Proposals decided`.
- `apps/AGENTS.md` "Architecture" — a changed operation also updates `mock/`.
- `apps/AGENTS.md:47-49` and root `AGENTS.md:177-179` — both widths and the browser check.

## Depends on

- Plan 03 merged to `main` of the engine.
- Start from `origin/main` of `kanthorlabs/kanthord-apps`. No file overlaps with plans 02 and 05.

## Provides

The dashboard of the decision contract. No engine seam.

## Tasks

### 04.1 Write the reproducing tests

- Files: `src/features/projects/view/components/proposal-section.test.tsx`, `src/features/overview/overview-screen.test.tsx` (edit)
- Do:
  1. In `proposal-section.test.tsx`, add the test "decides two of three open proposals in one dialog". Render a `Blocked` proposer with three open proposals of one assessment. Click `Decide`. In the dialog, check the first and the third proposal and confirm.
  2. Assert that `decideProposals` is called once with the assessment identity and `{ expected_mission_version, approved_proposal_ids: [<first>, <third>] }`. Assert that no proposal row holds an `Approve proposal` button.
  3. Add the test "keeps the confirm disabled until one proposal is checked". Assert the reason "Check one proposal or more. To reject every proposal, use Unblock or Discard."
  4. In `overview-screen.test.tsx`, move the test of `:1424` to one `Decide` button of the decision item with two open proposals.
- Verify: `pnpm exec vitest run src/features/projects/view/components/proposal-section.test.tsx src/features/overview` fails on the new tests only.

### 04.2 Move the API types and the resource

- Files: `src/api/types.ts`, `src/api/resources/mission.ts`, `src/api/resources/mission.test.ts` (edit)
- Do:
  1. `MissionProposal` (`src/api/types.ts:812-821`) adds `readonly rejected_at: number | null`.
  2. Replace `MissionProposalApproveBody` (`:823-826`) with `MissionProposalDecideBody { expected_mission_version; approved_proposal_ids: readonly string[]; reason? }`. Replace `MissionProposalApproveResult` (`:905-908`) with `MissionProposalDecideResult { created: readonly MissionNodeChange[]; rejected_proposal_ids: readonly string[]; proposer: MissionControlResult }`.
  3. Replace `approveProposal` (`src/api/resources/mission.ts:138-150`) with `decideProposals(assessmentId, body)`. It sends `POST /api/mission/assessment/<assessment id>/decide` with a new idempotency key.
  4. Move the resource test of `src/api/resources/mission.test.ts:153-155`.
  5. Before the merge, compare these types with `static/openapi/mission/proposal.decide.yaml` and `proposal.list.yaml` of engine `origin/main`. A difference blocks the merge.
- Verify: `pnpm exec vitest run src/api`.

### 04.3 Replace the approve hook with the decision hook

- Files: `src/hooks/use-proposal-approve.tsx` → `src/hooks/use-proposal-decision.tsx`, `src/hooks/use-proposal-approve.test.ts` → `src/hooks/use-proposal-decision.test.ts` (`git mv`, then edit)
- Do:
  1. `useProposalDecision(proposer, proposals, missionVersion, reload)` answers `open`, `openProposals`, `checked`, `toggle(proposalId)`, `reason`, `setReason`, `error`, `deciding`, `available`, `unavailableReason`, `request`, `cancel` and `confirm`.
  2. `openProposals` holds the proposals with `approved_at === null`, `rejected_at === null` and `attempt === proposer.attempt`. `available` is true when the proposer is `Blocked`, not retired, and `openProposals` is not empty. Keep the texts of `unavailableReasonOf` (`:36-49`) for the other cases.
  3. `confirm` sends `decideProposals(openProposals[0].assessment_id, { expected_mission_version, approved_proposal_ids, reason? })`, with the checked identities in the order of `openProposals`. It does nothing while no proposal is checked.
  4. The success toast reads "Decided the proposals of <proposer>." Its description names the count of fix nodes and of rejected proposals and the proposer state.
  5. `CONFLICT_MESSAGES` (`:24-33`) drops `mission.proposal.already_approved`. It adds `mission.proposal.decided`: "Another decision of this assessment came first. The view now shows it." and `mission.proposal.assessment_mismatch`: "A proposal no longer belongs to this assessment. The view now shows the current proposals."
  6. Move the hook tests to the new state.
- Cite: decision D6; `mission-service.impl.md` "The mission screen of the dashboard".
- Verify: `pnpm exec vitest run src/hooks/use-proposal-decision.test.ts`.

### 04.4 Replace the approve dialog with the decision dialog

- Files: `src/components/proposal-approve-dialog.tsx` → `src/components/proposal-decision-dialog.tsx` (`git mv`, then edit)
- Do:
  1. Title: "Decide the proposals of <proposer>?". Description: "Checked proposals become fix nodes. Unchecked proposals become rejected. A decision cannot be undone."
  2. List each open proposal with the vendored `Checkbox` (`src/components/ui/checkbox.tsx`), labelled with the proposal name. Copy the checkbox field of `src/features/workers/instance/components/archive-instance-dialog.tsx:56`.
  3. Keep the reason field and the error line of the approve dialog.
  4. The confirm `Decide` stays disabled while no proposal is checked, with the reason "Check one proposal or more. To reject every proposal, use Unblock or Discard." Show the reason as text in the dialog, not in a tooltip alone.
- Verify: `pnpm exec vitest run src/components`.

### 04.5 Move the call sites

- Files: `src/features/projects/view/components/proposal-section.tsx`, `src/features/projects/view/components/proposal-item.tsx`, `src/features/overview/use-decision-acts.ts`, `src/features/overview/components/decision-item.tsx`, `src/lib/attention.ts` and their tests (edit)
- Do:
  1. `ProposalSection` calls `useProposalDecision` and renders one `Decide` button beside its heading while `available` is true, else the `unavailableReason` text. It renders `ProposalDecisionDialog`. Its description reads "A judgement of this examine node proposes a fix node for each defect in a completed dependency. Decide creates a fix node for each checked proposal, rejects the others and unblocks this node."
  2. `ProposalItem` drops the `approve` prop and its button (`proposal-item.tsx:84-88`). The badge reads `open`, `approved` or `rejected` (`:65-67`). A rejected proposal shows the fact `Rejected` with `utcDateTime(proposal.rejected_at)`, as `:49-50` shows `Approved`.
  3. `useDecisionActs` (`src/features/overview/use-decision-acts.ts:149`) calls `useProposalDecision`. The decision item (`decision-item.tsx:140-155`) shows one `Decide` button while `available` is true and renders `ProposalDecisionDialog` (`:207`).
  4. `openProposalsOf` (`src/lib/attention.ts:241-248`) also requires `rejected_at === null`.
  5. Remove every import of the old hook and dialog. `rg -n 'approveProposal|ProposalApprove|use-proposal-approve|proposal-approve-dialog' src mock` prints nothing.
- Verify: the tests of task 04.1 pass. `pnpm exec vitest run src/features src/lib`.

### 04.6 Move the mock daemon

- Files: `mock/daemon.mjs`, `mock/fixtures.mjs` (edit)
- Do:
  1. Replace the route `POST /api/mission/proposal/:id/approve` (`mock/daemon.mjs:1332-1420`) with `POST /api/mission/assessment/:id/decide`. It applies the order of writes and the refusals of plan 03: 404 for an unknown assessment, 409 `mission.proposal.decided`, 400 `mission.proposal.assessment_mismatch`, 409 `mission.node.state_conflict`. It answers `{ created: [...], rejected_proposal_ids, proposer }`.
  2. Each fixture proposal holds `rejected_at: null`. One fixture assessment of a `Blocked` examine node holds two open proposals.
  3. The unblock route (`:1477`) and the discard route (`:1512`) set `rejected_at` of every open proposal of the attempt of a `Blocked` proposer.
- Verify: `node mock/daemon.mjs` starts.

### 04.E Run the gate

- Do:
  1. Run the gate row 04 of `00-index.md`.
  2. Start `pnpm dev:all`. With the `ego-browser` skill, open the project of the fixture examine node at 1280 by 800 and at 390 by 844 (root `AGENTS.md:177-179`).
  3. On the node sheet, check that `Decide` opens the dialog with one checkbox for each open proposal and a disabled confirm. Check one proposal and confirm. Check that the section then shows one `approved` and one `rejected` badge.
  4. On the Overview, check that the decision item of a `Blocked` examine node shows one `Decide` button.
- Verify: every command of the row exits 0, and each check of steps 3 and 4 holds at both widths with no horizontal page scroll.

## E2E

The apps repository holds no engine E2E. The browser check of task 04.E is the end-to-end proof against the mock daemon.

## Blockers

None.

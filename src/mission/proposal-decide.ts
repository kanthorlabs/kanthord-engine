import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type ExecutionEnds,
  type HumanActor,
  Intent,
  MissionErrorCode,
  NodeState,
  type Proposal,
  PROPOSAL_IDENTITY_PREFIX,
  type ProposalDecide,
} from "./contract.ts";
import { stateConflict } from "./control.ts";
import { unblockNode } from "./control-unblock.ts";
import { createNode } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import {
  listProposalsOfAssessment,
  markProposalApproved,
} from "./proposal-store.ts";
import { proposalRecord, requireAssessment } from "./proposal-read.ts";
import { revisionFromRow } from "./revision.ts";
import type { Dependencies } from "./service.ts";
import { insertDependency, intentOf, readCurrentRevision } from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const IDENTITY_SEPARATOR_LENGTH = 1;
const FILENAME_PREFIX = "proposal-";
const FILENAME_SUFFIX = ".md";
const TASK_FILENAME_SUFFIX = "-task.md";
const REASON_PREFIX = "Approve fix-node proposal ";
const NO_BINDINGS: string[] = [];
const NO_PROPOSALS = 0;

function filenameStem(proposalId: string): string {
  return `${FILENAME_PREFIX}${proposalId
    .slice(PROPOSAL_IDENTITY_PREFIX.length + IDENTITY_SEPARATOR_LENGTH)
    .toLowerCase()}`;
}

function decided(assessmentId: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.ProposalDecided,
    "Assessment has no open proposal.",
    { assessment_id: assessmentId },
  );
}

function isOpen(item: Proposal): boolean {
  return item.approved_at === null && item.rejected_at === null;
}

export function decideProposals(
  tx: Transaction,
  dependencies: Dependencies,
  assessmentId: string,
  body: ProposalDecide,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const assessment = requireAssessment(tx, assessmentId);
  const proposals = listProposalsOfAssessment(tx, assessment.id).map(
    proposalRecord,
  );
  const open = proposals.filter(isOpen);
  if (open.length === NO_PROPOSALS) decided(assessment.id);
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const mismatched = body.approved_proposal_ids.filter((id) => !byId.has(id));
  if (mismatched.length > NO_PROPOSALS)
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.ProposalAssessmentMismatch,
      "Proposal does not belong to the assessment.",
      { proposal_ids: mismatched },
    );
  const approved = body.approved_proposal_ids.map((id) => byId.get(id)!);
  if (!approved.every(isOpen)) decided(assessment.id);
  const proposer = requireNode(tx, open[0]!.node_id);
  assert.equal(intentOf(tx, proposer.id), Intent.Examine);
  requireActive(proposer);
  const mission = requireMission(
    tx,
    proposer.mission_id,
    body.expected_mission_version,
  );
  if (
    proposer.state !== NodeState.Blocked ||
    proposer.attempt !== assessment.attempt
  )
    stateConflict(proposer);
  const proposerRevision = readCurrentRevision(tx, proposer.id);
  assert.ok(proposerRevision);
  let missionVersion = mission.version;
  const created = approved.map((proposal) => {
    const source = requireNode(tx, proposal.content.dependency_id);
    requireActive(source);
    const sourceRow = readCurrentRevision(tx, source.id);
    assert.ok(sourceRow);
    const stem = filenameStem(proposal.id);
    const { task } = proposal.content;
    const sourceContent = revisionFromRow(tx, sourceRow).content;
    const change = createNode(
      tx,
      mission.id,
      {
        filename: `${stem}${FILENAME_SUFFIX}`,
        content: {
          name: proposal.content.name,
          requirement: proposal.content.requirement,
          criterion: proposal.content.criterion,
          verifications: task.verifications,
          bindings: sourceContent.bindings,
          intent: Intent.Implement,
          tags: sourceContent.tags,
        },
        tasks: [
          {
            filename: `${stem}${TASK_FILENAME_SUFFIX}`,
            content: { ...task, bindings: NO_BINDINGS },
          },
        ],
        reason: body.reason ?? `${REASON_PREFIX}${proposal.id}`,
        expected_mission_version: missionVersion,
      },
      actor,
      dependencies.bindings,
      dependencies.environments,
      dependencies.workQueue,
      dependencies.config.text_max_bytes,
    );
    missionVersion = change.mission_version;
    const createdId = change.revisions[0]?.node_id;
    assert.ok(createdId);
    insertDependency(tx, mission.id, proposer.id, createdId);
    markProposalApproved(tx, proposal.id, createdId, now);
    return {
      ...change,
      added_edges: [
        ...change.added_edges,
        { dependent_id: proposer.id, depends_on_id: createdId },
      ],
    };
  });
  const unblocked = unblockNode(
    tx,
    dependencies,
    proposer.id,
    {
      blocked_attempt: assessment.attempt,
      expected_revision: proposerRevision.revision,
      expected_mission_version: missionVersion,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    },
    actor,
    now,
    ends,
  );
  const approvedIds = new Set(body.approved_proposal_ids);
  return {
    result: {
      created,
      rejected_proposal_ids: open
        .map((proposal) => proposal.id)
        .filter((id) => !approvedIds.has(id)),
      proposer: unblocked.result,
    },
    act: unblocked.act,
  };
}

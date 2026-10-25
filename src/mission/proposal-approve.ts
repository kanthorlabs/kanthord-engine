import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NodeState,
  Intent,
  PROPOSAL_IDENTITY_PREFIX,
  type HumanActor,
  type ProposalApprove,
  type ExecutionEnds,
} from "./contract.ts";
import { stateConflict } from "./control.ts";
import { unblockNode } from "./control-unblock.ts";
import { createNode } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import { markProposalApproved } from "./proposal-store.ts";
import { proposalRecord, requireProposal } from "./proposal-read.ts";
import { revisionFromRow } from "./revision.ts";
import type { Dependencies } from "./service.ts";
import { insertDependency, readCurrentRevision, intentOf } from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const IDENTITY_SEPARATOR_LENGTH = 1;
const FILENAME_PREFIX = "proposal-";
const FILENAME_SUFFIX = ".md";
const TASK_FILENAME_SUFFIX = "-task.md";
const REASON_PREFIX = "Approve fix-node proposal ";
const NO_BINDINGS: string[] = [];
const NO_ATTEMPT = 0;

function filenameStem(proposalId: string): string {
  return `${FILENAME_PREFIX}${proposalId
    .slice(PROPOSAL_IDENTITY_PREFIX.length + IDENTITY_SEPARATOR_LENGTH)
    .toLowerCase()}`;
}

export function approveProposal(
  tx: Transaction,
  dependencies: Dependencies,
  proposalId: string,
  body: ProposalApprove,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const row = requireProposal(tx, proposalId);
  if (row.approved_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.ProposalAlreadyApproved,
      "Proposal is approved.",
      { proposal_id: row.id },
    );
  const proposal = proposalRecord(row);
  const proposer = requireNode(tx, proposal.node_id);
  assert.equal(intentOf(tx, proposer.id), Intent.Examine);
  requireActive(proposer);
  const mission = requireMission(
    tx,
    proposer.mission_id,
    body.expected_mission_version,
  );
  if (
    proposer.state !== NodeState.Blocked ||
    proposer.attempt !== proposal.attempt
  )
    stateConflict(proposer);
  const proposerRevision = readCurrentRevision(tx, proposer.id);
  assert.ok(proposerRevision);
  const source = requireNode(tx, proposal.content.dependency_id);
  requireActive(source);
  const sourceRow = readCurrentRevision(tx, source.id);
  assert.ok(sourceRow);
  const stem = filenameStem(proposal.id);
  const reason = body.reason ?? `${REASON_PREFIX}${proposal.id}`;
  const { task } = proposal.content;
  const sourceContent = revisionFromRow(tx, sourceRow).content;
  const created = createNode(
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
      reason,
      expected_mission_version: mission.version,
    },
    actor,
    dependencies.bindings,
    dependencies.environments,
    dependencies.workQueue,
    dependencies.config.text_max_bytes,
  );
  const createdId = created.revisions[0]?.node_id;
  assert.ok(createdId);
  insertDependency(tx, mission.id, proposer.id, createdId);
  const unblocked = unblockNode(
    tx,
    dependencies,
    proposer.id,
    {
      blocked_attempt: proposal.attempt,
      expected_revision: proposerRevision.revision,
      expected_mission_version: created.mission_version,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    },
    actor,
    now,
    ends,
  );
  markProposalApproved(tx, proposal.id, createdId, now);
  const createdNode = requireNode(tx, createdId);
  assert.ok(createdNode.state);
  return {
    result: {
      created: {
        ...created,
        added_edges: [
          ...created.added_edges,
          { dependent_id: proposer.id, depends_on_id: createdId },
        ],
      },
      proposer: unblocked.result,
    },
    act: {
      project_id: mission.project_id,
      node_id: createdId,
      attempt: createdNode.attempt ?? NO_ATTEMPT,
      acted_at: now,
      mission_version: requireMission(tx, mission.id).version,
      from: null,
      to: createdNode.state,
      reason: body.reason ?? null,
      revoked: null,
      evidence_id: null,
      lead_time_ms: null,
    },
  };
}

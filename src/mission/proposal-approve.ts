import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NodeKind,
  NodeState,
  PROPOSAL_IDENTITY_PREFIX,
  type HumanActor,
  type NodeChange,
  type ProposalApprove,
} from "./contract.ts";
import { stateConflict } from "./control.ts";
import { unblockNode } from "./control-unblock.ts";
import { createNode } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import { markProposalApproved } from "./proposal-store.ts";
import { proposalRecord, requireProposal } from "./proposal-read.ts";
import { revisionFromRow } from "./revision.ts";
import type { Dependencies } from "./service.ts";
import { readCurrentRevision } from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const FIRST_REVISION = 1;
const IDENTITY_SEPARATOR_LENGTH = 1;
const FILENAME_PREFIX = "proposal-";
const FILENAME_SUFFIX = ".md";
const TASK_FILENAME_SUFFIX = "-task.md";
const REASON_PREFIX = "Approve fix-objective proposal ";
const NO_BINDINGS: string[] = [];

function filenameStem(proposalId: string): string {
  return `${FILENAME_PREFIX}${proposalId
    .slice(PROPOSAL_IDENTITY_PREFIX.length + IDENTITY_SEPARATOR_LENGTH)
    .toLowerCase()}`;
}

function mergeChanges(objective: NodeChange, task: NodeChange): NodeChange {
  return {
    mission_version: task.mission_version,
    revisions: [...objective.revisions, ...task.revisions],
    retired_node_ids: [],
    added_edges: [...objective.added_edges, ...task.added_edges],
    removed_edges: [],
    open_attempts_unchanged: task.open_attempts_unchanged,
  };
}

export function approveProposal(
  tx: Transaction,
  dependencies: Dependencies,
  proposalId: string,
  body: ProposalApprove,
  actor: HumanActor,
  now: number,
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
  const initiative = requireNode(tx, proposal.node_id);
  assert.equal(initiative.kind, NodeKind.Initiative);
  requireActive(initiative);
  const mission = requireMission(
    tx,
    initiative.mission_id,
    body.expected_mission_version,
  );
  if (
    initiative.state !== NodeState.Blocked ||
    initiative.attempt !== proposal.attempt
  )
    stateConflict(initiative);
  const initiativeRevision = readCurrentRevision(tx, initiative.id);
  assert.ok(initiativeRevision);
  const source = requireNode(tx, proposal.content.objective_id);
  requireActive(source);
  const sourceRow = readCurrentRevision(tx, source.id);
  assert.ok(sourceRow);
  const stem = filenameStem(proposal.id);
  const reason = body.reason ?? `${REASON_PREFIX}${proposal.id}`;
  const { task } = proposal.content;
  const objective = createNode(
    tx,
    mission.id,
    {
      filename: `${stem}${FILENAME_SUFFIX}`,
      kind: NodeKind.Objective,
      content: {
        name: proposal.content.name,
        requirement: proposal.content.requirement,
        criterion: proposal.content.criterion,
        verifications: task.verifications,
        bindings: revisionFromRow(tx, sourceRow).content.bindings,
      },
      reason,
      expected_mission_version: mission.version,
      parent_id: initiative.id,
      expected_parent_revision: initiativeRevision.revision,
    },
    actor,
    dependencies.bindings,
    dependencies.workQueue,
    dependencies.config.text_max_bytes,
  );
  const objectiveId = objective.revisions[0]?.node_id;
  assert.ok(objectiveId);
  const taskChange = createNode(
    tx,
    mission.id,
    {
      filename: `${stem}${TASK_FILENAME_SUFFIX}`,
      kind: NodeKind.Task,
      content: { ...task, bindings: NO_BINDINGS },
      reason,
      expected_mission_version: objective.mission_version,
      parent_id: objectiveId,
      expected_parent_revision: FIRST_REVISION,
    },
    actor,
    dependencies.bindings,
    dependencies.workQueue,
    dependencies.config.text_max_bytes,
  );
  const unblocked = unblockNode(
    tx,
    dependencies,
    initiative.id,
    {
      blocked_attempt: proposal.attempt,
      expected_revision: initiativeRevision.revision,
      expected_mission_version: taskChange.mission_version,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    },
    actor,
    now,
  );
  markProposalApproved(tx, proposal.id, objectiveId, now);
  return {
    objective: mergeChanges(objective, taskChange),
    initiative: unblocked,
  };
}

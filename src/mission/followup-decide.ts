import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Acted, ActFacts } from "./act-telemetry.ts";
import {
  externalLinksSchema,
  followupContentSchema,
  type FollowupDecide,
  type FollowupProposal,
  type HumanActor,
  MissionErrorCode,
  NodeState,
  PROPOSAL_IDENTITY_PREFIX,
  type TaskContent,
} from "./contract.ts";
import { markThreadDone } from "./inbox-item.ts";
import { createNode } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import { followupRecord } from "./proposal-read.ts";
import {
  markFollowupRejected,
  markProposalApproved,
  type ProposalRow,
  readOpenFollowup,
} from "./proposal-store.ts";
import { revisionFromRow } from "./revision.ts";
import type { Dependencies } from "./service.ts";
import {
  insertDependency,
  readCurrentRevision,
  readRevision,
} from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const IDENTITY_SEPARATOR_LENGTH = 1;
const FILENAME_PREFIX = "followup-";
const FILENAME_SUFFIX = ".md";
const FIRST_TASK_NUMBER = 1;
const REASON_PREFIX = "Approve follow-up proposal ";
const NO_ATTEMPT = 0;

function filenameStem(proposalId: string): string {
  return `${FILENAME_PREFIX}${proposalId
    .slice(PROPOSAL_IDENTITY_PREFIX.length + IDENTITY_SEPARATOR_LENGTH)
    .toLowerCase()}`;
}

function decided(nodeId: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.ProposalDecided,
    "Node has no open follow-up proposal.",
    { node_id: nodeId },
  );
}

function taskWrites(tasks: TaskContent[], stem: string) {
  return tasks.map((task, index) => ({
    filename: `${stem}-${index + FIRST_TASK_NUMBER}${FILENAME_SUFFIX}`,
    content: task.content,
  }));
}

function approveFollowup(
  tx: Transaction,
  dependencies: Dependencies,
  missionId: string,
  origin: { id: string; state: NodeState },
  proposal: ProposalRow,
  body: FollowupDecide,
  actor: HumanActor,
  now: number,
): string {
  const row = readCurrentRevision(tx, origin.id);
  assert.ok(row, "A node has a revision.");
  const { content, tasks } = revisionFromRow(tx, row);
  const stem = filenameStem(proposal.id);
  const change = createNode(
    tx,
    missionId,
    {
      filename: `${stem}${FILENAME_SUFFIX}`,
      content: {
        ...content,
        requirement: body.requirement ?? content.requirement,
        criterion: body.criterion ?? content.criterion,
      },
      tasks: taskWrites(tasks, stem),
      reason: body.reason ?? `${REASON_PREFIX}${proposal.id}`,
      expected_mission_version: body.expected_mission_version,
    },
    actor,
    dependencies.bindings,
    dependencies.environments,
    dependencies.workQueue,
    dependencies.config.text_max_bytes,
  );
  const createdId = change.revisions[0]?.node_id;
  assert.ok(createdId);
  markProposalApproved(tx, proposal.id, createdId, now);
  if (origin.state === NodeState.Completed)
    insertDependency(tx, missionId, createdId, origin.id);
  return createdId;
}

function markFollowupThreadsDone(
  tx: Transaction,
  missionId: string,
  nodeId: string,
  proposal: ProposalRow,
  now: number,
): void {
  const { node_revision } = followupContentSchema.parse(
    JSON.parse(proposal.content),
  );
  const revision = readRevision(tx, nodeId, node_revision);
  assert.ok(revision, "A proposal names an existing revision.");
  for (const link of externalLinksSchema.parse(
    JSON.parse(revision.external_links),
  ))
    markThreadDone(tx, missionId, canonicalJSON(link), now);
}

export function decideFollowup(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: FollowupDecide,
  actor: HumanActor,
  now: number,
): Acted<FollowupProposal> {
  const node = requireNode(tx, nodeId);
  const proposal = readOpenFollowup(tx, node.id);
  if (proposal === null) decided(node.id);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expected_mission_version,
  );
  requireActive(node);
  assert.ok(node.state);
  const createdNodeId = body.approve
    ? approveFollowup(
        tx,
        dependencies,
        mission.id,
        { id: node.id, state: node.state },
        proposal,
        body,
        actor,
        now,
      )
    : null;
  if (createdNodeId === null) markFollowupRejected(tx, proposal.id, now);
  markFollowupThreadsDone(tx, node.mission_id, node.id, proposal, now);
  const settled = followupRecord({
    ...proposal,
    created_node_id: createdNodeId,
    approved_at: createdNodeId === null ? null : now,
    rejected_at: createdNodeId === null ? now : null,
  });
  const facts: ActFacts = {
    project_id: mission.project_id,
    node_id: node.id,
    attempt: node.attempt ?? NO_ATTEMPT,
    acted_at: now,
    mission_version: requireMission(tx, mission.id).version,
    from: node.state,
    to: node.state,
    reason: body.reason ?? null,
    revoked: null,
    evidence_id: null,
    lead_time_ms: null,
  };
  return {
    result: settled,
    act: facts,
  };
}

import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  NodeState,
  NodeKind,
  AssetKind,
  MissionBindingKind,
  type Override,
  type RepositoryAddress,
  type HumanAct,
  type HumanActor,
  type Mission,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { readRevision, type NodeRow } from "./store.ts";
import {
  closeAttempt,
  readLandedCommitEvidence,
  insertEvidence,
} from "./record-store.ts";
import {
  admitControl,
  requireNoUnresolvedAction,
  endLiveClaim,
  writeHumanRecords,
  transition,
  controlResult,
  actRevision,
} from "./control.ts";

const NO_ATTEMPT = 0;
const OVERRIDE_STATES = [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Blocked,
  NodeState.Paused,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
];
const BINDING_MISMATCH = "mission.evidence.binding_mismatch";

function landedEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  address: RepositoryAddress,
  reason: string,
  actor: HumanActor,
  now: number,
): string {
  const revision = readRevision(tx, node.id, actRevision(tx, node));
  assert.ok(revision && node.attempt !== null);
  const pins = z.array(z.string()).parse(JSON.parse(revision.bindings));
  const binding = dependencies.bindings.getBindingRevision(
    tx,
    address.binding_id,
  );
  if (
    node.kind !== NodeKind.Objective ||
    !pins.includes(address.binding_id) ||
    binding?.resource_identity.split(":")[0] !== MissionBindingKind.Repository
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      BINDING_MISMATCH,
      "Landed commit does not name the objective's pinned repository.",
      { binding_id: address.binding_id },
    );
  const id = createIdentity("evidence");
  insertEvidence(
    tx,
    {
      id,
      node_id: node.id,
      attempt: node.attempt,
      subject: reason,
      requirement_key: null,
      end_state: null,
      verification: null,
      provenance: canonicalJSON(actor),
      created_at: now,
    },
    [
      {
        id: createIdentity("evidence_asset"),
        evidence_id: id,
        kind: AssetKind.Repository,
        content: canonicalJSON({
          binding_id: address.binding_id,
          commit: address.commit,
        }),
        published_at: now,
        expired_at: null,
      },
    ],
  );
  return id;
}

export function overrideNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: Override,
  actor: HumanActor,
  now: number,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    OVERRIDE_STATES,
    now,
  );
  requireNoUnresolvedAction(tx, node);
  endLiveClaim(tx, dependencies, node, now);
  assert.ok(node.attempt !== null);
  const evidenceIds =
    node.attempt === NO_ATTEMPT
      ? []
      : readLandedCommitEvidence(tx, nodeId, node.attempt).map((row) => row.id);
  if (body.landed_commit !== undefined)
    evidenceIds.push(
      landedEvidence(
        tx,
        dependencies,
        node,
        body.landed_commit,
        body.reason,
        actor,
        now,
      ),
    );
  if (node.attempt > NO_ATTEMPT && node.state !== NodeState.Blocked)
    closeAttempt(tx, nodeId, node.attempt, now);
  const outcome = writeHumanRecords(
    tx,
    node,
    AssessmentResult.Success,
    body.reason,
    actor,
    evidenceIds,
    now,
  );
  transition(tx, dependencies, mission, node, NodeState.Completed, now);
  return controlResult(tx, dependencies, nodeId, outcome, actor, now);
}
const DISCARD_STATES = [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.Blocked,
  NodeState.Paused,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
];

function closeHuman(
  tx: Transaction,
  dependencies: Dependencies,
  mission: Mission,
  node: NodeRow,
  body: HumanAct,
  actor: HumanActor,
  state: NodeState,
  now: number,
) {
  assert.ok(node.attempt !== null);
  assert.ok(state === NodeState.Blocked || state === NodeState.Discarded);
  if (node.attempt > NO_ATTEMPT && node.state !== NodeState.Blocked)
    closeAttempt(tx, node.id, node.attempt, now);
  const evidenceIds =
    node.attempt === NO_ATTEMPT
      ? []
      : readLandedCommitEvidence(tx, node.id, node.attempt).map(
          (row) => row.id,
        );
  const outcome = writeHumanRecords(
    tx,
    node,
    AssessmentResult.Undetermined,
    body.reason,
    actor,
    evidenceIds,
    now,
  );
  transition(tx, dependencies, mission, node, state, now);
  return controlResult(tx, dependencies, node.id, outcome, actor, now);
}

export function blockNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    [NodeState.Paused],
    now,
  );
  return closeHuman(
    tx,
    dependencies,
    mission,
    node,
    body,
    actor,
    NodeState.Blocked,
    now,
  );
}

export function discardNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    DISCARD_STATES,
    now,
  );
  requireNoUnresolvedAction(tx, node);
  endLiveClaim(tx, dependencies, node, now);
  return closeHuman(
    tx,
    dependencies,
    mission,
    node,
    body,
    actor,
    NodeState.Discarded,
    now,
  );
}

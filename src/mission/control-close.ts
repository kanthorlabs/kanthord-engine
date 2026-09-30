import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  NodeState,
  type HumanAct,
  type HumanActor,
  type Mission,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import type { NodeRow } from "./store.ts";
import { closeAttempt, readLandedCommitEvidence } from "./record-store.ts";
import {
  admitControl,
  requireNoUnresolvedAction,
  endLiveClaim,
  writeHumanRecords,
  transition,
  controlResult,
} from "./control.ts";

const ZERO = 0;
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
  if (node.attempt > ZERO && node.state !== NodeState.Blocked)
    closeAttempt(tx, node.id, node.attempt, now);
  const evidenceIds =
    node.attempt === ZERO
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

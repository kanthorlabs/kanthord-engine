import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  NodeState,
  Resolution,
  ResumeTarget,
  type Resume,
  type HumanAct,
  RevokeCause,
  type HumanActor,
  type ExecutionEnds,
} from "./contract.ts";
import { readinessOf } from "./conditions.ts";
import { actionStatesOf } from "./frozen-action.ts";
import { openAttempt } from "./record-store.ts";
import { readCurrentRevision, readNode, type NodeRow } from "./store.ts";
import {
  admitControl,
  endLiveClaim,
  transition,
  controlResult,
  closeExternalAttempt,
  actedOn,
} from "./control.ts";
import type { Dependencies } from "./service.ts";

const NO_ATTEMPT = 0;
const NOT_READY = "mission.node.not_ready";

function requireReady(tx: Transaction, node: NodeRow): void {
  const readiness = readinessOf(tx, node);
  if (!readiness.holds)
    throw new OperationError(
      HttpStatus.Conflict,
      NOT_READY,
      "Node is not ready for evaluation.",
      { unsatisfied_ids: readiness.unsatisfied_ids },
    );
}

function openCurrentAttempt(
  tx: Transaction,
  nodeId: string,
  actor: HumanActor,
  now: number,
): void {
  const revision = readCurrentRevision(tx, nodeId);
  assert.ok(revision);
  openAttempt(tx, nodeId, revision.revision, actor, now);
}

export function readyNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    [NodeState.Available],
    now,
    ends,
  );
  requireReady(tx, node);
  if (node.attempt === NO_ATTEMPT) openCurrentAttempt(tx, nodeId, actor, now);
  transition(tx, dependencies, mission, node, NodeState.Waiting, now);
  return actedOn(
    tx,
    mission,
    node,
    body.reason,
    now,
    controlResult(tx, dependencies, nodeId, null, actor, now),
    null,
  );
}

export function resumeNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: Resume,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    [NodeState.Paused],
    now,
    ends,
  );
  assert.ok(node.attempt !== null);
  const actions =
    node.attempt === NO_ATTEMPT
      ? []
      : actionStatesOf(tx, dependencies.bindings, nodeId, node.attempt);
  let target: NodeState = body.target;
  if (actions.some((state) => state.resolution === Resolution.OtherEnd))
    target = NodeState.ExternalFailed;
  else if (actions.some((state) => state.request !== null))
    target = actions.every(
      (state) => state.resolution === Resolution.ExpectedEnd,
    )
      ? NodeState.ExternalSuccess
      : NodeState.ExternalRequested;
  else if (body.target === ResumeTarget.Waiting) {
    requireReady(tx, node);
    if (node.attempt === NO_ATTEMPT) openCurrentAttempt(tx, nodeId, actor, now);
  }
  transition(tx, dependencies, mission, node, target, now);
  const current = readNode(tx, nodeId);
  assert.ok(current);
  const outcome = closeExternalAttempt(tx, dependencies, current, now);
  return actedOn(
    tx,
    mission,
    node,
    body.reason,
    now,
    controlResult(tx, dependencies, nodeId, outcome, actor, now),
    null,
  );
}

const PAUSE_STATES = [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
];

export function pauseNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    PAUSE_STATES,
    now,
    ends,
  );
  const claim = endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
  );
  transition(tx, dependencies, mission, node, NodeState.Paused, now);
  return actedOn(
    tx,
    mission,
    node,
    body.reason,
    now,
    controlResult(tx, dependencies, nodeId, null, actor, now),
    claim?.execution.trace ?? null,
  );
}

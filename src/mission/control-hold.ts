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
  type HumanActor,
} from "./contract.ts";
import { readinessOf, closureUnsatisfied } from "./conditions.ts";
import { actionStatesOf } from "./frozen-action.ts";
import { openAttempt } from "./record-store.ts";
import { readCurrentRevision, readNode, type NodeRow } from "./store.ts";
import {
  admitControl,
  endLiveClaim,
  transition,
  controlResult,
  closeExternalAttempt,
} from "./control.ts";
import type { Dependencies } from "./service.ts";

const ZERO = 0;
const NOT_READY = "mission.node.not_ready";

function requireReady(
  tx: Transaction,
  node: NodeRow,
  checkClosure: boolean,
): void {
  const readiness = readinessOf(tx, node);
  const unsatisfiedIds = checkClosure ? closureUnsatisfied(tx, node) : [];
  if (!readiness.holds || unsatisfiedIds.length > ZERO)
    throw new OperationError(
      HttpStatus.Conflict,
      NOT_READY,
      "Node is not ready for evaluation.",
      {
        objectivesNotTerminal: readiness.objectivesNotTerminal,
        unresolvedActions: readiness.unresolvedActions,
        unsatisfiedIds,
      },
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
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    [NodeState.Available],
    now,
  );
  requireReady(tx, node, false);
  if (node.attempt === ZERO) openCurrentAttempt(tx, nodeId, actor, now);
  transition(tx, dependencies, mission, node, NodeState.Waiting, now);
  return controlResult(tx, dependencies, nodeId, null, actor, now);
}

export function resumeNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: Resume,
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
  assert.ok(node.attempt !== null);
  const actions =
    node.attempt === ZERO
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
    requireReady(tx, node, true);
    if (node.attempt === ZERO) openCurrentAttempt(tx, nodeId, actor, now);
  }
  transition(tx, dependencies, mission, node, target, now);
  const current = readNode(tx, nodeId);
  assert.ok(current);
  const outcome = closeExternalAttempt(tx, dependencies, current, now);
  return controlResult(tx, dependencies, nodeId, outcome, actor, now);
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
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    PAUSE_STATES,
    now,
  );
  endLiveClaim(tx, dependencies, node, now);
  transition(tx, dependencies, mission, node, NodeState.Paused, now);
  return controlResult(tx, dependencies, nodeId, null, actor, now);
}

import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  type ExecutionEnds,
  type HumanAct,
  type HumanActor,
  NodeState,
  Resolution,
  type Resume,
  ResumeTarget,
  RevokeCause,
} from "./contract.ts";
import { readinessOf } from "./conditions.ts";
import { actionStatesOf } from "./frozen-action.ts";
import { openAttempt } from "./record-store.ts";
import {
  type NodeRow,
  readClaimedNodes,
  readCurrentRevision,
  readNode,
} from "./store.ts";
import {
  actedOn,
  admitControl,
  closeExternalAttempt,
  controlResult,
  endLiveClaim,
  executionEnds,
  HUMAN_PAUSED_STOP,
  reportEnds,
  transition,
} from "./control.ts";
import type { ExecutionTrace } from "../tracking/contract.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";

const NO_ATTEMPT = 0;
const NOT_READY = "mission.node.not_ready";
const CLAIM_LIVE = "mission.node.claim_live";

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
  const claim = dependencies.schedulerClaims.liveExecutionOf(tx, nodeId, now);
  if (
    claim !== null &&
    dependencies.workerStopOrders.orderOf(claim.execution_id) !== null
  )
    throw new OperationError(
      HttpStatus.Conflict,
      CLAIM_LIVE,
      "The paused node keeps a live claim that waits for its stop.",
      { node_id: nodeId, execution_id: claim.execution_id },
    );
  endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
    null,
  );
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
  const live = dependencies.schedulerClaims.liveExecutionOf(tx, nodeId, now);
  if (
    live !== null &&
    dependencies.workerStopOrders.connected(tx, live.runtime_identity)
  ) {
    transition(tx, dependencies, mission, node, NodeState.Paused, now);
    return {
      ...actedOn(
        tx,
        mission,
        node,
        body.reason,
        now,
        controlResult(tx, dependencies, nodeId, null, actor, now),
        null,
      ),
      stopOrder: {
        execution_id: live.execution_id,
        runtime_identity: live.runtime_identity,
      },
    };
  }
  const claim = endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
    HUMAN_PAUSED_STOP,
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

function claimedNodeOf(
  tx: Transaction,
  dependencies: Dependencies,
  executionId: string,
  now: number,
): NodeRow | null {
  return (
    readClaimedNodes(tx).find(
      (node) =>
        dependencies.schedulerClaims.liveExecutionOf(tx, node.id, now)
          ?.execution_id === executionId,
    ) ?? null
  );
}

export function revokeForInstanceArchive(
  tx: Transaction,
  dependencies: Dependencies,
  executionId: string,
  instance: string,
  actor: HumanActor,
  now: number,
): ExecutionEnds | null {
  const node = claimedNodeOf(tx, dependencies, executionId, now);
  if (node === null) return null;
  const ends = executionEnds();
  const claim = endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
    {
      reason: "instance_archived",
      code: null,
      detail: canonicalJSON({ instance, actor: actor.name }),
    },
  );
  assert.ok(claim);
  if (node.state === NodeState.Paused) return ends;
  transition(
    tx,
    dependencies,
    requireMission(tx, node.mission_id),
    node,
    node.state === NodeState.Executing
      ? NodeState.Available
      : NodeState.Waiting,
    now,
  );
  return ends;
}

export function revokePausedClaim(
  dependencies: Dependencies,
  executionId: string,
  now: number,
): ExecutionTrace | null {
  const ends = executionEnds();
  dependencies.store.transaction((tx) => {
    const node = claimedNodeOf(tx, dependencies, executionId, now);
    if (node?.state !== NodeState.Paused) return;
    endLiveClaim(
      tx,
      dependencies,
      node,
      now,
      RevokeCause.Human,
      null,
      ends,
      HUMAN_PAUSED_STOP,
    );
  });
  reportEnds(dependencies, ends);
  return ends.revoked[0]?.execution.trace ?? null;
}

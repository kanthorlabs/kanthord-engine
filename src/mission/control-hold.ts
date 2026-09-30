import type { Transaction } from "../kernel/store.ts";
import { NodeState, type HumanAct, type HumanActor } from "./contract.ts";
import {
  admitControl,
  endLiveClaim,
  transition,
  controlResult,
} from "./control.ts";
import type { Dependencies } from "./service.ts";

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

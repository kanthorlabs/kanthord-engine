import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import { MissionErrorCode, type Mission } from "./contract.ts";
import { readMission, type NodeRow } from "./store.ts";

export function requireActive(node: NodeRow): void {
  if (node.retired_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Retired,
      "Node is retired.",
      { node_id: node.id },
    );
}

export function requireNonterminal(node: NodeRow): void {
  if (isTerminal(node.state))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Terminal,
      "Node is terminal.",
      { node_id: node.id },
    );
}

export function requireMission(
  tx: Transaction,
  missionId: string,
  expected?: number,
): Mission {
  const mission = readMission(tx, missionId);
  if (!mission)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.MissionNotFound,
      "Mission not found.",
    );
  if (expected !== undefined && mission.version !== expected)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.VersionConflict,
      "Mission version changed.",
      { current: mission.version },
    );
  return mission;
}

import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { MissionErrorCode, type Mission } from "./contract.ts";
import { readMission } from "./store.ts";

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

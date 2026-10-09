import type { ServiceClient } from "../kernel/operation.ts";
import type { missionOperations } from "../mission/contract.ts";
import type { schedulerOperations } from "../scheduler/contract.ts";
import type { workerOperations } from "./contract.ts";

export interface MethodClients {
  mission: Pick<
    ServiceClient<typeof missionOperations>,
    | "evidence.submit"
    | "assessment.submit"
    | "execution.pinnedRevision.get"
    | "execution.evidence.list"
    | "execution.evidence.asset.content.get"
    | "execution.objective.list"
    | "execution.objective.outcome.list"
    | "execution.objective.evidence.list"
    | "execution.clearedAssessment.get"
    | "execution.reworkAssessment.get"
  >;
  scheduler: Pick<
    ServiceClient<typeof schedulerOperations>,
    "executionRelease" | "claimGet"
  >;
  worker: Pick<ServiceClient<typeof workerOperations>, "action.request">;
}

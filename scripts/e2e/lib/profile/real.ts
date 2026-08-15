import type { ExecutionDriver } from "../driver/index.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { ScenarioProfile } from "./index.ts";

export async function createRealProfile(
  _context: ScenarioContext,
  driver: ExecutionDriver,
  input: Readonly<{
    origin: string;
    credentialArguments: readonly string[];
    defaultBranch: string;
    localPlanPath: string;
    expectedObjectiveCount: number;
    expectedTaskCount: number;
    expectedPendingTaskCount: number;
    expectedReadyTaskCount: number;
  }>,
): Promise<ScenarioProfile> {
  const planDirectory = await driver.deliverDirectory(
    "client",
    input.localPlanPath,
    "plan",
  );

  return {
    name: "real",
    origin: input.origin,
    credentialArguments: input.credentialArguments,
    defaultBranch: input.defaultBranch,
    planDirectory,
    expectedObjectiveCount: input.expectedObjectiveCount,
    expectedTaskCount: input.expectedTaskCount,
    expectedPendingTaskCount: input.expectedPendingTaskCount,
    expectedReadyTaskCount: input.expectedReadyTaskCount,
    fixtureRoot: null,
    expectedObjectIds: null,
  };
}

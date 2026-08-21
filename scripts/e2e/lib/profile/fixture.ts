import { createHttpRemote } from "../../../../test/helpers/remote/index.ts";
import { fixtureObjectIds } from "../../../../test/helpers/remote/seed.ts";
import {
  httpCredentials,
  httpWrongCredential,
} from "../../../../test/helpers/remote/http.ts";
import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import type { ExecutionDriver } from "../driver/index.ts";
import type { PodmanExecutor } from "../driver/podman.ts";
import type { Topology } from "../podman/topology.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { PlanAxis } from "../scenario/index.ts";
import type { ScenarioProfile } from "./index.ts";

const fixturePlanDeliveryName = "plan";
const fixtureDefaultBranch = "main";

export const fixtureRepositoryPath = "/fixture.git";

export type FixturePlanDefinition = Readonly<{
  planSource: string;
  fixtureRoot: string;
  expectedObjectiveCount: number;
  expectedTaskCount: number;
  expectedPendingTaskCount: number;
  expectedReadyTaskCount: number;
}>;

export const fixturePlanTable: Readonly<
  Record<PlanAxis, FixturePlanDefinition>
> = {
  "two-objective": {
    planSource: "test/e2e/fixtures/two-objective/plan",
    fixtureRoot: "test/e2e/fixtures/two-objective",
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 2,
  },
  "three-objective": {
    planSource: "test/e2e/fixtures/three-objective/plan",
    fixtureRoot: "test/e2e/fixtures/three-objective",
    expectedObjectiveCount: 3,
    expectedTaskCount: 5,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 3,
  },
};

export function fixturePlanSource(plan: PlanAxis): string {
  return fixturePlanTable[plan].planSource;
}

export function fixtureRepositoryUrl(origin: string): string {
  return `${origin}${fixtureRepositoryPath}`;
}

type PodmanTopology = Readonly<{
  topology: Readonly<{ fixtureOrigin: string }>;
}>;

type OriginSource = (
  context: ScenarioContext,
  driver: ExecutionDriver,
) => Promise<
  Readonly<{
    origin: string;
    username: string;
    token: string;
    wrongToken: string;
  }>
>;

const originSources: Readonly<Record<string, OriginSource>> = {
  local: async (context) => {
    const remote = await createHttpRemote();
    context.take({
      kind: "directory",
      id: "fixture-remote",
      release: remote.dispose,
    });
    return {
      origin: fixtureRepositoryUrl(remote.origin),
      username: remote.credentials.writer.username,
      token: remote.credentials.writer.token,
      wrongToken: remote.wrongCredential.token,
    };
  },
  podman: async (_context, driver) => {
    const { topology } = driver as unknown as PodmanTopology;
    return {
      origin: fixtureRepositoryUrl(topology.fixtureOrigin),
      username: httpCredentials.writer.username,
      token: httpCredentials.writer.token,
      wrongToken: httpWrongCredential.token,
    };
  },
};

export function fixtureCredentialArguments(
  username: string,
  tokenFile: string,
): readonly string[] {
  return [
    "--name",
    "fixture",
    "--kind",
    "git",
    "--transport",
    "http-basic",
    "--forge",
    "github",
    "--username",
    username,
    "--input-token-file",
    tokenFile,
  ];
}

export async function createFixtureProfile(
  context: ScenarioContext,
  driver: ExecutionDriver,
  plan: PlanAxis,
): Promise<ScenarioProfile> {
  const planDefinition = fixturePlanTable[plan];
  const resolveOrigin = originSources[driver.name];
  if (resolveOrigin === undefined) {
    throw new Error(
      `createFixtureProfile has no origin source for driver ${driver.name}`,
    );
  }

  const { origin, username, token, wrongToken } = await resolveOrigin(
    context,
    driver,
  );
  secrets.hold(token);
  const tokenFile = await driver.deliverToken(token);

  const probeRows = await driver.probeOrigin({
    origin,
    username,
    tokenPath: tokenFile,
    wrongToken,
    defaultBranch: fixtureDefaultBranch,
  });

  for (const row of probeRows) {
    try {
      context.assert(row.name, true, row.passed);
    } catch {
      throw new RunnerError("unavailable", `fixture row ${row.name} failed`);
    }
  }

  const planDirectory = await driver.deliverDirectory(
    "client",
    planDefinition.planSource,
    fixturePlanDeliveryName,
  );

  return {
    name: "fixture",
    origin,
    credentialArguments: fixtureCredentialArguments(username, tokenFile),
    defaultBranch: fixtureDefaultBranch,
    planDirectory,
    expectedObjectiveCount: planDefinition.expectedObjectiveCount,
    expectedTaskCount: planDefinition.expectedTaskCount,
    expectedPendingTaskCount: planDefinition.expectedPendingTaskCount,
    expectedReadyTaskCount: planDefinition.expectedReadyTaskCount,
    fixtureRoot: planDefinition.fixtureRoot,
    expectedObjectIds: fixtureObjectIds,
  };
}

const daemonFixtureTokenPath = "/opt/e2e/tokens/fixture-http";

async function deliverDaemonFixtureToken(
  execute: PodmanExecutor,
  topology: Topology,
  token: string,
): Promise<string> {
  await execute([
    "podman",
    "exec",
    topology.daemonContainer,
    "mkdir",
    "-p",
    "/opt/e2e/tokens",
  ]);
  await execute([
    "podman",
    "exec",
    topology.daemonContainer,
    "install",
    "-m",
    "600",
    "/dev/null",
    daemonFixtureTokenPath,
  ]);
  await execute(
    [
      "podman",
      "exec",
      "--interactive",
      topology.daemonContainer,
      "sh",
      "-c",
      `cat > ${daemonFixtureTokenPath}`,
    ],
    token,
  );
  return daemonFixtureTokenPath;
}

export async function createPodmanFixtureProfile(
  context: ScenarioContext,
  execute: PodmanExecutor,
  topology: Topology,
  driver: ExecutionDriver,
  plan: PlanAxis,
): Promise<ScenarioProfile> {
  const planDefinition = fixturePlanTable[plan];
  const token = httpCredentials.writer.token;
  secrets.hold(token);

  const tokenFile = await driver.deliverToken(token);
  const daemonTokenPath = await deliverDaemonFixtureToken(
    execute,
    topology,
    token,
  );

  const probeRows = await driver.probeOrigin({
    origin: fixtureRepositoryUrl(topology.fixtureOrigin),
    username: httpCredentials.writer.username,
    tokenPath: daemonTokenPath,
    wrongToken: httpWrongCredential.token,
    defaultBranch: fixtureDefaultBranch,
  });
  for (const row of probeRows) {
    try {
      context.assert(row.name, true, row.passed);
    } catch {
      throw new RunnerError("unavailable", `fixture row ${row.name} failed`);
    }
  }

  const planDirectory = await driver.deliverDirectory(
    "client",
    planDefinition.planSource,
    fixturePlanDeliveryName,
  );

  return {
    name: "fixture",
    origin: fixtureRepositoryUrl(topology.fixtureOrigin),
    credentialArguments: fixtureCredentialArguments(
      httpCredentials.writer.username,
      tokenFile,
    ),
    defaultBranch: fixtureDefaultBranch,
    planDirectory,
    expectedObjectiveCount: planDefinition.expectedObjectiveCount,
    expectedTaskCount: planDefinition.expectedTaskCount,
    expectedPendingTaskCount: planDefinition.expectedPendingTaskCount,
    expectedReadyTaskCount: planDefinition.expectedReadyTaskCount,
    fixtureRoot: planDefinition.fixtureRoot,
    expectedObjectIds: fixtureObjectIds,
  };
}

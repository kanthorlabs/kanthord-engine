import { createHttpRemote } from "../../../../test/helpers/remote/index.ts";
import { fixtureObjectIds } from "../../../../test/helpers/remote/seed.ts";
import {
  httpCredentials,
  httpWrongCredential,
} from "../../../../test/helpers/remote/http.ts";
import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import type { ExecutionDriver } from "../driver/index.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { ScenarioProfile } from "./index.ts";

const fixturePlanSource = "test/e2e/fixtures/two-objective/plan";
const fixturePlanDeliveryName = "plan";
const fixtureRootPath = "test/e2e/fixtures/two-objective";
const fixtureDefaultBranch = "main";

export const fixtureRepositoryPath = "/fixture.git";

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
    "--token-file",
    tokenFile,
  ];
}

export async function createFixtureProfile(
  context: ScenarioContext,
  driver: ExecutionDriver,
): Promise<ScenarioProfile> {
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
    fixturePlanSource,
    fixturePlanDeliveryName,
  );

  return {
    name: "fixture",
    origin,
    credentialArguments: fixtureCredentialArguments(username, tokenFile),
    defaultBranch: fixtureDefaultBranch,
    planDirectory,
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 2,
    fixtureRoot: fixtureRootPath,
    expectedObjectIds: fixtureObjectIds,
  };
}

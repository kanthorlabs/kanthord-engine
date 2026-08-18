import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { fixtureObjectIds } from "../../../../test/helpers/remote/seed.ts";
import { httpCredentials } from "../../../../test/helpers/remote/http.ts";
import type { DaemonConfig, ExecutionDriver } from "../driver/index.ts";
import { createPodmanDriver, type PodmanExecutor } from "../driver/podman.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import { RunnerError } from "../errors.ts";
import { assertPodman } from "../podman/preflight.ts";
import { reclaimByLabel } from "../podman/reclaim.ts";
import { provisionImages } from "../podman/provision.ts";
import { takeImage, takeTemporaryDirectory } from "../resources.ts";
import {
  createTopology,
  daemonHomeMountPath,
  planTopology,
  type Topology,
} from "../podman/topology.ts";
import {
  fixtureCredentialArguments,
  fixturePlanSource,
  fixturePlanTable,
  fixtureRepositoryUrl,
} from "../profile/fixture.ts";
import { writeSecretFile } from "../secret-file.ts";
import { assertNoDisclosure } from "../disclosure.ts";
import { runCommand } from "../command.ts";
import type { BundleIdentity, BundleVersions } from "../bundle.ts";
import type { PlanAxis, ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import { runJourney } from "./journey.ts";
import { runTransportCases } from "./transport.ts";
import { resolveTools } from "./tools.ts";

export type WithDisclosureFailure = Error & { disclosureFailure?: Error };

type P1E4Context = ScenarioContext & {
  noteHost(name: string, identity: BundleIdentity): void;
  note(key: string, value: string): void;
  setVersions(partial: Partial<BundleVersions>): void;
};

const localAllowedHost = "127.0.0.1:7421";
const fixturePlanDeliveryName = "plan";
const p1e4Plan: PlanAxis = "two-objective";

async function resolveFixtureCredentialArguments(
  driver: ExecutionDriver,
  credentialArguments: readonly string[],
): Promise<readonly string[]> {
  const usernameIndex = credentialArguments.indexOf("--username");
  const tokenFileIndex = credentialArguments.indexOf("--token-file");
  if (
    usernameIndex === -1 ||
    tokenFileIndex === -1 ||
    credentialArguments[usernameIndex + 1] !== "" ||
    credentialArguments[tokenFileIndex + 1] !== ""
  ) {
    return credentialArguments;
  }

  const tokenFile = await driver.deliverToken(httpCredentials.writer.token);
  const resolved = [...credentialArguments];
  resolved[usernameIndex + 1] = httpCredentials.writer.username;
  resolved[tokenFileIndex + 1] = tokenFile;
  return resolved;
}

async function resolveFixturePlanDirectory(
  driver: ExecutionDriver,
  planDirectory: string,
  plan: PlanAxis,
): Promise<string> {
  const planSource = fixturePlanSource(plan);
  if (planDirectory !== planSource) {
    return planDirectory;
  }

  return driver.deliverDirectory("client", planSource, fixturePlanDeliveryName);
}

export async function runP1E4(
  context: ScenarioContext,
  execute: PodmanExecutor,
  executeHost: PodmanExecutor,
  profile: ScenarioProfile,
): Promise<void> {
  const p1e4Context = context as P1E4Context;

  // Phase 1: preflight
  const facts = await assertPodman(execute);

  // Phase 2: reclaim, before anything is created
  const reclaimReport = await reclaimByLabel(execute, context.tag);
  const [survivor] = reclaimReport.failed;
  if (survivor !== undefined) {
    throw new RunnerError(
      "assertion-failed",
      `a stale resource survived reclaim: ${survivor.kind} ${survivor.id}`,
    );
  }

  // Phase 3: provision
  const provision = await provisionImages(execute, executeHost, context.tag);
  takeImage(context, execute, provision.images.product);
  takeImage(context, execute, provision.images.fixture);

  // Phase 4: topology
  const topology = planTopology(context.tag);
  const secretsDirectory = await takeTemporaryDirectory(
    context,
    "kanthord-e2e-p1e4-secrets-",
  );
  const runToken = randomBytes(16).toString("hex");
  const masterKey = randomBytes(32).toString("base64");
  const tokenFile = await writeSecretFile(
    context,
    join(secretsDirectory, "token"),
    runToken,
  );
  const masterKeyFile = await writeSecretFile(
    context,
    join(secretsDirectory, "master-key"),
    masterKey,
  );
  await createTopology(context, execute, provision.images, topology, {
    tokenFile,
    masterKeyFile,
  });

  const driver = await createPodmanDriver(context, {
    execute,
    images: provision.images,
    topology,
    architecture: facts.architecture,
  });

  try {
    // Phase 5: identity and versions
    p1e4Context.noteHost("daemon", await driver.identity("daemon"));
    p1e4Context.noteHost("client", await driver.identity("client"));
    p1e4Context.setVersions({ podman: facts.version });
    p1e4Context.note("productDigest", provision.productDigest);
    p1e4Context.note("baseDigest", provision.baseDigest);
    p1e4Context.note("imageId", provision.images.product);
    p1e4Context.note("architecture", provision.architecture);
    p1e4Context.note("podmanRootless", String(facts.rootless));

    const baseConfig = {
      home: daemonHomeMountPath,
      actor: "e2e-p1-e4",
      masterKey,
      tools: resolveTools(),
      attemptLimit: 3,
      leaseTtlMs: 300000,
    };

    // Phase 6: the startup refusal, across the boundary
    const refusalConfig: DaemonConfig = {
      ...baseConfig,
      http: {
        bind: "0.0.0.0",
        port: topology.daemonPort,
        token: "",
        allowedHosts: [localAllowedHost],
      },
    };
    const refusal = await driver.startDaemonExpectingRefusal(refusalConfig);
    context.assert("startup-refusal-exit", 1, refusal.exitCode);
    context.assert(
      "startup-refusal-message",
      "kanthord: config-refused: a non-loopback bind address requires http.token\n",
      refusal.stderr,
    );

    // Phase 7: the load-bearing allow list — omitting the alias
    const localConfig: DaemonConfig = {
      ...baseConfig,
      http: {
        bind: "0.0.0.0",
        port: topology.daemonPort,
        token: runToken,
        allowedHosts: [localAllowedHost],
      },
    };
    const localHandle = await driver.startDaemon(localConfig);
    const aliasResponse = await driver.issue({
      method: "GET",
      path: "/v1/status",
      headers: {
        Authorization: `Bearer ${runToken}`,
        Host: topology.allowedHost,
      },
      omitHost: false,
    });
    context.assert("alias-omitted-status", 403, aliasResponse.status);
    const aliasBody = JSON.parse(aliasResponse.body) as Readonly<{
      error?: Readonly<{ code?: string }>;
    }>;
    context.assert(
      "alias-omitted-code",
      "host-forbidden",
      aliasBody.error?.code ?? null,
    );
    await localHandle.stop();
    await execute([
      "podman",
      "exec",
      topology.daemonContainer,
      "rm",
      "-f",
      join(daemonHomeMountPath, "kanthord.config.json"),
    ]);

    // Phase 8: the journey
    const credentialArguments = await resolveFixtureCredentialArguments(
      driver,
      profile.credentialArguments,
    );
    const planDirectory = await resolveFixturePlanDirectory(
      driver,
      profile.planDirectory,
      p1e4Plan,
    );
    const journey = await runJourney(context, driver, {
      ...profile,
      credentialArguments,
      planDirectory,
    });

    // Phase 9: the transport oracle, against the running daemon
    await runTransportCases(
      context,
      { allowedHost: topology.allowedHost, token: journey.token },
      driver.issue,
    );

    // Phase 10: logs
    const logs = await driver.collectLogs();
    for (const [name, text] of Object.entries(logs)) {
      context.attachLog?.(name, text);
    }
  } catch (error) {
    // Phase 11: disclosure, even when phases 5-10 failed mid-run
    try {
      await assertNoDisclosure(context, execute, topology);
    } catch (disclosureError) {
      (error as WithDisclosureFailure).disclosureFailure =
        disclosureError as Error;
    }
    throw error;
  }

  // Phase 11: disclosure, on the success path
  await assertNoDisclosure(context, execute, topology);
}

function createHostExecutor(context: ScenarioContext): PodmanExecutor {
  return async (argv, stdin, cwd) =>
    runCommand(context.sink, {
      argv: [...argv],
      stdin,
      cwd,
      env: { PATH: process.env.PATH ?? "" },
    });
}

async function buildRealProfile(
  topology: Topology,
  plan: PlanAxis,
): Promise<ScenarioProfile> {
  const planDefinition = fixturePlanTable[plan];
  return {
    name: "fixture",
    origin: fixtureRepositoryUrl(topology.fixtureOrigin),
    credentialArguments: fixtureCredentialArguments("", ""),
    defaultBranch: "main",
    planDirectory: planDefinition.planSource,
    expectedObjectiveCount: planDefinition.expectedObjectiveCount,
    expectedTaskCount: planDefinition.expectedTaskCount,
    expectedPendingTaskCount: planDefinition.expectedPendingTaskCount,
    expectedReadyTaskCount: planDefinition.expectedReadyTaskCount,
    fixtureRoot: planDefinition.fixtureRoot,
    expectedObjectIds: fixtureObjectIds,
  };
}

async function run(context: ScenarioContext): Promise<void> {
  const topology = planTopology(context.tag);
  const execute = createHostExecutor(context);
  const executeHost = createHostExecutor(context);
  const profile = await buildRealProfile(topology, p1e4Plan);
  await runP1E4(context, execute, executeHost, profile);
}

export const p1e4: ScenarioDeclaration = {
  id: "P1-E4",
  mode: "deterministic",
  driver: "podman",
  profile: "fixture",
  plan: p1e4Plan,
  run,
};

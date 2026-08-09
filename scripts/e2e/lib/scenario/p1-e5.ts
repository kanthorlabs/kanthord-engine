import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import { removeTree } from "../resources.ts";
import { createRealProfile } from "../profile/real.ts";
import { createLocalDriver } from "../driver/local.ts";
import { runCommand } from "../command.ts";
import type { ExecutionDriver } from "../driver/index.ts";
import type { ReadRemoteRefs } from "../remote-refs.ts";
import type { ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import { runJourney } from "./journey.ts";
import {
  loadE2eEnv,
  loadE2eFileValues,
  E2eEnvError,
  type E2eEnv,
} from "../../env.ts";
import { runRemoteRefs } from "../remote-refs.ts";

const requiredEnvVars = [
  "KANTHORD_E2E_REAL_PLAN",
  "KANTHORD_E2E_REAL_OBJECTIVES",
  "KANTHORD_E2E_REAL_TASKS",
] as const;

function isPositiveInteger(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d*$/.test(value);
}

export type RealInputs = Readonly<{
  origin: string;
  defaultBranch: string;
  token: string;
  planPath: string;
  expectedObjectiveCount: number;
  expectedTaskCount: number;
}>;

export async function checkPrerequisites(
  context: ScenarioContext,
  env: Readonly<Record<string, string | undefined>>,
  loadEnv: typeof loadE2eEnv = loadE2eEnv,
): Promise<RealInputs> {
  if (context.daemonHost !== null || context.clientHost !== null) {
    throw new RunnerError(
      "invalid-argument",
      "P1-E5 runs on one machine and takes no host option",
    );
  }

  const resolved: Record<string, string | undefined> = {};
  for (const name of requiredEnvVars) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new RunnerError(
        "unavailable",
        `P1-E5 needs ${name}, in the environment or in .env.e2e`,
      );
    }
    resolved[name] = value;
  }

  if (!isPositiveInteger(resolved.KANTHORD_E2E_REAL_OBJECTIVES)) {
    throw new RunnerError(
      "unavailable",
      "P1-E5 needs KANTHORD_E2E_REAL_OBJECTIVES to be a positive integer",
    );
  }
  if (!isPositiveInteger(resolved.KANTHORD_E2E_REAL_TASKS)) {
    throw new RunnerError(
      "unavailable",
      "P1-E5 needs KANTHORD_E2E_REAL_TASKS to be a positive integer",
    );
  }

  let e2eEnv: E2eEnv;
  try {
    e2eEnv = loadEnv({ runId: context.tag });
  } catch (error) {
    if (error instanceof E2eEnvError) {
      throw new RunnerError(
        "unavailable",
        `P1-E5 needs ${error.missing.join(", ")} in .env.e2e`,
      );
    }
    throw error;
  }

  return {
    origin: `https://github.com/${e2eEnv.ghRepo}.git`,
    defaultBranch: e2eEnv.ghBaseBranch,
    token: e2eEnv.ghToken,
    planPath: resolved.KANTHORD_E2E_REAL_PLAN as string,
    expectedObjectiveCount: Number.parseInt(
      resolved.KANTHORD_E2E_REAL_OBJECTIVES as string,
      10,
    ),
    expectedTaskCount: Number.parseInt(
      resolved.KANTHORD_E2E_REAL_TASKS as string,
      10,
    ),
  };
}

export async function runP1E5(
  context: ScenarioContext,
  driver: ExecutionDriver,
  inputs: RealInputs,
  readRemoteRefs: ReadRemoteRefs = createShellRemoteRefs(context),
): Promise<void> {
  secrets.hold(inputs.token);
  const deliveredTokenPath = await driver.deliverToken(inputs.token);
  context.take({
    kind: "file",
    id: deliveredTokenPath,
    async release(): Promise<void> {
      await removeTree(deliveredTokenPath);
    },
  });
  const remoteRefsInput = {
    origin: inputs.origin,
    username: "x-access-token",
    tokenPath: deliveredTokenPath,
  };
  const before = await readRemoteRefs(remoteRefsInput);

  const profile = await createRealProfile(context, driver, {
    origin: inputs.origin,
    credentialArguments: [
      "--name",
      "real",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--token-file",
      deliveredTokenPath,
    ],
    defaultBranch: inputs.defaultBranch,
    localPlanPath: inputs.planPath,
    expectedObjectiveCount: inputs.expectedObjectiveCount,
    expectedTaskCount: inputs.expectedTaskCount,
  });

  await runJourney(context, driver, profile);
  const after = await readRemoteRefs(remoteRefsInput);
  context.assert("forge-unchanged", before, after);
}

function createShellRemoteRefs(context: ScenarioContext): ReadRemoteRefs {
  return (input) =>
    runRemoteRefs(
      (script) =>
        runCommand(context.sink, {
          argv: ["/bin/sh", "-c", script],
          env: { PATH: process.env.PATH ?? "" },
        }),
      input,
    );
}

function secretsDisclosed(text: string): boolean {
  return secrets.forms().some((form) => text.includes(form));
}

async function run(context: ScenarioContext): Promise<void> {
  const inputs = await checkPrerequisites(context, {
    ...loadE2eFileValues(),
    ...process.env,
  });
  const driver = await createLocalDriver(context);

  await runP1E5(context, driver, inputs);

  const logs = await driver.collectLogs();
  const commandsText = (context.commandsRecorded?.() ?? [])
    .map((command) => command.argv.join(" "))
    .join("\n");
  const daemonLogsText = Object.values(logs).join("\n");

  context.assert(
    "no-disclosure-bearer-header",
    false,
    secretsDisclosed(commandsText),
  );
  context.assert("no-disclosure-config", false, secretsDisclosed(commandsText));
  context.assert(
    "no-disclosure-printed-commands",
    false,
    secretsDisclosed(commandsText),
  );
  context.assert(
    "no-disclosure-daemon-logs",
    false,
    secretsDisclosed(daemonLogsText),
  );
}

export const p1e5: ScenarioDeclaration = {
  id: "P1-E5",
  mode: "integration",
  driver: "local",
  profile: "real",
  run,
};

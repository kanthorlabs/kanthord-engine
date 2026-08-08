import { readFile } from "node:fs/promises";

import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import { runCommand } from "../command.ts";
import { createRealProfile } from "../profile/real.ts";
import { createSshDriver, type SshExecutor } from "../driver/ssh.ts";
import type { ExecutionDriver } from "../driver/index.ts";
import type { ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import { runJourney } from "./journey.ts";

const requiredEnvVars = [
  "KANTHORD_E2E_REAL_ORIGIN",
  "KANTHORD_E2E_REAL_BRANCH",
  "KANTHORD_E2E_REAL_TOKEN_FILE",
  "KANTHORD_E2E_REAL_PLAN",
  "KANTHORD_E2E_REAL_OBJECTIVES",
  "KANTHORD_E2E_REAL_TASKS",
] as const;

function isPositiveInteger(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d*$/.test(value);
}

function sshArgv(host: string, argv: readonly string[]): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    host,
    "--",
    ...argv,
  ];
}

export async function checkPrerequisites(
  context: ScenarioContext,
  execute: SshExecutor,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const { daemonHost, clientHost } = context;

  if (daemonHost === null) {
    throw new RunnerError("unavailable", "P1-E3 needs --daemon-host");
  }
  if (clientHost === null) {
    throw new RunnerError("unavailable", "P1-E3 needs --client-host");
  }

  for (const name of requiredEnvVars) {
    if (env[name] === undefined) {
      throw new RunnerError("unavailable", `P1-E3 needs ${name}`);
    }
  }

  if (!isPositiveInteger(env.KANTHORD_E2E_REAL_OBJECTIVES)) {
    throw new RunnerError(
      "unavailable",
      "P1-E3 needs KANTHORD_E2E_REAL_OBJECTIVES to be a positive integer",
    );
  }
  if (!isPositiveInteger(env.KANTHORD_E2E_REAL_TASKS)) {
    throw new RunnerError(
      "unavailable",
      "P1-E3 needs KANTHORD_E2E_REAL_TASKS to be a positive integer",
    );
  }

  const daemonPing = await execute(
    { role: "daemon", host: daemonHost },
    sshArgv(daemonHost, ["true"]),
  );
  if (daemonPing.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `P1-E3 cannot reach the daemon host ${daemonHost}`,
    );
  }

  const clientPing = await execute(
    { role: "client", host: clientHost },
    sshArgv(clientHost, ["true"]),
  );
  if (clientPing.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `P1-E3 cannot reach the client host ${clientHost}`,
    );
  }
}

export async function runP1E3(
  context: ScenarioContext,
  driver: ExecutionDriver,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const origin = env.KANTHORD_E2E_REAL_ORIGIN as string;
  const branch = env.KANTHORD_E2E_REAL_BRANCH as string;
  const tokenFile = env.KANTHORD_E2E_REAL_TOKEN_FILE as string;
  const localPlanPath = env.KANTHORD_E2E_REAL_PLAN as string;
  const expectedObjectiveCount = Number.parseInt(
    env.KANTHORD_E2E_REAL_OBJECTIVES as string,
    10,
  );
  const expectedTaskCount = Number.parseInt(
    env.KANTHORD_E2E_REAL_TASKS as string,
    10,
  );

  const tokenValue = (await readFile(tokenFile, "utf8")).trim();
  secrets.hold(tokenValue);
  const deliveredTokenPath = await driver.deliverToken(tokenValue);

  const profile = await createRealProfile(context, driver, {
    origin,
    credentialArguments: [
      "--name",
      "real",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--username",
      "",
      "--token-file",
      deliveredTokenPath,
    ],
    defaultBranch: branch,
    localPlanPath,
    expectedObjectiveCount,
    expectedTaskCount,
  });

  await runJourney(context, driver, profile);
}

function secretsDisclosed(text: string): boolean {
  return secrets.forms().some((form) => text.includes(form));
}

async function run(context: ScenarioContext): Promise<void> {
  const captured: { argv: readonly string[] }[] = [];

  const execute: SshExecutor = async (_target, argv, stdin) => {
    captured.push({ argv });
    return runCommand(context.sink, { argv: [...argv], stdin });
  };

  await checkPrerequisites(context, execute, process.env);

  const driver = await createSshDriver(context, {
    daemonHost: context.daemonHost as string,
    clientHost: context.clientHost as string,
    execute,
  });

  await runP1E3(context, driver, process.env);

  const logs = await driver.collectLogs();
  const commandsText = captured
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

export const p1e3: ScenarioDeclaration = {
  id: "P1-E3",
  mode: "deployment",
  driver: "ssh",
  profile: "real",
  run,
};

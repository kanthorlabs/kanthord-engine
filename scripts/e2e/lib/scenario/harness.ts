import type { ExecutionDriver, HostRole } from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";

export type HarnessIdentity = Readonly<{
  actorId: string;
  tokenFile: string;
  role: HostRole;
}>;

export type HarnessTaskResult = Readonly<{
  fence: number;
  runId: string;
  attemptNo: number;
  objectId: string;
}>;

function parseClaim(stdout: string): Readonly<{
  fence: number;
  runId: string;
  attemptNo: number;
}> {
  const lease =
    /^kanthord: claimed \S+ fence ([1-9][0-9]*) expires \S+ heartbeat [0-9]+ms$/m.exec(
      stdout,
    );
  const run =
    /^kanthord: run (\S+) attempt ([1-9][0-9]*) objective-run \S+ objective-fence [1-9][0-9]*$/m.exec(
      stdout,
    );
  const fenceText = lease?.[1];
  const runId = run?.[1];
  const attemptText = run?.[2];
  if (
    fenceText === undefined ||
    runId === undefined ||
    attemptText === undefined
  ) {
    throw new Error("kanthord: unable to parse node claim output");
  }

  const fence = Number(fenceText);
  const attemptNo = Number(attemptText);
  if (!Number.isSafeInteger(fence) || !Number.isSafeInteger(attemptNo)) {
    throw new Error("kanthord: node claim output contains an unsafe number");
  }

  return { fence, runId, attemptNo };
}

function withToken(identity: HarnessIdentity): Readonly<{ tokenFile: string }> {
  return { tokenFile: identity.tokenFile };
}

export async function registerHarness(
  driver: ExecutionDriver,
  role: HostRole,
  name: string,
): Promise<HarnessIdentity> {
  const registration = await driver.registerActor(role, name);
  return {
    actorId: registration.actorId,
    tokenFile: registration.tokenFile,
    role,
  };
}

export async function runHarnessTask(
  context: ScenarioContext,
  driver: ExecutionDriver,
  identity: HarnessIdentity,
  input: Readonly<{ nodeId: string; objectId: string; label: string }>,
): Promise<HarnessTaskResult> {
  const claim = await driver.cliAs(
    identity.role,
    ["node", "claim", "--id", input.nodeId],
    withToken(identity),
  );
  context.assert(`${input.label}-claim-status`, 0, claim.exitCode);
  const parsed = parseClaim(claim.stdout);
  context.assert(`${input.label}-claim-attempt`, 1, parsed.attemptNo);

  const heartbeat = await driver.cliAs(
    identity.role,
    [
      "node",
      "heartbeat",
      "--id",
      input.nodeId,
      "--fence",
      String(parsed.fence),
    ],
    withToken(identity),
  );
  context.assert(`${input.label}-heartbeat-status`, 0, heartbeat.exitCode);

  const report = await driver.cliAs(
    identity.role,
    [
      "node",
      "report",
      "--id",
      input.nodeId,
      "--outcome",
      "accepted",
      "--object-id",
      input.objectId,
      "--fence",
      String(parsed.fence),
    ],
    withToken(identity),
  );
  context.assert(`${input.label}-report-status`, 0, report.exitCode);

  return {
    fence: parsed.fence,
    runId: parsed.runId,
    attemptNo: parsed.attemptNo,
    objectId: input.objectId,
  };
}

export async function attestObjective(
  context: ScenarioContext,
  driver: ExecutionDriver,
  identity: HarnessIdentity,
  input: Readonly<{
    nodeId: string;
    fence: number;
    objectId: string;
    label: string;
  }>,
): Promise<void> {
  const attest = await driver.cliAs(
    identity.role,
    [
      "node",
      "attest",
      "--id",
      input.nodeId,
      "--fence",
      String(input.fence),
      "--object-id",
      input.objectId,
    ],
    withToken(identity),
  );
  context.assert(`${input.label}-attest-status`, 0, attest.exitCode);
}

export function harnessTaskAssertionNames(label: string): readonly string[] {
  return [
    `${label}-claim-status`,
    `${label}-claim-attempt`,
    `${label}-heartbeat-status`,
    `${label}-report-status`,
  ];
}

export function attestAssertionNames(label: string): readonly string[] {
  return [`${label}-attest-status`];
}

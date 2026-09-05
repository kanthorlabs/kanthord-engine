import type { ExecutionDriver, HostRole } from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";

export type HarnessIdentity = Readonly<{
  actorId: string;
  tokenFile: string;
  role: HostRole;
}>;

export type HarnessTaskResult = Readonly<{
  leaseFence: number;
  runId: string;
  runFence: number;
  objectiveRunId: string;
  objectiveLeaseFence: number;
  attemptNo: number;
  objectId: string;
}>;

function parseClaim(stdout: string): Readonly<{
  leaseFence: number;
  runId: string;
  runFence: number;
  objectiveRunId: string;
  objectiveLeaseFence: number;
  attemptNo: number;
}> {
  const lease =
    /^kanthord: claimed \S+ lease-fence ([1-9][0-9]*) expires \S+$/m.exec(
      stdout,
    );
  const run =
    /^kanthord: run (\S+) run-fence ([1-9][0-9]*) attempt ([1-9][0-9]*) objective-run (\S+) objective-lease-fence ([1-9][0-9]*)$/m.exec(
      stdout,
    );
  const leaseFenceText = lease?.[1];
  const runId = run?.[1];
  const runFenceText = run?.[2];
  const attemptText = run?.[3];
  const objectiveRunId = run?.[4];
  const objectiveLeaseFenceText = run?.[5];
  if (
    leaseFenceText === undefined ||
    runId === undefined ||
    runFenceText === undefined ||
    attemptText === undefined ||
    objectiveRunId === undefined ||
    objectiveLeaseFenceText === undefined
  ) {
    throw new Error("kanthord: unable to parse node claim output");
  }

  const leaseFence = Number(leaseFenceText);
  const runFence = Number(runFenceText);
  const attemptNo = Number(attemptText);
  const objectiveLeaseFence = Number(objectiveLeaseFenceText);
  if (
    !Number.isSafeInteger(leaseFence) ||
    !Number.isSafeInteger(runFence) ||
    !Number.isSafeInteger(attemptNo) ||
    !Number.isSafeInteger(objectiveLeaseFence)
  ) {
    throw new Error("kanthord: node claim output contains an unsafe number");
  }

  return {
    leaseFence,
    runId,
    runFence,
    objectiveRunId,
    objectiveLeaseFence,
    attemptNo,
  };
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

  const renew = await driver.cliAs(
    identity.role,
    [
      "node",
      "renew",
      "--id",
      input.nodeId,
      "--fence",
      String(parsed.leaseFence),
      "--run-id",
      parsed.runId,
      "--run-fence",
      String(parsed.runFence),
    ],
    withToken(identity),
  );
  context.assert(`${input.label}-renew-status`, 0, renew.exitCode);

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
      String(parsed.leaseFence),
      "--run-id",
      parsed.runId,
      "--run-fence",
      String(parsed.runFence),
    ],
    withToken(identity),
  );
  context.assert(`${input.label}-report-status`, 0, report.exitCode);

  return {
    leaseFence: parsed.leaseFence,
    runId: parsed.runId,
    runFence: parsed.runFence,
    objectiveRunId: parsed.objectiveRunId,
    objectiveLeaseFence: parsed.objectiveLeaseFence,
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
    runId: string;
    runFence: number;
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
      "--run-id",
      input.runId,
      "--run-fence",
      String(input.runFence),
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
    `${label}-renew-status`,
    `${label}-report-status`,
  ];
}

export function attestAssertionNames(label: string): readonly string[] {
  return [`${label}-attest-status`];
}

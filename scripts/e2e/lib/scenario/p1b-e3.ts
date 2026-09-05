import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { CommandRecord } from "../command.ts";
import type {
  ExecutionDriver,
  HttpRequest,
  HttpResponse,
} from "../driver/index.ts";
import { createPodmanDriver, type PodmanExecutor } from "../driver/podman.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import { createPodmanFixtureProfile } from "../profile/fixture.ts";
import { RunnerError } from "../errors.ts";
import { assertPodman } from "../podman/preflight.ts";
import { reclaimByLabel } from "../podman/reclaim.ts";
import { provisionImages } from "../podman/provision.ts";
import { takeImage, takeTemporaryDirectory } from "../resources.ts";
import { createTopology, planTopology } from "../podman/topology.ts";
import { writeSecretFile } from "../secret-file.ts";
import { assertNoDisclosure } from "../disclosure.ts";
import { runCommand } from "../command.ts";
import type { BundleIdentity, BundleVersions } from "../bundle.ts";
import type { ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import type { JourneyOptions, JourneyResult } from "./journey.ts";
import { runJourney as defaultRunJourney } from "./journey.ts";
import { realClock } from "./clock.ts";
import { registerHarness, type HarnessIdentity } from "./harness.ts";

export const wallClockDependency =
  "P1B-E3 waits on wall clock and controls no clock: the daemon exposes no time API, so the takeover is observed by polling node claim every 250 ms to a deadline of 60000 ms under a lease term of 2000 ms.";

export const takeoverLeaseTtlMs = 2000;
export const takeoverPollIntervalMs = 250;
export const takeoverPollDeadlineMs = 60000;

export type P1B3Clock = Readonly<{
  now(): number;
  wait(ms: number): Promise<void>;
}>;

export type P1B3Result = Readonly<{ takeoverLatencyMs: number }>;

export type WithDisclosureFailure = Error & { disclosureFailure?: Error };

type P1B3Context = ScenarioContext & {
  noteHost(name: string, identity: BundleIdentity): void;
  note(key: string, value: string): void;
  setVersions(partial: Partial<BundleVersions>): void;
};

type JsonObject = Readonly<Record<string, unknown>>;

type NodeIdentity = Readonly<{ id: string; state: string }>;

function fail(message: string): never {
  throw new RunnerError("assertion-failed", message);
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("the daemon returned a non-object JSON entry");
  }
  return value as JsonObject;
}

function objectBody(response: HttpResponse): JsonObject {
  return asObject(JSON.parse(response.body));
}

function stringField(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    return fail(`the daemon response field ${field} is not a string`);
  }
  return value;
}

function integerField(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(`the daemon response field ${field} is not an integer`);
  }
  return value;
}

function arrayField(body: JsonObject, field: string): readonly unknown[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    return fail(`the daemon response field ${field} is not an array`);
  }
  return value;
}

function responseStatus(response: HttpResponse, operationId: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new RunnerError(
      "assertion-failed",
      `${operationId} answered HTTP ${String(response.status)}`,
    );
  }
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function request(
  method: string,
  path: string,
  tokenFile: string,
  body?: unknown,
): HttpRequest {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return {
    method,
    path,
    headers,
    omitHost: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    tokenFile,
  };
}

function claimRequest(nodeId: string, tokenFile: string): HttpRequest {
  return request(
    "POST",
    `/v1/node/${pathSegment(nodeId)}/claim`,
    tokenFile,
    {},
  );
}

function readyTaskPath(projectId: string): string {
  const query = [
    `project=${encodeURIComponent(projectId)}`,
    "kind=task",
    "state=ready",
  ].join("&");
  return `/v1/node?${query}`;
}

function errorRecord(
  response: HttpResponse,
): Readonly<{ status: number; code: string | null }> {
  let body: JsonObject;
  try {
    body = objectBody(response);
  } catch {
    return { status: response.status, code: null };
  }
  const error = body.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return { status: response.status, code: null };
  }
  const code = (error as JsonObject).code;
  return {
    status: response.status,
    code: typeof code === "string" ? code : null,
  };
}

function readyTaskIds(response: HttpResponse): readonly string[] {
  return arrayField(objectBody(response), "nodes")
    .map((value) => asObject(value))
    .filter((node) => stringField(node, "kind") === "task")
    .filter((node) => stringField(node, "state") === "ready")
    .map((node) => stringField(node, "id"));
}

function parseClaim(
  stdout: string,
): Readonly<{ fence: number; expiresAt: number; runId: string }> {
  const lease =
    /^kanthord: claimed \S+ lease-fence ([1-9][0-9]*) expires ([1-9][0-9]*)$/m.exec(
      stdout,
    );
  const run =
    /^kanthord: run (\S+) run-fence [1-9][0-9]* attempt [1-9][0-9]* objective-run \S+ objective-run-fence [1-9][0-9]* objective-lease-fence [1-9][0-9]*$/m.exec(
      stdout,
    );
  if (lease === null || run === null) {
    return fail("the node claim command returned no claim");
  }
  const fence = Number(lease[1]);
  const expiresAt = Number(lease[2]);
  const runId = run[1];
  if (
    !Number.isSafeInteger(fence) ||
    !Number.isSafeInteger(expiresAt) ||
    runId === undefined
  ) {
    return fail("the node claim command returned an unsafe fence or expiry");
  }
  return { fence, expiresAt, runId };
}

function showIdentity(response: HttpResponse): NodeIdentity {
  const body = objectBody(response);
  return { id: stringField(body, "id"), state: stringField(body, "state") };
}

function nodeStateLine(record: CommandRecord): NodeIdentity {
  const line = record.stdout.split(/\r?\n/u).find((entry) => entry.length > 0);
  const match =
    line === undefined
      ? null
      : /^kanthord: node (\S+) (\S+) (\S+) (.*)$/u.exec(line);
  if (match === null) {
    return fail("the node show command returned no node");
  }
  return { id: match[1] as string, state: match[3] as string };
}

function outcomeEventActorIds(
  record: CommandRecord,
  subjectId: string,
): readonly string[] {
  const actors: string[] = [];
  for (const line of record.stdout.split(/\r?\n/u)) {
    if (!line.startsWith("kanthord: event ")) {
      continue;
    }
    const fields = line.split(" ");
    const type = fields[5];
    const subject = fields[6];
    if (type !== "outcome.reported" || subject !== `node/${subjectId}`) {
      continue;
    }
    const actor = fields[4];
    if (actor === undefined) {
      return fail("the event list returned a malformed event");
    }
    const separator = actor.indexOf("/");
    if (separator < 1 || separator === actor.length - 1) {
      return fail("the event list returned a malformed actor");
    }
    actors.push(actor.slice(separator + 1));
  }
  return actors;
}

function expectedObjectId(
  profile: ScenarioProfile,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = profile.expectedObjectIds?.[key];
    if (value !== undefined) return value;
  }
  return fail(`the fixture profile has no object id for ${keys.join(" or ")}`);
}

export async function runP1BE3(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
  runJourney: (
    context: ScenarioContext,
    driver: ExecutionDriver,
    profile: ScenarioProfile,
    options?: JourneyOptions,
  ) => Promise<JourneyResult> = defaultRunJourney,
  clock: P1B3Clock = realClock,
): Promise<P1B3Result> {
  const journey = await runJourney(context, driver, profile, {
    leaseTtlMs: takeoverLeaseTtlMs,
  });
  const first = await registerHarness(driver, "client", "p1b-e3-first");
  const second = await registerHarness(driver, "client2", "p1b-e3-second");

  const listRecord = await driver.issueAs(
    first.role,
    request("GET", readyTaskPath(journey.projectId), first.tokenFile),
  );
  responseStatus(listRecord, "node.list");
  const taskId = readyTaskIds(listRecord)[0];
  if (taskId === undefined) {
    return fail("the fixture listing contains no ready task");
  }
  const objectId = expectedObjectId(profile, ["first", "commit1"]);

  const claim = await driver.cliAs(
    first.role,
    ["node", "claim", "--id", taskId],
    { tokenFile: first.tokenFile },
  );
  context.assert("first-claim-status", 0, claim.exitCode);
  const firstClaim = parseClaim(claim.stdout);
  const firstFence = firstClaim.fence;
  const firstExpiry = firstClaim.expiresAt;
  context.assert(
    "first-fence",
    true,
    Number.isSafeInteger(firstFence) && firstFence >= 1,
  );
  const claimedAt = clock.now();

  const pollStart = clock.now();
  let takeover: HttpResponse | null = null;
  let lastStatus: number | null = null;
  let lastBody: string | null = null;
  let firstAnswer = true;
  while (clock.now() - pollStart < takeoverPollDeadlineMs) {
    const response = await driver.issueAs(
      second.role,
      claimRequest(taskId, second.tokenFile),
    );
    lastStatus = response.status;
    lastBody = response.body;

    if (firstAnswer) {
      const firstPollElapsedMs = clock.now() - claimedAt;
      if (clock.now() >= firstExpiry) {
        return fail(
          `the first takeover poll ran after the reported expiry: elapsed ${String(firstPollElapsedMs)} ms`,
        );
      }
      context.assert(
        "poll-refused-before-expiry",
        { status: 409, code: "lease-held" },
        errorRecord(response),
      );
      firstAnswer = false;
    } else if (clock.now() < firstExpiry) {
      const record = errorRecord(response);
      if (record.status !== 409 || record.code !== "lease-held") {
        return fail(
          `a takeover poll before the reported expiry answered ${String(record.status)} ${record.code ?? "no-code"}`,
        );
      }
    }

    if (response.status === 200) {
      takeover = response;
      break;
    }
    await clock.wait(takeoverPollIntervalMs);
  }

  if (takeover === null) {
    const elapsedMs = clock.now() - pollStart;
    const diagnostics = `elapsed ${String(elapsedMs)} ms, last status ${String(lastStatus ?? "none")}, last body ${lastBody ?? "none"}`;
    context.attachLog?.("takeover-timeout", diagnostics);
    return fail(`the takeover poll timed out: ${diagnostics}`);
  }

  context.assert("takeover-status", 200, takeover.status);
  const takeoverBody = objectBody(takeover);
  const takeoverLease = asObject(takeoverBody.lease);
  const newFence = integerField(takeoverLease, "fence");
  const takeoverExpiry = integerField(takeoverLease, "expiresAt");
  const takeoverRunId = stringField(takeoverBody, "runId");
  const takeoverRunFence = integerField(takeoverBody, "runFence");
  context.assert("takeover-fence-greater", true, newFence > firstFence);
  const takeoverAt = clock.now();

  const beforeShow = await driver.issueAs(
    first.role,
    request("GET", `/v1/node/${pathSegment(taskId)}`, first.tokenFile),
  );
  const beforeElapsedMs = clock.now() - takeoverAt;
  if (clock.now() >= takeoverExpiry) {
    return fail(
      `the state-before-stale-report read ran after the reported expiry: elapsed ${String(beforeElapsedMs)} ms`,
    );
  }
  context.assert(
    "state-before-stale-report",
    { id: taskId, state: "running" },
    showIdentity(beforeShow),
  );

  const staleReport = await driver.issueAs(
    first.role,
    request("POST", `/v1/node/${pathSegment(taskId)}/report`, first.tokenFile, {
      report: "accepted",
      fence: firstFence,
      runId: firstClaim.runId,
      runFence: firstFence,
      objectId,
    }),
  );
  context.assert(
    "stale-report-status",
    { status: 409, code: "lease-held" },
    errorRecord(staleReport),
  );

  const afterShow = await driver.issueAs(
    first.role,
    request("GET", `/v1/node/${pathSegment(taskId)}`, first.tokenFile),
  );
  context.assert(
    "state-after-stale-report",
    { id: taskId, state: "running" },
    showIdentity(afterShow),
  );

  const report = await driver.cliAs(
    second.role,
    [
      "node",
      "report",
      "--id",
      taskId,
      "--outcome",
      "accepted",
      "--object-id",
      objectId,
      "--fence",
      String(newFence),
      "--run-id",
      takeoverRunId,
      "--run-fence",
      String(takeoverRunFence),
    ],
    { tokenFile: second.tokenFile },
  );
  context.assert("takeover-report-status", 0, report.exitCode);

  const doneShow = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    taskId,
  ]);
  context.assert(
    "final-state-done",
    { id: taskId, state: "done" },
    nodeStateLine(doneShow),
  );

  const eventsRecord = await driver.cliAs("client", [
    "event",
    "list",
    "--type",
    "outcome.reported",
    "--subject",
    taskId,
  ]);
  const actorIds = outcomeEventActorIds(eventsRecord, taskId);
  context.assert("outcome-events-count", 1, actorIds.length);
  context.assert("outcome-event-actor", second.actorId, actorIds[0]);

  return { takeoverLatencyMs: takeoverAt - claimedAt };
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

async function run(context: ScenarioContext): Promise<void> {
  const execute = createHostExecutor(context);
  const facts = await assertPodman(execute);

  const reclaimReport = await reclaimByLabel(execute, context.tag);
  const [survivor] = reclaimReport.failed;
  if (survivor !== undefined) {
    throw new RunnerError(
      "assertion-failed",
      `a stale resource survived reclaim: ${survivor.kind} ${survivor.id}`,
    );
  }

  const provision = await provisionImages(execute, execute, context.tag);
  takeImage(context, execute, provision.images.product);
  takeImage(context, execute, provision.images.fixture);

  const topology = planTopology(context.tag);
  const secretsDirectory = await takeTemporaryDirectory(
    context,
    "kanthord-e2e-p1b-e3-secrets-",
  );
  const tokenFile = await writeSecretFile(
    context,
    join(secretsDirectory, "token"),
    randomBytes(16).toString("hex"),
  );
  const masterKeyFile = await writeSecretFile(
    context,
    join(secretsDirectory, "master-key"),
    randomBytes(32).toString("base64"),
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

  const p1b3Context = context as P1B3Context;
  p1b3Context.noteHost("daemon", await driver.identity("daemon"));
  p1b3Context.noteHost("client", await driver.identity("client"));
  p1b3Context.noteHost("client2", await driver.identity("client2"));
  p1b3Context.setVersions({ podman: facts.version });
  p1b3Context.note("productDigest", provision.productDigest);
  p1b3Context.note("baseDigest", provision.baseDigest);
  p1b3Context.note("imageId", provision.images.product);
  p1b3Context.note("architecture", provision.architecture);
  p1b3Context.note("podmanRootless", String(facts.rootless));

  const profile = await createPodmanFixtureProfile(
    context,
    execute,
    topology,
    driver,
    "two-objective",
  );

  try {
    const result = await runP1BE3(context, driver, profile);
    p1b3Context.note("takeoverLatency", String(result.takeoverLatencyMs));
    const logs = await driver.collectLogs();
    for (const [name, text] of Object.entries(logs)) {
      context.attachLog?.(name, text);
    }
  } catch (error) {
    try {
      await assertNoDisclosure(context, execute, topology);
    } catch (disclosureError) {
      (error as WithDisclosureFailure).disclosureFailure =
        disclosureError as Error;
    }
    throw error;
  }

  await assertNoDisclosure(context, execute, topology);
}

export const p1bE3: ScenarioDeclaration = {
  id: "P1B-E3",
  mode: "deterministic",
  driver: "podman",
  profile: "fixture",
  plan: "two-objective",
  run,
};

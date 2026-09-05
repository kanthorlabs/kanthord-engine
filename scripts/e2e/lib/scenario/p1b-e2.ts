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
import type { JourneyResult } from "./journey.ts";
import { runJourney as defaultRunJourney } from "./journey.ts";
import { runTransportCases } from "./transport.ts";
import {
  attestObjective,
  registerHarness,
  runHarnessTask,
  type HarnessIdentity,
} from "./harness.ts";

export type WithDisclosureFailure = Error & { disclosureFailure?: Error };

type P1B2Context = ScenarioContext & {
  noteHost(name: string, identity: BundleIdentity): void;
  note(key: string, value: string): void;
  setVersions(partial: Partial<BundleVersions>): void;
};

type JsonObject = Readonly<Record<string, unknown>>;

type GraphNode = Readonly<{
  id: string;
  kind: string;
  state: string;
  parentId: string | null;
  title: string;
}>;

type TaskGraph = Readonly<{
  alphaId: string;
  betaId: string;
  gammaId: string;
  alphaFirstId: string;
  alphaSecondId: string;
  betaFirstId: string;
  betaSecondId: string;
  gammaFirstId: string;
}>;

type NodeIdentity = Readonly<{ id: string; state: string }>;

type ActorRecord = Readonly<{ actorKind: string; actorId: string }>;

const idempotencyKey = "p1b-e2-shared-claim-key";

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

function nullableStringField(body: JsonObject, field: string): string | null {
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    return fail(`the daemon response field ${field} is not nullable text`);
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
  extraHeaders: Readonly<Record<string, string>> = {},
): HttpRequest {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...extraHeaders,
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

function claimRequest(
  nodeId: string,
  tokenFile: string,
  withKey: boolean,
): HttpRequest {
  return request(
    "POST",
    `/v1/node/${pathSegment(nodeId)}/claim`,
    tokenFile,
    {},
    withKey ? { "Idempotency-Key": idempotencyKey } : {},
  );
}

function listPath(projectId: string, readyOnly: boolean): string {
  const query = [
    `project=${encodeURIComponent(projectId)}`,
    ...(readyOnly ? ["kind=task", "state=ready"] : []),
  ].join("&");
  return `/v1/node?${query}`;
}

function graphNodes(response: HttpResponse): readonly GraphNode[] {
  return arrayField(objectBody(response), "nodes").map((value) => {
    const node = asObject(value);
    return {
      id: stringField(node, "id"),
      kind: stringField(node, "kind"),
      state: stringField(node, "state"),
      parentId: nullableStringField(node, "parentId"),
      title: stringField(node, "title"),
    };
  });
}

function graphFromListing(nodes: readonly GraphNode[]): TaskGraph {
  const objectives = nodes.filter((node) => node.kind === "objective");
  const alpha = objectives.find((node) => node.title === "Alpha");
  const beta = objectives.find((node) => node.title === "Beta");
  const gamma = objectives.find((node) => node.title === "Gamma");
  if (alpha === undefined || beta === undefined || gamma === undefined) {
    return fail("the fixture listing does not contain the three objectives");
  }

  const tasks = nodes.filter((node) => node.kind === "task");
  const alphaTasks = tasks.filter((node) => node.parentId === alpha.id);
  const betaTasks = tasks.filter((node) => node.parentId === beta.id);
  const gammaTasks = tasks.filter((node) => node.parentId === gamma.id);
  const alphaFirst = alphaTasks.find((node) => node.state === "ready");
  const alphaSecond = alphaTasks.find((node) => node.state === "pending");
  const betaFirst = betaTasks.find((node) => node.state === "ready");
  const betaSecond = betaTasks.find((node) => node.state === "pending");
  const gammaFirst = gammaTasks.find((node) => node.state === "ready");
  if (
    alphaFirst === undefined ||
    alphaSecond === undefined ||
    betaFirst === undefined ||
    betaSecond === undefined ||
    gammaFirst === undefined
  ) {
    return fail("the fixture listing does not contain the expected frontier");
  }

  return {
    alphaId: alpha.id,
    betaId: beta.id,
    gammaId: gamma.id,
    alphaFirstId: alphaFirst.id,
    alphaSecondId: alphaSecond.id,
    betaFirstId: betaFirst.id,
    betaSecondId: betaSecond.id,
    gammaFirstId: gammaFirst.id,
  };
}

function nodeIdentities(response: HttpResponse): readonly NodeIdentity[] {
  return arrayField(objectBody(response), "nodes").map((value) => {
    const node = asObject(value);
    return {
      id: stringField(node, "id"),
      state: stringField(node, "state"),
    };
  });
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

function leaseSubjectId(response: HttpResponse): string {
  const lease = asObject(objectBody(response).lease);
  return stringField(lease, "subjectId");
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

function showIdentity(response: HttpResponse): NodeIdentity {
  const body = objectBody(response);
  return { id: stringField(body, "id"), state: stringField(body, "state") };
}

function attestedObjectIdOf(response: HttpResponse): string {
  return stringField(objectBody(response), "attestedObjectId");
}

function eventActorRecords(record: CommandRecord): readonly ActorRecord[] {
  return record.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("kanthord: event "))
    .map((line) => {
      const fields = line.split(" ");
      const actor = fields[4];
      if (actor === undefined) {
        return fail("the event list returned a malformed event");
      }
      const separator = actor.indexOf("/");
      if (separator < 1 || separator === actor.length - 1) {
        return fail("the event list returned a malformed actor");
      }
      return {
        actorKind: actor.slice(0, separator),
        actorId: actor.slice(separator + 1),
      };
    });
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

export async function runP1BE2(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
  runJourney: (
    context: ScenarioContext,
    driver: ExecutionDriver,
    profile: ScenarioProfile,
  ) => Promise<JourneyResult> = defaultRunJourney,
): Promise<void> {
  const journey = await runJourney(context, driver, profile);
  const first = await registerHarness(driver, "client", "p1b-e2-first");
  const second = await registerHarness(driver, "client2", "p1b-e2-second");

  const graphRecord = await driver.issueAs(
    first.role,
    request("GET", listPath(journey.projectId, false), first.tokenFile),
  );
  responseStatus(graphRecord, "node.list");
  const graph = graphFromListing(graphNodes(graphRecord));

  const firstList = await driver.issueAs(
    first.role,
    request("GET", listPath(journey.projectId, true), first.tokenFile),
  );
  const secondList = await driver.issueAs(
    second.role,
    request("GET", listPath(journey.projectId, true), second.tokenFile),
  );
  context.assert("client1-list-status", 200, firstList.status);
  context.assert("client2-list-status", 200, secondList.status);
  context.assert(
    "both-lists-equal",
    nodeIdentities(firstList),
    nodeIdentities(secondList),
  );

  const raceCalls = [
    {
      harness: first,
      response: driver.issueAs(
        first.role,
        claimRequest(graph.alphaFirstId, first.tokenFile, false),
      ),
    },
    {
      harness: second,
      response: driver.issueAs(
        second.role,
        claimRequest(graph.alphaFirstId, second.tokenFile, false),
      ),
    },
  ];
  const raceResults = await Promise.all(
    raceCalls.map(async (entry) => ({
      harness: entry.harness,
      response: await entry.response,
    })),
  );
  const firstRace = raceResults[0]!;
  const secondRace = raceResults[1]!;

  let alphaActor: HarnessIdentity;
  let betaActor: HarnessIdentity;
  let raceWinnerResponse: HttpResponse;
  let raceLoserResponse: HttpResponse;
  if (firstRace.response.status === 200 && secondRace.response.status === 409) {
    alphaActor = firstRace.harness;
    betaActor = secondRace.harness;
    raceWinnerResponse = firstRace.response;
    raceLoserResponse = secondRace.response;
  } else if (
    secondRace.response.status === 200 &&
    firstRace.response.status === 409
  ) {
    alphaActor = secondRace.harness;
    betaActor = firstRace.harness;
    raceWinnerResponse = secondRace.response;
    raceLoserResponse = firstRace.response;
  } else {
    return fail(
      "the claim race did not produce exactly one 200 and one 409 lease-held",
    );
  }
  context.assert("race-one-success", 200, raceWinnerResponse.status);
  context.assert(
    "race-one-lease-held",
    { status: 409, code: "lease-held" },
    errorRecord(raceLoserResponse),
  );

  const siblingClaim = await driver.issueAs(
    betaActor.role,
    claimRequest(graph.alphaSecondId, betaActor.tokenFile, false),
  );
  context.assert(
    "sibling-claim-refused",
    { status: 409, code: "lease-held" },
    errorRecord(siblingClaim),
  );
  const objectiveClaim = await driver.issueAs(
    betaActor.role,
    claimRequest(graph.alphaId, betaActor.tokenFile, false),
  );
  context.assert(
    "objective-claim-refused",
    { status: 409, code: "lease-held" },
    errorRecord(objectiveClaim),
  );

  const betaClaim = await driver.issueAs(
    betaActor.role,
    claimRequest(graph.betaFirstId, betaActor.tokenFile, false),
  );
  context.assert("beta-claim-status", 200, betaClaim.status);
  context.assert(
    "two-leases-live",
    [graph.alphaFirstId, graph.betaFirstId],
    [leaseSubjectId(raceWinnerResponse), leaseSubjectId(betaClaim)],
  );

  const alphaFirstObjectId = expectedObjectId(profile, ["first", "commit1"]);
  const alphaSecondObjectId = expectedObjectId(profile, ["second", "commit2"]);
  const betaFirstObjectId = expectedObjectId(profile, ["betaFirst", "tree1"]);
  const betaSecondObjectId = expectedObjectId(profile, ["betaSecond", "tree2"]);
  const alphaAttestObjectId = expectedObjectId(profile, [
    "alphaAttest",
    "tagV1",
  ]);
  const betaAttestObjectId = expectedObjectId(profile, ["betaAttest", "blob2"]);

  const alphaFirstResult = await runHarnessTask(context, driver, alphaActor, {
    nodeId: graph.alphaFirstId,
    objectId: alphaFirstObjectId,
    label: "alpha-1",
  });
  await runHarnessTask(context, driver, alphaActor, {
    nodeId: graph.alphaSecondId,
    objectId: alphaSecondObjectId,
    label: "alpha-2",
  });
  const betaFirstResult = await runHarnessTask(context, driver, betaActor, {
    nodeId: graph.betaFirstId,
    objectId: betaFirstObjectId,
    label: "beta-1",
  });
  await runHarnessTask(context, driver, betaActor, {
    nodeId: graph.betaSecondId,
    objectId: betaSecondObjectId,
    label: "beta-2",
  });

  await attestObjective(context, driver, alphaActor, {
    nodeId: graph.alphaId,
    fence: alphaFirstResult.objectiveLeaseFence,
    runId: alphaFirstResult.objectiveRunId,
    runFence: alphaFirstResult.objectiveLeaseFence,
    objectId: alphaAttestObjectId,
    label: "alpha",
  });
  await attestObjective(context, driver, betaActor, {
    nodeId: graph.betaId,
    fence: betaFirstResult.objectiveLeaseFence,
    runId: betaFirstResult.objectiveRunId,
    runFence: betaFirstResult.objectiveLeaseFence,
    objectId: betaAttestObjectId,
    label: "beta",
  });

  const alphaShow = await driver.issueAs(
    alphaActor.role,
    request(
      "GET",
      `/v1/node/${pathSegment(graph.alphaId)}`,
      alphaActor.tokenFile,
    ),
  );
  const betaShow = await driver.issueAs(
    betaActor.role,
    request(
      "GET",
      `/v1/node/${pathSegment(graph.betaId)}`,
      betaActor.tokenFile,
    ),
  );
  context.assert(
    "alpha-state-attested",
    { id: graph.alphaId, state: "awaiting_approval" },
    showIdentity(alphaShow),
  );
  context.assert(
    "beta-state-attested",
    { id: graph.betaId, state: "awaiting_approval" },
    showIdentity(betaShow),
  );
  context.assert(
    "attested-object-ids-differ",
    [alphaAttestObjectId, betaAttestObjectId],
    [attestedObjectIdOf(alphaShow), attestedObjectIdOf(betaShow)],
  );

  const harnessClose = await driver.issueAs(
    alphaActor.role,
    request(
      "POST",
      `/v1/node/${pathSegment(graph.alphaId)}/report`,
      alphaActor.tokenFile,
      {
        report: "closed",
        runId: alphaFirstResult.objectiveRunId,
        runFence: alphaFirstResult.objectiveLeaseFence,
        acknowledgePartial: false,
      },
    ),
  );
  context.assert(
    "close-harness-forbidden",
    { status: 403, code: "actor-forbidden" },
    errorRecord(harnessClose),
  );

  await driver.cliAs("client", [
    "node",
    "close",
    "--id",
    graph.alphaId,
    "--run-id",
    alphaFirstResult.objectiveRunId,
    "--run-fence",
    String(alphaFirstResult.objectiveLeaseFence),
  ]);
  const alphaClosed = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    graph.alphaId,
  ]);
  context.assert(
    "alpha-closed",
    { id: graph.alphaId, state: "done" },
    nodeStateLine(alphaClosed),
  );
  const gammaAfterFirstClose = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    graph.gammaId,
  ]);
  context.assert(
    "gamma-pending-after-first-close",
    { id: graph.gammaId, state: "pending" },
    nodeStateLine(gammaAfterFirstClose),
  );

  await driver.cliAs("client", [
    "node",
    "close",
    "--id",
    graph.betaId,
    "--run-id",
    betaFirstResult.objectiveRunId,
    "--run-fence",
    String(betaFirstResult.objectiveLeaseFence),
  ]);
  const betaClosed = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    graph.betaId,
  ]);
  context.assert(
    "beta-closed",
    { id: graph.betaId, state: "done" },
    nodeStateLine(betaClosed),
  );
  const gammaAfterSecondClose = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    graph.gammaId,
  ]);
  context.assert(
    "gamma-ready-after-second-close",
    { id: graph.gammaId, state: "ready" },
    nodeStateLine(gammaAfterSecondClose),
  );
  const gammaFirstState = await driver.cliAs("client", [
    "node",
    "show",
    "--id",
    graph.gammaFirstId,
  ]);
  context.assert(
    "gamma-first-task-ready",
    { id: graph.gammaFirstId, state: "ready" },
    nodeStateLine(gammaFirstState),
  );

  const claimsRecord = await driver.cliAs("client", [
    "event",
    "list",
    "--type",
    "lease.claimed",
  ]);
  const reportsRecord = await driver.cliAs("client", [
    "event",
    "list",
    "--type",
    "outcome.reported",
  ]);
  const alphaActorRecord: ActorRecord = {
    actorKind: "harness",
    actorId: alphaActor.actorId,
  };
  const betaActorRecord: ActorRecord = {
    actorKind: "harness",
    actorId: betaActor.actorId,
  };
  context.assert(
    "event-list-claims",
    [alphaActorRecord, betaActorRecord, alphaActorRecord, betaActorRecord],
    eventActorRecords(claimsRecord),
  );
  context.assert(
    "event-list-reports",
    [alphaActorRecord, alphaActorRecord, betaActorRecord, betaActorRecord],
    eventActorRecords(reportsRecord),
  );
  context.assert(
    "event-actor-ids-differ",
    true,
    alphaActor.actorId !== betaActor.actorId,
  );

  const firstIdempotentClaim = await driver.issueAs(
    alphaActor.role,
    claimRequest(graph.gammaFirstId, alphaActor.tokenFile, true),
  );
  const secondIdempotentClaim = await driver.issueAs(
    betaActor.role,
    claimRequest(graph.gammaFirstId, betaActor.tokenFile, true),
  );
  context.assert("idempotency-first-status", 200, firstIdempotentClaim.status);
  context.assert(
    "idempotency-second-status",
    409,
    secondIdempotentClaim.status,
  );
  context.assert(
    "idempotency-bodies-differ",
    true,
    firstIdempotentClaim.body !== secondIdempotentClaim.body,
  );

  const network = (await driver.daemonNetwork?.()) ?? {
    bind: "0.0.0.0",
    port: 7421,
    allowedHosts: ["kanthord-daemon:7421"] as readonly string[],
  };
  const allowedHost = network.allowedHosts[0] ?? "kanthord-daemon:7421";
  await runTransportCases(
    context,
    { allowedHost, token: journey.token },
    (input) => driver.issueAs("client2", input),
  );
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
    "kanthord-e2e-p1b-e2-secrets-",
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

  const p1b2Context = context as P1B2Context;
  p1b2Context.noteHost("daemon", await driver.identity("daemon"));
  p1b2Context.noteHost("client", await driver.identity("client"));
  p1b2Context.noteHost("client2", await driver.identity("client2"));
  p1b2Context.setVersions({ podman: facts.version });
  p1b2Context.note("productDigest", provision.productDigest);
  p1b2Context.note("baseDigest", provision.baseDigest);
  p1b2Context.note("imageId", provision.images.product);
  p1b2Context.note("architecture", provision.architecture);
  p1b2Context.note("podmanRootless", String(facts.rootless));

  const profile = await createPodmanFixtureProfile(
    context,
    execute,
    topology,
    driver,
    "three-objective",
  );

  try {
    await runP1BE2(context, driver, profile);
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

export const p1bE2: ScenarioDeclaration = {
  id: "P1B-E2",
  mode: "deterministic",
  driver: "podman",
  profile: "fixture",
  plan: "three-objective",
  run,
};

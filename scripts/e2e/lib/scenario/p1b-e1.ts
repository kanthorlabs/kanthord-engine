import type { CommandRecord } from "../command.ts";
import type {
  ExecutionDriver,
  HttpRequest,
  HttpResponse,
} from "../driver/index.ts";
import { createFixtureProfile } from "../profile/fixture.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import { createLocalDriver } from "../driver/local.ts";
import type { ScenarioContext } from "./context.ts";
import type { JourneyResult } from "./journey.ts";
import { runJourney as defaultRunJourney } from "./journey.ts";
import { attestObjective, registerHarness, runHarnessTask } from "./harness.ts";
import type { ScenarioDeclaration } from "./index.ts";
import { RunnerError } from "../errors.ts";

type JsonObject = Readonly<Record<string, unknown>>;

type ListedNode = Readonly<{
  id: string;
  kind: string;
  state: string;
  parentId: string | null;
}>;

type TaskGraph = Readonly<{
  alphaId: string;
  gammaId: string;
  alphaFirstId: string;
  alphaSecondId: string;
  betaFirstId: string;
  gammaFirstId: string;
}>;

type EventRecord = Readonly<{
  type: string;
  actorKind: string;
  actorId: string;
}>;

const harnessRole = "client" as const;
const transientTitle = "p1b-e1-transient";
const renamedTransientTitle = "p1b-e1-transient-renamed";
const durableTitle = "p1b-e1-durable";

function fail(message: string): never {
  throw new RunnerError("assertion-failed", message);
}

function objectBody(response: HttpResponse): JsonObject {
  const parsed: unknown = JSON.parse(response.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("the daemon returned a non-object JSON response");
  }
  return parsed as JsonObject;
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

function stringArrayField(body: JsonObject, field: string): readonly string[] {
  return arrayField(body, field).map((value) => {
    if (typeof value !== "string") {
      return fail(`the daemon response field ${field} contains a non-string`);
    }
    return value;
  });
}

function completenessField(body: JsonObject): readonly unknown[] {
  return arrayField(body, "completeness");
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

function taskNodeLine(line: string): ListedNode | null {
  const match = /^kanthord: node (\S+) (\S+) (\S+) (\S+) (\S+)$/u.exec(line);
  if (match === null) return null;
  return {
    id: match[1] as string,
    kind: match[2] as string,
    state: match[3] as string,
    parentId: match[5] === "-" ? null : (match[5] as string),
  };
}

function parseTaskList(record: CommandRecord): readonly ListedNode[] {
  return record.stdout
    .split(/\r?\n/u)
    .map(taskNodeLine)
    .filter((node): node is ListedNode => node !== null)
    .filter((node) => node.kind === "task");
}

function nodeStateLine(record: CommandRecord): Readonly<{
  id: string;
  state: string;
}> {
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

function edgeIds(body: JsonObject): readonly string[] {
  return arrayField(body, "edges").map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("the edge list contains a non-object edge");
    }
    return stringField(value as JsonObject, "id");
  });
}

function documents(body: JsonObject): readonly Readonly<{
  path: string;
  content: string;
}>[] {
  return arrayField(body, "documents").map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("the plan export contains a non-object document");
    }
    const document = value as JsonObject;
    return {
      path: stringField(document, "path"),
      content: stringField(document, "content"),
    };
  });
}

function canonicalDocuments(
  input: readonly Readonly<{ path: string; content: string }>[],
): Buffer {
  const ordered = [...input].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

function eventRecords(record: CommandRecord): readonly EventRecord[] {
  return record.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("kanthord: event "))
    .map((line) => {
      const fields = line.split(" ");
      const actor = fields[4];
      const type = fields[5];
      if (actor === undefined || type === undefined) {
        return fail("the event list returned a malformed event");
      }
      const separator = actor.indexOf("/");
      if (separator < 1 || separator === actor.length - 1) {
        return fail("the event list returned a malformed actor");
      }
      return {
        actorKind: actor.slice(0, separator),
        actorId: actor.slice(separator + 1),
        type,
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

function graphFromTasks(tasks: readonly ListedNode[]): TaskGraph {
  const parents: string[] = [];
  for (const task of tasks) {
    if (task.parentId !== null && !parents.includes(task.parentId)) {
      parents.push(task.parentId);
    }
  }

  const alphaId = parents[0];
  const betaId = parents[1];
  const gammaId = parents[2];
  if (alphaId === undefined || betaId === undefined || gammaId === undefined) {
    return fail("the fixture task list does not contain three objectives");
  }

  const alphaTasks = tasks.filter((task) => task.parentId === alphaId);
  const betaTasks = tasks.filter((task) => task.parentId === betaId);
  const gammaTasks = tasks.filter((task) => task.parentId === gammaId);
  const alphaFirst = alphaTasks.find((task) => task.state === "ready");
  const alphaSecond = alphaTasks.find((task) => task.state === "pending");
  const betaFirst = betaTasks.find((task) => task.state === "ready");
  const gammaFirst = gammaTasks.find((task) => task.state === "ready");
  if (
    alphaFirst === undefined ||
    alphaSecond === undefined ||
    betaFirst === undefined ||
    gammaFirst === undefined
  ) {
    return fail("the fixture task list does not contain the expected frontier");
  }

  return {
    alphaId,
    gammaId,
    alphaFirstId: alphaFirst.id,
    alphaSecondId: alphaSecond.id,
    betaFirstId: betaFirst.id,
    gammaFirstId: gammaFirst.id,
  };
}

async function runScenario(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
  journeyRunner: (
    context: ScenarioContext,
    driver: ExecutionDriver,
    profile: ScenarioProfile,
  ) => Promise<JourneyResult>,
): Promise<void> {
  const journey = await journeyRunner(context, driver, profile);
  const harness = await registerHarness(driver, harnessRole, "p1b-e1-harness");
  const humanTokenFile = await driver.deliverToken(journey.token);
  const taskGraphRecord = await driver.cliAs(
    harness.role,
    ["node", "list", "--project", journey.projectId, "--kind", "task"],
    { tokenFile: harness.tokenFile },
  );
  const taskGraph = graphFromTasks(parseTaskList(taskGraphRecord));
  const authoringOperationIds: string[] = [];

  const issueOperation = async (
    operationId: string,
    input: HttpRequest,
  ): Promise<HttpResponse> => {
    authoringOperationIds.push(operationId);
    return driver.issueAs(harness.role, {
      ...input,
      tokenFile: harness.tokenFile,
    });
  };

  const projectPath = `/v1/project/${pathSegment(journey.projectId)}`;
  const beforeExport = await issueOperation(
    "plan.export",
    request("GET", `${projectPath}/plan/export`, harness.tokenFile),
  );
  responseStatus(beforeExport, "plan.export");
  const beforeExportBody = objectBody(beforeExport);
  const beforeRevision = nullableStringField(beforeExportBody, "revision");
  const beforeDocuments = documents(beforeExportBody);

  const edgesBeforeResponse = await issueOperation(
    "edge.list",
    request("GET", `${projectPath}/edge`, harness.tokenFile),
  );
  responseStatus(edgesBeforeResponse, "edge.list");
  const edgesBefore = edgeIds(objectBody(edgesBeforeResponse));

  const taskNode = (title: string): Readonly<Record<string, unknown>> => ({
    kind: "task",
    title,
    parentId: taskGraph.alphaId,
    instruction: "",
    acceptance: "",
    worker: null,
    dependsOn: [],
  });

  const transientCreate = await issueOperation(
    "node.create",
    request("POST", `${projectPath}/node`, harness.tokenFile, {
      fromRevision: beforeRevision,
      node: taskNode(transientTitle),
    }),
  );
  context.assert("transient-create-status", 200, transientCreate.status);
  const transientCreateBody = objectBody(transientCreate);
  context.assert(
    "transient-create-completeness",
    [],
    completenessField(transientCreateBody),
  );
  const transientId = stringField(transientCreateBody, "id");
  const createRevision = stringField(transientCreateBody, "revision");

  const transientShowBeforeUpdate = await issueOperation(
    "node.show",
    request("GET", `/v1/node/${pathSegment(transientId)}`, harness.tokenFile),
  );
  responseStatus(transientShowBeforeUpdate, "node.show");
  context.assert(
    "transient-node-revision",
    createRevision,
    stringField(objectBody(transientShowBeforeUpdate), "revision"),
  );

  const transientUpdate = await issueOperation(
    "node.update",
    request(
      "POST",
      `/v1/node/${pathSegment(transientId)}/update`,
      harness.tokenFile,
      {
        fromRevision: createRevision,
        node: taskNode(renamedTransientTitle),
      },
    ),
  );
  context.assert("transient-update-status", 200, transientUpdate.status);
  const transientUpdateBody = objectBody(transientUpdate);
  context.assert(
    "transient-update-completeness",
    [],
    completenessField(transientUpdateBody),
  );
  const updateRevision = stringField(transientUpdateBody, "revision");

  const transientShowAfterUpdate = await issueOperation(
    "node.show",
    request("GET", `/v1/node/${pathSegment(transientId)}`, harness.tokenFile),
  );
  responseStatus(transientShowAfterUpdate, "node.show");
  context.assert(
    "transient-update-title",
    renamedTransientTitle,
    stringField(objectBody(transientShowAfterUpdate), "title"),
  );

  const transientDelete = await issueOperation(
    "node.delete",
    request(
      "POST",
      `/v1/node/${pathSegment(transientId)}/delete`,
      harness.tokenFile,
      { fromRevision: updateRevision },
    ),
  );
  context.assert("transient-delete-status", 200, transientDelete.status);
  const transientDeleteBody = objectBody(transientDelete);
  context.assert(
    "transient-delete-completeness",
    [],
    completenessField(transientDeleteBody),
  );
  const deleteRevision = stringField(transientDeleteBody, "revision");
  context.assert(
    "transient-delete-identity",
    [transientId],
    stringArrayField(transientDeleteBody, "deleted"),
  );

  const transientGone = await issueOperation(
    "node.show",
    request("GET", `/v1/node/${pathSegment(transientId)}`, harness.tokenFile),
  );
  context.assert("transient-gone", 404, transientGone.status);

  const afterDeleteExport = await issueOperation(
    "plan.export",
    request("GET", `${projectPath}/plan/export`, harness.tokenFile),
  );
  responseStatus(afterDeleteExport, "plan.export");
  const afterDeleteExportBody = objectBody(afterDeleteExport);
  context.assert(
    "export-revision-after-delete",
    deleteRevision,
    nullableStringField(afterDeleteExportBody, "revision"),
  );
  context.assert(
    "export-documents-after-delete",
    true,
    Buffer.compare(
      canonicalDocuments(beforeDocuments),
      canonicalDocuments(documents(afterDeleteExportBody)),
    ) === 0,
  );

  const durableCreate = await issueOperation(
    "node.create",
    request("POST", `${projectPath}/node`, harness.tokenFile, {
      fromRevision: deleteRevision,
      node: taskNode(durableTitle),
    }),
  );
  context.assert("durable-create-status", 200, durableCreate.status);
  const durableCreateBody = objectBody(durableCreate);
  context.assert(
    "durable-create-completeness",
    [],
    completenessField(durableCreateBody),
  );
  const durableId = stringField(durableCreateBody, "id");

  const edgesAfterResponse = await issueOperation(
    "edge.list",
    request("GET", `${projectPath}/edge`, harness.tokenFile),
  );
  responseStatus(edgesAfterResponse, "edge.list");
  context.assert(
    "authored-edges-unchanged",
    edgesBefore,
    edgeIds(objectBody(edgesAfterResponse)),
  );

  const durableShow = await issueOperation(
    "node.show",
    request("GET", `/v1/node/${pathSegment(durableId)}`, harness.tokenFile),
  );
  responseStatus(durableShow, "node.show");
  const durableShowBody = objectBody(durableShow);
  context.assert(
    "durable-state-ready",
    { id: durableId, state: "ready" },
    {
      id: stringField(durableShowBody, "id"),
      state: stringField(durableShowBody, "state"),
    },
  );

  const transientEvents = eventRecords(
    await driver.cliAs(harnessRole, [
      "event",
      "list",
      "--subject",
      transientId,
      "--actor",
      harness.actorId,
    ]),
  );
  const durableEvents = eventRecords(
    await driver.cliAs(harnessRole, [
      "event",
      "list",
      "--subject",
      durableId,
      "--actor",
      harness.actorId,
    ]),
  );
  const harnessActor = { actorKind: "harness", actorId: harness.actorId };
  context.assert(
    "transient-event-types",
    ["node.created", "node.updated", "node.deleted"],
    transientEvents.map((event) => event.type),
  );
  context.assert(
    "transient-event-actor",
    [harnessActor, harnessActor, harnessActor],
    transientEvents.map(({ actorKind, actorId }) => ({ actorKind, actorId })),
  );
  context.assert(
    "durable-event-types",
    ["node.created"],
    durableEvents.map((event) => event.type),
  );
  context.assert(
    "durable-event-actor",
    [harnessActor],
    durableEvents.map(({ actorKind, actorId }) => ({ actorKind, actorId })),
  );
  context.assert(
    "authoring-operation-ids",
    [
      "plan.export",
      "edge.list",
      "node.create",
      "node.show",
      "node.update",
      "node.show",
      "node.delete",
      "node.show",
      "plan.export",
      "node.create",
      "edge.list",
      "node.show",
    ],
    authoringOperationIds,
  );

  const readyRecord = await driver.cliAs(
    harness.role,
    [
      "node",
      "list",
      "--project",
      journey.projectId,
      "--state",
      "ready",
      "--kind",
      "task",
    ],
    { tokenFile: harness.tokenFile },
  );
  const readyIds = parseTaskList(readyRecord)
    .map((node) => node.id)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
  const expectedReadyIds = [
    taskGraph.alphaFirstId,
    durableId,
    taskGraph.betaFirstId,
    taskGraph.gammaFirstId,
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  context.assert("ready-frontier", expectedReadyIds, readyIds);

  const firstObjectId = expectedObjectId(profile, ["first", "commit1"]);
  const secondObjectId = expectedObjectId(profile, ["second", "commit2"]);
  const authoredObjectId = expectedObjectId(profile, ["authored", "tree2"]);
  const combinedObjectId = expectedObjectId(profile, [
    "combined",
    "tagV1",
    "authored",
  ]);

  const alphaFirstResult = await runHarnessTask(context, driver, harness, {
    nodeId: taskGraph.alphaFirstId,
    objectId: firstObjectId,
    label: "alpha-1",
  });
  const alphaFirstState = await driver.cliAs(
    harness.role,
    ["node", "show", "--id", taskGraph.alphaFirstId],
    { tokenFile: harness.tokenFile },
  );
  context.assert(
    "alpha-1-state",
    { id: taskGraph.alphaFirstId, state: "done" },
    nodeStateLine(alphaFirstState),
  );

  await runHarnessTask(context, driver, harness, {
    nodeId: taskGraph.alphaSecondId,
    objectId: secondObjectId,
    label: "alpha-2",
  });
  const alphaSecondState = await driver.cliAs(
    harness.role,
    ["node", "show", "--id", taskGraph.alphaSecondId],
    { tokenFile: harness.tokenFile },
  );
  context.assert(
    "alpha-2-state",
    { id: taskGraph.alphaSecondId, state: "done" },
    nodeStateLine(alphaSecondState),
  );

  await runHarnessTask(context, driver, harness, {
    nodeId: durableId,
    objectId: authoredObjectId,
    label: "alpha-authored",
  });
  const authoredState = await driver.cliAs(
    harness.role,
    ["node", "show", "--id", durableId],
    { tokenFile: harness.tokenFile },
  );
  context.assert(
    "alpha-authored-state",
    { id: durableId, state: "done" },
    nodeStateLine(authoredState),
  );

  await attestObjective(context, driver, harness, {
    nodeId: taskGraph.alphaId,
    fence: alphaFirstResult.objectiveLeaseFence,
    runId: alphaFirstResult.objectiveRunId,
    runFence: alphaFirstResult.objectiveLeaseFence,
    objectId: combinedObjectId,
    label: "alpha",
  });

  const alphaAttested = await driver.issueAs(
    harnessRole,
    request(
      "GET",
      `/v1/node/${pathSegment(taskGraph.alphaId)}`,
      humanTokenFile,
    ),
  );
  responseStatus(alphaAttested, "node.show");
  const alphaAttestedBody = objectBody(alphaAttested);
  context.assert(
    "alpha-state-attested",
    { id: taskGraph.alphaId, state: "awaiting_approval" },
    {
      id: stringField(alphaAttestedBody, "id"),
      state: stringField(alphaAttestedBody, "state"),
    },
  );
  context.assert(
    "alpha-attested-object-id",
    combinedObjectId,
    stringField(alphaAttestedBody, "attestedObjectId"),
  );
  context.assert(
    "alpha-projection",
    "done",
    stringField(alphaAttestedBody, "projection"),
  );

  const humanAttest = await driver.issueAs(
    harnessRole,
    request(
      "POST",
      `/v1/node/${pathSegment(taskGraph.alphaId)}/report`,
      humanTokenFile,
      {
        report: "attested",
        fence: alphaFirstResult.objectiveLeaseFence,
        runId: alphaFirstResult.objectiveRunId,
        runFence: alphaFirstResult.objectiveLeaseFence,
        objectId: combinedObjectId,
      },
    ),
  );
  context.assert("attest-human-status", 403, humanAttest.status);
  const humanAttestBody = objectBody(humanAttest);
  const humanAttestError = humanAttestBody.error;
  const humanAttestCode =
    humanAttestError !== null &&
    typeof humanAttestError === "object" &&
    !Array.isArray(humanAttestError)
      ? (humanAttestError as JsonObject).code
      : undefined;
  context.assert("attest-human-code", "actor-forbidden", humanAttestCode);

  await driver.cliAs(harnessRole, [
    "node",
    "close",
    "--id",
    taskGraph.alphaId,
    "--run-id",
    alphaFirstResult.objectiveRunId,
    "--run-fence",
    String(alphaFirstResult.objectiveLeaseFence),
  ]);
  const alphaClosed = await driver.cliAs(harnessRole, [
    "node",
    "show",
    "--id",
    taskGraph.alphaId,
  ]);
  context.assert(
    "alpha-state-closed",
    { id: taskGraph.alphaId, state: "done" },
    nodeStateLine(alphaClosed),
  );

  const gammaState = await driver.cliAs(harnessRole, [
    "node",
    "show",
    "--id",
    taskGraph.gammaId,
  ]);
  context.assert(
    "gamma-state-pending",
    { id: taskGraph.gammaId, state: "pending" },
    nodeStateLine(gammaState),
  );
  const betaFirstState = await driver.cliAs(harnessRole, [
    "node",
    "show",
    "--id",
    taskGraph.betaFirstId,
  ]);
  context.assert(
    "beta-first-state-ready",
    { id: taskGraph.betaFirstId, state: "ready" },
    nodeStateLine(betaFirstState),
  );
}

export async function runP1BE1(
  context: ScenarioContext,
  driver: ExecutionDriver,
  profile: ScenarioProfile,
  runJourney: (
    context: ScenarioContext,
    driver: ExecutionDriver,
    profile: ScenarioProfile,
  ) => Promise<JourneyResult> = defaultRunJourney,
): Promise<void> {
  await runScenario(context, driver, profile, runJourney);
}

async function run(context: ScenarioContext): Promise<void> {
  const driver = await createLocalDriver(context);
  const profile = await createFixtureProfile(
    context,
    driver,
    "three-objective",
  );
  await runP1BE1(context, driver, profile);
}

export const p1bE1: ScenarioDeclaration = {
  id: "P1B-E1",
  mode: "deterministic",
  driver: "local",
  profile: "fixture",
  plan: "three-objective",
  run,
};

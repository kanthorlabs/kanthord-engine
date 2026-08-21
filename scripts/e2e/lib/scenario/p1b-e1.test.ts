import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord } from "../command.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
  HttpRequest,
  HttpResponse,
} from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import type { JourneyResult } from "./journey.ts";
import {
  expectedAssertions,
  fixtureProfileAssertionNames,
  journeyAssertionNames,
} from "./assertions.ts";
import { p1bE1, runP1BE1 } from "./p1b-e1.ts";

const projectId = "project-1";
const alphaId = "objective-alpha";
const betaId = "objective-beta";
const gammaId = "objective-gamma";
const alphaFirstId = "task-alpha-first";
const alphaSecondId = "task-alpha-second";
const betaFirstId = "task-beta-first";
const betaSecondId = "task-beta-second";
const gammaFirstId = "task-gamma-first";
const transientId = "task-transient";
const durableId = "task-authored-durable";
const harnessTokenFile = "/run/e2e/harness-1.token";
const humanTokenFile = "/run/e2e/human.token";

const revisions = {
  before: "revision-before",
  create: "revision-create",
  update: "revision-update",
  delete: "revision-delete",
  durable: "revision-durable",
} as const;

type AssertionRecord = Readonly<{
  name: string;
  expected: unknown;
  actual: unknown;
}>;

type CliCall = Readonly<{
  role: HostRole | "human";
  argv: readonly string[];
  tokenFile?: string;
}>;

type IssueCall = Readonly<{
  role: HostRole;
  request: HttpRequest;
  operationId: string;
  response: HttpResponse;
}>;

type TimelineEntry = Readonly<{
  kind: "cli" | "issue";
  operationId?: string;
  argv?: readonly string[];
  path?: string;
  tokenFile?: string;
}>;

type FakeScenario = Readonly<{
  driver: ExecutionDriver;
  cliCalls: readonly CliCall[];
  issueCalls: readonly IssueCall[];
  timeline: readonly TimelineEntry[];
  registrations: readonly Readonly<{ role: HostRole; name: string }>[];
  events: string[];
}>;

function command(
  argv: readonly string[],
  stdout = "",
  exitCode = 0,
  stderr = "",
): CommandRecord {
  return {
    argv,
    cwd: "/tmp/p1b-e1-test",
    exitCode,
    stdout,
    stderr,
  };
}

function context(): ScenarioContext & {
  assertionNames(): readonly string[];
  assertionRecords(): readonly AssertionRecord[];
} {
  const records: AssertionRecord[] = [];
  return {
    tag: "p1b-e1-test",
    scenarioId: "P1B-E1",
    bundleDirectory: "/tmp/p1b-e1-test-bundle",
    take: () => undefined,
    sink: { print: () => undefined, record: () => undefined },
    assert(name: string, expected: unknown, actual: unknown): void {
      const record = { name, expected, actual };
      records.push(record);
      assert.deepEqual(actual, expected);
    },
    daemonHost: null,
    clientHost: null,
    assertionNames(): readonly string[] {
      return records.map((record) => record.name);
    },
    assertionRecords(): readonly AssertionRecord[] {
      return records;
    },
  };
}

function profile(): ScenarioProfile {
  return {
    name: "fixture",
    origin: "http://fixture.test/fixture.git",
    credentialArguments: [],
    defaultBranch: "main",
    planDirectory: "test/e2e/fixtures/three-objective/plan",
    expectedObjectiveCount: 3,
    expectedTaskCount: 5,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 3,
    fixtureRoot: "test/e2e/fixtures/three-objective",
    expectedObjectIds: {
      first: "object-first",
      second: "object-second",
      authored: "object-authored",
    },
  };
}

function journey(): JourneyResult {
  return {
    credentialId: "credential-1",
    repositoryId: "repository-1",
    projectId,
    firstRevision: "journey-revision-1",
    secondRevision: "journey-revision-2",
    accepted: [],
    token: "human-token",
  };
}

function nodeState(id: string): string {
  if (id === gammaId) return "pending";
  if (id === alphaId) return "awaiting_approval";
  if (id === betaId) return "pending";
  if (id === transientId) return "ready";
  if (id === durableId) return "ready";
  if (id === alphaFirstId) return "ready";
  if (id === alphaSecondId) return "pending";
  if (id === betaFirstId) return "ready";
  if (id === betaSecondId) return "pending";
  if (id === gammaFirstId) return "ready";
  return "ready";
}

function nodeView(
  id: string,
  overrides: Readonly<{
    state?: string;
    title?: string;
    revision?: string;
    attestedObjectId?: string | null;
    projection?: "done" | "partial" | "discarded" | null;
  }> = {},
): Readonly<Record<string, unknown>> {
  const kind = id.startsWith("objective-") ? "objective" : "task";
  const parentId = kind === "task" ? alphaId : null;
  return {
    id,
    projectId,
    kind,
    title: overrides.title ?? id,
    state: overrides.state ?? nodeState(id),
    blockReason: null,
    discardReason: null,
    parentId,
    dependencies: [],
    instructionBlob: "blob-instruction",
    acceptanceBlob: null,
    instruction: "",
    acceptance: kind === "task" ? "" : null,
    worker: "general@1",
    repositoryId: "repository-1",
    repo: "fixture",
    revision: overrides.revision ?? "revision-node",
    updatedAt: 1,
    attestedObjectId: overrides.attestedObjectId ?? null,
    projection: overrides.projection ?? null,
  };
}

function nodeListItem(id: string): Readonly<Record<string, unknown>> {
  const view = nodeView(id);
  return {
    id: view.id,
    projectId: view.projectId,
    kind: view.kind,
    title: view.title,
    state: view.state,
    blockReason: view.blockReason,
    discardReason: view.discardReason,
    parentId: view.parentId,
    dependencies: view.dependencies,
  };
}

function operationId(request: HttpRequest): string {
  if (request.path.endsWith("/plan/export")) return "plan.export";
  if (request.path.endsWith("/edge")) return "edge.list";
  if (request.path.endsWith("/node")) return "node.create";
  if (request.path.endsWith("/update")) return "node.update";
  if (request.path.endsWith("/delete")) return "node.delete";
  if (request.path.endsWith("/report")) return "node.report";
  if (request.path.startsWith("/v1/node/")) return "node.show";
  if (request.path === "/v1/node") return "node.list";
  throw new Error(`unexpected request ${request.method} ${request.path}`);
}

function requestBody(request: HttpRequest): Readonly<Record<string, unknown>> {
  return request.body === undefined
    ? {}
    : (JSON.parse(request.body) as Readonly<Record<string, unknown>>);
}

function showResponse(
  id: string,
  states: Readonly<Record<string, string>>,
  transientShows: number,
  titles: Readonly<Record<string, string>>,
  revisions: Readonly<Record<string, string>>,
  attestedObjectIds: Readonly<Record<string, string>>,
): HttpResponse {
  if (id === transientId && transientShows >= 3) {
    return {
      status: 404,
      body: JSON.stringify({
        error: { code: "not-found", message: `no node ${transientId}` },
      }),
    };
  }
  const state = states[id] ?? nodeState(id);
  const extras =
    id === alphaId && state === "awaiting_approval"
      ? {
          attestedObjectId: attestedObjectIds[id],
          projection: "done" as const,
        }
      : {};
  return {
    status: 200,
    body: JSON.stringify(
      nodeView(id, {
        state,
        title: titles[id],
        revision: revisions[id],
        ...extras,
      }),
    ),
  };
}

function eventOutput(subject: string): string {
  const rows =
    subject === transientId
      ? [
          ["event-transient-1", "node.created", transientId],
          ["event-transient-2", "node.updated", transientId],
          ["event-transient-3", "node.deleted", transientId],
        ]
      : [["event-durable-1", "node.created", durableId]];
  return (
    rows
      .map(
        ([id, type, subjectId]) =>
          `kanthord: event 2026-08-17T00:00:00.000Z ${id} harness/harness-1 ${type} task/${subjectId} {}`,
      )
      .join("\n") + "\n"
  );
}

function idOption(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--id");
  return index === -1 ? argv[2] : argv[index + 1];
}

function readyListOutput(): string {
  return (
    [alphaFirstId, durableId, betaFirstId, gammaFirstId]
      .map(
        (id) =>
          `kanthord: node ${id} task ready - ${id === betaFirstId ? betaId : id === gammaFirstId ? gammaId : alphaId}`,
      )
      .join("\n") + "\n"
  );
}

function fixtureListOutput(): string {
  return (
    [
      [alphaFirstId, "ready", alphaId],
      [alphaSecondId, "pending", alphaId],
      [betaFirstId, "ready", betaId],
      [betaSecondId, "pending", betaId],
      [gammaFirstId, "ready", gammaId],
    ]
      .map(
        ([id, state, parent]) =>
          `kanthord: node ${id} task ${state} - ${parent}`,
      )
      .join("\n") + "\n"
  );
}

function createFakeScenario(): FakeScenario {
  const cliCalls: CliCall[] = [];
  const issueCalls: IssueCall[] = [];
  const timeline: TimelineEntry[] = [];
  const registrations: { role: HostRole; name: string }[] = [];
  const events: string[] = [];
  const states: Record<string, string> = {
    [alphaId]: "running",
    [betaId]: "pending",
    [gammaId]: "pending",
  };
  const titles: Record<string, string> = {};
  const nodeRevisions: Record<string, string> = {};
  const attestedObjectIds: Record<string, string> = {};
  let transientShows = 0;
  let planExports = 0;

  const issueAs = async (
    role: HostRole,
    request: HttpRequest,
  ): Promise<HttpResponse> => {
    const operation = operationId(request);
    const body = requestBody(request);
    let response: HttpResponse;

    if (operation === "plan.export") {
      planExports += 1;
      response = {
        status: 200,
        body: JSON.stringify({
          revision: planExports === 1 ? revisions.before : revisions.delete,
          documents: [{ path: "alpha/objective.md", content: "alpha\n" }],
        }),
      };
    } else if (operation === "edge.list") {
      response = { status: 200, body: JSON.stringify({ edges: [] }) };
    } else if (operation === "node.create") {
      const node = body.node as Readonly<{ title?: string }>;
      const transient = node.title === "p1b-e1-transient";
      const revision = transient ? revisions.create : revisions.durable;
      const id = transient ? transientId : durableId;
      nodeRevisions[id] = revision;
      response = {
        status: 200,
        body: JSON.stringify({
          revision,
          id,
          completeness: [],
        }),
      };
    } else if (operation === "node.update") {
      response = {
        status: 200,
        body: JSON.stringify({ revision: revisions.update, completeness: [] }),
      };
      titles[transientId] = "p1b-e1-transient-renamed";
      nodeRevisions[transientId] = revisions.update;
    } else if (operation === "node.delete") {
      states[transientId] = "deleted";
      delete nodeRevisions[transientId];
      response = {
        status: 200,
        body: JSON.stringify({
          revision: revisions.delete,
          deleted: [transientId],
          completeness: [],
        }),
      };
    } else if (operation === "node.show") {
      const id = request.path.slice("/v1/node/".length);
      if (id === transientId) transientShows += 1;
      response = showResponse(
        id,
        states,
        transientShows,
        titles,
        nodeRevisions,
        attestedObjectIds,
      );
    } else if (operation === "node.list") {
      response = {
        status: 200,
        body: JSON.stringify({
          nodes: [
            alphaFirstId,
            alphaSecondId,
            betaFirstId,
            betaSecondId,
            gammaFirstId,
          ].map(nodeListItem),
        }),
      };
    } else if (operation === "node.report") {
      const id = request.path.slice("/v1/node/".length, -"/report".length);
      if (
        request.tokenFile !== harnessTokenFile &&
        body.report === "attested"
      ) {
        response = {
          status: 403,
          body: JSON.stringify({
            error: { code: "actor-forbidden", message: "actor is forbidden" },
          }),
        };
      } else {
        response = {
          status: 200,
          body: JSON.stringify({
            nodeId: id,
            kind: id.startsWith("objective-") ? "objective" : "task",
            state: body.report === "attested" ? "awaiting_approval" : "done",
            blockReason: null,
            attemptId: "attempt-1",
            attemptNo: 1,
            attemptsRemaining: 2,
            objectId: typeof body.objectId === "string" ? body.objectId : null,
            objectiveState: "running",
            objectiveProjection: null,
          }),
        };
      }
    } else {
      throw new Error(`unexpected operation ${operation}`);
    }

    issueCalls.push({ role, request, operationId: operation, response });
    timeline.push({
      kind: "issue",
      operationId: operation,
      path: request.path,
      tokenFile: request.tokenFile,
    });
    return response;
  };

  const cliAs = async (
    role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> => {
    cliCalls.push({ role, argv, tokenFile: options?.tokenFile });
    timeline.push({ kind: "cli", argv });
    return cliResponse(argv, options?.tokenFile, states);
  };

  const cliResponse = (
    argv: readonly string[],
    _tokenFile: string | undefined,
    currentStates: Record<string, string>,
  ): CommandRecord => {
    if (argv[0] === "node" && argv[1] === "claim") {
      const id = idOption(argv) as string;
      const fence =
        id === alphaId
          ? 41
          : id === alphaFirstId
            ? 11
            : id === alphaSecondId
              ? 12
              : id === durableId
                ? 13
                : id === betaFirstId
                  ? 21
                  : 31;
      currentStates[id] = "running";
      return command(
        argv,
        `kanthord: claimed ${id} fence ${fence} expires 2026-08-17T00:00:00.000Z heartbeat 1000ms\n` +
          `kanthord: run run-${id} attempt 1 objective-run objective-run-${id} objective-fence ${fence + 100}\n`,
      );
    }
    if (argv[0] === "node" && argv[1] === "heartbeat") {
      const id = idOption(argv) as string;
      const fence = argv[argv.indexOf("--fence") + 1] as string;
      return command(
        argv,
        `kanthord: renewed ${id} fence ${fence} expires 2026-08-17T00:00:00.000Z\n`,
      );
    }
    if (argv[0] === "node" && argv[1] === "report") {
      const id = idOption(argv) as string;
      currentStates[id] = "done";
      return command(argv, `kanthord: reported ${id} done\n`);
    }
    if (argv[0] === "node" && argv[1] === "attest") {
      const objectIndex = argv.indexOf("--object-id");
      const objectId =
        objectIndex === -1 ? undefined : (argv[objectIndex + 1] as string);
      currentStates[alphaId] = "awaiting_approval";
      if (objectId !== undefined) attestedObjectIds[alphaId] = objectId;
      return command(argv, `kanthord: reported ${alphaId} awaiting_approval\n`);
    }
    if (argv[0] === "node" && argv[1] === "close") {
      const id = idOption(argv) as string;
      currentStates[id] = "done";
      return command(argv, `kanthord: reported ${id} done\n`);
    }
    if (argv[0] === "node" && argv[1] === "list") {
      return command(
        argv,
        argv.includes("--state") ? readyListOutput() : fixtureListOutput(),
      );
    }
    if (argv[0] === "node" && argv[1] === "show") {
      const id = idOption(argv) as string;
      const view = nodeView(id, {
        state: currentStates[id],
        title: titles[id],
      });
      return command(
        argv,
        `kanthord: node ${view.id} ${view.kind} ${view.state} ${view.title}\n`,
      );
    }
    if (argv[0] === "event" && argv[1] === "list") {
      const subjectIndex = argv.indexOf("--subject");
      const subject =
        subjectIndex === -1 ? durableId : (argv[subjectIndex + 1] as string);
      return command(argv, eventOutput(subject));
    }
    throw new Error(`unexpected CLI ${argv.join(" ")}`);
  };

  const driver: ExecutionDriver = {
    name: "local",
    async identity() {
      return {
        hostname: "p1b-e1-test",
        platform: "darwin",
        architecture: "arm64",
      };
    },
    async deliverBinary() {
      return "/tmp/kanthord";
    },
    async deliverDirectory() {
      return "/tmp/plan";
    },
    async retrieveDirectory() {},
    async deliverConfig() {
      return "/tmp/config.json";
    },
    async deliverToken(token: string) {
      return token === "human-token" ? humanTokenFile : "/run/e2e/origin.token";
    },
    async probeOrigin() {
      return [];
    },
    async assertBareMachine() {},
    cli: async (argv) => {
      cliCalls.push({ role: "human", argv });
      timeline.push({ kind: "cli", argv });
      return cliResponse(argv, undefined, states);
    },
    cliAs,
    issue: (request) => issueAs("client", request),
    issueAs,
    async registerActor(role: HostRole, name: string) {
      registrations.push({ role, name });
      events.push("register");
      timeline.push({ kind: "cli", argv: ["actor", "register"] });
      return { actorId: "harness-1", tokenFile: harnessTokenFile };
    },
    async startDaemon(_config: DaemonConfig): Promise<DaemonHandle> {
      throw new Error("unused");
    },
    async startDaemonExpectingRefusal() {
      throw new Error("unused");
    },
    async collectLogs() {
      return {};
    },
  };

  return { driver, cliCalls, issueCalls, timeline, registrations, events };
}

async function runScenario(): Promise<{
  fake: FakeScenario;
  context: ReturnType<typeof context>;
}> {
  const fake = createFakeScenario();
  const recordingContext = context();
  await runP1BE1(
    recordingContext,
    fake.driver,
    profile(),
    async (scenarioContext) => {
      for (const name of [
        ...fixtureProfileAssertionNames,
        ...journeyAssertionNames,
      ]) {
        scenarioContext.assert(name, null, null);
      }
      return journey();
    },
  );
  return { fake, context: recordingContext };
}

test("calls runJourney exactly once before it registers a harness", async () => {
  const fake = createFakeScenario();
  const recordingContext = context();
  await runP1BE1(recordingContext, fake.driver, profile(), async () => {
    fake.events.unshift("journey");
    return journey();
  });

  assert.deepEqual(fake.events.slice(0, 2), ["journey", "register"]);
  assert.deepEqual(fake.registrations, [
    { role: "client", name: "p1b-e1-harness" },
  ]);
  assert.ok(
    fake.timeline.findIndex(
      (entry) => entry.kind === "cli" && entry.argv?.[0] === "actor",
    ) > -1,
  );
});

test("records its assertion names in the declared order", async () => {
  const result = await runScenario();
  const manifest = expectedAssertions as Readonly<
    Record<string, readonly string[]>
  >;
  const expected = manifest["P1B-E1"];
  assert.ok(Array.isArray(expected));
  assert.deepEqual(result.context.assertionNames(), expected);
});

test("claims alpha's first task, alpha's second task and the authored task in that order", async () => {
  const result = await runScenario();
  const taskIds = new Set([alphaFirstId, alphaSecondId, durableId]);
  const claimed = result.fake.cliCalls
    .filter(
      (call) =>
        call.argv[0] === "node" &&
        call.argv[1] === "claim" &&
        taskIds.has(idOption(call.argv) as string),
    )
    .map((call) => idOption(call.argv));
  assert.deepEqual(claimed, [alphaFirstId, alphaSecondId, durableId]);
});

test("authors both nodes under alpha before any claim", async () => {
  const result = await runScenario();
  const harnessIssues = result.fake.issueCalls.filter(
    (call) => call.request.tokenFile === harnessTokenFile,
  );
  assert.deepEqual(
    harnessIssues.map((call) => call.operationId),
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
  );
  const creates = harnessIssues.filter(
    (call) => call.operationId === "node.create",
  );
  assert.deepEqual(
    creates.map((call) => requestBody(call.request).node),
    [
      {
        kind: "task",
        title: "p1b-e1-transient",
        parentId: alphaId,
        instruction: "",
        acceptance: "",
        worker: null,
        dependsOn: [],
      },
      {
        kind: "task",
        title: "p1b-e1-durable",
        parentId: alphaId,
        instruction: "",
        acceptance: "",
        worker: null,
        dependsOn: [],
      },
    ],
  );
  const firstClaim = result.fake.timeline.findIndex(
    (entry) => entry.kind === "cli" && entry.argv?.[1] === "claim",
  );
  const lastAuthoring = result.fake.timeline.reduce(
    (last, entry, index) =>
      entry.kind === "issue" && entry.tokenFile === harnessTokenFile
        ? index
        : last,
    -1,
  );
  assert.ok(lastAuthoring < firstClaim);
});

test("signs no plan.revisions request with the harness token", async () => {
  const result = await runScenario();
  assert.equal(
    result.fake.issueCalls.some(
      (call) =>
        call.request.tokenFile === harnessTokenFile &&
        call.operationId === "plan.revisions",
    ),
    false,
  );
});

test("sends the node revision on the update and the project revision on the delete", async () => {
  const result = await runScenario();
  const update = result.fake.issueCalls.find(
    (call) => call.operationId === "node.update",
  );
  const create = result.fake.issueCalls.find(
    (call) =>
      call.operationId === "node.create" &&
      requestBody(call.request).node !== undefined &&
      (requestBody(call.request).node as Readonly<{ title?: string }>).title ===
        "p1b-e1-transient",
  );
  const deletion = result.fake.issueCalls.find(
    (call) => call.operationId === "node.delete",
  );
  assert.ok(update !== undefined);
  assert.ok(create !== undefined);
  assert.ok(deletion !== undefined);
  const createResponse = JSON.parse(create.response.body) as Readonly<{
    revision: string;
  }>;
  const deleteResponse = JSON.parse(
    result.fake.issueCalls.find((call) => call.operationId === "node.update")
      ?.response.body ?? "{}",
  ) as Readonly<{ revision: string }>;
  assert.equal(
    requestBody(update.request).fromRevision,
    createResponse.revision,
  );
  assert.equal(
    requestBody(deletion.request).fromRevision,
    deleteResponse.revision,
  );
});

test("reads the authored task as ready before it claims it", async () => {
  const result = await runScenario();
  const showIndex = result.fake.timeline.findIndex(
    (entry) =>
      entry.kind === "issue" &&
      entry.operationId === "node.show" &&
      entry.path?.endsWith(`/${durableId}`) === true,
  );
  const claimIndex = result.fake.timeline.findIndex(
    (entry) =>
      entry.kind === "cli" &&
      entry.argv?.[1] === "claim" &&
      idOption(entry.argv) === durableId,
  );
  const ready = result.context
    .assertionRecords()
    .find((record) => record.name === "durable-state-ready");
  assert.ok(showIndex > -1);
  assert.ok(showIndex < claimIndex);
  assert.deepEqual(ready?.expected, { id: durableId, state: "ready" });
});

test("reads the ready frontier as four identities, the authored task included", async () => {
  const result = await runScenario();
  const ready = result.context
    .assertionRecords()
    .find((record) => record.name === "ready-frontier");
  assert.deepEqual(ready?.expected, [
    alphaFirstId,
    durableId,
    betaFirstId,
    gammaFirstId,
  ]);
});

test("asserts gamma pending by identity and never by count", async () => {
  const result = await runScenario();
  const pending = result.context
    .assertionRecords()
    .find((record) => record.name === "gamma-state-pending");
  assert.deepEqual(pending?.expected, { id: gammaId, state: "pending" });
  assert.equal(JSON.stringify(pending?.expected).includes("count"), false);
});

test("builds the fixture profile on the three-objective axis", () => {
  assert.equal(p1bE1.plan, "three-objective");
  assert.equal(p1bE1.driver, "local");
  assert.equal(p1bE1.profile, "fixture");
});

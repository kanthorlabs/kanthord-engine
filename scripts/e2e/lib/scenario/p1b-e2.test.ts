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
  disclosureAssertionNames,
  expectedAssertions,
  fixtureProfileAssertionNames,
  journeyAssertionNames,
} from "./assertions.ts";
import { runP1BE2 } from "./p1b-e2.ts";

const projectId = "project-1";
const alphaId = "objective-alpha";
const betaId = "objective-beta";
const gammaId = "objective-gamma";
const alphaFirstId = "task-alpha-first";
const alphaSecondId = "task-alpha-second";
const betaFirstId = "task-beta-first";
const betaSecondId = "task-beta-second";
const gammaFirstId = "task-gamma-first";
const firstTokenFile = "/run/e2e/harness-first.token";
const secondTokenFile = "/run/e2e/harness-second.token";
const firstActorId = "harness-first";
const secondActorId = "harness-second";
const humanToken = "human-token";
const idempotencyKey = "p1b-e2-shared-claim-key";

const objectIds = {
  alphaFirst: "object-alpha-first",
  alphaSecond: "object-alpha-second",
  betaFirst: "object-beta-first",
  betaSecond: "object-beta-second",
  alphaAttest: "object-alpha-attest",
  betaAttest: "object-beta-attest",
} as const;

type AssertionRecord = Readonly<{
  name: string;
  expected: unknown;
  actual: unknown;
}>;

type CliCall = Readonly<{
  role: HostRole;
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
  phase: "issue-start" | "issue-finish";
  operationId: string;
  path: string;
  tokenFile?: string;
}>;

type Registration = Readonly<{ role: HostRole; name: string }>;

type FakeScenario = Readonly<{
  driver: ExecutionDriver;
  cliCalls: readonly CliCall[];
  issueCalls: readonly IssueCall[];
  timeline: readonly TimelineEntry[];
  registrations: readonly Registration[];
}>;

type RecordingContext = ScenarioContext & {
  assertionNames(): readonly string[];
  assertionRecords(): readonly AssertionRecord[];
};

function command(
  argv: readonly string[],
  stdout = "",
  exitCode = 0,
): CommandRecord {
  return {
    argv,
    cwd: "/tmp/p1b-e2-test",
    exitCode,
    stdout,
    stderr: "",
  };
}

function context(): RecordingContext {
  const records: AssertionRecord[] = [];
  return {
    tag: "p1b-e2-test",
    scenarioId: "P1B-E2",
    bundleDirectory: "/tmp/p1b-e2-test-bundle",
    take: () => undefined,
    sink: { print: () => undefined, record: () => undefined },
    assert(name: string, expected: unknown, actual: unknown): void {
      records.push({ name, expected, actual });
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
      first: objectIds.alphaFirst,
      second: objectIds.alphaSecond,
      betaFirst: objectIds.betaFirst,
      betaSecond: objectIds.betaSecond,
      alphaAttest: objectIds.alphaAttest,
      betaAttest: objectIds.betaAttest,
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
    token: humanToken,
  };
}

function pathWithoutQuery(request: HttpRequest): string {
  return request.path.split("?")[0] as string;
}

function operationId(request: HttpRequest): string {
  const path = pathWithoutQuery(request);
  if (path === "/v1/status") return "system.status";
  if (path.startsWith("/v1/node/") && path.endsWith("/claim"))
    return "node.claim";
  if (path.startsWith("/v1/node/") && path.endsWith("/report"))
    return "node.report";
  if (path.startsWith("/v1/node/")) return "node.show";
  if (path === "/v1/node") return "node.list";
  throw new Error(`unexpected request ${request.method} ${request.path}`);
}

function graphNodes(
  states: Readonly<Record<string, string>>,
): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      id: alphaId,
      projectId,
      kind: "objective",
      title: "Alpha",
      state: states[alphaId],
      blockReason: null,
      discardReason: null,
      parentId: null,
      dependencies: [],
    },
    {
      id: betaId,
      projectId,
      kind: "objective",
      title: "Beta",
      state: states[betaId],
      blockReason: null,
      discardReason: null,
      parentId: null,
      dependencies: [],
    },
    {
      id: gammaId,
      projectId,
      kind: "objective",
      title: "Gamma",
      state: states[gammaId],
      blockReason: null,
      discardReason: null,
      parentId: null,
      dependencies: [],
    },
    {
      id: alphaFirstId,
      projectId,
      kind: "task",
      title: "alpha/01-first",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: alphaId,
      dependencies: [],
    },
    {
      id: alphaSecondId,
      projectId,
      kind: "task",
      title: "alpha/02-second",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: alphaId,
      dependencies: [],
    },
    {
      id: betaFirstId,
      projectId,
      kind: "task",
      title: "beta/01-first",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: betaId,
      dependencies: [],
    },
    {
      id: betaSecondId,
      projectId,
      kind: "task",
      title: "beta/02-second",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: betaId,
      dependencies: [],
    },
    {
      id: gammaFirstId,
      projectId,
      kind: "task",
      title: "gamma/01-first",
      state: states[gammaFirstId],
      blockReason: null,
      discardReason: null,
      parentId: gammaId,
      dependencies: [],
    },
  ];
}

function claimFence(id: string): number {
  if (id === alphaFirstId) return 11;
  if (id === alphaSecondId) return 12;
  if (id === betaFirstId) return 21;
  if (id === betaSecondId) return 22;
  throw new Error(`unexpected claim ${id}`);
}

function claimOutput(id: string): string {
  const fence = claimFence(id);
  return (
    `kanthord: claimed ${id} fence ${String(fence)} expires 2026-08-17T00:00:00.000Z heartbeat 1000ms\n` +
    `kanthord: run run-${id} attempt 1 objective-run objective-run-${id} objective-fence ${String(fence + 100)}\n`
  );
}

function nodeShowLine(
  id: string,
  states: Readonly<Record<string, string>>,
): string {
  const kind = id.startsWith("objective-") ? "objective" : "task";
  return `kanthord: node ${id} ${kind} ${states[id]} ${id}\n`;
}

function eventOutput(
  type: string,
  alphaActorId: string,
  betaActorId: string,
): string {
  const rows: ReadonlyArray<readonly [string, string]> =
    type === "lease.claimed"
      ? [
          [alphaActorId, alphaFirstId],
          [betaActorId, betaFirstId],
          [alphaActorId, gammaFirstId],
          [betaActorId, gammaFirstId],
        ]
      : [
          [alphaActorId, alphaFirstId],
          [alphaActorId, alphaSecondId],
          [betaActorId, betaFirstId],
          [betaActorId, betaSecondId],
        ];
  return rows
    .map(
      ([actor, subject], index) =>
        `kanthord: event 2026-08-17T00:00:00.000Z event-${type}-${String(index)} harness/${actor} ${type} task/${subject} {}\n`,
    )
    .join("");
}

function createFakeScenario(winner: "first" | "second"): FakeScenario {
  const cliCalls: CliCall[] = [];
  const issueCalls: IssueCall[] = [];
  const timeline: TimelineEntry[] = [];
  const registrations: Registration[] = [];
  const states: Record<string, string> = {
    [alphaId]: "running",
    [betaId]: "pending",
    [gammaId]: "pending",
    [gammaFirstId]: "ready",
  };
  const alphaTokenFile = winner === "first" ? firstTokenFile : secondTokenFile;
  const betaTokenFile = winner === "first" ? secondTokenFile : firstTokenFile;
  const alphaActorId = winner === "first" ? firstActorId : secondActorId;
  const betaActorId = winner === "first" ? secondActorId : firstActorId;
  let closes = 0;

  const issueAs = async (
    role: HostRole,
    request: HttpRequest,
  ): Promise<HttpResponse> => {
    const operation = operationId(request);
    const isRace = request.path === `/v1/node/${alphaFirstId}/claim`;
    if (isRace) {
      timeline.push({
        phase: "issue-start",
        operationId: operation,
        path: request.path,
        tokenFile: request.tokenFile,
      });
    }
    await Promise.resolve();

    let response: HttpResponse;
    if (pathWithoutQuery(request) === "/v1/status") {
      const auth = request.headers.Authorization;
      if (auth !== `Bearer ${humanToken}`) {
        response = {
          status: 401,
          body: JSON.stringify({
            error: { code: "unauthenticated", message: "no token" },
          }),
        };
      } else if (request.headers.Origin !== undefined) {
        response = {
          status: 403,
          body: JSON.stringify({
            error: { code: "origin-forbidden", message: "origin refused" },
          }),
        };
      } else if (request.headers.Host === "not-allowed.invalid:1") {
        response = {
          status: 403,
          body: JSON.stringify({
            error: { code: "host-forbidden", message: "host refused" },
          }),
        };
      } else if (request.omitHost) {
        response = {
          status: 403,
          body: JSON.stringify({
            error: { code: "host-forbidden", message: "host refused" },
          }),
        };
      } else {
        response = { status: 200, body: JSON.stringify({ ok: true }) };
      }
    } else if (operation === "node.list") {
      response = {
        status: 200,
        body: JSON.stringify({ nodes: graphNodes(states) }),
      };
    } else if (operation === "node.show") {
      const id = request.path.slice("/v1/node/".length);
      if (id === alphaId) {
        response = {
          status: 200,
          body: JSON.stringify({
            id,
            state: "awaiting_approval",
            attestedObjectId: objectIds.alphaAttest,
          }),
        };
      } else if (id === betaId) {
        response = {
          status: 200,
          body: JSON.stringify({
            id,
            state: "awaiting_approval",
            attestedObjectId: objectIds.betaAttest,
          }),
        };
      } else {
        throw new Error(`unexpected node.show ${id}`);
      }
    } else if (operation === "node.claim") {
      const id = request.path.slice("/v1/node/".length, -"/claim".length);
      if (id === alphaFirstId) {
        response =
          request.tokenFile === alphaTokenFile
            ? {
                status: 200,
                body: JSON.stringify({ lease: { subjectId: alphaFirstId } }),
              }
            : {
                status: 409,
                body: JSON.stringify({
                  error: { code: "lease-held", message: "held" },
                }),
              };
      } else if (id === gammaFirstId) {
        response =
          request.tokenFile === alphaTokenFile
            ? {
                status: 200,
                body: JSON.stringify({ lease: { subjectId: gammaFirstId } }),
              }
            : {
                status: 409,
                body: JSON.stringify({
                  error: {
                    code: "lease-held",
                    message: "held by the alpha actor",
                  },
                }),
              };
      } else if (id === alphaSecondId || id === alphaId) {
        response = {
          status: 409,
          body: JSON.stringify({
            error: { code: "lease-held", message: "held" },
          }),
        };
      } else if (id === betaFirstId) {
        response = {
          status: 200,
          body: JSON.stringify({ lease: { subjectId: betaFirstId } }),
        };
      } else {
        throw new Error(`unexpected claim ${id}`);
      }
    } else if (operation === "node.report") {
      response = {
        status: 403,
        body: JSON.stringify({
          error: { code: "actor-forbidden", message: "actor is forbidden" },
        }),
      };
    } else {
      throw new Error(`unexpected operation ${operation}`);
    }

    if (isRace) {
      timeline.push({
        phase: "issue-finish",
        operationId: operation,
        path: request.path,
        tokenFile: request.tokenFile,
      });
    }
    issueCalls.push({ role, request, operationId: operation, response });
    return response;
  };

  const cliAs = async (
    role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> => {
    cliCalls.push({ role, argv, tokenFile: options?.tokenFile });
    return cliResponse(argv);
  };

  const cliResponse = (argv: readonly string[]): CommandRecord => {
    if (argv[0] === "node" && argv[1] === "claim") {
      const id = argv[argv.indexOf("--id") + 1] as string;
      return command(argv, claimOutput(id));
    }
    if (argv[0] === "node" && argv[1] === "heartbeat") {
      return command(
        argv,
        `kanthord: renewed ${argv[argv.indexOf("--id") + 1] as string}\n`,
      );
    }
    if (argv[0] === "node" && argv[1] === "report") {
      return command(
        argv,
        `kanthord: reported ${argv[argv.indexOf("--id") + 1] as string} done\n`,
      );
    }
    if (argv[0] === "node" && argv[1] === "attest") {
      const id = argv[argv.indexOf("--id") + 1] as string;
      states[id] = "awaiting_approval";
      return command(argv, `kanthord: reported ${id} awaiting_approval\n`);
    }
    if (argv[0] === "node" && argv[1] === "close") {
      const id = argv[argv.indexOf("--id") + 1] as string;
      states[id] = "done";
      closes += 1;
      if (closes >= 2) {
        states[gammaId] = "ready";
      }
      return command(argv, `kanthord: reported ${id} done\n`);
    }
    if (argv[0] === "node" && argv[1] === "show") {
      const id = argv[argv.length - 1] as string;
      return command(argv, nodeShowLine(id, states));
    }
    if (argv[0] === "event" && argv[1] === "list") {
      const typeIndex = argv.indexOf("--type");
      const type =
        typeIndex === -1 ? "outcome.reported" : (argv[typeIndex + 1] as string);
      return command(argv, eventOutput(type, alphaActorId, betaActorId));
    }
    throw new Error(`unexpected CLI ${argv.join(" ")}`);
  };

  const driver: ExecutionDriver = {
    name: "podman",
    async identity() {
      return {
        hostname: "p1b-e2-test",
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
    async deliverToken() {
      return "/run/e2e/token";
    },
    async probeOrigin() {
      return [];
    },
    async assertBareMachine() {},
    cli: async (argv) => cliAs("client", argv),
    cliAs,
    issue: (request) => issueAs("client", request),
    issueAs,
    async registerActor(role: HostRole, name: string) {
      registrations.push({ role, name });
      return role === "client"
        ? { actorId: firstActorId, tokenFile: firstTokenFile }
        : { actorId: secondActorId, tokenFile: secondTokenFile };
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

  return { driver, cliCalls, issueCalls, timeline, registrations };
}

async function runScenario(
  winner: "first" | "second" = "first",
): Promise<{ fake: FakeScenario; context: RecordingContext }> {
  const fake = createFakeScenario(winner);
  const recordingContext = context();
  await runP1BE2(
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

test("registers one harness per client container", async () => {
  const result = await runScenario();
  assert.deepEqual(result.fake.registrations, [
    { role: "client", name: "p1b-e2-first" },
    { role: "client2", name: "p1b-e2-second" },
  ]);
});

test("issues both claims of phase 2 before it awaits either", async () => {
  const result = await runScenario();
  const starts = result.fake.timeline.filter(
    (entry) => entry.phase === "issue-start",
  );
  const finishes = result.fake.timeline.filter(
    (entry) => entry.phase === "issue-finish",
  );
  assert.equal(starts.length, 2);
  assert.equal(finishes.length, 2);
  assert.ok(
    starts.every((entry) => entry.path === `/v1/node/${alphaFirstId}/claim`),
  );
  const firstFinish = result.fake.timeline.findIndex(
    (entry) => entry.phase === "issue-finish",
  );
  assert.ok(firstFinish >= 2);
});

test("asserts one success and one lease-held without asserting which client won", async () => {
  for (const winner of ["first", "second"] as const) {
    const result = await runScenario(winner);
    const raceSuccess = result.context
      .assertionRecords()
      .find((record) => record.name === "race-one-success");
    const raceHeld = result.context
      .assertionRecords()
      .find((record) => record.name === "race-one-lease-held");
    assert.deepEqual(raceSuccess?.actual, 200);
    assert.deepEqual(raceHeld?.actual, { status: 409, code: "lease-held" });
  }
});

test("records its assertion names in the declared order", async () => {
  const result = await runScenario();
  const manifest = expectedAssertions as Readonly<
    Record<string, readonly string[] | "non-empty">
  >;
  const expected = manifest["P1B-E2"];
  assert.ok(Array.isArray(expected));
  assert.deepEqual(
    [...result.context.assertionNames(), ...disclosureAssertionNames],
    expected,
  );
});

test("sends one idempotency key on one node id from two actors", async () => {
  const result = await runScenario();
  const idempotent = result.fake.issueCalls.filter(
    (call) => call.request.headers["Idempotency-Key"] !== undefined,
  );
  assert.equal(idempotent.length, 2);
  assert.equal(
    idempotent[0]?.request.headers["Idempotency-Key"],
    idempotencyKey,
  );
  assert.equal(
    idempotent[1]?.request.headers["Idempotency-Key"],
    idempotencyKey,
  );
  assert.equal(idempotent[0]?.request.path, idempotent[1]?.request.path);
  assert.equal(idempotent[0]?.request.path, `/v1/node/${gammaFirstId}/claim`);
  assert.notEqual(
    idempotent[0]?.request.tokenFile,
    idempotent[1]?.request.tokenFile,
  );
});

test("runs the transport cases from the second client", async () => {
  const result = await runScenario();
  const transport = result.fake.issueCalls.filter(
    (call) => call.request.path === "/v1/status",
  );
  assert.ok(transport.length > 0);
  assert.ok(transport.every((call) => call.role === "client2"));
});

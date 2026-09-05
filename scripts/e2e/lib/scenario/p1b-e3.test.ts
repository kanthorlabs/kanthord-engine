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
import { RunnerError } from "../errors.ts";
import type { ScenarioContext } from "./context.ts";
import type { ScenarioProfile } from "../profile/index.ts";
import type { JourneyOptions, JourneyResult } from "./journey.ts";
import {
  disclosureAssertionNames,
  expectedAssertions,
  fixtureProfileAssertionNames,
  journeyAssertionNames,
} from "./assertions.ts";
import {
  runP1BE3,
  takeoverLeaseTtlMs,
  takeoverPollDeadlineMs,
  takeoverPollIntervalMs,
  type P1B3Clock,
  type P1B3Result,
} from "./p1b-e3.ts";

const projectId = "project-1";
const taskId = "task-alpha-first";
const betaFirstId = "task-beta-first";
const firstTokenFile = "/run/e2e/e3-first.token";
const secondTokenFile = "/run/e2e/e3-second.token";
const secondActorId = "harness-e3-second";
const humanToken = "human-token";
const firstFence = 41;
const firstExpiry = 10000;
const takeoverExpiry = 20000;
const defaultTakeoverFence = 100;
const firstRunId = "run-task-alpha-first";
const takeoverRunId = "run-task-alpha-takeover";

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
  response: HttpResponse;
}>;

type Registration = Readonly<{ role: HostRole; name: string }>;

type FakeScenario = Readonly<{
  driver: ExecutionDriver;
  cliCalls: readonly CliCall[];
  issueCalls: readonly IssueCall[];
  registrations: readonly Registration[];
}>;

type RecordingContext = ScenarioContext & {
  logs(): Readonly<Record<string, string>>;
  assertionNames(): readonly string[];
  assertionRecords(): readonly AssertionRecord[];
};

type FakeClock = Readonly<{
  clock: P1B3Clock;
  waits: readonly number[];
}>;

type FakeOptions = Readonly<{
  takeoverFence?: number;
  neverTakeover?: boolean;
  eventRecordCount?: number;
  legacyHeartbeatOutput?: boolean;
}>;

function command(
  argv: readonly string[],
  stdout = "",
  exitCode = 0,
): CommandRecord {
  return {
    argv,
    cwd: "/tmp/p1b-e3-test",
    exitCode,
    stdout,
    stderr: "",
  };
}

function context(): RecordingContext {
  const records: AssertionRecord[] = [];
  const attached: Record<string, string> = {};
  return {
    tag: "p1b-e3-test",
    scenarioId: "P1B-E3",
    bundleDirectory: "/tmp/p1b-e3-test-bundle",
    take: () => undefined,
    sink: { print: () => undefined, record: () => undefined },
    assert(name: string, expected: unknown, actual: unknown): void {
      records.push({ name, expected, actual });
      assert.deepEqual(actual, expected);
    },
    attachLog(name: string, text: string): void {
      attached[name] = text;
    },
    logs(): Readonly<Record<string, string>> {
      return attached;
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
    planDirectory: "test/e2e/fixtures/two-objective/plan",
    expectedObjectiveCount: 2,
    expectedTaskCount: 4,
    expectedPendingTaskCount: 2,
    expectedReadyTaskCount: 2,
    fixtureRoot: "test/e2e/fixtures/two-objective",
    expectedObjectIds: {
      first: "object-e3-first",
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

function fakeClock(): FakeClock {
  let now = 0;
  const waits: number[] = [];
  return {
    clock: {
      now: () => now,
      wait: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    },
    waits,
  };
}

function createFakeScenario(
  clock: P1B3Clock,
  options: FakeOptions = {},
): FakeScenario {
  const takeoverFence = options.takeoverFence ?? defaultTakeoverFence;
  const neverTakeover = options.neverTakeover ?? false;
  const eventRecordCount = options.eventRecordCount ?? 1;
  const legacyHeartbeatOutput = options.legacyHeartbeatOutput ?? false;
  const cliCalls: CliCall[] = [];
  const issueCalls: IssueCall[] = [];
  const registrations: Registration[] = [];

  const issueAs = async (
    role: HostRole,
    request: HttpRequest,
  ): Promise<HttpResponse> => {
    const path = request.path.split("?")[0] as string;
    let response: HttpResponse;
    if (path === "/v1/node") {
      response = {
        status: 200,
        body: JSON.stringify({
          nodes: [
            { id: taskId, kind: "task", state: "ready" },
            { id: betaFirstId, kind: "task", state: "ready" },
          ],
        }),
      };
    } else if (path.endsWith("/claim")) {
      if (neverTakeover || clock.now() < firstExpiry) {
        response = {
          status: 409,
          body: JSON.stringify({
            error: { code: "lease-held", message: "held" },
          }),
        };
      } else {
        response = {
          status: 200,
          body: JSON.stringify({
            lease: { fence: takeoverFence, expiresAt: takeoverExpiry },
            objectiveLease: {
              fence: takeoverFence,
              expiresAt: takeoverExpiry,
            },
            runFence: takeoverFence,
            runId: takeoverRunId,
            objectiveRunId: "objective-run-task-alpha-takeover",
            objectiveRunFence: takeoverFence,
          }),
        };
      }
    } else if (path.endsWith("/report")) {
      response = {
        status: 409,
        body: JSON.stringify({
          error: { code: "lease-held", message: "stale fence" },
        }),
      };
    } else if (path.startsWith("/v1/node/")) {
      response = {
        status: 200,
        body: JSON.stringify({ id: taskId, state: "running" }),
      };
    } else {
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
    issueCalls.push({ role, request, response });
    return response;
  };

  const cliAs = async (
    role: HostRole,
    argv: readonly string[],
    options2?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> => {
    cliCalls.push({ role, argv, tokenFile: options2?.tokenFile });
    if (argv[0] === "node" && argv[1] === "claim") {
      const id = argv[argv.indexOf("--id") + 1] as string;
      return command(
        argv,
        (legacyHeartbeatOutput
          ? `kanthord: claimed ${id} lease-fence ${String(firstFence)} expires ${String(firstExpiry)} heartbeat 1000ms\n`
          : `kanthord: claimed ${id} lease-fence ${String(firstFence)} expires ${String(firstExpiry)}\n`) +
          `kanthord: run ${firstRunId} run-fence ${String(firstFence)} attempt 1 objective-run objective-run-${id} objective-run-fence ${String(firstFence)} objective-lease-fence ${String(firstFence)}\n`,
      );
    }
    if (argv[0] === "node" && argv[1] === "report") {
      const id = argv[argv.indexOf("--id") + 1] as string;
      return command(argv, `kanthord: reported ${id} done\n`);
    }
    if (argv[0] === "node" && argv[1] === "show") {
      const id = argv[argv.length - 1] as string;
      return command(argv, `kanthord: node ${id} task done ${id}\n`);
    }
    if (argv[0] === "event" && argv[1] === "list") {
      const rows = Array.from({ length: eventRecordCount }, (_, index) => {
        const actor =
          index === 0 ? secondActorId : `harness-e3-extra-${String(index)}`;
        return `kanthord: event 2026-08-17T00:00:00.000Z event-${String(index)} harness/${actor} outcome.reported node/${taskId} {}`;
      });
      return command(argv, rows.join("\n") + "\n");
    }
    throw new Error(`unexpected CLI ${argv.join(" ")}`);
  };

  const driver: ExecutionDriver = {
    name: "podman",
    async identity() {
      return {
        hostname: "p1b-e3-test",
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
        ? { actorId: "harness-e3-first", tokenFile: firstTokenFile }
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

  return { driver, cliCalls, issueCalls, registrations };
}

type Pieces = {
  fake: FakeScenario;
  context: RecordingContext;
  clock: FakeClock;
  journeyOptions?: JourneyOptions;
};

function makePieces(options: FakeOptions = {}): Pieces {
  const clock = fakeClock();
  const fake = createFakeScenario(clock.clock, options);
  const recordingContext = context();
  return { fake, context: recordingContext, clock };
}

function journeyStub(pieces: Pieces) {
  return async (
    scenarioContext: ScenarioContext,
    _driver: ExecutionDriver,
    _profile: ScenarioProfile,
    journeyOptions?: JourneyOptions,
  ): Promise<JourneyResult> => {
    pieces.journeyOptions = journeyOptions;
    for (const name of [
      ...fixtureProfileAssertionNames,
      ...journeyAssertionNames,
    ]) {
      scenarioContext.assert(name, null, null);
    }
    return journey();
  };
}

function drive(pieces: Pieces): Promise<P1B3Result> {
  return runP1BE3(
    pieces.context,
    pieces.fake.driver,
    profile(),
    journeyStub(pieces),
    pieces.clock.clock,
  );
}

async function runScenario(options: FakeOptions = {}): Promise<Pieces> {
  const pieces = makePieces(options);
  await drive(pieces);
  return pieces;
}

function failedRecord(pieces: Pieces): AssertionRecord | undefined {
  return pieces.context.assertionRecords().find((record) => {
    try {
      assert.deepEqual(record.actual, record.expected);
      return false;
    } catch {
      return true;
    }
  });
}

test("configures the daemon with a lease term of 2000 ms", async () => {
  const pieces = await runScenario();
  assert.equal(takeoverLeaseTtlMs, 2000);
  assert.equal(pieces.journeyOptions?.leaseTtlMs, 2000);
});

test("runP1BE3 rejects legacy heartbeat claim output", async () => {
  const pieces = makePieces({ legacyHeartbeatOutput: true });

  await assert.rejects(drive(pieces));
  assert.equal(pieces.fake.cliCalls.length, 1);
});

test("polls at 250 ms to a 60000 ms deadline", async () => {
  const pieces = await runScenario();
  assert.equal(takeoverPollIntervalMs, 250);
  assert.equal(takeoverPollDeadlineMs, 60000);
  assert.ok(pieces.clock.waits.length > 0);
  assert.ok(pieces.clock.waits.every((ms) => ms === takeoverPollIntervalMs));
  const elapsed = pieces.clock.waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(elapsed >= firstExpiry);
  assert.ok(elapsed < takeoverPollDeadlineMs);
});

test("sleeps no lease term", async () => {
  const pieces = await runScenario();
  assert.ok(pieces.clock.waits.length > 0);
  assert.ok(pieces.clock.waits.every((ms) => ms <= takeoverPollIntervalMs));
  assert.ok(pieces.clock.waits.some((ms) => ms === takeoverPollIntervalMs));
});

test("asserts the takeover fence is greater than the first", async () => {
  const pieces = makePieces({ takeoverFence: firstFence });
  await assert.rejects(drive(pieces));
  assert.equal(failedRecord(pieces)?.name, "takeover-fence-greater");
});

test("keeps its diagnostics on timeout", async () => {
  const pieces = makePieces({ neverTakeover: true });
  await assert.rejects(drive(pieces), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "assertion-failed");
    assert.match(error.message, /elapsed \d+ ms/);
    assert.match(error.message, /last status 409/);
    assert.match(error.message, /last body/);
    return true;
  });
  const diagnostics = pieces.context.logs()["takeover-timeout"];
  assert.ok(diagnostics !== undefined);
  assert.match(diagnostics, /elapsed \d+ ms/);
  assert.match(diagnostics, /last status 409/);
  assert.match(diagnostics, /last body/);
});

test("asserts exactly one outcome.reported record naming the second actor", async () => {
  const pieces = makePieces({ eventRecordCount: 2 });
  await assert.rejects(drive(pieces));
  assert.equal(failedRecord(pieces)?.name, "outcome-events-count");
});

test("passes run authority to the stale and takeover reports", async () => {
  const pieces = await runScenario();
  const staleReport = pieces.fake.issueCalls.find((call) =>
    call.request.path.endsWith("/report"),
  );
  assert.ok(staleReport !== undefined);
  assert.deepEqual(JSON.parse(staleReport.request.body ?? "{}"), {
    report: "accepted",
    fence: firstFence,
    runId: firstRunId,
    runFence: firstFence,
    objectId: "object-e3-first",
  });

  const takeoverReport = pieces.fake.cliCalls.find(
    (call) => call.argv[0] === "node" && call.argv[1] === "report",
  );
  assert.deepEqual(takeoverReport?.argv, [
    "node",
    "report",
    "--id",
    taskId,
    "--outcome",
    "accepted",
    "--object-id",
    "object-e3-first",
    "--fence",
    String(defaultTakeoverFence),
    "--run-id",
    takeoverRunId,
    "--run-fence",
    String(defaultTakeoverFence),
  ]);
});

test("records its assertion names in the declared order", async () => {
  const pieces = await runScenario();
  const manifest = expectedAssertions as Readonly<
    Record<string, readonly string[]>
  >;
  const expected = manifest["P1B-E3"];
  assert.ok(Array.isArray(expected));
  assert.deepEqual(
    [...pieces.context.assertionNames(), ...disclosureAssertionNames],
    expected,
  );
});

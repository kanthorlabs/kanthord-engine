import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord } from "../command.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
} from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";
import {
  attestAssertionNames,
  attestObjective,
  harnessTaskAssertionNames,
  registerHarness,
  runHarnessTask,
} from "./harness.ts";

type Assertion = Readonly<{
  name: string;
  expected: unknown;
  actual: unknown;
}>;

type HarnessFake = Readonly<{
  driver: ExecutionDriver;
  cliCalls: readonly Readonly<{
    role: HostRole;
    argv: readonly string[];
  }>[];
  registrations: readonly Readonly<{ role: HostRole; name: string }>[];
}>;

function command(argv: readonly string[], stdout: string): CommandRecord {
  return {
    argv,
    cwd: "/tmp/harness-test",
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function contextWith(assertions: Assertion[]): ScenarioContext {
  return {
    tag: "harness-test",
    scenarioId: "P1-E1",
    bundleDirectory: "/tmp/harness-test",
    take: () => undefined,
    sink: { print: () => undefined, record: () => undefined },
    assert(name: string, expected: unknown, actual: unknown): void {
      assertions.push({ name, expected, actual });
      assert.deepEqual(actual, expected);
    },
    daemonHost: null,
    clientHost: null,
  };
}

function fakeDriver(
  driverOptions: Readonly<{ legacyHeartbeatOutput?: boolean }> = {},
): HarnessFake {
  const cliCalls: Readonly<{
    role: HostRole;
    argv: readonly string[];
  }>[] = [];
  const registrations: Readonly<{ role: HostRole; name: string }>[] = [];

  const driver: ExecutionDriver = {
    name: "local",
    async identity() {
      return {
        hostname: "harness-test",
        platform: "darwin",
        architecture: "arm64",
      };
    },
    async deliverBinary() {
      return "/tmp/kanthord";
    },
    async deliverDirectory() {
      return "/tmp/harness-directory";
    },
    async retrieveDirectory() {},
    async deliverConfig() {
      return "/tmp/harness-config.json";
    },
    async deliverToken() {
      return "/tmp/harness-token";
    },
    async probeOrigin() {
      return [];
    },
    async assertBareMachine() {},
    async cli(argv: readonly string[]) {
      return command(argv, "");
    },
    async cliAs(
      role: HostRole,
      argv: readonly string[],
      options?: Readonly<{ tokenFile?: string }>,
    ) {
      const effectiveArgv =
        options?.tokenFile === undefined
          ? [...argv]
          : [...argv, "--api-token-file", options.tokenFile];
      cliCalls.push({ role, argv: effectiveArgv });
      if (argv[1] === "claim") {
        return command(
          effectiveArgv,
          (driverOptions.legacyHeartbeatOutput === true
            ? "kanthord: claimed task-1 lease-fence 7 expires 2026-08-17T00:00:00.000Z heartbeat 1000ms\n"
            : "kanthord: claimed task-1 lease-fence 7 expires 2026-08-17T00:00:00.000Z\n") +
            "kanthord: run run-1 run-fence 5 attempt 1 objective-run objective-run-1 objective-run-fence 2 objective-lease-fence 3\n",
        );
      }
      if (argv[1] === "renew") {
        return command(
          effectiveArgv,
          "kanthord: renewed task-1 fence 7 expires 2026-08-17T00:00:00.000Z\n",
        );
      }
      if (argv[1] === "report") {
        return command(effectiveArgv, "kanthord: reported task-1 done\n");
      }
      if (argv[1] === "attest") {
        return command(
          effectiveArgv,
          "kanthord: reported objective-1 awaiting_approval\n",
        );
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    },
    issue: async () => ({ status: 200, body: "{}" }),
    async issueAs() {
      return { status: 200, body: "{}" };
    },
    async registerActor(role: HostRole, name: string) {
      registrations.push({ role, name });
      return { actorId: "actor-1", tokenFile: "/tmp/client-1.token" };
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

  return { driver, cliCalls, registrations };
}

function identity(): Readonly<{
  actorId: string;
  tokenFile: string;
  role: HostRole;
}> {
  return {
    actorId: "actor-1",
    tokenFile: "/tmp/client-1.token",
    role: "client",
  };
}

test("registerHarness returns the actor id and the token file and no token", async () => {
  const fake = fakeDriver();

  const result = await registerHarness(fake.driver, "client", "harness-one");

  assert.deepEqual(result, identity());
  assert.deepEqual(fake.registrations, [
    { role: "client", name: "harness-one" },
  ]);
  assert.deepEqual(Object.keys(result), ["actorId", "tokenFile", "role"]);
  assert.equal("token" in result, false);
});

test("runHarnessTask issues claim, renew and report in that order", async () => {
  const fake = fakeDriver();
  const assertions: Assertion[] = [];

  await runHarnessTask(contextWith(assertions), fake.driver, identity(), {
    nodeId: "task-1",
    objectId: "object-1",
    label: "alpha-1",
  });

  assert.deepEqual(fake.cliCalls, [
    {
      role: "client",
      argv: [
        "node",
        "claim",
        "--id",
        "task-1",
        "--api-token-file",
        "/tmp/client-1.token",
      ],
    },
    {
      role: "client",
      argv: [
        "node",
        "renew",
        "--id",
        "task-1",
        "--fence",
        "7",
        "--run-id",
        "run-1",
        "--run-fence",
        "5",
        "--api-token-file",
        "/tmp/client-1.token",
      ],
    },
    {
      role: "client",
      argv: [
        "node",
        "report",
        "--id",
        "task-1",
        "--outcome",
        "accepted",
        "--object-id",
        "object-1",
        "--fence",
        "7",
        "--run-id",
        "run-1",
        "--run-fence",
        "5",
        "--api-token-file",
        "/tmp/client-1.token",
      ],
    },
  ]);
});

test("runHarnessTask rejects legacy heartbeat claim output", async () => {
  const fake = fakeDriver({ legacyHeartbeatOutput: true });

  await assert.rejects(
    runHarnessTask(contextWith([]), fake.driver, identity(), {
      nodeId: "task-1",
      objectId: "object-1",
      label: "alpha-1",
    }),
  );
  assert.equal(fake.cliCalls.length, 1);
});

test("runHarnessTask returns both run authorities and the object id it parsed", async () => {
  const fake = fakeDriver();

  const result = await runHarnessTask(
    contextWith([]),
    fake.driver,
    identity(),
    { nodeId: "task-1", objectId: "object-1", label: "alpha-1" },
  );

  assert.deepEqual(result, {
    leaseFence: 7,
    runId: "run-1",
    runFence: 5,
    objectiveRunId: "objective-run-1",
    objectiveRunFence: 2,
    objectiveLeaseFence: 3,
    attemptNo: 1,
    objectId: "object-1",
  });
});

test("runHarnessTask records its four assertion names in order", async () => {
  const fake = fakeDriver();
  const assertions: Assertion[] = [];

  await runHarnessTask(contextWith(assertions), fake.driver, identity(), {
    nodeId: "task-1",
    objectId: "object-1",
    label: "alpha-1",
  });

  assert.deepEqual(
    assertions.map(({ name }) => name),
    [
      "alpha-1-claim-status",
      "alpha-1-claim-attempt",
      "alpha-1-renew-status",
      "alpha-1-report-status",
    ],
  );
  assert.deepEqual(
    assertions.map(({ name }) => name),
    harnessTaskAssertionNames("alpha-1"),
  );
});

test("attestObjective sends the fence and the object id", async () => {
  const fake = fakeDriver();
  const assertions: Assertion[] = [];

  const objectiveInput = {
    nodeId: "objective-1",
    fence: 7,
    runId: "objective-run-1",
    runFence: 3,
    objectId: "object-alpha",
    label: "alpha",
  };
  await attestObjective(
    contextWith(assertions),
    fake.driver,
    identity(),
    objectiveInput as Parameters<typeof attestObjective>[3],
  );

  assert.deepEqual(fake.cliCalls, [
    {
      role: "client",
      argv: [
        "node",
        "attest",
        "--id",
        "objective-1",
        "--fence",
        "7",
        "--run-id",
        "objective-run-1",
        "--run-fence",
        "3",
        "--object-id",
        "object-alpha",
        "--api-token-file",
        "/tmp/client-1.token",
      ],
    },
  ]);
  assert.deepEqual(
    assertions.map(({ name }) => name),
    attestAssertionNames("alpha"),
  );
});

test("two labels produce two disjoint name sets", () => {
  const first = new Set([
    ...harnessTaskAssertionNames("alpha-1"),
    ...attestAssertionNames("alpha"),
  ]);
  const second = new Set([
    ...harnessTaskAssertionNames("beta-1"),
    ...attestAssertionNames("beta"),
  ]);

  assert.equal(
    [...first].some((name) => second.has(name)),
    false,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { profileFieldNames } from "./index.ts";
import { createFixtureProfile } from "./fixture.ts";
import { createRealProfile } from "./real.ts";
import { createLedger } from "../resources.ts";
import { secrets } from "../redact.ts";
import { RunnerError } from "../errors.ts";
import { fixtureObjectIds } from "../../../../test/helpers/remote/seed.ts";
import { httpWrongCredential } from "../../../../test/helpers/remote/http.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { ExecutionDriver, HostRole } from "../driver/index.ts";
import type { OriginProbeInput, ProbeRow } from "../driver/origin-probe.ts";
import type { ResourceHandle } from "../resources.ts";

const expectedFieldNames = [
  "name",
  "origin",
  "credentialArguments",
  "defaultBranch",
  "planDirectory",
  "expectedObjectiveCount",
  "expectedTaskCount",
  "fixtureRoot",
  "expectedObjectIds",
] as const;

function fakeContext(taken: {
  take: ReturnType<typeof createLedger>["take"];
}): ScenarioContext {
  return {
    tag: "profile-test",
    scenarioId: "P1-E1",
    bundleDirectory: "/tmp/profile-test-bundle",
    take: taken.take,
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(): void {},
    daemonHost: null,
    clientHost: null,
  };
}

function notImplemented(): never {
  throw new Error("not used by this test");
}

async function fakeDeliverToken(_token: string): Promise<string> {
  return "/tmp/deliver/token";
}

async function passingProbe(
  _input: OriginProbeInput,
): Promise<readonly ProbeRow[]> {
  return [
    { name: "fixture-head-symref", passed: true },
    { name: "fixture-fetch", passed: true },
    { name: "fixture-receive-pack-refuses-wrong-token", passed: true },
  ];
}

function fakeDriver(
  name: ExecutionDriver["name"],
  deliverDirectory: ExecutionDriver["deliverDirectory"],
  extra: Readonly<Record<string, unknown>> = {},
): ExecutionDriver {
  return {
    name,
    identity: notImplemented,
    deliverBinary: notImplemented,
    deliverDirectory,
    retrieveDirectory: notImplemented,
    deliverConfig: notImplemented,
    deliverToken: notImplemented,
    probeOrigin: passingProbe,
    assertBareMachine: notImplemented,
    cli: notImplemented,
    issue: notImplemented,
    startDaemon: notImplemented,
    startDaemonExpectingRefusal: notImplemented,
    collectLogs: notImplemented,
    ...extra,
  } as ExecutionDriver;
}

test("profileFieldNames has exactly the nine ScenarioProfile keys, in declaration order", () => {
  assert.deepEqual(profileFieldNames, expectedFieldNames);
});

test("createFixtureProfile returns the fixture's own default branch, counts and object ids", async () => {
  const ledger = createLedger();
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    { deliverToken: fakeDeliverToken },
  );
  const profile = await createFixtureProfile(fakeContext(ledger), driver);

  assert.equal(profile.defaultBranch, "main");
  assert.equal(profile.expectedObjectiveCount, 2);
  assert.equal(profile.expectedTaskCount, 4);
  assert.deepEqual(profile.expectedObjectIds, fixtureObjectIds);

  await ledger.releaseAll();
});

test("createFixtureProfile calls deliverDirectory exactly once for the plan fixture, and planDirectory is its return value", async () => {
  const ledger = createLedger();
  const calls: Array<[HostRole, string, string]> = [];
  const driver = fakeDriver(
    "local",
    async (role: HostRole, source: string, name: string) => {
      calls.push([role, source, name]);
      return "/tmp/deliver/plan-sentinel";
    },
    { deliverToken: fakeDeliverToken },
  );

  const profile = await createFixtureProfile(fakeContext(ledger), driver);

  assert.deepEqual(calls, [
    ["client", "test/e2e/fixtures/two-objective/plan", "plan"],
  ]);
  assert.equal(profile.planDirectory, "/tmp/deliver/plan-sentinel");

  await ledger.releaseAll();
});

test("createFixtureProfile on a local driver takes one directory resource for the in-process fixture remote", async () => {
  const ledger = createLedger();
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    { deliverToken: fakeDeliverToken },
  );

  await createFixtureProfile(fakeContext(ledger), driver);

  const directoryHandles: readonly ResourceHandle[] = ledger
    .taken()
    .filter((handle) => handle.kind === "directory");
  assert.equal(directoryHandles.length, 1);

  await ledger.releaseAll();
});

test("createFixtureProfile on a podman driver takes no directory resource and reads the origin from the topology, suffixed with the fixture repository path", async () => {
  const ledger = createLedger();
  const fixtureOrigin = "http://127.0.0.1:7422";
  const driver = fakeDriver(
    "podman",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    { topology: { fixtureOrigin }, deliverToken: fakeDeliverToken },
  );

  const profile = await createFixtureProfile(fakeContext(ledger), driver);

  assert.equal(ledger.taken().length, 0);
  assert.equal(profile.origin, `${fixtureOrigin}/fixture.git`);
});

test("SECURITY: createFixtureProfile holds the fixture Basic-auth token in the shared secret registry itself, not only through driver.deliverToken", async () => {
  const ledger = createLedger();
  let deliveredToken = "";
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    {
      async deliverToken(token: string): Promise<string> {
        deliveredToken = token;
        return "/tmp/deliver/token";
      },
    },
  );

  try {
    await createFixtureProfile(fakeContext(ledger), driver);

    assert.notEqual(deliveredToken, "");
    assert.equal(secrets.values().includes(deliveredToken), true);
  } finally {
    await ledger.releaseAll();
  }
});

test("createRealProfile carries fixtureRoot null and expectedObjectIds null, and delivers the operator's own plan path", async () => {
  const ledger = createLedger();
  const calls: Array<[HostRole, string, string]> = [];
  const driver = fakeDriver(
    "ssh",
    async (role: HostRole, source: string, name: string) => {
      calls.push([role, source, name]);
      return "/tmp/deliver/real-plan";
    },
  );

  const profile = await createRealProfile(fakeContext(ledger), driver, {
    origin: "https://example.invalid/real.git",
    credentialArguments: ["credential", "register", "--name", "real"],
    defaultBranch: "trunk",
    localPlanPath: "/home/operator/plan",
    expectedObjectiveCount: 5,
    expectedTaskCount: 11,
  });

  assert.equal(profile.fixtureRoot, null);
  assert.equal(profile.expectedObjectIds, null);
  assert.deepEqual(calls, [["client", "/home/operator/plan", "plan"]]);
  assert.equal(profile.planDirectory, "/tmp/deliver/real-plan");
});

test("the fixture profile and the real profile carry the same key set", async () => {
  const ledger1 = createLedger();
  const fixtureProfile = await createFixtureProfile(
    fakeContext(ledger1),
    fakeDriver(
      "local",
      async (_role: HostRole, _source: string, name: string) =>
        `/tmp/deliver/${name}`,
      { deliverToken: fakeDeliverToken },
    ),
  );

  const ledger2 = createLedger();
  const realProfile = await createRealProfile(
    fakeContext(ledger2),
    fakeDriver(
      "ssh",
      async (_role: HostRole, _source: string, name: string) =>
        `/tmp/deliver/${name}`,
    ),
    {
      origin: "https://example.invalid/real.git",
      credentialArguments: [],
      defaultBranch: "trunk",
      localPlanPath: "/home/operator/plan",
      expectedObjectiveCount: 1,
      expectedTaskCount: 1,
    },
  );

  assert.deepEqual(
    Object.keys(fixtureProfile).sort(),
    Object.keys(realProfile).sort(),
  );

  await ledger1.releaseAll();
});

test("createFixtureProfile on a podman driver probes the origin once with the delivered token path, the main branch and the wrong credential", async () => {
  const ledger = createLedger();
  const fixtureOrigin = "http://127.0.0.1:7422";
  const probeCalls: OriginProbeInput[] = [];
  const driver = fakeDriver(
    "podman",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    {
      topology: { fixtureOrigin },
      deliverToken: async (_token: string) => "/tmp/deliver/token-podman",
      probeOrigin: async (input: OriginProbeInput) => {
        probeCalls.push(input);
        return passingProbe(input);
      },
    },
  );

  await createFixtureProfile(fakeContext(ledger), driver);

  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0]?.tokenPath, "/tmp/deliver/token-podman");
  assert.equal(probeCalls[0]?.defaultBranch, "main");
  assert.equal(probeCalls[0]?.wrongToken, httpWrongCredential.token);

  await ledger.releaseAll();
});

test("createFixtureProfile records the three probe rows through context.assert with expected true", async () => {
  const ledger = createLedger();
  const assertions: Array<{
    name: string;
    expected: unknown;
    actual: unknown;
  }> = [];
  const context: ScenarioContext = {
    ...fakeContext(ledger),
    assert(name: string, expected: unknown, actual: unknown): void {
      assertions.push({ name, expected, actual });
    },
  };
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    { deliverToken: fakeDeliverToken },
  );

  await createFixtureProfile(context, driver);

  assert.deepEqual(assertions, [
    { name: "fixture-head-symref", expected: true, actual: true },
    { name: "fixture-fetch", expected: true, actual: true },
    {
      name: "fixture-receive-pack-refuses-wrong-token",
      expected: true,
      actual: true,
    },
  ]);

  await ledger.releaseAll();
});

test("createFixtureProfile rejects with unavailable when a probe row fails, and records it first", async () => {
  const ledger = createLedger();
  const assertions: Array<{
    name: string;
    expected: unknown;
    actual: unknown;
  }> = [];
  const context: ScenarioContext = {
    ...fakeContext(ledger),
    assert(name: string, expected: unknown, actual: unknown): void {
      assertions.push({ name, expected, actual });
      if (actual !== expected) {
        throw new RunnerError("assertion-failed", name);
      }
    },
  };
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) =>
      `/tmp/deliver/${name}`,
    {
      deliverToken: fakeDeliverToken,
      async probeOrigin(): Promise<readonly ProbeRow[]> {
        return [
          { name: "fixture-head-symref", passed: false },
          { name: "fixture-fetch", passed: true },
          { name: "fixture-receive-pack-refuses-wrong-token", passed: true },
        ];
      },
    },
  );

  await assert.rejects(
    createFixtureProfile(context, driver),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "unavailable" &&
      error.message === "fixture row fixture-head-symref failed",
  );

  assert.deepEqual(assertions[0], {
    name: "fixture-head-symref",
    expected: true,
    actual: false,
  });

  await ledger.releaseAll();
});

test("createFixtureProfile issues probeOrigin before any journey command, and issues no cli call itself", async () => {
  const ledger = createLedger();
  const calls: string[] = [];
  const driver = fakeDriver(
    "local",
    async (_role: HostRole, _source: string, name: string) => {
      calls.push("deliverDirectory");
      return `/tmp/deliver/${name}`;
    },
    {
      deliverToken: async (_token: string) => {
        calls.push("deliverToken");
        return "/tmp/deliver/token";
      },
      async probeOrigin(input: OriginProbeInput): Promise<readonly ProbeRow[]> {
        calls.push("probeOrigin");
        return passingProbe(input);
      },
      async cli(argv: readonly string[]) {
        calls.push("cli");
        return {
          argv,
          cwd: process.cwd(),
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    },
  );

  await createFixtureProfile(fakeContext(ledger), driver);

  assert.equal(calls.includes("probeOrigin"), true);
  assert.equal(calls.includes("cli"), false);

  await ledger.releaseAll();
});

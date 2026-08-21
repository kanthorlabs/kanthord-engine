import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import {
  driverMethodNames,
  type ExecutionDriver,
  type HostRole,
} from "./index.ts";
import { createLocalDriver } from "./local.ts";
import { createPodmanDriver } from "./podman.ts";
import { createSshDriver } from "./ssh.ts";
import { createLedger } from "../resources.ts";
import { RunnerError } from "../errors.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { CommandRecord } from "../command.ts";
import type { Topology } from "../podman/topology.ts";

const expectedMethodNames = [
  "name",
  "identity",
  "deliverBinary",
  "deliverDirectory",
  "retrieveDirectory",
  "deliverConfig",
  "deliverToken",
  "probeOrigin",
  "assertBareMachine",
  "cli",
  "cliAs",
  "issue",
  "issueAs",
  "registerActor",
  "daemonNetwork",
  "startDaemon",
  "startDaemonExpectingRefusal",
  "collectLogs",
] as const;

function fakeContext(): ScenarioContext & {
  releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]>;
} {
  const ledger = createLedger();
  return {
    tag: "interface-test",
    scenarioId: "P1-E1",
    bundleDirectory: "/tmp/interface-test-bundle",
    take: ledger.take,
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(): void {},
    daemonHost: null,
    clientHost: null,
    releaseAll(): ReturnType<ReturnType<typeof createLedger>["releaseAll"]> {
      return ledger.releaseAll();
    },
  };
}

const warmContext = fakeContext();
after(() => warmContext.releaseAll());

before(
  async () => {
    const driver = await createLocalDriver(warmContext);
    await driver.deliverBinary("client");
  },
  { timeout: 300000 },
);

function fakeCommandRecord(argv: readonly string[]): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout: "", stderr: "" };
}

type Story10Request = Parameters<ExecutionDriver["issue"]>[0] &
  Readonly<{ tokenFile?: string }>;

type Story10Driver = ExecutionDriver &
  Readonly<{
    cliAs(
      role: HostRole,
      argv: readonly string[],
      options?: Readonly<{ tokenFile?: string }>,
    ): Promise<CommandRecord>;
    issueAs(
      role: HostRole,
      request: Story10Request,
    ): ReturnType<ExecutionDriver["issue"]>;
    registerActor(
      role: HostRole,
      name: string,
    ): Promise<Readonly<{ actorId: string; tokenFile: string }>>;
  }>;

function story10Driver(driver: ExecutionDriver): Story10Driver {
  return driver as Story10Driver;
}

type SshCall = Readonly<{
  target: Readonly<{ role: HostRole; host: string }>;
  argv: readonly string[];
  stdin: string | undefined;
  record: CommandRecord;
}>;

async function recordingSshDriver(
  calls: SshCall[],
  stdout = "200\n{}",
): Promise<Story10Driver> {
  const driver = await createSshDriver(fakeContext(), {
    daemonHost: "daemon.example",
    clientHost: "client.example",
    execute: async (target, argv, stdin) => {
      const record = fakeCommandRecord(argv);
      const response = argv.includes("register")
        ? "actor_01\ntoken: [redacted] -> /tmp/token\n"
        : stdout;
      const completed = { ...record, stdout: response };
      calls.push({ target, argv, stdin, record: completed });
      return completed;
    },
  });
  return story10Driver(driver);
}

type PodmanCall = Readonly<{
  argv: readonly string[];
  stdin: string | undefined;
  record: CommandRecord;
}>;

async function recordingPodmanDriver(
  calls: PodmanCall[],
  stdout = "200\n{}",
): Promise<Story10Driver> {
  const driver = await createPodmanDriver(fakeContext(), {
    execute: async (argv, stdin) => {
      const record = { ...fakeCommandRecord(argv), stdout };
      calls.push({ argv, stdin, record });
      return record;
    },
    images: {
      product: "kanthord-e2e-product",
      fixture: "kanthord-e2e-fixture",
    },
    topology: fakeTopology(),
  });
  return story10Driver(driver);
}

function fakeTopology(): Topology {
  return {
    runId: "R1",
    network: "kanthord-e2e-R1",
    pod: "kanthord-e2e-pod-R1",
    fixtureContainer: "kanthord-e2e-fixture-R1",
    daemonContainer: "kanthord-e2e-daemon-R1",
    clientContainer: "kanthord-e2e-client-R1",
    secondClientContainer: "kanthord-e2e-client2-R1",
    volume: "kanthord-e2e-home-R1",
    daemonAlias: "kanthord-daemon",
    daemonPort: 7421,
    fixturePort: 7422,
    allowedHost: "kanthord-daemon:7421",
    fixtureOrigin: "http://127.0.0.1:7422",
  };
}

function assertDriverShape(driver: Readonly<Record<string, unknown>>): void {
  assert.deepEqual(Object.keys(driver).sort(), [...expectedMethodNames].sort());
  for (const key of expectedMethodNames) {
    if (key === "name") {
      continue;
    }
    assert.equal(typeof driver[key], "function", `${key} is not a function`);
  }
}

test("driverMethodNames has exactly the ExecutionDriver keys, in declaration order", () => {
  assert.deepEqual(driverMethodNames, expectedMethodNames);
});

test("createLocalDriver's constructed driver exposes exactly the driverMethodNames keys and is named local", async (t) => {
  const context = fakeContext();
  t.after(() => context.releaseAll());
  const driver = await createLocalDriver(context);
  assertDriverShape(driver);
  assert.equal(driver.name, "local");
});

test("createPodmanDriver's constructed driver exposes exactly the driverMethodNames keys and is named podman, against a fake executor that spawns nothing", async () => {
  let executed = false;
  const driver = await createPodmanDriver(fakeContext(), {
    execute: async (argv: readonly string[]): Promise<CommandRecord> => {
      executed = true;
      return fakeCommandRecord(argv);
    },
    images: {
      product: "kanthord-e2e-product",
      fixture: "kanthord-e2e-fixture",
    },
    topology: fakeTopology(),
  });
  assertDriverShape(driver);
  assert.equal(driver.name, "podman");
  assert.equal(
    executed,
    false,
    "constructing the driver must not spawn podman",
  );
});

test("createPodmanDriver maps client2 to the second client container", async () => {
  const topology = fakeTopology();
  const driver = await createPodmanDriver(fakeContext(), {
    execute: async (argv: readonly string[]): Promise<CommandRecord> =>
      fakeCommandRecord(argv),
    images: {
      product: "kanthord-e2e-product",
      fixture: "kanthord-e2e-fixture",
    },
    topology,
  });

  const identity = await driver.identity("client2");
  assert.equal(identity.hostname, topology.secondClientContainer);
});

test("createPodmanDriver collects daemon, client and client2 logs", async () => {
  const topology = fakeTopology();
  const driver = await createPodmanDriver(fakeContext(), {
    execute: async (argv: readonly string[]): Promise<CommandRecord> => ({
      ...fakeCommandRecord(argv),
      stdout: `log:${argv[2] ?? ""}`,
    }),
    images: {
      product: "kanthord-e2e-product",
      fixture: "kanthord-e2e-fixture",
    },
    topology,
  });

  const logs = await driver.collectLogs();
  assert.deepEqual(logs, {
    daemon: `log:${topology.daemonContainer}`,
    client: `log:${topology.clientContainer}`,
    client2: `log:${topology.secondClientContainer}`,
  });
});

test("createSshDriver's constructed driver exposes exactly the driverMethodNames keys and is named ssh, against a fake executor that spawns nothing", async () => {
  let executed = false;
  const driver = await createSshDriver(fakeContext(), {
    daemonHost: "daemon.example",
    clientHost: "client.example",
    execute: async (
      _target: Readonly<{
        role: "daemon" | "client" | "client2";
        host: string;
      }>,
      argv: readonly string[],
    ): Promise<CommandRecord> => {
      executed = true;
      return fakeCommandRecord(argv);
    },
  });
  assertDriverShape(driver);
  assert.equal(driver.name, "ssh");
  assert.equal(executed, false, "constructing the driver must not spawn ssh");
});

test("createSshDriver's probeOrigin rejects with unavailable, because the real profile has no fixture origin", async () => {
  const driver = await createSshDriver(fakeContext(), {
    daemonHost: "daemon.example",
    clientHost: "client.example",
    execute: async (
      _target: Readonly<{
        role: "daemon" | "client" | "client2";
        host: string;
      }>,
      argv: readonly string[],
    ): Promise<CommandRecord> => fakeCommandRecord(argv),
  });

  await assert.rejects(
    driver.probeOrigin({
      origin: "http://example.invalid/fixture.git",
      username: "writer",
      tokenPath: "/tmp/token",
      wrongToken: "bad-tok",
      defaultBranch: "main",
    }),
    (error: unknown) =>
      error instanceof RunnerError && error.code === "unavailable",
  );
});

test('cli and cliAs("client") reach the same target with the same arguments', async () => {
  const calls: SshCall[] = [];
  const driver = await recordingSshDriver(calls);
  const argv = ["status", "--json"];

  await driver.cli(argv);
  await driver.cliAs("client", argv);

  assert.deepEqual(
    calls.map((call) => call.target),
    [
      { role: "client", host: "client.example" },
      { role: "client", host: "client.example" },
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.argv),
    [argv, argv],
  );
});

test('issue and issueAs("client") build the same request', async () => {
  const calls: PodmanCall[] = [];
  const driver = await recordingPodmanDriver(calls);
  const request = {
    method: "POST",
    path: "/v1/node/node_01ARZ3NDEKTSV4RRFFQ69G5FAV/claim",
    headers: { "Idempotency-Key": "same-key" },
    omitHost: false,
    body: JSON.stringify({}),
  };

  await driver.issue(request);
  await driver.issueAs("client", request);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    JSON.parse(calls[0]?.stdin ?? "null"),
    JSON.parse(calls[1]?.stdin ?? "null"),
  );
});

test("registerActor returns no token field", async () => {
  const calls: SshCall[] = [];
  const driver = await recordingSshDriver(calls);

  const result = await driver.registerActor("client", "harness-one");

  assert.deepEqual(Object.keys(result), ["actorId", "tokenFile"]);
  assert.equal(result.actorId, "actor_01");
  assert.equal(typeof result.tokenFile, "string");
  assert.equal(result.tokenFile.length > 0, true);
  assert.equal("token" in result, false);
});

test("registerActor runs as the configured human actor", async () => {
  const calls: SshCall[] = [];
  const driver = await recordingSshDriver(calls);

  await driver.registerActor("client", "harness-one");

  const registration = calls.find((call) => call.argv.includes("register"));
  assert.ok(registration);
  assert.equal(registration.argv.includes("--api-token-file"), false);
});

test("two registrations on one role return two distinct token paths", async () => {
  const calls: SshCall[] = [];
  const driver = await recordingSshDriver(calls);

  const first = await driver.registerActor("client", "unsafe/name");
  const second = await driver.registerActor("client", "unsafe/name");

  assert.notEqual(first.tokenFile, second.tokenFile);
  assert.equal(first.tokenFile.includes("unsafe/name"), false);
  assert.equal(second.tokenFile.includes("unsafe/name"), false);
});

test("cliAs appends --api-token-file only when the caller passes one", async () => {
  const calls: SshCall[] = [];
  const driver = await recordingSshDriver(calls);
  const tokenFile = "/tmp/client-token-file";

  await driver.cliAs("client", ["status"]);
  await driver.cliAs("client", ["status"], { tokenFile });

  assert.equal(calls[0]?.argv.includes("--api-token-file"), false);
  const tokenOption = calls[1]?.argv.indexOf("--api-token-file") ?? -1;
  assert.notEqual(tokenOption, -1);
  assert.equal(calls[1]?.argv[tokenOption + 1], tokenFile);
});

test("no driver reads a token file in the runner process", async () => {
  const tokenFile = "/tmp/token-file-that-does-not-exist";
  const request = Object.assign(
    {
      method: "GET",
      path: "/v1/health",
      headers: {},
      omitHost: false,
    },
    { tokenFile },
  );

  const sshCalls: SshCall[] = [];
  const sshDriver = await recordingSshDriver(sshCalls);
  await assert.doesNotReject(() => sshDriver.issueAs("client", request));

  const podmanCalls: PodmanCall[] = [];
  const podmanDriver = await recordingPodmanDriver(podmanCalls);
  await assert.doesNotReject(() => podmanDriver.issueAs("client", request));

  const context = fakeContext();
  const localDriver = story10Driver(await createLocalDriver(context));
  try {
    const record = await localDriver.cliAs("client", ["--version"], {
      tokenFile,
    });
    assert.equal(record.argv.includes(tokenFile), true);
  } finally {
    await context.releaseAll();
  }
});

test("the recorded registration prints no token", async () => {
  const calls: SshCall[] = [];
  const secret = "registration-secret-value";
  const driver = await recordingSshDriver(calls);

  await driver.registerActor("client", "harness-one");

  const registration = calls.find((call) => call.argv.includes("register"));
  assert.ok(registration);
  assert.equal(registration.record.stdout.includes("actor_01"), true);
  assert.equal(registration.record.stdout.includes(secret), false);
  assert.equal(registration.argv.includes("--output-token-file"), true);
});

test("startDaemon carries leaseTtlMs into the daemon settings payload", async () => {
  const calls: PodmanCall[] = [];
  const driver = await recordingPodmanDriver(calls);
  const config = {
    home: "/var/lib/kanthord",
    actor: "e2e-interface-test",
    masterKey: "0".repeat(64),
    http: {
      bind: "0.0.0.0",
      port: 7421,
      token: "human-token",
      allowedHosts: ["kanthord-daemon:7421"],
    },
    tools: { git: "git", ssh: "ssh", sshKeyscan: "ssh-keyscan" },
    attemptLimit: 3,
    leaseTtlMs: 2000,
  };

  const handle = await driver.startDaemon(config);
  try {
    const writeConfig = calls.find((call) =>
      call.argv.includes("/opt/e2e/bin/write-config.mjs"),
    );
    assert.ok(writeConfig);
    const settings = JSON.parse(writeConfig.stdin ?? "null") as Readonly<{
      leaseTtlMs?: number;
    }>;
    assert.equal(settings.leaseTtlMs, 2000);
  } finally {
    await handle.stop();
  }
});

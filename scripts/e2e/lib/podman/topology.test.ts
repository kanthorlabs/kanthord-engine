import test from "node:test";
import assert from "node:assert/strict";

import { planTopology, createTopology } from "./topology.ts";
import type { Topology } from "./topology.ts";
import { createLedger } from "../resources.ts";
import type { CommandRecord } from "../command.ts";
import type { ScenarioContext } from "../scenario/context.ts";

const images = { product: "product-image-id", fixture: "fixture-image-id" };
const secretPaths = {
  tokenFile: "/tmp/e2e-fake-token-file",
  masterKeyFile: "/tmp/e2e-fake-master-file",
};

function fakeRecord(argv: readonly string[]): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout: "", stderr: "" };
}

function fakeContext(ledger: ReturnType<typeof createLedger>): ScenarioContext {
  return {
    tag: "topology-test",
    scenarioId: "P1-E4",
    bundleDirectory: "/tmp/topology-test-bundle",
    take: ledger.take,
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(): void {},
    daemonHost: null,
    clientHost: null,
  };
}

test("planTopology(runId) returns exactly the thirteen pinned fields, and is pure", () => {
  const expected: Topology = {
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
  assert.deepEqual(planTopology("R1"), expected);
  assert.deepEqual(planTopology("R1"), planTopology("R1"));
});

test("createTopology issues exactly nine commands, in order, each carrying the run-id label, with the two secret creates before the daemon run", async () => {
  const topology = planTopology("R1");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  assert.equal(argvCalls.length, 9);

  assert.deepEqual(argvCalls[0], [
    "podman",
    "network",
    "create",
    "--internal",
    "--label",
    "kanthord-e2e-run=R1",
    topology.network,
  ]);
  assert.deepEqual(argvCalls[1], [
    "podman",
    "volume",
    "create",
    "--label",
    "kanthord-e2e-run=R1",
    topology.volume,
  ]);
  assert.deepEqual(argvCalls[2], [
    "podman",
    "pod",
    "create",
    "--name",
    topology.pod,
    "--network",
    `${topology.network}:alias=${topology.daemonAlias}`,
    "--label",
    "kanthord-e2e-run=R1",
  ]);
  assert.deepEqual(argvCalls[3], [
    "podman",
    "run",
    "--detach",
    "--pod",
    topology.pod,
    "--name",
    topology.fixtureContainer,
    "--label",
    "kanthord-e2e-run=R1",
    "--pull=never",
    images.fixture,
    "node",
    "/opt/fixture/main.ts",
    "--bind",
    "127.0.0.1",
    "--port",
    "7422",
  ]);
  assert.deepEqual(argvCalls[4], [
    "podman",
    "secret",
    "create",
    "--label",
    "kanthord-e2e-run=R1",
    "kanthord-token-R1",
    secretPaths.tokenFile,
  ]);
  assert.deepEqual(argvCalls[5], [
    "podman",
    "secret",
    "create",
    "--label",
    "kanthord-e2e-run=R1",
    "kanthord-master-R1",
    secretPaths.masterKeyFile,
  ]);
  assert.deepEqual(argvCalls[6], [
    "podman",
    "run",
    "--detach",
    "--pod",
    topology.pod,
    "--name",
    topology.daemonContainer,
    "--label",
    "kanthord-e2e-run=R1",
    "--pull=never",
    "--volume",
    `${topology.volume}:/var/lib/kanthord`,
    "--secret",
    "kanthord-token-R1,type=mount,target=/run/secrets/kanthord-token,mode=0600",
    "--secret",
    "kanthord-master-R1,type=mount,target=/run/secrets/kanthord-master,mode=0600",
    images.product,
    "sleep",
    "infinity",
  ]);
  assert.deepEqual(argvCalls[7], [
    "podman",
    "run",
    "--detach",
    "--network",
    topology.network,
    "--name",
    topology.clientContainer,
    "--label",
    "kanthord-e2e-run=R1",
    "--pull=never",
    "--secret",
    "kanthord-token-R1,type=mount,target=/run/secrets/kanthord-token,mode=0600",
    "--secret",
    "kanthord-master-R1,type=mount,target=/run/secrets/kanthord-master,mode=0600",
    images.product,
    "sleep",
    "infinity",
  ]);
  assert.deepEqual(argvCalls[8], [
    "podman",
    "run",
    "--detach",
    "--network",
    topology.network,
    "--name",
    topology.secondClientContainer,
    "--label",
    "kanthord-e2e-run=R1",
    "--pull=never",
    "--secret",
    "kanthord-token-R1,type=mount,target=/run/secrets/kanthord-token,mode=0600",
    "--secret",
    "kanthord-master-R1,type=mount,target=/run/secrets/kanthord-master,mode=0600",
    images.product,
    "sleep",
    "infinity",
  ]);

  for (const argv of argvCalls) {
    assert.ok(argv.includes("kanthord-e2e-run=R1"));
  }
});

test("no --secret argument anywhere carries mode=0400, and every --secret carries mode=0600", async () => {
  const topology = planTopology("R10");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  const secretArguments = argvCalls
    .flatMap((argv) => argv)
    .filter(
      (token) =>
        token.startsWith("kanthord-token-") ||
        token.startsWith("kanthord-master-"),
    )
    .filter((token) => token.includes("type=mount"));

  assert.ok(secretArguments.length > 0);
  for (const token of secretArguments) {
    assert.equal(token.includes("mode=0400"), false);
    assert.ok(token.includes("mode=0600"));
  }

  const daemonArgv = argvCalls[6] ?? [];
  const clientArgv = argvCalls[7] ?? [];
  const secondClientArgv = argvCalls[8] ?? [];
  assert.equal(daemonArgv.filter((token) => token === "--secret").length, 2);
  assert.equal(clientArgv.filter((token) => token === "--secret").length, 2);
  assert.equal(
    secondClientArgv.filter((token) => token === "--secret").length,
    2,
  );
});

test("no command in the whole recording carries --env or -e", async () => {
  const topology = planTopology("R11");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  for (const argv of argvCalls) {
    assert.equal(argv.includes("--env"), false);
    assert.equal(argv.includes("-e"), false);
  }
});

test("every podman run carries --pull=never, and none carries --network host, --network=host or --publish", async () => {
  const topology = planTopology("R2");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  const runCommands = argvCalls.filter((argv) => argv[1] === "run");
  assert.equal(runCommands.length, 4);
  for (const argv of runCommands) {
    assert.ok(argv.includes("--pull=never"));
    assert.equal(argv.includes("--network host"), false);
    assert.equal(argv.includes("--network=host"), false);
    assert.equal(argv.includes("--publish"), false);
  }
});

test("the fixture and daemon commands carry --pod; the client command carries --network and no --pod", async () => {
  const topology = planTopology("R3");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  const fixtureArgv = argvCalls[3] ?? [];
  const daemonArgv = argvCalls[6] ?? [];
  const clientArgv = argvCalls[7] ?? [];
  const secondClientArgv = argvCalls[8] ?? [];

  assert.ok(fixtureArgv.includes("--pod"));
  assert.ok(daemonArgv.includes("--pod"));
  assert.equal(clientArgv.includes("--pod"), false);
  assert.ok(clientArgv.includes("--network"));
  assert.equal(secondClientArgv.includes("--pod"), false);
  assert.ok(secondClientArgv.includes("--network"));
});

test("the client command carries no --volume", async () => {
  const topology = planTopology("R4");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  assert.equal((argvCalls[7] ?? []).includes("--volume"), false);
});

test("the second client container carries no daemon volume mount", async () => {
  const topology = planTopology("R4B");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  assert.equal(argvCalls.length, 9);
  const secondClientArgv = argvCalls[8] ?? [];
  assert.ok(secondClientArgv.includes("--network"));
  assert.equal(secondClientArgv.includes("--volume"), false);
  assert.equal(secondClientArgv.includes("-v"), false);
});

test("the fixture command uses images.fixture and the other three use images.product", async () => {
  const topology = planTopology("R5");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  assert.ok((argvCalls[3] ?? []).includes(images.fixture));
  assert.equal((argvCalls[3] ?? []).includes(images.product), false);
  assert.ok((argvCalls[6] ?? []).includes(images.product));
  assert.ok((argvCalls[7] ?? []).includes(images.product));
  assert.ok((argvCalls[8] ?? []).includes(images.product));
});

test("the daemon and both client commands end in sleep infinity; neither argv contains serve", async () => {
  const topology = planTopology("R6");
  const argvCalls: (readonly string[])[] = [];
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    argvCalls.push(argv);
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  const daemonArgv = argvCalls[6] ?? [];
  const clientArgv = argvCalls[7] ?? [];
  const secondClientArgv = argvCalls[8] ?? [];
  assert.deepEqual(daemonArgv.slice(-2), ["sleep", "infinity"]);
  assert.deepEqual(clientArgv.slice(-2), ["sleep", "infinity"]);
  assert.deepEqual(secondClientArgv.slice(-2), ["sleep", "infinity"]);
  assert.equal(daemonArgv.includes("serve"), false);
  assert.equal(clientArgv.includes("serve"), false);
  assert.equal(secondClientArgv.includes("serve"), false);
});

test("context.taken() after createTopology deep-equals, in take order, network/volume/pod/fixture/daemon/client/client2 with their kinds", async () => {
  const topology = planTopology("R7");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> =>
    fakeRecord(argv);
  const ledger = createLedger();

  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );

  assert.deepEqual(ledger.taken(), [
    { kind: "network", id: topology.network },
    { kind: "volume", id: topology.volume },
    { kind: "pod", id: topology.pod },
    { kind: "container", id: topology.fixtureContainer },
    { kind: "secret", id: "kanthord-token-R7" },
    { kind: "secret", id: "kanthord-master-R7" },
    { kind: "container", id: topology.daemonContainer },
    { kind: "container", id: topology.clientContainer },
    { kind: "container", id: topology.secondClientContainer },
  ]);
});

test("a failure on command 4 (the fixture container) leaves taken() holding the first three", async () => {
  const topology = planTopology("R8");
  let callIndex = 0;
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    callIndex += 1;
    if (callIndex === 4) {
      throw new Error("podman run failed");
    }
    return fakeRecord(argv);
  };
  const ledger = createLedger();

  await assert.rejects(
    createTopology(fakeContext(ledger), execute, images, topology, secretPaths),
  );

  assert.deepEqual(ledger.taken(), [
    { kind: "network", id: topology.network },
    { kind: "volume", id: topology.volume },
    { kind: "pod", id: topology.pod },
  ]);
});

test("startDaemon then stop() then startDaemon issues two write-config-then-migrate-then-token-install-then-token-write-then-serve exec sequences, delivers the token to all three containers each time, and one pkill, and no podman run or podman rm in between", async () => {
  const topology = planTopology("R9");
  const calls: Array<{ argv: readonly string[]; stdin?: string }> = [];
  const execute = async (
    argv: readonly string[],
    stdin?: string,
  ): Promise<CommandRecord> => {
    calls.push({ argv, stdin });
    if (argv.some((token) => token.includes("e2e-request.mjs"))) {
      return { ...fakeRecord(argv), stdout: "200\n{}" };
    }
    return fakeRecord(argv);
  };
  const ledger = createLedger();
  await createTopology(
    fakeContext(ledger),
    execute,
    images,
    topology,
    secretPaths,
  );
  calls.length = 0;

  const { createPodmanDriver } = await import("../driver/podman.ts");
  const driver = await createPodmanDriver(fakeContext(ledger), {
    execute,
    images,
    topology,
  });

  const config = {
    home: "/var/lib/kanthord",
    actor: "e2e-topology",
    masterKey: "0".repeat(64),
    http: {
      bind: "0.0.0.0",
      port: topology.daemonPort,
      token: "topology-token",
      allowedHosts: [topology.allowedHost],
    },
    tools: { git: "git", ssh: "ssh", sshKeyscan: "ssh-keyscan" },
    attemptLimit: 3,
    leaseTtlMs: 300000,
  };

  const handle = await driver.startDaemon(config);
  await handle.stop();
  await driver.startDaemon(config);

  const execCommands = calls.filter(
    ({ argv }) => argv[0] === "podman" && argv[1] === "exec",
  );
  assert.equal(execCommands.length, 21);

  const healthCommands = execCommands.filter(({ argv }) =>
    argv.some((token) => token.includes("e2e-request.mjs")),
  );
  assert.equal(healthCommands.length, 2);

  const writeConfigCommands = execCommands.filter(({ argv }) =>
    argv.includes("/opt/e2e/bin/write-config.mjs"),
  );
  assert.equal(writeConfigCommands.length, 2);
  assert.deepEqual(writeConfigCommands[0]?.argv, [
    "podman",
    "exec",
    "--interactive",
    topology.daemonContainer,
    "node",
    "/opt/e2e/bin/write-config.mjs",
  ]);

  const migrateCommands = execCommands.filter(
    ({ argv }) => argv.includes("db") && argv.includes("migrate"),
  );
  assert.equal(migrateCommands.length, 2);
  for (const { argv } of migrateCommands) {
    assert.deepEqual(argv, [
      "podman",
      "exec",
      topology.daemonContainer,
      "kanthord",
      "db",
      "migrate",
      "--home",
      config.home,
    ]);
  }

  const tokenInstallCommands = execCommands.filter(
    ({ argv }) =>
      argv.includes("install") && argv.includes("/run/secrets/kanthord-token"),
  );
  assert.equal(tokenInstallCommands.length, 6);
  for (const { argv } of tokenInstallCommands) {
    const container = argv[2];
    assert.ok(
      container === topology.daemonContainer ||
        container === topology.clientContainer ||
        container === topology.secondClientContainer,
    );
    assert.deepEqual(argv, [
      "podman",
      "exec",
      container,
      "install",
      "-m",
      "600",
      "/dev/null",
      "/run/secrets/kanthord-token",
    ]);
  }
  assert.equal(
    tokenInstallCommands.filter(
      ({ argv }) => argv[2] === topology.daemonContainer,
    ).length,
    2,
  );
  assert.equal(
    tokenInstallCommands.filter(
      ({ argv }) => argv[2] === topology.clientContainer,
    ).length,
    2,
  );
  assert.equal(
    tokenInstallCommands.filter(
      ({ argv }) => argv[2] === topology.secondClientContainer,
    ).length,
    2,
  );

  const tokenWriteCommands = execCommands.filter(({ argv }) =>
    argv.some((token) => token === "cat > /run/secrets/kanthord-token"),
  );
  assert.equal(tokenWriteCommands.length, 6);
  for (const { argv, stdin } of tokenWriteCommands) {
    const container = argv[3];
    assert.ok(
      container === topology.daemonContainer ||
        container === topology.clientContainer ||
        container === topology.secondClientContainer,
    );
    assert.deepEqual(argv, [
      "podman",
      "exec",
      "--interactive",
      container,
      "sh",
      "-c",
      "cat > /run/secrets/kanthord-token",
    ]);
    assert.equal(stdin, "topology-token");
  }
  assert.equal(
    tokenWriteCommands.filter(
      ({ argv }) => argv[3] === topology.daemonContainer,
    ).length,
    2,
  );
  assert.equal(
    tokenWriteCommands.filter(
      ({ argv }) => argv[3] === topology.clientContainer,
    ).length,
    2,
  );
  assert.equal(
    tokenWriteCommands.filter(
      ({ argv }) => argv[3] === topology.secondClientContainer,
    ).length,
    2,
  );

  const stdin = writeConfigCommands[0]?.stdin ?? "";
  assert.equal(stdin.includes("topology-token"), false);
  assert.equal(stdin.includes(`"${"0".repeat(64)}"`), false);
  assert.equal(stdin.includes('"token"'), false);
  assert.equal(stdin.includes('"masterKey"'), false);
  const parsed = JSON.parse(stdin) as Readonly<{
    http: Readonly<{ tokenFile: string }>;
    masterKeyFile: string;
  }>;
  assert.equal(parsed.http.tokenFile, "/run/secrets/kanthord-token");
  assert.equal(parsed.masterKeyFile, "/run/secrets/kanthord-master");

  const serveCommands = execCommands.filter(({ argv }) =>
    argv.includes("serve"),
  );
  assert.equal(serveCommands.length, 2);
  for (const { argv } of serveCommands) {
    assert.deepEqual(argv, [
      "podman",
      "exec",
      "--detach",
      topology.daemonContainer,
      "kanthord",
      "serve",
    ]);
  }

  const pkillCommands = execCommands.filter(({ argv }) =>
    argv.includes("pkill"),
  );
  assert.equal(pkillCommands.length, 1);
  assert.deepEqual(pkillCommands[0]?.argv, [
    "podman",
    "exec",
    topology.daemonContainer,
    "pkill",
    "-TERM",
    "-f",
    "kanthord serve",
  ]);

  assert.equal(
    calls.some(({ argv }) => argv[0] === "podman" && argv[1] === "run"),
    false,
  );
  assert.equal(
    calls.some(({ argv }) => argv[0] === "podman" && argv[1] === "rm"),
    false,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { driverMethodNames } from "./index.ts";
import { createLocalDriver } from "./local.ts";
import { createPodmanDriver } from "./podman.ts";
import { createSshDriver } from "./ssh.ts";
import { createLedger } from "../resources.ts";
import { RunnerError } from "../errors.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { CommandRecord } from "../command.ts";

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
  "issue",
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

function fakeCommandRecord(argv: readonly string[]): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout: "", stderr: "" };
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
    topology: {
      runId: "R1",
      network: "kanthord-e2e-R1",
      pod: "kanthord-e2e-pod-R1",
      fixtureContainer: "kanthord-e2e-fixture-R1",
      daemonContainer: "kanthord-e2e-daemon-R1",
      clientContainer: "kanthord-e2e-client-R1",
      volume: "kanthord-e2e-home-R1",
      daemonAlias: "kanthord-daemon",
      daemonPort: 7421,
      fixturePort: 7422,
      allowedHost: "kanthord-daemon:7421",
      fixtureOrigin: "http://127.0.0.1:7422",
    },
  });
  assertDriverShape(driver);
  assert.equal(driver.name, "podman");
  assert.equal(
    executed,
    false,
    "constructing the driver must not spawn podman",
  );
});

test("createSshDriver's constructed driver exposes exactly the driverMethodNames keys and is named ssh, against a fake executor that spawns nothing", async () => {
  let executed = false;
  const driver = await createSshDriver(fakeContext(), {
    daemonHost: "daemon.example",
    clientHost: "client.example",
    execute: async (
      _target: Readonly<{ role: "daemon" | "client"; host: string }>,
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
      _target: Readonly<{ role: "daemon" | "client"; host: string }>,
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

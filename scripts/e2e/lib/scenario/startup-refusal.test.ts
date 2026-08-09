import test from "node:test";
import assert from "node:assert/strict";

import { runStartupRefusal } from "./transport.ts";
import type { ExecutionDriver, DaemonConfig } from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";
import { RunnerError } from "../errors.ts";

function buildContext(): Readonly<{
  context: ScenarioContext;
  assertions: { name: string; passed: boolean }[];
}> {
  const assertions: { name: string; passed: boolean }[] = [];
  const context: ScenarioContext = {
    tag: "startup-refusal-test",
    scenarioId: "P1-E2",
    bundleDirectory: "/dev/null",
    take(): void {},
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertions.push({ name, passed });
      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    attachLog(): void {},
    daemonHost: null,
    clientHost: null,
  };
  return { context, assertions };
}

function buildRefusalDriver(
  overrides: Readonly<{ exitCode?: number; stderr?: string }>,
): Readonly<{ driver: ExecutionDriver; configs: DaemonConfig[] }> {
  const configs: DaemonConfig[] = [];
  const driver: ExecutionDriver = {
    name: "local",
    async identity() {
      throw new Error("not used by this test");
    },
    async deliverBinary() {
      throw new Error("not used by this test");
    },
    async deliverDirectory() {
      throw new Error("not used by this test");
    },
    async retrieveDirectory() {
      throw new Error("not used by this test");
    },
    async deliverConfig() {
      throw new Error("not used by this test");
    },
    async deliverToken() {
      throw new Error("not used by this test");
    },
    async probeOrigin() {
      throw new Error("not used by this test");
    },
    async assertBareMachine() {},
    async cli() {
      throw new Error("not used by this test");
    },
    issue: async () => {
      throw new Error("not used by this test");
    },
    async startDaemon() {
      throw new Error("not used by this test");
    },
    async startDaemonExpectingRefusal(config: DaemonConfig) {
      configs.push(config);
      return {
        argv: ["kanthord", "serve"],
        cwd: config.home,
        exitCode: overrides.exitCode ?? 1,
        stdout: "",
        stderr:
          overrides.stderr ??
          "kanthord: config-refused: a non-loopback bind address requires http.token\n",
      };
    },
    async collectLogs() {
      return {};
    },
  };
  return { driver, configs };
}

test("runStartupRefusal sets http.bind to 203.0.113.1 and http.token to empty, and passes on a matching refusal", async () => {
  const { driver, configs } = buildRefusalDriver({});
  const { context, assertions } = buildContext();
  await runStartupRefusal(context, driver);

  assert.equal(configs.length, 1);
  assert.equal(configs[0]?.http.bind, "203.0.113.1");
  assert.equal(configs[0]?.http.token, "");

  assert.deepEqual(
    assertions.map((entry) => entry.name),
    ["startup-refusal-exit", "startup-refusal-message"],
  );
  assert.ok(assertions.every((entry) => entry.passed));
});

test("a driver returning exit 0 makes runStartupRefusal reject naming startup-refusal-exit", async () => {
  const { driver } = buildRefusalDriver({ exitCode: 0 });
  const { context } = buildContext();
  await assert.rejects(
    runStartupRefusal(context, driver),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "assertion-failed" &&
      error.message === "startup-refusal-exit",
  );
});

test("a driver returning exit 1 with a different message makes runStartupRefusal reject naming startup-refusal-message", async () => {
  const { driver } = buildRefusalDriver({
    stderr: "kanthord: something-else: nope\n",
  });
  const { context } = buildContext();
  await assert.rejects(
    runStartupRefusal(context, driver),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "assertion-failed" &&
      error.message === "startup-refusal-message",
  );
});

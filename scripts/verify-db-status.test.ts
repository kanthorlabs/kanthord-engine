import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  runDbStatusStep,
  type DbStatusStepDependencies,
} from "./verify-db-status.ts";
import { reservePort } from "../test/helpers/port.ts";

type CallDbStatusInput = Readonly<{ baseUrl: string; token: string }>;

function assertCleanup(
  result: Readonly<{ home: string; daemonExit: number | null }>,
): void {
  assert.equal(existsSync(result.home), false);
  assert.equal(existsSync(join(result.home, "daemon.lock.db")), false);
  assert.notEqual(result.daemonExit, null);
}

function homeFromError(error: Error): string {
  const matched = /\(home ([^)]+)\)/.exec(error.message);
  assert.ok(matched, `no home path in message: ${error.message}`);
  return matched[1]!;
}

test("scripts/verify-db-status", async (t) => {
  await t.test("the passing run resolves and cleans up", async () => {
    const recordedInputs: CallDbStatusInput[] = [];
    const dependencies: DbStatusStepDependencies = {
      stdout: () => {},
      reservePort,
      callDbStatus: async (input) => {
        recordedInputs.push(input);
        return { code: 0, stdout: "kanthord: version 1.0.0", stderr: "" };
      },
    };

    const result = await runDbStatusStep(dependencies);

    assertCleanup(result);
    assert.equal(recordedInputs.length, 1);
    const recorded = recordedInputs[0]!;
    assert.equal(recorded.baseUrl, `http://127.0.0.1:${result.port}`);
    assert.equal(recorded.token, "test-token");

    // A second run immediately after resolves — no leaked lock, no leaked port.
    const second = await runDbStatusStep(dependencies);
    assertCleanup(second);
  });

  await t.test("the failing run cleans up identically", async () => {
    const dependencies: DbStatusStepDependencies = {
      stdout: () => {},
      reservePort,
      callDbStatus: async () => ({
        code: 3,
        stdout: "",
        stderr: "boom",
      }),
    };

    let rejectedHome = "";
    await assert.rejects(
      () => runDbStatusStep(dependencies),
      (error: Error) => {
        assert.match(error.message, /db status exited 3/);
        rejectedHome = homeFromError(error);
        return true;
      },
    );

    assert.equal(existsSync(rejectedHome), false);
    assert.equal(existsSync(join(rejectedHome, "daemon.lock.db")), false);

    // Cleanup happened even though the step rejected — proved by a fresh run resolving.
    const followUp: DbStatusStepDependencies = {
      stdout: () => {},
      reservePort,
      callDbStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const result = await runDbStatusStep(followUp);
    assertCleanup(result);
  });

  await t.test(
    "a callDbStatus that throws rejects with that error, and cleans up",
    async () => {
      const dependencies: DbStatusStepDependencies = {
        stdout: () => {},
        reservePort,
        callDbStatus: async () => {
          throw new Error("network exploded");
        },
      };

      await assert.rejects(
        () => runDbStatusStep(dependencies),
        /network exploded/,
      );

      const followUp: DbStatusStepDependencies = {
        stdout: () => {},
        reservePort,
        callDbStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
      };
      const result = await runDbStatusStep(followUp);
      assertCleanup(result);
    },
  );

  await t.test(
    "the step reads no KANTHORD_HOME from the ambient environment",
    async () => {
      const previous = process.env.KANTHORD_HOME;
      process.env.KANTHORD_HOME = "/nonexistent";

      try {
        const dependencies: DbStatusStepDependencies = {
          stdout: () => {},
          reservePort,
          callDbStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
        };

        const result = await runDbStatusStep(dependencies);
        assertCleanup(result);
        assert.ok(result.migrated >= 0);
      } finally {
        if (previous === undefined) {
          delete process.env.KANTHORD_HOME;
        } else {
          process.env.KANTHORD_HOME = previous;
        }
      }
    },
  );

  await t.test("a failure before the daemon starts cleans up too", async () => {
    let called = false;

    const dependencies: DbStatusStepDependencies = {
      stdout: () => {},
      reservePort: () => Promise.reject(new Error("no port available")),
      callDbStatus: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    await assert.rejects(
      () => runDbStatusStep(dependencies),
      /no port available/,
    );

    assert.equal(called, false);

    const followUp: DbStatusStepDependencies = {
      stdout: () => {},
      reservePort,
      callDbStatus: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    assertCleanup(await runDbStatusStep(followUp));
  });
});

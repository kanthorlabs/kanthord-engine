import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeMachines,
  gatewayFixture,
  inProcessWorker,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";

test("in-process worker helper reaches ready with injection and stops cleanly", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const host = await inProcessWorker(t, {
    endpoint: fixture.endpoint,
    token,
    clientSecret: Buffer.alloc(32, 9).toString("base64"),
    modelRuntimeFactory: async () => {
      assert.fail("No inference is expected");
    },
  });
  const ready = "Worker application ready";
  assert.equal(host.logs[0]?.msg, ready);
  assert.equal(await host.worker.stop(), null);
  assert.equal(await host.running, null);
});

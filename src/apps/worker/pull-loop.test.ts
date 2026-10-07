import assert from "node:assert/strict";
import { test } from "node:test";
import { CancellationContext } from "../../kernel/context.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { Backoff, workerApi } from "./api.ts";
import { pullLoop } from "./pull-loop.ts";
import { testClaim } from "./test-support.ts";

const REGISTRATION = {
  runtime_identity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  resource_identity: "worker:kanthord:test",
  worker_name: "general@1",
};
const ONCE = 1;
test("claim admission precedes hosting even when shutdown races the pull", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const shutdown = new CancellationContext();
  const execution = testClaim();
  const events: string[] = [];
  t.mock.method(api.scheduler, "workPull", async () => {
    shutdown.cancel();
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: { kind: "claimed", execution },
    };
  });
  const result = await pullLoop({
    api,
    registration: REGISTRATION,
    backoff: new Backoff(),
    shutdown,
    host: async (claim) => {
      assert.deepEqual(claim, execution);
      events.push("host");
      return null;
    },
    register: async () => REGISTRATION,
    pulling: () => events.push("pull"),
    claimed: () => events.push("claimed"),
  });
  assert.equal(result, null);
  assert.deepEqual(events, ["pull", "claimed", "host"]);
});
test("pull loop backs off no work and uncertainty with fresh keys and stops sleep on cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = workerApi("http://127.0.0.1:1");
  const shutdown = new CancellationContext();
  const keys: string[] = [];
  t.mock.method(
    api.scheduler,
    "workPull",
    async (
      _input: unknown,
      options: Parameters<typeof api.scheduler.workPull>[1],
    ) => {
      keys.push(options!.idempotencyKey!);
      return keys.length === ONCE
        ? {
            type: OperationResultType.Completed,
            status: 200,
            data: { kind: "no-work" },
          }
        : { type: OperationResultType.Indeterminate };
    },
  );
  const running = pullLoop({
    api,
    registration: REGISTRATION,
    backoff: new Backoff(),
    shutdown,
    host: async () => {
      assert.fail("Unexpected claim");
    },
    register: async () => {
      assert.fail("Unexpected registration");
    },
    pulling: () => {},
    claimed: () => assert.fail("Unexpected claim"),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.length, ONCE);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const twice = 2;
  assert.equal(keys.length, twice);
  assert.equal(new Set(keys).size, twice);
  shutdown.cancel();
  assert.equal(await running, null);
});

test("expired registration registers again while authentication refusal ends the loop", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const shutdown = new CancellationContext();
  let registrations = 0;
  let pulls = 0;
  const terminal = "gateway.authentication.unauthorized";
  t.mock.method(api.scheduler, "workPull", async () => ({
    type: OperationResultType.Failure,
    status: 403,
    error: {
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      error: {
        code: ++pulls === ONCE ? "gateway.registration.required" : terminal,
        message: "test refusal",
        details: null,
      },
    },
  }));
  const result = await pullLoop({
    api,
    registration: REGISTRATION,
    backoff: new Backoff(),
    shutdown,
    host: async () => null,
    register: async () => {
      registrations++;
      return REGISTRATION;
    },
    pulling: () => {},
    claimed: () => assert.fail("Unexpected claim"),
  });
  assert.equal(result?.code, terminal);
  assert.equal(registrations, ONCE);
});

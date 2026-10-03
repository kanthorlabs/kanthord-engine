import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationResultType } from "../../kernel/operation.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { workerApi } from "./api.ts";
import {
  register,
  startHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from "./registration.ts";

test("registration returns server facts with a fresh key and translates refusal and uncertainty", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const facts = {
    runtimeIdentity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    resourceIdentity: "worker:kanthord:test",
    workerName: "general@1",
  };
  const keys: string[] = [];
  t.mock.method(
    api.worker,
    "register",
    async (
      _input: unknown,
      options: Parameters<typeof api.worker.register>[1],
    ) => {
      keys.push(options!.idempotencyKey!);
      return { type: OperationResultType.Completed, status: 200, data: facts };
    },
  );
  assert.deepEqual(await register(api), facts);
  assert.deepEqual(await register(api), facts);
  assert.equal(new Set(keys).size, keys.length);
  t.mock.method(api.worker, "register", async () => ({
    type: OperationResultType.Indeterminate,
  }));
  await assert.rejects(register(api), {
    code: "worker.start.registration_indeterminate",
  });
  const code = "worker.instance.slot_unavailable";
  t.mock.method(api.worker, "register", async () => ({
    type: OperationResultType.Failure,
    status: 409,
    error: {
      requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      error: { code, message: "No slot", details: null },
    },
  }));
  await assert.rejects(
    register(api),
    (error) => error instanceof Diagnostic && error.code === code,
  );
});

test("heartbeat warns once per failed tick and stop cancels the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const api = workerApi("http://127.0.0.1:1");
  const records: unknown[] = [];
  let calls = 0;
  const expectedCalls = 2;
  t.mock.method(api.worker, "heartbeat", async () => {
    calls++;
    return { type: OperationResultType.Indeterminate };
  });
  const timer = startHeartbeat(api, (record) => records.push(record));
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  await Promise.resolve();
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, expectedCalls);
  assert.equal(records.length, expectedCalls);
  timer.stop();
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.equal(calls, expectedCalls);
});

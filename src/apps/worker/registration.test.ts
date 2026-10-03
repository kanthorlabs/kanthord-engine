import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationResultType } from "../../kernel/operation.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { workerApi } from "./api.ts";
import { register } from "./registration.ts";

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

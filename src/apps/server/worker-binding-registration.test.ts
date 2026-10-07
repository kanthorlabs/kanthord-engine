import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "hono/jwt";
import { gatewayFixture } from "./test-support.ts";
import { httpClient } from "../../gateway/client.ts";
import { projectOperations, BindingKind } from "../../project/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";

const INITIAL_BINDING_VERSION = 1;
const SINGLE_INSTANCE = 1;
const TWO_INSTANCES = 2;
const NO_INSTANCES = 0;
const INPUT = { params: {}, query: {}, body: null };

test("binding availability changes end real registrations atomically and count recovery admits a fresh runtime identity", async (t) => {
  const f = await gatewayFixture(t);
  const project = httpClient(projectOperations, f.endpoint, f.token);
  const created = await project.create({
    params: {},
    query: {},
    body: { name: "registration-end" },
  });
  assert.ok(created.type === OperationResultType.Completed);
  const projectId = created.data.id;
  let version = INITIAL_BINDING_VERSION;
  const write = (count: number | null) =>
    project["bindingSet.write"]({
      params: { project_id: projectId },
      query: {},
      body: {
        version,
        bindings:
          count === null
            ? {}
            : {
                main: {
                  kind: BindingKind.Worker,
                  config: { worker: "claude@1", instance_count: count },
                },
              },
      },
    });
  const initial = await write(TWO_INSTANCES);
  assert.ok(initial.type === OperationResultType.Completed);
  version = initial.data.binding_set_version;
  const tokenA = await f.machineToken(projectId, "main");
  const tokenB = await f.machineToken(projectId, "main");
  const a = httpClient(workerOperations, f.endpoint, tokenA);
  const b = httpClient(workerOperations, f.endpoint, tokenB);
  const first = await a.register(INPUT);
  assert.ok(first.type === OperationResultType.Completed);
  assert.ok((await b.register(INPUT)).type === OperationResultType.Completed);
  const clientA = String(decode(tokenA).payload.sub);
  const clientB = String(decode(tokenB).payload.sub);
  const lowered = await write(SINGLE_INSTANCE);
  assert.ok(lowered.type === OperationResultType.Completed);
  version = lowered.data.binding_set_version;
  assert.ok(f.worker.registrations.findByClient(clientA));
  assert.ok(f.worker.registrations.findByClient(clientB));
  const end = f.worker.endRegistrations.bind(f.worker);
  const fail = t.mock.method(
    f.worker,
    "endRegistrations",
    (...args: Parameters<typeof end>) => {
      end(...args);
      throw new Error("rollback after group end");
    },
  );
  const failed = await write(NO_INSTANCES);
  assert.ok(failed.type === OperationResultType.Failure);
  assert.equal(failed.status, HttpStatus.InternalServerError);
  assert.ok(f.worker.registrations.findByClient(clientA));
  assert.ok(f.worker.registrations.findByClient(clientB));
  fail.mock.restore();
  const disabled = await write(NO_INSTANCES);
  assert.ok(disabled.type === OperationResultType.Completed);
  version = disabled.data.binding_set_version;
  assert.equal(f.worker.registrations.findByClient(clientA), undefined);
  assert.equal(f.worker.registrations.findByClient(clientB), undefined);
  const enabled = await write(SINGLE_INSTANCE);
  assert.ok(enabled.type === OperationResultType.Completed);
  version = enabled.data.binding_set_version;
  const next = await a.register(INPUT);
  assert.ok(next.type === OperationResultType.Completed);
  assert.notEqual(next.data.runtimeIdentity, first.data.runtimeIdentity);
  const removed = await write(null);
  assert.ok(removed.type === OperationResultType.Completed);
  assert.equal(f.worker.registrations.findByClient(clientA), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerService } from "./service.ts";
import { workerOperations } from "./contract.ts";
import { OperationRegistry } from "../kernel/operation.ts";
import { CancellationContext } from "../kernel/context.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationError } from "../kernel/errors.ts";

const client = {
  clientId: "client",
  name: "worker",
  workerBindingId: "binding",
  projectId: "project",
};

test("Worker owns registrations, declares its handler, and joins lifecycle calls", async () => {
  const health = new HealthRegistry();
  const worker = new WorkerService({ config: {}, health });
  const registry = new OperationRegistry();
  worker.declare(registry);
  assert.equal(
    registry.get(workerOperations.register.id).operation.service,
    workerOperations.register.service,
  );
  assert.equal(
    (await worker.healthcheck()).registrations,
    HealthStatus.Unavailable,
  );
  const starting = worker.start();
  assert.equal(starting, worker.start());
  assert.equal(await starting, null);
  assert.deepEqual(await health.check(), {
    worker: { registrations: HealthStatus.Healthy },
  });
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const registration = store.transaction((transaction) =>
      worker.registrations.register(transaction, client),
    );
    assert.equal(
      worker.registrations.findByClient(client.clientId),
      registration,
    );
    assert.throws(
      () =>
        store.transaction((transaction) =>
          worker.registrations.register(transaction, client),
        ),
      (error) =>
        error instanceof OperationError && error.status === HttpStatus.Conflict,
    );
    worker.registrations.deregister(registration.runtimeIdentity);
    assert.equal(worker.registrations.findByClient(client.clientId), undefined);
    const next = store.transaction((transaction) =>
      worker.registrations.register(transaction, client),
    );
    assert.notEqual(next.runtimeIdentity, registration.runtimeIdentity);
  } finally {
    store.close();
    assert.equal(await worker.stop(), null);
  }
  assert.equal(worker.stop(), worker.stop());
  assert.equal(
    (await worker.healthcheck()).registrations,
    HealthStatus.Unavailable,
  );
  assert.ok((await worker.start()) instanceof Error);
});

test("Worker run joins cancellation before and after startup", async () => {
  for (const before of [true, false]) {
    const worker = new WorkerService({ config: {} });
    const context = new CancellationContext();
    if (before) context.cancel();
    const running = worker.run(context);
    if (!before) context.cancel();
    assert.equal(await running, context.err());
    assert.equal(await worker.stop(), null);
  }
});

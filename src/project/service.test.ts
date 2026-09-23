import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectService } from "./service.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { OperationRegistry } from "../kernel/operation.ts";

const NO_OPERATIONS = 0;

test("Project declares no operations or configured bindings and owns its lifecycle probe", async () => {
  const health = new HealthRegistry();
  const project = new ProjectService({ config: {}, health });
  const registry = new OperationRegistry();
  project.declare(registry);
  assert.equal(registry.all().length, NO_OPERATIONS);
  assert.equal(await project.resolveWorkerBinding("absent", background), null);
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Unavailable },
  });
  const starting = project.start();
  assert.equal(starting, project.start());
  assert.equal(await starting, null);
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Healthy },
  });
  const stopping = project.stop();
  assert.equal(stopping, project.stop());
  assert.equal(await stopping, null);
  assert.ok((await project.start()) instanceof Error);
});

test("Project propagates cancellation to binding resolution and joins run", async () => {
  for (const before of [true, false]) {
    const project = new ProjectService({ config: {} });
    const context = new CancellationContext();
    if (before) context.cancel();
    const running = project.run(context);
    if (!before) context.cancel();
    assert.equal(await running, context.err());
    await assert.rejects(
      project.resolveWorkerBinding("absent", context),
      (error) => error === context.err(),
    );
    assert.equal(await project.stop(), null);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CancellationContext, type Context } from "./context.ts";
import {
  HealthRegistry,
  HealthScope,
  ResourceStatus,
  MAX_HEALTH_PROBES,
  type HealthProbe,
} from "./health.ts";
import { healthy } from "./service.ts";

test("resource status values are stable", () => {
  assert.deepEqual(ResourceStatus, {
    Healthy: "healthy",
    Unhealthy: "unhealthy",
    Unknown: "unknown",
  });
});

test("health scope values are stable", () => {
  assert.deepEqual(HealthScope, { Global: "global", Project: "project" });
});

test("health registration validates names, duplicates, probes, capacity and timeout", () => {
  const registry = new HealthRegistry();
  for (const name of ["", "../store", "store.sqlite", "Store"])
    assert.throws(
      () => registry.register(name, () => ({ sqlite: 200 })),
      /safe service name/,
    );
  assert.throws(
    () => registry.register("store", null as unknown as HealthProbe),
    /probe function/,
  );
  registry.register("store", () => ({ sqlite: 200 }));
  assert.throws(
    () => registry.register("store", () => ({ sqlite: 503 })),
    /Duplicate/,
  );
  for (let index = 1; index < MAX_HEALTH_PROBES; index++)
    registry.register(`service-${index}`, () => ({ component: 200 }));
  assert.throws(
    () => registry.register("overflow", () => ({ component: 200 })),
    /capacity/,
  );
  for (const timeout of [0, -1, 1.5, 5001, Infinity, NaN])
    assert.throws(() => new HealthRegistry(timeout), /timeout/);
});

test("health aggregation snapshots all registrations, probes concurrently and reads fresh component state", async () => {
  const registry = new HealthRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let workerStatus = 200;
  registry.register("project", async () => {
    entered.resolve();
    await release.promise;
    return { "llm-primary": 200 };
  });
  const checking = registry.check();
  registry.register("worker", () => ({ "instance-one": workerStatus }));
  await entered.promise;
  release.resolve();
  assert.deepEqual(await checking, { project: { "llm-primary": 200 } });
  assert.deepEqual(await registry.check(), {
    project: { "llm-primary": 200 },
    worker: { "instance-one": 200 },
  });
  workerStatus = 503;
  assert.deepEqual((await registry.check()).worker, { "instance-one": 503 });
  assert.deepEqual(await new HealthRegistry().check(), {});
  assert.equal(healthy({}), false);
});

test("probe failures and invalid maps stay visible without hiding healthy siblings or leaking exceptions", async () => {
  const registry = new HealthRegistry();
  registry.register("store", () => ({ sqlite: 200 }));
  registry.register("throws", () => {
    throw new Error("secret credential");
  });
  registry.register("rejects", async () => {
    throw new Error("private endpoint");
  });
  registry.register("empty", () => ({}));
  registry.register("invalid", () => ({ provider: 201 }));
  registry.register("blank", () => ({ "": 200 }));
  registry.register("missing", (() => undefined) as unknown as HealthProbe);
  registry.register("worker", () => ({ live: 200, offline: 503 }));
  const result = await registry.check();
  assert.deepEqual(result, {
    store: { sqlite: 200 },
    throws: { healthcheck: 503 },
    rejects: { healthcheck: 503 },
    empty: { healthcheck: 503 },
    invalid: { healthcheck: 503 },
    blank: { healthcheck: 503 },
    missing: { healthcheck: 503 },
    worker: { live: 200, offline: 503 },
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|credential|private|endpoint/,
  );
});

test("all probes start before waiting; timed-out probes receive cancellation and cannot block the report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const registry = new HealthRegistry(20);
  const expectedProbeCount = 2;
  const contexts: Context[] = [];
  const entered = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  registry.register("hung", (context) => {
    contexts.push(context);
    entered.resolve();
    return new Promise(() => {});
  });
  registry.register("store", (context) => {
    contexts.push(context);
    second.resolve();
    return { sqlite: 200 };
  });
  const checking = registry.check();
  await Promise.all([entered.promise, second.promise]);
  t.mock.timers.tick(20);
  assert.deepEqual(await checking, {
    hung: { healthcheck: 503 },
    store: { sqlite: 200 },
  });
  assert.equal(contexts.length, expectedProbeCount);
  assert.ok(contexts.every((context) => context.err() !== null));
});

test("caller cancellation releases child probes and propagates instead of reporting success", async () => {
  const parent = new CancellationContext();
  const registry = new HealthRegistry();
  const entered = Promise.withResolvers<Context>();
  registry.register("worker", (context) => {
    entered.resolve(context);
    return new Promise(() => {});
  });
  const checking = registry.check(parent);
  const child = await entered.promise;
  parent.cancel();
  await assert.rejects(checking, (error) => error === parent.err());
  assert.equal(child.err(), parent.err());
  await assert.rejects(
    registry.check(parent),
    (error) => error === parent.err(),
  );
});

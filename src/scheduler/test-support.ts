import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { z } from "zod";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { createIdentity } from "../kernel/identity.ts";
import { DEFAULT_RELEASE_RESERVE_SECONDS } from "./config.ts";
import {
  SCHEDULER_SERVICE_NAME,
  schedulerOperations,
  type ExecutionRow,
} from "./contract.ts";
import { schedulerMigrations } from "./migrations.ts";
import { SchedulerService, type Dependencies } from "./service.ts";

export const FIXTURE_TRACE_ID = "1234567890abcdef1234567890abcdef";
export const FIXTURE_SPAN_ID = "1234567890abcdef";
export const FIXTURE_NOW = 1000;
export const FIXTURE_DEADLINE = 2000;
const NO_REVISION = 0;

export function executionFixture(
  overrides: Partial<ExecutionRow> = {},
): ExecutionRow {
  const row = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    workerBindingId: createIdentity("binding"),
    resourceIdentity: "worker:kanthord:general",
    runtimeIdentity: createIdentity("worker_instance"),
    attempt: 1,
    pinnedRevision: 1,
    credentials: [],
    expiredAt: FIXTURE_DEADLINE,
    traceId: FIXTURE_TRACE_ID,
    rootSpanId: FIXTURE_SPAN_ID,
    createdAt: FIXTURE_NOW,
    endedAt: null,
    ...overrides,
  };
  assert.ok(row.attempt > NO_REVISION);
  assert.ok(row.pinnedRevision > NO_REVISION);
  return row;
}

export function schedulerHarness(
  t: TestContext,
  overrides: Partial<Dependencies> = {},
) {
  const store = overrides.store ?? new Store(IN_MEMORY_DATABASE);
  if (!overrides.store) t.after(() => store.close());
  store.migrate([
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
  ]);
  const calls: { method: string; arguments: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, arguments: args });
  };
  const dependencies: Dependencies = {
    store,
    config: { release_reserve: DEFAULT_RELEASE_RESERVE_SECONDS },
    transitions: {
      claim: (...args) => {
        record("claim", args);
        return null;
      },
      release: (...args) => record("release", args),
      loss: (...args) => record("loss", args),
    },
    registrations: {
      clientAttributionOf: (...args) => {
        record("clientAttributionOf", args);
        return null;
      },
      instanceHealthcheck: (...args) => {
        record("instanceHealthcheck", args);
        return true;
      },
    },
    declarations: {
      declarationOf: (...args) => {
        record("declarationOf", args);
        return null;
      },
    },
    bindings: {
      workerBindingOf: (...args) => {
        record("workerBindingOf", args);
        return null;
      },
    },
    traceIdentity: {
      mint: () => {
        record("mint", []);
        return { traceId: FIXTURE_TRACE_ID, rootSpanId: FIXTURE_SPAN_ID };
      },
    },
    ...overrides,
  };
  const service = new SchedulerService(dependencies);
  t.after(() => service.stop());
  const registry = new OperationRegistry();
  service.declare(registry);
  async function invoke<K extends keyof typeof schedulerOperations>(
    key: K,
    input: unknown,
    caller: CallerContext,
  ): Promise<z.output<(typeof schedulerOperations)[K]["output"]>> {
    const operation = schedulerOperations[key];
    const registered = registry.get(operation.id);
    assert.equal(registered.operation, operation);
    assert.equal(operation.service, SCHEDULER_SERVICE_NAME);
    return operation.output.parse(
      await registered.handler(operation.input.parse(input), caller),
    ) as z.output<(typeof schedulerOperations)[K]["output"]>;
  }
  return { store, service, registry, dependencies, calls, invoke };
}

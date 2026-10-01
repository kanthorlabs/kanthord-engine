import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import pino from "pino";
import { configuration } from "../../config/index.ts";
import { custodyMigrations } from "../../custody/index.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import { schedulerMigrations } from "../../scheduler/index.ts";
import { SCHEDULER_SERVICE_NAME } from "../../scheduler/contract.ts";
import { Store } from "../../kernel/store.ts";
import { gatewayMigrations } from "../../gateway/index.ts";
import { projectMigrations } from "../../project/index.ts";
import { missionMigrations } from "../../mission/index.ts";
import { MISSION_SERVICE_NAME } from "../../mission/contract.ts";
import { workerMigrations } from "../../worker/index.ts";
import { composeServices } from "./index.ts";
import type { OperationRegistry } from "../../kernel/operation.ts";
import {
  workerResourceIdentity,
  type ProjectBindings,
} from "../../project/contract.ts";
import {
  InstanceActivity,
  type WorkerRegistrations,
} from "../../worker/contract.ts";
export interface MachineDependencies {
  project: ProjectBindings;
  worker: WorkerRegistrations;
}
import type { Registration, VerifiedClient } from "../../worker/contract.ts";
import type { Transaction } from "../../kernel/store.ts";
import { throwIfCancelled, type Context } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationError as GatewayError } from "../../kernel/errors.ts";
import { KANTHORD_AUTH_USERNAME } from "../../gateway/local.ts";
import { generateHumanJWT, generateMachineJWT } from "../../gateway/local.ts";
import { HealthRegistry } from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";

export const domainHealth = {
  repository: { toolchain: HealthStatus.Healthy },
  scheduler: { queue: 200 },
  custody: { credential: 200 },
  project: { bindings: 200 },
  worker: { registrations: 200 },
  mission: { operations: 200 },
};

export const TEST_WORKER_BINDING = "binding";
export const TEST_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SINGLE_INSTANCE = 1;
const NO_INSTANCES = 0;

export function fakeMachines(
  options: {
    bindings?: Map<
      string,
      { projectId: string; capacity: number; available?: boolean }
    >;
  } = {},
) {
  const bindings =
    options.bindings ??
    new Map([
      [
        TEST_WORKER_BINDING,
        {
          projectId: TEST_PROJECT_ID,
          capacity: SINGLE_INSTANCE,
          available: true,
        },
      ],
    ]);
  const registrations = new Map<string, Registration>();
  const registrationHistory = new Map<string, Registration>();
  const project = {
    bindings,
    async resolveWorkerGroup(
      projectId: string,
      resourceIdentity: string,
      _issuedAt: number,
      context: Context,
    ) {
      throwIfCancelled(context);
      const match = [...bindings].find(
        ([name, binding]) =>
          workerResourceIdentity(name) === resourceIdentity &&
          binding.projectId === projectId &&
          binding.available !== false &&
          binding.capacity > NO_INSTANCES,
      );
      return match ? { projectId, resourceIdentity } : null;
    },
  };
  const worker = {
    registrations,
    findByClient: (clientId: string) => registrations.get(clientId),
    liveRegistrationOf(tx: Transaction, runtimeIdentity: string) {
      assert.ok(tx.database.isTransaction);
      assert.ok(runtimeIdentity);
      const row = registrationHistory.get(runtimeIdentity);
      return row &&
        registrations.get(row.clientId)?.runtimeIdentity === runtimeIdentity
        ? row
        : null;
    },
    clientAttributionOf(tx: Transaction, runtimeIdentity: string) {
      assert.ok(tx.database.isTransaction);
      assert.ok(runtimeIdentity);
      const row = registrationHistory.get(runtimeIdentity);
      return row ? { clientId: row.clientId, name: row.name } : null;
    },
    heartbeat: (runtimeIdentity: string) => {
      assert.ok(runtimeIdentity);
    },
    register(
      transaction: Transaction,
      client: VerifiedClient,
      now: number,
    ): Registration {
      assert.ok(transaction.database.isTransaction);
      const binding = [...bindings].find(
        ([name, binding]) =>
          workerResourceIdentity(name) === client.resourceIdentity &&
          binding.projectId === client.projectId,
      )?.[1];
      assert.ok(binding && binding.available !== false);
      assert.equal(binding.projectId, client.projectId);
      assert.ok(
        Number.isSafeInteger(binding.capacity) &&
          binding.capacity >= NO_INSTANCES,
      );
      const previous = registrations.get(client.clientId);
      if (previous) return previous;
      const count = [...registrations.values()].filter(
        (entry) =>
          entry.resourceIdentity === client.resourceIdentity &&
          entry.projectId === client.projectId,
      ).length;
      if (count >= binding.capacity)
        throw new GatewayError(
          HttpStatus.Conflict,
          "worker.instance.slot_unavailable",
          "Worker binding is at capacity.",
        );
      const registration = {
        ...client,
        runtimeIdentity: createIdentity("worker_instance"),
        registeredAt: now,
      };
      registrations.set(client.clientId, registration);
      registrationHistory.set(registration.runtimeIdentity, registration);
      return registration;
    },
    deregister(runtimeIdentity: string): void {
      for (const [clientId, registration] of registrations)
        if (registration.runtimeIdentity === runtimeIdentity)
          registrations.delete(clientId);
    },
    restart(): void {
      registrations.clear();
    },
  };
  return { project, worker } satisfies MachineDependencies;
}

export async function gatewayFixture(
  t: TestContext,
  options: {
    registry?: OperationRegistry;
    health?: HealthRegistry;
    repositoryConnector?: Parameters<
      typeof composeServices
    >[0]["repositoryConnector"];
    machines?: MachineDependencies;
    inventoryOverrides?: Parameters<
      typeof composeServices
    >[0]["inventoryOverrides"];
    path?: string;
    standIns?: Parameters<typeof composeServices>[0]["standIns"];
  } = {},
) {
  process.umask(0o077);
  const config = configuration({
    masterKey: randomBytes(32).toString("base64"),
    gateway: { port: 0, allowedHosts: ["localhost"] },
  }).getProperties();
  const store = new Store(options.path ?? ":memory:");
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
    { service: "gateway", migrations: gatewayMigrations },
    { service: "worker", migrations: workerMigrations },
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
    { service: "project", migrations: projectMigrations },
  ]);
  const logs: string[] = [];
  const {
    scheduler,
    custody,
    gateway,
    project,
    worker,
    mission,
    invocation,
    repoConnector,
  } = composeServices({
    config,
    store,
    registry: options.registry,
    health: options.health ?? new HealthRegistry(),
    repositoryConnector: options.repositoryConnector,
    bindings: options.machines?.project,
    registrations: options.machines?.worker,
    inventoryOverrides: options.inventoryOverrides,
    standIns: {
      schedulerClaims: {
        revoke: () => null,
        settle: () => {},
        liveExecutionOf: () => null,
      },
      wakeup: { wake: () => {} },
      executionAttribution: { of: () => null },
      ...options.standIns,
      workerSchedulerClaims: {
        runningExecutionOfRuntime: () => null,
        activityOf: () => ({
          activity: InstanceActivity.Idle,
          executionId: null,
        }),
        ...options.standIns?.workerSchedulerClaims,
      },
    },
    logger: pino(
      { level: "info" },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    ),
  });
  t.after(async () => {
    const failures: Error[] = [];
    try {
      const quiescence = await Promise.all(
        [scheduler, custody, worker, mission, project, gateway].map((service) =>
          service.quiesce(),
        ),
      );
      failures.push(...quiescence.filter((error) => error !== null));
      await gateway.drain();
      const invocationError = await invocation.stop();
      if (invocationError) failures.push(invocationError);
      for (const service of [
        gateway,
        project,
        mission,
        worker,
        custody,
        scheduler,
      ]) {
        const error = await service.stop();
        if (error) failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Fixture cleanup failed.");
    } finally {
      store.close();
    }
  });
  for (const service of [
    scheduler,
    custody,
    worker,
    mission,
    project,
    gateway,
  ]) {
    const error = await service.start();
    if (error) throw error;
  }
  const port = gateway.address()!.port;
  config.gateway.allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const endpoint = `http://127.0.0.1:${port}`;
  const request = (path: string, init?: RequestInit) =>
    fetch(endpoint + path, init);
  return {
    repoConnector,
    scheduler,
    worker,
    custody,
    mission,
    gateway,
    store,
    endpoint,
    request,
    token: (
      await generateHumanJWT(config.masterKey, config.gateway.tokenLifetime)
    ).token,
    machineToken: async (
      projectId: string,
      bindingName: string,
      name?: string,
    ) =>
      (
        await generateMachineJWT(
          config.masterKey,
          config.gateway.tokenLifetime,
          { projectId, bindingName },
          name,
        )
      ).token,
    config,
    accountId: KANTHORD_AUTH_USERNAME,
    logs,
  };
}

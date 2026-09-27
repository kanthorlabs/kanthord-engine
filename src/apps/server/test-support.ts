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
import { workerMigrations } from "../../worker/index.ts";
import { composeServices } from "./index.ts";
import type { OperationRegistry } from "../../kernel/operation.ts";
import type { ProjectBindings } from "../../project/contract.ts";
import type { WorkerRegistrations } from "../../worker/contract.ts";
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
};

export const TEST_WORKER_BINDING = "binding";
export const TEST_PROJECT_ID = "project";
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
  const project = {
    bindings,
    async resolveWorkerBinding(bindingId: string, context: Context) {
      throwIfCancelled(context);
      const binding = bindings.get(bindingId);
      if (!binding || binding.available === false) return null;
      return { workerBindingId: bindingId, projectId: binding.projectId };
    },
  };
  const worker = {
    registrations,
    findByClient: (clientId: string) => registrations.get(clientId),
    register(transaction: Transaction, client: VerifiedClient): Registration {
      assert.ok(transaction.database.isTransaction);
      const binding = bindings.get(client.workerBindingId);
      assert.ok(binding && binding.available !== false);
      assert.equal(binding.projectId, client.projectId);
      assert.ok(
        Number.isSafeInteger(binding.capacity) &&
          binding.capacity >= NO_INSTANCES,
      );
      if (registrations.has(client.clientId))
        throw new GatewayError(
          HttpStatus.Conflict,
          "gateway.registration.conflict",
          "Client identity already holds a live registration.",
        );
      const count = [...registrations.values()].filter(
        (entry) => entry.workerBindingId === client.workerBindingId,
      ).length;
      if (count >= binding.capacity)
        throw new GatewayError(
          HttpStatus.Conflict,
          "gateway.registration.capacity",
          "Worker binding is at capacity.",
        );
      const registration = {
        ...client,
        runtimeIdentity: createIdentity("runtime_identity"),
      };
      registrations.set(client.clientId, registration);
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
    standIns?: Parameters<typeof composeServices>[0]["standIns"];
    path?: string;
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
    { service: "project", migrations: projectMigrations },
  ]);
  const logs: string[] = [];
  const {
    scheduler,
    custody,
    gateway,
    project,
    worker,
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
    standIns: options.standIns,
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
        [scheduler, custody, worker, project, gateway].map((service) =>
          service.quiesce(),
        ),
      );
      failures.push(...quiescence.filter((error) => error !== null));
      await gateway.drain();
      const invocationError = await invocation.stop();
      if (invocationError) failures.push(invocationError);
      for (const service of [gateway, project, worker, custody, scheduler]) {
        const error = await service.stop();
        if (error) failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Fixture cleanup failed.");
    } finally {
      store.close();
    }
  });
  for (const service of [scheduler, custody, worker, project, gateway]) {
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
    custody,
    gateway,
    store,
    endpoint,
    request,
    token: (
      await generateHumanJWT(config.masterKey, config.gateway.tokenLifetime)
    ).token,
    machineToken: async (binding: string, name?: string) =>
      (
        await generateMachineJWT(
          config.masterKey,
          config.gateway.tokenLifetime,
          binding,
          name,
        )
      ).token,
    config,
    accountId: KANTHORD_AUTH_USERNAME,
    logs,
  };
}

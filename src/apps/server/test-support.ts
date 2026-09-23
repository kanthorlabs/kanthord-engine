import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import pino from "pino";
import { configuration } from "../../config/index.ts";
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

export const domainHealth = {
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
    machines?: MachineDependencies;
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
    { service: "gateway", migrations: gatewayMigrations },
    { service: "worker", migrations: workerMigrations },
    { service: "project", migrations: projectMigrations },
  ]);
  const logs: string[] = [];
  const { gateway, project, worker } = composeServices({
    config,
    store,
    registry: options.registry,
    health: options.health ?? new HealthRegistry(),
    bindings: options.machines?.project,
    registrations: options.machines?.worker,
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
      for (const service of [gateway, worker, project]) {
        const error = await service.stop();
        if (error) failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Fixture cleanup failed.");
    } finally {
      store.close();
    }
  });
  for (const service of [project, worker, gateway]) {
    const error = await service.start();
    if (error) throw error;
  }
  const port = gateway.address()!.port;
  config.gateway.allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const endpoint = `http://127.0.0.1:${port}`;
  const request = (path: string, init?: RequestInit) =>
    fetch(endpoint + path, init);
  return {
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import pino from "pino";
import { configuration } from "./config/index.ts";
import { Store } from "./store.ts";
import { gatewayMigrations } from "./gateway/migrations.ts";
import { GatewayService } from "./gateway/service.ts";
import { OperationRegistry } from "./gateway/registry.ts";
import type {
  MachineDependencies,
  Registration,
  VerifiedClient,
} from "./gateway/contracts.ts";
import type { Transaction } from "./store.ts";
import { throwIfCancelled, type Context } from "./context.ts";
import { createIdentity } from "./shared/identity.ts";
import { HttpStatus } from "./shared/http.ts";
import { GatewayError } from "./gateway/errors.ts";
import { KANTHORD_AUTH_USERNAME } from "./gateway/constants.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
} from "./gateway/authentication.ts";
import type { HealthRegistry } from "./health.ts";

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

export function temporary(t: TestContext): string {
  process.umask(0o077);
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, "kanthord-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
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
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const logs: string[] = [];
  const gateway = new GatewayService({
    config,
    store,
    registry: options.registry,
    health: options.health,
    machines: options.machines,
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
    try {
      const error = await gateway.stop();
      if (error) throw error;
    } finally {
      store.close();
    }
  });
  const error = await gateway.start();
  if (error) throw error;
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

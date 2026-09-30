import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import convict from "convict";
import pino, { type Logger } from "pino";
import {
  globalConfigSchema,
  MASTER_KEY_BYTES,
  type GlobalConfig,
} from "../config/global.ts";
import { Store } from "../kernel/store.ts";
import { OperationRegistry, StoreName } from "../kernel/operation.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import type { Registration } from "../worker/contract.ts";
import {
  Authentication,
  type AuthenticationLookups,
} from "./authentication.ts";
import { gatewayConfigSchema, type GatewayConfig } from "./config.ts";
import type { InventoryCollector } from "./contract.ts";
import { gatewayMigrations } from "./migrations.ts";
import { GatewayService } from "./service.ts";
import { createInvocation } from "./index.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
  KANTHORD_AUTH_USERNAME,
} from "./local.ts";

type TestConfig = GlobalConfig & { gateway: GatewayConfig };
export const TEST_WORKER_BINDING = "binding";
export const TEST_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";

export function configuration(value: unknown) {
  const config = convict<TestConfig>(
    { ...globalConfigSchema, gateway: gatewayConfigSchema },
    { args: [], env: {} },
  ).load(value);
  config.validate({ allowed: "strict" });
  return config;
}

export function fakeLookups() {
  const registrations = new Map<string, Registration>();
  const worker = {
    registrations,
    findByClient: (client: string) => registrations.get(client),
  };
  return {
    project: {
      async resolveWorkerGroup(
        projectId: string,
        resourceIdentity: string,
        _issuedAt: number,
        context: Context,
      ) {
        throwIfCancelled(context);
        return projectId === TEST_PROJECT_ID &&
          resourceIdentity === `worker:kanthord:${TEST_WORKER_BINDING}`
          ? { projectId, resourceIdentity }
          : null;
      },
    },
    worker,
  } satisfies AuthenticationLookups;
}

function storeAt(path = ":memory:"): Store {
  const store = new Store(path);
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  return store;
}

async function tokens(config: TestConfig) {
  return {
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
    accountId: KANTHORD_AUTH_USERNAME,
  };
}

export async function authenticationFixture(
  t: TestContext,
  lookups: AuthenticationLookups = fakeLookups(),
) {
  const config = configuration({
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
  }).getProperties();
  const store = storeAt();
  t.after(() => store.close());
  const authentication = new Authentication(config.masterKey, lookups);
  return { config, store, authentication, ...(await tokens(config)) };
}

export function composeGateway(options: {
  config: TestConfig;
  store: Store;
  logger: Logger;
  registry?: OperationRegistry;
  health?: HealthRegistry;
  lookups?: AuthenticationLookups;
  collect?: InventoryCollector;
}): GatewayService {
  const registry = options.registry ?? new OperationRegistry();
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: options.store },
    idempotencyTtl: options.config.gateway.idempotencyTtl,
    masterKey: options.config.masterKey,
    tokenLifetime: options.config.gateway.tokenLifetime,
    lookups: options.lookups,
  });
  const gateway = new GatewayService({
    config: options.config.gateway,
    logger: options.logger,
    registry,
    invocation,
    health: options.health,
  });
  gateway.declare(
    registry,
    options.collect ?? (() => ({ entries: [], missingInventories: [] })),
    options.logger,
  );
  registry.seal({ [StoreName.Operational]: options.store });
  return gateway;
}

export async function gatewayFixture(
  t: TestContext,
  options: {
    registry?: OperationRegistry;
    health?: HealthRegistry;
    lookups?: AuthenticationLookups;
    collect?: InventoryCollector;
    path?: string;
  } = {},
) {
  process.umask(0o077);
  const config = configuration({
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    gateway: { port: 0, allowedHosts: ["localhost"] },
  }).getProperties();
  const store = storeAt(options.path);
  const logs: string[] = [];
  const gateway = composeGateway({
    ...options,
    config,
    store,
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
      await gateway.quiesce();
      await gateway.drain();
      const invocationError = await gateway.invocation.stop();
      const error = (await gateway.stop()) ?? invocationError;
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
    config,
    endpoint,
    request,
    logs,
    ...(await tokens(config)),
  };
}

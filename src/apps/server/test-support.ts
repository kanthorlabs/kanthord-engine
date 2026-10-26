import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import { IdentityKind } from "../../kernel/caller.ts";
import { join } from "node:path";
import { WorkerUnit } from "../worker/unit.ts";
import { directories } from "../../kernel/xdg.ts";
import type { ModelRuntimeFactory } from "../../worker/unit/index.ts";
import { httpTransport } from "../worker/transport.ts";
import { requirePiTools, temporary } from "../../kernel/test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  REPOSITORY_COMPONENT_NAME,
  repositoryOperations,
} from "../../repository/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import {
  missionOperations,
  Intent,
  NodeState,
} from "../../mission/contract.ts";
import {
  OperationResultType,
  type Operation,
  type OperationResult,
} from "../../kernel/operation.ts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { TestContext } from "node:test";
import pino from "pino";
import { z } from "zod";
import { configuration, CONFIG_VERSION } from "../../config/index.ts";
import { custodyMigrations } from "../../custody/index.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import { schedulerMigrations } from "../../scheduler/index.ts";
import {
  SCHEDULER_SERVICE_NAME,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import type { SchedulerConfig } from "../../scheduler/index.ts";
import { Store } from "../../kernel/store.ts";
import { gatewayMigrations } from "../../gateway/index.ts";
import { projectMigrations } from "../../project/index.ts";
import { missionMigrations } from "../../mission/index.ts";
import { intakeMigrations } from "../../intake/index.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import {
  AssetKind,
  MISSION_SERVICE_NAME,
  PlatformAddressKind,
  type Revision,
} from "../../mission/contract.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { workerMigrations } from "../../worker/index.ts";
import { agentMigrations } from "../../agent/index.ts";
import { workbenchMigrations } from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { fakeRepositoryFiles } from "./container-fakes.ts";
import { environment, kanthord } from "./cli-support.ts";
import { composeServices, trackingDatabaseMigrations } from "./index.ts";
import {
  RepositoryComponent,
  repositoryMigrations,
  type GitWriter,
  type HostKeySources,
} from "../../repository/index.ts";
import { GITHUB_API_VERSION } from "../../repository/github.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../../repository/test-sshd.ts";
import {
  alwaysAvailable,
  InstancePlacement,
  PoolPlacement,
  type PlacementStatus,
  type RepositoryTransport,
} from "../../worker/contract.ts";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  StoreName,
  type OperationRegistry,
} from "../../kernel/operation.ts";
import {
  workerResourceIdentity,
  type ProjectBindings,
} from "../../project/contract.ts";
import type { PoolSlot, WorkerRegistrations } from "../../worker/contract.ts";
export interface MachineDependencies {
  project: ProjectBindings;
  worker: WorkerRegistrations;
}
import type { Registration, VerifiedClient } from "../../worker/contract.ts";
import type { Transaction } from "../../kernel/store.ts";
import { type Context } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { isString } from "../../kernel/values.ts";
import { OperationError as GatewayError } from "../../kernel/errors.ts";
import { KANTHORD_AUTH_USERNAME } from "../../gateway/auth/jwt.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
  signingKey,
} from "../../gateway/auth/jwt.ts";
import type {
  SlotDriver,
  SlotExit,
  SlotInstance,
  SlotLaunch,
} from "./slot-driver.ts";
import { HealthRegistry } from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";

export const servicePing = {
  id: "test.service.ping",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: HttpMethod.Post,
  path: "/api/test/ping",
  access: AccessPolicy.Service,
  timeoutMs: 30000,
  mutation: true,
  input: emptyInput,
  output: z.strictObject({ pong: z.literal(true) }),
  status: HttpStatus.OK,
  description: "Test the service access policy.",
} as const;

export const COVERING_WORKER_BINDINGS = {
  coder: {
    kind: "worker",
    config: {
      worker: "coder@1",
      placement: "server",
      instance_count: 0,
      tags: [],
    },
  },
  reviewer: {
    kind: "worker",
    config: {
      worker: "reviewer@1",
      placement: "server",
      instance_count: 0,
      tags: [],
    },
  },
} as const;
export const COVERING_AGENTS = ["swe@1", "re@1"] as const;
const FIRST_SLOT = 0;
const MILLISECONDS_PER_SECOND = 1000;
const SLOT_EXIT: SlotExit = { code: 0, error: null };

export class FakeSlotInstance implements SlotInstance {
  private readonly exit = Promise.withResolvers<SlotExit>();
  readonly exited = this.exit.promise;

  control(): void {
    this.exit.resolve(SLOT_EXIT);
  }

  terminate(): void {
    this.exit.resolve(SLOT_EXIT);
  }
}

export class FakeSlotDriver implements SlotDriver {
  readonly placement = PoolPlacement.Server;
  private readonly launches: SlotLaunch[] = [];
  private readonly waiters: Array<() => void> = [];

  check(): Promise<PlacementStatus> {
    return Promise.resolve(alwaysAvailable(this.placement));
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  removeVolume(): Promise<void> {
    return Promise.resolve();
  }

  sweepVolumes(): Promise<void> {
    return Promise.resolve();
  }

  launch(launch: SlotLaunch): SlotInstance {
    this.launches.push(launch);
    for (const wake of this.waiters.splice(0)) wake();
    return new FakeSlotInstance();
  }

  async launched(
    projectId: string,
    resourceIdentity: string,
    slot: number,
  ): Promise<SlotLaunch> {
    for (;;) {
      const found = this.launches.findLast(
        (launch) =>
          launch.slot.project_id === projectId &&
          launch.slot.resource_identity === resourceIdentity &&
          launch.slot.slot === slot,
      );
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type EnablementBody = z.input<
  (typeof agentOperations)["enablement.put"]["input"]
>["body"];
export interface CoveringProvider {
  platform: EnablementBody["agent_providers"][number]["provider"];
  credential: string;
  configuration: EnablementBody["default_configuration"];
}

export async function enableCoveringAgents(
  env: NodeJS.ProcessEnv,
  provider?: CoveringProvider,
): Promise<void> {
  assert.ok(env.KANTHORD_ENDPOINT);
  assert.ok(env.KANTHORD_TOKEN);
  const call = humanCaller({
    endpoint: env.KANTHORD_ENDPOINT,
    token: env.KANTHORD_TOKEN,
  });
  const enabled: CoveringProvider = provider ?? {
    platform: "anthropic",
    credential: "covering-llm",
    configuration: NATIVE_DEFAULTS,
  };
  if (provider === undefined)
    await call(llmOperations.create, {
      params: {},
      query: {},
      body: {
        name: enabled.credential,
        platform: "anthropic",
        metadata: null,
        [SECRET_FIELD]: { key: "covering-provider-key" },
      },
    });
  for (const agent of COVERING_AGENTS)
    await call(agentOperations["enablement.put"], {
      params: { agent_name: agent },
      query: {},
      body: {
        agent_providers: [
          {
            name: enabled.configuration.agent_provider,
            provider: enabled.platform,
            credential: enabled.credential,
          },
        ],
        default_configuration: enabled.configuration,
        fallback_configurations: [],
      },
    });
}

export async function holdCoveringCredential(
  env: NodeJS.ProcessEnv,
  holder: string,
): Promise<void> {
  assert.ok(env.KANTHORD_ENDPOINT);
  assert.ok(env.KANTHORD_TOKEN);
  await humanCaller({
    endpoint: env.KANTHORD_ENDPOINT,
    token: env.KANTHORD_TOKEN,
  })(llmOperations.create, {
    params: {},
    query: {},
    body: {
      name: "covering-llm",
      platform: "anthropic",
      metadata: null,
      holders: [holder],
      [SECRET_FIELD]: { key: "covering-provider-key" },
    },
  });
}

const COVERING_APPLY_EXIT = 0;

export async function applyCoveringBindings(
  env: NodeJS.ProcessEnv,
  directory: string,
  projectId: string,
  version = 1,
): Promise<number> {
  const path = join(directory, `covering-${projectId}-${version}.json`);
  writePrivate(
    path,
    JSON.stringify({ version, bindings: COVERING_WORKER_BINDINGS }),
  );
  const result = await kanthord(
    ["project", "binding", "apply", projectId, "--file", path],
    env,
  );
  assert.equal(result.code, COVERING_APPLY_EXIT, result.stderr);
  return (JSON.parse(result.stdout) as { binding_set_version: number })
    .binding_set_version;
}

export const domainHealth = {
  repository: { toolchain: HealthStatus.Healthy },
  scheduler: { queue: 200 },
  custody: { credential: 200 },
  project: { bindings: 200 },
  worker: { registrations: 200 },
  mission: { operations: 200 },
  intake: { events: 200 },
  tracking: { store: 200 },
};

export async function inProcessWorker(
  t: TestContext,
  input: {
    endpoint: string;
    token: string;
    client_secret: string;
    modelRuntimeFactory?: ModelRuntimeFactory;
    repositoryTransport?: RepositoryTransport;
  },
) {
  requirePiTools();
  const root = temporary(t);
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const state = directories(env).state;
  const logs: Record<string, unknown>[] = [];
  const ready = Promise.withResolvers<void>();
  const readyMessage = "Worker application ready";
  const worker = new WorkerUnit({
    bindings: [
      {
        transport: httpTransport(input.endpoint, input.token),
        client_secret: input.client_secret,
      },
    ],
    directories: { data: state, log: state },
    env,
    model_runtime_factory: input.modelRuntimeFactory,
    repository_transport: input.repositoryTransport,
    log: (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      logs.push(record);
      if (record.msg === readyMessage) ready.resolve();
    },
  });
  const stop = () => {
    void worker.stop();
  };
  process.on("SIGTERM", stop);
  const running = worker.run();
  t.after(async () => {
    process.off("SIGTERM", stop);
    await worker.stop();
    await running;
  });
  await Promise.race([
    ready.promise,
    running.then((error) => {
      throw error ?? new Error("Worker ended before ready");
    }),
  ]);
  return { worker, env, logs, running };
}

export const TEST_WORKER_BINDING = "binding";
export const TEST_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const FAKE_SSH_CREDENTIAL = "github-ssh";
export const FAKE_SSH_HOST = "github.com";
export const FAKE_GITHUB_HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
export const FAKE_GITHUB_HOST_KEY_FINGERPRINT =
  "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
export const FAKE_HOST_KEY_SOURCES: HostKeySources = {
  githubMeta: async () => ({ ssh_keys: [FAKE_GITHUB_HOST_KEY] }),
  keyscan: async (host) => {
    throw new Error(`The test host key sources read no key of ${host}.`);
  },
};
const SINGLE_INSTANCE = 1;
const NO_INSTANCES = 0;
const CHECKSUM_HEADER = "x-amz-checksum-sha256";
const ZERO_BYTES = 0;
const EPHEMERAL_PORT = 0;

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
      context.signal.throwIfAborted();
      const match = [...bindings].find(
        ([name, binding]) =>
          workerResourceIdentity(name) === resourceIdentity &&
          binding.projectId === projectId &&
          binding.available !== false &&
          binding.capacity > NO_INSTANCES,
      );
      return match
        ? { project_id: projectId, resource_identity: resourceIdentity }
        : null;
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
        registrations.get(row.client_id)?.runtime_identity === runtimeIdentity
        ? row
        : null;
    },
    clientAttributionOf(tx: Transaction, runtimeIdentity: string) {
      assert.ok(tx.database.isTransaction);
      assert.ok(runtimeIdentity);
      const row = registrationHistory.get(runtimeIdentity);
      return row ? { client_id: row.client_id, name: row.name } : null;
    },
    heartbeat: (runtimeIdentity: string) => {
      assert.ok(runtimeIdentity);
    },
    register(
      transaction: Transaction,
      client: VerifiedClient,
      now: number,
    ): Registration & { worker_name: string } {
      assert.ok(transaction.database.isTransaction);
      const binding = [...bindings].find(
        ([name, binding]) =>
          workerResourceIdentity(name) === client.resource_identity &&
          binding.projectId === client.project_id,
      )?.[1];
      assert.ok(binding && binding.available !== false);
      assert.equal(binding.projectId, client.project_id);
      assert.ok(
        Number.isSafeInteger(binding.capacity) &&
          binding.capacity >= NO_INSTANCES,
      );
      const previous = registrations.get(client.client_id);
      if (previous) return { ...previous, worker_name: "coder@1" };
      const count = [...registrations.values()].filter(
        (entry) =>
          entry.resource_identity === client.resource_identity &&
          entry.project_id === client.project_id,
      ).length;
      if (count >= binding.capacity)
        throw new GatewayError(
          HttpStatus.Conflict,
          "worker.registration.slot_unavailable",
          "Worker binding is at capacity.",
        );
      const registration = {
        ...client,
        worker_name: "coder@1",
        runtime_identity: createIdentity("worker_registration"),
        registered_at: now,
      };
      registrations.set(client.client_id, registration);
      registrationHistory.set(registration.runtime_identity, registration);
      return registration;
    },
    deregister(tx: Transaction, runtimeIdentity: string, now: number): void {
      assert.ok(tx.database.isTransaction);
      assert.ok(Number.isSafeInteger(now));
      const row = registrationHistory.get(runtimeIdentity);
      if (
        row &&
        registrations.get(row.client_id)?.runtime_identity === runtimeIdentity
      )
        registrations.delete(row.client_id);
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
    github?: Parameters<typeof composeServices>[0]["github"];
    repositoryTransport?: Parameters<
      typeof composeServices
    >[0]["repositoryTransport"];
    hostKeySources?: Parameters<typeof composeServices>[0]["hostKeySources"];
    machines?: MachineDependencies;
    inventoryOverrides?: Parameters<
      typeof composeServices
    >[0]["inventoryOverrides"];
    path?: string;
    scheduler?: Partial<SchedulerConfig>;
    project?: { environment_memory_mb?: number };
    oauthProviders?: Parameters<typeof composeServices>[0]["oauthProviders"];
    loadModelRuntime?: Parameters<
      typeof composeServices
    >[0]["loadModelRuntime"];
    workbenchModelRuntimeFactory?: Parameters<
      typeof composeServices
    >[0]["workbenchModelRuntimeFactory"];
    environmentModelRuntimeFactory?: Parameters<
      typeof composeServices
    >[0]["environmentModelRuntimeFactory"];
    stateDirectory?: string;
    agentDirectory?: string;
    serverSlotLimit?: number;
    containerImage?: string;
    intake?: { pendingEventLimit?: number; pollIntervalMs?: number };
    handoverRefreshWaitMs?: number;
    fakeSlots?: boolean;
    environmentRuntime?: Parameters<
      typeof composeServices
    >[0]["environmentRuntime"];
    containerRuntimeHost?: Parameters<
      typeof composeServices
    >[0]["containerRuntimeHost"];
    environmentDevcontainerCli?: Parameters<
      typeof composeServices
    >[0]["environmentDevcontainerCli"];
    containerSlotDriver?: Parameters<
      typeof composeServices
    >[0]["containerSlotDriver"];
    repositoryFiles?: Parameters<typeof composeServices>[0]["repositoryFiles"];
  } = {},
) {
  process.umask(0o077);
  const slotDriver = options.fakeSlots ? new FakeSlotDriver() : undefined;
  const config = configuration({
    version: CONFIG_VERSION,
    master_key: randomBytes(32).toString("base64"),
    gateway: { port: 0, allowed_hosts: ["localhost"] },
    scheduler: options.scheduler ?? {},
    project: options.project ?? {},
    agent:
      options.agentDirectory === undefined
        ? {}
        : { prompt: { agent_directory: options.agentDirectory } },
    worker: {
      ...(options.serverSlotLimit === undefined
        ? {}
        : { server_slot_limit: options.serverSlotLimit }),
      ...(options.containerImage === undefined
        ? {}
        : { container_image: options.containerImage }),
    },
  }).getProperties();
  const store = new Store(options.path ?? ":memory:");
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
    { service: "gateway", migrations: gatewayMigrations },
    { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    { service: "worker", migrations: workerMigrations },
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
    { service: "project", migrations: projectMigrations },
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
    { service: REPOSITORY_COMPONENT_NAME, migrations: repositoryMigrations },
  ]);
  const trackingStore = new Store(":memory:");
  trackingStore.migrate(trackingDatabaseMigrations);
  const logs: string[] = [];
  const {
    scheduler,
    tracking,
    custody,
    gateway,
    project,
    intake,
    worker,
    mission,
    workbench,
    invocation,
    workerPool,
    threadDriver,
    containerDriver,
    repoConnector,
    github,
    gitWriter,
    s3,
  } = composeServices({
    config,
    store,
    trackingStore,
    stateDirectory: options.stateDirectory ?? temporary(t),
    workbenchModelRuntimeFactory: options.workbenchModelRuntimeFactory,
    environmentModelRuntimeFactory: options.environmentModelRuntimeFactory,
    registry: options.registry,
    health: options.health ?? new HealthRegistry(),
    repositoryConnector: options.repositoryConnector,
    github: options.github,
    repositoryTransport: options.repositoryTransport,
    hostKeySources: options.hostKeySources ?? FAKE_HOST_KEY_SOURCES,
    oauthProviders: options.oauthProviders,
    loadModelRuntime: options.loadModelRuntime,
    bindings: options.machines?.project,
    registrations: options.machines?.worker,
    inventoryOverrides: options.inventoryOverrides,
    intake: options.intake,
    handoverRefreshWaitMs: options.handoverRefreshWaitMs,
    serverSlotDriver: slotDriver,
    environmentRuntime: options.environmentRuntime,
    containerRuntimeHost: options.containerRuntimeHost,
    environmentDevcontainerCli: options.environmentDevcontainerCli,
    containerSlotDriver: options.containerSlotDriver,
    repositoryFiles: options.repositoryFiles ?? fakeRepositoryFiles(),
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
      await worker.stopPool();
      const quiescence = await Promise.all(
        [
          scheduler,
          custody,
          worker,
          mission,
          project,
          intake,
          workbench,
          gateway,
        ].map((service) => service.quiesce()),
      );
      failures.push(...quiescence.filter((error) => error !== null));
      await Promise.all([intake.drain(), gateway.drain()]);
      const invocationError = await invocation.stop();
      if (invocationError) failures.push(invocationError);
      for (const service of [
        gateway,
        workbench,
        intake,
        project,
        mission,
        worker,
        custody,
        scheduler,
        tracking,
      ]) {
        const error = await service.stop();
        if (error) failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Fixture cleanup failed.");
    } finally {
      store.close();
      trackingStore.close();
    }
  });
  for (const service of [
    scheduler,
    custody,
    worker,
    mission,
    project,
    intake,
    workbench,
    gateway,
    tracking,
  ]) {
    const error = await service.start();
    if (error) throw error;
  }
  if (slotDriver) worker.startPool();
  const port = gateway.address()!.port;
  config.gateway.allowed_hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const endpoint = `http://127.0.0.1:${port}`;
  const request = (path: string, init?: RequestInit) =>
    fetch(endpoint + path, init);
  const slotTokenOf = async (slot: PoolSlot) => {
    const { sign } = await import("hono/jwt");
    const iat = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
    return sign(
      {
        sub: slot.client_id,
        name: `server slot ${slot.slot}`,
        kind: IdentityKind.Client,
        project_id: slot.project_id,
        resource_identity: slot.resource_identity,
        iat,
        exp: iat + config.gateway.auth.token_lifetime,
        jti: ulid(),
      },
      await signingKey(config.master_key, config.gateway.auth.version),
      "HS256",
    );
  };
  return {
    repoConnector,
    github,
    gitWriter,
    s3,
    project,
    intake,
    scheduler,
    worker,
    custody,
    mission,
    workbench,
    gateway,
    invocation,
    workerPool,
    threadDriver,
    containerDriver,
    masterKey: config.master_key,
    authVersion: config.gateway.auth.version,
    store,
    tracking,
    trackingStore,
    endpoint,
    request,
    token: (
      await generateHumanJWT(
        config.master_key,
        config.gateway.auth.version,
        config.gateway.auth.token_lifetime,
      )
    ).token,
    machineToken: async (
      projectId: string,
      bindingName: string,
      name?: string,
    ) =>
      (
        await generateMachineJWT(
          config.master_key,
          config.gateway.auth.version,
          config.gateway.auth.token_lifetime,
          { projectId, bindingName },
          name,
        )
      ).token,
    slotTokenOf,
    slotClient: async (
      projectId: string,
      bindingName: string,
      slot = FIRST_SLOT,
    ) => {
      assert.ok(slotDriver);
      const launch = await slotDriver.launched(
        projectId,
        workerResourceIdentity(bindingName),
        slot,
      );
      return {
        client_id: launch.slot.client_id,
        token: await slotTokenOf(launch.slot),
        client_secret: launch.client_secret,
      };
    },
    config,
    accountId: KANTHORD_AUTH_USERNAME,
    logs,
  };
}

const NO_DELIVERY_LENGTH = 0;

export interface Delivery {
  inboundId: string;
  secret: string;
  event: string;
  deliveryId: string;
  body: string | Uint8Array;
  signature?: string | null;
}

export async function deliver(
  fixture: Pick<Awaited<ReturnType<typeof gatewayFixture>>, "request">,
  input: Delivery,
): Promise<{ status: number; body: unknown }> {
  assert.ok(input.inboundId.length > NO_DELIVERY_LENGTH);
  assert.ok(input.secret.length > NO_DELIVERY_LENGTH);
  const bytes = Buffer.from(input.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": input.event,
    "X-GitHub-Delivery": input.deliveryId,
  };
  const signature =
    input.signature === undefined
      ? `sha256=${createHmac("sha256", input.secret).update(bytes).digest("hex")}`
      : input.signature;
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  const response = await fixture.request(`/hooks/${input.inboundId}`, {
    method: HttpMethod.Post,
    headers,
    body: bytes,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > NO_DELIVERY_LENGTH ? JSON.parse(text) : null,
  };
}

const GITHUB_VERSION_HEADER = "x-github-api-version";
const GITHUB_BODY_MAX = 1024 ** 2;
const GITHUB_EVENTS_ROUTE = /^\/repos\/([^/]+)\/([^/]+)\/events$/;
const GITHUB_NOT_MODIFIED_STATUS = 304;
const NO_HOLD_PASS = 0;
const HOLD_PASS_STEP = 1;
const GITHUB_PULL_ROUTE =
  /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/([1-9][0-9]*)(\/comments|\/reviews(?:\/([1-9][0-9]*)\/comments)?)?)?$/;
const GITHUB_MERGE_ROUTE =
  /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)\/merge$/;
const GITHUB_REPOSITORY_ROUTE = /^\/repos\/([^/]+)\/([^/]+)$/;
const GITHUB_RULES_ROUTE = /^\/repos\/([^/]+)\/([^/]+)\/rules\/branches\/.+$/;
const GITHUB_CHECK_RUNS_ROUTE =
  /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/;
const GITHUB_STATUSES_ROUTE =
  /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/statuses$/;
const GITHUB_REQUIRED_STATUS_CHECKS_RULE = "required_status_checks";
const GITHUB_REPOSITORY_SETTINGS = {
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
};
const GITHUB_TOKEN_SCHEME = /^(?:token|bearer) /i;
const GITHUB_MERGE_SHA = /^[a-f0-9]{40}$/;
const GITHUB_NOT_FOUND = { message: "Not Found" };
const GITHUB_SCRIPTED_FAILURE = { message: "scripted failure" };
const GITHUB_FIRST_PULL_NUMBER = 1;
const GITHUB_FIRST_MERGEABILITY = 0;
const GITHUB_LAST_MERGEABILITY = 1;
const GITHUB_NEXT_PULL_STEP = 1;
const GITHUB_CREATED_STATUS = 201;
const GITHUB_EMPTY_BODY = "";
const GITHUB_MIN_SEGMENT_LENGTH = 1;
const GITHUB_REVIEWS_SUFFIX = "/reviews";
const GITHUB_FIRST_CLOSE_MS = Date.UTC(2026, 9, 15);
const MS_PER_CLOSE_STEP = 1000;

export const FakePullState = {
  Open: "open",
  Closed: "closed",
} as const;
export type FakePullState = (typeof FakePullState)[keyof typeof FakePullState];

export interface FakePullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  head: string;
  base: string;
  state: FakePullState;
  merged: boolean;
  merge_commit_sha: string | null;
  closed_at: string | null;
  head_sha: string;
  reviews: FakeReview[];
  mergeability: FakeMergeability[];
}

export interface FakeMergeability {
  mergeable: boolean | null;
  mergeable_state: string;
}

export interface FakeReview {
  id: number;
  user: { id: number; login: string };
  state: string;
  commit_id: string;
  body: string;
  submitted_at: string;
  comments: FakeReviewComment[];
}

export interface FakeReviewComment {
  path: string;
  line: number | null;
  body: string;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface FakeCommitStatus {
  context: string;
  state: string;
}

export interface FakeGitHubCall {
  method: string;
  path: string;
  body: unknown;
  token: string | null;
  if_none_match: string | null;
  status: number | null;
}

interface FakeEventsHold {
  pass: number;
  gate: Promise<void>;
}

interface FakeGitHubState {
  pulls: FakePullRequest[];
  calls: FakeGitHubCall[];
  next: { status: number; body: unknown } | null;
  failPulls: number | null;
  dropNext: boolean;
  gate: Promise<void> | null;
  events: Map<string, unknown[]>;
  failEvents: number | null;
  eventsHold: FakeEventsHold | null;
  refuseMerge: number | null;
  closeSequence: number;
  mergeHeadSha: string | null;
  requiredChecks: string[];
  checkRuns: Map<string, FakeCheckRun[]>;
  commitStatuses: Map<string, FakeCommitStatus[]>;
}

interface FakeGitHubAnswer {
  status: number;
  body: unknown;
  etag?: string;
}

const createPullSchema = z.looseObject({
  head: z.string().min(GITHUB_MIN_SEGMENT_LENGTH),
  base: z.string().min(GITHUB_MIN_SEGMENT_LENGTH),
  title: z.string(),
});
const mergePullSchema = z.looseObject({
  sha: z.string().regex(GITHUB_MERGE_SHA),
  merge_method: z.enum(["merge", "squash", "rebase"]),
});

async function readGitHubBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= GITHUB_BODY_MAX);
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === GITHUB_EMPTY_BODY ? null : (JSON.parse(text) as unknown);
}

function gitHubToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined) return null;
  assert.match(authorization, GITHUB_TOKEN_SCHEME);
  return authorization.replace(GITHUB_TOKEN_SCHEME, "");
}

function pullBody(pull: FakePullRequest) {
  assert.ok(pull.number >= GITHUB_FIRST_PULL_NUMBER);
  assert.ok(pull.merged === (pull.merge_commit_sha !== null));
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    closed_at: pull.closed_at,
    merged_at: pull.merged ? pull.closed_at : null,
    ...pull.mergeability[GITHUB_FIRST_MERGEABILITY],
    head: {
      ref: pull.head,
      sha: pull.head_sha,
      label: `${pull.owner}:${pull.head}`,
      repo: { full_name: `${pull.owner}/${pull.repo}` },
    },
    base: {
      ref: pull.base,
      repo: { full_name: `${pull.owner}/${pull.repo}` },
    },
  };
}

function createPull(
  state: FakeGitHubState,
  owner: string,
  repo: string,
  body: unknown,
): FakeGitHubAnswer {
  const pull = insertPull(state, owner, repo, createPullSchema.parse(body));
  return { status: GITHUB_CREATED_STATUS, body: pullBody(pull) };
}

function insertPull(
  state: FakeGitHubState,
  owner: string,
  repo: string,
  input: { head: string; base: string; title: string },
): FakePullRequest {
  assert.ok(owner.length >= GITHUB_MIN_SEGMENT_LENGTH);
  assert.ok(repo.length >= GITHUB_MIN_SEGMENT_LENGTH);
  const pull: FakePullRequest = {
    owner,
    repo,
    number: state.pulls.length + GITHUB_NEXT_PULL_STEP,
    title: input.title,
    head: input.head,
    base: input.base,
    state: FakePullState.Open,
    merged: false,
    merge_commit_sha: null,
    closed_at: null,
    head_sha: createHash("sha1")
      .update(`${owner}/${repo}#${input.head}`)
      .digest("hex"),
    reviews: [],
    mergeability: [],
  };
  state.pulls.push(pull);
  assert.equal(state.pulls.at(-1), pull);
  return pull;
}

function listPulls(
  state: FakeGitHubState,
  owner: string,
  repo: string,
  query: URLSearchParams,
  ifNoneMatch: string | null,
): FakeGitHubAnswer {
  assert.ok(owner.length >= GITHUB_MIN_SEGMENT_LENGTH);
  assert.ok(repo.length >= GITHUB_MIN_SEGMENT_LENGTH);
  const listed = state.pulls.filter(
    (pull) =>
      pull.owner === owner &&
      pull.repo === repo &&
      (!query.has("state") || query.get("state") === pull.state) &&
      (!query.has("head") || query.get("head") === `${owner}:${pull.head}`) &&
      (!query.has("base") || query.get("base") === pull.base),
  );
  if (query.get("state") !== FakePullState.Closed)
    return { status: HttpStatus.OK, body: listed.map(pullBody) };
  const body = listed
    .sort(
      (left, right) =>
        (right.closed_at ?? "").localeCompare(left.closed_at ?? "") ||
        right.number - left.number,
    )
    .map(pullBody);
  const etag = eventsEtag(body);
  return ifNoneMatch === etag
    ? { status: GITHUB_NOT_MODIFIED_STATUS, body: null, etag }
    : { status: HttpStatus.OK, body, etag };
}

function closePull(state: FakeGitHubState, pull: FakePullRequest): void {
  assert.equal(pull.state, FakePullState.Open);
  state.closeSequence += GITHUB_NEXT_PULL_STEP;
  pull.state = FakePullState.Closed;
  pull.closed_at = new Date(
    GITHUB_FIRST_CLOSE_MS + state.closeSequence * MS_PER_CLOSE_STEP,
  )
    .toISOString()
    .replace(".000Z", "Z");
}

function routePull(
  state: FakeGitHubState,
  method: string,
  url: URL,
  body: unknown,
  ifNoneMatch: string | null,
): FakeGitHubAnswer {
  const route = GITHUB_PULL_ROUTE.exec(url.pathname);
  if (!route) return { status: HttpStatus.NotFound, body: GITHUB_NOT_FOUND };
  const [, owner, repo, number, suffix, reviewId] = route;
  assert.ok(owner && repo);
  if (number === undefined) {
    return method === HttpMethod.Post
      ? createPull(state, owner, repo, body)
      : listPulls(state, owner, repo, url.searchParams, ifNoneMatch);
  }
  const pull = state.pulls.find(
    (item) =>
      item.owner === owner && item.repo === repo && item.number === +number,
  );
  if (!pull || method !== HttpMethod.Get)
    return { status: HttpStatus.NotFound, body: GITHUB_NOT_FOUND };
  if (suffix === undefined) {
    const body = pullBody(pull);
    if (pull.mergeability.length > GITHUB_LAST_MERGEABILITY)
      pull.mergeability.shift();
    return { status: HttpStatus.OK, body };
  }
  if (reviewId !== undefined) {
    const review = pull.reviews.find((item) => item.id === +reviewId);
    return review
      ? { status: HttpStatus.OK, body: review.comments }
      : { status: HttpStatus.NotFound, body: GITHUB_NOT_FOUND };
  }
  return {
    status: HttpStatus.OK,
    body:
      suffix === GITHUB_REVIEWS_SUFFIX
        ? pull.reviews.map(({ comments, ...review }) => {
            assert.ok(Array.isArray(comments));
            return review;
          })
        : [],
  };
}

function branchRules(state: FakeGitHubState): FakeGitHubAnswer {
  const rules = state.requiredChecks.length
    ? [
        {
          type: GITHUB_REQUIRED_STATUS_CHECKS_RULE,
          parameters: {
            required_status_checks: state.requiredChecks.map((context) => ({
              context,
            })),
          },
        },
      ]
    : [];
  return { status: HttpStatus.OK, body: rules };
}

function routeCommitChecks(
  state: FakeGitHubState,
  pathname: string,
): FakeGitHubAnswer | null {
  const runs = GITHUB_CHECK_RUNS_ROUTE.exec(pathname);
  if (runs) {
    const [, , , ref] = runs;
    assert.ok(ref);
    const checkRuns = state.checkRuns.get(ref) ?? [];
    return {
      status: HttpStatus.OK,
      body: { total_count: checkRuns.length, check_runs: checkRuns },
    };
  }
  const statuses = GITHUB_STATUSES_ROUTE.exec(pathname);
  if (!statuses) return null;
  const [, , , ref] = statuses;
  assert.ok(ref);
  return { status: HttpStatus.OK, body: state.commitStatuses.get(ref) ?? [] };
}

function eventsEtag(events: unknown[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  return `"${digest}"`;
}

function eventsKey(owner: string, repo: string): string {
  assert.ok(owner.length >= GITHUB_MIN_SEGMENT_LENGTH);
  assert.ok(repo.length >= GITHUB_MIN_SEGMENT_LENGTH);
  return `${owner}/${repo}`;
}

function listEvents(
  state: FakeGitHubState,
  owner: string,
  repo: string,
  ifNoneMatch: string | null,
): FakeGitHubAnswer & { etag: string } {
  const events = state.events.get(eventsKey(owner, repo)) ?? [];
  const etag = eventsEtag(events);
  return ifNoneMatch === etag
    ? { status: GITHUB_NOT_MODIFIED_STATUS, body: null, etag }
    : { status: HttpStatus.OK, body: events, etag };
}

async function awaitEventsHold(state: FakeGitHubState) {
  const hold = state.eventsHold;
  if (!hold) return;
  if (hold.pass > NO_HOLD_PASS) {
    hold.pass -= HOLD_PASS_STEP;
    return;
  }
  await hold.gate;
}

function replyGitHub(
  response: ServerResponse,
  answer: FakeGitHubAnswer,
  headers: Record<string, string> = {},
) {
  assert.ok(Number.isInteger(answer.status));
  assert.ok(!response.headersSent);
  const head = writeHead(response, answer.status, headers);
  if (answer.status === GITHUB_NOT_MODIFIED_STATUS) head.end();
  else head.end(JSON.stringify(answer.body));
}

function writeHead(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
): ServerResponse {
  return response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
}

async function gitHubRequest(
  state: FakeGitHubState,
  request: IncomingMessage,
  response: ServerResponse,
) {
  assert.ok(request.url && request.method);
  assert.equal(request.headers[GITHUB_VERSION_HEADER], GITHUB_API_VERSION);
  const body = await readGitHubBody(request);
  const method = request.method;
  const url = new URL(request.url, "http://127.0.0.1");
  const eventsRoute =
    method === HttpMethod.Get ? GITHUB_EVENTS_ROUTE.exec(url.pathname) : null;
  const call: FakeGitHubCall = {
    method,
    path: request.url,
    body,
    token: gitHubToken(request),
    if_none_match: request.headers["if-none-match"] ?? null,
    status: null,
  };
  state.calls.push(call);
  if (eventsRoute) await awaitEventsHold(state);
  if (state.gate) await state.gate;
  const reply = (
    answer: FakeGitHubAnswer,
    headers?: Record<string, string>,
  ) => {
    call.status = answer.status;
    replyGitHub(response, answer, headers);
  };
  const scripted = state.next;
  if (scripted) {
    state.next = null;
    return reply(scripted);
  }
  if (eventsRoute) {
    const [, owner, repo] = eventsRoute;
    assert.ok(owner && repo);
    if (state.failEvents !== null)
      return reply({ status: state.failEvents, body: GITHUB_SCRIPTED_FAILURE });
    const listed = listEvents(state, owner, repo, call.if_none_match);
    return reply(listed, { etag: listed.etag });
  }
  if (method === HttpMethod.Get && state.failPulls !== null)
    return reply({ status: state.failPulls, body: GITHUB_SCRIPTED_FAILURE });
  const answer = GITHUB_REPOSITORY_ROUTE.test(url.pathname)
    ? { status: HttpStatus.OK, body: GITHUB_REPOSITORY_SETTINGS }
    : GITHUB_RULES_ROUTE.test(url.pathname)
      ? branchRules(state)
      : GITHUB_MERGE_ROUTE.test(url.pathname)
        ? mergePull(state, url, body)
        : (routeCommitChecks(state, url.pathname) ??
          routePull(state, method, url, body, call.if_none_match));
  if (method !== HttpMethod.Get && state.dropNext) {
    state.dropNext = false;
    response.destroy();
    return;
  }
  reply(answer, answer.etag === undefined ? undefined : { etag: answer.etag });
}

function mergePull(
  state: FakeGitHubState,
  url: URL,
  body: unknown,
): FakeGitHubAnswer {
  const [, owner, repo, number] = GITHUB_MERGE_ROUTE.exec(url.pathname) ?? [];
  assert.ok(owner && repo && number);
  if (state.refuseMerge !== null)
    return { status: state.refuseMerge, body: GITHUB_SCRIPTED_FAILURE };
  const { sha } = mergePullSchema.parse(body);
  const pull = changePull(state, +number);
  const mergeCommit = createHash("sha1")
    .update(`${sha}:${number}`)
    .digest("hex");
  closePull(state, pull);
  pull.merged = true;
  pull.head_sha = state.mergeHeadSha ?? sha;
  state.mergeHeadSha = null;
  pull.merge_commit_sha = mergeCommit;
  return { status: HttpStatus.OK, body: { sha: mergeCommit, merged: true } };
}

function changePull(state: FakeGitHubState, number: number): FakePullRequest {
  const pull = state.pulls.find((item) => item.number === number);
  assert.ok(pull, "Unknown fake pull request");
  assert.equal(pull.state, FakePullState.Open);
  return pull;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HTTP_REQUEST_CHANNEL = "http.client.request.start";

export function outboundHosts(t: TestContext) {
  const hosts = {
    remote: [] as string[],
    fetch: [] as string[],
    http: [] as string[],
  };
  const record = (seen: string[], host: string) => {
    seen.push(host);
    if (!LOOPBACK_HOSTS.has(host)) hosts.remote.push(host);
  };
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const url = input instanceof Request ? input.url : input;
    record(hosts.fetch, new URL(url).hostname);
    return fetch(...args);
  });
  const onRequest = (message: unknown) => {
    const { request } = message as { request: ClientRequest };
    record(hosts.http, request.host);
  };
  subscribe(HTTP_REQUEST_CHANNEL, onRequest);
  t.after(() => unsubscribe(HTTP_REQUEST_CHANNEL, onRequest));
  return hosts;
}

export async function fakeGitHub(t: TestContext) {
  const state: FakeGitHubState = {
    pulls: [],
    calls: [],
    next: null,
    failPulls: null,
    dropNext: false,
    gate: null,
    events: new Map(),
    failEvents: null,
    eventsHold: null,
    refuseMerge: null,
    mergeHeadSha: null,
    closeSequence: 0,
    requiredChecks: [],
    checkRuns: new Map(),
    commitStatuses: new Map(),
  };
  const failures: unknown[] = [];
  let releaseGate = () => {};
  let releaseEvents = () => {};
  const server = createServer((request, response) => {
    void gitHubRequest(state, request, response).catch((error: unknown) => {
      failures.push(error);
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  t.after(async () => {
    releaseGate();
    releaseEvents();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (failures.length)
      throw new AggregateError(failures, "Fake GitHub failed.");
  });
  server.listen(EPHEMERAL_PORT, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && !isString(address));
  assert.ok(address.port > EPHEMERAL_PORT);
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    pulls: state.pulls as readonly FakePullRequest[],
    calls: state.calls as readonly FakeGitHubCall[],
    open(pull: {
      owner: string;
      repo: string;
      head: string;
      base: string;
    }): number {
      return insertPull(state, pull.owner, pull.repo, {
        head: pull.head,
        base: pull.base,
        title: pull.head,
      }).number;
    },
    merge(number: number, sha: string): void {
      assert.match(sha, GITHUB_MERGE_SHA);
      const pull = changePull(state, number);
      closePull(state, pull);
      pull.merged = true;
      pull.merge_commit_sha = sha;
    },
    close(number: number): void {
      closePull(state, changePull(state, number));
    },
    review(
      number: number,
      review: {
        reviewer: number;
        state: string;
        commit_id?: string;
        body?: string;
        comments?: FakeReviewComment[];
      },
    ): number {
      const pull = changePull(state, number);
      const id =
        state.pulls.reduce((count, item) => count + item.reviews.length, 0) +
        GITHUB_NEXT_PULL_STEP;
      pull.reviews.push({
        id,
        user: { id: review.reviewer, login: `reviewer-${review.reviewer}` },
        state: review.state,
        commit_id: review.commit_id ?? pull.head_sha,
        body: review.body ?? "",
        submitted_at: new Date().toISOString(),
        comments: review.comments ?? [],
      });
      return id;
    },
    mergeability(number: number, answers: FakeMergeability[]): void {
      assert.ok(answers.length >= GITHUB_LAST_MERGEABILITY);
      changePull(state, number).mergeability = [...answers];
    },
    checks(input: {
      required: readonly string[];
      commit: string;
      runs: readonly FakeCheckRun[];
      statuses?: readonly FakeCommitStatus[];
    }): void {
      assert.ok(input.commit.length >= GITHUB_MIN_SEGMENT_LENGTH);
      state.requiredChecks = [...input.required];
      state.checkRuns.set(input.commit, [...input.runs]);
      state.commitStatuses.set(input.commit, [...(input.statuses ?? [])]);
    },
    refuseMerge(status: number | null): void {
      assert.ok(status === null || Number.isInteger(status));
      state.refuseMerge = status;
    },
    respondNext(status: number, body: unknown): void {
      assert.ok(Number.isInteger(status));
      assert.equal(state.next, null);
      state.next = { status, body };
    },
    failPulls(status: number | null): void {
      assert.ok(status === null || Number.isInteger(status));
      state.failPulls = status;
    },
    dropNextAfterApply(): void {
      assert.equal(state.dropNext, false);
      state.dropNext = true;
    },
    mergeAtOtherHead(sha: string): void {
      assert.equal(state.mergeHeadSha, null);
      state.mergeHeadSha = sha;
    },
    events(owner: string, repo: string, events: readonly unknown[]): void {
      state.events.set(eventsKey(owner, repo), [...events]);
    },
    failEvents(status: number | null): void {
      assert.ok(status === null || Number.isInteger(status));
      state.failEvents = status;
    },
    holdEvents(options: { pass: number }): () => void {
      assert.ok(Number.isInteger(options.pass) && options.pass >= NO_HOLD_PASS);
      assert.equal(state.eventsHold, null);
      const gate = Promise.withResolvers<void>();
      state.eventsHold = { pass: options.pass, gate: gate.promise };
      releaseEvents = () => {
        state.eventsHold = null;
        gate.resolve();
      };
      return releaseEvents;
    },
    hold(): () => void {
      assert.equal(state.gate, null);
      const gate = Promise.withResolvers<void>();
      state.gate = gate.promise;
      releaseGate = () => {
        state.gate = null;
        gate.resolve();
      };
      return releaseGate;
    },
  };
}

const FIRST_SEEDED_ATTEMPT = 1;

export function seedUnresolvedRequest(
  store: Store,
  input: { project_id: string; resource_identity: string; number: number },
): void {
  const nodeId = createIdentity("node");
  const evidenceId = createIdentity("evidence");
  const now = Date.now();
  store.transaction((tx) => {
    const mission = tx.database
      .prepare("SELECT id FROM mission_mission WHERE project_id = ?")
      .get(input.project_id) as { id: string } | undefined;
    assert.ok(mission, "The project holds a mission.");
    tx.database
      .prepare(
        "INSERT INTO mission_node (id, mission_id, filename, state, attempt, priority, retired_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
      )
      .run(
        nodeId,
        mission.id,
        `${nodeId}.md`,
        NodeState.ExternalRequested,
        FIRST_SEEDED_ATTEMPT,
        now,
      );
    tx.database
      .prepare(
        "INSERT INTO mission_attempt (node_id, attempt, node_revision, opened_by, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(nodeId, FIRST_SEEDED_ATTEMPT, FIRST_SEEDED_ATTEMPT, "{}", now);
    tx.database
      .prepare(
        "INSERT INTO mission_evidence (id, node_id, attempt, subject, requirement_key, end_state, verification, provenance, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
      )
      .run(
        evidenceId,
        nodeId,
        FIRST_SEEDED_ATTEMPT,
        "pull request",
        "seeded.pull_request",
        "{}",
        now,
      );
    tx.database
      .prepare(
        "INSERT INTO mission_evidence_asset (id, evidence_id, kind, content, published_at, expired_at) VALUES (?, ?, ?, ?, NULL, NULL)",
      )
      .run(
        createIdentity("evidence_asset"),
        evidenceId,
        AssetKind.Platform,
        canonicalJSON({
          kind: PlatformAddressKind.PullRequest,
          resource_identity: input.resource_identity,
          number: input.number,
        }),
      );
  });
}

const MAIN_REF = "refs/heads/main";
const TEMPLATE_PREFIX = "kanthord-template-";

const bareTemplates = new Map<
  string,
  Promise<{ bare: string; head: string }>
>();

function templateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), TEMPLATE_PREFIX));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

export async function bareRepository(t: TestContext, name: string) {
  let template = bareTemplates.get(name);
  if (!template) {
    template = seededBareRepository(templateRoot(), name);
    bareTemplates.set(name, template);
  }
  const { bare: source, head } = await template;
  const bare = join(temporary(t), `${name}.git`);
  cpSync(source, bare, { recursive: true });
  return { bare, head };
}

async function seededBareRepository(root: string, name: string) {
  const bare = join(root, `${name}.git`);
  const seed = join(root, "seed");
  mkdirSync(bare);
  await simpleGit(bare).init(true, ["--initial-branch=main"]);
  await simpleGit().clone(bare, seed);
  const git = simpleGit(seed);
  await git.addConfig("user.name", "Test Journey");
  await git.addConfig("user.email", "test_journey@example.invalid");
  writeFileSync(join(seed, "README.md"), `test_journey ${name} repository\n`);
  await git.add("README.md");
  await git.commit("initial");
  await git.push("origin", "main");
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(await remoteHead(bare, MAIN_REF), head);
  return { bare, head };
}

export function mappedTransport(
  addresses: Record<string, string>,
): RepositoryTransport & GitWriter {
  const connector = new RepositoryComponent();
  function mapped(address: string) {
    assert.ok(Object.hasOwn(addresses, address), "Unmapped repository address");
    assert.ok(addresses[address]);
    return addresses[address]!;
  }
  return {
    clone: (address, directory, context, deadlineMs) =>
      connector.clone(
        mapped(address),
        directory,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    cloneSnapshot: (address, revision, directory, context, deadlineMs) =>
      connector.cloneSnapshot(
        mapped(address),
        revision,
        directory,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    fetchAndCheckout: (directory, branch, base, pushed, context, deadlineMs) =>
      connector.fetchAndCheckout(
        directory,
        branch,
        base,
        pushed,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    fetchBase: (directory, base, context, deadlineMs) =>
      connector.fetchBase(
        directory,
        base,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    pushNodeBranch: (directory, branch, context, deadlineMs) =>
      connector.pushNodeBranch(
        directory,
        branch,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    mergePushFresh: (input, ...args) =>
      connector.mergePushFresh(
        { ...input, address: mapped(input.address) },
        ...args,
      ),
    pushSnapshotFresh: (input, ...args) =>
      connector.pushSnapshotFresh(
        { ...input, address: mapped(input.address) },
        ...args,
      ),
    landedOn: (input, ...args) =>
      connector.landedOn({ ...input, address: mapped(input.address) }, ...args),
    sshAccessOf: (...args) => connector.sshAccessOf(...args),
  };
}

export async function remoteHead(
  bare: string,
  ref: string,
): Promise<string | null> {
  assert.ok(bare.startsWith("/"));
  assert.ok(ref.startsWith("refs/heads/"));
  const output = (await simpleGit().raw(["ls-remote", bare, ref])).trim();
  if (!output) return null;
  const [head, found] = output.split(/\s+/);
  assert.equal(found, ref);
  assert.match(head!, /^[a-f0-9]{40}$/);
  return head!;
}

const S3_BUCKET = "evidence";
const ZERO_LOSSES = 0;
const ONE_LOSS = 1;
const S3_BODY_MAX = 16 * 1024 ** 2;
const S3_FIRST_VERSION = 1;
const S3_VERSION_PREFIX = "v";
const S3_SIGNATURE_PARAMETER = "X-Amz-Signature";
const S3_SIGNED_HEADERS_PARAMETER = "X-Amz-SignedHeaders";
const S3_SIGNED_HEADER_SEPARATOR = ";";
const S3_CONTENT_LENGTH_HEADER = "content-length";
const S3_VERSION_HEADER = "x-amz-version-id";
const S3_CHECKSUM_MODE_HEADER = "x-amz-checksum-mode";
const S3_CHECKSUM_TYPE_HEADER = "x-amz-checksum-type";
const S3_CHECKSUM_MODE_ENABLED = "ENABLED";
const S3_CHECKSUM_TYPE_FULL = "FULL_OBJECT";
const S3_HEAD = "HEAD";
const S3_BASE64 = "base64";
const S3_SHA256 = "sha256";
const S3_ERROR_CODES = {
  access: "AccessDenied",
  bucket: "NoSuchBucket",
  key: "NoSuchKey",
  checksum: "BadDigest",
  length: "IncompleteBody",
  scripted: "InternalError",
} as const;

export interface FakeS3Object {
  version: string;
  bytes: Buffer;
  sha256: string | null;
}

export interface FakeS3Call {
  method: string;
  key: string;
  version: string | null;
}

interface FakeS3State {
  versions: Map<string, FakeS3Object[]>;
  calls: FakeS3Call[];
  nextFailure: number | null;
  losses: number;
}

interface FakeS3Target {
  key: string;
  version: string | null;
}

function s3Target(url: URL): FakeS3Target | null {
  const prefix = `/${S3_BUCKET}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  return { key, version: url.searchParams.get("versionId") };
}

function replyS3(response: ServerResponse, status: number, code: string) {
  assert.ok(Number.isInteger(status));
  assert.ok(!response.headersSent);
  response
    .writeHead(status, { "content-type": "application/xml" })
    .end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
}

async function readS3Body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = ZERO_BYTES;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= S3_BODY_MAX);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function s3Signed(request: IncomingMessage, url: URL): boolean {
  return (
    url.searchParams.has(S3_SIGNATURE_PARAMETER) ||
    request.headers.authorization !== undefined
  );
}

function s3SignedHeaders(url: URL): ReadonlySet<string> {
  const value = url.searchParams.get(S3_SIGNED_HEADERS_PARAMETER) ?? "";
  return new Set(value.split(S3_SIGNED_HEADER_SEPARATOR));
}

function s3Find(state: FakeS3State, target: FakeS3Target) {
  const stored = state.versions.get(target.key) ?? [];
  return target.version === null
    ? stored.at(-1)
    : stored.find((item) => item.version === target.version);
}

function putS3Object(
  state: FakeS3State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  target: FakeS3Target,
  bytes: Buffer,
) {
  const signed = s3SignedHeaders(url);
  if (
    signed.has(S3_CONTENT_LENGTH_HEADER) &&
    request.headers[S3_CONTENT_LENGTH_HEADER] !== String(bytes.length)
  )
    return replyS3(response, HttpStatus.BadRequest, S3_ERROR_CODES.length);
  const declared = request.headers[CHECKSUM_HEADER];
  const actual = createHash(S3_SHA256).update(bytes).digest(S3_BASE64);
  if (signed.has(CHECKSUM_HEADER) && declared !== actual)
    return replyS3(response, HttpStatus.BadRequest, S3_ERROR_CODES.checksum);
  const stored = state.versions.get(target.key) ?? [];
  const version = `${S3_VERSION_PREFIX}${stored.length + S3_FIRST_VERSION}`;
  stored.push({
    version,
    bytes,
    sha256: signed.has(CHECKSUM_HEADER) ? actual : null,
  });
  state.versions.set(target.key, stored);
  response.writeHead(HttpStatus.OK, { [S3_VERSION_HEADER]: version }).end();
}

function readS3Object(
  state: FakeS3State,
  request: IncomingMessage,
  response: ServerResponse,
  target: FakeS3Target,
) {
  const found = s3Find(state, target);
  if (!found) {
    return request.method === HttpMethod.Get
      ? replyS3(response, HttpStatus.NotFound, S3_ERROR_CODES.key)
      : response.writeHead(HttpStatus.NotFound).end();
  }
  const headers: Record<string, string | number> = {
    [S3_CONTENT_LENGTH_HEADER]: found.bytes.length,
    [S3_VERSION_HEADER]: found.version,
  };
  if (
    found.sha256 !== null &&
    request.headers[S3_CHECKSUM_MODE_HEADER] === S3_CHECKSUM_MODE_ENABLED
  ) {
    headers[CHECKSUM_HEADER] = found.sha256;
    headers[S3_CHECKSUM_TYPE_HEADER] = S3_CHECKSUM_TYPE_FULL;
  }
  response
    .writeHead(HttpStatus.OK, headers)
    .end(request.method === HttpMethod.Get ? found.bytes : undefined);
}

function deleteS3Object(
  state: FakeS3State,
  response: ServerResponse,
  target: FakeS3Target,
) {
  const stored = state.versions.get(target.key) ?? [];
  const kept =
    target.version === null
      ? []
      : stored.filter((item) => item.version !== target.version);
  state.versions.set(target.key, kept);
  const headers: Record<string, string> =
    target.version === null ? {} : { [S3_VERSION_HEADER]: target.version };
  response.writeHead(HttpStatus.NoContent, headers).end();
}

async function s3Request(
  state: FakeS3State,
  request: IncomingMessage,
  response: ServerResponse,
) {
  assert.ok(request.url && request.method);
  const url = new URL(request.url, "http://127.0.0.1");
  const target = s3Target(url);
  if (!target)
    return replyS3(response, HttpStatus.NotFound, S3_ERROR_CODES.bucket);
  state.calls.push({
    method: request.method,
    key: target.key,
    version: target.version,
  });
  const body = await readS3Body(request);
  if (state.losses > ZERO_LOSSES) {
    state.losses -= 1;
    return request.socket.destroy();
  }
  const scripted = state.nextFailure;
  if (scripted !== null) {
    state.nextFailure = null;
    return replyS3(response, scripted, S3_ERROR_CODES.scripted);
  }
  if (!s3Signed(request, url))
    return replyS3(response, HttpStatus.Forbidden, S3_ERROR_CODES.access);
  if (request.method === HttpMethod.Put)
    return putS3Object(state, request, response, url, target, body);
  if (request.method === HttpMethod.Delete)
    return deleteS3Object(state, response, target);
  assert.ok(request.method === HttpMethod.Get || request.method === S3_HEAD);
  readS3Object(state, request, response, target);
}

export async function fakeS3(t: TestContext) {
  const state: FakeS3State = {
    versions: new Map(),
    calls: [],
    nextFailure: null,
    losses: ZERO_LOSSES,
  };
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void s3Request(state, request, response).catch((error: unknown) => {
      failures.push(error);
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (failures.length) throw new AggregateError(failures, "Fake S3 failed.");
  });
  server.listen(EPHEMERAL_PORT, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && !isString(address));
  assert.ok(address.port > EPHEMERAL_PORT);
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    bucket: S3_BUCKET,
    calls: state.calls as readonly FakeS3Call[],
    objects(key: string): readonly FakeS3Object[] {
      return state.versions.get(key) ?? [];
    },
    failNext(status: number): void {
      assert.ok(Number.isInteger(status));
      assert.equal(state.nextFailure, null);
      state.nextFailure = status;
    },
    loseNext(count = ONE_LOSS): void {
      assert.ok(Number.isSafeInteger(count) && count >= ZERO_LOSSES);
      assert.ok(count === ZERO_LOSSES || state.losses === ZERO_LOSSES);
      state.losses = count;
    },
  };
}

const STORAGE_PREFIX = "kanthord";
const STORAGE_REGION = "eu-central-1";
const STORAGE_CREDENTIAL = "store";
const STORAGE_ACCESS_KEY_ID = "AKIASTORAGEOPERATIONS";
export const STORAGE_SECRET = "storage-operations-secret";
const STORAGE_FIRST_REVISION = 1;
const STORAGE_FIRST_INDEX = 0;
const STORAGE_SUCCESSFUL_EXIT = 0;
const STORAGE_NO_OUTPUT = "";
const STORAGE_NODE_CONTENT = {
  name: "Store objects",
  requirement: "Store objects",
  criterion: "Objects land",
  verifications: ["true"],
};

type StorageCli = {
  env: NodeJS.ProcessEnv;
  read<T>(args: string[], env?: NodeJS.ProcessEnv): Promise<T>;
  write<T>(args: string[], body: unknown, env?: NodeJS.ProcessEnv): Promise<T>;
};

function storageCli(t: TestContext, endpoint: string, token: string) {
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: endpoint,
    KANTHORD_TOKEN: token,
  };
  let sequence = STORAGE_FIRST_INDEX;
  const read = async <T>(args: string[], use = env): Promise<T> => {
    const result = await kanthord(args, use);
    assert.equal(result.code, STORAGE_SUCCESSFUL_EXIT, result.stderr);
    assert.equal(result.stderr, STORAGE_NO_OUTPUT);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, use = env) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], use);
  };
  return { env, read, write } satisfies StorageCli;
}

async function storageCredentials(cli: StorageCli, endpoint: string) {
  assert.ok(endpoint.startsWith("http://"));
  await cli.write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await createFakeSshCredential(cli.read);
  await cli.write(["storage", "credential", "create"], {
    name: STORAGE_CREDENTIAL,
    platform: "s3",
    metadata: { endpoint, bucket: S3_BUCKET, region: STORAGE_REGION },
    secret: {
      access_key_id: STORAGE_ACCESS_KEY_ID,
      secret_access_key: STORAGE_SECRET,
    },
  });
}

function storageBindings(endpoint: string, available: boolean) {
  assert.ok(endpoint.startsWith("http://"));
  return {
    repo: {
      kind: "repository",
      config: {
        available: true,
        platform: "github",
        address: "git@github.com:owner/repo.git",
        ssh_credential: FAKE_SSH_CREDENTIAL,
        credential: "github",
        strategy: { base_branch: "main" },
      },
    },
    store: {
      kind: "storage",
      config: {
        available,
        endpoint,
        bucket: S3_BUCKET,
        region: STORAGE_REGION,
        prefix: STORAGE_PREFIX,
        credential: STORAGE_CREDENTIAL,
      },
    },
    harness: {
      kind: "worker",
      config: { worker: "claude-code@1", instance_count: SINGLE_INSTANCE },
    },
  };
}

async function storageNode(
  cli: StorageCli,
  ids: { projectId: string; missionId: string },
  bindingIds: string[],
) {
  const create = async (
    filename: string,
    intent: Intent,
    bindings: string[],
  ) => {
    const { version } = await cli.read<{ version: number }>([
      "mission",
      "get",
      ids.projectId,
    ]);
    const answer = await cli.write<{ revisions: Revision[] }>(
      ["mission", "node", "create", ids.missionId],
      {
        filename,
        content: { ...STORAGE_NODE_CONTENT, intent, bindings },
        tasks: [],
        reason: "plan",
        expected_mission_version: version,
      },
    );
    return answer.revisions[STORAGE_FIRST_INDEX]!.node_id;
  };
  const examine = await create("examine.md", Intent.Examine, []);
  const implement = await create("implement.md", Intent.Implement, bindingIds);
  const { version } = await cli.read<{ version: number }>([
    "mission",
    "get",
    ids.projectId,
  ]);
  await cli.write(["mission", "dependency", "add", examine, implement], {
    reason: "plan",
    expected_mission_version: version,
  });
  return implement;
}

async function storageExecution(
  cli: StorageCli,
  token: string,
  resourceIdentity: string,
) {
  assert.ok(token.length);
  const env = { ...cli.env, KANTHORD_TOKEN: token };
  const { runtime_identity } = await cli.read<{ runtime_identity: string }>(
    ["worker", "register"],
    env,
  );
  const { execution } = await cli.write<{ execution: ExecutionRecord }>(
    ["scheduler", "work", "pull"],
    { resource_identity: resourceIdentity, runtime_identity },
    env,
  );
  assert.ok(execution.execution_id);
  return execution;
}

export async function storageProject(t: TestContext) {
  const s3 = await fakeS3(t);
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  const cli = storageCli(t, fixture.endpoint, fixture.token);
  await storageCredentials(cli, s3.endpoint);
  const project = await cli.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "storage",
  ]);
  const mission = await cli.read<{ id: string }>([
    "mission",
    "get",
    project.id,
  ]);
  const applyBindings = (version: number, available: boolean) =>
    cli.write(["project", "binding", "apply", project.id], {
      version,
      bindings: storageBindings(s3.endpoint, available),
    });
  await applyBindings(STORAGE_FIRST_REVISION, true);
  const { items } = await cli.read<{
    items: { id: string; name: string; resource_identity: string }[];
  }>(["project", "binding", "list", project.id]);
  const binding = (name: string) => {
    const row = items.find((item) => item.name === name);
    assert.ok(row);
    return row;
  };
  const nodeId = await storageNode(
    cli,
    { projectId: project.id, missionId: mission.id },
    [binding("repo").id, binding("store").id],
  );
  const token = await fixture.machineToken(project.id, "harness");
  const execution = await storageExecution(
    cli,
    token,
    binding("harness").resource_identity,
  );
  assert.equal(execution.node_id, nodeId);
  return {
    s3,
    fixture,
    cli,
    project,
    nodeId,
    token,
    execution,
    storageBindingId: binding("store").id,
    applyBindings,
    keyOf: (assetId: string) =>
      [
        STORAGE_PREFIX,
        project.id,
        mission.id,
        nodeId,
        execution.attempt,
        assetId,
      ].join("/"),
    machine: () =>
      fixture.invocation.authentication.authenticate(`Bearer ${token}`),
    human: () =>
      fixture.invocation.authentication.authenticate(`Bearer ${fixture.token}`),
  };
}

const WORKER_PROJECT_REPOSITORY_CREDENTIAL = "github";
const WORKER_PROJECT_SSH_CREDENTIAL = "github-ssh";
const SECRET_FIELD = "secret";
const WORKER_PROJECT_NODE = {
  name: "Work",
  requirement: "Do work",
  criterion: "Done",
  verifications: ["true"],
};
const FIRST_BINDING_SET_VERSION = 1;
const FIRST_MISSION_VERSION = 1;
const SECOND_MISSION_VERSION = 2;

export async function createFakeSshCredential(
  read: <T>(args: string[]) => Promise<T>,
): Promise<void> {
  await read([
    "repository",
    "credential",
    "ssh-key-create",
    FAKE_SSH_CREDENTIAL,
  ]);
  await read([
    "repository",
    "host-key",
    "pin",
    FAKE_SSH_HOST,
    "--fingerprint",
    FAKE_GITHUB_HOST_KEY_FINGERPRINT,
  ]);
}

export function humanCaller(
  fixture: Pick<
    Awaited<ReturnType<typeof gatewayFixture>>,
    "endpoint" | "token"
  >,
) {
  return async <T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
  ) => {
    const result = (await httpClient(
      { operation },
      fixture.endpoint,
      fixture.token,
    ).operation(input)) as OperationResult<z.output<T["output"]>>;
    assert.equal(
      result.type,
      OperationResultType.Completed,
      JSON.stringify(result),
    );
    return (result as { data: z.output<T["output"]> }).data;
  };
}

export async function provisionRepositoryCredentials(
  fixture: Parameters<typeof humanCaller>[0],
) {
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  await call(repositoryOperations.create, {
    ...empty,
    body: {
      name: WORKER_PROJECT_REPOSITORY_CREDENTIAL,
      platform: "github",
      metadata: null,
      [SECRET_FIELD]: { key: "worker-project-token" },
    },
  });
  await call(repositoryOperations.ssh_key_create, {
    ...empty,
    body: { name: WORKER_PROJECT_SSH_CREDENTIAL },
  });
  await call(repositoryOperations.host_key_pin, {
    params: { host: FAKE_SSH_HOST },
    query: {},
    body: { fingerprint: FAKE_GITHUB_HOST_KEY_FINGERPRINT },
  });
}

function workerProjectBindings(
  workers: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return {
    repo: {
      kind: "repository",
      config: {
        available: true,
        platform: "github",
        address: "git@github.com:owner/repo.git",
        ssh_credential: WORKER_PROJECT_SSH_CREDENTIAL,
        strategy: { base_branch: "main" },
        credential: WORKER_PROJECT_REPOSITORY_CREDENTIAL,
        prompts: { "swe@1": "Follow repository conventions." },
      },
    },
    ...Object.fromEntries(
      Object.entries(workers).map(([name, count]) => [
        name,
        {
          kind: "worker",
          config: { worker: "claude-code@1", instance_count: count },
        },
      ]),
    ),
  };
}

export async function provisionWorkerProject(
  fixture: Parameters<typeof humanCaller>[0],
  name: string,
  workers: Readonly<Record<string, number>>,
) {
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  const project = await call(projectOperations.create, {
    ...empty,
    body: { name },
  });
  const written = (version: number, next: Readonly<Record<string, number>>) =>
    call(projectOperations["bindingSet.write"], {
      params: { project_id: project.id },
      query: {},
      body: { version, bindings: workerProjectBindings(next) as never },
    });
  const bindingSet = await written(FIRST_BINDING_SET_VERSION, workers);
  const mission = await call(missionOperations.get, {
    params: { project_id: project.id },
    query: {},
    body: null,
  });
  const examine = await call(missionOperations["node.create"], {
    params: { mission_id: mission.id },
    query: {},
    body: {
      filename: "examine-1.md",
      content: { ...WORKER_PROJECT_NODE, intent: Intent.Examine, bindings: [] },
      tasks: [],
      reason: "plan",
      expected_mission_version: FIRST_MISSION_VERSION,
    },
  });
  const implement = await call(missionOperations["node.create"], {
    params: { mission_id: mission.id },
    query: {},
    body: {
      filename: "implement-1.md",
      content: {
        ...WORKER_PROJECT_NODE,
        intent: Intent.Implement,
        bindings: [bindingSet.bindings.repo!.id],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: SECOND_MISSION_VERSION,
    },
  });
  await call(missionOperations["dependency.add"], {
    params: {
      node_id: examine.revisions[0]!.node_id,
      depends_on_id: implement.revisions[0]!.node_id,
    },
    query: {},
    body: {
      reason: "plan",
      expected_mission_version: implement.mission_version,
    },
  });
  return {
    id: project.id,
    bindingSetVersion: bindingSet.binding_set_version,
    rewrite: async (next: Readonly<Record<string, number>>) => {
      const current = await call(projectOperations["bindingSet.get"], {
        params: { project_id: project.id },
        query: {},
        body: null,
      });
      return written(current.version, next);
    },
    pause: () =>
      call(projectOperations.pause, {
        params: { project_id: project.id },
        query: {},
        body: null,
      }),
  };
}

const NATIVE_DEFAULTS = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;

export async function provisionNativeAgent(
  fixture: Parameters<typeof humanCaller>[0],
) {
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  await call(llmOperations.create, {
    ...empty,
    body: {
      name: "native-credential",
      platform: "anthropic",
      metadata: null,
      [SECRET_FIELD]: { key: "native-provider-key" },
    },
  });
  await call(agentOperations["enablement.put"], {
    params: { agent_name: "swe@1" },
    query: {},
    body: {
      agent_providers: [
        {
          name: "default",
          provider: "anthropic",
          credential: "native-credential",
        },
      ],
      default_configuration: NATIVE_DEFAULTS,
      fallback_configurations: [],
    },
  });
}

export async function provisionNativeServerProject(
  fixture: Parameters<typeof humanCaller>[0],
  name: string,
  binding: string,
) {
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  const project = await call(projectOperations.create, {
    ...empty,
    body: { name },
  });
  await call(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: {
      version: FIRST_BINDING_SET_VERSION,
      bindings: {
        ...(workerProjectBindings({}) as Record<string, never>),
        [binding]: {
          kind: "worker",
          config: {
            worker: "coder@1",
            instance_count: 1,
            placement: InstancePlacement.Server,
            entries: [{ agent: "swe@1", ...NATIVE_DEFAULTS }],
          },
        },
      } as never,
    },
  });
  return { id: project.id };
}

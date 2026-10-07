import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { Worker, type WorkerOptions } from "../worker/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import { clientConfigPath } from "../../gateway/client.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { TestContext } from "node:test";
import pino from "pino";
import { configuration } from "../../config/index.ts";
import { custodyMigrations } from "../../custody/index.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import { schedulerMigrations } from "../../scheduler/index.ts";
import { SCHEDULER_SERVICE_NAME } from "../../scheduler/contract.ts";
import type { SchedulerConfig } from "../../scheduler/index.ts";
import { Store } from "../../kernel/store.ts";
import { gatewayMigrations } from "../../gateway/index.ts";
import { projectMigrations } from "../../project/index.ts";
import { missionMigrations } from "../../mission/index.ts";
import {
  MISSION_SERVICE_NAME,
  type IntakeStorage,
  type IntakeCheck,
} from "../../mission/contract.ts";
import { workerMigrations } from "../../worker/index.ts";
import { agentMigrations } from "../../agent/index.ts";
import { workbenchMigrations } from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { composeServices } from "./index.ts";
import type { OperationRegistry } from "../../kernel/operation.ts";
import {
  workerResourceIdentity,
  type ProjectBindings,
} from "../../project/contract.ts";
import type {
  WorkerRegistrations,
  IntakeActions,
} from "../../worker/contract.ts";
export interface MachineDependencies {
  project: ProjectBindings;
  worker: WorkerRegistrations;
}
import type { Registration, VerifiedClient } from "../../worker/contract.ts";
import type { Transaction } from "../../kernel/store.ts";
import { throwIfCancelled, type Context } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { isString } from "../../kernel/values.ts";
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

export function toolStubs(t: TestContext): string {
  const directory = temporary(t);
  for (const name of ["rg", "fd"])
    writeFileSync(join(directory, name), "#!/bin/sh\necho test_tool\n", {
      mode: 0o700,
    });
  return directory;
}

export async function inProcessWorker(
  t: TestContext,
  input: Pick<
    WorkerOptions,
    "endpoint" | "token" | "modelRuntimeFactory" | "repositoryTransport"
  > & { client_secret: string },
) {
  const root = temporary(t);
  const previous = process.env.PATH;
  process.env.PATH = `${toolStubs(t)}:${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  writePrivate(
    clientConfigPath(env),
    stringify({ client_secret: input.client_secret }),
  );
  const logs: Record<string, unknown>[] = [];
  const ready = Promise.withResolvers<void>();
  const readyMessage = "Worker application ready";
  const worker = new Worker({
    ...input,
    env,
    log: (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      logs.push(record);
      if (record.msg === readyMessage) ready.resolve();
    },
  });
  const running = worker.run();
  t.after(async () => {
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
export const FAKE_SSH_IDENTITY = {
  hostname: "github.com",
  port: 22,
  identityFiles: ["~/.ssh/id_rsa"],
  identitiesOnly: true,
};
export const FAKE_SSH_CREDENTIAL_BODY = {
  name: "github-ssh",
  platform: "ssh" as const,
  metadata: {
    host: "github.com",
    hostname: "github.com",
    port: 22,
    identity_file: "~/.ssh/id_rsa",
  },
  secret: {},
};
const SINGLE_INSTANCE = 1;
const NO_INSTANCES = 0;
const OBJECT_GRANT_LIFETIME_MS = 3600000;
const SINK_BODY_MAX = 16 * 1024 ** 2;
const CHECKSUM_HEADER = "x-amz-checksum-sha256";
const ZERO_BYTES = 0;
const EPHEMERAL_PORT = 0;

type ObjectSink = { endpoint: string; objects: Map<string, Uint8Array> };

async function sinkRequest(
  objects: ObjectSink["objects"],
  request: IncomingMessage,
  response: ServerResponse,
) {
  assert.ok(request.url);
  const key = decodeURIComponent(request.url.slice(1));
  if (request.method === HttpMethod.Put) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= SINK_BODY_MAX);
      chunks.push(Buffer.from(chunk));
    }
    objects.set(key, Buffer.concat(chunks));
    response.writeHead(HttpStatus.OK).end();
    return;
  }
  assert.equal(request.method, HttpMethod.Get);
  const bytes = objects.get(key);
  response.writeHead(bytes ? HttpStatus.OK : HttpStatus.NotFound).end(bytes);
}

export async function objectSink(t: TestContext): Promise<ObjectSink> {
  const objects: ObjectSink["objects"] = new Map();
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void sinkRequest(objects, request, response).catch((error: unknown) => {
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
    if (failures.length)
      throw new AggregateError(failures, "Object sink failed.");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && !isString(address));
  assert.ok(address.port > EPHEMERAL_PORT);
  return { endpoint: `http://127.0.0.1:${address.port}`, objects };
}

export function sinkStorage(sink: ObjectSink): IntakeStorage {
  assert.ok(sink.endpoint.startsWith("http://127.0.0.1:"));
  assert.ok(sink.objects instanceof Map);
  const deletedRequests = new Set<string>();
  const get: IntakeStorage["get"] = async (call, _binding, key) => {
    throwIfCancelled(call.context);
    assert.ok(key);
    return {
      getUrl: `${sink.endpoint}/${encodeURIComponent(key)}`,
      expiresAt: Date.now() + OBJECT_GRANT_LIFETIME_MS,
    };
  };
  return {
    async put(call, _binding, key, size, sha256) {
      throwIfCancelled(call.context);
      assert.ok(size >= ZERO_BYTES);
      const headers: Record<string, string> = {};
      if (sha256 !== null) headers[CHECKSUM_HEADER] = sha256;
      return {
        putUrl: `${sink.endpoint}/${encodeURIComponent(key)}`,
        headers,
        expiresAt: Date.now() + OBJECT_GRANT_LIFETIME_MS,
      };
    },
    async check(call, binding, key, size, sha256) {
      throwIfCancelled(call.context);
      assert.ok(size >= ZERO_BYTES);
      if (sink.objects.get(key)?.byteLength !== size)
        throw new Error("object size mismatch");
      if (
        sha256 !== null &&
        createHash("sha256").update(sink.objects.get(key)!).digest("hex") !==
          sha256
      )
        throw new Error("object checksum mismatch");
      return { location: `s3://${binding.bucket}/${key}`, version: null };
    },
    get,
    executionGet: get,
    async delete(call, _binding, key, _version, requestKey) {
      throwIfCancelled(call.context);
      assert.ok(key);
      assert.ok(requestKey);
      if (deletedRequests.has(requestKey)) return;
      sink.objects.delete(key);
      deletedRequests.add(requestKey);
    },
  };
}

export function scriptedCheck(
  answer: Awaited<ReturnType<IntakeCheck["check"]>>,
) {
  const calls: Parameters<IntakeCheck["check"]>[] = [];
  return {
    calls,
    async check(...args: Parameters<IntakeCheck["check"]>) {
      throwIfCancelled(args[0]);
      assert.ok(args[1].frozenAction.key);
      calls.push(args);
      return structuredClone(answer);
    },
  } satisfies IntakeCheck & { calls: typeof calls };
}

export function scriptedActions() {
  const performAnswers: Awaited<ReturnType<IntakeActions["perform"]>>[] = [];
  type Answer = Awaited<ReturnType<IntakeActions["perform"]>>;
  const requests = new Map<string, Answer | null>();
  const readBackAnswers: (Answer | null)[] = [];
  const readBackCalls: string[] = [];
  const readAnswers: Awaited<ReturnType<IntakeActions["read"]>>[] = [];
  const performCalls: {
    call: { executionId: string };
    action: Parameters<IntakeActions["perform"]>[1];
    operands: Parameters<IntakeActions["perform"]>[2];
    requestKey: string;
  }[] = [];
  const readCalls: {
    call: { executionId: string };
    method: Parameters<IntakeActions["read"]>[1];
    address: Parameters<IntakeActions["read"]>[2];
  }[] = [];
  let gate: Promise<void> | null = null;
  const seam: IntakeActions = {
    async perform(call, action, operands, requestKey) {
      assert.ok(requestKey);
      const key = `${action.action}/${requestKey}`;
      const previous = requests.get(key);
      if (previous === null)
        throw new GatewayError(
          HttpStatus.Conflict,
          "intake.outbound.request.in_flight",
          "Request is running.",
        );
      if (previous !== undefined) {
        if (!("class" in previous)) return structuredClone(previous);
        readBackCalls.push(requestKey);
        const match = readBackAnswers.shift();
        if (match && !("class" in match)) requests.set(key, match);
        return structuredClone(match ?? previous);
      }
      requests.set(key, null);
      performCalls.push({
        call: { executionId: call.executionId },
        action,
        operands,
        requestKey,
      });
      if (gate) await gate;
      const answer = performAnswers.shift();
      if (!answer) throw new Error("no scripted answer");
      requests.set(key, structuredClone(answer));
      return answer;
    },
    async read(call, method, address) {
      readCalls.push({
        call: { executionId: call.executionId },
        method,
        address,
      });
      if (gate) await gate;
      const answer = readAnswers.shift();
      if (!answer) throw new Error("no scripted answer");
      return answer;
    },
  };
  return {
    seam,
    performAnswers,
    readBackAnswers,
    readBackCalls,
    requests,
    readAnswers,
    performCalls,
    readCalls,
    hold() {
      assert.equal(gate, null);
      const pending = Promise.withResolvers<void>();
      gate = pending.promise;
      return () => {
        assert.equal(gate, pending.promise);
        gate = null;
        pending.resolve();
      };
    },
  };
}

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
    ): Registration & { workerName: string } {
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
      if (previous) return { ...previous, workerName: "general@1" };
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
        workerName: "general@1",
        runtimeIdentity: createIdentity("worker_instance"),
        registeredAt: now,
      };
      registrations.set(client.clientId, registration);
      registrationHistory.set(registration.runtimeIdentity, registration);
      return registration;
    },
    deregister(tx: Transaction, runtimeIdentity: string, now: number): void {
      assert.ok(tx.database.isTransaction);
      assert.ok(Number.isSafeInteger(now));
      const row = registrationHistory.get(runtimeIdentity);
      if (
        row &&
        registrations.get(row.clientId)?.runtimeIdentity === runtimeIdentity
      )
        registrations.delete(row.clientId);
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
    scheduler?: Partial<SchedulerConfig>;
    oauthProviders?: Parameters<typeof composeServices>[0]["oauthProviders"];
    standIns?: Parameters<typeof composeServices>[0]["standIns"];
    workbenchModelRuntimeFactory?: Parameters<
      typeof composeServices
    >[0]["workbenchModelRuntimeFactory"];
    stateDirectory?: string;
  } = {},
) {
  process.umask(0o077);
  const config = configuration({
    master_key: randomBytes(32).toString("base64"),
    gateway: { port: 0, allowed_hosts: ["localhost"] },
    scheduler: options.scheduler ?? {},
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
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  ]);
  const logs: string[] = [];
  const {
    scheduler,
    custody,
    gateway,
    project,
    worker,
    mission,
    workbench,
    invocation,
    repoConnector,
  } = composeServices({
    config,
    store,
    stateDirectory: options.stateDirectory ?? temporary(t),
    workbenchModelRuntimeFactory: options.workbenchModelRuntimeFactory,
    registry: options.registry,
    health: options.health ?? new HealthRegistry(),
    repositoryConnector: options.repositoryConnector,
    oauthProviders: options.oauthProviders,
    bindings: options.machines?.project,
    registrations: options.machines?.worker,
    inventoryOverrides: options.inventoryOverrides,
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
        [scheduler, custody, worker, mission, project, workbench, gateway].map(
          (service) => service.quiesce(),
        ),
      );
      failures.push(...quiescence.filter((error) => error !== null));
      await gateway.drain();
      const invocationError = await invocation.stop();
      if (invocationError) failures.push(invocationError);
      for (const service of [
        gateway,
        workbench,
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
    workbench,
    gateway,
  ]) {
    const error = await service.start();
    if (error) throw error;
  }
  const port = gateway.address()!.port;
  config.gateway.allowed_hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const endpoint = `http://127.0.0.1:${port}`;
  const request = (path: string, init?: RequestInit) =>
    fetch(endpoint + path, init);
  return {
    repoConnector,
    project,
    scheduler,
    worker,
    custody,
    mission,
    workbench,
    gateway,
    invocation,
    store,
    endpoint,
    request,
    token: (
      await generateHumanJWT(config.master_key, config.gateway.token_lifetime)
    ).token,
    machineToken: async (
      projectId: string,
      bindingName: string,
      name?: string,
    ) =>
      (
        await generateMachineJWT(
          config.master_key,
          config.gateway.token_lifetime,
          { projectId, bindingName },
          name,
        )
      ).token,
    config,
    accountId: KANTHORD_AUTH_USERNAME,
    logs,
  };
}

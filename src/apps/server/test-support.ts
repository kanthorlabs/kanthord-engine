import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { simpleGit } from "simple-git";
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
import { z } from "zod";
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
import { intakeMigrations } from "../../intake/index.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import {
  MISSION_SERVICE_NAME,
  type IntakeStorage,
} from "../../mission/contract.ts";
import { workerMigrations } from "../../worker/index.ts";
import { agentMigrations } from "../../agent/index.ts";
import { workbenchMigrations } from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { composeServices } from "./index.ts";
import { RepositoryComponent, type GitWriter } from "../../repository/index.ts";
import { GITHUB_API_VERSION } from "../../repository/github.ts";
import type { RepositoryTransport } from "../../worker/index.ts";
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
import type { WorkerRegistrations } from "../../worker/contract.ts";
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

export const domainHealth = {
  repository: { toolchain: HealthStatus.Healthy },
  scheduler: { queue: 200 },
  custody: { credential: 200 },
  project: { bindings: 200 },
  worker: { registrations: 200 },
  mission: { operations: 200 },
  intake: { events: 200 },
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
      get_url: `${sink.endpoint}/${encodeURIComponent(key)}`,
      expires_at: Date.now() + OBJECT_GRANT_LIFETIME_MS,
    };
  };
  return {
    async put(call, _binding, key, size, sha256) {
      throwIfCancelled(call.context);
      assert.ok(size >= ZERO_BYTES);
      const headers: Record<string, string> = {};
      if (sha256 !== null) headers[CHECKSUM_HEADER] = sha256;
      return {
        put_url: `${sink.endpoint}/${encodeURIComponent(key)}`,
        headers,
        expires_at: Date.now() + OBJECT_GRANT_LIFETIME_MS,
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
      if (previous) return { ...previous, worker_name: "general@1" };
      const count = [...registrations.values()].filter(
        (entry) =>
          entry.resource_identity === client.resource_identity &&
          entry.project_id === client.project_id,
      ).length;
      if (count >= binding.capacity)
        throw new GatewayError(
          HttpStatus.Conflict,
          "worker.instance.slot_unavailable",
          "Worker binding is at capacity.",
        );
      const registration = {
        ...client,
        worker_name: "general@1",
        runtime_identity: createIdentity("worker_instance"),
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
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  ]);
  const logs: string[] = [];
  const {
    scheduler,
    custody,
    gateway,
    project,
    intake,
    worker,
    mission,
    workbench,
    invocation,
    repoConnector,
    github,
    gitWriter,
    s3,
  } = composeServices({
    config,
    store,
    stateDirectory: options.stateDirectory ?? temporary(t),
    workbenchModelRuntimeFactory: options.workbenchModelRuntimeFactory,
    registry: options.registry,
    health: options.health ?? new HealthRegistry(),
    repositoryConnector: options.repositoryConnector,
    github: options.github,
    repositoryTransport: options.repositoryTransport,
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
    intake,
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

const GITHUB_VERSION_HEADER = "x-github-api-version";
const GITHUB_BODY_MAX = 1024 ** 2;
const GITHUB_PULL_ROUTE =
  /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/([1-9][0-9]*)(\/comments)?)?$/;
const GITHUB_TOKEN_SCHEME = /^(?:token|bearer) /i;
const GITHUB_MERGE_SHA = /^[a-f0-9]{40}$/;
const GITHUB_NOT_FOUND = { message: "Not Found" };
const GITHUB_SCRIPTED_FAILURE = { message: "scripted failure" };
const GITHUB_FIRST_PULL_NUMBER = 1;
const GITHUB_NEXT_PULL_STEP = 1;
const GITHUB_CREATED_STATUS = 201;
const GITHUB_EMPTY_BODY = "";
const GITHUB_MIN_SEGMENT_LENGTH = 1;

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
}

export interface FakeGitHubCall {
  method: string;
  path: string;
  body: unknown;
  token: string | null;
}

interface FakeGitHubState {
  pulls: FakePullRequest[];
  calls: FakeGitHubCall[];
  next: { status: number; body: unknown } | null;
  failPulls: number | null;
  dropNext: boolean;
  gate: Promise<void> | null;
}

interface FakeGitHubAnswer {
  status: number;
  body: unknown;
}

const createPullSchema = z.looseObject({
  head: z.string().min(GITHUB_MIN_SEGMENT_LENGTH),
  base: z.string().min(GITHUB_MIN_SEGMENT_LENGTH),
  title: z.string(),
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
    head: {
      ref: pull.head,
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
  return { status: HttpStatus.OK, body: listed.map(pullBody) };
}

function routePull(
  state: FakeGitHubState,
  method: string,
  url: URL,
  body: unknown,
): FakeGitHubAnswer {
  const route = GITHUB_PULL_ROUTE.exec(url.pathname);
  if (!route) return { status: HttpStatus.NotFound, body: GITHUB_NOT_FOUND };
  const [, owner, repo, number, comments] = route;
  assert.ok(owner && repo);
  if (number === undefined) {
    return method === HttpMethod.Post
      ? createPull(state, owner, repo, body)
      : listPulls(state, owner, repo, url.searchParams);
  }
  const pull = state.pulls.find(
    (item) =>
      item.owner === owner && item.repo === repo && item.number === +number,
  );
  if (!pull || method !== HttpMethod.Get)
    return { status: HttpStatus.NotFound, body: GITHUB_NOT_FOUND };
  return { status: HttpStatus.OK, body: comments ? [] : pullBody(pull) };
}

function replyGitHub(response: ServerResponse, answer: FakeGitHubAnswer) {
  assert.ok(Number.isInteger(answer.status));
  assert.ok(!response.headersSent);
  response
    .writeHead(answer.status, { "content-type": "application/json" })
    .end(JSON.stringify(answer.body));
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
  state.calls.push({
    method,
    path: request.url,
    body,
    token: gitHubToken(request),
  });
  if (state.gate) await state.gate;
  const scripted = state.next;
  if (scripted) {
    state.next = null;
    return replyGitHub(response, scripted);
  }
  if (method === HttpMethod.Get && state.failPulls !== null)
    return replyGitHub(response, {
      status: state.failPulls,
      body: GITHUB_SCRIPTED_FAILURE,
    });
  const answer = routePull(
    state,
    method,
    new URL(request.url, "http://127.0.0.1"),
    body,
  );
  if (method !== HttpMethod.Get && state.dropNext) {
    state.dropNext = false;
    response.destroy();
    return;
  }
  replyGitHub(response, answer);
}

function changePull(state: FakeGitHubState, number: number): FakePullRequest {
  const pull = state.pulls.find((item) => item.number === number);
  assert.ok(pull, "Unknown fake pull request");
  assert.equal(pull.state, FakePullState.Open);
  return pull;
}

export async function fakeGitHub(t: TestContext) {
  const state: FakeGitHubState = {
    pulls: [],
    calls: [],
    next: null,
    failPulls: null,
    dropNext: false,
    gate: null,
  };
  const failures: unknown[] = [];
  let releaseGate = () => {};
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
      pull.state = FakePullState.Closed;
      pull.merged = true;
      pull.merge_commit_sha = sha;
    },
    close(number: number): void {
      changePull(state, number).state = FakePullState.Closed;
    },
    reopen(number: number): void {
      const pull = state.pulls.find((item) => item.number === number);
      assert.ok(pull, "Unknown fake pull request");
      assert.equal(pull.state, FakePullState.Closed);
      assert.equal(pull.merged, false);
      pull.state = FakePullState.Open;
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

const MAIN_REF = "refs/heads/main";

export async function bareRepository(t: TestContext, name: string) {
  const root = temporary(t);
  const bare = join(root, `${name}.git`);
  const seed = join(root, "seed");
  mkdirSync(bare);
  await simpleGit(bare).init(true, ["--initial-branch=main"]);
  await simpleGit().clone(bare, seed);
  const git = simpleGit(seed);
  await git.addConfig("user.name", "Test Journey");
  await git.addConfig("user.email", "test_journey@example.invalid");
  writeFileSync(join(seed, "README.md"), "test_journey repository\n");
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
    proveSshIdentity: async () => {},
    clone: (address, ...args) => connector.clone(mapped(address), ...args),
    cloneSnapshot: (address, ...args) =>
      connector.cloneSnapshot(mapped(address), ...args),
    fetchAndCheckout: (...args) => connector.fetchAndCheckout(...args),
    pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
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

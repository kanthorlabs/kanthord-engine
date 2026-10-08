import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { simpleGit } from "simple-git";
import { join } from "node:path";
import { stringify } from "yaml";
import { Worker, type WorkerOptions } from "../worker/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import { clientConfigPath } from "../../gateway/client.ts";
import { createHash, createHmac, randomBytes } from "node:crypto";
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
import { MISSION_SERVICE_NAME, type Revision } from "../../mission/contract.ts";
import { workerMigrations } from "../../worker/index.ts";
import { agentMigrations } from "../../agent/index.ts";
import { workbenchMigrations } from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
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
    workbenchModelRuntimeFactory?: Parameters<
      typeof composeServices
    >[0]["workbenchModelRuntimeFactory"];
    stateDirectory?: string;
    intake?: { pendingEventLimit?: number; pollIntervalMs?: number };
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
    intake: options.intake,
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
  const answer = routePull(state, method, url, body);
  if (method !== HttpMethod.Get && state.dropNext) {
    state.dropNext = false;
    response.destroy();
    return;
  }
  reply(answer);
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
    events: new Map(),
    failEvents: null,
    eventsHold: null,
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
  await cli.write(
    ["repository", "credential", "create"],
    FAKE_SSH_CREDENTIAL_BODY,
  );
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
        ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
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
      config: { worker: "claude@1", instance_count: SINGLE_INSTANCE },
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
    kind: string,
    bindings: string[],
    parentId?: string,
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
        kind,
        content: { ...STORAGE_NODE_CONTENT, bindings },
        reason: "plan",
        expected_mission_version: version,
        ...(parentId
          ? {
              parent_id: parentId,
              expected_parent_revision: STORAGE_FIRST_REVISION,
            }
          : {}),
      },
    );
    return answer.revisions[STORAGE_FIRST_INDEX]!.node_id;
  };
  const initiative = await create("initiative.md", "initiative", []);
  return create("objective.md", "objective", bindingIds, initiative);
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
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
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

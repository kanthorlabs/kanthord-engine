import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { test, type TestContext } from "node:test";
import { type Dependencies, WorkerService } from "./service.ts";
import { workerMigrations } from "./migrations.ts";
import {
  alwaysAvailable,
  BindingEntryState,
  connectionPayloadSchema,
  INSTANCE_CONNECTED_WINDOW_MS,
  INSTANCE_CONNECTION_INFO,
  instanceConfigurationSchema,
  InstancePlacement,
  PlacementIssue,
  WORKER_SERVICE_NAME,
  WORKER_TOKEN_INFO,
  type WorkerAgentView,
  type WorkerBindingsOf,
  WorkerErrorCode,
  workerOperations,
  workerTokenPayloadSchema,
} from "./contract.ts";
import { AgentErrorCode, type HolderScope } from "../agent/contract.ts";
import type { ExecutionEnds } from "../mission/contract.ts";
import {
  insertRegistration,
  readAllLive,
  readRow,
} from "./registration-rows.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
} from "../kernel/hpke.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { background } from "../kernel/context.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  testMachineIdentity,
  testWorkerIdentity,
} from "../kernel/test-identity.ts";
import { packageVersion } from "../kernel/version.ts";

const WORKER = "coder@1";
const INSTANCE = "laptop";
const ENDPOINT = "http://127.0.0.1:31415";
const CONNECTION_NAME = "host-a";
const OTHER_CONNECTION_NAME = "host-b";
const TOKEN_LIFETIME_MS = 3600000;
const CLIENT_ID_CHARACTERS = 26;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const UTF8 = "utf8";
const BASE64URL = "base64url";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FIRST_CHARACTER = 0;
const FIRST_CHARACTER_RANGE = 8;
const CHARACTER_RANGE = 32;
const NO_VERSION = 0;
const FIRST_VERSION = 1;
const SECOND_VERSION = 2;
const NO_ROWS = 0;
const WORKER_CONFIG = {
  heartbeat_window: 300,
  server_instance_limit: 16,
  container_image: "docker.io/kanthorlabs/kanthord",
};
const SERVER_INSTANCE_LIMIT = 2;
const INVALID_PLACEMENT = "thread";

const ANSWERED_ENDS: ExecutionEnds = { lost: [], revoked: [] };
const REVOKE_FAILURE = "revoke failed";
const NO_CALLS = 0;
const SINGLE_CALL = 1;

type Binding = ReturnType<WorkerBindingsOf>[number];

const HOLDER_MISMATCH_VIEW: WorkerAgentView = {
  defaults: null,
  effective: null,
  chain: [],
  active_position: null,
  cooling: null,
  valid: false,
  issues: [
    { path: ["placement"], code: AgentErrorCode.CredentialHolderMismatch },
  ],
};

function unexpected(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

function clientIdentity(...parts: (string | number)[]): string {
  const digest = createHash("sha256").update(parts.join("/")).digest();
  const characters = [...digest.subarray(0, CLIENT_ID_CHARACTERS)].map(
    (byte, index) =>
      CROCKFORD[
        index === FIRST_CHARACTER
          ? byte % FIRST_CHARACTER_RANGE
          : byte % CHARACTER_RANGE
      ],
  );
  return `client_identity_${characters.join("")}`;
}

function bindingOf(projectId: string, name: string, instances: string[]) {
  return {
    binding_id: createIdentity("binding"),
    name,
    project_name: "project",
    project_id: projectId,
    resource_identity: `worker:kanthord:${name}`,
    revision: 1,
    worker_name: WORKER,
    instance_count: instances.length,
    generation: 1,
    resource_budget: null,
    entries: [],
    tombstone: false,
    worker_instances: instances,
  } satisfies Binding;
}

function instanceFixture(
  t: TestContext,
  config: Partial<typeof WORKER_CONFIG> = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const bindings: Binding[] = [];
  const scopes: HolderScope[] = [];
  const unended = new Map<string, string>();
  const revoked: string[] = [];
  const reports: { ends: ExecutionEnds; inTransaction: boolean }[] = [];
  const revocation = { failure: null as Error | null };
  const dependencies: Dependencies = {
    config: { ...WORKER_CONFIG, ...config },
    store,
    missionActions: {
      authorizeRequest: unexpected,
      authorizeAction: unexpected,
      actionContextOf: unexpected,
    },
    instanceArchive: {
      revokeForInstanceArchive: (_tx, executionId) => {
        if (revocation.failure) throw revocation.failure;
        revoked.push(executionId);
        return ANSWERED_ENDS;
      },
      reportExecutionEnds: (ends) => {
        reports.push({ ends, inTransaction: store.database.isTransaction });
      },
    },
    intakeActions: { perform: unexpected, read: unexpected },
    evidenceRequests: { request: unexpected },
    custodyHandover: {
      handover: unexpected,
      report: unexpected,
      sshSign: unexpected,
      sshPublicKeyOf: unexpected,
    },
    promptTelemetry: { agentPrompted: () => {} },
    agentPrompt: { compose: unexpected, templates: unexpected },
    workerBindingOf: (_tx, projectId, resourceIdentity) =>
      bindings.find(
        (binding) =>
          binding.project_id === projectId &&
          binding.resource_identity === resourceIdentity,
      ) ?? null,
    workerBindingsOf: (_tx, projectId) =>
      bindings.filter(
        (binding) => projectId === null || binding.project_id === projectId,
      ),
    instanceIssuer: {
      workerToken: async ({ instanceId }) => ({
        token: `worker.${instanceId}`,
        expiresAt: Date.now() + TOKEN_LIFETIME_MS,
      }),
      clientToken: async ({ clientId, connectionId }) => ({
        token: `client.${clientId}.${connectionId}`,
        expiresAt: Date.now() + TOKEN_LIFETIME_MS,
      }),
      clientIdentity: (instanceId, projectId, resourceIdentity, generation) =>
        clientIdentity(instanceId, projectId, resourceIdentity, generation),
      clientSecret: (clientId) => `secret.${clientId}`,
    },
    environmentClaimed: unexpected,
    environmentDigestOf: unexpected,
    environmentOf: unexpected,
    workerBindingRowOf: unexpected,
    repositoryPolicyOf: unexpected,
    repositoryBindingIdsOf: unexpected,
    intentOf: unexpected,
    pinnedCredentialMetadata: unexpected,
    credentialMetadata: unexpected,
    sshHostKeysOf: unexpected,
    schedulerClaims: {
      agentSelectionsOf: () => [],
      agentPinsOf: () => null,
      requireRunning: unexpected,
      runningExecutionOfRuntime: () => null,
      unendedExecutionOf: (_tx, runtimeIdentity) => {
        const execution = unended.get(runtimeIdentity);
        return execution ? { execution_id: execution } : null;
      },
      activityOf: unexpected,
    },
    agentConfiguration: {
      validateEntry: unexpected,
      selectAgent: unexpected,
      selectionAt: unexpected,
      selectionView: unexpected,
      agentView: (_tx, _agent, _entry, scope) => {
        scopes.push(scope);
        return HOLDER_MISMATCH_VIEW;
      },
    },
  };
  const service = (): WorkerService => {
    const worker = new WorkerService(dependencies);
    const registry = new OperationRegistry();
    worker.declare(registry);
    return Object.assign(worker, { registry });
  };
  let worker = service();
  let registry = (worker as WorkerService & { registry: OperationRegistry })
    .registry;
  let commits = 0;
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (fn) => {
      commits++;
      return store.transaction(fn);
    },
  };
  async function invoke<K extends keyof typeof workerOperations>(
    key: K,
    body: unknown = null,
    params: Record<string, string> = {},
    query: Record<string, unknown> = {},
  ): Promise<(typeof workerOperations)[K]["output"]["_output"]> {
    const operation = workerOperations[key];
    const input = operation.input.parse({ params, query, body });
    return operation.output.parse(
      await registry.get(operation.id).handler(input, caller),
    ) as (typeof workerOperations)[K]["output"]["_output"];
  }
  async function refuses(
    task: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    await assert.rejects(
      task,
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === status &&
        error.code === code,
    );
  }
  async function created(name = INSTANCE) {
    const pair = await generateX25519KeyPair();
    const record = await invoke("instance.create", {
      name,
      worker: WORKER,
      placement: InstancePlacement.Worker,
      public_key: pair.public_key.toString(BASE64URL),
    });
    return { record, pair };
  }
  function createdAt(
    name: string,
    placement: InstancePlacement,
    extra: Record<string, unknown> = {},
  ) {
    return invoke("instance.create", {
      name,
      worker: WORKER,
      placement,
      ...extra,
    });
  }
  function asWorker(instanceId: string, name = INSTANCE) {
    caller.identity = testWorkerIdentity(instanceId, name, "jti");
  }
  function asHuman() {
    caller.identity = {
      kind: "human",
      accountId: "alice",
      name: "Alice",
      jti: "j",
    } as CallerContext["identity"];
  }
  function register(binding: Binding, instanceId: string) {
    caller.identity = testMachineIdentity(
      {
        clientId: clientIdentity(
          instanceId,
          binding.project_id,
          binding.resource_identity,
          binding.generation,
        ),
        name: INSTANCE,
        projectId: binding.project_id,
        resourceIdentity: binding.resource_identity,
        issuedAt: Date.now(),
        instanceId,
        connectionId: createIdentity("connection"),
      },
      "jti",
    );
    return invoke("register");
  }
  async function restart() {
    await worker.stop();
    worker = service();
    registry = (worker as WorkerService & { registry: OperationRegistry })
      .registry;
    await worker.start();
  }
  return {
    store,
    bindings,
    scopes,
    unended,
    revoked,
    reports,
    revocation,
    invoke,
    refuses,
    created,
    createdAt,
    asWorker,
    asHuman,
    register,
    restart,
    worker: () => worker,
    commits: () => commits,
  };
}

test("create stores a public key and answers no instance configuration", async (t) => {
  const f = instanceFixture(t);
  const { record, pair } = await f.created();
  assert.equal(record.name, INSTANCE);
  assert.equal(record.worker, WORKER);
  assert.equal(record.revision, FIRST_REVISION);
  assert.equal(record.placement, InstancePlacement.Worker);
  assert.equal(record.public_key, pair.public_key.toString(BASE64URL));
  assert.equal(record.fingerprint, keyFingerprint(pair.public_key));
  assert.equal(record.ended_at, null);
  assert.ok(!("instance_configuration" in record));
});

test("create with an endpoint answers an instance configuration of a generated key", async (t) => {
  const f = instanceFixture(t);
  const record = await f.invoke("instance.create", {
    name: INSTANCE,
    worker: WORKER,
    placement: InstancePlacement.Worker,
    endpoint: ENDPOINT,
  });
  assert.ok(record.instance_configuration);
  assert.doesNotMatch(record.instance_configuration, /[=+/]/);
  const configuration = instanceConfigurationSchema.parse(
    JSON.parse(
      Buffer.from(record.instance_configuration, BASE64URL).toString(UTF8),
    ),
  );
  assert.deepEqual(configuration, {
    name: INSTANCE,
    endpoint: ENDPOINT,
    instance_id: record.id,
    private_key: configuration.private_key,
  });
  f.asWorker(record.id);
  const token = await f.invoke("instance.token", { instance_id: record.id });
  const opened = workerTokenPayloadSchema.parse(
    await openJSON(
      Buffer.from(configuration.private_key, BASE64URL),
      WORKER_TOKEN_INFO,
      record.id,
      token.sealed,
    ),
  );
  assert.equal(opened.fingerprint, record.fingerprint);
});

test("create refuses each invalid input with its code", async (t) => {
  const f = instanceFixture(t);
  const { pair } = await f.created();
  const zero = Buffer.alloc(32).toString(BASE64URL);
  const key = pair.public_key.toString(BASE64URL);
  const other = (await generateX25519KeyPair()).public_key.toString(BASE64URL);
  const cases: [Record<string, unknown>, number, string][] = [
    [
      {
        name: INSTANCE,
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: other,
      },
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceNameConflict,
    ],
    [
      {
        name: "token",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: other,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceNameInvalid,
    ],
    [
      {
        name: "Upper",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: other,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceNameInvalid,
    ],
    [
      {
        name: "other",
        worker: "absent@1",
        placement: InstancePlacement.Worker,
        public_key: other,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceWorkerInvalid,
    ],
    [
      {
        name: "other",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: zero,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      { name: "other", worker: WORKER, placement: InstancePlacement.Worker },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      {
        name: "other",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: other,
        endpoint: ENDPOINT,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      {
        name: "other",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        public_key: key,
      },
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceKeyConflict,
    ],
  ];
  for (const [body, status, code] of cases)
    await f.refuses(() => f.invoke("instance.create", body), status, code);
});

test("create at a server or a container placement stores null key fields", async (t) => {
  const f = instanceFixture(t);
  for (const [name, placement] of [
    ["thread-host", InstancePlacement.Server],
    ["box", InstancePlacement.Container],
  ] as const) {
    const record = await f.createdAt(name, placement);
    assert.equal(record.placement, placement);
    assert.equal(record.public_key, null);
    assert.equal(record.fingerprint, null);
    assert.ok(!("instance_configuration" in record));
  }
});

test("create refuses an absent or an unknown placement", async (t) => {
  const f = instanceFixture(t);
  await f.refuses(
    () => f.invoke("instance.create", { name: INSTANCE, worker: WORKER }),
    HttpStatus.BadRequest,
    WorkerErrorCode.InstancePlacementInvalid,
  );
  await f.refuses(
    () =>
      f.createdAt(INSTANCE, INVALID_PLACEMENT as InstancePlacement, {
        endpoint: ENDPOINT,
      }),
    HttpStatus.BadRequest,
    WorkerErrorCode.InstancePlacementInvalid,
  );
});

test("create of a server instance refuses a public key or an endpoint", async (t) => {
  const f = instanceFixture(t);
  const key = (await generateX25519KeyPair()).public_key.toString(BASE64URL);
  for (const placement of [
    InstancePlacement.Server,
    InstancePlacement.Container,
  ])
    for (const extra of [{ public_key: key }, { endpoint: ENDPOINT }])
      await f.refuses(
        () => f.createdAt(INSTANCE, placement, extra),
        HttpStatus.BadRequest,
        WorkerErrorCode.InstanceKeyForbidden,
      );
});

test("create at the container placement refuses an unavailable runtime and passes a failed probe", async (t) => {
  const f = instanceFixture(t);
  const status = (reason: PlacementIssue) => ({
    ...alwaysAvailable(InstancePlacement.Container),
    available: false,
    reason,
  });
  const read = t.mock.method(f.worker(), "placementStatus", async () =>
    status(PlacementIssue.RuntimeAbsent),
  );
  await assert.rejects(
    () => f.createdAt(INSTANCE, InstancePlacement.Container),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === WorkerErrorCode.InstancePlacementUnavailable &&
      isDeepStrictEqual(error.details, {
        placement: InstancePlacement.Container,
        reason: PlacementIssue.RuntimeAbsent,
      }),
  );
  for (const reason of [
    PlacementIssue.ServerInContainer,
    PlacementIssue.RuntimeRootful,
  ]) {
    read.mock.mockImplementation(async () => status(reason));
    await f.refuses(
      () => f.createdAt(INSTANCE, InstancePlacement.Container),
      HttpStatus.Conflict,
      WorkerErrorCode.InstancePlacementUnavailable,
    );
  }
  read.mock.mockImplementation(async () =>
    status(PlacementIssue.RuntimeFailed),
  );
  const record = await f.createdAt(INSTANCE, InstancePlacement.Container);
  assert.equal(record.placement, InstancePlacement.Container);
});

test("create of a server instance refuses at the server instance limit and a worker instance and an archived place pass", async (t) => {
  const f = instanceFixture(t, {
    server_instance_limit: SERVER_INSTANCE_LIMIT,
  });
  await f.createdAt("first", InstancePlacement.Server);
  await f.createdAt("second", InstancePlacement.Container);
  for (const placement of [
    InstancePlacement.Server,
    InstancePlacement.Container,
  ])
    await assert.rejects(
      () => f.createdAt("third", placement),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === WorkerErrorCode.InstanceServerLimit &&
        isDeepStrictEqual(error.details, { limit: SERVER_INSTANCE_LIMIT }),
    );
  await f.created("laptop");
  await f.invoke(
    "instance.archive",
    { expected_revision: FIRST_REVISION },
    { instance_name: "first" },
  );
  const third = await f.createdAt("third", InstancePlacement.Server);
  assert.equal(third.placement, InstancePlacement.Server);
});

test("a Reset key of a server instance refuses", async (t) => {
  const f = instanceFixture(t);
  await f.createdAt(INSTANCE, InstancePlacement.Server);
  const key = (await generateX25519KeyPair()).public_key.toString(BASE64URL);
  await assert.rejects(
    () =>
      f.invoke(
        "instance.rotate",
        { public_key: key, expected_revision: FIRST_REVISION },
        { instance_name: INSTANCE },
      ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === WorkerErrorCode.InstancePlacementUnsupported &&
      isDeepStrictEqual(error.details, { placement: InstancePlacement.Server }),
  );
});

test("list and get answer the placement of every instance", async (t) => {
  const f = instanceFixture(t);
  await f.created("alpha");
  await f.createdAt("beta", InstancePlacement.Server);
  await f.createdAt("gamma", InstancePlacement.Container);
  const listed = await f.invoke("instance.list", null, {}, {});
  assert.deepEqual(
    listed.items.map((item) => [item.name, item.placement]),
    [
      ["alpha", InstancePlacement.Worker],
      ["beta", InstancePlacement.Server],
      ["gamma", InstancePlacement.Container],
    ],
  );
  const got = await f.invoke("instance.get", null, { instance_name: "beta" });
  assert.equal(got.placement, InstancePlacement.Server);
});

test("the token opens only with the instance key and refuses an unknown or ended revision", async (t) => {
  const f = instanceFixture(t);
  const { record, pair } = await f.created();
  const answer = await f.invoke("instance.token", { instance_id: record.id });
  assert.equal(answer.server_version, packageVersion());
  const payload = workerTokenPayloadSchema.parse(
    await openJSON(
      pair.private_key,
      WORKER_TOKEN_INFO,
      record.id,
      answer.sealed,
    ),
  );
  assert.equal(payload.token, `worker.${record.id}`);
  assert.equal(payload.name, INSTANCE);
  assert.equal(payload.worker, WORKER);
  await f.refuses(
    () =>
      f.invoke("instance.token", {
        instance_id: createIdentity("worker_instance"),
      }),
    HttpStatus.NotFound,
    WorkerErrorCode.InstanceNotFound,
  );
});

test("connect answers one sealed entry for each listing binding, and a second process supersedes the first", async (t) => {
  const f = instanceFixture(t);
  const { record, pair } = await f.created();
  const projectA = createIdentity("project");
  const projectB = createIdentity("project");
  f.bindings.push(
    bindingOf(projectA, "general", [INSTANCE]),
    bindingOf(projectB, "review", [INSTANCE]),
    bindingOf(projectB, "other", ["desktop"]),
  );
  f.asWorker(record.id);
  const first = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const payload = connectionPayloadSchema.parse(
    await openJSON(
      pair.private_key,
      INSTANCE_CONNECTION_INFO,
      `${record.id}${first.connection_id}`,
      first.sealed,
    ),
  );
  assert.deepEqual(
    payload.bindings.map((entry) => [entry.resource_identity, entry.state]),
    [
      ["worker:kanthord:general", BindingEntryState.Serving],
      ["worker:kanthord:review", BindingEntryState.Serving],
    ],
  );
  for (const entry of payload.bindings) {
    assert.equal(
      entry.token,
      `client.${entry.client_id}.${first.connection_id}`,
    );
    assert.equal(entry.client_secret, `secret.${entry.client_id}`);
  }
  const heartbeat = await f.invoke("instance.heartbeat", {
    connection_id: first.connection_id,
    connection_name: CONNECTION_NAME,
  });
  assert.equal(heartbeat.server_version, packageVersion());
  assert.equal(heartbeat.credential_version, NO_VERSION);
  assert.deepEqual(heartbeat.login_sessions, []);
  const second = await f.invoke("instance.connect", {
    connection_name: OTHER_CONNECTION_NAME,
  });
  assert.notEqual(second.connection_id, first.connection_id);
  await f.refuses(
    () =>
      f.invoke("instance.heartbeat", {
        connection_id: first.connection_id,
        connection_name: CONNECTION_NAME,
      }),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceConnectionSuperseded,
  );
  await f.refuses(
    () =>
      f.invoke("instance.connect", {
        connection_id: first.connection_id,
        connection_name: CONNECTION_NAME,
      }),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceConnectionSuperseded,
  );
  assert.equal(
    f.worker().instances.holdConnection(record.id, first.connection_id),
    false,
  );
  f.asHuman();
  const read = await f.invoke("instance.get", null, {
    instance_name: INSTANCE,
  });
  assert.equal(read.connection?.connection_name, OTHER_CONNECTION_NAME);
  assert.deepEqual(
    read.bindings.map((binding) => binding.binding),
    ["general", "review"],
  );
});

test("a binding change bumps the binding version of each listed instance", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const projectId = createIdentity("project");
  await f.worker().start();
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  assert.equal(connection.binding_version, NO_VERSION);
  f.bindings.push(bindingOf(projectId, "general", [INSTANCE]));
  f.worker().bindingsChanged(projectId);
  const listed = await f.invoke("instance.heartbeat", {
    connection_id: connection.connection_id,
    connection_name: CONNECTION_NAME,
  });
  assert.equal(listed.binding_version, FIRST_VERSION);
  f.bindings[0]!.worker_instances = [];
  f.worker().bindingsChanged(projectId);
  const dropped = await f.invoke("instance.heartbeat", {
    connection_id: connection.connection_id,
    connection_name: CONNECTION_NAME,
  });
  assert.equal(dropped.binding_version, SECOND_VERSION);
});

test("a listed instance registers once for each binding and a binding that drops it keeps a draining entry", async (t) => {
  const f = instanceFixture(t);
  const { record, pair } = await f.created();
  const projectId = createIdentity("project");
  const binding = bindingOf(projectId, "general", [INSTANCE]);
  f.bindings.push(binding);
  const first = await f.register(binding, record.id);
  assert.deepEqual(await f.register(binding, record.id), first);
  assert.equal(
    f.store.transaction((tx) => readRow(tx, first.runtime_identity))
      ?.instance_id,
    record.id,
  );
  binding.worker_instances = [];
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const payload = connectionPayloadSchema.parse(
    await openJSON(
      pair.private_key,
      INSTANCE_CONNECTION_INFO,
      `${record.id}${connection.connection_id}`,
      connection.sealed,
    ),
  );
  assert.deepEqual(
    payload.bindings.map((entry) => entry.state),
    [BindingEntryState.Draining],
  );
  const other = await f.created("desktop");
  await f.refuses(
    () => f.register(binding, other.record.id),
    HttpStatus.Conflict,
    WorkerErrorCode.PlacementMismatch,
  );
});

test("a Reset key ends the old revision, its tokens and its registrations in one transaction", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const other = await f.created("desktop");
  const projectId = createIdentity("project");
  const binding = bindingOf(projectId, "general", [INSTANCE, "desktop"]);
  f.bindings.push(binding);
  const registration = await f.register(binding, record.id);
  const kept = await f.register(binding, other.record.id);
  f.asHuman();
  const before = f.commits();
  const next = await generateX25519KeyPair();
  const rotated = await f.invoke(
    "instance.rotate",
    {
      public_key: next.public_key.toString(BASE64URL),
      expected_revision: FIRST_REVISION,
    },
    { instance_name: INSTANCE },
  );
  assert.equal(f.commits(), before + 1);
  assert.equal(rotated.revision, SECOND_REVISION);
  assert.notEqual(rotated.id, record.id);
  assert.equal(f.worker().instances.liveInstance(record.id), null);
  assert.ok(f.worker().instances.liveInstance(rotated.id));
  const live = f.store
    .transaction(readAllLive)
    .map((row) => row.runtime_identity);
  assert.ok(!live.includes(registration.runtime_identity));
  assert.ok(live.includes(kept.runtime_identity));
  await f.refuses(
    () => f.invoke("instance.token", { instance_id: record.id }),
    HttpStatus.NotFound,
    WorkerErrorCode.InstanceNotFound,
  );
  await f.refuses(
    () =>
      f.invoke(
        "instance.rotate",
        { endpoint: ENDPOINT, expected_revision: FIRST_REVISION },
        { instance_name: INSTANCE },
      ),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceRevisionConflict,
  );
});

test("a failed Reset key commit keeps the old revision and its registrations", async (t) => {
  const f = instanceFixture(t);
  const { record, pair } = await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  const registration = await f.register(binding, record.id);
  f.asHuman();
  await f.refuses(
    () =>
      f.invoke(
        "instance.rotate",
        {
          public_key: pair.public_key.toString(BASE64URL),
          expected_revision: FIRST_REVISION,
        },
        { instance_name: INSTANCE },
      ),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceKeyConflict,
  );
  assert.ok(f.worker().instances.liveInstance(record.id));
  assert.ok(
    f.store
      .transaction(readAllLive)
      .some((row) => row.runtime_identity === registration.runtime_identity),
  );
});

test("archive refuses a listed or busy instance and then ends it with its registrations", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  const registration = await f.register(binding, record.id);
  f.asHuman();
  const archive = () =>
    f.invoke(
      "instance.archive",
      { expected_revision: FIRST_REVISION },
      { instance_name: INSTANCE },
    );
  await f.refuses(archive, HttpStatus.Conflict, WorkerErrorCode.InstanceInUse);
  binding.worker_instances = [];
  const executionId = createIdentity("execution");
  f.unended.set(registration.runtime_identity, executionId);
  await assert.rejects(
    archive,
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === WorkerErrorCode.InstanceInUse &&
      JSON.stringify(error.details) ===
        JSON.stringify({ executions: [executionId] }),
  );
  f.unended.clear();
  const archived = await archive();
  assert.ok(archived.ended_at);
  assert.equal(f.store.transaction(readAllLive).length, NO_ROWS);
  await f.refuses(
    archive,
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceArchived,
  );
  await f.refuses(
    () => f.created(),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceNameConflict,
  );
});

function archiveFixture(f: ReturnType<typeof instanceFixture>) {
  const archive = (force?: boolean) =>
    f.invoke(
      "instance.archive",
      force === undefined
        ? { expected_revision: FIRST_REVISION }
        : { expected_revision: FIRST_REVISION, force },
      { instance_name: INSTANCE },
    );
  const refusesWith = (task: () => Promise<unknown>, details: unknown) =>
    assert.rejects(
      task,
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === WorkerErrorCode.InstanceInUse &&
        isDeepStrictEqual(error.details, details),
    );
  return { archive, refusesWith };
}

async function busyInstance(f: ReturnType<typeof instanceFixture>) {
  const { record } = await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  const registration = await f.register(binding, record.id);
  f.asHuman();
  return { record, binding, registration };
}

test("a listing binding refuses an archive with and without force and lists the bindings", async (t) => {
  const f = instanceFixture(t);
  const { binding, registration } = await busyInstance(f);
  const { archive, refusesWith } = archiveFixture(f);
  f.unended.set(registration.runtime_identity, createIdentity("execution"));
  const details = {
    bindings: [{ project_id: binding.project_id, binding: binding.name }],
  };
  await refusesWith(() => archive(), details);
  await refusesWith(() => archive(true), details);
  assert.equal(f.revoked.length, NO_CALLS);
  assert.equal(f.reports.length, NO_CALLS);
});

test("an archive without force refuses an unlisted instance with a live execution and revokes nothing", async (t) => {
  const f = instanceFixture(t);
  const { binding, registration } = await busyInstance(f);
  const { archive, refusesWith } = archiveFixture(f);
  binding.worker_instances = [];
  const executionId = createIdentity("execution");
  f.unended.set(registration.runtime_identity, executionId);
  await refusesWith(() => archive(), { executions: [executionId] });
  await refusesWith(() => archive(false), { executions: [executionId] });
  assert.equal(f.revoked.length, NO_CALLS);
  assert.equal(f.reports.length, NO_CALLS);
});

test("an archive with force revokes the live execution, ends the instance in one transaction and reports after the commit", async (t) => {
  const f = instanceFixture(t);
  const { record, binding, registration } = await busyInstance(f);
  const { archive } = archiveFixture(f);
  binding.worker_instances = [];
  const executionId = createIdentity("execution");
  f.unended.set(registration.runtime_identity, executionId);
  const commits = f.commits();
  const archived = await archive(true);
  assert.equal(f.commits(), commits + SINGLE_CALL);
  assert.equal(archived.id, record.id);
  assert.ok(archived.ended_at);
  assert.equal(f.store.transaction(readAllLive).length, NO_ROWS);
  assert.deepEqual(f.revoked, [executionId]);
  assert.equal(f.reports.length, SINGLE_CALL);
  assert.deepEqual(f.reports[0]!.ends, ANSWERED_ENDS);
  assert.equal(f.reports[0]!.inTransaction, false);
});

test("a failure of the revocation rolls the archive back and reports nothing", async (t) => {
  const f = instanceFixture(t);
  const { record, binding, registration } = await busyInstance(f);
  const { archive } = archiveFixture(f);
  binding.worker_instances = [];
  f.unended.set(registration.runtime_identity, createIdentity("execution"));
  f.revocation.failure = new Error(REVOKE_FAILURE);
  await assert.rejects(() => archive(true), { message: REVOKE_FAILURE });
  assert.ok(f.worker().instances.liveInstance(record.id));
  assert.equal(f.store.transaction(readAllLive).length, SINGLE_CALL);
  assert.equal(f.reports.length, NO_CALLS);
});

test("an archive with force of an instance with no live execution calls neither collaboration", async (t) => {
  const f = instanceFixture(t);
  const { binding } = await busyInstance(f);
  const { archive } = archiveFixture(f);
  binding.worker_instances = [];
  const archived = await archive(true);
  assert.ok(archived.ended_at);
  assert.equal(f.revoked.length, NO_CALLS);
  assert.equal(f.reports.length, NO_CALLS);
});

test("a server restart keeps the registrations of a live instance and adopts the first valid connection", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  await f.worker().start();
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const registration = await f.register(binding, record.id);
  await f.restart();
  assert.ok(
    f.store
      .transaction(readAllLive)
      .some((row) => row.runtime_identity === registration.runtime_identity),
  );
  assert.deepEqual(await f.register(binding, record.id), registration);
  f.asWorker(record.id);
  const heartbeat = await f.invoke("instance.heartbeat", {
    connection_id: connection.connection_id,
    connection_name: CONNECTION_NAME,
  });
  assert.equal(heartbeat.server_version, packageVersion());
  assert.equal(
    f
      .worker()
      .instances.holdConnection(record.id, createIdentity("connection")),
    false,
  );
  assert.equal(
    f.worker().instances.connectionOf(record.id)?.connection_name,
    CONNECTION_NAME,
  );
});

test("a client request after a restart adopts the connection and the next heartbeat names it", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  await f.worker().start();
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  await f.restart();
  assert.equal(
    f.worker().instances.holdConnection(record.id, connection.connection_id),
    true,
  );
  f.asWorker(record.id);
  await f.invoke("instance.heartbeat", {
    connection_id: connection.connection_id,
    connection_name: CONNECTION_NAME,
  });
  assert.equal(
    f.worker().instances.connectionOf(record.id)?.connection_name,
    CONNECTION_NAME,
  );
});

test("list pages instances by name with their binding count and holder mismatch", async (t) => {
  const f = instanceFixture(t);
  await f.created("beta");
  await f.created("alpha");
  f.bindings.push(bindingOf(createIdentity("project"), "general", ["alpha"]));
  const first = await f.invoke("instance.list", null, {}, { limit: 1 });
  assert.deepEqual(
    first.items.map((item) => [
      item.name,
      item.binding_count,
      item.holder_mismatch,
    ]),
    [["alpha", 1, true]],
  );
  assert.deepEqual(f.scopes, [{ holders: ["alpha"], claimant: null }]);
  assert.ok(first.next_cursor);
  const second = await f.invoke(
    "instance.list",
    null,
    {},
    { limit: 1, cursor: first.next_cursor },
  );
  assert.deepEqual(
    second.items.map((item) => [
      item.name,
      item.binding_count,
      item.holder_mismatch,
    ]),
    [["beta", 0, false]],
  );
  assert.equal(second.next_cursor, null);
});

test("the registrations of an instance are empty for a registration with no instance", (t) => {
  const f = instanceFixture(t);
  const projectId = createIdentity("project");
  const registration = f.store.transaction((tx) =>
    insertRegistration(
      tx,
      {
        client_id: createIdentity("client_identity"),
        name: "coder-1",
        project_id: projectId,
        resource_identity: "worker:kanthord:general",
        instance_id: null,
      },
      Date.now(),
    ),
  );
  f.store.transaction((tx) =>
    insertRegistration(
      tx,
      {
        client_id: createIdentity("client_identity"),
        name: "coder-2",
        project_id: projectId,
        resource_identity: "worker:kanthord:general",
        instance_id: null,
      },
      Date.now(),
    ),
  );
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.worker().registrationsOfInstance(tx, registration.runtime_identity),
    ),
    [],
  );
});

test("an instance counts as connected only while its last heartbeat is inside the connected window", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  assert.equal(f.worker().instanceConnected(INSTANCE), false);
  f.asWorker(record.id);
  await f.invoke("instance.connect", { connection_name: CONNECTION_NAME });
  assert.equal(f.worker().instanceConnected(INSTANCE), true);
  const start = Date.now();
  t.mock.method(Date, "now", () => start + INSTANCE_CONNECTED_WINDOW_MS + 1);
  assert.equal(f.worker().instanceConnected(INSTANCE), false);
});

test("instance.get and instance.list show no connection once the last heartbeat leaves the connected window", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  f.asWorker(record.id);
  await f.invoke("instance.connect", { connection_name: CONNECTION_NAME });
  f.asHuman();
  const live = await f.invoke("instance.get", null, {
    instance_name: INSTANCE,
  });
  assert.equal(live.connection?.connection_name, CONNECTION_NAME);
  const start = Date.now();
  t.mock.method(Date, "now", () => start + INSTANCE_CONNECTED_WINDOW_MS + 1);
  const stale = await f.invoke("instance.get", null, {
    instance_name: INSTANCE,
  });
  assert.equal(stale.connection, null);
  const listed = await f.invoke("instance.list", null, {}, {});
  assert.deepEqual(
    listed.items.map((item) => [item.name, item.connection]),
    [[INSTANCE, null]],
  );
});

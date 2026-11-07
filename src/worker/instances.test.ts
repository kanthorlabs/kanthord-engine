import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { test, type TestContext } from "node:test";
import pino, { type Logger } from "pino";
import { type Dependencies, WorkerService } from "./service.ts";
import { workerMigrations } from "./migrations.ts";
import {
  alwaysAvailable,
  BindingEntryState,
  connectionPayloadSchema,
  FOOTPRINT_ORDERS_PENDING_MAX,
  INSTANCE_CONNECTED_WINDOW_MS,
  INSTANCE_CONNECTION_INFO,
  instanceConfigurationSchema,
  InstancePlacement,
  PlacementIssue,
  type PoolHost,
  SESSION_READS_PENDING_MAX,
  type SessionRead,
  SessionReadOutcome,
  StopOrderReason,
  WORKER_SERVICE_NAME,
  WORKER_TOKEN_INFO,
  type WorkerAgentView,
  type WorkerBindingsOf,
  WorkerErrorCode,
  workerOperations,
  workerTokenPayloadSchema,
} from "./contract.ts";
import { AgentErrorCode, type HolderScope } from "../agent/contract.ts";
import { InstanceCleanableKind } from "../kernel/cleanup.ts";
import type { HumanActor } from "../kernel/actor.ts";
import type { ExecutionEnds } from "../mission/contract.ts";
import type { LoginSessionEntry } from "../llm/contract.ts";
import type { HeldCopy } from "../custody/contract.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { CAPABILITY_MODEL_LIST_READ } from "../llm/platforms.ts";
import {
  SESSION_READ_WAIT_MS,
  UnreachableReason,
} from "../tracking/contract.ts";
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
  testHumanIdentity,
  testMachineIdentity,
  testWorkerIdentity,
} from "../kernel/test-identity.ts";
import { packageVersion } from "../kernel/version.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const REPORTED_AT = 1700000000000;
const WORKER = "coder@1";
const INSTANCE = "laptop";
const MACHINE = "workstation";
const ARCHIVED_MACHINE = "retired";
const UNKNOWN_MACHINE = "absent";
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
const LIVENESS_GAP_MS = 5;
const LOGIN_ENTRY: LoginSessionEntry = {
  session_id: "login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  name: "claude",
  platform: "anthropic-subscription",
  mode: "copy_code",
  code: null,
  holder: "relay-a",
};
const SINGLE_CALL = 1;
const INFO_LEVEL = 30;
const ARCHIVED_RECORD = "worker.instance.archived";
const ACTOR_NAME = "Alice";
const SHORT_SESSION_READ_WAIT_MS = 20;
const SESSION_READ_ID_PATTERN = /^session_read_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_READ: SessionRead = {
  execution_id: createIdentity("execution"),
  session_id: "0123456789abcdef",
  entry_id: "a1b2c3d4",
  entry_type: "message",
};
const RESOLVED = {
  outcome: SessionReadOutcome.Resolved,
  entry: { id: SESSION_READ.entry_id, type: SESSION_READ.entry_type },
};

function sessionReadOf(index: number): SessionRead {
  return {
    ...SESSION_READ,
    entry_id: `e${index.toString(16).padStart(7, "0")}`,
  };
}

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

const IDLE_POOL_HOST: PoolHost = {
  prepare: unexpected,
  start: unexpected,
  update: unexpected,
  restart: unexpected,
  imageOf: unexpected,
  archive: unexpected,
  sweep: unexpected,
  stop: async () => {},
  placementStatus: unexpected,
  readSessionEntry: unexpected,
  runtimeUsage: unexpected,
  runtimeStore: unexpected,
  removeImage: unexpected,
  sessionItems: unexpected,
  removeSession: unexpected,
  logItem: unexpected,
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
  sessionReadWaitMs = SESSION_READ_WAIT_MS,
  logger?: Logger,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const bindings: Binding[] = [];
  const scopes: HolderScope[] = [];
  const unended = new Map<string, string>();
  const revoked: string[] = [];
  const archivers: { instance: string; actor: HumanActor }[] = [];
  const reports: { ends: ExecutionEnds; inTransaction: boolean }[] = [];
  const revocation = {
    failure: null as Error | null,
    archiveFailure: null as Error | null,
    only: null as string | null,
  };
  const archivedHolders: string[] = [];
  const logins = new Map<string, LoginSessionEntry[]>();
  const used = new Map<string, HeldCopy[]>();
  const footprint = {
    stored: new Set<string>(),
    measured: [] as string[],
    settled: [] as string[],
    archived: [] as string[],
  };
  const dependencies: Dependencies = {
    config: { ...WORKER_CONFIG, ...config },
    store,
    ...(logger && {
      pool: { host: IDLE_POOL_HOST, workerBindingsOf: () => [], logger },
    }),
    footprint: {
      recordMeasurement: (_tx, name) => {
        footprint.measured.push(name);
      },
      recordResults: (_tx, _name, results) =>
        results
          .map((result) => result.cleanup_id)
          .filter((cleanupId) => !footprint.stored.has(cleanupId)),
      settleMeasurement: (name) => {
        footprint.settled.push(name);
      },
      instanceArchived: (_tx, name) => {
        footprint.archived.push(name);
      },
    },
    loginSessionsOf: (holder) => logins.get(holder) ?? [],
    instanceCopies: {
      archiveHeld: (_tx, holder) => {
        if (revocation.archiveFailure) throw revocation.archiveFailure;
        archivedHolders.push(holder);
      },
      heldCopies: () => [],
      usedCopies: (_tx, name) => used.get(name) ?? [],
    },
    copyHealthOf: (holder) => ({
      status: ResourceStatus.Healthy,
      capability: CAPABILITY_MODEL_LIST_READ,
      failure_reason: null,
      models: null,
      reported_at: REPORTED_AT,
      reported_by: holder,
    }),
    sessionReadWaitMs,
    missionActions: {
      authorizeRequest: unexpected,
      authorizeAction: unexpected,
      actionContextOf: unexpected,
    },
    missionPromptPins: {
      attemptPromptCommits: unexpected,
      pinPromptCommits: unexpected,
    },
    instanceArchive: {
      revokeForInstanceArchive: (_tx, executionId, instance, actor) => {
        if (
          revocation.failure &&
          (revocation.only === null || revocation.only === executionId)
        )
          throw revocation.failure;
        revoked.push(executionId);
        archivers.push({ instance, actor });
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
      lease: unexpected,
      sshSign: unexpected,
      sshPublicKeyOf: unexpected,
    },
    promptTelemetry: { agentPrompted: () => {}, promptRecordOf: unexpected },
    agentPrompt: {
      compose: unexpected,
      templates: unexpected,
      framing: unexpected,
    },
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
  const machines = new Set<string>();
  async function machine(name = MACHINE) {
    if (machines.has(name)) return name;
    await invoke("machine.create", { name });
    machines.add(name);
    return name;
  }
  async function created(name = INSTANCE) {
    const pair = await generateX25519KeyPair();
    const record = await invoke("instance.create", {
      name,
      worker: WORKER,
      placement: InstancePlacement.Worker,
      machine: await machine(),
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
  function asClient(binding: Binding) {
    caller.identity = testMachineIdentity(
      {
        clientId: createIdentity("client_identity"),
        name: INSTANCE,
        projectId: binding.project_id,
        resourceIdentity: binding.resource_identity,
        issuedAt: Date.now(),
      },
      "jti",
    );
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
    archivers,
    reports,
    revocation,
    archivedHolders,
    logins,
    used,
    footprint,
    invoke,
    refuses,
    machine,
    created,
    createdAt,
    asWorker,
    asHuman,
    asClient,
    as: (identity: CallerContext["identity"]) => {
      caller.identity = identity;
    },
    caller: () => caller.identity,
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
    machine: await f.machine(),
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
        machine: MACHINE,
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
        machine: MACHINE,
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
        machine: MACHINE,
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
        machine: MACHINE,
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
        machine: MACHINE,
        public_key: zero,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      {
        name: "other",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        machine: MACHINE,
      },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      {
        name: "other",
        worker: WORKER,
        placement: InstancePlacement.Worker,
        machine: MACHINE,
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
        machine: MACHINE,
        public_key: key,
      },
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceKeyConflict,
    ],
  ];
  for (const [body, status, code] of cases)
    await f.refuses(() => f.invoke("instance.create", body), status, code);
});

test("create at the worker placement refuses an absent, an unknown and an archived machine", async (t) => {
  const f = instanceFixture(t);
  const name = await f.machine();
  const archived = await f.machine(ARCHIVED_MACHINE);
  const key = async () =>
    (await generateX25519KeyPair()).public_key.toString(BASE64URL);
  const create = async (machine?: string) =>
    f.invoke("instance.create", {
      name: INSTANCE,
      worker: WORKER,
      placement: InstancePlacement.Worker,
      machine,
      public_key: await key(),
    });
  await f.invoke(
    "machine.archive",
    { expected_revision: FIRST_REVISION },
    { machine_name: archived },
  );
  for (const machine of [undefined, UNKNOWN_MACHINE, archived])
    await f.refuses(
      () => create(machine),
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceMachineInvalid,
    );
  assert.equal((await create(name)).machine, name);
});

test("create at a server or a container placement refuses a machine", async (t) => {
  const f = instanceFixture(t);
  const machine = await f.machine();
  for (const placement of [
    InstancePlacement.Server,
    InstancePlacement.Container,
  ])
    await f.refuses(
      () => f.createdAt(INSTANCE, placement, { machine }),
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceMachineInvalid,
    );
});

test("create stores the machine name and refuses the name of a machine", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  assert.equal(record.machine, MACHINE);
  const server = await f.createdAt("beta", InstancePlacement.Server);
  assert.equal(server.machine, null);
  const got = await f.invoke("instance.get", null, {
    instance_name: INSTANCE,
  });
  assert.equal(got.machine, MACHINE);
  await f.refuses(
    () => f.createdAt(MACHINE, InstancePlacement.Server),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceNameConflict,
  );
  await f.refuses(
    () => f.created(MACHINE),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceNameConflict,
  );
});

test("get answers the own copies and the machine copies of names with no own copy, each with its holder and the health of its holder", async (t) => {
  const f = instanceFixture(t);
  await f.created();
  const copyOf = (name: string, holder: string): HeldCopy => ({
    name,
    holder,
    revision: FIRST_REVISION,
    platform: "anthropic",
    sealed_current: true,
  });
  f.used.set(INSTANCE, [copyOf("alpha", MACHINE), copyOf("beta", INSTANCE)]);
  const got = await f.invoke("instance.get", null, { instance_name: INSTANCE });
  assert.deepEqual(
    got.credentials.map(({ name, holder, health }) => [
      name,
      holder,
      health.reported_by,
    ]),
    [
      ["alpha", MACHINE, MACHINE],
      ["beta", INSTANCE, INSTANCE],
    ],
  );
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

test("the heartbeat answers the versions and the machine, and the work version starts at the start time and rises by one", async (t) => {
  const before = Date.now();
  const f = instanceFixture(t);
  const after = Date.now();
  const { record } = await f.created();
  f.logins.set(INSTANCE, [LOGIN_ENTRY]);
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const beat = () =>
    f.invoke("instance.heartbeat", {
      connection_id: connection.connection_id,
      connection_name: CONNECTION_NAME,
    });
  const first = await beat();
  assert.deepEqual(Object.keys(first).sort(), [
    "binding_version",
    "credential_version",
    "machine",
    "server_version",
    "work_version",
  ]);
  assert.equal(first.machine, MACHINE);
  assert.ok(first.work_version >= before && first.work_version <= after);
  f.worker().raiseWorkVersion(INSTANCE);
  const raised = await beat();
  assert.equal(raised.work_version, first.work_version + FIRST_VERSION);
  assert.equal(
    f.worker().instances.workVersionOf("desktop"),
    first.work_version,
  );
});

test("the work read answers the work version and the login sessions, renews no liveness and refuses a superseded connection", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  f.logins.set(INSTANCE, [LOGIN_ENTRY]);
  f.asWorker(record.id);
  const first = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const liveness = () =>
    f.worker().instances.connectionOf(record.id)?.last_heartbeat_at;
  const renewed = liveness();
  await new Promise((resolve) => setTimeout(resolve, LIVENESS_GAP_MS));
  f.worker().raiseWorkVersion(INSTANCE);
  const work = await f.invoke("instance.work", {
    connection_id: first.connection_id,
  });
  assert.deepEqual(work, {
    work_version: f.worker().instances.workVersionOf(INSTANCE),
    login_sessions: [LOGIN_ENTRY],
    session_reads: [],
    footprint_orders: [],
    stop_orders: [],
  });
  assert.equal(liveness(), renewed);
  await f.invoke("instance.connect", {
    connection_name: OTHER_CONNECTION_NAME,
  });
  await f.refuses(
    () => f.invoke("instance.work", { connection_id: first.connection_id }),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceConnectionSuperseded,
  );
});

test("a work read after a dropped connection answers connection_superseded and adopts no connection", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  f.worker().instances.dropConnection(record.id);
  await f.refuses(
    () =>
      f.invoke("instance.work", { connection_id: connection.connection_id }),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceConnectionSuperseded,
  );
  assert.equal(f.worker().instances.connectionOf(record.id), null);
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

test("an archive with force logs worker.instance.archived with the actor and the execution ids", async (t) => {
  const lines: string[] = [];
  const f = instanceFixture(
    t,
    {},
    SESSION_READ_WAIT_MS,
    pino({ level: "info" }, { write: (line) => lines.push(line) }),
  );
  const { binding, registration } = await busyInstance(f);
  const { archive } = archiveFixture(f);
  binding.worker_instances = [];
  const executionId = createIdentity("execution");
  f.unended.set(registration.runtime_identity, executionId);
  await archive(true);
  assert.deepEqual(f.archivers, [
    {
      instance: INSTANCE,
      actor: { kind: "human", account: "alice", name: ACTOR_NAME },
    },
  ]);
  const records = lines
    .map((line) => JSON.parse(line))
    .filter((record) => record.msg === ARCHIVED_RECORD);
  assert.equal(records.length, SINGLE_CALL);
  assert.equal(records[0].level, INFO_LEVEL);
  assert.equal(records[0].instance, INSTANCE);
  assert.equal(records[0].actor, ACTOR_NAME);
  assert.equal(records[0].force, true);
  assert.deepEqual(records[0].execution_ids, [executionId]);
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

test("list answers no holder mismatch for a server and a container instance", async (t) => {
  const f = instanceFixture(t);
  await f.createdAt("beta", InstancePlacement.Server);
  await f.createdAt("gamma", InstancePlacement.Container);
  f.bindings.push(
    bindingOf(createIdentity("project"), "coder", ["beta", "gamma"]),
  );
  const page = await f.invoke("instance.list", null, {}, {});
  assert.deepEqual(
    page.items.map((item) => [
      item.name,
      item.binding_count,
      item.holder_mismatch,
    ]),
    [
      ["beta", 1, false],
      ["gamma", 1, false],
    ],
  );
  assert.deepEqual(f.scopes, []);
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

async function connectedInstance(
  f: ReturnType<typeof instanceFixture>,
  name = INSTANCE,
) {
  const { record } = await f.created(name);
  f.asWorker(record.id, name);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const work = () => {
    f.asWorker(record.id, name);
    return f.invoke("instance.work", {
      connection_id: connection.connection_id,
    });
  };
  const queue = (
    read: SessionRead,
    signal = AbortSignal.timeout(TOKEN_LIFETIME_MS),
  ) =>
    f
      .worker()
      .instances.queueSessionRead({ id: record.id, name }, read, signal);
  const report = (readId: string, body: unknown = RESOLVED) => {
    f.asWorker(record.id, name);
    return f.invoke("session_read.report", body, { read_id: readId });
  };
  return { record, work, queue, report };
}

test("the work read lists each pending session read, the work version rises at each queue and a report answers each waiter", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedInstance(f);
  const before = (await box.work()).work_version;
  const first = box.queue(SESSION_READ);
  const joined = box.queue({ ...SESSION_READ });
  const other = box.queue(sessionReadOf(1));
  const work = await box.work();
  assert.equal(work.work_version, before + SECOND_VERSION);
  assert.deepEqual(
    work.session_reads.map((listed) => ({
      execution_id: listed.execution_id,
      session_id: listed.session_id,
      entry_id: listed.entry_id,
      entry_type: listed.entry_type,
    })),
    [SESSION_READ, sessionReadOf(1)],
  );
  for (const { read_id } of work.session_reads)
    assert.match(read_id, SESSION_READ_ID_PATTERN);
  assert.equal(await box.report(work.session_reads[0]!.read_id), null);
  assert.deepEqual(await first, { result: RESOLVED });
  assert.deepEqual(await joined, { result: RESOLVED });
  await box.report(work.session_reads[1]!.read_id, {
    outcome: SessionReadOutcome.EntryAbsent,
  });
  assert.deepEqual(await other, {
    result: { outcome: SessionReadOutcome.EntryAbsent },
  });
  const after = await box.work();
  assert.deepEqual(after.session_reads, []);
  assert.equal(after.work_version, before + SECOND_VERSION);
});

test("a session read of an instance with no current connection answers offline at once and queues nothing", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const target = { id: record.id, name: INSTANCE };
  const version = f.worker().instances.workVersionOf(INSTANCE);
  assert.deepEqual(
    await f
      .worker()
      .instances.queueSessionRead(
        target,
        SESSION_READ,
        AbortSignal.timeout(TOKEN_LIFETIME_MS),
      ),
    { unreachable: UnreachableReason.Offline },
  );
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const start = Date.now();
  t.mock.method(Date, "now", () => start + INSTANCE_CONNECTED_WINDOW_MS + 1);
  assert.deepEqual(
    await f
      .worker()
      .instances.queueSessionRead(
        target,
        SESSION_READ,
        AbortSignal.timeout(TOKEN_LIFETIME_MS),
      ),
    { unreachable: UnreachableReason.Offline },
  );
  assert.equal(f.worker().instances.workVersionOf(INSTANCE), version);
  t.mock.restoreAll();
  const work = await f.invoke("instance.work", {
    connection_id: connection.connection_id,
  });
  assert.deepEqual(work.session_reads, []);
});

test("the ninth distinct pending session read answers busy and a read of a pending entry joins it", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedInstance(f);
  const waits = Array.from({ length: SESSION_READS_PENDING_MAX }, (_, index) =>
    box.queue(sessionReadOf(index)),
  );
  const version = f.worker().instances.workVersionOf(INSTANCE);
  assert.deepEqual(await box.queue(sessionReadOf(SESSION_READS_PENDING_MAX)), {
    unreachable: UnreachableReason.Busy,
  });
  const joined = box.queue(sessionReadOf(0));
  assert.equal(f.worker().instances.workVersionOf(INSTANCE), version);
  const work = await box.work();
  assert.equal(work.session_reads.length, SESSION_READS_PENDING_MAX);
  for (const { read_id } of work.session_reads) await box.report(read_id);
  for (const wait of [...waits, joined])
    assert.deepEqual(await wait, { result: RESOLVED });
});

test("no report within the session read wait answers timeout, drops the read and a later report answers not_found", async (t) => {
  const f = instanceFixture(t, {}, SHORT_SESSION_READ_WAIT_MS);
  const box = await connectedInstance(f);
  const wait = box.queue(SESSION_READ);
  const [listed] = (await box.work()).session_reads;
  assert.deepEqual(await wait, { unreachable: UnreachableReason.Timeout });
  assert.deepEqual((await box.work()).session_reads, []);
  await f.refuses(
    () => box.report(listed!.read_id),
    HttpStatus.NotFound,
    WorkerErrorCode.SessionReadNotFound,
  );
});

test("an aborted session read drops its waiter and the read", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedInstance(f);
  const controller = new AbortController();
  const wait = box.queue(SESSION_READ, controller.signal);
  controller.abort();
  await assert.rejects(wait);
  assert.deepEqual((await box.work()).session_reads, []);
});

test("a report of a session read of another instance answers not_found and keeps the read pending", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedInstance(f);
  const other = await connectedInstance(f, "desktop");
  const wait = box.queue(SESSION_READ);
  const [listed] = (await box.work()).session_reads;
  await f.refuses(
    () => other.report(listed!.read_id),
    HttpStatus.NotFound,
    WorkerErrorCode.SessionReadNotFound,
  );
  assert.deepEqual((await box.work()).session_reads, [listed]);
  await box.report(listed!.read_id);
  assert.deepEqual(await wait, { result: RESOLVED });
});

test("the session read report refuses a body outside the outcome union", () => {
  const body = workerOperations["session_read.report"].input.shape.body;
  for (const refused of [
    { outcome: SessionReadOutcome.Resolved },
    { outcome: SessionReadOutcome.Resolved, entry: RESOLVED.entry, bytes: 1 },
    { outcome: SessionReadOutcome.TooLarge },
    { outcome: SessionReadOutcome.TooLarge, bytes: 0 },
    { outcome: SessionReadOutcome.Unreadable, entry: RESOLVED.entry },
    { outcome: "changed" },
  ])
    assert.equal(
      body.safeParse(refused).success,
      false,
      JSON.stringify(refused),
    );
  for (const accepted of [
    RESOLVED,
    { outcome: SessionReadOutcome.TooLarge, bytes: 1 },
    { outcome: SessionReadOutcome.SessionAbsent },
    { outcome: SessionReadOutcome.EntryAbsent },
    { outcome: SessionReadOutcome.Unreadable },
  ])
    assert.equal(
      body.safeParse(accepted).success,
      true,
      JSON.stringify(accepted),
    );
});

const WORKSPACE_KEY = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLEANUP_HUMAN = testHumanIdentity("alice", "Alice", "jti");
const EMPTY_MEASUREMENT = { measured_at: 1, disk: null, kinds: [] };

function cleanupResult(cleanupId: string) {
  return {
    cleanup_id: cleanupId,
    removed: [WORKSPACE_KEY],
    removed_bytes: 1,
    absent: [],
    refused: [],
  };
}

async function footprintInstance(f: ReturnType<typeof instanceFixture>) {
  const { record } = await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  await f.register(binding, record.id);
  const reporter = f.caller();
  const report = (body: unknown) => {
    f.as(reporter);
    return f.invoke("footprint.report", body);
  };
  const queue = (cleanupId: string) => {
    f.as(CLEANUP_HUMAN);
    return f.invoke(
      "instance.workspace.delete",
      { cleanup_id: cleanupId, keys: [WORKSPACE_KEY] },
      { instance_name: INSTANCE },
    );
  };
  return { record, report, queue };
}

test("a queued order raises the work version once, the work read lists it and a report result drops it without a version change", async (t) => {
  const f = instanceFixture(t);
  const { record, report, queue } = await footprintInstance(f);
  const version = () => f.worker().instances.workVersionOf(INSTANCE);
  const before = version();
  const cleanupId = createIdentity("cleanup");
  assert.deepEqual(await queue(cleanupId), { queued: true });
  assert.equal(version(), before + FIRST_VERSION);
  await queue(cleanupId);
  assert.equal(version(), before + FIRST_VERSION);
  f.asWorker(record.id);
  const connection = await f.invoke("instance.connect", {
    connection_name: CONNECTION_NAME,
  });
  const work = await f.invoke("instance.work", {
    connection_id: connection.connection_id,
  });
  assert.deepEqual(work.footprint_orders, [
    {
      cleanup_id: cleanupId,
      kind: InstanceCleanableKind.Workspace,
      keys: [WORKSPACE_KEY],
    },
  ]);
  const answer = await report({
    measurement: EMPTY_MEASUREMENT,
    results: [cleanupResult(cleanupId)],
  });
  assert.deepEqual(answer, { orders: [] });
  assert.equal(version(), before + FIRST_VERSION);
  assert.deepEqual(f.worker().instances.footprintOrdersOf(record.id), []);
  assert.deepEqual(f.footprint.measured, [INSTANCE]);
  assert.deepEqual(f.footprint.settled, [INSTANCE]);
});

test("a result of an order unknown to the server and the memory answers order_unknown, and a stored order after a restart is accepted", async (t) => {
  const f = instanceFixture(t);
  const { report } = await footprintInstance(f);
  await f.refuses(
    () =>
      report({
        measurement: EMPTY_MEASUREMENT,
        results: [cleanupResult(createIdentity("cleanup"))],
      }),
    HttpStatus.NotFound,
    WorkerErrorCode.FootprintOrderUnknown,
  );
  assert.deepEqual(f.footprint.measured, []);
  assert.deepEqual(f.footprint.settled, []);
  const stored = createIdentity("cleanup");
  f.footprint.stored.add(stored);
  await f.restart();
  assert.deepEqual(
    await report({ measurement: null, results: [cleanupResult(stored)] }),
    { orders: [] },
  );
  assert.deepEqual(f.footprint.settled, []);
});

test("a footprint report from a registration with no instance answers instance_not_found", async (t) => {
  const f = instanceFixture(t);
  await f.created();
  const binding = bindingOf(createIdentity("project"), "general", [INSTANCE]);
  f.bindings.push(binding);
  f.asClient(binding);
  await f.refuses(
    () =>
      f.invoke("footprint.report", {
        measurement: EMPTY_MEASUREMENT,
        results: [],
      }),
    HttpStatus.NotFound,
    WorkerErrorCode.InstanceNotFound,
  );
  assert.deepEqual(f.footprint.measured, []);
});

test("a session delete at the worker placement queues a session order", async (t) => {
  const f = instanceFixture(t);
  const { record } = await f.created();
  const cleanupId = createIdentity("cleanup");
  const executionId = createIdentity("execution");
  f.as(CLEANUP_HUMAN);
  assert.deepEqual(
    await f.invoke(
      "instance.session.delete",
      { cleanup_id: cleanupId, execution_ids: [executionId] },
      { instance_name: INSTANCE },
    ),
    { queued: true },
  );
  assert.deepEqual(f.worker().instances.footprintOrdersOf(record.id), [
    {
      cleanup_id: cleanupId,
      kind: InstanceCleanableKind.Session,
      keys: [executionId],
    },
  ]);
});

test("an archive drops the orders of the instance and reports the archive to the footprint", async (t) => {
  const f = instanceFixture(t);
  const { record, queue } = await footprintInstance(f);
  await queue(createIdentity("cleanup"));
  f.bindings[0]!.worker_instances = [];
  f.asHuman();
  await archiveFixture(f).archive(true);
  assert.deepEqual(f.footprint.archived, [INSTANCE]);
  assert.deepEqual(f.worker().instances.footprintOrdersOf(record.id), []);
});

test("an instance holds at most FOOTPRINT_ORDERS_PENDING_MAX orders, a repeat of a held order is accepted and a new order answers orders_full", async (t) => {
  const f = instanceFixture(t);
  const { record, queue } = await footprintInstance(f);
  const held = Array.from({ length: FOOTPRINT_ORDERS_PENDING_MAX }, () =>
    createIdentity("cleanup"),
  );
  for (const cleanupId of held) await queue(cleanupId);
  assert.deepEqual(await queue(held[0]!), { queued: true });
  await f.refuses(
    () => queue(createIdentity("cleanup")),
    HttpStatus.Conflict,
    WorkerErrorCode.FootprintOrdersFull,
  );
  assert.equal(
    f.worker().instances.footprintOrdersOf(record.id).length,
    FOOTPRINT_ORDERS_PENDING_MAX,
  );
});

const STOP_REASON = "instance_archived";
const STOP_ORDER_FAILED = "worker.instance.stop_order_failed";
const SECOND_INSTANCE_NAME = "desk";
const ERROR_LEVEL = 50;

async function connectedBusy(
  f: ReturnType<typeof instanceFixture>,
  name = INSTANCE,
) {
  const { record } = await f.created(name);
  const binding = bindingOf(createIdentity("project"), `bound-${name}`, [name]);
  f.bindings.push(binding);
  const registration = await f.register(binding, record.id);
  const connectionId = createIdentity("connection");
  assert.ok(
    f
      .worker()
      .instances.holdConnection(record.id, connectionId, CONNECTION_NAME),
  );
  binding.worker_instances = [];
  const executionId = createIdentity("execution");
  f.unended.set(registration.runtime_identity, executionId);
  f.asHuman();
  const archive = (force = true) =>
    f.invoke(
      "instance.archive",
      { expected_revision: FIRST_REVISION, force },
      { instance_name: name },
    );
  const work = async () => {
    f.asWorker(record.id, name);
    const answer = await f.invoke("instance.work", {
      connection_id: connectionId,
    });
    f.asHuman();
    return answer;
  };
  const orders = () =>
    f.store.transaction((tx) =>
      f.worker().instances.stopOrdersOf(tx, record.id),
    );
  return {
    record,
    registration,
    executionId,
    archive,
    work,
    orders,
    name,
  };
}

function loggingFixture(t: TestContext) {
  const lines: string[] = [];
  const f = instanceFixture(
    t,
    {},
    SESSION_READ_WAIT_MS,
    pino({ level: "info" }, { write: (line) => lines.push(line) }),
  );
  const records = (message: string) =>
    lines
      .map((line) => JSON.parse(line))
      .filter((record) => record.msg === message);
  return { f, records };
}

test("a forced archive of a connected instance with a live execution orders the stop and ends no instance", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  const version = f.worker().instances.workVersionOf(INSTANCE);
  const archived = await box.archive();
  assert.equal(archived.ended_at, null);
  assert.deepEqual(archived.stopping, [box.executionId]);
  assert.ok(f.worker().instances.liveInstance(box.record.id));
  assert.equal(f.store.transaction(readAllLive).length, SINGLE_CALL);
  assert.equal(f.revoked.length, NO_CALLS);
  assert.equal(f.reports.length, NO_CALLS);
  assert.deepEqual(f.footprint.archived, []);
  assert.deepEqual(f.archivedHolders, []);
  assert.ok(f.worker().instances.workVersionOf(INSTANCE) > version);
  assert.deepEqual((await box.work()).stop_orders, [
    { execution_id: box.executionId, reason: STOP_REASON },
  ]);
  assert.notEqual(f.worker().instances.connectionOf(box.record.id), null);
});

test("the release of the stopped execution ends the instance with its registrations and removes the order", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  const instances = f.worker().instances;
  assert.equal(f.worker().stopOrderOf(box.executionId), STOP_REASON);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker().archiving(tx, box.registration.runtime_identity),
    ),
    true,
  );
  f.worker().executionReleased(box.executionId);
  assert.equal(instances.liveInstance(box.record.id), null);
  assert.equal(f.store.transaction(readAllLive).length, NO_ROWS);
  assert.equal(f.worker().stopOrderOf(box.executionId), null);
  assert.deepEqual(box.orders(), []);
  assert.equal(instances.connectionOf(box.record.id), null);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker().archiving(tx, box.registration.runtime_identity),
    ),
    false,
  );
  const stored = await f.invoke("instance.get", null, {
    instance_name: INSTANCE,
  });
  assert.ok(stored.ended_at);
});

test("an order past the deadline revokes with the archive stop and ends the instance", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  const instances = f.worker().instances;
  instances.sweepStopOrders();
  assert.ok(instances.liveInstance(box.record.id));
  assert.equal(f.revoked.length, NO_CALLS);
  const later = Date.now() + INSTANCE_CONNECTED_WINDOW_MS + SINGLE_CALL;
  t.mock.method(Date, "now", () => later);
  instances.sweepStopOrders();
  assert.deepEqual(f.revoked, [box.executionId]);
  assert.deepEqual(f.archivers, [
    {
      instance: INSTANCE,
      actor: { kind: "human", account: "alice", name: ACTOR_NAME },
    },
  ]);
  assert.equal(f.reports.length, SINGLE_CALL);
  assert.equal(f.reports[0]!.inTransaction, false);
  assert.equal(instances.liveInstance(box.record.id), null);
  assert.equal(f.worker().stopOrderOf(box.executionId), null);
  assert.equal(f.store.transaction(readAllLive).length, NO_ROWS);
});

test("an archive with force of a disconnected instance with a live execution revokes and ends it at once", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  f.worker().instances.dropConnection(box.record.id);
  const archived = await box.archive();
  assert.ok(archived.ended_at);
  assert.equal(archived.stopping, undefined);
  assert.deepEqual(f.revoked, [box.executionId]);
  assert.equal(f.store.transaction(readAllLive).length, NO_ROWS);
  assert.deepEqual(box.orders(), []);
});

test("a repeated archive answers the same stopping list and keeps one pending archive and one order", async (t) => {
  const { f, records } = loggingFixture(t);
  const box = await connectedBusy(f);
  const first = await box.archive();
  const version = f.worker().instances.workVersionOf(INSTANCE);
  const second = await box.archive();
  assert.deepEqual(second, first);
  assert.equal(f.worker().instances.workVersionOf(INSTANCE), version);
  assert.equal(box.orders().length, SINGLE_CALL);
  assert.equal(f.revoked.length, NO_CALLS);
  f.worker().executionReleased(box.executionId);
  assert.equal(records(ARCHIVED_RECORD).length, SINGLE_CALL);
});

test("the first archive transaction ends no instance and the deferred end runs each archive step once and logs the stored actor", async (t) => {
  const { f, records } = loggingFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  assert.deepEqual(f.footprint.archived, []);
  assert.deepEqual(f.archivedHolders, []);
  assert.equal(records(ARCHIVED_RECORD).length, NO_CALLS);
  f.asWorker(box.record.id);
  f.worker().executionReleased(box.executionId);
  assert.deepEqual(f.footprint.archived, [INSTANCE]);
  assert.deepEqual(f.archivedHolders, [INSTANCE]);
  const logged = records(ARCHIVED_RECORD);
  assert.equal(logged.length, SINGLE_CALL);
  assert.equal(logged[0].level, INFO_LEVEL);
  assert.equal(logged[0].instance, INSTANCE);
  assert.equal(logged[0].actor, ACTOR_NAME);
  assert.equal(logged[0].force, true);
  assert.deepEqual(logged[0].execution_ids, [box.executionId]);
});

test("a rotate during a pending archive refuses with in_use and the stopping list", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  const pair = await generateX25519KeyPair();
  await assert.rejects(
    () =>
      f.invoke(
        "instance.rotate",
        {
          public_key: pair.public_key.toString(BASE64URL),
          expected_revision: FIRST_REVISION,
        },
        { instance_name: INSTANCE },
      ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === WorkerErrorCode.InstanceInUse &&
      isDeepStrictEqual(error.details, { stopping: [box.executionId] }),
  );
  assert.ok(f.worker().instances.liveInstance(box.record.id));
});

test("the deferred end drops the heartbeat entries and calls instanceEnded after its commit", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  const changed: boolean[] = [];
  t.mock.method(f.worker(), "instancesChanged", () => {
    changed.push(f.store.database.isTransaction);
  });
  assert.ok(
    f
      .worker()
      .heartbeatClock.identities()
      .includes(box.registration.runtime_identity),
  );
  f.worker().executionReleased(box.executionId);
  assert.deepEqual(changed, [false]);
  assert.equal(
    f
      .worker()
      .heartbeatClock.identities()
      .includes(box.registration.runtime_identity),
    false,
  );
});

test("the order timer logs the error of one order and still handles the next order", async (t) => {
  const { f, records } = loggingFixture(t);
  const first = await connectedBusy(f);
  const second = await connectedBusy(f, SECOND_INSTANCE_NAME);
  await first.archive();
  await second.archive();
  f.revocation.failure = new Error(REVOKE_FAILURE);
  f.revocation.only = first.executionId;
  const later = Date.now() + INSTANCE_CONNECTED_WINDOW_MS + SINGLE_CALL;
  t.mock.method(Date, "now", () => later);
  f.worker().instances.sweepStopOrders();
  const failed = records(STOP_ORDER_FAILED);
  assert.equal(failed.length, SINGLE_CALL);
  assert.equal(failed[0].level, ERROR_LEVEL);
  assert.equal(failed[0].execution_id, first.executionId);
  assert.equal(f.worker().stopOrderOf(first.executionId), STOP_REASON);
  assert.ok(f.worker().instances.liveInstance(first.record.id));
  assert.equal(f.worker().instances.liveInstance(second.record.id), null);
  assert.deepEqual(f.revoked, [second.executionId]);
});

test("a second order for an execution keeps the first reason and a pending archive ends when that execution releases", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  const paused = StopOrderReason.WorkerStopped;
  f.worker().instances.queueStopOrder(
    { name: INSTANCE },
    {
      execution_id: box.executionId,
      runtime_identity: box.registration.runtime_identity,
      reason: paused,
    },
  );
  const archived = await box.archive();
  assert.deepEqual(archived.stopping, [box.executionId]);
  assert.deepEqual(box.orders(), [
    { execution_id: box.executionId, reason: paused },
  ]);
  f.worker().executionReleased(box.executionId);
  assert.equal(f.worker().instances.liveInstance(box.record.id), null);
  assert.equal(f.worker().stopOrderOf(box.executionId), null);
});

test("the archive keeps the connection while stopping is not empty and drops it when the instance ends", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  assert.notEqual(f.worker().instances.connectionOf(box.record.id), null);
  await box.archive();
  assert.notEqual(f.worker().instances.connectionOf(box.record.id), null);
  f.worker().executionReleased(box.executionId);
  assert.equal(f.worker().instances.connectionOf(box.record.id), null);
});

test("the order timer retries a deferred end that failed and left an empty stopping list", async (t) => {
  const f = instanceFixture(t);
  const box = await connectedBusy(f);
  await box.archive();
  f.revocation.archiveFailure = new Error(REVOKE_FAILURE);
  assert.throws(() => f.worker().executionReleased(box.executionId), {
    message: REVOKE_FAILURE,
  });
  assert.ok(f.worker().instances.liveInstance(box.record.id));
  assert.equal(
    f.store.transaction((tx) =>
      f.worker().archiving(tx, box.registration.runtime_identity),
    ),
    true,
  );
  f.revocation.archiveFailure = null;
  f.worker().instances.sweepStopOrders();
  assert.equal(f.worker().instances.liveInstance(box.record.id), null);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker().archiving(tx, box.registration.runtime_identity),
    ),
    false,
  );
});

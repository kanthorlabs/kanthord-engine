import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { WorkerService, type Dependencies } from "./service.ts";
import { workerMigrations } from "./migrations.ts";
import {
  BindingEntryState,
  INSTANCE_CONNECTION_INFO,
  InstancePlacement,
  WORKER_SERVICE_NAME,
  WORKER_TOKEN_INFO,
  WorkerErrorCode,
  connectionPayloadSchema,
  instanceConfigurationSchema,
  workerOperations,
  workerTokenPayloadSchema,
  type WorkerBindingsOf,
} from "./contract.ts";
import { readAllLive, readRow } from "./registration-rows.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
} from "../kernel/hpke.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { background } from "../kernel/context.ts";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
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
  server_slot_limit: 16,
  container_image: "docker.io/kanthorlabs/kanthord",
};

type Binding = ReturnType<WorkerBindingsOf>[number];

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
    placement: InstancePlacement.Worker,
    generation: 1,
    resource_budget: null,
    entries: [],
    tombstone: false,
    worker_instances: instances,
  } satisfies Binding;
}

function instanceFixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const bindings: Binding[] = [];
  const unended = new Map<string, string>();
  const dependencies: Dependencies = {
    config: WORKER_CONFIG,
    store,
    missionActions: {
      authorizeRequest: unexpected,
      authorizeAction: unexpected,
      actionContextOf: unexpected,
    },
    intakeActions: { perform: unexpected, read: unexpected },
    evidenceRequests: { request: unexpected },
    custodyHandover: { handover: unexpected, report: unexpected },
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
    workerBindingRowOf: unexpected,
    repositoryPolicyOf: unexpected,
    repositoryBindingIdsOf: unexpected,
    intentOf: unexpected,
    pinnedCredentialMetadata: unexpected,
    credentialMetadata: unexpected,
    sshHostKeysOf: unexpected,
    schedulerClaims: {
      agentSelectionsOf: () => [],
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
      agentView: unexpected,
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
      public_key: pair.public_key.toString(BASE64URL),
    });
    return { record, pair };
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
    unended,
    invoke,
    refuses,
    created,
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
      { name: INSTANCE, worker: WORKER, public_key: other },
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceNameConflict,
    ],
    [
      { name: "token", worker: WORKER, public_key: other },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceNameInvalid,
    ],
    [
      { name: "Upper", worker: WORKER, public_key: other },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceNameInvalid,
    ],
    [
      { name: "other", worker: "absent@1", public_key: other },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceWorkerInvalid,
    ],
    [
      { name: "other", worker: WORKER, public_key: zero },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      { name: "other", worker: WORKER },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      { name: "other", worker: WORKER, public_key: other, endpoint: ENDPOINT },
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceKeyInvalid,
    ],
    [
      { name: "other", worker: WORKER, public_key: key },
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceKeyConflict,
    ],
  ];
  for (const [body, status, code] of cases)
    await f.refuses(() => f.invoke("instance.create", body), status, code);
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
      f.invoke("instance.heartbeat", { connection_id: first.connection_id }),
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
  });
  assert.equal(listed.binding_version, FIRST_VERSION);
  f.bindings[0]!.worker_instances = [];
  f.worker().bindingsChanged(projectId);
  const dropped = await f.invoke("instance.heartbeat", {
    connection_id: connection.connection_id,
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
  });
  assert.equal(heartbeat.server_version, packageVersion());
  assert.equal(
    f
      .worker()
      .instances.holdConnection(record.id, createIdentity("connection")),
    false,
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

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { type Dependencies, WorkerService } from "./service.ts";
import { workerMigrations } from "./migrations.ts";
import {
  INSTANCE_CONNECTED_WINDOW_MS,
  InstancePlacement,
  machineConfigurationSchema,
  machineOperations,
  WORKER_SERVICE_NAME,
  WorkerErrorCode,
  workerOperations,
} from "./contract.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
  sealJSON,
} from "../kernel/hpke.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { background } from "../kernel/context.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  testHumanIdentity,
  testWorkerIdentity,
} from "../kernel/test-identity.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const WORKER = "coder@1";
const MACHINE = "workstation";
const OTHER_MACHINE = "build-box";
const INSTANCE = "laptop";
const SECOND_INSTANCE = "desktop";
const THIRD_INSTANCE = "tablet";
const OTHER_INSTANCE = "other";
const CONNECTION_NAME = "host-a";
const ACCOUNT = "alice";
const ACCOUNT_NAME = "Alice";
const JTI = "jti";
const BASE64URL = "base64url";
const UTF8 = "utf8";
const SEAL_INFO = "kanthord/test/machine";
const SEAL_AAD = "machine";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const TWO_INSTANCES = 2;
const THIRD_REVISION = 3;
const NO_ROWS = 0;
const NO_INSTANCES = 0;
const PAGE_SIZE = 1;
const SHORT_KEY_BYTES = 16;
const LATER_HEARTBEAT_MS = 1000;
const WORKER_CONFIG = {
  heartbeat_window: 300,
  server_instance_limit: 16,
  container_image: "docker.io/kanthorlabs/kanthord",
};

function unexpected(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

function machineFixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const archivedHolders: string[] = [];
  const dependencies: Dependencies = {
    config: WORKER_CONFIG,
    store,
    footprint: {
      recordMeasurement: unexpected,
      recordResults: unexpected,
      settleMeasurement: unexpected,
      instanceArchived: () => {},
    },
    loginSessionsOf: () => [],
    sessionReadWaitMs: LATER_HEARTBEAT_MS,
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
      revokeForInstanceArchive: unexpected,
      reportExecutionEnds: unexpected,
    },
    instanceCopies: {
      archiveHeld: (_tx, holder) => {
        archivedHolders.push(holder);
      },
      heldCopies: () => [],
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
    workerBindingOf: () => null,
    workerBindingsOf: () => [],
    instanceIssuer: {
      workerToken: unexpected,
      clientToken: unexpected,
      clientIdentity: unexpected,
      clientSecret: unexpected,
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
      unendedExecutionOf: () => null,
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
  const worker = new WorkerService(dependencies);
  const registry = new OperationRegistry();
  worker.declare(registry);
  const caller: CallerContext = {
    identity: testHumanIdentity(ACCOUNT, ACCOUNT_NAME, JTI),
    context: background,
    requestId: "request",
    commit: (fn) => store.transaction(fn),
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
  async function createdMachine(name = MACHINE) {
    const pair = await generateX25519KeyPair();
    const record = await invoke("machine.create", {
      name,
      public_key: pair.public_key.toString(BASE64URL),
    });
    return { record, pair };
  }
  async function createdInstance(name: string, machine = MACHINE) {
    const pair = await generateX25519KeyPair();
    const record = await invoke("instance.create", {
      name,
      worker: WORKER,
      placement: InstancePlacement.Worker,
      machine,
      public_key: pair.public_key.toString(BASE64URL),
    });
    return { record, pair };
  }
  async function connect(instanceId: string, name: string) {
    caller.identity = testWorkerIdentity(instanceId, name, JTI);
    const connection = await invoke("instance.connect", {
      connection_name: CONNECTION_NAME,
    });
    caller.identity = testHumanIdentity(ACCOUNT, ACCOUNT_NAME, JTI);
    return connection;
  }
  async function heartbeat(
    instanceId: string,
    name: string,
    connectionId: string,
  ) {
    caller.identity = testWorkerIdentity(instanceId, name, JTI);
    await invoke("instance.heartbeat", {
      connection_id: connectionId,
      connection_name: CONNECTION_NAME,
    });
    caller.identity = testHumanIdentity(ACCOUNT, ACCOUNT_NAME, JTI);
  }
  return {
    store,
    worker,
    archivedHolders,
    invoke,
    refuses,
    createdMachine,
    createdInstance,
    connect,
    heartbeat,
  };
}

test("the secret mutations of the machine key carry the no-store header of a secret operation", () => {
  assert.ok(machineOperations["machine.create"].secret);
  assert.ok(machineOperations["machine.rotate"].secret);
});

test("create stores a public key and answers no machine configuration", async (t) => {
  const f = machineFixture(t);
  const { record, pair } = await f.createdMachine();
  assert.ok(record.id.startsWith("worker_machine_"));
  assert.equal(record.name, MACHINE);
  assert.equal(record.revision, FIRST_REVISION);
  assert.equal(record.public_key, pair.public_key.toString(BASE64URL));
  assert.equal(record.fingerprint, keyFingerprint(pair.public_key));
  assert.equal(record.ended_at, null);
  assert.ok(!("machine_configuration" in record));
});

test("create without a public key answers a machine configuration of the generated key once", async (t) => {
  const f = machineFixture(t);
  const record = await f.invoke("machine.create", { name: MACHINE });
  assert.ok(record.machine_configuration);
  assert.doesNotMatch(record.machine_configuration, /[=+/]/);
  const configuration = machineConfigurationSchema.parse(
    JSON.parse(
      Buffer.from(record.machine_configuration, BASE64URL).toString(UTF8),
    ),
  );
  assert.deepEqual(Object.keys(configuration), ["name", "private_key"]);
  assert.equal(configuration.name, MACHINE);
  const sealed = await sealJSON(
    Buffer.from(record.public_key, BASE64URL),
    SEAL_INFO,
    SEAL_AAD,
    { name: MACHINE },
  );
  assert.deepEqual(
    await openJSON(
      Buffer.from(configuration.private_key, BASE64URL),
      SEAL_INFO,
      SEAL_AAD,
      sealed,
    ),
    { name: MACHINE },
  );
  const read = await f.invoke("machine.get", null, { machine_name: MACHINE });
  assert.ok(!("machine_configuration" in read));
});

test("create refuses a bad name and a bad key with their codes", async (t) => {
  const f = machineFixture(t);
  const key = (await generateX25519KeyPair()).public_key.toString(BASE64URL);
  const cases: [Record<string, unknown>, string][] = [
    [{ name: "token", public_key: key }, WorkerErrorCode.MachineNameInvalid],
    [{ name: "Upper", public_key: key }, WorkerErrorCode.MachineNameInvalid],
    [
      { name: MACHINE, public_key: "not base64url!" },
      WorkerErrorCode.MachineKeyInvalid,
    ],
    [
      {
        name: MACHINE,
        public_key: Buffer.alloc(SHORT_KEY_BYTES).toString(BASE64URL),
      },
      WorkerErrorCode.MachineKeyInvalid,
    ],
  ];
  for (const [body, code] of cases)
    await f.refuses(
      () => f.invoke("machine.create", body),
      HttpStatus.BadRequest,
      code,
    );
});

test("create refuses a name of a live or an archived machine or instance", async (t) => {
  const f = machineFixture(t);
  const { record } = await f.createdMachine();
  await f.createdInstance(INSTANCE);
  await f.refuses(
    () => f.invoke("machine.create", { name: MACHINE }),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineNameConflict,
  );
  await f.refuses(
    () => f.invoke("machine.create", { name: INSTANCE }),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineNameConflict,
  );
  await f.invoke(
    "instance.archive",
    { expected_revision: FIRST_REVISION },
    { instance_name: INSTANCE },
  );
  await f.refuses(
    () => f.invoke("machine.create", { name: INSTANCE }),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineNameConflict,
  );
  await f.invoke(
    "machine.archive",
    { expected_revision: record.revision },
    { machine_name: MACHINE },
  );
  await f.refuses(
    () => f.invoke("machine.create", { name: MACHINE }),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineNameConflict,
  );
});

test("an instance create refuses the name of a machine", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  await f.refuses(
    () => f.createdInstance(MACHINE),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceNameConflict,
  );
});

test("create refuses a key that a machine or an instance revision holds", async (t) => {
  const f = machineFixture(t);
  const { pair } = await f.createdMachine();
  const instance = await f.createdInstance(INSTANCE);
  const create = (name: string, key: Buffer) => () =>
    f.invoke("machine.create", {
      name,
      public_key: key.toString(BASE64URL),
    });
  await f.refuses(
    create(OTHER_MACHINE, pair.public_key),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineKeyConflict,
  );
  await f.refuses(
    create(OTHER_MACHINE, instance.pair.public_key),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineKeyConflict,
  );
  await f.refuses(
    () =>
      f.invoke("instance.create", {
        name: SECOND_INSTANCE,
        worker: WORKER,
        placement: InstancePlacement.Worker,
        machine: MACHINE,
        public_key: pair.public_key.toString(BASE64URL),
      }),
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceKeyConflict,
  );
});

test("an instance stores the machine name and keeps it across a key reset", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  const { record } = await f.createdInstance(INSTANCE);
  assert.equal(record.machine, MACHINE);
  const next = await generateX25519KeyPair();
  const rotated = await f.invoke(
    "instance.rotate",
    {
      expected_revision: FIRST_REVISION,
      public_key: next.public_key.toString(BASE64URL),
    },
    { instance_name: INSTANCE },
  );
  assert.equal(rotated.machine, MACHINE);
  const server = await f.invoke("instance.create", {
    name: SECOND_INSTANCE,
    worker: WORKER,
    placement: InstancePlacement.Server,
  });
  assert.equal(server.machine, null);
});

test("list pages machines by name with the count of live instances", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine(MACHINE);
  await f.createdMachine(OTHER_MACHINE);
  await f.createdInstance(INSTANCE);
  await f.createdInstance(SECOND_INSTANCE);
  const first = await f.invoke("machine.list", null, {}, { limit: PAGE_SIZE });
  assert.deepEqual(
    first.items.map((item) => [item.name, item.instance_count]),
    [[OTHER_MACHINE, NO_INSTANCES]],
  );
  assert.ok(first.next_cursor);
  const second = await f.invoke(
    "machine.list",
    null,
    {},
    { limit: PAGE_SIZE, cursor: first.next_cursor },
  );
  assert.deepEqual(
    second.items.map((item) => [item.name, item.instance_count]),
    [[MACHINE, TWO_INSTANCES]],
  );
  assert.equal(second.next_cursor, null);
});

test("get answers the live instances with their connection and refuses an unknown name", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  const first = await f.createdInstance(INSTANCE);
  await f.createdInstance(SECOND_INSTANCE);
  await f.createdInstance(THIRD_INSTANCE, MACHINE);
  await f.connect(first.record.id, INSTANCE);
  const read = await f.invoke("machine.get", null, { machine_name: MACHINE });
  assert.equal(read.name, MACHINE);
  assert.deepEqual(
    read.instances.map((instance) => instance.name),
    [SECOND_INSTANCE, INSTANCE, THIRD_INSTANCE],
  );
  assert.equal(
    read.instances.find((instance) => instance.name === INSTANCE)?.connection
      ?.connection_name,
    CONNECTION_NAME,
  );
  assert.equal(
    read.instances.find((instance) => instance.name === SECOND_INSTANCE)
      ?.connection,
    null,
  );
  await f.refuses(
    () => f.invoke("machine.get", null, { machine_name: OTHER_MACHINE }),
    HttpStatus.NotFound,
    WorkerErrorCode.MachineNotFound,
  );
});

test("rotate ends the live revision, stores the next key and answers a generated configuration", async (t) => {
  const f = machineFixture(t);
  const { record } = await f.createdMachine();
  const next = await generateX25519KeyPair();
  const rotated = await f.invoke(
    "machine.rotate",
    {
      expected_revision: FIRST_REVISION,
      public_key: next.public_key.toString(BASE64URL),
    },
    { machine_name: MACHINE },
  );
  assert.equal(rotated.revision, SECOND_REVISION);
  assert.equal(rotated.public_key, next.public_key.toString(BASE64URL));
  assert.ok(!("machine_configuration" in rotated));
  const generated = await f.invoke(
    "machine.rotate",
    { expected_revision: SECOND_REVISION },
    { machine_name: MACHINE },
  );
  assert.equal(generated.revision, THIRD_REVISION);
  assert.ok(generated.machine_configuration);
  const ended = f.store.database
    .prepare("SELECT revision FROM worker_machine WHERE ended_at IS NOT NULL")
    .all()
    .map((row) => row.revision);
  assert.deepEqual(ended, [record.revision, SECOND_REVISION]);
});

test("rotate refuses a stale revision, an archived machine, an unknown name and a held key", async (t) => {
  const f = machineFixture(t);
  const { pair } = await f.createdMachine();
  await assert.rejects(
    () =>
      f.invoke(
        "machine.rotate",
        { expected_revision: SECOND_REVISION },
        { machine_name: MACHINE },
      ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === WorkerErrorCode.MachineRevisionConflict &&
      JSON.stringify(error.details) ===
        JSON.stringify({ revision: FIRST_REVISION }),
  );
  await f.refuses(
    () =>
      f.invoke(
        "machine.rotate",
        {
          expected_revision: FIRST_REVISION,
          public_key: pair.public_key.toString(BASE64URL),
        },
        { machine_name: MACHINE },
      ),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineKeyConflict,
  );
  await f.refuses(
    () =>
      f.invoke(
        "machine.rotate",
        { expected_revision: FIRST_REVISION },
        { machine_name: OTHER_MACHINE },
      ),
    HttpStatus.NotFound,
    WorkerErrorCode.MachineNotFound,
  );
  await f.invoke(
    "machine.archive",
    { expected_revision: FIRST_REVISION },
    { machine_name: MACHINE },
  );
  await f.refuses(
    () =>
      f.invoke(
        "machine.rotate",
        { expected_revision: FIRST_REVISION },
        { machine_name: MACHINE },
      ),
    HttpStatus.Conflict,
    WorkerErrorCode.MachineArchived,
  );
});

test("archive refuses while a live instance names the machine and lists the instances", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  await f.createdInstance(SECOND_INSTANCE);
  await f.createdInstance(INSTANCE);
  const archive = () =>
    f.invoke(
      "machine.archive",
      { expected_revision: FIRST_REVISION },
      { machine_name: MACHINE },
    );
  await assert.rejects(
    archive,
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === WorkerErrorCode.MachineInUse &&
      JSON.stringify(error.details) ===
        JSON.stringify({ instances: [SECOND_INSTANCE, INSTANCE] }),
  );
  assert.deepEqual(f.archivedHolders, []);
  for (const name of [INSTANCE, SECOND_INSTANCE])
    await f.invoke(
      "instance.archive",
      { expected_revision: FIRST_REVISION },
      { instance_name: name },
    );
  const archived = await archive();
  assert.ok(archived.ended_at);
});

test("archive calls archiveHeld with the machine name and refuses a second archive", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  const archive = () =>
    f.invoke(
      "machine.archive",
      { expected_revision: FIRST_REVISION },
      { machine_name: MACHINE },
    );
  await archive();
  assert.deepEqual(f.archivedHolders, [MACHINE]);
  await f.refuses(
    archive,
    HttpStatus.Conflict,
    WorkerErrorCode.MachineArchived,
  );
  const listed = await f.invoke("machine.list");
  assert.equal(listed.items.length, NO_ROWS);
});

test("machineKeyOf answers the current key after a rotate and null after an archive", async (t) => {
  const f = machineFixture(t);
  const { record, pair } = await f.createdMachine();
  const keyOf = () =>
    f.store.transaction((tx) => f.worker.machineKeyOf(tx, MACHINE));
  assert.deepEqual(keyOf(), {
    name: MACHINE,
    public_key: pair.public_key.toString(BASE64URL),
    fingerprint: record.fingerprint,
  });
  const next = await generateX25519KeyPair();
  await f.invoke(
    "machine.rotate",
    {
      expected_revision: FIRST_REVISION,
      public_key: next.public_key.toString(BASE64URL),
    },
    { machine_name: MACHINE },
  );
  assert.deepEqual(keyOf(), {
    name: MACHINE,
    public_key: next.public_key.toString(BASE64URL),
    fingerprint: keyFingerprint(next.public_key),
  });
  await f.invoke(
    "machine.archive",
    { expected_revision: SECOND_REVISION },
    { machine_name: MACHINE },
  );
  assert.equal(keyOf(), null);
  assert.equal(
    f.store.transaction((tx) => f.worker.machineKeyOf(tx, OTHER_MACHINE)),
    null,
  );
});

test("machineOf answers the machine of a worker instance and null elsewhere", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  await f.createdInstance(INSTANCE);
  await f.invoke("instance.create", {
    name: SECOND_INSTANCE,
    worker: WORKER,
    placement: InstancePlacement.Server,
  });
  const machineOf = (name: string) =>
    f.store.transaction((tx) => f.worker.machineOf(tx, name));
  assert.equal(machineOf(INSTANCE), MACHINE);
  assert.equal(machineOf(SECOND_INSTANCE), null);
  assert.equal(machineOf(THIRD_INSTANCE), null);
});

test("connectedInstancesOf orders by the newest heartbeat then by name and skips a stale heartbeat", async (t) => {
  const f = machineFixture(t);
  await f.createdMachine();
  await f.createdMachine(OTHER_MACHINE);
  const start = Date.now();
  const clock = t.mock.method(Date, "now", () => start);
  const connected = (machine = MACHINE) =>
    f.worker.connectedInstancesOf(machine).map((instance) => instance.name);
  const stale = await f.createdInstance(THIRD_INSTANCE);
  await f.connect(stale.record.id, THIRD_INSTANCE);
  clock.mock.mockImplementation(() => start + INSTANCE_CONNECTED_WINDOW_MS);
  const newest = await f.createdInstance(INSTANCE);
  const tied = await f.createdInstance(SECOND_INSTANCE);
  const elsewhere = await f.createdInstance(OTHER_INSTANCE, OTHER_MACHINE);
  const connection = await f.connect(newest.record.id, INSTANCE);
  await f.connect(tied.record.id, SECOND_INSTANCE);
  await f.connect(elsewhere.record.id, OTHER_INSTANCE);
  assert.deepEqual(connected(), [SECOND_INSTANCE, INSTANCE, THIRD_INSTANCE]);
  assert.deepEqual(connected(OTHER_MACHINE), [OTHER_INSTANCE]);
  clock.mock.mockImplementation(
    () => start + INSTANCE_CONNECTED_WINDOW_MS + LATER_HEARTBEAT_MS,
  );
  await f.heartbeat(newest.record.id, INSTANCE, connection.connection_id);
  assert.deepEqual(connected(), [INSTANCE, SECOND_INSTANCE]);
  clock.mock.mockImplementation(
    () =>
      start +
      INSTANCE_CONNECTED_WINDOW_MS +
      LATER_HEARTBEAT_MS +
      INSTANCE_CONNECTED_WINDOW_MS +
      1,
  );
  assert.deepEqual(connected(), []);
});

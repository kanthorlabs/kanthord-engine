import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WorkerService, type Dependencies } from "./service.ts";
import { ActionPerformer } from "./action-performer.ts";
import {
  workerOperations,
  ACTION_REQUEST_TOOL_NAME,
  WorkerErrorCode,
  WORKER_SERVICE_NAME,
  LIST_LIMIT_DEFAULT,
  AGENT_PROVIDER_CAPABILITY,
  AGENT_PROVIDER_TARGET_KIND,
  REGISTRATION_CAPABILITY,
  InstanceActivity,
  WorkerHost,
  WorkerMethod,
  type AgentDependentBinding,
  type WorkerEntry,
  type WorkerBindingOf,
} from "./contract.ts";
import { workerMigrations } from "./migrations.ts";
import {
  AgentProviderKind,
  EnablementState,
  insertEnablementRevision,
  getLatestRevision,
} from "./enablements.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import {
  HealthRegistry,
  HealthScope,
  ResourceStatus,
} from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  endRegistration,
  readAllLive,
  readRow,
  reopenRegistration,
} from "./instances.ts";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "./heartbeat.ts";

const fakeCollaborations = {
  missionActions: {
    actionContextOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  intakeActions: {
    perform: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    read: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  evidenceRequests: {
    request: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  custodyHandover: {
    handover: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    report: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  workerBindingOf: () => ({
    bindingId: "binding",
    revision: 1,
    workerName: "claude@1",
    instanceCount: 1,
    resourceBudget: null,
    entries: [],
    tombstone: false,
  }),
  schedulerClaims: {
    requireRunning: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    runningExecutionOfRuntime: () => null,
    activityOf: () => ({ activity: InstanceActivity.Idle, executionId: null }),
  },
  custodySuitability: () => {},
  credentialMetadata: () => null,
  entriesOfAgent: () => [],
  modelListCheck: () => async () => ResourceStatus.Unknown,
};
const WORKER_CONFIG = { heartbeatWindow: 300, globalPrompt: "" };

test("action handler forwards only the proved claim and caller before its commit", async (t) => {
  const f = enablementFixture(t);
  const execution = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "harness",
      resourceIdentity: "worker:kanthord:harness",
      projectId: execution.projectId,
      issuedAt: 1,
    },
    "jwt",
    execution.runtimeIdentity,
  );
  const answer = { toolName: ACTION_REQUEST_TOOL_NAME, items: [] };
  const perform = t.mock.method(
    ActionPerformer.prototype,
    "perform",
    async () => {
      const noCommits = 0;
      assert.equal(f.commits(), noCommits);
      return answer;
    },
  );
  const result = await f.registry
    .get(workerOperations["action.request"].id)
    .handler(
      {
        params: { executionId: createIdentity("execution") },
        query: {},
        body: null,
      },
      { ...f.caller, identity, execution },
    );
  assert.equal(result, answer);
  assert.deepEqual(perform.mock.calls[0]?.arguments, [
    { context: f.caller.context, identity },
    execution,
  ]);
  const oneCommit = 1;
  assert.equal(f.commits(), oneCommit);
});

const client = {
  clientId: "client",
  name: "worker",
  resourceIdentity: "worker:kanthord:binding",
  projectId: "project",
};

test("Worker owns registrations, declares its handler, and joins lifecycle calls", async (t) => {
  const health = new HealthRegistry();
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const worker = new WorkerService({
    config: WORKER_CONFIG,
    store,
    health,
    ...fakeCollaborations,
  });
  const registry = new OperationRegistry();
  worker.declare(registry);
  assert.equal(
    registry.get(workerOperations.register.id).operation.service,
    workerOperations.register.service,
  );
  assert.equal(
    (await worker.healthcheck()).registrations,
    HealthStatus.Unavailable,
  );
  const starting = worker.start();
  assert.equal(starting, worker.start());
  assert.equal(await starting, null);
  assert.deepEqual(await health.check(), {
    worker: { registrations: HealthStatus.Healthy },
  });
  try {
    const registration = store.transaction((transaction) =>
      worker.registrations.register(transaction, client, Date.now()),
    );
    assert.deepEqual(
      worker.registrations.findByClient(client.clientId),
      registration,
    );
    assert.deepEqual(
      store.transaction((transaction) =>
        worker.registrations.register(transaction, client, Date.now()),
      ),
      registration,
    );
    store.transaction((tx) =>
      endRegistration(tx, registration.runtimeIdentity, Date.now()),
    );
    assert.equal(worker.registrations.findByClient(client.clientId), undefined);
    const next = store.transaction((transaction) =>
      worker.registrations.register(transaction, client, Date.now()),
    );
    assert.notEqual(next.runtimeIdentity, registration.runtimeIdentity);
  } finally {
    assert.equal(await worker.stop(), null);
  }
  assert.equal(worker.stop(), worker.stop());
  assert.equal(
    (await worker.healthcheck()).registrations,
    HealthStatus.Unavailable,
  );
  assert.ok((await worker.start()) instanceof Error);
});

test("Worker run joins cancellation before and after startup", async (t) => {
  for (const before of [true, false]) {
    const { worker } = enablementFixture(t);
    const context = new CancellationContext();
    if (before) context.cancel();
    const running = worker.run(context);
    if (!before) context.cancel();
    assert.equal(await running, context.err());
    assert.equal(await worker.stop(), null);
  }
});

const AGENT = "swe@1";
const OTHER_AGENT = "re@1";
const WORKER = "general@1";
const EXTERNAL_HARNESS = "claude-code";
const MODEL = "claude-sonnet-4-5";
const MISSING_MODEL = "claude-3-5-sonnet-20241022";
const UNKNOWN = "unknown";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const ADD_PROVIDER = "agent.enablement.provider.add";
const REMOVE_PROVIDER = "agent.enablement.provider.remove";
const provider = {
  name: "primary",
  provider: AgentProviderKind.Anthropic,
  credential: "anthropic",
};
const spare = { ...provider, name: "spare" };
const defaults = {
  agentProvider: provider.name,
  modelIdentifier: MODEL,
  reasoningEffort: "off",
};
const putBody = { agentProviders: [provider], defaultConfiguration: defaults };
const binding = { bindingId: "binding", workerName: WORKER, entry: null };

test("registration admission is idempotent, bounded by the latest slot count and rolled back with its transaction", (t) => {
  let instanceCount = 2;
  let tombstone = false;
  const f = enablementFixture(t, {
    workerBindingOf: (tx) => {
      assert.ok(tx.database.isTransaction);
      return {
        ...fakeCollaborations.workerBindingOf(),
        instanceCount,
        tombstone,
      };
    },
  });
  const one = 1;
  const two = 2;
  const none = 0;
  const identity = testMachineIdentity(
    {
      ...client,
      clientId: createIdentity("client_identity"),
      issuedAt: Date.now(),
    },
    "session",
  );
  const handler = f.registry.get(workerOperations.register.id).handler;
  f.caller.identity = identity;
  const input = { params: {}, query: {}, body: null };
  const first = handler(input, f.caller);
  assert.deepEqual(handler(input, f.caller), first);
  assert.equal(f.store.transaction(readAllLive).length, one);
  f.caller.identity = testMachineIdentity(
    { ...identity, clientId: createIdentity("client_identity") },
    "second",
  );
  handler(input, f.caller);
  instanceCount = one;
  f.caller.identity = testMachineIdentity(
    { ...identity, clientId: createIdentity("client_identity") },
    "third",
  );
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  assert.equal(f.store.transaction(readAllLive).length, two);
  instanceCount = none;
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  instanceCount = two + one;
  tombstone = true;
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  tombstone = false;
  const commit = f.caller.commit;
  const failure = new Error("commit rolls back");
  f.caller.commit = (write) =>
    f.store.transaction((tx) => {
      write(tx);
      throw failure;
    });
  assert.throws(
    () => handler(input, f.caller),
    (error) => error === failure,
  );
  f.caller.commit = commit;
  assert.equal(f.store.transaction(readAllLive).length, two);
  assert.equal(
    f.worker.registrations.findByClient(f.caller.identity.clientId),
    undefined,
  );
});

test("deregistration owns its target, rolls back atomically and preserves a newer registration", (t) => {
  const f = enablementFixture(t);
  const clientId = createIdentity("client_identity");
  f.caller.identity = testMachineIdentity(
    { ...client, clientId, issuedAt: Date.now() },
    "owner",
  );
  const register = f.registry.get(workerOperations.register.id).handler;
  const deregister = f.registry.get(
    workerOperations["instance.deregister"].id,
  ).handler;
  const empty = { params: {}, query: {}, body: null };
  const first = workerOperations.register.output.parse(
    register(empty, f.caller),
  );
  const input = { ...empty, params: first };
  const commit = f.caller.commit;
  const failure = new Error("rollback end");
  f.caller.commit = (write) =>
    f.store.transaction((tx) => {
      write(tx);
      throw failure;
    });
  assert.throws(
    () => deregister(input, f.caller),
    (error) => error === failure,
  );
  assert.ok(f.worker.registrations.findByClient(clientId));
  assert.notEqual(f.worker.heartbeatClock.ageMs(first.runtimeIdentity), null);
  f.caller.commit = commit;
  const owner = f.caller.identity;
  for (const changed of [
    { clientId: createIdentity("client_identity") },
    { projectId: "other" },
    { resourceIdentity: "other" },
  ]) {
    f.caller.identity = testMachineIdentity(
      { ...owner, ...changed },
      "foreign",
    );
    refuses(
      () => deregister(input, f.caller),
      WorkerErrorCode.InstanceNotFound,
      HttpStatus.NotFound,
    );
  }
  f.caller.identity = owner;
  assert.deepEqual(deregister(input, f.caller), {
    ...first,
    registered: false,
  });
  assert.equal(f.worker.heartbeatClock.ageMs(first.runtimeIdentity), null);
  assert.equal(f.worker.registrations.findByClient(clientId), undefined);
  const next = workerOperations.register.output.parse(
    register(empty, f.caller),
  );
  assert.notEqual(next.runtimeIdentity, first.runtimeIdentity);
  for (const runtimeIdentity of [
    first.runtimeIdentity,
    createIdentity("worker_instance"),
  ])
    refuses(
      () => deregister({ ...empty, params: { runtimeIdentity } }, f.caller),
      WorkerErrorCode.InstanceNotFound,
      HttpStatus.NotFound,
    );
  assert.equal(
    f.worker.registrations.findByClient(clientId)?.runtimeIdentity,
    next.runtimeIdentity,
  );
});

type OperationKey = Exclude<keyof typeof workerOperations, "register">;

test("resume settles before admission, preserves live readings and reopens the same client registration", (t) => {
  let now = 100;
  let running = true;
  let slot = true;
  const calls: string[] = [];
  const f = enablementFixture(t, {
    monotonicNow: () => now,
    schedulerClaims: {
      ...fakeCollaborations.schedulerClaims,
      runningExecutionOfRuntime: (tx, runtimeIdentity, time) => {
        assert.ok(tx.database.isTransaction);
        assert.ok(runtimeIdentity && Number.isSafeInteger(time));
        calls.push("settle");
        return running ? { executionId: "execution" } : null;
      },
    },
    workerBindingOf: () => {
      calls.push("binding");
      return slot ? fakeCollaborations.workerBindingOf() : null;
    },
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  f.worker.heartbeatClock.set(row.runtimeIdentity);
  const handler = f.registry.get(
    workerOperations["instance.resume"].id,
  ).handler;
  const input = {
    params: { runtimeIdentity: row.runtimeIdentity },
    query: {},
    body: null,
  };
  calls.length = 0;
  now += 100;
  const checkedCommit = f.caller.commit;
  f.caller.commit = (write) =>
    checkedCommit((tx) => {
      const result = write(tx);
      workerOperations["instance.resume"].output.parse(result);
      return result;
    });
  const age = f.worker.heartbeatClock.ageMs(row.runtimeIdentity);
  assert.deepEqual(handler(input, f.caller), {
    runtimeIdentity: row.runtimeIdentity,
    registered: true,
  });
  assert.deepEqual(calls, []);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), age);
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtimeIdentity, Date.now()),
  );
  running = false;
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.NoLiveExecution,
    HttpStatus.Conflict,
  );
  assert.deepEqual(calls, ["settle"]);
  running = true;
  slot = false;
  calls.length = 0;
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  assert.deepEqual(calls, ["settle", "binding"]);
  slot = true;
  const commit = f.caller.commit;
  const failure = new Error("rollback resume");
  f.caller.commit = (write) =>
    f.store.transaction((tx) => {
      write(tx);
      throw failure;
    });
  assert.throws(
    () => handler(input, f.caller),
    (error) => error === failure,
  );
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), age);
  assert.equal(f.worker.registrations.findByClient(client.clientId), undefined);
  f.caller.commit = commit;
  assert.deepEqual(handler(input, f.caller), {
    runtimeIdentity: row.runtimeIdentity,
    registered: true,
  });
  const renewedAge = 0;
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), renewedAge);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.registrations.register(tx, client, Date.now()),
    ).runtimeIdentity,
    row.runtimeIdentity,
  );
});

test("resume refuses unknown identities, occupied clients, full slots, tombstones and disabled bindings", (t) => {
  let binding: ReturnType<WorkerBindingOf> =
    fakeCollaborations.workerBindingOf();
  const f = enablementFixture(t, {
    workerBindingOf: () => binding,
    schedulerClaims: {
      ...fakeCollaborations.schedulerClaims,
      runningExecutionOfRuntime: () => ({ executionId: "execution" }),
    },
  });
  const handler = f.registry.get(
    workerOperations["instance.resume"].id,
  ).handler;
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const input = {
    params: { runtimeIdentity: row.runtimeIdentity },
    query: {},
    body: null,
  };
  refuses(
    () =>
      handler(
        {
          ...input,
          params: { runtimeIdentity: createIdentity("worker_instance") },
        },
        f.caller,
      ),
    WorkerErrorCode.InstanceNotFound,
    HttpStatus.NotFound,
  );
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtimeIdentity, Date.now()),
  );
  const next = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.ClientLive,
    HttpStatus.Conflict,
  );
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, next.runtimeIdentity, Date.now()),
  );
  const other = f.store.transaction((tx) =>
    f.worker.registrations.register(
      tx,
      { ...client, clientId: "other" },
      Date.now(),
    ),
  );
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, other.runtimeIdentity, Date.now()),
  );
  for (const unavailable of [
    null,
    { ...fakeCollaborations.workerBindingOf(), tombstone: true },
    { ...fakeCollaborations.workerBindingOf(), instanceCount: 0 },
  ]) {
    binding = unavailable;
    refuses(
      () => handler(input, f.caller),
      WorkerErrorCode.SlotUnavailable,
      HttpStatus.Conflict,
    );
  }
  assert.equal(f.worker.registrations.findByClient(client.clientId), undefined);
});

test("start resets live heartbeats and sweep ends only expired rows while preserving reopened readings", async (t) => {
  let now = 1000;
  const window = 1;
  const inside = 999;
  const expired = 1001;
  const zero = 0;
  const f = enablementFixture(t, {
    monotonicNow: () => now,
    config: { ...WORKER_CONFIG, heartbeatWindow: window },
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), zero);
  now += inside;
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.clientId));
  f.worker.registrations.heartbeat(row.runtimeIdentity);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), zero);
  now += expired;
  f.worker.sweepRegistrations();
  assert.equal(f.worker.registrations.findByClient(client.clientId), undefined);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), null);
  f.store.transaction((tx) => reopenRegistration(tx, row.runtimeIdentity));
  f.worker.heartbeatClock.set(row.runtimeIdentity);
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.clientId));
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), zero);
  const restarted = new WorkerService({
    config: WORKER_CONFIG,
    store: f.store,
    ...fakeCollaborations,
    monotonicNow: () => now,
  });
  await restarted.start();
  assert.equal(restarted.heartbeatClock.ageMs(row.runtimeIdentity), zero);
  assert.ok(restarted.registrations.findByClient(client.clientId));
  await restarted.stop();
});

test("run owns the heartbeat interval and quiescence stops it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = enablementFixture(t);
  const context = new CancellationContext();
  const sweep = t.mock.method(f.worker, "sweepRegistrations", () => {});
  const running = f.worker.run(context);
  await f.worker.start();
  t.mock.timers.tick(HEARTBEAT_SWEEP_INTERVAL_MS);
  const once = 1;
  assert.equal(sweep.mock.calls.length, once);
  await f.worker.quiesce();
  t.mock.timers.tick(HEARTBEAT_SWEEP_INTERVAL_MS);
  assert.equal(sweep.mock.calls.length, once);
  context.cancel();
  await running;
});

test("quiescence before run resumes prevents a heartbeat producer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = enablementFixture(t);
  const sweep = t.mock.method(f.worker, "sweepRegistrations", () => {});
  const running = f.worker.run();
  await f.worker.quiesce();
  t.mock.timers.tick(HEARTBEAT_SWEEP_INTERVAL_MS);
  const none = 0;
  assert.equal(sweep.mock.calls.length, none);
  await f.worker.stop();
  assert.equal(await running, null);
});

test("a failed heartbeat sweep stops its producer and reaches the run supervisor", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = enablementFixture(t);
  const failure = new Error("heartbeat transaction failed");
  const sweep = t.mock.method(f.worker, "sweepRegistrations", () => {
    throw failure;
  });
  const running = f.worker.run();
  await f.worker.start();
  t.mock.timers.tick(HEARTBEAT_SWEEP_INTERVAL_MS);
  assert.equal(await running, failure);
  t.mock.timers.tick(HEARTBEAT_SWEEP_INTERVAL_MS);
  const once = 1;
  assert.equal(sweep.mock.calls.length, once);
});

test("ending a binding shares its caller transaction and leaves reopened heartbeat readings intact", async (t) => {
  const f = enablementFixture(t);
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  const before = f.worker.heartbeatClock.ageMs(row.runtimeIdentity);
  const failure = new Error("rollback binding end");
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        f.worker.endRegistrations(
          tx,
          client.projectId,
          client.resourceIdentity,
          Date.now(),
        );
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.ok(f.worker.registrations.findByClient(client.clientId));
  f.store.transaction((tx) =>
    f.worker.endRegistrations(
      tx,
      client.projectId,
      client.resourceIdentity,
      Date.now(),
    ),
  );
  assert.equal(f.worker.registrations.findByClient(client.clientId), undefined);
  assert.ok(f.worker.heartbeatClock.ageMs(row.runtimeIdentity)! >= before!);
  f.store.transaction((tx) => reopenRegistration(tx, row.runtimeIdentity));
  f.worker.heartbeatClock.set(row.runtimeIdentity);
  f.worker.sweepRegistrations();
  assert.notEqual(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), null);
  assert.ok(f.worker.registrations.findByClient(client.clientId));
});

test("registration reads retain ended attribution and observe the caller transaction without writes", (t) => {
  const f = enablementFixture(t);
  const registrations = f.worker.registrations;
  const row = f.store.transaction((tx) =>
    registrations.register(tx, client, Date.now()),
  );
  const attribution = { clientId: client.clientId, name: client.name };
  const failure = new Error("rollback registration end");
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        assert.deepEqual(
          registrations.liveRegistrationOf(tx, row.runtimeIdentity),
          row,
        );
        assert.deepEqual(
          registrations.clientAttributionOf(tx, row.runtimeIdentity),
          attribution,
        );
        endRegistration(tx, row.runtimeIdentity, Date.now());
        assert.equal(
          registrations.liveRegistrationOf(tx, row.runtimeIdentity),
          null,
        );
        assert.deepEqual(
          registrations.clientAttributionOf(tx, row.runtimeIdentity),
          attribution,
        );
        throw failure;
      }),
    (error) => error === failure,
  );
  f.store.transaction((tx) => {
    assert.deepEqual(
      registrations.liveRegistrationOf(tx, row.runtimeIdentity),
      row,
    );
    endRegistration(tx, row.runtimeIdentity, Date.now());
    const next = registrations.register(
      tx,
      { ...client, name: "renamed" },
      Date.now(),
    );
    const before = tx.database.prepare("SELECT total_changes() AS count").get();
    assert.equal(
      registrations.liveRegistrationOf(tx, row.runtimeIdentity),
      null,
    );
    assert.deepEqual(
      registrations.liveRegistrationOf(tx, next.runtimeIdentity),
      next,
    );
    assert.deepEqual(
      registrations.clientAttributionOf(tx, row.runtimeIdentity),
      attribution,
    );
    assert.deepEqual(
      registrations.clientAttributionOf(tx, next.runtimeIdentity),
      {
        clientId: client.clientId,
        name: "renamed",
      },
    );
    assert.equal(registrations.liveRegistrationOf(tx, UNKNOWN), null);
    assert.equal(registrations.clientAttributionOf(tx, UNKNOWN), null);
    assert.deepEqual(
      tx.database.prepare("SELECT total_changes() AS count").get(),
      before,
    );
  });
});

test("registration collaborations require an active transaction of their owning store", (t) => {
  const f = enablementFixture(t);
  const foreign = enablementFixture(t);
  const reads: Array<(tx: Parameters<WorkerBindingOf>[0]) => unknown> = [
    (tx: Parameters<WorkerBindingOf>[0]) =>
      f.worker.registrations.liveRegistrationOf(tx, UNKNOWN),
    (tx: Parameters<WorkerBindingOf>[0]) =>
      f.worker.registrations.clientAttributionOf(tx, UNKNOWN),
    (tx: Parameters<WorkerBindingOf>[0]) =>
      f.worker.instanceHealthcheck(tx, UNKNOWN),
    (tx: Parameters<WorkerBindingOf>[0]) => f.worker.registrationChecks(tx),
  ];
  const ended = f.store.transaction((tx) => tx);
  for (let index = 0; index < reads.length; index++) {
    assert.throws(() => reads[index]!(ended), assert.AssertionError);
    assert.throws(
      () => foreign.store.transaction(reads[index]!),
      assert.AssertionError,
    );
  }
});

test("external instance health reads current binding availability without configuration or provider checks", (t) => {
  let binding: ReturnType<WorkerBindingOf> =
    fakeCollaborations.workerBindingOf();
  const f = enablementFixture(t, {
    workerBindingOf: (tx, projectId, resourceIdentity) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(projectId, client.projectId);
      assert.equal(resourceIdentity, client.resourceIdentity);
      return binding;
    },
    custodySuitability: () => assert.fail("External health resolves no agent"),
    credentialMetadata: () =>
      assert.fail("External health reads no credential"),
    modelListCheck: () =>
      assert.fail("Instance health performs no provider check"),
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtimeIdentity),
    );
  assert.equal(check(), true);
  binding = null;
  assert.equal(check(), false);
  binding = { ...fakeCollaborations.workerBindingOf(), tombstone: true };
  assert.equal(check(), false);
  binding = { ...fakeCollaborations.workerBindingOf(), instanceCount: 0 };
  assert.equal(check(), false);
  binding = fakeCollaborations.workerBindingOf();
  assert.equal(check(), true);
  f.store.transaction((tx) =>
    endRegistration(tx, row.runtimeIdentity, Date.now()),
  );
  assert.equal(check(), false);
  assert.equal(
    f.store.transaction((tx) => f.worker.instanceHealthcheck(tx, UNKNOWN)),
    false,
  );
});

test("native instance health resolves the latest agent entry and enablement in the caller snapshot", (t) => {
  let entries: NonNullable<ReturnType<WorkerBindingOf>>["entries"] = [];
  let failure: Error | null = null;
  const f = enablementFixture(t, {
    workerBindingOf: () => ({
      ...fakeCollaborations.workerBindingOf(),
      workerName: WORKER,
      entries,
    }),
    custodySuitability: (tx) => {
      assert.ok(tx.database.isTransaction);
      if (failure) throw failure;
    },
    modelListCheck: () =>
      assert.fail("Instance health performs no provider check"),
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtimeIdentity),
    );
  assert.equal(check(), false);
  f.invoke("agent.enablement.put", putBody);
  assert.equal(check(), true);
  entries = [{ agent: AGENT, modelIdentifier: MISSING_MODEL }];
  assert.equal(check(), false);
  entries = [{ agent: AGENT, ...defaults }];
  assert.equal(check(), true);
  f.invoke("agent.enablement.disable", { expectedRevision: FIRST_REVISION });
  assert.equal(check(), false);
  f.invoke("agent.enablement.enable", { expectedRevision: SECOND_REVISION });
  assert.equal(check(), true);
  failure = new Error("Unexpected custody failure");
  assert.throws(check, (error) => error === failure);
  failure = null;
  f.store.transaction((tx) => {
    endRegistration(tx, row.runtimeIdentity, Date.now());
    assert.equal(f.worker.instanceHealthcheck(tx, row.runtimeIdentity), false);
  });
});

test("registration checks read heartbeat boundaries without renewing, ending or changing instance health", async (t) => {
  let now = 0;
  const windowMs = 1000;
  const beyond = 1;
  const f = enablementFixture(t, {
    monotonicNow: () => now,
    config: { ...WORKER_CONFIG, heartbeatWindow: 1 },
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  const before = f.store.transaction((tx) => ({
    row: readRow(tx, row.runtimeIdentity),
    changes: tx.database.prepare("SELECT total_changes() AS count").get(),
  }));
  const [item] = f.store.transaction((tx) => f.worker.registrationChecks(tx));
  assert.ok(item);
  assert.deepEqual(
    { ...item, check: undefined },
    {
      projectId: client.projectId,
      resourceIdentity: client.resourceIdentity,
      runtimeIdentity: row.runtimeIdentity,
      capability: REGISTRATION_CAPABILITY,
      check: undefined,
    },
  );
  for (const age of [windowMs - beyond, windowMs, windowMs + beyond]) {
    now = age;
    const expected =
      age > windowMs ? ResourceStatus.Unhealthy : ResourceStatus.Healthy;
    assert.equal(await item.check(background), expected);
    assert.equal(
      await f.store
        .transaction((tx) => f.worker.registrationChecks(tx))[0]!
        .check(background),
      expected,
    );
    assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), age);
    f.store.transaction((tx) => {
      assert.equal(f.worker.instanceHealthcheck(tx, row.runtimeIdentity), true);
      assert.deepEqual(readRow(tx, row.runtimeIdentity), before.row);
      assert.deepEqual(
        tx.database.prepare("SELECT total_changes() AS count").get(),
        before.changes,
      );
    });
  }
  const cancelled = new CancellationContext();
  cancelled.cancel();
  await assert.rejects(
    item.check(cancelled),
    (error) => error === cancelled.err(),
  );
  f.worker.heartbeatClock.drop(row.runtimeIdentity);
  assert.equal(await item.check(background), ResourceStatus.Unhealthy);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), null);
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.clientId));
});

test("registration liveness stays separate from native configuration and excludes ended rows", async (t) => {
  const f = enablementFixture(t, {
    monotonicNow: () => 0,
    workerBindingOf: () => ({
      ...fakeCollaborations.workerBindingOf(),
      workerName: WORKER,
    }),
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtimeIdentity),
    ),
    false,
  );
  const [item] = f.store.transaction((tx) => f.worker.registrationChecks(tx));
  assert.ok(item);
  assert.equal(await item.check(background), ResourceStatus.Healthy);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtimeIdentity),
    ),
    false,
  );
  f.store.transaction((tx) => {
    endRegistration(tx, row.runtimeIdentity, Date.now());
    assert.deepEqual(f.worker.registrationChecks(tx), []);
  });
  const zero = 0;
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), zero);
  assert.deepEqual(
    f.store.transaction((tx) => f.worker.registrationChecks(tx)),
    [],
  );
});

function enablementFixture(
  t: TestContext,
  collaborations: Partial<Dependencies> = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const worker = new WorkerService({
    config: WORKER_CONFIG,
    store,
    ...fakeCollaborations,
    ...collaborations,
  });
  const registry = new OperationRegistry();
  worker.declare(registry);
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
  function invoke<K extends OperationKey>(
    key: K,
    body: unknown = null,
    params: Record<string, string> = { agentName: AGENT },
    query: Record<string, unknown> = {},
  ): (typeof workerOperations)[K]["output"]["_output"] {
    const operation = workerOperations[key];
    const input = operation.input.parse({ params, query, body });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    ) as (typeof workerOperations)[K]["output"]["_output"];
  }
  return { store, worker, invoke, registry, caller, commits: () => commits };
}

function refuses(
  fn: () => unknown,
  code: string,
  status: number = HttpStatus.BadRequest,
  details?: OperationError["details"],
) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

test("handover handlers pass the proven execution and one transactional clock reading", (t) => {
  const execution = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "machine",
      projectId: execution.projectId,
      resourceIdentity: "worker:kanthord:general",
      issuedAt: 0,
    },
    "jti",
    execution.runtimeIdentity,
  );
  const envelope = { nonce: "nonce", ciphertext: "ciphertext" };
  const now = 1000;
  t.mock.method(Date, "now", () => now);
  const f = enablementFixture(t, {
    custodyHandover: {
      handover: (tx, actualIdentity, actualExecution, actualNow) => {
        assert(tx.database.isTransaction);
        assert.equal(actualIdentity, identity);
        assert.equal(actualExecution, execution);
        assert.equal(actualNow, now);
        return envelope;
      },
      report: (
        tx,
        actualIdentity,
        actualExecution,
        actualEnvelope,
        actualNow,
      ) => {
        assert(tx.database.isTransaction);
        assert.equal(actualIdentity, identity);
        assert.equal(actualExecution, execution);
        assert.deepEqual(actualEnvelope, envelope);
        assert.equal(actualNow, now);
      },
    },
  });
  const caller = { ...f.caller, identity, execution };
  const body = { executionId: createIdentity("execution"), ...envelope };
  assert.deepEqual(
    f.registry
      .get(workerOperations.handover.id)
      .handler({ params: {}, query: {}, body }, caller),
    envelope,
  );
  assert.equal(
    f.registry
      .get(workerOperations.credential.id)
      .handler({ params: {}, query: {}, body }, caller),
    null,
  );
  const expectedCommits = 2;
  assert.equal(f.commits(), expectedCommits);
});

test("catalog pages supplied declarations once per commit and registrations add no entry", async (t) => {
  const f = enablementFixture(t);
  const pageSize = 2;
  const expectedCommits = 4;
  const before = f.invoke("catalog.list", null, {});
  assert.deepEqual(
    before.items.map((item) => item.name),
    ["claude@1", "general@1", "opencode@1", "reviewer@1"],
  );
  assert.equal(before.nextCursor, null);
  const first = f.invoke("catalog.list", null, {}, { limit: pageSize });
  assert.deepEqual(
    first.items.map((item) => item.name),
    ["claude@1", "general@1"],
  );
  assert.equal(first.nextCursor, Buffer.from(WORKER).toString("base64url"));
  const second = f.invoke(
    "catalog.list",
    null,
    {},
    { limit: pageSize, cursor: first.nextCursor },
  );
  assert.deepEqual(
    second.items.map((item) => item.name),
    ["opencode@1", "reviewer@1"],
  );
  assert.equal(second.nextCursor, null);
  await f.worker.start();
  t.after(() => f.worker.stop());
  f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  assert.deepEqual(f.invoke("catalog.list", null, {}), before);
  assert.equal(f.commits(), expectedCommits);
  assert.deepEqual(Object.keys(before.items[0]!).sort(), [
    "declaredNodeStates",
    "host",
    "name",
    "requiredNodeFormat",
  ]);
});

test("instance reads commit once, retain heartbeat age and refuse ended identities", (t) => {
  const f = enablementFixture(t, { monotonicNow: () => 100 });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(
      tx,
      {
        ...client,
        clientId: createIdentity("client_identity"),
        projectId: createIdentity("project"),
      },
      Date.now(),
    ),
  );
  f.worker.heartbeatClock.set(row.runtimeIdentity);
  const before = f.store.transaction(readAllLive);
  const age = f.worker.heartbeatClock.ageMs(row.runtimeIdentity);
  const commits = f.commits();
  const record = f.invoke("instance.get", null, {
    runtimeIdentity: row.runtimeIdentity,
  });
  const page = f.invoke("instance.list", null, {});
  assert.deepEqual(page.items, [record]);
  const twoReads = 2;
  assert.equal(f.commits() - commits, twoReads);
  assert.deepEqual(f.store.transaction(readAllLive), before);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtimeIdentity), age);
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtimeIdentity, Date.now()),
  );
  refuses(
    () =>
      f.invoke("instance.get", null, { runtimeIdentity: row.runtimeIdentity }),
    WorkerErrorCode.InstanceNotFound,
    HttpStatus.NotFound,
  );
});

test("catalog reads expose host-specific budgets and refuse unknown names and malformed cursors", (t) => {
  const f = enablementFixture(t);
  const native = f.invoke("catalog.get", null, { workerName: WORKER });
  assert.equal(native.host, WorkerHost.Kanthord);
  assert.ok("method" in native && native.method === WorkerMethod.Steps);
  assert.ok("agentName" in native && native.agentName === AGENT);
  assert.ok(!("harness" in native));
  assert.deepEqual(native.resourceBudget, { turns: 200, wallTimeMs: 7200000 });
  const external = f.invoke("catalog.get", null, { workerName: "claude@1" });
  assert.equal(external.host, WorkerHost.ExternalHarness);
  assert.ok("harness" in external && external.harness === EXTERNAL_HARNESS);
  assert.ok(!("method" in external) && !("agentName" in external));
  assert.deepEqual(external.resourceBudget, { wallTimeMs: 7200000 });
  assert.deepEqual(f.worker.declarationOf(WORKER), native);
  assert.equal(f.worker.declarationOf(UNKNOWN), null);
  refuses(
    () => f.invoke("catalog.get", null, { workerName: UNKNOWN }),
    WorkerErrorCode.CatalogNotFound,
    HttpStatus.NotFound,
  );
  for (const cursor of ["!", "Zg=", "Zh", "_w"])
    refuses(
      () => f.invoke("catalog.list", null, {}, { cursor }),
      "system.pagination.cursor_invalid",
    );
  assert.deepEqual(
    f.invoke(
      "catalog.list",
      null,
      {},
      { cursor: Buffer.from("zzz").toString("base64url") },
    ),
    { items: [], nextCursor: null },
  );
  assert.equal(
    workerOperations["catalog.get"].output.safeParse({
      ...native,
      resourceBudget: { wallTimeMs: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
    false,
  );
});

test("resource inventory includes every live provider across pages without writes", async (t) => {
  const calls: Array<{
    tx: Parameters<Dependencies["modelListCheck"]>[0];
    credential: string;
  }> = [];
  const f = enablementFixture(t, {
    modelListCheck: (tx, credential) => {
      calls.push({ tx, credential });
      return async () => ResourceStatus.Unhealthy;
    },
  });
  const PAGE_SIZE = 100;
  const EXTRA_AGENT = 1;
  const SPECIAL_AGENT = "agent/name";
  const SPECIAL_PROVIDER = {
    ...provider,
    name: "with space",
    credential: "special-credential",
  };
  const DISABLED_AGENT = "disabled";
  const REMOVED_AGENT = "removed";
  f.store.transaction((tx) => {
    for (let index = 0; index < PAGE_SIZE + EXTRA_AGENT; index++) {
      insertEnablementRevision(
        tx,
        `agent-${String(index).padStart(3, "0")}`,
        EnablementState.Enabled,
        [provider],
        defaults,
      );
    }
    insertEnablementRevision(
      tx,
      SPECIAL_AGENT,
      EnablementState.Enabled,
      [provider, SPECIAL_PROVIDER],
      defaults,
    );
    insertEnablementRevision(
      tx,
      DISABLED_AGENT,
      EnablementState.Disabled,
      [provider],
      defaults,
    );
    insertEnablementRevision(
      tx,
      REMOVED_AGENT,
      EnablementState.Enabled,
      [provider],
      defaults,
    );
    insertEnablementRevision(
      tx,
      REMOVED_AGENT,
      EnablementState.Enabled,
      [provider],
      defaults,
      Date.now(),
    );
  });
  const countRows = () =>
    f.store.transaction(
      (tx) =>
        (
          tx.database
            .prepare("SELECT COUNT(*) AS count FROM worker_agent_enablement")
            .get() as { count: number }
        ).count,
    );
  const before = countRows();
  let inventory: ReturnType<typeof f.worker.resourceInventory> = [];
  f.store.transaction((tx) => {
    inventory = f.worker.resourceInventory(tx);
    assert.ok(calls.every((call) => call.tx === tx));
  });
  assert.equal(countRows(), before);
  const expectedNames = [
    ...Array.from(
      { length: PAGE_SIZE + EXTRA_AGENT },
      (_, index) => `agent-${String(index).padStart(3, "0")}/${provider.name}`,
    ),
    `${encodeURIComponent(SPECIAL_AGENT)}/${provider.name}`,
    `${encodeURIComponent(SPECIAL_AGENT)}/${encodeURIComponent(SPECIAL_PROVIDER.name)}`,
    `${DISABLED_AGENT}/${provider.name}`,
  ];
  assert.deepEqual(
    inventory.map((entry) => entry.name).sort(),
    expectedNames.sort(),
  );
  assert.equal(calls.length, inventory.length);
  assert.ok(
    calls.some((call) => call.credential === SPECIAL_PROVIDER.credential),
  );
  assert.ok(
    inventory.some(
      (entry) => entry.name === `${DISABLED_AGENT}/${provider.name}`,
    ),
  );
  assert.ok(inventory.every((entry) => !entry.name.startsWith(REMOVED_AGENT)));
  const special = inventory.find(
    (entry) =>
      entry.name ===
      `${encodeURIComponent(SPECIAL_AGENT)}/${encodeURIComponent(SPECIAL_PROVIDER.name)}`,
  );
  assert.ok(special);
  assert.equal(special.scope, HealthScope.Global);
  assert.equal(special.project, null);
  assert.equal(
    special.target,
    `${AGENT_PROVIDER_TARGET_KIND}:${SPECIAL_PROVIDER.credential}`,
  );
  assert.equal(special.capability, AGENT_PROVIDER_CAPABILITY);
  assert.equal(await special.check(background), ResourceStatus.Unhealthy);
  assert.equal(countRows(), before);
});

test("enablement operations use one commit, page ascending, and project only wire fields", (t) => {
  const f = enablementFixture(t);
  refuses(
    () => f.invoke("agent.enablement.get"),
    WorkerErrorCode.NotFound,
    HttpStatus.NotFound,
    { agentName: AGENT },
  );
  const first = f.invoke("agent.enablement.put", putBody);
  assert.deepEqual(first, {
    agentName: AGENT,
    state: EnablementState.Enabled,
    ...putBody,
    revision: FIRST_REVISION,
  });
  f.invoke("agent.enablement.put", putBody, { agentName: OTHER_AGENT });
  const page = f.invoke("agent.enablement.list", null, {}, { limit: "1" });
  assert.deepEqual(
    page.items.map(({ agentName }) => agentName),
    [OTHER_AGENT],
  );
  assert.ok(page.nextCursor);
  const next = f.invoke(
    "agent.enablement.list",
    null,
    {},
    { limit: 1, cursor: page.nextCursor },
  );
  assert.deepEqual(next, { items: [first], nextCursor: null });
  assert.deepEqual(f.invoke("agent.enablement.get"), first);
  const expectedCommits = 6;
  assert.equal(f.commits(), expectedCommits);
  assert.deepEqual(
    workerOperations["agent.enablement.list"].input.parse({
      params: {},
      query: {},
      body: null,
    }).query,
    { limit: LIST_LIMIT_DEFAULT },
  );
});

test("put checks catalog then tombstone-aware expected revision and restarts enabled", (t) => {
  const f = enablementFixture(t);
  refuses(
    () =>
      f.invoke(
        "agent.enablement.put",
        { ...putBody, expectedRevision: 1 },
        { agentName: UNKNOWN },
      ),
    WorkerErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    () => f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 1 }),
    WorkerErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: null },
  );
  f.invoke("agent.enablement.put", putBody);
  refuses(
    () => f.invoke("agent.enablement.put", putBody),
    WorkerErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: FIRST_REVISION },
  );
  f.invoke("agent.enablement.disable", { expectedRevision: 1 });
  assert.deepEqual(
    f.invoke("agent.enablement.remove", { expectedRevision: 2 }),
    { agentName: AGENT, removed: true },
  );
  refuses(
    () => f.invoke("agent.enablement.put", putBody),
    WorkerErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: THIRD_REVISION },
  );
  refuses(
    () => f.invoke("agent.enablement.get"),
    WorkerErrorCode.NotFound,
    HttpStatus.NotFound,
  );
  const restored = f.invoke("agent.enablement.put", {
    ...putBody,
    expectedRevision: 3,
  });
  assert.deepEqual(
    { revision: restored.revision, state: restored.state },
    { revision: 4, state: EnablementState.Enabled },
  );
});

test("mutations check catalog, existence, and then revision in order", (t) => {
  const f = enablementFixture(t);
  for (const key of [
    "agent.enablement.enable",
    "agent.enablement.disable",
    "agent.enablement.remove",
    "agent.enablement.provider.add",
    "agent.enablement.provider.remove",
  ] as const) {
    const body =
      key === ADD_PROVIDER
        ? { ...spare, expectedRevision: 99 }
        : { expectedRevision: 99 };
    const params: Record<string, string> =
      key === REMOVE_PROVIDER
        ? { agentName: AGENT, providerName: spare.name }
        : { agentName: AGENT };
    refuses(
      () => f.invoke(key, body, { ...params, agentName: UNKNOWN }),
      WorkerErrorCode.AgentNotFound,
      HttpStatus.NotFound,
    );
    refuses(
      () => f.invoke(key, body, params),
      WorkerErrorCode.NotFound,
      HttpStatus.NotFound,
    );
  }
  f.invoke("agent.enablement.put", putBody);
  refuses(
    () => f.invoke("agent.enablement.disable", { expectedRevision: 99 }),
    WorkerErrorCode.RevisionConflict,
    HttpStatus.Conflict,
  );
});

test("disable skips dependent validation; enable validates defaults and every binding", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("agent.enablement.put", putBody);
  entries = [{ ...binding, entry: { modelIdentifier: MISSING_MODEL } }];
  const disabled = f.invoke("agent.enablement.disable", {
    expectedRevision: 1,
  });
  assert.equal(disabled.state, EnablementState.Disabled);
  refuses(
    () => f.invoke("agent.enablement.enable", { expectedRevision: 2 }),
    WorkerErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [
        {
          bindingId: binding.bindingId,
          workerName: WORKER,
          code: WorkerErrorCode.ModelUnknown,
        },
      ],
    },
  );
  entries = [binding];
  assert.equal(
    f.invoke("agent.enablement.enable", { expectedRevision: 2 }).state,
    EnablementState.Enabled,
  );
  assert.equal(
    f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 3 })
      .revision,
    THIRD_REVISION + 1,
  );
});

test("remove refuses bindings and tombstones only when unused", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("agent.enablement.put", putBody);
  entries = [binding];
  refuses(
    () => f.invoke("agent.enablement.remove", { expectedRevision: 1 }),
    WorkerErrorCode.InUse,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [{ bindingId: binding.bindingId, workerName: WORKER }],
    },
  );
  entries = [];
  assert.deepEqual(
    f.invoke("agent.enablement.remove", { expectedRevision: 1 }),
    { agentName: AGENT, removed: true },
  );
  assert.deepEqual(f.invoke("agent.enablement.list", null, {}), {
    items: [],
    nextCursor: null,
  });
});

test("provider add and remove preserve uniqueness, last provider, default and explicit dependents", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("agent.enablement.put", putBody);
  const remove = (name: string, revision: number) =>
    f.invoke(
      "agent.enablement.provider.remove",
      { expectedRevision: revision },
      { agentName: AGENT, providerName: name },
    );
  refuses(
    () => remove(UNKNOWN, 1),
    WorkerErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  refuses(() => remove(provider.name, 1), WorkerErrorCode.ProviderRequired);
  assert.deepEqual(
    f.invoke("agent.enablement.provider.add", { ...spare, expectedRevision: 1 })
      .agentProviders,
    [provider, spare],
  );
  refuses(
    () =>
      f.invoke("agent.enablement.provider.add", {
        ...spare,
        expectedRevision: 2,
      }),
    WorkerErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () => remove(provider.name, 2),
    WorkerErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    { agentName: AGENT, dependents: [{ kind: "defaultConfiguration" }] },
  );
  entries = [{ ...binding, entry: { ...defaults, agentProvider: spare.name } }];
  refuses(
    () => remove(spare.name, 2),
    WorkerErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      dependents: [{ bindingId: binding.bindingId, workerName: WORKER }],
    },
  );
  entries = [binding];
  assert.deepEqual(remove(spare.name, 2).agentProviders, [provider]);
});

test("put rejects duplicate names, absent defaults, provider-kind changes, and omitted explicit providers", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...putBody,
        agentProviders: [provider, provider],
      }),
    WorkerErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...putBody,
        defaultConfiguration: { ...defaults, agentProvider: UNKNOWN },
      }),
    WorkerErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  f.invoke("agent.enablement.put", {
    ...putBody,
    agentProviders: [provider, spare],
  });
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...putBody,
        expectedRevision: 1,
        agentProviders: [
          provider,
          { ...spare, provider: AgentProviderKind.GithubCopilot },
        ],
      }),
    WorkerErrorCode.ProviderFixed,
    HttpStatus.Conflict,
  );
  entries = [{ ...binding, entry: { ...defaults, agentProvider: spare.name } }];
  refuses(
    () => f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 1 }),
    WorkerErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [{ bindingId: binding.bindingId, workerName: WORKER }],
    },
  );
  assert.deepEqual(
    f.store.transaction((tx) => getLatestRevision(tx, AGENT)),
    { revision: 1 },
  );
});

test("put collects binding validation failures and validates its defaults first", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("agent.enablement.put", putBody);
  entries = [
    { ...binding, entry: { modelIdentifier: MISSING_MODEL } },
    {
      ...binding,
      bindingId: "second",
      entry: {
        agentProvider: UNKNOWN,
        modelIdentifier: MODEL,
        reasoningEffort: "off",
      },
    },
  ];
  refuses(
    () => f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 1 }),
    WorkerErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [
        {
          bindingId: binding.bindingId,
          workerName: WORKER,
          code: WorkerErrorCode.ModelUnknown,
        },
        {
          bindingId: "second",
          workerName: WORKER,
          code: WorkerErrorCode.ProviderNotFound,
        },
      ],
    },
  );
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...putBody,
        expectedRevision: 1,
        defaultConfiguration: { ...defaults, modelIdentifier: MISSING_MODEL },
      }),
    WorkerErrorCode.ModelUnknown,
  );
});

test("anthropic uses the built-in catalog, not absent credential metadata", (t) => {
  const f = enablementFixture(t, {
    credentialMetadata: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...putBody,
        defaultConfiguration: { ...defaults, modelIdentifier: MISSING_MODEL },
      }),
    WorkerErrorCode.ModelUnknown,
  );
  assert.equal(
    f.invoke("agent.enablement.put", putBody).defaultConfiguration
      .modelIdentifier,
    MODEL,
  );
});

test("openai-compatible metadata establishes models and reasoning levels, including an explicit empty set", (t) => {
  let metadata: Record<string, unknown> | null = {
    models: [{ id: MODEL, extra: true }],
  };
  const f = enablementFixture(t, {
    credentialMetadata: () => ({
      id: "credential",
      name: "custom",
      platform: AgentProviderKind.OpenaiCompatible,
      metadata,
    }),
  });
  const customBody = {
    ...putBody,
    agentProviders: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () =>
      f.invoke("agent.enablement.put", {
        ...customBody,
        defaultConfiguration: { ...defaults, reasoningEffort: "high" },
      }),
    WorkerErrorCode.ReasoningUnsupported,
  );
  metadata = { models: [{ id: MODEL, reasoningLevels: [] }] };
  refuses(
    () => f.invoke("agent.enablement.put", customBody),
    WorkerErrorCode.ReasoningUnsupported,
  );
  for (const value of [{ models: [] }, null]) {
    metadata = value;
    refuses(
      () => f.invoke("agent.enablement.put", customBody),
      WorkerErrorCode.ModelUnknown,
    );
  }
  metadata = { models: [{ id: MODEL }] };
  assert.equal(
    f.invoke("agent.enablement.put", customBody).revision,
    FIRST_REVISION,
  );
  metadata = { models: [{ id: MODEL, reasoningLevels: ["high"] }] };
  assert.equal(
    f.invoke("agent.enablement.put", {
      ...customBody,
      expectedRevision: 1,
      defaultConfiguration: { ...defaults, reasoningEffort: "high" },
    }).revision,
    SECOND_REVISION,
  );
});

test("null credential records permit no model; malformed metadata propagates in writes and views", (t) => {
  let metadata: Record<string, unknown> = { models: [{ id: MODEL }] };
  let absent = true;
  const f = enablementFixture(t, {
    credentialMetadata: () =>
      absent
        ? null
        : {
            id: "credential",
            name: "custom",
            platform: AgentProviderKind.OpenaiCompatible,
            metadata,
          },
  });
  const customBody = {
    ...putBody,
    agentProviders: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () => f.invoke("agent.enablement.put", customBody),
    WorkerErrorCode.ModelUnknown,
  );
  absent = false;
  f.invoke("agent.enablement.put", customBody);
  metadata = { models: "broken" };
  for (const action of [
    () =>
      f.invoke("agent.enablement.put", { ...customBody, expectedRevision: 1 }),
    () =>
      f.store.transaction((tx) =>
        f.worker.workerAgentView(tx, WORKER, AGENT, null),
      ),
  ])
    assert.throws(
      action,
      (error) => error instanceof Error && !(error instanceof OperationError),
    );
});

test("Custody refusals map to credential_unsuitable, while unexpected failures propagate unchanged", (t) => {
  let failure: Error | null = null;
  const f = enablementFixture(t, {
    custodySuitability: () => {
      if (failure) throw failure;
    },
  });
  f.invoke("agent.enablement.put", putBody);
  failure = new OperationError(
    HttpStatus.NotFound,
    "credential.credential.not_found",
    "Missing credential.",
  );
  refuses(
    () => f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 1 }),
    WorkerErrorCode.CredentialUnsuitable,
  );
  refuses(
    () =>
      f.invoke("agent.enablement.provider.add", {
        ...spare,
        expectedRevision: 1,
      }),
    WorkerErrorCode.CredentialUnsuitable,
  );
  const view = () =>
    f.store.transaction((tx) =>
      f.worker.workerAgentView(tx, WORKER, AGENT, null),
    );
  assert.deepEqual(view()?.issues, [
    { path: ["agentProvider"], code: WorkerErrorCode.CredentialUnsuitable },
  ]);
  failure = new CodedError(
    "system.composition.unwired",
    "Unwired collaboration.",
  );
  for (const action of [
    () => f.invoke("agent.enablement.put", { ...putBody, expectedRevision: 1 }),
    view,
  ]) {
    assert.throws(action, (error) => error === failure);
  }
});

test("validateEntry enforces availability, allowlist, entry forms, and external-worker rules", (t) => {
  const f = enablementFixture(t);
  const validate = (entry: WorkerEntry | null, workerName = WORKER) =>
    f.store.transaction((tx) => f.worker.validateEntry(tx, workerName, entry));
  refuses(
    () => validate(null),
    WorkerErrorCode.Unavailable,
    HttpStatus.BadRequest,
    { agentName: AGENT },
  );
  refuses(() => validate(null, UNKNOWN), WorkerErrorCode.InvalidConfiguration);
  assert.doesNotThrow(() => validate(null, "claude@1"));
  refuses(
    () => validate({ modelIdentifier: MODEL }, "claude@1"),
    WorkerErrorCode.InvalidConfiguration,
  );
  f.invoke("agent.enablement.put", putBody);
  for (const entry of [
    null,
    defaults,
    { modelIdentifier: MODEL },
    { reasoningEffort: "off" },
  ])
    assert.doesNotThrow(() => validate(entry));
  refuses(
    () =>
      validate({ ...defaults, options: { unexpected: true } } as WorkerEntry),
    WorkerErrorCode.OverrideNotAllowed,
  );
  for (const entry of [
    {},
    { agentProvider: provider.name },
    { agentProvider: provider.name, modelIdentifier: MODEL },
  ])
    refuses(() => validate(entry), WorkerErrorCode.InvalidConfiguration);
  refuses(
    () => validate({ reasoningEffort: "invented" }),
    WorkerErrorCode.ReasoningUnsupported,
  );
  f.invoke("agent.enablement.disable", { expectedRevision: 1 });
  refuses(() => validate(defaults), WorkerErrorCode.Unavailable);
});

test("Worker collaborations report provider and effective model dependencies without owning a transaction", (t) => {
  const f = enablementFixture(t, {
    entriesOfAgent: (_tx, agentName) =>
      agentName === OTHER_AGENT
        ? [
            {
              ...binding,
              workerName: "reviewer@1",
              entry: { modelIdentifier: MODEL },
            },
          ]
        : [binding],
  });
  f.invoke("agent.enablement.put", putBody);
  f.invoke(
    "agent.enablement.put",
    {
      ...putBody,
      defaultConfiguration: {
        ...defaults,
        modelIdentifier: "claude-haiku-4-5",
      },
    },
    { agentName: OTHER_AGENT },
  );
  f.store.transaction((tx) => {
    assert.deepEqual(
      f.worker.agentProvidersDependentOn(tx, provider.credential),
      [
        { agentName: OTHER_AGENT, providerName: provider.name },
        { agentName: AGENT, providerName: provider.name },
      ],
    );
    const dependent = f.worker.enablementsDependentOnModel(
      tx,
      provider.credential,
      MODEL,
    );
    assert.deepEqual(dependent.map(({ agentName }) => agentName).sort(), [
      OTHER_AGENT,
      AGENT,
    ]);
    for (const row of dependent)
      assert.deepEqual(Object.keys(row).sort(), [
        "agentName",
        "agentProviders",
        "defaultConfiguration",
        "revision",
        "state",
      ]);
    assert.deepEqual(
      f.worker.enablementsDependentOnModel(tx, UNKNOWN, MODEL),
      [],
    );
  });
  assert.deepEqual(f.worker.workerAgentsOf(WORKER), [AGENT]);
  assert.deepEqual(f.worker.workerAgentsOf("claude@1"), []);
  assert.deepEqual(f.worker.workerAgentsOf(UNKNOWN), []);
});

test("model dependency lookup enumerates all live pages, deduplicates, and excludes tombstones", (t) => {
  const f = enablementFixture(t, {
    entriesOfAgent: () => [{ ...binding, entry: { modelIdentifier: MODEL } }],
  });
  const count = LIST_LIMIT_DEFAULT + 2;
  f.store.transaction((tx) => {
    for (let index = 0; index < count; index++)
      insertEnablementRevision(
        tx,
        `agent-${String(index).padStart(3, "0")}`,
        EnablementState.Disabled,
        [provider],
        defaults,
      );
    insertEnablementRevision(
      tx,
      "removed",
      EnablementState.Enabled,
      [provider],
      defaults,
      Date.now(),
    );
    assert.equal(
      f.worker.enablementsDependentOnModel(tx, provider.credential, MODEL)
        .length,
      count,
    );
  });
});

test("workerAgentView resolves valid configurations and returns precise issues without hiding unexpected errors", (t) => {
  const f = enablementFixture(t);
  const view = (
    entry: WorkerEntry | null = null,
    workerName = WORKER,
    agentName = AGENT,
  ) =>
    f.store.transaction((tx) =>
      f.worker.workerAgentView(tx, workerName, agentName, entry),
    );
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    valid: false,
    issues: [{ path: [], code: WorkerErrorCode.Unavailable }],
  });
  assert.equal(view(null, UNKNOWN), null);
  assert.equal(view(null, WORKER, UNKNOWN), null);
  assert.equal(view(null, WORKER, OTHER_AGENT), null);
  assert.equal(view(null, "claude@1"), null);
  f.invoke("agent.enablement.put", putBody);
  assert.deepEqual(view(), {
    defaults,
    effective: {
      ...defaults,
      provider: provider.provider,
      credential: provider.credential,
    },
    valid: true,
    issues: [],
  });
  for (const [entry, path, code] of [
    [
      { modelIdentifier: MISSING_MODEL },
      "modelIdentifier",
      WorkerErrorCode.ModelUnknown,
    ],
    [
      { agentProvider: UNKNOWN },
      "agentProvider",
      WorkerErrorCode.ProviderNotFound,
    ],
    [
      { reasoningEffort: "invented" },
      "reasoningEffort",
      WorkerErrorCode.ReasoningUnsupported,
    ],
  ] as const)
    assert.deepEqual(view(entry), {
      defaults,
      effective: null,
      valid: false,
      issues: [{ path: [path], code }],
    });
  f.invoke("agent.enablement.disable", { expectedRevision: 1 });
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    valid: false,
    issues: [{ path: [], code: WorkerErrorCode.Unavailable }],
  });
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WorkerService, type Dependencies } from "./service.ts";
import { ActionPerformer } from "./action-performer.ts";
import {
  workerOperations,
  ACTION_REQUEST_TOOL_NAME,
  WorkerErrorCode,
  WORKER_SERVICE_NAME,
  REGISTRATION_CAPABILITY,
  REGISTRATION_TARGET_KIND,
  InstanceActivity,
  WorkerHost,
  WorkerMethod,
  type WorkerEntry,
  type WorkerBindingOf,
} from "./contract.ts";
import { workerMigrations } from "./migrations.ts";
import {
  AgentComponent,
  agentMigrations,
  type Dependencies as AgentDependencies,
} from "../agent/index.ts";
import {
  agentOperations,
  AgentErrorCode,
  AGENT_COMPONENT_NAME,
} from "../agent/contract.ts";
import { AgentProviderKind } from "../agent/enablements.ts";
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
import { OperationError } from "../kernel/errors.ts";
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
  agentPrompt: {
    compose: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  workerBindingRowOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  repositoryPolicyOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  repositoryBindingIdsOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  pinnedCredentialMetadata: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  credentialMetadata: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  missionActions: {
    authorizeRequest: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    authorizeAction: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
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
    binding_id: "binding",
    name: "test_worker/%",
    project_name: "test_project",
    revision: 1,
    worker_name: "claude@1",
    instance_count: 1,
    resource_budget: null,
    entries: [],
    tombstone: false,
  }),
  schedulerClaims: {
    requireRunning: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    runningExecutionOfRuntime: () => null,
    activityOf: () => ({ activity: InstanceActivity.Idle, execution_id: null }),
  },
  agentConfiguration: {
    validateEntry: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    agentView: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
};
const PROVIDER_CAPABILITY = "model-list read";
const fakeAgentCollaborations: Omit<AgentDependencies, "store"> = {
  config: { prompt: { system_file: "", agent_directory: "", host_file: true } },
  dataDirectory: "/nonexistent/data",
  hostHome: "/nonexistent/home",
  workbenchDirectory: (agentName) => `/nonexistent/workbench/${agentName}`,
  custodySuitability: () => {},
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryWorkingOf: () => null,
  providerHealthCheck: () => async () => ResourceStatus.Unknown,
  providerCapability: () => PROVIDER_CAPABILITY,
  toolDeclarations: async () => [],
};
const WORKER_CONFIG = { heartbeat_window: 300 };

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
  const answer = { tool_name: ACTION_REQUEST_TOOL_NAME, items: [] };
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
        params: { execution_id: createIdentity("execution") },
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
  client_id: "client",
  name: "worker",
  resource_identity: "worker:kanthord:binding",
  project_id: "project",
};
const clientIdentity = {
  clientId: client.client_id,
  name: client.name,
  resourceIdentity: client.resource_identity,
  projectId: client.project_id,
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
      {
        ...worker.registrations.findByClient(client.client_id),
        worker_name: registration.worker_name,
      },
      registration,
    );
    assert.deepEqual(
      store.transaction((transaction) =>
        worker.registrations.register(transaction, client, Date.now()),
      ),
      registration,
    );
    store.transaction((tx) =>
      endRegistration(tx, registration.runtime_identity, Date.now()),
    );
    assert.equal(
      worker.registrations.findByClient(client.client_id),
      undefined,
    );
    const next = store.transaction((transaction) =>
      worker.registrations.register(transaction, client, Date.now()),
    );
    assert.notEqual(next.runtime_identity, registration.runtime_identity);
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
const provider = {
  name: "primary",
  provider: AgentProviderKind.Anthropic,
  credential: "anthropic",
};
const defaults = {
  agent_provider: provider.name,
  model_identifier: MODEL,
  reasoning_effort: "off",
};
const putBody = {
  agent_providers: [provider],
  default_configuration: defaults,
};

test("registration admission is idempotent, bounded by the latest slot count and rolled back with its transaction", (t) => {
  let instanceCount = 2;
  let tombstone = false;
  const f = enablementFixture(t, {
    workerBindingOf: (tx) => {
      assert.ok(tx.database.isTransaction);
      return {
        ...fakeCollaborations.workerBindingOf(),
        instance_count: instanceCount,
        tombstone,
      };
    },
  });
  const one = 1;
  const two = 2;
  const none = 0;
  const identity = testMachineIdentity(
    {
      ...clientIdentity,
      clientId: createIdentity("client_identity"),
      issuedAt: Date.now(),
    },
    "session",
  );
  const handler = f.registry.get(workerOperations.register.id).handler;
  f.caller.identity = identity;
  const input = { params: {}, query: {}, body: null };
  const first = handler(input, f.caller);
  const facts = workerOperations.register.output.parse(first);
  assert.equal(facts.resource_identity, identity.resourceIdentity);
  assert.equal(
    facts.worker_name,
    fakeCollaborations.workerBindingOf().worker_name,
  );
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
    { ...clientIdentity, clientId, issuedAt: Date.now() },
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
  assert.notEqual(f.worker.heartbeatClock.ageMs(first.runtime_identity), null);
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
    runtime_identity: first.runtime_identity,
    registered: false,
  });
  assert.equal(f.worker.heartbeatClock.ageMs(first.runtime_identity), null);
  assert.equal(f.worker.registrations.findByClient(clientId), undefined);
  const next = workerOperations.register.output.parse(
    register(empty, f.caller),
  );
  assert.notEqual(next.runtime_identity, first.runtime_identity);
  for (const runtimeIdentity of [
    first.runtime_identity,
    createIdentity("worker_instance"),
  ])
    refuses(
      () =>
        deregister(
          { ...empty, params: { runtime_identity: runtimeIdentity } },
          f.caller,
        ),
      WorkerErrorCode.InstanceNotFound,
      HttpStatus.NotFound,
    );
  assert.equal(
    f.worker.registrations.findByClient(clientId)?.runtime_identity,
    next.runtime_identity,
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
        return running ? { execution_id: "execution" } : null;
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
  f.worker.heartbeatClock.set(row.runtime_identity);
  const handler = f.registry.get(
    workerOperations["instance.resume"].id,
  ).handler;
  const input = {
    params: { runtime_identity: row.runtime_identity },
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
  const age = f.worker.heartbeatClock.ageMs(row.runtime_identity);
  assert.deepEqual(handler(input, f.caller), {
    runtime_identity: row.runtime_identity,
    registered: true,
  });
  assert.deepEqual(calls, []);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), age);
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtime_identity, Date.now()),
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
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), age);
  assert.equal(
    f.worker.registrations.findByClient(client.client_id),
    undefined,
  );
  f.caller.commit = commit;
  assert.deepEqual(handler(input, f.caller), {
    runtime_identity: row.runtime_identity,
    registered: true,
  });
  const renewedAge = 0;
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), renewedAge);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.registrations.register(tx, client, Date.now()),
    ).runtime_identity,
    row.runtime_identity,
  );
});

test("resume refuses unknown identities, occupied clients, full slots, tombstones and disabled bindings", (t) => {
  let binding: ReturnType<WorkerBindingOf> =
    fakeCollaborations.workerBindingOf();
  const f = enablementFixture(t, {
    workerBindingOf: () => binding,
    schedulerClaims: {
      ...fakeCollaborations.schedulerClaims,
      runningExecutionOfRuntime: () => ({ execution_id: "execution" }),
    },
  });
  const handler = f.registry.get(
    workerOperations["instance.resume"].id,
  ).handler;
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const input = {
    params: { runtime_identity: row.runtime_identity },
    query: {},
    body: null,
  };
  refuses(
    () =>
      handler(
        {
          ...input,
          params: { runtime_identity: createIdentity("worker_instance") },
        },
        f.caller,
      ),
    WorkerErrorCode.InstanceNotFound,
    HttpStatus.NotFound,
  );
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtime_identity, Date.now()),
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
    f.worker.registrations.deregister(tx, next.runtime_identity, Date.now()),
  );
  const other = f.store.transaction((tx) =>
    f.worker.registrations.register(
      tx,
      { ...client, client_id: "other" },
      Date.now(),
    ),
  );
  refuses(
    () => handler(input, f.caller),
    WorkerErrorCode.SlotUnavailable,
    HttpStatus.Conflict,
  );
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, other.runtime_identity, Date.now()),
  );
  for (const unavailable of [
    null,
    { ...fakeCollaborations.workerBindingOf(), tombstone: true },
    { ...fakeCollaborations.workerBindingOf(), instance_count: 0 },
  ]) {
    binding = unavailable;
    refuses(
      () => handler(input, f.caller),
      WorkerErrorCode.SlotUnavailable,
      HttpStatus.Conflict,
    );
  }
  assert.equal(
    f.worker.registrations.findByClient(client.client_id),
    undefined,
  );
});

test("start resets live heartbeats and sweep ends only expired rows while preserving reopened readings", async (t) => {
  let now = 1000;
  const window = 1;
  const inside = 999;
  const expired = 1001;
  const zero = 0;
  const f = enablementFixture(t, {
    monotonicNow: () => now,
    config: { ...WORKER_CONFIG, heartbeat_window: window },
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), zero);
  now += inside;
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.client_id));
  f.worker.registrations.heartbeat(row.runtime_identity);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), zero);
  now += expired;
  f.worker.sweepRegistrations();
  assert.equal(
    f.worker.registrations.findByClient(client.client_id),
    undefined,
  );
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), null);
  f.store.transaction((tx) => reopenRegistration(tx, row.runtime_identity));
  f.worker.heartbeatClock.set(row.runtime_identity);
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.client_id));
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), zero);
  const restarted = new WorkerService({
    config: WORKER_CONFIG,
    store: f.store,
    ...fakeCollaborations,
    monotonicNow: () => now,
  });
  await restarted.start();
  assert.equal(restarted.heartbeatClock.ageMs(row.runtime_identity), zero);
  assert.ok(restarted.registrations.findByClient(client.client_id));
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
  const before = f.worker.heartbeatClock.ageMs(row.runtime_identity);
  const failure = new Error("rollback binding end");
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        f.worker.endRegistrations(
          tx,
          client.project_id,
          client.resource_identity,
          Date.now(),
        );
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.ok(f.worker.registrations.findByClient(client.client_id));
  f.store.transaction((tx) =>
    f.worker.endRegistrations(
      tx,
      client.project_id,
      client.resource_identity,
      Date.now(),
    ),
  );
  assert.equal(
    f.worker.registrations.findByClient(client.client_id),
    undefined,
  );
  assert.ok(f.worker.heartbeatClock.ageMs(row.runtime_identity)! >= before!);
  f.store.transaction((tx) => reopenRegistration(tx, row.runtime_identity));
  f.worker.heartbeatClock.set(row.runtime_identity);
  f.worker.sweepRegistrations();
  assert.notEqual(f.worker.heartbeatClock.ageMs(row.runtime_identity), null);
  assert.ok(f.worker.registrations.findByClient(client.client_id));
});

test("registration reads retain ended attribution and observe the caller transaction without writes", (t) => {
  const f = enablementFixture(t);
  const registrations = f.worker.registrations;
  const row = f.store.transaction((tx) =>
    registrations.register(tx, client, Date.now()),
  );
  const attribution = { client_id: client.client_id, name: client.name };
  const failure = new Error("rollback registration end");
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        assert.deepEqual(
          {
            ...registrations.liveRegistrationOf(tx, row.runtime_identity),
            worker_name: row.worker_name,
          },
          row,
        );
        assert.deepEqual(
          registrations.clientAttributionOf(tx, row.runtime_identity),
          attribution,
        );
        endRegistration(tx, row.runtime_identity, Date.now());
        assert.equal(
          registrations.liveRegistrationOf(tx, row.runtime_identity),
          null,
        );
        assert.deepEqual(
          registrations.clientAttributionOf(tx, row.runtime_identity),
          attribution,
        );
        throw failure;
      }),
    (error) => error === failure,
  );
  f.store.transaction((tx) => {
    assert.deepEqual(
      {
        ...registrations.liveRegistrationOf(tx, row.runtime_identity),
        worker_name: row.worker_name,
      },
      row,
    );
    endRegistration(tx, row.runtime_identity, Date.now());
    const next = registrations.register(
      tx,
      { ...client, name: "renamed" },
      Date.now(),
    );
    const before = tx.database.prepare("SELECT total_changes() AS count").get();
    assert.equal(
      registrations.liveRegistrationOf(tx, row.runtime_identity),
      null,
    );
    assert.deepEqual(
      {
        ...registrations.liveRegistrationOf(tx, next.runtime_identity),
        worker_name: next.worker_name,
      },
      next,
    );
    assert.deepEqual(
      registrations.clientAttributionOf(tx, row.runtime_identity),
      attribution,
    );
    assert.deepEqual(
      registrations.clientAttributionOf(tx, next.runtime_identity),
      {
        client_id: client.client_id,
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
  const f = enablementFixture(
    t,
    {
      workerBindingOf: (tx, projectId, resourceIdentity) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(projectId, client.project_id);
        assert.equal(resourceIdentity, client.resource_identity);
        return binding;
      },
    },
    {
      custodySuitability: () =>
        assert.fail("External health resolves no agent"),
      approvedModels: () => assert.fail("External health reads no credential"),
      providerHealthCheck: () =>
        assert.fail("Instance health performs no provider check"),
      providerCapability: () =>
        assert.fail("Instance health reads no provider capability"),
    },
  );
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtime_identity),
    );
  assert.equal(check(), true);
  binding = null;
  assert.equal(check(), false);
  binding = { ...fakeCollaborations.workerBindingOf(), tombstone: true };
  assert.equal(check(), false);
  binding = { ...fakeCollaborations.workerBindingOf(), instance_count: 0 };
  assert.equal(check(), false);
  binding = fakeCollaborations.workerBindingOf();
  assert.equal(check(), true);
  f.store.transaction((tx) =>
    endRegistration(tx, row.runtime_identity, Date.now()),
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
  const f = enablementFixture(
    t,
    {
      workerBindingOf: () => ({
        ...fakeCollaborations.workerBindingOf(),
        worker_name: WORKER,
        entries,
      }),
    },
    {
      custodySuitability: (tx) => {
        assert.ok(tx.database.isTransaction);
        if (failure) throw failure;
      },
      providerHealthCheck: () =>
        assert.fail("Instance health performs no provider check"),
      providerCapability: () =>
        assert.fail("Instance health reads no provider capability"),
    },
  );
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtime_identity),
    );
  assert.equal(check(), false);
  f.invokeAgent("enablement.put", putBody);
  assert.equal(check(), true);
  entries = [{ agent: AGENT, model_identifier: MISSING_MODEL }];
  assert.equal(check(), false);
  entries = [{ agent: AGENT, ...defaults }];
  assert.equal(check(), true);
  f.invokeAgent("enablement.disable", { expected_revision: FIRST_REVISION });
  assert.equal(check(), false);
  f.invokeAgent("enablement.enable", { expected_revision: SECOND_REVISION });
  assert.equal(check(), true);
  failure = new Error("Unexpected custody failure");
  assert.throws(check, (error) => error === failure);
  failure = null;
  f.store.transaction((tx) => {
    endRegistration(tx, row.runtime_identity, Date.now());
    assert.equal(f.worker.instanceHealthcheck(tx, row.runtime_identity), false);
  });
});

test("registration checks read heartbeat boundaries without renewing, ending or changing instance health", async (t) => {
  let now = 0;
  const windowMs = 1000;
  const beyond = 1;
  const f = enablementFixture(t, {
    monotonicNow: () => now,
    config: { ...WORKER_CONFIG, heartbeat_window: 1 },
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  const before = f.store.transaction((tx) => ({
    row: readRow(tx, row.runtime_identity),
    changes: tx.database.prepare("SELECT total_changes() AS count").get(),
  }));
  const [item] = f.store.transaction((tx) => f.worker.registrationChecks(tx));
  assert.ok(item);
  const [entry] = f.store.transaction((tx) => f.worker.resourceInventory(tx));
  assert.ok(entry);
  const binding = fakeCollaborations.workerBindingOf();
  assert.deepEqual(
    { ...entry, check: undefined },
    {
      scope: HealthScope.Project,
      project: binding.project_name,
      name: `${encodeURIComponent(binding.name)}/${encodeURIComponent(row.runtime_identity)}`,
      target: `${REGISTRATION_TARGET_KIND}:${row.runtime_identity}`,
      capability: REGISTRATION_CAPABILITY,
      check: undefined,
    },
  );
  assert.deepEqual(
    { ...item, check: undefined },
    {
      projectId: client.project_id,
      resourceIdentity: client.resource_identity,
      runtimeIdentity: row.runtime_identity,
      capability: REGISTRATION_CAPABILITY,
      check: undefined,
    },
  );
  for (const age of [windowMs - beyond, windowMs, windowMs + beyond]) {
    now = age;
    const expected =
      age > windowMs ? ResourceStatus.Unhealthy : ResourceStatus.Healthy;
    assert.equal(await item.check(background), expected);
    assert.equal(await entry.check(background), expected);
    assert.equal(
      await f.store
        .transaction((tx) => f.worker.registrationChecks(tx))[0]!
        .check(background),
      expected,
    );
    assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), age);
    f.store.transaction((tx) => {
      assert.equal(
        f.worker.instanceHealthcheck(tx, row.runtime_identity),
        true,
      );
      assert.deepEqual(readRow(tx, row.runtime_identity), before.row);
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
  f.worker.heartbeatClock.drop(row.runtime_identity);
  assert.equal(await item.check(background), ResourceStatus.Unhealthy);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), null);
  f.worker.sweepRegistrations();
  assert.ok(f.worker.registrations.findByClient(client.client_id));
});

test("registration liveness stays separate from native configuration and excludes ended rows", async (t) => {
  const f = enablementFixture(t, {
    monotonicNow: () => 0,
    workerBindingOf: () => ({
      ...fakeCollaborations.workerBindingOf(),
      worker_name: WORKER,
    }),
  });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  await f.worker.start();
  t.after(() => f.worker.stop());
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtime_identity),
    ),
    false,
  );
  const [item] = f.store.transaction((tx) => f.worker.registrationChecks(tx));
  assert.ok(item);
  assert.equal(await item.check(background), ResourceStatus.Healthy);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.instanceHealthcheck(tx, row.runtime_identity),
    ),
    false,
  );
  f.store.transaction((tx) => {
    endRegistration(tx, row.runtime_identity, Date.now());
    assert.deepEqual(f.worker.registrationChecks(tx), []);
    assert.deepEqual(f.worker.resourceInventory(tx), []);
  });
  const zero = 0;
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), zero);
  assert.deepEqual(
    f.store.transaction((tx) => f.worker.registrationChecks(tx)),
    [],
  );
});

function enablementFixture(
  t: TestContext,
  collaborations: Partial<Dependencies> = {},
  agentCollaborations: Partial<AgentDependencies> = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const agent = new AgentComponent({
    store,
    ...fakeAgentCollaborations,
    ...agentCollaborations,
  });
  const worker = new WorkerService({
    config: WORKER_CONFIG,
    store,
    ...fakeCollaborations,
    agentConfiguration: {
      validateEntry: (tx, name, entry) => agent.validateEntry(tx, name, entry),
      agentView: (tx, name, entry, models) =>
        agent.agentView(tx, name, entry, models),
    },
    ...collaborations,
  });
  const registry = new OperationRegistry();
  worker.declare(registry);
  agent.declare(registry);
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
    params: Record<string, string> = { agent_name: AGENT },
    query: Record<string, unknown> = {},
  ): (typeof workerOperations)[K]["output"]["_output"] {
    const operation = workerOperations[key];
    const input = operation.input.parse({ params, query, body });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    ) as (typeof workerOperations)[K]["output"]["_output"];
  }
  function invokeAgent<K extends keyof typeof agentOperations>(
    key: K,
    body: unknown = null,
    params: Record<string, string> = { agent_name: AGENT },
  ): (typeof agentOperations)[K]["output"]["_output"] {
    const operation = agentOperations[key];
    const input = operation.input.parse({ params, query: {}, body });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    ) as (typeof agentOperations)[K]["output"]["_output"];
  }
  return {
    store,
    worker,
    agent,
    invoke,
    invokeAgent,
    registry,
    caller,
    commits: () => commits,
  };
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
  const body = { execution_id: createIdentity("execution"), ...envelope };
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

test("catalog pages released declarations once per commit and registrations add no entry", async (t) => {
  const f = enablementFixture(t);
  const pageSize = 1;
  const expectedCommits = 4;
  const before = f.invoke("catalog.list", null, {});
  assert.deepEqual(
    before.items.map((item) => item.name),
    ["developer@1", "reviewer@1"],
  );
  assert.equal(before.next_cursor, null);
  const first = f.invoke("catalog.list", null, {}, { limit: pageSize });
  assert.deepEqual(
    first.items.map((item) => item.name),
    ["developer@1"],
  );
  assert.equal(
    first.next_cursor,
    Buffer.from("developer@1").toString("base64url"),
  );
  const second = f.invoke(
    "catalog.list",
    null,
    {},
    { limit: pageSize, cursor: first.next_cursor },
  );
  assert.deepEqual(
    second.items.map((item) => item.name),
    ["reviewer@1"],
  );
  assert.equal(second.next_cursor, null);
  await f.worker.start();
  t.after(() => f.worker.stop());
  f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  assert.deepEqual(f.invoke("catalog.list", null, {}), before);
  assert.equal(f.commits(), expectedCommits);
  assert.deepEqual(Object.keys(before.items[0]!).sort(), [
    "declared_node_states",
    "host",
    "name",
    "required_node_format",
  ]);
});

test("instance reads commit once, retain heartbeat age and refuse ended identities", (t) => {
  const f = enablementFixture(t, { monotonicNow: () => 100 });
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(
      tx,
      {
        ...client,
        client_id: createIdentity("client_identity"),
        project_id: createIdentity("project"),
      },
      Date.now(),
    ),
  );
  f.worker.heartbeatClock.set(row.runtime_identity);
  const before = f.store.transaction(readAllLive);
  const age = f.worker.heartbeatClock.ageMs(row.runtime_identity);
  const commits = f.commits();
  const record = f.invoke("instance.get", null, {
    runtime_identity: row.runtime_identity,
  });
  const page = f.invoke("instance.list", null, {});
  assert.deepEqual(page.items, [record]);
  const twoReads = 2;
  assert.equal(f.commits() - commits, twoReads);
  assert.deepEqual(f.store.transaction(readAllLive), before);
  assert.equal(f.worker.heartbeatClock.ageMs(row.runtime_identity), age);
  f.store.transaction((tx) =>
    f.worker.registrations.deregister(tx, row.runtime_identity, Date.now()),
  );
  refuses(
    () =>
      f.invoke("instance.get", null, {
        runtime_identity: row.runtime_identity,
      }),
    WorkerErrorCode.InstanceNotFound,
    HttpStatus.NotFound,
  );
});

test("catalog reads expose host-specific budgets and refuse unknown names and malformed cursors", (t) => {
  const f = enablementFixture(t);
  const native = f.invoke("catalog.get", null, { worker_name: WORKER });
  assert.equal(native.host, WorkerHost.Kanthord);
  assert.ok("method" in native && native.method === WorkerMethod.Steps);
  assert.ok("agent_names" in native);
  assert.deepEqual(native.agent_names, [AGENT]);
  assert.ok(!("harness" in native));
  assert.deepEqual(native.resource_budget, {
    turns: 200,
    wall_time_ms: 7200000,
  });
  const external = f.invoke("catalog.get", null, { worker_name: "claude@1" });
  assert.equal(external.host, WorkerHost.ExternalHarness);
  assert.ok("harness" in external && external.harness === EXTERNAL_HARNESS);
  assert.ok(!("method" in external) && !("agent_name" in external));
  assert.deepEqual(external.resource_budget, { wall_time_ms: 7200000 });
  assert.deepEqual(f.worker.declarationOf(WORKER), native);
  assert.equal(f.worker.declarationOf(UNKNOWN), null);
  refuses(
    () => f.invoke("catalog.get", null, { worker_name: UNKNOWN }),
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
    { items: [], next_cursor: null },
  );
  assert.equal(
    workerOperations["catalog.get"].output.safeParse({
      ...native,
      resource_budget: { wall_time_ms: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
    false,
  );
});

test("registration inventory fails closed when its binding is missing or removed", (t) => {
  let binding: ReturnType<WorkerBindingOf> =
    fakeCollaborations.workerBindingOf();
  const f = enablementFixture(t, { workerBindingOf: () => binding });
  f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  for (const unavailable of [
    null,
    { ...fakeCollaborations.workerBindingOf(), tombstone: true },
  ]) {
    binding = unavailable;
    assert.throws(
      () => f.store.transaction((tx) => f.worker.resourceInventory(tx)),
      assert.AssertionError,
    );
  }
  binding = fakeCollaborations.workerBindingOf();
  assert.ok(f.store.transaction((tx) => f.worker.resourceInventory(tx)).length);
});

test("validateEntry refuses unknown workers and external entries and validates each native agent", (t) => {
  const f = enablementFixture(t);
  const validate = (entry: WorkerEntry | null, workerName = WORKER) =>
    f.store.transaction((tx) => f.worker.validateEntry(tx, workerName, entry));
  refuses(
    () => validate(null),
    AgentErrorCode.Unavailable,
    HttpStatus.BadRequest,
    { agent_name: AGENT },
  );
  refuses(() => validate(null, UNKNOWN), AgentErrorCode.InvalidConfiguration);
  assert.doesNotThrow(() => validate(null, "claude@1"));
  refuses(
    () => validate({ model_identifier: MODEL }, "claude@1"),
    AgentErrorCode.InvalidConfiguration,
  );
  f.invokeAgent("enablement.put", putBody);
  assert.doesNotThrow(() => validate(defaults));
  refuses(
    () => validate({ model_identifier: MISSING_MODEL }),
    AgentErrorCode.ModelUnknown,
  );
});

test("workerAgentsOf lists the native agent of a worker", (t) => {
  const f = enablementFixture(t);
  assert.deepEqual(f.worker.workerAgentsOf(WORKER), [AGENT]);
  assert.deepEqual(f.worker.workerAgentsOf("claude@1"), []);
  assert.deepEqual(f.worker.workerAgentsOf(UNKNOWN), []);
});

test("workerAgentView answers null outside the agents of the worker and delegates the agent view", (t) => {
  const f = enablementFixture(t);
  const view = (
    entry: WorkerEntry | null = null,
    workerName = WORKER,
    agentName = AGENT,
  ) =>
    f.store.transaction((tx) =>
      f.worker.workerAgentView(tx, workerName, agentName, entry),
    );
  assert.equal(view(null, UNKNOWN), null);
  assert.equal(view(null, WORKER, UNKNOWN), null);
  assert.equal(view(null, WORKER, OTHER_AGENT), null);
  assert.equal(view(null, "claude@1"), null);
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  });
  f.invokeAgent("enablement.put", putBody);
  const entry = { model_identifier: MISSING_MODEL };
  assert.deepEqual(
    view(entry),
    f.store.transaction((tx) => f.agent.agentView(tx, AGENT, entry)),
  );
  assert.equal(view()?.valid, true);
});

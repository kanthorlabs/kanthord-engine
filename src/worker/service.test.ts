import assert from "node:assert/strict";
import { COOLDOWN_DEFAULTS } from "../agent/config.ts";
import { SERVER_HOLDER } from "../custody/contract.ts";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { WorkerService, type Dependencies } from "./service.ts";
import { ActionPerformer } from "./action-performer.ts";
import {
  workerOperations,
  ACTION_REQUEST_TOOL_NAME,
  WorkerErrorCode,
  WORKER_SERVICE_NAME,
  REGISTRATION_CAPABILITY,
  REGISTRATION_TARGET_KIND,
  RegistrationActivity,
  InstancePlacement,
  PlacementIssue,
  POOL_SLOT_COUNT,
  PoolPlacement,
  ContainerRuntime,
  alwaysAvailable,
  type PlacementStatus,
  WorkerHost,
  WorkerMethod,
  ExecutionIntent,
  type ExecutionSetup,
  type WorkerEntry,
  type WorkerBindingOf,
} from "./contract.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { approvedModels, Platform } from "../llm/platforms.ts";
import { workerMigrations } from "./migrations.ts";
import {
  AgentComponent,
  agentMigrations,
  type Dependencies as AgentDependencies,
} from "../agent/index.ts";
import { memoryCredentialHolds } from "../agent/test-support.ts";
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
import {
  Store,
  IN_MEMORY_DATABASE,
  type Transaction,
} from "../kernel/store.ts";
import { AgentChoiceKind, type AgentSelection } from "../scheduler/contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  endRegistration,
  readAllLive,
  readRow,
  reopenRegistration,
} from "./registration-rows.ts";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "./heartbeat.ts";
import { FakePoolHost } from "./test-support.ts";

const fakeCollaborations = {
  agentPrompt: {
    compose: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    templates: async () => {
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
  intentOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  pinnedCredentialMetadata: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  credentialMetadata: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  sshHostKeysOf: () => {
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
    sshSign: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    sshPublicKeyOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  workerBindingOf: () => ({
    binding_id: "binding",
    name: "test_worker/%",
    project_name: "test_project",
    revision: 1,
    worker_name: "claude-code@1",
    instance_count: 1,
    placement: null,
    generation: 1,
    resource_budget: null,
    entries: [],
    tombstone: false,
  }),
  schedulerClaims: {
    agentSelectionsOf: () => [],
    requireRunning: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    runningExecutionOfRuntime: () => null,
    unendedExecutionOf: () => null,
    activityOf: () => ({
      activity: RegistrationActivity.Idle,
      execution_id: null,
    }),
  },
  workerBindingsOf: () => [],
  instanceIssuer: {
    workerToken: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    clientToken: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    clientIdentity: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    clientSecret: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  agentConfiguration: {
    validateEntry: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    selectAgent: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    selectionAt: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    selectionView: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    agentView: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
};
const PROVIDER_CAPABILITY = "model-list read";
const SERVER_SCOPE = { holders: [SERVER_HOLDER], claimant: SERVER_HOLDER };
const fakeAgentCollaborations: Omit<AgentDependencies, "store"> = {
  config: {
    prompt: { system_file: "", agent_directory: "", host_file: true },
    cooldown: COOLDOWN_DEFAULTS,
  },
  dataDirectory: "/nonexistent/data",
  hostHome: "/nonexistent/home",
  workbenchDirectory: (agentName) => `/nonexistent/workbench/${agentName}`,
  custodySuitability: () => {},
  copyHeld: () => true,
  credentialHolds: memoryCredentialHolds(),
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryWorkingOf: () => null,
  providerHealthCheck: () => async () => ResourceStatus.Unknown,
  providerCapability: () => PROVIDER_CAPABILITY,
  toolDeclarations: async () => [],
  logger: pino({ enabled: false }),
};
const WORKER_CONFIG = {
  heartbeat_window: 300,
  server_slot_limit: 16,
  container_image: "docker.io/kanthorlabs/kanthord",
};

test("action handler forwards only the proved claim and caller before its commit", async (t) => {
  const f = enablementFixture(t);
  const execution = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    runtimeIdentity: createIdentity("worker_registration"),
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
const WORKER = "coder@1";
const EXTERNAL_HARNESS = "claude-code";
const MODEL = "claude-sonnet-4-5";
const MISSING_MODEL = "claude-3-5-sonnet-20241022";
const UNKNOWN = "unknown";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const FOURTH_REVISION = 4;
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
  fallback_configurations: [],
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
    workerOperations["registration.deregister"].id,
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
      WorkerErrorCode.RegistrationNotFound,
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
    createIdentity("worker_registration"),
  ])
    refuses(
      () =>
        deregister(
          { ...empty, params: { runtime_identity: runtimeIdentity } },
          f.caller,
        ),
      WorkerErrorCode.RegistrationNotFound,
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
    workerOperations["registration.resume"].id,
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
      workerOperations["registration.resume"].output.parse(result);
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
    workerOperations["registration.resume"].id,
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
          params: { runtime_identity: createIdentity("worker_registration") },
        },
        f.caller,
      ),
    WorkerErrorCode.RegistrationNotFound,
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
      f.worker.registrationHealthcheck(tx, UNKNOWN),
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

test("external registration health reads current binding availability without configuration or provider checks", (t) => {
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
        assert.fail("Registration health performs no provider check"),
      providerCapability: () =>
        assert.fail("Registration health reads no provider capability"),
    },
  );
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, row.runtime_identity),
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
    f.store.transaction((tx) => f.worker.registrationHealthcheck(tx, UNKNOWN)),
    false,
  );
});

test("native registration health resolves the latest agent entry and enablement in the caller snapshot", (t) => {
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
        assert.fail("Registration health performs no provider check"),
      providerCapability: () =>
        assert.fail("Registration health reads no provider capability"),
    },
  );
  const row = f.store.transaction((tx) =>
    f.worker.registrations.register(tx, client, Date.now()),
  );
  const check = () =>
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, row.runtime_identity),
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
    assert.equal(
      f.worker.registrationHealthcheck(tx, row.runtime_identity),
      false,
    );
  });
});

test("registration checks read heartbeat boundaries without renewing, ending or changing registration health", async (t) => {
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
        f.worker.registrationHealthcheck(tx, row.runtime_identity),
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
      f.worker.registrationHealthcheck(tx, row.runtime_identity),
    ),
    false,
  );
  const [item] = f.store.transaction((tx) => f.worker.registrationChecks(tx));
  assert.ok(item);
  assert.equal(await item.check(background), ResourceStatus.Healthy);
  assert.equal(
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, row.runtime_identity),
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
      validateEntry: (tx, name, entry, holders) =>
        agent.validateEntry(tx, name, entry, holders),
      agentView: (tx, name, entry, scope, models) =>
        agent.agentView(tx, name, entry, scope, models),
      selectAgent: (tx, name, entry, scope) =>
        agent.selectAgent(tx, name, entry, scope),
      selectionAt: (tx, name, enablementId, entry, position) =>
        agent.selectionAt(tx, name, enablementId, entry, position),
      selectionView: (tx, selection, models) =>
        agent.selectionView(tx, selection, models),
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
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    runtimeIdentity: createIdentity("worker_registration"),
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
  const signed = { nonce: "signed-nonce", ciphertext: "signed-ciphertext" };
  const now = 1000;
  t.mock.method(Date, "now", () => now);
  const repositoryBindingIds = [createIdentity("binding")];
  const f = enablementFixture(t, {
    repositoryBindingIdsOf: (tx, nodeId, revision) => {
      assert(tx.database.isTransaction);
      assert.equal(nodeId, execution.nodeId);
      assert.equal(revision, execution.pinnedRevision);
      return repositoryBindingIds;
    },
    workerBindingRowOf: (tx, bindingId) => {
      assert(tx.database.isTransaction);
      assert.equal(bindingId, execution.workerBindingId);
      return {
        binding_id: bindingId,
        project_id: execution.projectId,
        resource_identity: "worker:kanthord:general",
        worker_name: "coder@1",
        entries: [],
        resource_budget: null,
        tombstone: false,
        disabled: false,
        placement: InstancePlacement.Container,
        worker_instances: [],
      };
    },
    custodyHandover: {
      handover: (
        tx,
        actualIdentity,
        actualExecution,
        actualPlacement,
        actualBindingIds,
        actualNow,
      ) => {
        assert(tx.database.isTransaction);
        assert.equal(actualIdentity, identity);
        assert.equal(actualExecution, execution);
        assert.equal(actualPlacement, InstancePlacement.Container);
        assert.equal(actualBindingIds, repositoryBindingIds);
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
      sshSign: (
        tx,
        actualIdentity,
        actualClaim,
        actualPlacement,
        actualEnvelope,
        actualNow,
      ) => {
        assert(tx.database.isTransaction);
        assert.equal(actualIdentity, identity);
        assert.equal(actualClaim, execution);
        assert.equal(actualPlacement, InstancePlacement.Container);
        assert.deepEqual(actualEnvelope, envelope);
        assert.equal(actualNow, now);
        return signed;
      },
      sshPublicKeyOf: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
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
  assert.deepEqual(
    f.registry
      .get(workerOperations["ssh.sign"].id)
      .handler({ params: {}, query: {}, body }, caller),
    signed,
  );
  const expectedCommits = 3;
  assert.equal(f.commits(), expectedCommits);
});

test("catalog pages released declarations once per commit and registrations add no entry", async (t) => {
  const f = enablementFixture(t);
  const pageSize = 1;
  const expectedCommits = 4;
  const before = f.invoke("catalog.list", null, {});
  assert.deepEqual(
    before.items.map((item) => item.name),
    ["coder@1", "reviewer@1"],
  );
  assert.equal(before.next_cursor, null);
  const first = f.invoke("catalog.list", null, {}, { limit: pageSize });
  assert.deepEqual(
    first.items.map((item) => item.name),
    ["coder@1"],
  );
  assert.equal(first.next_cursor, Buffer.from("coder@1").toString("base64url"));
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
    "declared_intents",
    "declared_node_states",
    "host",
    "name",
  ]);
});

test("registration reads commit once, retain heartbeat age and refuse ended identities", (t) => {
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
  const record = f.invoke("registration.get", null, {
    runtime_identity: row.runtime_identity,
  });
  const page = f.invoke("registration.list", null, {});
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
      f.invoke("registration.get", null, {
        runtime_identity: row.runtime_identity,
      }),
    WorkerErrorCode.RegistrationNotFound,
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
  const external = f.invoke("catalog.get", null, {
    worker_name: "claude-code@1",
  });
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
    f.store.transaction((tx) =>
      f.worker.validateEntry(tx, workerName, entry, [SERVER_HOLDER]),
    );
  refuses(
    () => validate(null),
    AgentErrorCode.Unavailable,
    HttpStatus.BadRequest,
    { agent_name: AGENT },
  );
  refuses(() => validate(null, UNKNOWN), AgentErrorCode.InvalidConfiguration);
  assert.doesNotThrow(() => validate(null, "claude-code@1"));
  refuses(
    () => validate({ model_identifier: MODEL }, "claude-code@1"),
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
  assert.deepEqual(f.worker.workerAgentsOf("claude-code@1"), []);
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
      f.worker.workerAgentView(tx, workerName, agentName, entry, SERVER_SCOPE),
    );
  assert.equal(view(null, UNKNOWN), null);
  assert.equal(view(null, WORKER, UNKNOWN), null);
  assert.equal(view(null, WORKER, OTHER_AGENT), null);
  assert.equal(view(null, "claude-code@1"), null);
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    chain: [],
    active_position: null,
    cooling: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  });
  f.invokeAgent("enablement.put", putBody);
  const entry = { model_identifier: MISSING_MODEL };
  assert.deepEqual(
    view(entry),
    f.store.transaction((tx) =>
      f.agent.agentView(tx, AGENT, entry, SERVER_SCOPE),
    ),
  );
  assert.equal(view()?.valid, true);
});

type CredentialRecord = {
  platform: string;
  metadata: Record<string, unknown> | null;
};

function authorizationFixture(t: TestContext) {
  const projectId = createIdentity("project");
  const resourceIdentity = "worker:kanthord:general";
  const runtimeIdentity = createIdentity("worker_registration");
  const execution = {
    execution_id: createIdentity("execution"),
    project_id: projectId,
    worker_binding_id: createIdentity("binding"),
    resource_identity: resourceIdentity,
  };
  const claim = {
    executionId: execution.execution_id,
    runtimeIdentity,
    workerBindingId: execution.worker_binding_id,
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "machine",
      projectId,
      resourceIdentity,
      issuedAt: 0,
    },
    "jti",
    runtimeIdentity,
  );
  const anthropicRecord: CredentialRecord = {
    platform: provider.provider,
    metadata: null,
  };
  const newest = new Map<string, CredentialRecord>();
  const pinned = new Map<string, CredentialRecord & { id: string }>();
  const newestOf = (name: string) => newest.get(name) ?? anthropicRecord;
  let selectionOf: (tx: Transaction) => AgentSelection[] = () => [];
  const f = enablementFixture(
    t,
    {
      workerBindingRowOf: () => ({
        binding_id: execution.worker_binding_id,
        project_id: projectId,
        resource_identity: resourceIdentity,
        worker_name: WORKER,
        entries: [],
        resource_budget: null,
        tombstone: false,
        disabled: false,
        placement: InstancePlacement.Server,
        worker_instances: [],
      }),
      schedulerClaims: {
        ...fakeCollaborations.schedulerClaims,
        agentSelectionsOf: (tx) => selectionOf(tx),
      },
      pinnedCredentialMetadata: (_tx, _claim, name) => {
        const record = pinned.get(name);
        return record ? { ...record, name } : null;
      },
      credentialMetadata: (_tx, name) => newestOf(name),
      agentPrompt: {
        compose: async () => [],
        templates: async () => SHIPPED_TEMPLATES,
      },
      repositoryBindingIdsOf: () => [],
      intentOf: () => ExecutionIntent.Implement,
    },
    {
      approvedModels: (_tx, name) =>
        approvedModels(newestOf(name).platform, newestOf(name).metadata),
    },
  );
  const pin = () => {
    const chosen = f.store.transaction((tx) =>
      f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
    );
    assert.ok(chosen.kind === AgentChoiceKind.Selected);
    selectionOf = (tx) => [
      f.agent.selectionAt(
        tx,
        AGENT,
        chosen.enablement_id,
        null,
        chosen.selection.position,
      ),
    ];
    return chosen.selection;
  };
  const authorize = () =>
    f.store.transaction((tx) =>
      f.worker.authorizeModelInference(tx, identity, execution),
    );
  const setup = () =>
    f.registry
      .get(workerOperations["execution.setup.get"].id)
      .handler(
        { params: {}, query: {}, body: null },
        { ...f.caller, identity, execution: claim },
      ) as Promise<ExecutionSetup>;
  return { ...f, pin, authorize, setup, newest, pinned };
}

test("authorization reads the credential of the pinned enablement revision after a newer revision", (t) => {
  const f = authorizationFixture(t);
  f.invokeAgent("enablement.put", putBody);
  f.pin();
  f.invokeAgent("enablement.put", {
    ...putBody,
    expected_revision: FIRST_REVISION,
    agent_providers: [{ ...provider, credential: "anthropic-b" }],
  });
  assert.deepEqual(
    f.authorize().map((item) => item.credential),
    [provider.credential],
  );
  const other = { ...provider, name: "other", credential: "anthropic-c" };
  f.invokeAgent("enablement.put", {
    ...putBody,
    expected_revision: SECOND_REVISION,
    agent_providers: [other, provider],
    default_configuration: { ...defaults, agent_provider: other.name },
  });
  f.invokeAgent(
    "enablement.provider.remove",
    { expected_revision: THIRD_REVISION },
    { agent_name: AGENT, provider_name: provider.name },
  );
  assert.deepEqual(
    f.authorize().map((item) => item.credential),
    [provider.credential],
  );
  f.invokeAgent("enablement.disable", { expected_revision: FOURTH_REVISION });
  refuses(f.authorize, AgentErrorCode.Unavailable);
});

test("authorization validates the model against the pinned credential revision", (t) => {
  const f = authorizationFixture(t);
  const custom = { ...provider, provider: AgentProviderKind.OpenaiCompatible };
  const models = (id: string) => ({
    platform: Platform.OpenAICompatible,
    metadata: {
      base_url: "http://localhost:1234",
      models: [{ id, reasoning_levels: [defaults.reasoning_effort] }],
    },
  });
  f.newest.set(custom.credential, models(MODEL));
  f.invokeAgent("enablement.put", { ...putBody, agent_providers: [custom] });
  f.pin();
  f.pinned.set(custom.credential, {
    ...models(MODEL),
    id: createIdentity("credential"),
  });
  f.newest.set(custom.credential, models(MISSING_MODEL));
  assert.deepEqual(
    f.authorize().map((item) => item.credential),
    [custom.credential],
  );
  f.pinned.delete(custom.credential);
  refuses(f.authorize, AgentErrorCode.ModelUnknown);
});

test("setup answers the pinned credential after a newer enablement revision maps the provider to another credential", async (t) => {
  const f = authorizationFixture(t);
  f.invokeAgent("enablement.put", putBody);
  const selection = f.pin();
  const credentialId = createIdentity("credential");
  f.pinned.set(provider.credential, {
    platform: provider.provider,
    metadata: null,
    id: credentialId,
  });
  f.invokeAgent("enablement.put", {
    ...putBody,
    expected_revision: FIRST_REVISION,
    agent_providers: [{ ...provider, credential: "anthropic-b" }],
  });
  const [answered] = (await f.setup()).agents;
  assert.ok(answered);
  assert.equal(
    answered.effective_configuration.credential,
    provider.credential,
  );
  assert.equal(answered.credential_id, credentialId);
  assert.equal(answered.position, selection.position);
  assert.equal(answered.level, selection.level);
});

const POOL_PROJECT = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const POOL_RESOURCE = "worker:kanthord:binding";
const POOL_GENERATION = 11;
const POOL_ONE_START = 1;
const POOL_TWO_STARTS = 2;
const POOL_FOUR_STARTS = 4;
const NO_SWEPT = 0;

const POOL_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const changesApplied = () => new Promise((resolve) => setImmediate(resolve));

function poolFixture(t: TestContext, initialCount: number) {
  const host = new FakePoolHost();
  const logs: string[] = [];
  const state = {
    count: initialCount,
    placement: InstancePlacement.Server as InstancePlacement | null,
    generation: POOL_GENERATION,
    failure: null as Error | null,
    executing: new Set<string>(),
  };
  const binding = () => ({
    ...fakeCollaborations.workerBindingOf(),
    worker_name: WORKER,
    instance_count: state.count,
    placement: state.placement,
    worker_instances: [],
    generation: state.generation,
  });
  const f = enablementFixture(t, {
    workerBindingOf: () => binding(),
    schedulerClaims: {
      ...fakeCollaborations.schedulerClaims,
      activityOf: (_tx, runtimeIdentity) =>
        state.executing.has(runtimeIdentity)
          ? {
              activity: RegistrationActivity.Executing,
              execution_id: POOL_EXECUTION,
            }
          : { activity: RegistrationActivity.Idle, execution_id: null },
    },
    pool: {
      host,
      workerBindingsOf: () => {
        if (state.failure) throw state.failure;
        return [
          {
            ...binding(),
            project_id: POOL_PROJECT,
            resource_identity: POOL_RESOURCE,
          },
        ];
      },
      logger: pino({ level: "error" }, { write: (line) => logs.push(line) }),
    },
  });
  const slotId = (slot: number) =>
    host.clientIdentity(POOL_PROJECT, POOL_RESOURCE, POOL_GENERATION, slot);
  function register(clientId: string) {
    f.caller.identity = testMachineIdentity(
      {
        clientId,
        name: "server slot",
        resourceIdentity: POOL_RESOURCE,
        projectId: POOL_PROJECT,
        issuedAt: Date.now(),
      },
      "session",
    );
    return workerOperations.register.output.parse(
      f.registry
        .get(workerOperations.register.id)
        .handler({ params: {}, query: {}, body: null }, f.caller),
    );
  }
  return { ...f, host, state, logs, slotId, register };
}

test("the pool starts at startPool and a change notice before it does nothing", async (t) => {
  const f = poolFixture(t, 2);
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.deepEqual(f.host.started, []);
  f.worker.startPool();
  assert.deepEqual(
    f.host.started.map(({ slot }) => slot),
    [0, 1],
  );
  f.worker.startPool();
  assert.equal(f.host.started.length, POOL_TWO_STARTS);
});

test("startPool prepares the pool host once when no container binding is live", (t) => {
  const f = poolFixture(t, 0);
  f.worker.startPool();
  f.worker.startPool();
  assert.equal(f.host.prepared, POOL_ONE_START);
  assert.deepEqual(f.host.started, []);
});

test("startPool sweeps with the identity of the binding at every slot number", (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  assert.equal(f.host.swept.length, POOL_ONE_START);
  const live = f.host.swept[0]!;
  assert.equal(live.size, POOL_SLOT_COUNT);
  for (let slot = 0; slot < POOL_SLOT_COUNT; slot++)
    assert.ok(live.has(f.slotId(slot)));
});

test("startPool sweeps with no identity for a binding at the worker placement", (t) => {
  const f = poolFixture(t, 1);
  f.state.placement = InstancePlacement.Worker;
  f.worker.startPool();
  assert.equal(f.host.swept[0]!.size, NO_SWEPT);
});

test("a change notice reconciles the pool with the instance count of the binding", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  f.state.count = 3;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.deepEqual(
    f.host.started.map(({ slot }) => slot),
    [0, 1, 2],
  );
  f.state.count = 1;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.deepEqual(
    f.host.drained.map(({ slot }) => slot),
    [2, 1],
  );
});

test("a binding at the worker placement gets no pool slot", (t) => {
  const f = poolFixture(t, 2);
  f.state.placement = InstancePlacement.Worker;
  f.worker.startPool();
  assert.deepEqual(f.host.started, []);
});

test("a binding at the server placement accepts a registration only from a current pool slot", async (t) => {
  const f = poolFixture(t, 2);
  f.worker.startPool();
  const registered = f.register(f.slotId(1));
  assert.equal(
    workerOperations.register.output.parse(registered).resource_identity,
    POOL_RESOURCE,
  );
  refuses(
    () => f.register(createIdentity("client_identity")),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
  f.state.count = 1;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.ok(f.worker.registrations.findByClient(f.slotId(1)));
  f.host.end(f.slotId(1));
  refuses(
    () => f.register(f.slotId(1)),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
  f.state.generation = POOL_GENERATION + 1;
  refuses(
    () => f.register(f.slotId(0)),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
});

test("a binding at the worker placement refuses every client identity", (t) => {
  const f = poolFixture(t, 2);
  f.state.placement = InstancePlacement.Worker;
  f.worker.startPool();
  for (const clientId of [createIdentity("client_identity"), f.slotId(0)])
    refuses(
      () => f.register(clientId),
      WorkerErrorCode.PlacementMismatch,
      HttpStatus.Conflict,
    );
});

test("the start of the pool starts a slot above the target with a live registration in drain mode", (t) => {
  const f = poolFixture(t, 1);
  f.state.placement = null;
  f.register(f.slotId(2));
  f.state.placement = InstancePlacement.Server;
  f.worker.startPool();
  assert.deepEqual(
    f.host.started.map(({ slot, draining }) => [slot, draining]),
    [
      [0, false],
      [2, true],
    ],
  );
});

test("a registration record shows the placement and the drain flag of its slot", async (t) => {
  const f = poolFixture(t, 2);
  f.worker.startPool();
  f.register(f.slotId(0));
  f.register(f.slotId(1));
  f.state.count = 1;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  const items = f.invoke("registration.list", null, {}).items;
  const byClient = new Map(items.map((item) => [item.client_id, item]));
  assert.equal(byClient.get(f.slotId(0))?.placement, InstancePlacement.Server);
  assert.equal(byClient.get(f.slotId(0))?.draining, false);
  assert.equal(byClient.get(f.slotId(1))?.draining, true);
});

test("stopPool stops the host and ignores later change notices", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  await f.worker.stopPool();
  assert.ok(f.host.stopped);
  f.state.count = 2;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.equal(f.host.started.length, POOL_ONE_START);
});

test("a draining slot gets no claim while its running execution stays answerable", async (t) => {
  const f = poolFixture(t, 2);
  f.invokeAgent("enablement.put", putBody);
  f.worker.startPool();
  const active = f.register(f.slotId(0)).runtime_identity;
  const draining = f.register(f.slotId(1)).runtime_identity;
  const healthy = (runtimeIdentity: string) =>
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, runtimeIdentity),
    );
  assert.equal(healthy(active), true);
  assert.equal(healthy(draining), true);
  f.state.count = 1;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.equal(healthy(active), true);
  assert.equal(healthy(draining), false);
  f.state.count = 2;
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.equal(healthy(draining), true);
});

test("a restart of the pool host starts a busy slot above the target in drain mode", (t) => {
  const f = poolFixture(t, POOL_FOUR_STARTS);
  f.state.placement = null;
  const busy = f.register(f.slotId(2)).runtime_identity;
  f.register(f.slotId(3));
  f.state.executing.add(busy);
  f.state.placement = InstancePlacement.Server;
  f.state.count = 1;
  f.worker.startPool();
  assert.deepEqual(
    f.host.started.map(({ slot, draining }) => [slot, draining]),
    [
      [0, false],
      [2, true],
      [3, true],
    ],
  );
  assert.deepEqual(f.host.drained, []);
});

test("a failed reconciliation in a change notice is logged and does not reach the writer", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  f.state.failure = new Error("binding read failed");
  assert.doesNotThrow(() => f.worker.bindingsChanged(POOL_PROJECT));
  assert.deepEqual(f.logs, []);
  await changesApplied();
  const [line] = f.logs;
  assert.match(line!, /worker\.pool\.reconcile_failed/);
  assert.match(line!, /binding read failed/);
});

const DRIVER_RECORDS = 1;
const NO_STATUS_READS = 0;
const UNAVAILABLE_CONTAINER = {
  placement: InstancePlacement.Container,
  available: false,
  reason: PlacementIssue.RuntimeFailed,
  detail: "Cannot connect to Podman.",
  container_runtime: ContainerRuntime.Podman,
} satisfies PlacementStatus;

async function placementList(f: ReturnType<typeof poolFixture>) {
  const operation = workerOperations["placement.list"];
  const input = operation.input.parse({ params: {}, query: {}, body: null });
  return operation.output.parse(
    await f.registry.get(operation.id).handler(input, f.caller),
  );
}

async function loggedAfterStart(f: ReturnType<typeof poolFixture>) {
  f.worker.startPool();
  await changesApplied();
  return f.logs.filter((line) => /worker\.pool\.driver_unavailable/.test(line));
}

test("the placement list answers server, container and worker in order", async (t) => {
  const f = poolFixture(t, 1);
  assert.deepEqual(await placementList(f), {
    items: [
      alwaysAvailable(InstancePlacement.Server),
      alwaysAvailable(InstancePlacement.Container),
      alwaysAvailable(InstancePlacement.Worker),
    ],
  });
});

for (const reason of Object.values(PlacementIssue))
  test(`the placement list reports the container reason ${reason}`, async (t) => {
    const f = poolFixture(t, 1);
    const container = { ...UNAVAILABLE_CONTAINER, reason };
    f.host.statuses.set(PoolPlacement.Container, container);
    const { items } = await placementList(f);
    assert.deepEqual(
      items.map(({ placement }) => placement),
      [
        InstancePlacement.Server,
        InstancePlacement.Container,
        InstancePlacement.Worker,
      ],
    );
    assert.deepEqual(items[1], container);
    assert.deepEqual(items[0], alwaysAvailable(InstancePlacement.Server));
    assert.deepEqual(items[2], alwaysAvailable(InstancePlacement.Worker));
  });

test("the placement list reports no unavailable server or worker placement", async (t) => {
  const f = poolFixture(t, 1);
  f.host.statuses.set(PoolPlacement.Server, {
    ...UNAVAILABLE_CONTAINER,
    placement: InstancePlacement.Server,
  });
  const { items } = await placementList(f);
  assert.equal(items[0]!.placement, InstancePlacement.Server);
  assert.equal(items[2]!.available, true);
});

test("start with an unavailable runtime and a live container binding logs the driver once and starts the pool", async (t) => {
  const f = poolFixture(t, 1);
  f.state.placement = InstancePlacement.Container;
  f.host.statuses.set(PoolPlacement.Container, UNAVAILABLE_CONTAINER);
  const lines = await loggedAfterStart(f);
  assert.equal(lines.length, DRIVER_RECORDS);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.placement, InstancePlacement.Container);
  assert.equal(record.reason, PlacementIssue.RuntimeFailed);
  assert.equal(record.detail, UNAVAILABLE_CONTAINER.detail);
  assert.equal(f.host.started.length, POOL_ONE_START);
});

test("start logs no driver record for an available runtime", async (t) => {
  const f = poolFixture(t, 1);
  f.state.placement = InstancePlacement.Container;
  assert.deepEqual(await loggedAfterStart(f), []);
});

test("start checks no runtime when no live binding holds the container placement", async (t) => {
  const f = poolFixture(t, 1);
  f.host.statuses.set(PoolPlacement.Container, UNAVAILABLE_CONTAINER);
  assert.deepEqual(await loggedAfterStart(f), []);
  assert.equal(f.host.statusReads, NO_STATUS_READS);
});

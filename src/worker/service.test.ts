import assert from "node:assert/strict";
import { COOLDOWN_DEFAULTS } from "../agent/config.ts";
import {
  CredentialLeaseHeld,
  CredentialRefreshInFlight,
  SERVER_HOLDER,
} from "../custody/contract.ts";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { type Dependencies, WorkerService } from "./service.ts";
import { ActionPerformer } from "./action-performer.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  BindingEntryState,
  ContainerRuntime,
  ExecutionIntent,
  type ExecutionSetup,
  HANDOVER_REFRESH_WAIT_MS,
  HANDOVER_TIMEOUT_MS,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  InstancePlacement,
  type MissionPromptPins,
  PlacementIssue,
  type PlacementStatus,
  PoolPlacement,
  type PromptBase,
  type PromptCommits,
  REGISTRATION_CAPABILITY,
  REGISTRATION_TARGET_KIND,
  RegistrationActivity,
  type SessionRead,
  SessionReadOutcome,
  WORKER_SERVICE_NAME,
  type WorkerBindingOf,
  type WorkerEntry,
  WorkerErrorCode,
  WorkerHost,
  WorkerMethod,
  workerOperations,
} from "./contract.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { approvedModels, Platform } from "../llm/platforms.ts";
import { endInstance, insertInstance } from "./instance-rows.ts";
import { insertMachineFor } from "./machine-test-support.ts";
import { workerMigrations } from "./migrations.ts";
import {
  AgentComponent,
  type Dependencies as AgentDependencies,
  agentMigrations,
} from "../agent/index.ts";
import { memoryCredentialHolds } from "../agent/test-support.ts";
import {
  AGENT_COMPONENT_NAME,
  AgentErrorCode,
  agentOperations,
} from "../agent/contract.ts";
import { AgentProviderKind } from "../agent/enablements.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import {
  HealthRegistry,
  HealthScope,
  ResourceStatus,
} from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  AgentChoiceKind,
  type AgentPin,
  type AgentSelection,
} from "../scheduler/contract.ts";
import {
  CleanupRefusal,
  FOOTPRINT_SERVICE,
  InstanceCleanableKind,
  InstanceFootprintKind,
} from "../kernel/cleanup.ts";
import { HttpStatus } from "../kernel/http.ts";
import { ProjectErrorCode } from "../project/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
import { packageVersion } from "../kernel/version.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { PROMPT_SOURCE_READ_MS } from "../kernel/prompt-source.ts";
import {
  endRegistration,
  insertRegistration,
  readAllLive,
  readRow,
  reopenRegistration,
} from "./registration-rows.ts";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "./heartbeat.ts";
import {
  FakePoolHost,
  memoryPromptTelemetry,
  shippedFraming,
} from "./test-support.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  SESSION_READ_WAIT_MS,
  SessionAbsentReason,
  UnreachableReason,
} from "../tracking/contract.ts";

const fakeCollaborations = {
  sessionReadWaitMs: SESSION_READ_WAIT_MS,
  promptTelemetry: {
    agentPrompted: () => {},
    promptRecordOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  agentPrompt: {
    compose: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    templates: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    framing: async () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  environmentClaimed: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  environmentDigestOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  environmentOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
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
    linkUpdatesOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  missionPromptPins: {
    attemptPromptCommits: () => [],
    pinPromptCommits: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  instanceArchive: {
    revokeForInstanceArchive: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    revokePausedClaim: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    executionReleased: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    reportExecutionEnds: () => {
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
    describe: async () => {
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
    lease: () => {
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
    agentPinsOf: () => null,
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
    prompt: { agent_directory: "" },
    cooldown: COOLDOWN_DEFAULTS,
  },
  dataDirectory: "/nonexistent/data",
  custodySuitability: () => {},
  copyHeld: () => true,
  credentialHolds: memoryCredentialHolds(),
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryPromptsOf: () => null,
  promptBase: {
    baseCommitOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    instructionFileOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  attemptPromptStackOf: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  promptRecords: {
    executionTraceOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    promptRecordOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  },
  providerHealthCheck: () => async () => ResourceStatus.Unknown,
  providerCapability: () => PROVIDER_CAPABILITY,
  toolDeclarations: async () => [],
  workerNamesOf: () => [],
  workerAgentNames: [],
  logger: pino({ enabled: false }),
};
const WORKER_CONFIG = {
  heartbeat_window: 300,
  server_instance_limit: 16,
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
  stopAfter(t, () => store.close());
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
    assert.equal(await running, context.signal.reason);
    assert.equal(await worker.stop(), null);
  }
});

const AGENT = "swe@1";
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
  stopAfter(t, () => f.worker.stop());
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

test("run owns the stop order interval and quiescence stops it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = enablementFixture(t);
  const context = new CancellationContext();
  const sweep = t.mock.method(f.worker.instances, "sweepStopOrders", () => {});
  const running = f.worker.run(context);
  await f.worker.start();
  t.mock.timers.tick(INSTANCE_HEARTBEAT_INTERVAL_MS);
  const once = 1;
  assert.equal(sweep.mock.calls.length, once);
  await f.worker.quiesce();
  t.mock.timers.tick(INSTANCE_HEARTBEAT_INTERVAL_MS);
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
  stopAfter(t, () => f.worker.stop());
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
  stopAfter(t, () => f.worker.stop());
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
    (error) => error === cancelled.signal.reason,
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
  stopAfter(t, () => f.worker.stop());
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
  stopAfter(t, () => store.close());
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
    sessionReadWaitMs: SESSION_READ_WAIT_MS,
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

test("handover handlers pass the proven execution and one transactional clock reading", async (t) => {
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
      lease: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
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
  execution.runtimeIdentity = f.store.transaction((tx) => {
    const instance = insertInstance(
      tx,
      {
        name: LAPTOP,
        worker: WORKER,
        placement: InstancePlacement.Container,
        public_key: null,
        fingerprint: null,
      },
      now,
    );
    return insertRegistration(
      tx,
      {
        project_id: execution.projectId,
        resource_identity: "worker:kanthord:general",
        client_id: identity.clientId,
        name: "machine",
        instance_id: instance.id,
      },
      now,
    ).runtime_identity;
  });
  const caller = { ...f.caller, identity, execution };
  const body = { execution_id: createIdentity("execution"), ...envelope };
  assert.deepEqual(
    await f.registry
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
  let pinsOf: () => {
    worker_binding_id: string;
    pins: AgentPin[];
  } | null = () => null;
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
        agentPinsOf: () => pinsOf(),
      },
      pinnedCredentialMetadata: (_tx, _claim, name) => {
        const record = pinned.get(name);
        return record ? { ...record, name } : null;
      },
      credentialMetadata: (_tx, name) => newestOf(name),
      promptTelemetry: memoryPromptTelemetry(),
      agentPrompt: {
        compose: async () => [],
        templates: async () => SHIPPED_TEMPLATES,
        framing: async () => shippedFraming(),
      },
      missionPromptPins: {
        attemptPromptCommits: () => null,
        pinPromptCommits: () => {
          throw new Error("UNEXPECTED_COLLABORATION");
        },
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
    pinsOf = () => ({
      worker_binding_id: execution.worker_binding_id,
      pins: [
        {
          agent_name: AGENT,
          enablement_id: chosen.enablement_id,
          position: chosen.selection.position,
        },
      ],
    });
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
const OTHER_POOL_RESOURCE = "worker:kanthord:other";
const POOL_GENERATION = 11;
const POOL_ONE_START = 1;
const POOL_TWO_STARTS = 2;
const NO_STARTS = 0;
const FIRST_INSTANCE = 0;
const SECOND_INSTANCE = 1;
const THIRD_INSTANCE = 2;
const LAPTOP = "laptop";

const POOL_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const changesApplied = () => new Promise((resolve) => setImmediate(resolve));

interface PoolBinding {
  resource_identity: string;
  environment: string | null;
  listed: string[];
}

function poolFixture(
  t: TestContext,
  instanceCount: number,
  collaborations: Partial<Dependencies> = {},
) {
  const host = new FakePoolHost();
  const logs: string[] = [];
  const state = {
    generation: POOL_GENERATION,
    failure: null as Error | null,
    executing: new Set<string>(),
    revoked: [] as string[],
    reported: 0,
    bindings: [
      { resource_identity: POOL_RESOURCE, environment: null, listed: [] },
    ] as PoolBinding[],
  };
  const identities = new Map<string, string>();
  const instanceIds = new Map<string, string>();
  let clock = 0;
  const binding = (pool: PoolBinding, placement: InstancePlacement | null) => ({
    ...fakeCollaborations.workerBindingOf(),
    worker_name: WORKER,
    instance_count: pool.listed.length,
    placement,
    worker_instances: pool.listed,
    environment: pool.environment,
    generation: state.generation,
    project_id: POOL_PROJECT,
    resource_identity: pool.resource_identity,
  });
  const bindingsOf = () => state.bindings.map((pool) => binding(pool, null));
  const clientIdentityOf = (
    instanceId: string,
    projectId: string,
    resourceIdentity: string,
    generation: number,
  ) => {
    if (state.failure) throw state.failure;
    const key = [instanceId, projectId, resourceIdentity, generation].join("/");
    let identity = identities.get(key);
    if (!identity) {
      identity = createIdentity("client_identity");
      identities.set(key, identity);
    }
    return identity;
  };
  const f = enablementFixture(t, {
    instanceIssuer: {
      ...fakeCollaborations.instanceIssuer,
      clientIdentity: clientIdentityOf,
    },
    workerBindingOf: (_tx, _project, resourceIdentity) => {
      const pool = state.bindings.find(
        (item) => item.resource_identity === resourceIdentity,
      );
      return pool ? binding(pool, null) : null;
    },
    workerBindingsOf: bindingsOf,
    instanceArchive: {
      revokeForInstanceArchive: (_tx, executionId) => {
        state.revoked.push(executionId);
        return { lost: [], revoked: [] };
      },
      revokePausedClaim: () => null,
      executionReleased: () => {},
      reportExecutionEnds: () => {
        state.reported++;
      },
    },
    schedulerClaims: {
      ...fakeCollaborations.schedulerClaims,
      unendedExecutionOf: (_tx, runtimeIdentity) =>
        state.executing.has(runtimeIdentity)
          ? { execution_id: POOL_EXECUTION }
          : null,
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
      workerBindingsOf: bindingsOf,
      logger: pino({ level: "error" }, { write: (line) => logs.push(line) }),
    },
    ...collaborations,
  });
  function addInstance(
    name: string,
    placement: InstancePlacement = InstancePlacement.Server,
    listedBy: string[] = [POOL_RESOURCE],
  ) {
    const id = f.store.transaction(
      (tx) =>
        insertInstance(
          tx,
          {
            name,
            worker: WORKER,
            placement,
            machine:
              placement === InstancePlacement.Worker
                ? insertMachineFor(tx, name, clock)
                : null,
            public_key: null,
            fingerprint: null,
          },
          ++clock,
        ).id,
    );
    instanceIds.set(name, id);
    for (const pool of state.bindings)
      if (listedBy.includes(pool.resource_identity)) pool.listed.push(name);
    return id;
  }
  for (let index = 0; index < instanceCount; index++)
    addInstance(`server-${index}`);
  const nameOf = (index: number) => `server-${index}`;
  const clientOf = (name: string, resourceIdentity = POOL_RESOURCE): string => {
    return clientIdentityOf(
      instanceIds.get(name)!,
      POOL_PROJECT,
      resourceIdentity,
      state.generation,
    );
  };
  function registerAs(
    clientId: string,
    instanceId: string | undefined,
    resourceIdentity = POOL_RESOURCE,
  ) {
    f.caller.identity = testMachineIdentity(
      {
        clientId,
        name: instanceId === undefined ? "stranger" : "coder-1",
        resourceIdentity,
        projectId: POOL_PROJECT,
        issuedAt: Date.now(),
        ...(instanceId === undefined ? {} : { instanceId }),
      },
      "session",
    );
    return workerOperations.register.output.parse(
      f.registry
        .get(workerOperations.register.id)
        .handler({ params: {}, query: {}, body: null }, f.caller),
    );
  }
  function register(index: number, resourceIdentity = POOL_RESOURCE) {
    const name = nameOf(index);
    return registerAs(
      clientOf(name, resourceIdentity),
      instanceIds.get(name),
      resourceIdentity,
    );
  }
  const unlist = (index: number, resourceIdentity = POOL_RESOURCE) => {
    const pool = state.bindings.find(
      (item) => item.resource_identity === resourceIdentity,
    )!;
    pool.listed = pool.listed.filter((name) => name !== nameOf(index));
  };
  const archive = (index: number) =>
    f.store.transaction((tx) =>
      endInstance(tx, instanceIds.get(nameOf(index))!, ++clock),
    );
  return {
    ...f,
    host,
    state,
    logs,
    register,
    registerAs,
    addInstance,
    clientOf,
    nameOf,
    unlist,
    archive,
    instanceIdOf: (index: number) => instanceIds.get(nameOf(index))!,
  };
}

test("the pool starts at startPool and a change notice before it does nothing", async (t) => {
  const f = poolFixture(t, 2);
  f.worker.bindingsChanged(POOL_PROJECT);
  f.worker.instancesChanged();
  await changesApplied();
  assert.equal(f.host.started.length, NO_STARTS);
  f.worker.startPool();
  assert.deepEqual(
    f.host.started.map(({ instance }) => instance.name),
    ["server-0", "server-1"],
  );
  f.worker.startPool();
  assert.equal(f.host.started.length, POOL_TWO_STARTS);
});

test("startPool prepares the pool host once when no instance is live", (t) => {
  const f = poolFixture(t, 0);
  f.worker.startPool();
  f.worker.startPool();
  assert.equal(f.host.prepared, POOL_ONE_START);
  assert.equal(f.host.started.length, NO_STARTS);
});

const ARCHIVED_AT = 1751566593132;

test("startPool sweeps with the name of each archived server and container instance and no live or worker instance", (t) => {
  const f = poolFixture(t, 2);
  const end = (id: string) =>
    f.store.transaction((tx) => endInstance(tx, id, ARCHIVED_AT));
  end(f.addInstance("gone", InstancePlacement.Server, []));
  end(f.addInstance("boxed", InstancePlacement.Container, []));
  end(f.addInstance("laptop", InstancePlacement.Worker, []));
  f.archive(FIRST_INSTANCE);
  f.store.transaction((tx) =>
    insertInstance(
      tx,
      {
        name: f.nameOf(FIRST_INSTANCE),
        worker: WORKER,
        revision: FIRST_REVISION + 1,
        placement: InstancePlacement.Worker,
        machine: insertMachineFor(tx, f.nameOf(FIRST_INSTANCE), ARCHIVED_AT),
        public_key: null,
        fingerprint: null,
      },
      ARCHIVED_AT,
    ),
  );
  f.worker.startPool();
  assert.equal(f.host.swept.length, POOL_ONE_START);
  assert.deepEqual([...f.host.swept[0]!].sort(), ["boxed", "gone"]);
});

test("startPool starts an instance that no binding lists with no entry", (t) => {
  const f = poolFixture(t, 0);
  f.addInstance("idle", InstancePlacement.Server, []);
  f.worker.startPool();
  assert.deepEqual(
    f.host.started.map(({ instance, entries }) => [instance.name, entries]),
    [["idle", []]],
  );
  assert.deepEqual(f.store.transaction(readAllLive), []);
});

test("a binding write sends the entries of the running instances and starts none", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  assert.deepEqual(
    f.host.started[0]!.entries.map(({ state }) => state),
    [BindingEntryState.Serving],
  );
  f.state.bindings.push({
    resource_identity: OTHER_POOL_RESOURCE,
    environment: null,
    listed: [f.nameOf(FIRST_INSTANCE)],
  });
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  assert.equal(f.host.started.length, POOL_ONE_START);
  assert.deepEqual(
    f.host.updated[0]!.entries.map(
      ({ resource_identity }) => resource_identity,
    ),
    [POOL_RESOURCE, OTHER_POOL_RESOURCE],
  );
});

test("an instance create starts one and an archive stops one after the change notice", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  f.addInstance("server-1");
  f.worker.instancesChanged();
  await changesApplied();
  assert.deepEqual(
    f.host.started.map(({ instance }) => instance.name),
    ["server-0", "server-1"],
  );
  f.archive(FIRST_INSTANCE);
  f.worker.instancesChanged();
  await changesApplied();
  assert.deepEqual(
    f.host.archived.map(({ name }) => name),
    ["server-0"],
  );
});

test("a forced archive of a busy server instance revokes its execution and stops the instance after the commit", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  const registration = f.register(FIRST_INSTANCE);
  f.state.executing.add(registration.runtime_identity);
  f.unlist(FIRST_INSTANCE);
  f.caller.identity = FOOTPRINT_HUMAN;
  const archive = (force?: boolean) =>
    f.invoke(
      "instance.archive",
      { expected_revision: FIRST_REVISION, force },
      { instance_name: f.nameOf(FIRST_INSTANCE) },
    );
  assert.throws(
    () => archive(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === WorkerErrorCode.InstanceInUse,
  );
  assert.deepEqual(f.state.revoked, []);
  assert.deepEqual(f.host.archived, []);
  archive(true);
  assert.deepEqual(f.state.revoked, [POOL_EXECUTION]);
  assert.equal(f.state.reported, POOL_ONE_START);
  await changesApplied();
  assert.deepEqual(
    f.host.archived.map(({ name }) => name),
    [f.nameOf(FIRST_INSTANCE)],
  );
});

test("a deferred archive end drops the heartbeat entries of the ended registrations and schedules a reconcile", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  const registration = f.register(FIRST_INSTANCE);
  f.state.executing.add(registration.runtime_identity);
  f.unlist(FIRST_INSTANCE);
  f.caller.identity = FOOTPRINT_HUMAN;
  assert.ok(
    f.worker.instances.holdConnection(
      f.instanceIdOf(FIRST_INSTANCE),
      createIdentity("connection"),
    ),
  );
  const archived = f.invoke(
    "instance.archive",
    { expected_revision: FIRST_REVISION, force: true },
    { instance_name: f.nameOf(FIRST_INSTANCE) },
  );
  assert.deepEqual(archived.stopping, [POOL_EXECUTION]);
  assert.deepEqual(f.state.revoked, []);
  await changesApplied();
  assert.deepEqual(f.host.archived, []);
  assert.ok(
    f.worker.heartbeatClock
      .identities()
      .includes(registration.runtime_identity),
  );
  f.worker.executionReleased(POOL_EXECUTION);
  assert.equal(
    f.worker.heartbeatClock
      .identities()
      .includes(registration.runtime_identity),
    false,
  );
  await changesApplied();
  assert.deepEqual(
    f.host.archived.map(({ name }) => name),
    [f.nameOf(FIRST_INSTANCE)],
  );
});

test("an instance at the worker placement is not hosted", (t) => {
  const f = poolFixture(t, 0);
  f.addInstance("laptop", InstancePlacement.Worker);
  f.worker.startPool();
  assert.equal(f.host.started.length, NO_STARTS);
});

test("a client identity that the binding does not list for an instance refuses with placement_mismatch", (t) => {
  const f = poolFixture(t, 2);
  f.worker.startPool();
  const instanceId = f.instanceIdOf(FIRST_INSTANCE);
  const clientId = f.clientOf(f.nameOf(FIRST_INSTANCE));
  refuses(
    () => f.registerAs(createIdentity("client_identity"), instanceId),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
  refuses(
    () => f.registerAs(clientId, undefined),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
  f.unlist(FIRST_INSTANCE);
  refuses(
    () => f.register(FIRST_INSTANCE),
    WorkerErrorCode.PlacementMismatch,
    HttpStatus.Conflict,
  );
});

test("a registration resumes under the same identity after its instance leaves the list and its healthcheck fails", (t) => {
  const f = poolFixture(t, 1);
  f.invokeAgent("enablement.put", putBody);
  f.worker.startPool();
  const first = f.register(FIRST_INSTANCE);
  const healthy = () =>
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, first.runtime_identity),
    );
  assert.equal(healthy(), true);
  f.unlist(FIRST_INSTANCE);
  assert.deepEqual(f.register(FIRST_INSTANCE), first);
  assert.equal(healthy(), false);
  assert.equal(
    f.invoke("registration.list", null, {}).items[0]?.draining,
    true,
  );
});

test("one server instance that two bindings list holds two registrations that one execution covers", (t) => {
  const f = poolFixture(t, 1);
  f.state.bindings.push({
    resource_identity: OTHER_POOL_RESOURCE,
    environment: null,
    listed: [f.nameOf(FIRST_INSTANCE)],
  });
  f.worker.startPool();
  const first = f.register(FIRST_INSTANCE);
  const second = f.register(FIRST_INSTANCE, OTHER_POOL_RESOURCE);
  assert.notEqual(first.runtime_identity, second.runtime_identity);
  const rows = f.store.transaction(readAllLive);
  assert.deepEqual(
    rows.map((row) => row.instance_id),
    [f.instanceIdOf(FIRST_INSTANCE), f.instanceIdOf(FIRST_INSTANCE)],
  );
  const covered = (runtimeIdentity: string) =>
    f.store.transaction((tx) =>
      f.worker.registrationsOfInstance(tx, runtimeIdentity),
    );
  assert.deepEqual(covered(first.runtime_identity), [second.runtime_identity]);
  assert.deepEqual(covered(second.runtime_identity), [first.runtime_identity]);
});

test("a binding that drops an instance with a live registration keeps a draining entry for it", async (t) => {
  const f = poolFixture(t, 2);
  f.worker.startPool();
  f.register(FIRST_INSTANCE);
  f.unlist(FIRST_INSTANCE);
  f.worker.bindingsChanged(POOL_PROJECT);
  await changesApplied();
  const update = f.host.updated.find(
    ({ instance }) => instance.name === f.nameOf(FIRST_INSTANCE),
  );
  assert.deepEqual(
    update!.entries.map(({ state }) => state),
    [BindingEntryState.Draining],
  );
  assert.equal(
    f.host.updated.some(
      ({ instance }) => instance.name === f.nameOf(SECOND_INSTANCE),
    ),
    false,
  );
});

test("a registration record shows the placement and the drain flag of its instance", (t) => {
  const f = poolFixture(t, 2);
  f.worker.startPool();
  f.register(FIRST_INSTANCE);
  f.register(SECOND_INSTANCE);
  f.unlist(SECOND_INSTANCE);
  const items = f.invoke("registration.list", null, {}).items;
  const byClient = new Map(items.map((item) => [item.client_id, item]));
  const first = byClient.get(f.clientOf(f.nameOf(FIRST_INSTANCE)));
  assert.equal(first?.placement, InstancePlacement.Server);
  assert.equal(first?.draining, false);
  assert.equal(
    byClient.get(f.clientOf(f.nameOf(SECOND_INSTANCE)))?.draining,
    true,
  );
});

test("stopPool stops the host and ignores later change notices", async (t) => {
  const f = poolFixture(t, 1);
  f.worker.startPool();
  await f.worker.stopPool();
  assert.ok(f.host.stopped);
  f.addInstance("server-1");
  f.worker.instancesChanged();
  await changesApplied();
  assert.equal(f.host.started.length, POOL_ONE_START);
});

test("an unlisted instance registration gets no claim while its running execution stays answerable", (t) => {
  const f = poolFixture(t, 2);
  f.invokeAgent("enablement.put", putBody);
  f.worker.startPool();
  const active = f.register(FIRST_INSTANCE).runtime_identity;
  const dropped = f.register(SECOND_INSTANCE).runtime_identity;
  const healthy = (runtimeIdentity: string) =>
    f.store.transaction((tx) =>
      f.worker.registrationHealthcheck(tx, runtimeIdentity),
    );
  assert.equal(healthy(active), true);
  assert.equal(healthy(dropped), true);
  f.unlist(SECOND_INSTANCE);
  assert.equal(healthy(active), true);
  assert.equal(healthy(dropped), false);
});

test("a restart of the server keeps the draining entry of a live registration of an unlisted instance", (t) => {
  const f = poolFixture(t, 2);
  f.register(THIRD_INSTANCE - 1);
  f.unlist(SECOND_INSTANCE);
  f.worker.startPool();
  const entries = f.host.started.find(
    ({ instance }) => instance.name === f.nameOf(SECOND_INSTANCE),
  )!.entries;
  assert.deepEqual(
    entries.map(({ state }) => state),
    [BindingEntryState.Draining],
  );
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
const ONE_SESSION_READ = 1;
const NO_STATUS_READS = 0;
const UNAVAILABLE_CONTAINER = {
  placement: InstancePlacement.Container,
  available: false,
  reason: PlacementIssue.RuntimeFailed,
  detail: "Cannot connect to Podman.",
  container_runtime: ContainerRuntime.Podman,
} satisfies PlacementStatus;

async function loggedAfterStart(f: ReturnType<typeof poolFixture>) {
  f.worker.startPool();
  await changesApplied();
  return f.logs.filter((line) => /worker\.pool\.driver_unavailable/.test(line));
}

test("start with an unavailable runtime and a live container instance logs the driver once and starts the pool", async (t) => {
  const f = poolFixture(t, 0);
  f.addInstance("boxed", InstancePlacement.Container);
  f.host.statuses.set(PoolPlacement.Container, UNAVAILABLE_CONTAINER);
  const lines = await loggedAfterStart(f);
  assert.equal(lines.length, DRIVER_RECORDS);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.placement, InstancePlacement.Container);
  assert.equal(record.reason, PlacementIssue.RuntimeFailed);
  assert.equal(record.detail, UNAVAILABLE_CONTAINER.detail);
  assert.equal(f.host.started.length, POOL_ONE_START);
});

test("start checks no runtime when no live instance holds the container placement", async (t) => {
  const f = poolFixture(t, 1);
  f.host.statuses.set(PoolPlacement.Container, UNAVAILABLE_CONTAINER);
  assert.deepEqual(await loggedAfterStart(f), []);
  assert.equal(f.host.statusReads, NO_STATUS_READS);
});

const READY_ENVIRONMENT = "repository:github:Acme/app";
const READY_TAG = "localhost/kanthord-env/app:ready";
const STALE_TAG = "localhost/kanthord-env/app:stale";

test("environmentReady restarts each container instance of the environment on another image", (t) => {
  const f = poolFixture(t, 0);
  f.addInstance("box-0", InstancePlacement.Container);
  f.addInstance("box-1", InstancePlacement.Container);
  f.addInstance("box-2", InstancePlacement.Container);
  f.state.bindings[0]!.environment = READY_ENVIRONMENT;
  f.worker.startPool();
  f.host.images.set("box-0", READY_TAG);
  f.host.images.set("box-1", STALE_TAG);
  f.worker.environmentReady(POOL_PROJECT, READY_ENVIRONMENT, READY_TAG);
  assert.deepEqual(
    f.host.restarted.map(({ name }) => name),
    ["box-1", "box-2"],
  );
});

test("environmentReady keeps the instances of another repository binding and of a server instance", (t) => {
  const f = poolFixture(t, 0);
  f.addInstance("box-0", InstancePlacement.Container);
  f.addInstance("box-1", InstancePlacement.Container, [OTHER_POOL_RESOURCE]);
  f.addInstance("server-0", InstancePlacement.Server);
  f.state.bindings[0]!.environment = READY_ENVIRONMENT;
  f.state.bindings.push({
    resource_identity: OTHER_POOL_RESOURCE,
    environment: "repository:github:Acme/other",
    listed: ["box-1"],
  });
  f.worker.startPool();
  f.worker.environmentReady(POOL_PROJECT, READY_ENVIRONMENT, READY_TAG);
  assert.deepEqual(
    f.host.restarted.map(({ name }) => name),
    ["box-0"],
  );
});

const FIRST_HANDOVER_ATTEMPT = 1;
const TWO_HANDOVER_ATTEMPTS = 2;

function refreshingHandoverFixture(
  t: TestContext,
  handover: () => { nonce: string; ciphertext: string },
  collaborations: Partial<Dependencies> = {},
) {
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
  const f = enablementFixture(t, {
    repositoryBindingIdsOf: () => [],
    workerBindingRowOf: () => null,
    custodyHandover: {
      ...fakeCollaborations.custodyHandover,
      handover,
    },
    ...collaborations,
  });
  return (executionId = execution.executionId) =>
    f.registry
      .get(workerOperations.handover.id)
      .handler(
        { params: {}, query: {}, body: { execution_id: executionId } },
        { ...f.caller, identity, execution: { ...execution, executionId } },
      );
}

test("a handover that meets an in-flight credential refresh waits for the refresh to settle and then answers the envelope", async (t) => {
  const envelope = { nonce: "nonce", ciphertext: "ciphertext" };
  let release = () => {};
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const invoke = refreshingHandoverFixture(t, () => {
    attempts++;
    if (attempts === FIRST_HANDOVER_ATTEMPT)
      throw new CredentialRefreshInFlight(settled);
    return envelope;
  });
  const answer = invoke();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, FIRST_HANDOVER_ATTEMPT);
  release();
  assert.deepEqual(await answer, envelope);
  assert.equal(attempts, TWO_HANDOVER_ATTEMPTS);
});

test("a handover whose credential refresh outlasts the wait answers 503 worker.handover.refresh_in_flight before the route timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let attempts = 0;
  const invoke = refreshingHandoverFixture(t, () => {
    attempts++;
    throw new CredentialRefreshInFlight(new Promise<void>(() => {}));
  });
  const answer = invoke();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(HANDOVER_REFRESH_WAIT_MS);
  await assert.rejects(
    async () => {
      await answer;
    },
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.ServiceUnavailable &&
      error.code === WorkerErrorCode.HandoverRefreshInFlight,
  );
  assert.equal(attempts, FIRST_HANDOVER_ATTEMPT);
});

test("the credential lease operation maps CredentialLeaseHeld to 503 worker.credential.lease_held and answers the lease envelope otherwise", async (t) => {
  const credentialId = createIdentity("credential");
  const envelope = { nonce: "nonce", ciphertext: "ciphertext" };
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
  const now = 1000;
  t.mock.method(Date, "now", () => now);
  let held = true;
  const f = enablementFixture(t, {
    custodyHandover: {
      ...fakeCollaborations.custodyHandover,
      lease: (tx, actualIdentity, actualClaim, actualCredential, actualNow) => {
        assert(tx.database.isTransaction);
        assert.equal(actualIdentity, identity);
        assert.equal(actualClaim, execution);
        assert.equal(actualCredential, credentialId);
        assert.equal(actualNow, now);
        if (held) throw new CredentialLeaseHeld();
        return envelope;
      },
    },
  });
  const invoke = () =>
    f.registry.get(workerOperations["credential.lease"].id).handler(
      {
        params: {},
        query: {},
        body: {
          execution_id: execution.executionId,
          credential_id: credentialId,
        },
      },
      { ...f.caller, identity, execution },
    );
  await assert.rejects(
    async () => invoke(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.ServiceUnavailable &&
      error.code === WorkerErrorCode.CredentialLeaseHeld,
  );
  held = false;
  assert.deepEqual(await invoke(), envelope);
});

const NAMED_BINDING = createIdentity("binding");
const OTHER_NAMED_BINDING = createIdentity("binding");
const UNNAMED_BINDING = createIdentity("binding");
const HEAD = "a".repeat(40);
const SLOW_REMOTE_MS = 15000;
const SSH_UNREACHABLE_STATUS = 422;

function memoryPromptPins() {
  let stored: PromptCommits | null = null;
  const answered: PromptCommits[] = [];
  const pins: MissionPromptPins = {
    attemptPromptCommits: (tx, nodeId, attempt) => {
      assert.equal(attempt, FIRST_HANDOVER_ATTEMPT);
      assert.ok(nodeId.startsWith("node_"));
      return stored;
    },
    pinPromptCommits: (tx, _nodeId, attempt, commits) => {
      assert(tx.database.isTransaction);
      assert.equal(attempt, FIRST_HANDOVER_ATTEMPT);
      stored ??= commits;
      answered.push(stored);
      return stored;
    },
  };
  return { pins, answered, stored: () => stored };
}

function promptBaseOf(
  baseCommitOf: PromptBase["baseCommitOf"],
  named: readonly string[] = [NAMED_BINDING, OTHER_NAMED_BINDING],
): PromptBase {
  return {
    instructionBindingsOf: (tx, bindingIds) => {
      assert(tx.database.isTransaction);
      return bindingIds.filter((id) => named.includes(id));
    },
    baseCommitOf,
    instructionFileOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
  };
}

const PROMPT_BINDINGS = () => [
  NAMED_BINDING,
  UNNAMED_BINDING,
  OTHER_NAMED_BINDING,
];

test("a head read failure answers ssh_unreachable and pins nothing", async (t) => {
  const memory = memoryPromptPins();
  const unreachable = new OperationError(
    SSH_UNREACHABLE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    "The remote is unreachable.",
    { failure_reason: "timeout" },
  );
  const invoke = refreshingHandoverFixture(
    t,
    () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    {
      repositoryBindingIdsOf: PROMPT_BINDINGS,
      missionPromptPins: memory.pins,
      promptBase: promptBaseOf(async () => {
        throw unreachable;
      }),
    },
  );
  await assert.rejects(
    async () => {
      await invoke();
    },
    (error: unknown) => error === unreachable,
  );
  assert.equal(memory.stored(), null);
});

test("a head read takes at most its budget of the one handover deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const memory = memoryPromptPins();
  const invoke = refreshingHandoverFixture(
    t,
    () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    {
      repositoryBindingIdsOf: PROMPT_BINDINGS,
      missionPromptPins: memory.pins,
      promptBase: promptBaseOf(
        (_bindingId, context) =>
          new Promise((_resolve, reject) => {
            assert.equal(context.deadline, Date.now() + PROMPT_SOURCE_READ_MS);
            context.signal.addEventListener("abort", () =>
              reject(
                new OperationError(
                  SSH_UNREACHABLE_STATUS,
                  ProjectErrorCode.RepositorySshUnreachable,
                  "The remote is unreachable.",
                ),
              ),
            );
          }),
        [NAMED_BINDING],
      ),
    },
  );
  const answer = invoke();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PROMPT_SOURCE_READ_MS);
  await assert.rejects(
    async () => {
      await answer;
    },
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.RepositorySshUnreachable,
  );
  assert.equal(memory.stored(), null);
});

test("a slow remote together with a credential refresh in flight ends within the handover timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const started = Date.now();
  const memory = memoryPromptPins();
  let attempts = 0;
  const invoke = refreshingHandoverFixture(
    t,
    () => {
      attempts++;
      throw new CredentialRefreshInFlight(new Promise<void>(() => {}));
    },
    {
      repositoryBindingIdsOf: PROMPT_BINDINGS,
      missionPromptPins: memory.pins,
      promptBase: promptBaseOf(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(HEAD), SLOW_REMOTE_MS),
          ),
        [NAMED_BINDING],
      ),
    },
  );
  let settledAt: number | null = null;
  const answer = Promise.resolve(invoke()).finally(() => {
    settledAt = Date.now();
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(SLOW_REMOTE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, FIRST_HANDOVER_ATTEMPT);
  t.mock.timers.tick(HANDOVER_REFRESH_WAIT_MS - SLOW_REMOTE_MS);
  await assert.rejects(
    answer,
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === WorkerErrorCode.HandoverRefreshInFlight,
  );
  assert.equal(settledAt, started + HANDOVER_REFRESH_WAIT_MS);
  assert.ok(settledAt! - started < HANDOVER_TIMEOUT_MS);
});

const SESSION_READ: SessionRead = {
  execution_id: POOL_EXECUTION,
  session_id: "0123456789abcdef",
  entry_id: "a1b2c3d4",
  entry_type: "message",
};
const SESSION_SECRET = "full-entry-secret";
const readSignal = new AbortController().signal;

function registrationOf(
  f: ReturnType<typeof poolFixture>,
  instanceId: string | null,
): string {
  return f.store.transaction(
    (tx) =>
      insertRegistration(
        tx,
        {
          client_id: createIdentity("client_identity"),
          name: "coder-1",
          resource_identity: POOL_RESOURCE,
          project_id: POOL_PROJECT,
          instance_id: instanceId,
        },
        Date.now(),
      ).runtime_identity,
  );
}

test("a session read of an unknown execution or of a registration without an instance answers instance_unknown", async (t) => {
  const f = poolFixture(t, 1);
  const unknown = {
    session_absent: SessionAbsentReason.InstanceUnknown,
    instance: null,
    placement: null,
  };
  assert.deepEqual(
    await f.worker.readSessionEntry(null, SESSION_READ, readSignal),
    unknown,
  );
  assert.deepEqual(
    await f.worker.readSessionEntry(
      createIdentity("worker_registration"),
      SESSION_READ,
      readSignal,
    ),
    unknown,
  );
  assert.deepEqual(
    await f.worker.readSessionEntry(
      registrationOf(f, null),
      SESSION_READ,
      readSignal,
    ),
    unknown,
  );
  assert.equal(f.host.sessionReads.length, NO_STARTS);
});

test("a session read of an archived instance answers archived with its name and placement", async (t) => {
  const f = poolFixture(t, 1);
  const runtime = registrationOf(f, f.instanceIdOf(FIRST_INSTANCE));
  f.archive(FIRST_INSTANCE);
  assert.deepEqual(
    await f.worker.readSessionEntry(runtime, SESSION_READ, readSignal),
    {
      session_absent: SessionAbsentReason.Archived,
      instance: f.nameOf(FIRST_INSTANCE),
      placement: InstancePlacement.Server,
    },
  );
  assert.equal(f.host.sessionReads.length, NO_STARTS);
});

test("a session read of a server instance reads the pool host and answers its result", async (t) => {
  const f = poolFixture(t, 1);
  const runtime = registrationOf(f, f.instanceIdOf(FIRST_INSTANCE));
  const entry = { type: "message", id: SESSION_READ.entry_id, text: "full" };
  f.host.sessionReadResult = { outcome: SessionReadOutcome.Resolved, entry };
  assert.deepEqual(
    await f.worker.readSessionEntry(runtime, SESSION_READ, readSignal),
    {
      result: { outcome: SessionReadOutcome.Resolved, entry },
      instance: f.nameOf(FIRST_INSTANCE),
      placement: InstancePlacement.Server,
    },
  );
  assert.deepEqual(
    f.host.sessionReads.map(({ instance, read }) => [instance.name, read]),
    [[f.nameOf(FIRST_INSTANCE), SESSION_READ]],
  );
  f.host.sessionReadResult = { outcome: SessionReadOutcome.TooLarge, bytes: 9 };
  assert.deepEqual(
    await f.worker.readSessionEntry(runtime, SESSION_READ, readSignal),
    {
      result: { outcome: SessionReadOutcome.TooLarge, bytes: 9 },
      instance: f.nameOf(FIRST_INSTANCE),
      placement: InstancePlacement.Server,
    },
  );
});

test("a resolved entry with another id or type answers unreadable and the log record holds no entry content", async (t) => {
  const f = poolFixture(t, 1);
  const runtime = registrationOf(f, f.instanceIdOf(FIRST_INSTANCE));
  const mismatches = [
    { type: "message", id: "e5f6a7b8", secret: SESSION_SECRET },
    { type: "custom", id: SESSION_READ.entry_id, secret: SESSION_SECRET },
  ];
  for (const entry of mismatches) {
    f.host.sessionReadResult = { outcome: SessionReadOutcome.Resolved, entry };
    assert.deepEqual(
      await f.worker.readSessionEntry(runtime, SESSION_READ, readSignal),
      {
        result: { outcome: SessionReadOutcome.Unreadable },
        instance: f.nameOf(FIRST_INSTANCE),
        placement: InstancePlacement.Server,
      },
    );
  }
  const records = f.logs.filter((line) =>
    line.includes("worker.session_read.entry_mismatch"),
  );
  assert.equal(records.length, mismatches.length);
  for (const line of records) {
    assert.ok(!line.includes(SESSION_SECRET), line);
    assert.ok(line.includes(SESSION_READ.entry_id), line);
  }
});

test("a session read of a worker instance answers offline and reads no pool host", async (t) => {
  const f = poolFixture(t, 0);
  const placement = InstancePlacement.Worker;
  const runtime = registrationOf(
    f,
    f.addInstance(`box-${placement}`, placement),
  );
  assert.deepEqual(
    await f.worker.readSessionEntry(runtime, SESSION_READ, readSignal),
    {
      unreachable: UnreachableReason.Offline,
      instance: `box-${placement}`,
      placement,
    },
  );
  assert.equal(f.host.sessionReads.length, NO_STARTS);
});

test("a session read of a connected worker instance waits for its report and answers unreadable for another entry", async (t) => {
  const f = poolFixture(t, 0);
  const instanceId = f.addInstance("laptop", InstancePlacement.Worker);
  const runtime = registrationOf(f, instanceId);
  const connectionId = createIdentity("connection");
  f.worker.instances.holdConnection(instanceId, connectionId);
  const target = { instance: "laptop", placement: InstancePlacement.Worker };
  const outcomes = [
    {
      report: {
        outcome: SessionReadOutcome.Resolved,
        entry: { id: SESSION_READ.entry_id, type: SESSION_READ.entry_type },
      },
      answer: {
        outcome: SessionReadOutcome.Resolved,
        entry: { id: SESSION_READ.entry_id, type: SESSION_READ.entry_type },
      },
    },
    {
      report: {
        outcome: SessionReadOutcome.Resolved,
        entry: { id: "e5f6a7b8", type: SESSION_READ.entry_type },
      },
      answer: { outcome: SessionReadOutcome.Unreadable },
    },
  ];
  for (const { report, answer } of outcomes) {
    const waiting = f.worker.readSessionEntry(
      runtime,
      SESSION_READ,
      readSignal,
    );
    const [pending] = f.worker.instances.work(
      instanceId,
      "laptop",
      connectionId,
    ).session_reads;
    f.worker.instances.reportSessionRead(instanceId, pending!.read_id, report);
    assert.deepEqual(await waiting, { result: answer, ...target });
  }
  assert.equal(f.host.sessionReads.length, NO_STARTS);
});

test("a session read of a container instance reads the pool host", async (t) => {
  const f = poolFixture(t, 0);
  const placement = InstancePlacement.Container;
  const runtime = registrationOf(
    f,
    f.addInstance(`box-${placement}`, placement),
  );
  const answer = await f.worker.readSessionEntry(
    runtime,
    SESSION_READ,
    readSignal,
  );
  assert.equal(f.host.sessionReads.length, ONE_SESSION_READ);
  assert.equal(f.host.sessionReads[0]!.instance.placement, placement);
  assert.deepEqual(
    { instance: answer.instance, placement: answer.placement },
    { instance: `box-${placement}`, placement },
  );
});

const SLOT_REQUESTER = {
  kind: "human",
  account: "ulrich",
  name: "Ulrich",
} as const;

test("slot_image.delete refuses requested_by from a human caller and refuses the configured image from the Footprint service identity", async (t) => {
  const f = poolFixture(t, 0);
  const configured = `docker.io/kanthorlabs/kanthord:${packageVersion()}`;
  const old = "docker.io/kanthorlabs/kanthord:0.0.1";
  f.host.usage = {
    runtime: ContainerRuntime.Podman,
    images: [
      {
        id: `sha256:${"1".repeat(64)}`,
        references: [configured],
        created_at: 1,
        unique_bytes: 1,
        containers: 0,
      },
      {
        id: `sha256:${"2".repeat(64)}`,
        references: [old],
        created_at: 1,
        unique_bytes: 1,
        containers: 0,
      },
    ],
    volumes: [],
  };
  const operation = workerOperations["slot_image.delete"];
  const input = operation.input.parse({
    params: {},
    query: {},
    body: { references: [configured, old], requested_by: SLOT_REQUESTER },
  });
  await assert.rejects(
    async () =>
      f.registry.get(operation.id).handler(input, {
        ...f.caller,
        identity: testHumanIdentity("alice", "Alice", "jti"),
      }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      JSON.stringify(error.details) ===
        JSON.stringify([{ path: ["body", "requested_by"], code: "custom" }]),
  );
  const answer = await f.registry.get(operation.id).handler(input, {
    ...f.caller,
    identity: testServiceIdentity(FOOTPRINT_SERVICE),
  });
  assert.deepEqual(answer, {
    removed: 1,
    absent: 0,
    refused: [{ key: configured, reason: "live" }],
  });
  assert.deepEqual(f.host.removedImages, [old]);
});

const FOOTPRINT_HUMAN = testHumanIdentity("alice", "Alice", "jti");
const TOOL_OUTPUT_KEY = "pi-bash-0123456789abcdef.log";
const STDERR_ITEM = { key: "stderr.log", bytes: 7, modified_at: 3 };
const SESSION_ITEM_BYTES = 11;

function footprintKind(kind: InstanceFootprintKind, bytes: number) {
  return {
    kind,
    count: 1,
    bytes,
    oldest_at: 1,
    newest_at: 1,
    recent_count: 1,
    items: [{ key: `${kind}-item`, bytes, modified_at: 1 }],
    items_complete: true,
  };
}

function footprintPool(t: TestContext) {
  const measured: unknown[] = [];
  const settled: string[] = [];
  const ends = new Map<string, number | null>();
  const f = poolFixture(t, 1, {
    footprint: {
      recordMeasurement: (_tx, _name, _placement, measurement) => {
        measured.push(measurement);
      },
      recordResults: (_tx, _name, results) =>
        results.map((result) => result.cleanup_id),
      settleMeasurement: (name) => {
        settled.push(name);
      },
      instanceArchived: () => {},
    },
    executionEndTimes: (_tx, executionIds) =>
      new Map(
        executionIds.flatMap((id) =>
          ends.has(id) ? [[id, ends.get(id)!] as const] : [],
        ),
      ),
  });
  const invoke = async <K extends keyof typeof workerOperations>(
    key: K,
    body: unknown,
    params: Record<string, string> = {},
  ) => {
    const operation = workerOperations[key];
    return operation.output.parse(
      await f.registry
        .get(operation.id)
        .handler(operation.input.parse({ params, query: {}, body }), f.caller),
    ) as (typeof workerOperations)[K]["output"]["_output"];
  };
  return { ...f, measured, settled, ends, invoke };
}

test("a server footprint report drops the session kind and the disk, adds stderr.log and answers the orders of the instance", async (t) => {
  const f = footprintPool(t);
  f.host.stderrLog = STDERR_ITEM;
  const cleanupId = createIdentity("cleanup");
  f.caller.identity = FOOTPRINT_HUMAN;
  await f.invoke(
    "instance.tool_output.delete",
    { cleanup_id: cleanupId, keys: [TOOL_OUTPUT_KEY] },
    { instance_name: f.nameOf(FIRST_INSTANCE) },
  );
  f.register(FIRST_INSTANCE);
  const answer = await f.invoke("footprint.report", {
    measurement: {
      measured_at: 1,
      disk: { device: "1", total_bytes: 2, free_bytes: 1 },
      kinds: [
        footprintKind(InstanceFootprintKind.Session, 1),
        footprintKind(InstanceFootprintKind.Log, 1),
      ],
    },
    results: [],
  });
  assert.deepEqual(answer, {
    orders: [
      {
        cleanup_id: cleanupId,
        kind: InstanceCleanableKind.ToolOutput,
        keys: [TOOL_OUTPUT_KEY],
      },
    ],
  });
  const log = footprintKind(InstanceFootprintKind.Log, 1);
  assert.deepEqual(f.measured, [
    {
      measured_at: 1,
      disk: null,
      kinds: [
        {
          ...log,
          count: log.count + 1,
          bytes: log.bytes + STDERR_ITEM.bytes,
          items: [...log.items, STDERR_ITEM],
        },
      ],
    },
  ]);
  assert.deepEqual(f.settled, [f.nameOf(FIRST_INSTANCE)]);
});

test("a server session delete refuses a live execution, answers an unreadable directory and removes an ended one", async (t) => {
  const f = footprintPool(t);
  const name = f.nameOf(FIRST_INSTANCE);
  const live = createIdentity("execution");
  const ended = createIdentity("execution");
  const unreadable = createIdentity("execution");
  const absent = createIdentity("execution");
  f.ends.set(live, null);
  f.ends.set(ended, 1);
  f.ends.set(unreadable, 1);
  f.host.sessions.set(name, [
    { key: ended, bytes: SESSION_ITEM_BYTES, modified_at: 1 },
    { key: live, bytes: 1, modified_at: 1 },
  ]);
  f.host.unreadableSessions.add(unreadable);
  f.caller.identity = FOOTPRINT_HUMAN;
  const answer = await f.invoke(
    "instance.session.delete",
    {
      cleanup_id: createIdentity("cleanup"),
      execution_ids: [live, ended, unreadable, absent],
    },
    { instance_name: name },
  );
  assert.deepEqual(answer, {
    removed: 1,
    removed_bytes: SESSION_ITEM_BYTES,
    absent: 1,
    refused: [
      { key: live, reason: CleanupRefusal.Live },
      { key: unreadable, reason: CleanupRefusal.Unreadable },
    ],
  });
  assert.deepEqual(f.host.removedSessions, [
    { instance: name, execution: ended },
  ]);
});

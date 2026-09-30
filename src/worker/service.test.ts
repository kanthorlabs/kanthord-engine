import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WorkerService, type Dependencies } from "./service.ts";
import {
  workerOperations,
  WorkerErrorCode,
  WORKER_SERVICE_NAME,
  LIST_LIMIT_DEFAULT,
  AGENT_PROVIDER_CAPABILITY,
  AGENT_PROVIDER_TARGET_KIND,
  type AgentDependentBinding,
  type WorkerEntry,
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

const fakeCollaborations = {
  custodySuitability: () => {},
  credentialMetadata: () => null,
  entriesOfAgent: () => [],
  modelListCheck: () => async () => ResourceStatus.Unknown,
};
const WORKER_CONFIG = { heartbeatWindow: 300, globalPrompt: "" };

const client = {
  clientId: "client",
  name: "worker",
  workerBindingId: "binding",
  projectId: "project",
};

test("Worker owns registrations, declares its handler, and joins lifecycle calls", async () => {
  const health = new HealthRegistry();
  const worker = new WorkerService({
    config: WORKER_CONFIG,
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
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const registration = store.transaction((transaction) =>
      worker.registrations.register(transaction, client),
    );
    assert.equal(
      worker.registrations.findByClient(client.clientId),
      registration,
    );
    assert.throws(
      () =>
        store.transaction((transaction) =>
          worker.registrations.register(transaction, client),
        ),
      (error) =>
        error instanceof OperationError && error.status === HttpStatus.Conflict,
    );
    worker.registrations.deregister(registration.runtimeIdentity);
    assert.equal(worker.registrations.findByClient(client.clientId), undefined);
    const next = store.transaction((transaction) =>
      worker.registrations.register(transaction, client),
    );
    assert.notEqual(next.runtimeIdentity, registration.runtimeIdentity);
  } finally {
    store.close();
    assert.equal(await worker.stop(), null);
  }
  assert.equal(worker.stop(), worker.stop());
  assert.equal(
    (await worker.healthcheck()).registrations,
    HealthStatus.Unavailable,
  );
  assert.ok((await worker.start()) instanceof Error);
});

test("Worker run joins cancellation before and after startup", async () => {
  for (const before of [true, false]) {
    const worker = new WorkerService({
      config: WORKER_CONFIG,
      ...fakeCollaborations,
    });
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
type OperationKey = Exclude<keyof typeof workerOperations, "register">;

function enablementFixture(
  t: TestContext,
  collaborations: Partial<
    Pick<
      Dependencies,
      | "custodySuitability"
      | "credentialMetadata"
      | "entriesOfAgent"
      | "modelListCheck"
    >
  > = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  ]);
  const worker = new WorkerService({
    config: WORKER_CONFIG,
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

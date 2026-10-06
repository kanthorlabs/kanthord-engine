import assert from "node:assert/strict";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { test, type TestContext } from "node:test";
import { AgentComponent, type Dependencies } from "./service.ts";
import {
  agentOperations,
  AgentErrorCode,
  AGENT_COMPONENT_NAME,
  AGENT_PROVIDER_TARGET_KIND,
  LIST_LIMIT_DEFAULT,
  agentProviderKindSchema,
  ToolSource,
  type AgentDependentBinding,
  type AgentEntry,
  type ApprovedModel,
} from "./contract.ts";
import { agentMigrations } from "./migrations.ts";
import {
  AgentProviderKind,
  EnablementState,
  insertEnablementRevision,
  getLatestRevision,
} from "./enablements.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { background } from "../kernel/context.ts";
import { HealthScope, ResourceStatus } from "../kernel/health.ts";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { HttpStatus } from "../kernel/http.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";

const PROVIDER_CAPABILITY = "model-list read";
const DEFAULT_REASONING = "off";
const AGENT = "swe@1";
const OTHER_AGENT = "re@1";
const WORKER = "general@1";
const MODEL = "claude-sonnet-4-5";
const MISSING_MODEL = "claude-3-5-sonnet-20241022";
const UNKNOWN = "unknown";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const ADD_PROVIDER = "enablement.provider.add";
const REMOVE_PROVIDER = "enablement.provider.remove";
const TOOLS = [{ name: "read", source: ToolSource.Builtin, inputSchema: {} }];
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
const fakeCollaborations: Dependencies = {
  custodySuitability: () => {},
  approvedModels: () => null,
  entriesOfAgent: () => [],
  providerHealthCheck: () => async () => ResourceStatus.Unknown,
  providerCapability: () => PROVIDER_CAPABILITY,
  toolDeclarations: async () => TOOLS,
};

type OperationKey = keyof typeof agentOperations;

function enablementFixture(
  t: TestContext,
  collaborations: Partial<Dependencies> = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
  ]);
  const agent = new AgentComponent({
    ...fakeCollaborations,
    ...collaborations,
  });
  const registry = new OperationRegistry();
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
    params: Record<string, string> = { agentName: AGENT },
    query: Record<string, unknown> = {},
  ): (typeof agentOperations)[K]["output"]["_output"] {
    const operation = agentOperations[key];
    const input = operation.input.parse({ params, query, body });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    ) as (typeof agentOperations)[K]["output"]["_output"];
  }
  return { store, agent, invoke, registry, caller, commits: () => commits };
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

test("agent declaration read exposes prompts, tools and current enablement without writes", async (t) => {
  const schemaVersion = "https://json-schema.org/draft/2020-12/schema";
  const disabled = "disabled";
  const requested: string[] = [];
  const f = enablementFixture(t, {
    toolDeclarations: async (agentName) => {
      requested.push(agentName);
      return TOOLS;
    },
  });
  const operation = agentOperations.get;
  const read = async (agentName = AGENT) =>
    operation.output.parse(
      await f.registry
        .get(operation.id)
        .handler({ params: { agentName }, query: {}, body: null }, f.caller),
    );
  const before = f.store.database
    .prepare("SELECT total_changes() AS count")
    .get();
  const declaration = await read();
  assert.equal(declaration.enablement, null);
  assert.deepEqual(declaration.tools, TOOLS);
  assert.ok(
    declaration.basePrompt?.startsWith("You are a senior software engineer."),
  );
  assert.ok(declaration.agentPrompt.startsWith("## Role"));
  assert.equal(declaration.configurationSchema.$schema, schemaVersion);
  assert.equal(declaration.configurationSchema.additionalProperties, false);
  assert.deepEqual(declaration.configurationSchema.required, [
    "agentProvider",
    "provider",
    "credential",
    "modelIdentifier",
    "reasoningEffort",
  ]);
  assert.doesNotMatch(
    JSON.stringify(declaration.configurationSchema),
    /"(?:default|options)":/,
  );
  assert.match(
    String(declaration.configurationSchema.description),
    /JSON Schema validates neither lookup/,
  );
  assert.deepEqual((await read(OTHER_AGENT)).tools, TOOLS);
  assert.deepEqual(requested, [AGENT, OTHER_AGENT]);
  assert.deepEqual(
    f.store.database.prepare("SELECT total_changes() AS count").get(),
    before,
  );
  const enabled = f.invoke("enablement.put", putBody);
  assert.deepEqual((await read()).enablement, enabled);
  f.invoke("enablement.disable", { expectedRevision: enabled.revision });
  assert.equal((await read()).enablement?.state, disabled);
  await assert.rejects(read("nope@1"), {
    code: AgentErrorCode.AgentNotFound,
    status: HttpStatus.NotFound,
  });
});

test("resource inventory includes every live provider across pages without writes", async (t) => {
  const calls: Array<{
    tx: Parameters<Dependencies["providerHealthCheck"]>[0];
    credential: string;
  }> = [];
  const f = enablementFixture(t, {
    providerHealthCheck: (tx, credential) => {
      calls.push({ tx, credential });
      return async () => ResourceStatus.Unhealthy;
    },
    providerCapability: (_tx, credential) => `capability of ${credential}`,
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
            .prepare("SELECT COUNT(*) AS count FROM agent_enablement")
            .get() as { count: number }
        ).count,
    );
  const before = countRows();
  let inventory: ReturnType<typeof f.agent.resourceInventory> = [];
  f.store.transaction((tx) => {
    inventory = f.agent.resourceInventory(tx);
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
  assert.equal(
    special.capability,
    `capability of ${SPECIAL_PROVIDER.credential}`,
  );
  assert.equal(await special.check(background), ResourceStatus.Unhealthy);
  assert.equal(countRows(), before);
});

test("enablement operations use one commit, page ascending, and project only wire fields", (t) => {
  const f = enablementFixture(t);
  refuses(
    () => f.invoke("enablement.get"),
    AgentErrorCode.NotFound,
    HttpStatus.NotFound,
    { agentName: AGENT },
  );
  const first = f.invoke("enablement.put", putBody);
  assert.deepEqual(first, {
    agentName: AGENT,
    state: EnablementState.Enabled,
    ...putBody,
    revision: FIRST_REVISION,
  });
  f.invoke("enablement.put", putBody, { agentName: OTHER_AGENT });
  const page = f.invoke("enablement.list", null, {}, { limit: "1" });
  assert.deepEqual(
    page.items.map(({ agentName }) => agentName),
    [OTHER_AGENT],
  );
  assert.ok(page.nextCursor);
  const next = f.invoke(
    "enablement.list",
    null,
    {},
    { limit: 1, cursor: page.nextCursor },
  );
  assert.deepEqual(next, { items: [first], nextCursor: null });
  assert.deepEqual(f.invoke("enablement.get"), first);
  const expectedCommits = 6;
  assert.equal(f.commits(), expectedCommits);
  assert.deepEqual(
    agentOperations["enablement.list"].input.parse({
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
        "enablement.put",
        { ...putBody, expectedRevision: 1 },
        { agentName: UNKNOWN },
      ),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expectedRevision: 1 }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: null },
  );
  f.invoke("enablement.put", putBody);
  refuses(
    () => f.invoke("enablement.put", putBody),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: FIRST_REVISION },
  );
  f.invoke("enablement.disable", { expectedRevision: 1 });
  assert.deepEqual(f.invoke("enablement.remove", { expectedRevision: 2 }), {
    agentName: AGENT,
    removed: true,
  });
  refuses(
    () => f.invoke("enablement.put", putBody),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agentName: AGENT, revision: THIRD_REVISION },
  );
  refuses(
    () => f.invoke("enablement.get"),
    AgentErrorCode.NotFound,
    HttpStatus.NotFound,
  );
  const restored = f.invoke("enablement.put", {
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
    "enablement.enable",
    "enablement.disable",
    "enablement.remove",
    "enablement.provider.add",
    "enablement.provider.remove",
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
      AgentErrorCode.AgentNotFound,
      HttpStatus.NotFound,
    );
    refuses(
      () => f.invoke(key, body, params),
      AgentErrorCode.NotFound,
      HttpStatus.NotFound,
    );
  }
  f.invoke("enablement.put", putBody);
  refuses(
    () => f.invoke("enablement.disable", { expectedRevision: 99 }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
  );
});

test("disable skips dependent validation; enable validates defaults and every binding", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  entries = [{ ...binding, entry: { modelIdentifier: MISSING_MODEL } }];
  const disabled = f.invoke("enablement.disable", {
    expectedRevision: 1,
  });
  assert.equal(disabled.state, EnablementState.Disabled);
  refuses(
    () => f.invoke("enablement.enable", { expectedRevision: 2 }),
    AgentErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [
        {
          bindingId: binding.bindingId,
          workerName: WORKER,
          code: AgentErrorCode.ModelUnknown,
        },
      ],
    },
  );
  entries = [binding];
  assert.equal(
    f.invoke("enablement.enable", { expectedRevision: 2 }).state,
    EnablementState.Enabled,
  );
  assert.equal(
    f.invoke("enablement.put", { ...putBody, expectedRevision: 3 }).revision,
    THIRD_REVISION + 1,
  );
});

test("remove refuses bindings and tombstones only when unused", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  entries = [binding];
  refuses(
    () => f.invoke("enablement.remove", { expectedRevision: 1 }),
    AgentErrorCode.InUse,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [{ bindingId: binding.bindingId, workerName: WORKER }],
    },
  );
  entries = [];
  assert.deepEqual(f.invoke("enablement.remove", { expectedRevision: 1 }), {
    agentName: AGENT,
    removed: true,
  });
  assert.deepEqual(f.invoke("enablement.list", null, {}), {
    items: [],
    nextCursor: null,
  });
});

test("provider add and remove preserve uniqueness, last provider, default and explicit dependents", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  const remove = (name: string, revision: number) =>
    f.invoke(
      "enablement.provider.remove",
      { expectedRevision: revision },
      { agentName: AGENT, providerName: name },
    );
  refuses(
    () => remove(UNKNOWN, 1),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  refuses(() => remove(provider.name, 1), AgentErrorCode.ProviderRequired);
  assert.deepEqual(
    f.invoke("enablement.provider.add", { ...spare, expectedRevision: 1 })
      .agentProviders,
    [provider, spare],
  );
  refuses(
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        expectedRevision: 2,
      }),
    AgentErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () => remove(provider.name, 2),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    { agentName: AGENT, dependents: [{ kind: "defaultConfiguration" }] },
  );
  entries = [{ ...binding, entry: { ...defaults, agentProvider: spare.name } }];
  refuses(
    () => remove(spare.name, 2),
    AgentErrorCode.ProviderInUse,
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
      f.invoke("enablement.put", {
        ...putBody,
        agentProviders: [provider, provider],
      }),
    AgentErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        defaultConfiguration: { ...defaults, agentProvider: UNKNOWN },
      }),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  f.invoke("enablement.put", {
    ...putBody,
    agentProviders: [provider, spare],
  });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        expectedRevision: 1,
        agentProviders: [
          provider,
          { ...spare, provider: AgentProviderKind.GithubCopilot },
        ],
      }),
    AgentErrorCode.ProviderFixed,
    HttpStatus.Conflict,
  );
  entries = [{ ...binding, entry: { ...defaults, agentProvider: spare.name } }];
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expectedRevision: 1 }),
    AgentErrorCode.ProviderInUse,
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
  f.invoke("enablement.put", putBody);
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
    () => f.invoke("enablement.put", { ...putBody, expectedRevision: 1 }),
    AgentErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      bindings: [
        {
          bindingId: binding.bindingId,
          workerName: WORKER,
          code: AgentErrorCode.ModelUnknown,
        },
        {
          bindingId: "second",
          workerName: WORKER,
          code: AgentErrorCode.ProviderNotFound,
        },
      ],
    },
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        expectedRevision: 1,
        defaultConfiguration: { ...defaults, modelIdentifier: MISSING_MODEL },
      }),
    AgentErrorCode.ModelUnknown,
  );
});

test("anthropic uses the built-in catalog, not absent credential metadata", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        defaultConfiguration: { ...defaults, modelIdentifier: MISSING_MODEL },
      }),
    AgentErrorCode.ModelUnknown,
  );
  assert.equal(
    f.invoke("enablement.put", putBody).defaultConfiguration.modelIdentifier,
    MODEL,
  );
});

test("openai-codex uses the built-in catalog and refuses an unknown model", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  const codex = { ...provider, provider: AgentProviderKind.OpenaiCodex };
  const body = (modelIdentifier: string) => ({
    agentProviders: [codex],
    defaultConfiguration: { ...defaults, modelIdentifier },
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "gpt-5.5";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).defaultConfiguration
      .modelIdentifier,
    builtin,
  );
});

test("openrouter uses the built-in catalog and refuses an unknown model", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  const router = { ...provider, provider: AgentProviderKind.Openrouter };
  const body = (modelIdentifier: string) => ({
    agentProviders: [router],
    defaultConfiguration: { ...defaults, modelIdentifier },
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "anthropic/claude-3-haiku";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).defaultConfiguration
      .modelIdentifier,
    builtin,
  );
});

test("groq uses the built-in catalog and refuses an unknown model", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  const groq = { ...provider, provider: "groq" };
  const body = (modelIdentifier: string) => ({
    agentProviders: [groq],
    defaultConfiguration: { ...defaults, modelIdentifier },
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "llama-3.1-8b-instant";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).defaultConfiguration
      .modelIdentifier,
    builtin,
  );
});

test("the agent provider set holds openai-compatible and every pi-ai built-in provider", () => {
  assert.deepEqual(
    agentProviderKindSchema.options.toSorted(),
    [AgentProviderKind.OpenaiCompatible, ...getBuiltinProviders()].toSorted(),
  );
  assert.equal(agentProviderKindSchema.safeParse("github").success, false);
  assert.equal(agentProviderKindSchema.safeParse("s3").success, false);
});

test("openai-compatible approved models establish models and reasoning levels, including an explicit empty set", (t) => {
  let models: ApprovedModel[] | null = [
    { id: MODEL, reasoningLevels: [DEFAULT_REASONING] },
  ];
  const f = enablementFixture(t, { approvedModels: () => models });
  const customBody = {
    ...putBody,
    agentProviders: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...customBody,
        defaultConfiguration: { ...defaults, reasoningEffort: "high" },
      }),
    AgentErrorCode.ReasoningUnsupported,
  );
  models = [{ id: MODEL, reasoningLevels: [] }];
  refuses(
    () => f.invoke("enablement.put", customBody),
    AgentErrorCode.ReasoningUnsupported,
  );
  for (const value of [[], null]) {
    models = value;
    refuses(
      () => f.invoke("enablement.put", customBody),
      AgentErrorCode.ModelUnknown,
    );
  }
  models = [{ id: MODEL, reasoningLevels: [DEFAULT_REASONING] }];
  assert.equal(f.invoke("enablement.put", customBody).revision, FIRST_REVISION);
  models = [{ id: MODEL, reasoningLevels: ["high"] }];
  assert.equal(
    f.invoke("enablement.put", {
      ...customBody,
      expectedRevision: 1,
      defaultConfiguration: { ...defaults, reasoningEffort: "high" },
    }).revision,
    SECOND_REVISION,
  );
});

test("null credential records permit no model; malformed metadata propagates in writes and views", (t) => {
  const malformed = new Error("Malformed credential metadata.");
  let models: ApprovedModel[] | null = null;
  let broken = false;
  const f = enablementFixture(t, {
    approvedModels: () => {
      if (broken) throw malformed;
      return models;
    },
  });
  const customBody = {
    ...putBody,
    agentProviders: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () => f.invoke("enablement.put", customBody),
    AgentErrorCode.ModelUnknown,
  );
  models = [{ id: MODEL, reasoningLevels: [DEFAULT_REASONING] }];
  f.invoke("enablement.put", customBody);
  broken = true;
  for (const action of [
    () => f.invoke("enablement.put", { ...customBody, expectedRevision: 1 }),
    () => f.store.transaction((tx) => f.agent.agentView(tx, AGENT, null)),
  ])
    assert.throws(action, (error) => error === malformed);
});

test("Custody refusals map to credential_unsuitable, while unexpected failures propagate unchanged", (t) => {
  let failure: Error | null = null;
  const f = enablementFixture(t, {
    custodySuitability: () => {
      if (failure) throw failure;
    },
  });
  f.invoke("enablement.put", putBody);
  failure = new OperationError(
    HttpStatus.NotFound,
    "credential.credential.not_found",
    "Missing credential.",
  );
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expectedRevision: 1 }),
    AgentErrorCode.CredentialUnsuitable,
  );
  refuses(
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        expectedRevision: 1,
      }),
    AgentErrorCode.CredentialUnsuitable,
  );
  const view = () =>
    f.store.transaction((tx) => f.agent.agentView(tx, AGENT, null));
  assert.deepEqual(view()?.issues, [
    { path: ["agentProvider"], code: AgentErrorCode.CredentialUnsuitable },
  ]);
  failure = new CodedError(
    "system.composition.unwired",
    "Unwired collaboration.",
  );
  for (const action of [
    () => f.invoke("enablement.put", { ...putBody, expectedRevision: 1 }),
    view,
  ]) {
    assert.throws(action, (error) => error === failure);
  }
});

test("validateEntry enforces availability, allowlist and entry forms", (t) => {
  const f = enablementFixture(t);
  const validate = (entry: AgentEntry | null) =>
    f.store.transaction((tx) => f.agent.validateEntry(tx, AGENT, entry));
  refuses(
    () => validate(null),
    AgentErrorCode.Unavailable,
    HttpStatus.BadRequest,
    { agentName: AGENT },
  );
  f.invoke("enablement.put", putBody);
  for (const entry of [
    null,
    defaults,
    { modelIdentifier: MODEL },
    { reasoningEffort: "off" },
  ])
    assert.doesNotThrow(() => validate(entry));
  refuses(
    () =>
      validate({ ...defaults, options: { unexpected: true } } as AgentEntry),
    AgentErrorCode.OverrideNotAllowed,
  );
  for (const entry of [
    {},
    { agentProvider: provider.name },
    { agentProvider: provider.name, modelIdentifier: MODEL },
  ])
    refuses(() => validate(entry), AgentErrorCode.InvalidConfiguration);
  refuses(
    () => validate({ reasoningEffort: "invented" }),
    AgentErrorCode.ReasoningUnsupported,
  );
  f.invoke("enablement.disable", { expectedRevision: 1 });
  refuses(() => validate(defaults), AgentErrorCode.Unavailable);
});

test("Agent collaborations report provider and effective model dependencies without owning a transaction", (t) => {
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
  f.invoke("enablement.put", putBody);
  f.invoke(
    "enablement.put",
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
      f.agent.agentProvidersDependentOn(tx, provider.credential),
      [
        { agentName: OTHER_AGENT, providerName: provider.name },
        { agentName: AGENT, providerName: provider.name },
      ],
    );
    const dependent = f.agent.enablementsDependentOnModel(
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
      f.agent.enablementsDependentOnModel(tx, UNKNOWN, MODEL),
      [],
    );
  });
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
      f.agent.enablementsDependentOnModel(tx, provider.credential, MODEL)
        .length,
      count,
    );
  });
});

test("agentView resolves valid configurations and returns precise issues without hiding unexpected errors", (t) => {
  const f = enablementFixture(t);
  const view = (entry: AgentEntry | null = null, agentName = AGENT) =>
    f.store.transaction((tx) => f.agent.agentView(tx, agentName, entry));
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  });
  assert.equal(view(null, UNKNOWN), null);
  f.invoke("enablement.put", putBody);
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
      AgentErrorCode.ModelUnknown,
    ],
    [
      { agentProvider: UNKNOWN },
      "agentProvider",
      AgentErrorCode.ProviderNotFound,
    ],
    [
      { reasoningEffort: "invented" },
      "reasoningEffort",
      AgentErrorCode.ReasoningUnsupported,
    ],
  ] as const)
    assert.deepEqual(view(entry), {
      defaults,
      effective: null,
      valid: false,
      issues: [{ path: [path], code }],
    });
  f.invoke("enablement.disable", { expectedRevision: 1 });
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  });
});

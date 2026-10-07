import assert from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { temporary } from "../kernel/test-support.ts";
import { AgentComponent, type Dependencies } from "./service.ts";
import {
  agentOperations,
  AgentErrorCode,
  PromptOrigin,
  PromptLayerKind,
  PromptScope,
  PromptSourceState,
  PROMPT_SWITCHES,
  PROMPT_TEXT_MAX_BYTES,
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
import { promptSettings } from "./prompts.ts";
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
import { ProjectErrorCode } from "../project/contract.ts";
import { framing, PromptConsumer } from "./prompt-render.ts";

const PROVIDER_CAPABILITY = "model-list read";
const DEFAULT_REASONING = "off";
const WORKING_PATH = "~/working/AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const PROJECT_TEXT = "project prompt text";
const WORKING_TEXT = "workbench directory text";
const CUSTOM_TEXT = "custom workbench text";
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
const spare = { ...provider, name: "spare", credential: "anthropic-spare" };
const defaults = {
  agentProvider: provider.name,
  modelIdentifier: MODEL,
  reasoningEffort: "off",
};
const putBody = { agentProviders: [provider], defaultConfiguration: defaults };
const binding = { bindingId: "binding", workerName: WORKER, entry: null };
const fakeCollaborations: Omit<Dependencies, "store"> = {
  config: { prompt: { system_file: "", agent_directory: "" } },
  dataDirectory: "/nonexistent/data",
  hostHome: "/nonexistent/home",
  workbenchDirectory: (agentName) => `/nonexistent/workbench/${agentName}`,
  custodySuitability: () => {},
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryWorkingOf: () => null,
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
    store,
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

test("agent read answers the layers, the working layer of the workbench and the final prompt", async (t) => {
  const root = temporary(t);
  const working = join(root, "working");
  mkdirSync(working);
  writeFileSync(join(working, "AGENTS.md"), WORKING_TEXT);
  const f = enablementFixture(t, {
    dataDirectory: root,
    hostHome: root,
    workbenchDirectory: () => working,
  });
  f.invoke(
    "prompt.put",
    {
      scope: PromptScope.Workbench,
      agentName: AGENT,
      customText: CUSTOM_TEXT,
    },
    {},
  );
  f.invoke(
    "prompt.switch",
    { scope: PromptScope.System, switch: "base", enabled: false },
    {},
  );
  const operation = agentOperations.get;
  const read = async (query: Record<string, unknown> = {}) =>
    operation.output.parse(
      await f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { agentName: AGENT },
          query,
          body: null,
        }),
        f.caller,
      ),
    );
  const answer = await read();
  const layers = answer.prompt.layers!;
  assert.deepEqual(
    layers.map(({ layer }) => layer),
    ["system", "agent", "working"],
  );
  assert.deepEqual(
    layers.map(({ sources }) => sources.map(({ source }) => source)),
    [
      ["host_file", "base", "custom"],
      ["agent_file", "shipped", "custom"],
      [
        "agents_md",
        "agents_local_md",
        "claude_md",
        "claude_local_md",
        "shipped",
        "custom",
      ],
    ],
  );
  const base = layers[0]!.sources[1]!;
  assert.equal(base.state, PromptSourceState.Off);
  assert.equal(base.enabled, false);
  assert.equal(base.text, null);
  const file = layers[2]!.sources[0]!;
  assert.equal(file.state, PromptSourceState.Present);
  assert.equal(file.path, WORKING_PATH);
  assert.equal(file.text, WORKING_TEXT);
  assert.match(file.digest!, /^[a-f0-9]{64}$/);
  assert.equal(layers[2]!.sources[5]!.text, CUSTOM_TEXT);
  assert.ok(answer.prompt.final.includes(WORKING_TEXT));
  assert.ok(answer.prompt.final.includes(CUSTOM_TEXT));
  assert.ok(!answer.prompt.final.includes(base.text ?? "\u0000"));
  const final = await read({ view: "final" });
  assert.equal(final.prompt.layers, undefined);
  assert.equal(final.prompt.final, answer.prompt.final);
});

test("agent read with a repository binding answers its working layer and the worker framing", async (t) => {
  const root = temporary(t);
  const allOn = {
    agents_md: true,
    agents_local_md: true,
    claude_md: true,
    claude_local_md: true,
    project_prompt: true,
  };
  const policies: Record<
    string,
    {
      projectId: string;
      projectPrompt: string | null;
      workingLayer: typeof allOn;
    }
  > = {
    "binding-on": {
      projectId: "project-a",
      projectPrompt: PROJECT_TEXT,
      workingLayer: allOn,
    },
    "binding-empty": {
      projectId: "project-a",
      projectPrompt: "",
      workingLayer: allOn,
    },
    "binding-off": {
      projectId: "project-a",
      projectPrompt: PROJECT_TEXT,
      workingLayer: { ...allOn, claude_md: false, project_prompt: false },
    },
  };
  const f = enablementFixture(t, {
    dataDirectory: root,
    hostHome: root,
    repositoryWorkingOf: (_, id) =>
      policies[id] ? { name: "repo", ...policies[id] } : null,
  });
  const operation = agentOperations.get;
  const read = async (query: Record<string, unknown>) =>
    operation.output.parse(
      await f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { agentName: AGENT },
          query,
          body: null,
        }),
        f.caller,
      ),
    );
  const working = async (bindingId: string) => {
    const answer = await read({ projectId: "project-a", bindingId });
    return { answer, sources: answer.prompt.layers![2]!.sources };
  };
  const on = await working("binding-on");
  assert.deepEqual(
    on.sources.map(({ source }) => source),
    [
      "agents_md",
      "agents_local_md",
      "claude_md",
      "claude_local_md",
      "project_prompt",
    ],
  );
  assert.deepEqual(
    on.sources
      .slice(0, 4)
      .map(({ state, origin, path, text }) => [state, origin, path, text]),
    ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"].map(
      (name) => [PromptSourceState.Deferred, "file", name, null],
    ),
  );
  const prompt = on.sources[4]!;
  assert.equal(prompt.origin, PromptOrigin.Database);
  assert.equal(prompt.state, PromptSourceState.Present);
  assert.equal(prompt.text, PROJECT_TEXT);
  assert.ok(on.answer.prompt.final.includes(framing(PromptConsumer.Worker)));
  assert.ok(on.answer.prompt.final.includes(PROJECT_TEXT));
  assert.ok(!on.answer.prompt.final.includes("deferred"));
  const empty = await working("binding-empty");
  assert.equal(empty.sources[4]!.state, PromptSourceState.Absent);
  const off = await working("binding-off");
  assert.equal(off.sources[2]!.state, PromptSourceState.Off);
  assert.equal(off.sources[2]!.path, CLAUDE_FILE);
  assert.equal(off.sources[4]!.state, PromptSourceState.Off);
  assert.ok(!off.answer.prompt.final.includes(PROJECT_TEXT));
  await assert.rejects(
    read({ projectId: "project-b", bindingId: "binding-on" }),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.NotFound &&
      error.code === ProjectErrorCode.BindingNotFound,
  );
  await assert.rejects(
    read({ projectId: "project-a", bindingId: "binding-missing" }),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.BindingNotFound,
  );
  for (const query of [{ projectId: "project-a" }, { bindingId: "binding-on" }])
    assert.equal(
      operation.input.safeParse({
        params: { agentName: AGENT },
        query,
        body: null,
      }).success,
      false,
    );
});

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
  const sources = Object.fromEntries(
    declaration.prompt.layers!.flatMap(({ layer, sources }) =>
      sources.map((source) => [`${layer}.${source.source}`, source]),
    ),
  );
  assert.ok(
    sources["system.base"]!.text?.startsWith(
      "You are a senior software engineer.",
    ),
  );
  assert.ok(sources["agent.shipped"]!.text?.startsWith("## Role"));
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
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        name: "second",
        expectedRevision: 2,
      }),
    AgentErrorCode.ProviderCredentialConflict,
    HttpStatus.Conflict,
    {
      agentName: AGENT,
      credential: spare.credential,
      agentProvider: spare.name,
    },
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

test("put rejects duplicate names, duplicate credentials, absent defaults, provider-kind changes, and omitted explicit providers", (t) => {
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
        agentProviders: [
          provider,
          { ...spare, credential: provider.credential },
        ],
      }),
    AgentErrorCode.ProviderCredentialConflict,
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

const MODEL_LIST = "enablement.provider.model.list";

test("model list answers the built-in catalog of the provider with its supported levels", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  f.invoke("enablement.put", putBody);
  const { items } = f.invoke(MODEL_LIST, null, {
    agentName: AGENT,
    providerName: provider.name,
  });
  const catalog = getBuiltinModels(AgentProviderKind.Anthropic);
  assert.deepEqual(
    items.map(({ modelIdentifier }) => modelIdentifier),
    catalog.map(({ id }) => id),
  );
  const listed = items.find(({ modelIdentifier }) => modelIdentifier === MODEL);
  assert.ok(listed);
  assert.deepEqual(
    listed.reasoningEfforts,
    getSupportedThinkingLevels(catalog.find(({ id }) => id === MODEL)!),
  );
  assert.equal(f.commits(), SECOND_REVISION);
});

test("model list answers the approved models and reasoning levels of an openai-compatible credential", (t) => {
  let models: ApprovedModel[] | null = [
    { id: MODEL, reasoningLevels: [DEFAULT_REASONING, "high"] },
    { id: "plain", reasoningLevels: [] },
  ];
  const requested: string[] = [];
  const f = enablementFixture(t, {
    approvedModels: (_tx, credential) => {
      requested.push(credential);
      return models;
    },
  });
  f.invoke("enablement.put", {
    ...putBody,
    agentProviders: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  });
  const params = { agentName: AGENT, providerName: provider.name };
  assert.deepEqual(f.invoke(MODEL_LIST, null, params).items, [
    {
      modelIdentifier: MODEL,
      reasoningEfforts: [DEFAULT_REASONING, "high"],
    },
    { modelIdentifier: "plain", reasoningEfforts: [] },
  ]);
  assert.ok(
    requested.every((credential) => credential === provider.credential),
  );
  models = null;
  assert.deepEqual(f.invoke(MODEL_LIST, null, params).items, []);
});

test("model list refuses an unknown agent, an absent enablement and an absent provider", (t) => {
  const f = enablementFixture(t);
  const params = { agentName: AGENT, providerName: provider.name };
  refuses(
    () => f.invoke(MODEL_LIST, null, { ...params, agentName: UNKNOWN }),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    () => f.invoke(MODEL_LIST, null, params),
    AgentErrorCode.NotFound,
    HttpStatus.NotFound,
  );
  f.invoke("enablement.put", putBody);
  refuses(
    () => f.invoke(MODEL_LIST, null, { ...params, providerName: UNKNOWN }),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
});

const CREDENTIAL_MODEL_LIST = "model.list";

test("credential model list answers the models of a credential before any enablement", (t) => {
  const approved = [{ id: MODEL, reasoningLevels: [DEFAULT_REASONING] }];
  const requested: string[] = [];
  const f = enablementFixture(t, {
    approvedModels: (_tx, credential) => {
      requested.push(credential);
      return approved;
    },
  });
  const builtin = f.invoke(
    CREDENTIAL_MODEL_LIST,
    null,
    {},
    { provider: AgentProviderKind.Anthropic, credential: provider.credential },
  );
  assert.deepEqual(
    builtin.items.map(({ modelIdentifier }) => modelIdentifier),
    getBuiltinModels(AgentProviderKind.Anthropic).map(({ id }) => id),
  );
  assert.deepEqual(requested, []);
  const compatible = f.invoke(
    CREDENTIAL_MODEL_LIST,
    null,
    {},
    { provider: AgentProviderKind.OpenaiCompatible, credential: "gateway" },
  );
  assert.deepEqual(compatible.items, [
    { modelIdentifier: MODEL, reasoningEfforts: [DEFAULT_REASONING] },
  ]);
  assert.deepEqual(requested, ["gateway"]);
});

test("credential model list refuses a credential that does not suit the provider kind", (t) => {
  const f = enablementFixture(t, {
    custodySuitability: () => {
      throw new OperationError(
        HttpStatus.NotFound,
        "credential.credential.not_found",
        "The credential is absent.",
      );
    },
  });
  const query = {
    provider: AgentProviderKind.Anthropic,
    credential: provider.credential,
  };
  refuses(
    () => f.invoke(CREDENTIAL_MODEL_LIST, null, {}, query),
    AgentErrorCode.CredentialUnsuitable,
    HttpStatus.BadRequest,
    query,
  );
  assert.throws(() =>
    f.invoke(CREDENTIAL_MODEL_LIST, null, {}, { ...query, provider: "github" }),
  );
});

test("every listed model and reasoning effort passes the configuration validation", (t) => {
  const approved = [
    { id: MODEL, reasoningLevels: [DEFAULT_REASONING, "low", "high"] },
    { id: "plain", reasoningLevels: [DEFAULT_REASONING] },
  ];
  const f = enablementFixture(t, { approvedModels: () => approved });
  const custom = {
    name: "custom",
    provider: AgentProviderKind.OpenaiCompatible,
    credential: "gateway",
  };
  f.invoke("enablement.put", {
    ...putBody,
    agentProviders: [provider, custom],
  });
  const row = f.invoke("enablement.get");
  for (const item of row.agentProviders) {
    const { items } = f.invoke(MODEL_LIST, null, {
      agentName: AGENT,
      providerName: item.name,
    });
    assert.ok(items.length);
    for (const { modelIdentifier, reasoningEfforts } of items)
      for (const reasoningEffort of reasoningEfforts)
        f.store.transaction((tx) =>
          assert.doesNotThrow(() =>
            f.agent.validateEntry(tx, AGENT, {
              agentProvider: item.name,
              modelIdentifier,
              reasoningEffort,
            }),
          ),
        );
  }
});

const PROMPT_TARGETS = [
  { scope: PromptScope.System },
  { scope: PromptScope.Agent, agentName: AGENT },
  { scope: PromptScope.Workbench, agentName: AGENT },
] as const;

function allOn(scope: PromptScope) {
  return Object.fromEntries(PROMPT_SWITCHES[scope].map((name) => [name, true]));
}

test("prompt settings of an absent row answer every switch on and an empty text", (t) => {
  const f = enablementFixture(t);
  for (const target of PROMPT_TARGETS)
    assert.deepEqual(
      f.store.transaction((tx) =>
        promptSettings(
          tx,
          target.scope,
          "agentName" in target ? target.agentName : undefined,
        ),
      ),
      {
        scope: target.scope,
        agentName: "agentName" in target ? target.agentName : "",
        switches: allOn(target.scope),
        customText: "",
        system_layer: target.scope === PromptScope.Agent ? "inherit" : null,
        revision: 0,
      },
    );
});

test("prompt writes create the row at revision one and replace it at the expected revision", (t) => {
  const f = enablementFixture(t);
  for (const target of PROMPT_TARGETS) {
    const agentName = "agentName" in target ? target.agentName : "";
    const created = f.invoke(
      "prompt.put",
      { ...target, customText: "one" },
      {},
    );
    assert.deepEqual(created, {
      scope: target.scope,
      agentName,
      switches: allOn(target.scope),
      customText: "one",
      system_layer: target.scope === PromptScope.Agent ? "inherit" : null,
      revision: 1,
    });
    const switched = f.invoke(
      "prompt.switch",
      { ...target, expectedRevision: 1, switch: "custom", enabled: false },
      {},
    );
    assert.deepEqual(switched, {
      ...created,
      switches: { ...allOn(target.scope), custom: false },
      revision: 2,
    });
    const replaced = f.invoke(
      "prompt.put",
      { ...target, expectedRevision: 2, customText: "two" },
      {},
    );
    assert.deepEqual(
      [replaced.customText, replaced.revision],
      ["two", THIRD_REVISION],
    );
    assert.deepEqual(replaced.switches, switched.switches);
  }
});

const CUSTOM_A = "a";

test("prompt read answers the settings of a scope, the absent row included", (t) => {
  const f = enablementFixture(t);
  const target = { scope: PromptScope.Agent, agentName: AGENT };
  assert.deepEqual(f.invoke("prompt.get", null, {}, target), {
    ...target,
    switches: allOn(PromptScope.Agent),
    customText: "",
    system_layer: "inherit",
    revision: 0,
  });
  f.invoke("prompt.put", { ...target, customText: CUSTOM_A }, {});
  assert.equal(f.invoke("prompt.get", null, {}, target).customText, CUSTOM_A);
  assert.equal(
    f.invoke("prompt.get", null, {}, { scope: PromptScope.System })
      .system_layer,
    null,
  );
  refuses(
    () => f.invoke("prompt.get", null, {}, { ...target, agentName: UNKNOWN }),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
});

test("the system layer switch and the override of an agent decide its system layer", async (t) => {
  const f = enablementFixture(t);
  const operation = agentOperations.get;
  const systemLayer = async () =>
    operation.output
      .parse(
        await f.registry.get(operation.id).handler(
          operation.input.parse({
            params: { agentName: AGENT },
            query: {},
            body: null,
          }),
          f.caller,
        ),
      )
      .prompt.layers?.find(({ layer }) => layer === PromptLayerKind.System);
  assert.equal((await systemLayer())?.enabled, true);
  f.invoke(
    "prompt.switch",
    { scope: PromptScope.System, switch: "layer", enabled: false },
    {},
  );
  const inherited = await systemLayer();
  assert.equal(inherited?.enabled, false);
  assert.ok(
    inherited?.sources.every(({ state }) => state === PromptSourceState.Off),
  );
  const target = { scope: PromptScope.Agent, agentName: AGENT };
  const on = f.invoke("prompt.switch", { ...target, system_layer: "on" }, {});
  assert.deepEqual([on.system_layer, on.revision], ["on", FIRST_REVISION]);
  assert.equal((await systemLayer())?.enabled, true);
  f.invoke(
    "prompt.switch",
    {
      scope: PromptScope.System,
      expectedRevision: 1,
      switch: "layer",
      enabled: true,
    },
    {},
  );
  f.invoke(
    "prompt.switch",
    { ...target, expectedRevision: 1, system_layer: "off" },
    {},
  );
  assert.equal((await systemLayer())?.enabled, false);
});

test("a prompt switch takes either a source switch or the override of an agent scope", () => {
  const body = agentOperations["prompt.switch"].input.shape.body;
  const agent = { scope: PromptScope.Agent, agentName: AGENT };
  for (const invalid of [
    agent,
    { ...agent, switch: "custom", enabled: false, system_layer: "on" },
    { ...agent, switch: "custom" },
    { scope: PromptScope.System, system_layer: "on" },
    { scope: PromptScope.Workbench, agentName: AGENT, system_layer: "off" },
    { ...agent, switch: "layer", enabled: false },
  ])
    assert.equal(
      body.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  assert.ok(body.safeParse({ ...agent, system_layer: "inherit" }).success);
  assert.ok(
    body.safeParse({
      scope: PromptScope.System,
      switch: "layer",
      enabled: true,
    }).success,
  );
});

test("a second prompt write at one expected revision answers a conflict with the current row", (t) => {
  const f = enablementFixture(t);
  const target = { scope: PromptScope.Agent, agentName: AGENT };
  const first = f.invoke("prompt.put", { ...target, customText: "a" }, {});
  f.invoke(
    "prompt.put",
    { ...target, expectedRevision: 1, customText: "b" },
    {},
  );
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { ...target, expectedRevision: 1, customText: "c" },
        {},
      ),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
    {
      scope: target.scope,
      agentName: AGENT,
      current: { ...first, customText: "b", revision: 2 },
    },
  );
  refuses(
    () => f.invoke("prompt.put", { ...target, customText: "d" }, {}),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke(
        "prompt.switch",
        {
          scope: PromptScope.System,
          expectedRevision: 1,
          switch: "base",
          enabled: false,
        },
        {},
      ),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
  );
});

test("prompt writes refuse an oversized text, an empty agent layer and an unknown agent", (t) => {
  const f = enablementFixture(t);
  const target = { scope: PromptScope.Agent, agentName: AGENT };
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { ...target, customText: "a".repeat(PROMPT_TEXT_MAX_BYTES + 1) },
        {},
      ),
    AgentErrorCode.PromptTooLarge,
  );
  assert.equal(
    f.invoke(
      "prompt.put",
      { ...target, customText: "\u00e9".repeat(PROMPT_TEXT_MAX_BYTES / 2) },
      {},
    ).revision,
    FIRST_REVISION,
  );
  f.invoke(
    "prompt.switch",
    { ...target, expectedRevision: 1, switch: "agent_file", enabled: false },
    {},
  );
  f.invoke(
    "prompt.switch",
    { ...target, expectedRevision: 2, switch: "shipped", enabled: false },
    {},
  );
  refuses(
    () =>
      f.invoke(
        "prompt.switch",
        { ...target, expectedRevision: 3, switch: "custom", enabled: false },
        {},
      ),
    AgentErrorCode.PromptAgentLayerEmpty,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { scope: PromptScope.Workbench, agentName: UNKNOWN, customText: "x" },
        {},
      ),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
});

test("prompt inputs refuse an unknown switch and a wrong agent name", () => {
  const input = (body: unknown) =>
    agentOperations["prompt.switch"].input.safeParse({
      params: {},
      query: {},
      body,
    }).success;
  assert.equal(
    input({ scope: "system", switch: "agents_md", enabled: true }),
    false,
  );
  assert.equal(
    input({
      scope: "workbench",
      agentName: AGENT,
      switch: "bogus",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    input({ scope: "system", agentName: AGENT, switch: "base", enabled: true }),
    false,
  );
  assert.equal(
    input({ scope: "agent", switch: "custom", enabled: true }),
    false,
  );
  assert.equal(
    input({
      scope: "agent",
      agentName: AGENT,
      switch: "custom",
      enabled: true,
    }),
    true,
  );
});

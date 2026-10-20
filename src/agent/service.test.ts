import assert from "node:assert/strict";
import { SERVER_HOLDER } from "../custody/contract.ts";
import { COOLDOWN_DEFAULTS } from "./config.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { temporary } from "../kernel/test-support.ts";
import { AgentComponent, SelectionKind, type Dependencies } from "./service.ts";
import {
  agentOperations,
  AgentErrorCode,
  ChainLevel,
  FALLBACK_CONFIGURATIONS_MAX,
  AdvancingFailure,
  CooldownChangeKind,
  type AgentSelection,
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
  type HolderScope,
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
import { SHIPPED_TEMPLATES } from "./prompt-templates.ts";
import {
  capturedLogger,
  FallbackLog,
  memoryCredentialHolds,
} from "./test-support.ts";

const PROVIDER_CAPABILITY = "model-list read";
const DEFAULT_REASONING = "off";
const WORKING_PATH = "~/working/AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const PROJECT_TEXT = "project prompt text";
const WORKING_TEXT = "workbench directory text";
const CUSTOM_TEXT = "custom workbench text";
const AGENT = "swe@1";
const OTHER_AGENT = "re@1";
const WORKER = "coder@1";
const MODEL = "claude-sonnet-4-5";
const SUBSCRIPTION_MODEL = "claude-haiku-5-5";
const MISSING_MODEL = "claude-3-5-sonnet-20241022";
const UNKNOWN = "unknown";
const ABSENT_REVISION = 0;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const ADD_PROVIDER = "enablement.provider.add";
const REMOVE_PROVIDER = "enablement.provider.remove";
const TOOLS = [{ name: "read", source: ToolSource.Builtin, input_schema: {} }];
const provider = {
  name: "primary",
  provider: AgentProviderKind.Anthropic,
  credential: "anthropic",
};
const spare = { ...provider, name: "spare", credential: "anthropic-spare" };
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
const binding = {
  binding_id: "binding",
  worker_name: WORKER,
  entry: null,
  holders: [SERVER_HOLDER],
};
const SERVER_SCOPE = { holders: [SERVER_HOLDER], claimant: SERVER_HOLDER };
const fakeCollaborations: Omit<Dependencies, "store" | "credentialHolds"> = {
  config: {
    prompt: { system_file: "", agent_directory: "", host_file: true },
    cooldown: COOLDOWN_DEFAULTS,
  },
  dataDirectory: "/nonexistent/data",
  hostHome: "/nonexistent/home",
  workbenchDirectory: (agentName) => `/nonexistent/workbench/${agentName}`,
  custodySuitability: () => {},
  copyHeld: () => true,
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryWorkingOf: () => null,
  providerHealthCheck: () => async () => ResourceStatus.Unknown,
  providerCapability: () => PROVIDER_CAPABILITY,
  toolDeclarations: async () => TOOLS,
  logger: pino({ enabled: false }),
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
    credentialHolds: memoryCredentialHolds(),
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
    params: Record<string, string> = { agent_name: AGENT },
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
      agent_name: AGENT,
      custom_text: CUSTOM_TEXT,
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
          params: { agent_name: AGENT },
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

test("agent read renders the framing and layer messages from the template files of the agent directory", async (t) => {
  const root = temporary(t);
  const templates = join(root, "agents", "prompts");
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, "framing-workbench.md"), "Custom framing.\n");
  writeFileSync(
    join(templates, "layer-message.md"),
    "From {{source}}: {{text}}\n",
  );
  const working = join(root, "working");
  mkdirSync(working);
  writeFileSync(join(working, "AGENTS.md"), WORKING_TEXT);
  const f = enablementFixture(t, {
    config: {
      prompt: { system_file: "", agent_directory: "agents", host_file: true },
      cooldown: COOLDOWN_DEFAULTS,
    },
    dataDirectory: root,
    hostHome: root,
    workbenchDirectory: () => working,
  });
  const operation = agentOperations.get;
  const read = async () =>
    operation.output.parse(
      await f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { agent_name: AGENT },
          query: { view: "final" },
          body: null,
        }),
        f.caller,
      ),
    );
  const answer = await read();
  assert.ok(answer.prompt.final.includes("Custom framing."));
  assert.ok(
    answer.prompt.final.includes(`From file ${WORKING_PATH}: ${WORKING_TEXT}`),
  );
  writeFileSync(join(templates, "layer-message.md"), "{{#if}}");
  await assert.rejects(read(), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, AgentErrorCode.PromptTemplateInvalid);
    return true;
  });
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
      project_id: string;
      project_prompt: string | null;
      working_layer: typeof allOn;
    }
  > = {
    "binding-on": {
      project_id: "project-a",
      project_prompt: PROJECT_TEXT,
      working_layer: allOn,
    },
    "binding-empty": {
      project_id: "project-a",
      project_prompt: "",
      working_layer: allOn,
    },
    "binding-off": {
      project_id: "project-a",
      project_prompt: PROJECT_TEXT,
      working_layer: { ...allOn, claude_md: false, project_prompt: false },
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
          params: { agent_name: AGENT },
          query,
          body: null,
        }),
        f.caller,
      ),
    );
  const working = async (bindingId: string) => {
    const answer = await read({
      project_id: "project-a",
      binding_id: bindingId,
    });
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
  assert.ok(
    on.answer.prompt.final.includes(
      framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
    ),
  );
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
    read({ project_id: "project-b", binding_id: "binding-on" }),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.NotFound &&
      error.code === ProjectErrorCode.BindingNotFound,
  );
  await assert.rejects(
    read({ project_id: "project-a", binding_id: "binding-missing" }),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.BindingNotFound,
  );
  for (const query of [
    { project_id: "project-a" },
    { binding_id: "binding-on" },
  ])
    assert.equal(
      operation.input.safeParse({
        params: { agent_name: AGENT },
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
        .handler(
          { params: { agent_name: agentName }, query: {}, body: null },
          f.caller,
        ),
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
      "This text is the default standard.",
    ),
  );
  assert.ok(sources["agent.shipped"]!.text?.startsWith("## Role"));
  assert.equal(declaration.configuration_schema.$schema, schemaVersion);
  assert.equal(declaration.configuration_schema.additionalProperties, false);
  assert.deepEqual(declaration.configuration_schema.required, [
    "agent_provider",
    "provider",
    "credential",
    "model_identifier",
    "reasoning_effort",
  ]);
  assert.doesNotMatch(
    JSON.stringify(declaration.configuration_schema),
    /"(?:default|options)":/,
  );
  assert.match(
    String(declaration.configuration_schema.description),
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
  f.invoke("enablement.disable", { expected_revision: enabled.revision });
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
        [],
      );
    }
    insertEnablementRevision(
      tx,
      SPECIAL_AGENT,
      EnablementState.Enabled,
      [provider, SPECIAL_PROVIDER],
      defaults,
      [],
    );
    insertEnablementRevision(
      tx,
      DISABLED_AGENT,
      EnablementState.Disabled,
      [provider],
      defaults,
      [],
    );
    insertEnablementRevision(
      tx,
      REMOVED_AGENT,
      EnablementState.Enabled,
      [provider],
      defaults,
      [],
    );
    insertEnablementRevision(
      tx,
      REMOVED_AGENT,
      EnablementState.Enabled,
      [provider],
      defaults,
      [],
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
    { agent_name: AGENT },
  );
  const first = f.invoke("enablement.put", putBody);
  assert.deepEqual(first, {
    agent_name: AGENT,
    state: EnablementState.Enabled,
    ...putBody,
    revision: FIRST_REVISION,
  });
  f.invoke("enablement.put", putBody, { agent_name: OTHER_AGENT });
  const page = f.invoke("enablement.list", null, {}, { limit: "1" });
  assert.deepEqual(
    page.items.map(({ agent_name }) => agent_name),
    [OTHER_AGENT],
  );
  assert.ok(page.next_cursor);
  const next = f.invoke(
    "enablement.list",
    null,
    {},
    { limit: 1, cursor: page.next_cursor },
  );
  assert.deepEqual(next, { items: [first], next_cursor: null });
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
        { ...putBody, expected_revision: 1 },
        { agent_name: UNKNOWN },
      ),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 1 }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agent_name: AGENT, revision: null },
  );
  f.invoke("enablement.put", putBody);
  refuses(
    () => f.invoke("enablement.put", putBody),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agent_name: AGENT, revision: FIRST_REVISION },
  );
  f.invoke("enablement.disable", { expected_revision: 1 });
  assert.deepEqual(f.invoke("enablement.remove", { expected_revision: 2 }), {
    agent_name: AGENT,
    removed: true,
  });
  refuses(
    () => f.invoke("enablement.put", putBody),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agent_name: AGENT, revision: THIRD_REVISION },
  );
  refuses(
    () => f.invoke("enablement.get"),
    AgentErrorCode.NotFound,
    HttpStatus.NotFound,
  );
  const restored = f.invoke("enablement.put", {
    ...putBody,
    expected_revision: 3,
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
        ? { ...spare, expected_revision: 99 }
        : { expected_revision: 99 };
    const params: Record<string, string> =
      key === REMOVE_PROVIDER
        ? { agent_name: AGENT, provider_name: spare.name }
        : { agent_name: AGENT };
    refuses(
      () => f.invoke(key, body, { ...params, agent_name: UNKNOWN }),
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
    () => f.invoke("enablement.disable", { expected_revision: 99 }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
  );
});

test("disable skips dependent validation; enable validates defaults and every binding", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  entries = [{ ...binding, entry: { model_identifier: MISSING_MODEL } }];
  const disabled = f.invoke("enablement.disable", {
    expected_revision: 1,
  });
  assert.equal(disabled.state, EnablementState.Disabled);
  refuses(
    () => f.invoke("enablement.enable", { expected_revision: 2 }),
    AgentErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [
        {
          binding_id: binding.binding_id,
          worker_name: WORKER,
          code: AgentErrorCode.ModelUnknown,
        },
      ],
    },
  );
  entries = [binding];
  assert.equal(
    f.invoke("enablement.enable", { expected_revision: 2 }).state,
    EnablementState.Enabled,
  );
  assert.equal(
    f.invoke("enablement.put", { ...putBody, expected_revision: 3 }).revision,
    THIRD_REVISION + 1,
  );
});

test("remove refuses bindings and tombstones only when unused", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  entries = [binding];
  refuses(
    () => f.invoke("enablement.remove", { expected_revision: 1 }),
    AgentErrorCode.InUse,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [{ binding_id: binding.binding_id, worker_name: WORKER }],
    },
  );
  entries = [];
  assert.deepEqual(f.invoke("enablement.remove", { expected_revision: 1 }), {
    agent_name: AGENT,
    removed: true,
  });
  assert.deepEqual(f.invoke("enablement.list", null, {}), {
    items: [],
    next_cursor: null,
  });
});

test("provider add and remove preserve uniqueness, last provider, default and explicit dependents", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", putBody);
  const remove = (name: string, revision: number) =>
    f.invoke(
      "enablement.provider.remove",
      { expected_revision: revision },
      { agent_name: AGENT, provider_name: name },
    );
  refuses(
    () => remove(UNKNOWN, 1),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  refuses(() => remove(provider.name, 1), AgentErrorCode.ProviderRequired);
  assert.deepEqual(
    f.invoke("enablement.provider.add", { ...spare, expected_revision: 1 })
      .agent_providers,
    [provider, spare],
  );
  refuses(
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        expected_revision: 2,
      }),
    AgentErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        name: "second",
        expected_revision: 2,
      }),
    AgentErrorCode.ProviderCredentialConflict,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      credential: spare.credential,
      agent_provider: spare.name,
    },
  );
  refuses(
    () => remove(provider.name, 2),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    { agent_name: AGENT, dependents: [{ kind: "default_configuration" }] },
  );
  entries = [
    { ...binding, entry: { ...defaults, agent_provider: spare.name } },
  ];
  refuses(
    () => remove(spare.name, 2),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      dependents: [{ binding_id: binding.binding_id, worker_name: WORKER }],
    },
  );
  entries = [binding];
  assert.deepEqual(remove(spare.name, 2).agent_providers, [provider]);
});

test("put rejects duplicate names, duplicate credentials, absent defaults, provider-kind changes, and omitted explicit providers", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        agent_providers: [provider, provider],
      }),
    AgentErrorCode.ProviderNameConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        agent_providers: [
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
        default_configuration: { ...defaults, agent_provider: UNKNOWN },
        fallback_configurations: [],
      }),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  f.invoke("enablement.put", {
    ...putBody,
    agent_providers: [provider, spare],
  });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        expected_revision: 1,
        agent_providers: [
          provider,
          { ...spare, provider: AgentProviderKind.GithubCopilot },
        ],
      }),
    AgentErrorCode.ProviderFixed,
    HttpStatus.Conflict,
  );
  entries = [
    { ...binding, entry: { ...defaults, agent_provider: spare.name } },
  ];
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 1 }),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [{ binding_id: binding.binding_id, worker_name: WORKER }],
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
    { ...binding, entry: { model_identifier: MISSING_MODEL } },
    {
      ...binding,
      binding_id: "second",
      entry: {
        agent_provider: UNKNOWN,
        model_identifier: MODEL,
        reasoning_effort: "off",
      },
    },
  ];
  refuses(
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 1 }),
    AgentErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [
        {
          binding_id: binding.binding_id,
          worker_name: WORKER,
          code: AgentErrorCode.ModelUnknown,
        },
        {
          binding_id: "second",
          worker_name: WORKER,
          code: AgentErrorCode.ProviderNotFound,
        },
      ],
    },
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        expected_revision: 1,
        default_configuration: { ...defaults, model_identifier: MISSING_MODEL },
        fallback_configurations: [],
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
        default_configuration: { ...defaults, model_identifier: MISSING_MODEL },
        fallback_configurations: [],
      }),
    AgentErrorCode.ModelUnknown,
  );
  assert.equal(
    f.invoke("enablement.put", putBody).default_configuration.model_identifier,
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
    agent_providers: [codex],
    default_configuration: { ...defaults, model_identifier: modelIdentifier },
    fallback_configurations: [],
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "gpt-5.5";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).default_configuration
      .model_identifier,
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
    agent_providers: [router],
    default_configuration: { ...defaults, model_identifier: modelIdentifier },
    fallback_configurations: [],
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "anthropic/claude-haiku-4.5";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).default_configuration
      .model_identifier,
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
    agent_providers: [groq],
    default_configuration: { ...defaults, model_identifier: modelIdentifier },
    fallback_configurations: [],
  });
  refuses(
    () => f.invoke("enablement.put", body(MODEL)),
    AgentErrorCode.ModelUnknown,
  );
  const builtin = "llama-3.1-8b-instant";
  assert.equal(
    f.invoke("enablement.put", body(builtin)).default_configuration
      .model_identifier,
    builtin,
  );
});

test("the agent provider set holds openai-compatible, anthropic-subscription and every pi-ai built-in provider", () => {
  assert.deepEqual(
    agentProviderKindSchema.options.toSorted(),
    [
      AgentProviderKind.OpenaiCompatible,
      AgentProviderKind.AnthropicSubscription,
      ...getBuiltinProviders(),
    ].toSorted(),
  );
  assert.equal(agentProviderKindSchema.safeParse("github").success, false);
  assert.equal(agentProviderKindSchema.safeParse("s3").success, false);
});

test("openai-compatible approved models establish models and reasoning levels, including an explicit empty set", (t) => {
  let models: ApprovedModel[] | null = [
    { id: MODEL, reasoning_levels: [DEFAULT_REASONING] },
  ];
  const f = enablementFixture(t, { approvedModels: () => models });
  const customBody = {
    ...putBody,
    agent_providers: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...customBody,
        default_configuration: { ...defaults, reasoning_effort: "high" },
        fallback_configurations: [],
      }),
    AgentErrorCode.ReasoningUnsupported,
  );
  models = [{ id: MODEL, reasoning_levels: [] }];
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
  models = [{ id: MODEL, reasoning_levels: [DEFAULT_REASONING] }];
  assert.equal(f.invoke("enablement.put", customBody).revision, FIRST_REVISION);
  models = [{ id: MODEL, reasoning_levels: ["high"] }];
  assert.equal(
    f.invoke("enablement.put", {
      ...customBody,
      expected_revision: 1,
      default_configuration: { ...defaults, reasoning_effort: "high" },
      fallback_configurations: [],
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
    agent_providers: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  };
  refuses(
    () => f.invoke("enablement.put", customBody),
    AgentErrorCode.ModelUnknown,
  );
  models = [{ id: MODEL, reasoning_levels: [DEFAULT_REASONING] }];
  f.invoke("enablement.put", customBody);
  broken = true;
  for (const action of [
    () => f.invoke("enablement.put", { ...customBody, expected_revision: 1 }),
    () =>
      f.store.transaction((tx) =>
        f.agent.agentView(tx, AGENT, null, SERVER_SCOPE),
      ),
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
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 1 }),
    AgentErrorCode.CredentialUnsuitable,
  );
  refuses(
    () =>
      f.invoke("enablement.provider.add", {
        ...spare,
        expected_revision: 1,
      }),
    AgentErrorCode.CredentialUnsuitable,
  );
  const view = () =>
    f.store.transaction((tx) =>
      f.agent.agentView(tx, AGENT, null, SERVER_SCOPE),
    );
  assert.deepEqual(view()?.issues, [
    { path: ["agent_provider"], code: AgentErrorCode.CredentialUnsuitable },
  ]);
  failure = new CodedError(
    "system.composition.unwired",
    "Unwired collaboration.",
  );
  for (const action of [
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 1 }),
    view,
  ]) {
    assert.throws(action, (error) => error === failure);
  }
});

test("put refuses an unsuitable credential on a non-default provider before any write", (t) => {
  const f = enablementFixture(t, {
    custodySuitability: (_tx, { credential }) => {
      if (credential === spare.credential)
        throw new OperationError(
          HttpStatus.NotFound,
          "credential.credential.not_found",
          "Missing credential.",
        );
    },
  });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        agent_providers: [provider, spare],
      }),
    AgentErrorCode.CredentialUnsuitable,
  );
  assert.equal(
    f.store.transaction((tx) => getLatestRevision(tx, AGENT)),
    null,
  );
});

test("validateEntry enforces availability, allowlist and entry forms", (t) => {
  const f = enablementFixture(t);
  const validate = (entry: AgentEntry | null) =>
    f.store.transaction((tx) =>
      f.agent.validateEntry(tx, AGENT, entry, [SERVER_HOLDER]),
    );
  refuses(
    () => validate(null),
    AgentErrorCode.Unavailable,
    HttpStatus.BadRequest,
    { agent_name: AGENT },
  );
  f.invoke("enablement.put", putBody);
  for (const entry of [
    null,
    defaults,
    { model_identifier: MODEL },
    { reasoning_effort: "off" },
  ])
    assert.doesNotThrow(() => validate(entry));
  refuses(
    () =>
      validate({ ...defaults, options: { unexpected: true } } as AgentEntry),
    AgentErrorCode.OverrideNotAllowed,
  );
  for (const entry of [
    {},
    { agent_provider: provider.name },
    { agent_provider: provider.name, model_identifier: MODEL },
  ])
    refuses(() => validate(entry), AgentErrorCode.InvalidConfiguration);
  refuses(
    () => validate({ reasoning_effort: "invented" }),
    AgentErrorCode.ReasoningUnsupported,
  );
  f.invoke("enablement.disable", { expected_revision: 1 });
  refuses(() => validate(defaults), AgentErrorCode.Unavailable);
});

test("Agent collaborations report provider and effective model dependencies without owning a transaction", (t) => {
  const f = enablementFixture(t, {
    entriesOfAgent: (_tx, agentName) =>
      agentName === OTHER_AGENT
        ? [
            {
              ...binding,
              worker_name: "reviewer@1",
              entry: { model_identifier: MODEL },
            },
          ]
        : [binding],
  });
  f.invoke("enablement.put", putBody);
  f.invoke(
    "enablement.put",
    {
      ...putBody,
      default_configuration: {
        ...defaults,
        model_identifier: "claude-haiku-4-5",
      },
      fallback_configurations: [],
    },
    { agent_name: OTHER_AGENT },
  );
  f.store.transaction((tx) => {
    assert.deepEqual(
      f.agent.agentProvidersDependentOn(tx, provider.credential),
      [
        { agent_name: OTHER_AGENT, provider_name: provider.name },
        { agent_name: AGENT, provider_name: provider.name },
      ],
    );
    const dependent = f.agent.enablementsDependentOnModel(
      tx,
      provider.credential,
      MODEL,
    );
    assert.deepEqual(dependent.map(({ agent_name }) => agent_name).sort(), [
      OTHER_AGENT,
      AGENT,
    ]);
    for (const row of dependent)
      assert.deepEqual(Object.keys(row).sort(), [
        "agent_name",
        "agent_providers",
        "default_configuration",
        "fallback_configurations",
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
    entriesOfAgent: () => [{ ...binding, entry: { model_identifier: MODEL } }],
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
        [],
      );
    insertEnablementRevision(
      tx,
      "removed",
      EnablementState.Enabled,
      [provider],
      defaults,
      [],
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
    f.store.transaction((tx) =>
      f.agent.agentView(tx, agentName, entry, SERVER_SCOPE),
    );
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    chain: [],
    active_position: null,
    cooling: null,
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
    chain: [
      {
        position: 0,
        level: ChainLevel.Enablement,
        ...defaults,
        provider: provider.provider,
        credential: provider.credential,
        cooldown: null,
      },
    ],
    active_position: 0,
    cooling: null,
    valid: true,
    issues: [],
  });
  for (const [entry, path, code] of [
    [
      { model_identifier: MISSING_MODEL },
      "model_identifier",
      AgentErrorCode.ModelUnknown,
    ],
    [
      { agent_provider: UNKNOWN },
      "agent_provider",
      AgentErrorCode.ProviderNotFound,
    ],
    [
      { reasoning_effort: "invented" },
      "reasoning_effort",
      AgentErrorCode.ReasoningUnsupported,
    ],
  ] as const)
    assert.deepEqual(view(entry), {
      defaults,
      effective: null,
      chain: [],
      active_position: null,
      cooling: null,
      valid: false,
      issues: [{ path: [path], code }],
    });
  f.invoke("enablement.disable", { expected_revision: 1 });
  assert.deepEqual(view(), {
    defaults: null,
    effective: null,
    chain: [],
    active_position: null,
    cooling: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  });
});

test("selectionView validates the pinned selection and answers unavailable for a disabled or removed enablement", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", putBody);
  const chosen = f.store.transaction((tx) =>
    f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
  );
  assert.ok(chosen.kind === SelectionKind.Selected);
  const { selection } = chosen;
  const view = (pinned = selection) =>
    f.store.transaction((tx) => f.agent.selectionView(tx, pinned));
  assert.deepEqual(view(), {
    effective: {
      ...defaults,
      provider: provider.provider,
      credential: provider.credential,
    },
    valid: true,
    issues: [],
  });
  f.invoke("enablement.put", {
    ...putBody,
    expected_revision: FIRST_REVISION,
    agent_providers: [{ ...provider, name: "renamed", credential: "other" }],
    default_configuration: { ...defaults, agent_provider: "renamed" },
  });
  assert.deepEqual(view().effective, {
    ...defaults,
    provider: provider.provider,
    credential: provider.credential,
  });
  assert.deepEqual(view({ ...selection, model_identifier: MISSING_MODEL }), {
    effective: null,
    valid: false,
    issues: [
      {
        path: ["model_identifier"],
        code: AgentErrorCode.ModelUnknown,
      },
    ],
  });
  const unavailable = {
    effective: null,
    valid: false,
    issues: [{ path: [], code: AgentErrorCode.Unavailable }],
  };
  f.invoke("enablement.disable", { expected_revision: SECOND_REVISION });
  assert.deepEqual(view(), unavailable);
  f.invoke("enablement.remove", { expected_revision: THIRD_REVISION });
  assert.deepEqual(view(), unavailable);
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
    agent_name: AGENT,
    provider_name: provider.name,
  });
  const catalog = getBuiltinModels(AgentProviderKind.Anthropic);
  assert.deepEqual(
    items.map(({ model_identifier }) => model_identifier),
    catalog.map(({ id }) => id),
  );
  const listed = items.find(
    ({ model_identifier }) => model_identifier === MODEL,
  );
  assert.ok(listed);
  assert.deepEqual(
    listed.reasoning_efforts,
    getSupportedThinkingLevels(catalog.find(({ id }) => id === MODEL)!),
  );
  assert.equal(f.commits(), SECOND_REVISION);
});

test("model list of anthropic-subscription answers the built-in catalog of the anthropic pi provider", (t) => {
  const f = enablementFixture(t, {
    approvedModels: () => {
      throw new Error("Built-in catalog must not read metadata.");
    },
  });
  f.invoke("enablement.put", {
    ...putBody,
    agent_providers: [
      { ...provider, provider: AgentProviderKind.AnthropicSubscription },
    ],
  });
  const { items } = f.invoke(MODEL_LIST, null, {
    agent_name: AGENT,
    provider_name: provider.name,
  });
  assert.deepEqual(
    items.map(({ model_identifier }) => model_identifier),
    getBuiltinModels(AgentProviderKind.Anthropic).map(({ id }) => id),
  );
  assert.ok(
    items.some(
      ({ model_identifier }) => model_identifier === SUBSCRIPTION_MODEL,
    ),
  );
});

test("model list answers the approved models and reasoning levels of an openai-compatible credential", (t) => {
  let models: ApprovedModel[] | null = [
    { id: MODEL, reasoning_levels: [DEFAULT_REASONING, "high"] },
    { id: "plain", reasoning_levels: [] },
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
    agent_providers: [
      { ...provider, provider: AgentProviderKind.OpenaiCompatible },
    ],
  });
  const params = { agent_name: AGENT, provider_name: provider.name };
  assert.deepEqual(f.invoke(MODEL_LIST, null, params).items, [
    {
      model_identifier: MODEL,
      reasoning_efforts: [DEFAULT_REASONING, "high"],
    },
    { model_identifier: "plain", reasoning_efforts: [] },
  ]);
  assert.ok(
    requested.every((credential) => credential === provider.credential),
  );
  models = null;
  assert.deepEqual(f.invoke(MODEL_LIST, null, params).items, []);
});

test("model list refuses an unknown agent, an absent enablement and an absent provider", (t) => {
  const f = enablementFixture(t);
  const params = { agent_name: AGENT, provider_name: provider.name };
  refuses(
    () => f.invoke(MODEL_LIST, null, { ...params, agent_name: UNKNOWN }),
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
    () => f.invoke(MODEL_LIST, null, { ...params, provider_name: UNKNOWN }),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
});

const CREDENTIAL_MODEL_LIST = "model.list";

test("credential model list answers the models of a credential before any enablement", (t) => {
  const approved = [{ id: MODEL, reasoning_levels: [DEFAULT_REASONING] }];
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
    builtin.items.map(({ model_identifier }) => model_identifier),
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
    { model_identifier: MODEL, reasoning_efforts: [DEFAULT_REASONING] },
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
    { id: MODEL, reasoning_levels: [DEFAULT_REASONING, "low", "high"] },
    { id: "plain", reasoning_levels: [DEFAULT_REASONING] },
  ];
  const f = enablementFixture(t, { approvedModels: () => approved });
  const custom = {
    name: "custom",
    provider: AgentProviderKind.OpenaiCompatible,
    credential: "gateway",
  };
  f.invoke("enablement.put", {
    ...putBody,
    agent_providers: [provider, custom],
  });
  const row = f.invoke("enablement.get");
  for (const item of row.agent_providers) {
    const { items } = f.invoke(MODEL_LIST, null, {
      agent_name: AGENT,
      provider_name: item.name,
    });
    assert.ok(items.length);
    for (const { model_identifier, reasoning_efforts } of items)
      for (const reasoningEffort of reasoning_efforts)
        f.store.transaction((tx) =>
          assert.doesNotThrow(() =>
            f.agent.validateEntry(
              tx,
              AGENT,
              {
                agent_provider: item.name,
                model_identifier,
                reasoning_effort: reasoningEffort,
              },
              [SERVER_HOLDER],
            ),
          ),
        );
  }
});

const PROMPT_TARGETS = [
  { scope: PromptScope.System },
  { scope: PromptScope.Agent, agent_name: AGENT },
  { scope: PromptScope.Workbench, agent_name: AGENT },
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
          "agent_name" in target ? target.agent_name : undefined,
        ),
      ),
      {
        scope: target.scope,
        agent_name: "agent_name" in target ? target.agent_name : "",
        switches: allOn(target.scope),
        custom_text: "",
        system_layer: target.scope === PromptScope.Agent ? "inherit" : null,
        revision: 0,
      },
    );
});

test("prompt writes create the row at revision one and replace it at the expected revision", (t) => {
  const f = enablementFixture(t);
  for (const target of PROMPT_TARGETS) {
    const agentName = "agent_name" in target ? target.agent_name : "";
    const created = f.invoke(
      "prompt.put",
      { ...target, custom_text: "one" },
      {},
    );
    assert.deepEqual(created, {
      scope: target.scope,
      agent_name: agentName,
      switches: allOn(target.scope),
      custom_text: "one",
      system_layer: target.scope === PromptScope.Agent ? "inherit" : null,
      revision: 1,
      locked_switches: [],
    });
    const switched = f.invoke(
      "prompt.switch",
      { ...target, expected_revision: 1, switch: "custom", enabled: false },
      {},
    );
    assert.deepEqual(switched, {
      ...created,
      switches: { ...allOn(target.scope), custom: false },
      revision: 2,
    });
    const replaced = f.invoke(
      "prompt.put",
      { ...target, expected_revision: 2, custom_text: "two" },
      {},
    );
    assert.deepEqual(
      [replaced.custom_text, replaced.revision],
      ["two", THIRD_REVISION],
    );
    assert.deepEqual(replaced.switches, switched.switches);
  }
});

const CUSTOM_A = "a";

test("prompt read answers the settings of a scope, the absent row included", (t) => {
  const f = enablementFixture(t);
  const target = { scope: PromptScope.Agent, agent_name: AGENT };
  assert.deepEqual(f.invoke("prompt.get", null, {}, target), {
    ...target,
    switches: allOn(PromptScope.Agent),
    custom_text: "",
    system_layer: "inherit",
    revision: 0,
    locked_switches: [],
  });
  f.invoke("prompt.put", { ...target, custom_text: CUSTOM_A }, {});
  assert.equal(f.invoke("prompt.get", null, {}, target).custom_text, CUSTOM_A);
  assert.equal(
    f.invoke("prompt.get", null, {}, { scope: PromptScope.System })
      .system_layer,
    null,
  );
  refuses(
    () => f.invoke("prompt.get", null, {}, { ...target, agent_name: UNKNOWN }),
    AgentErrorCode.AgentNotFound,
    HttpStatus.NotFound,
  );
});

const HOST_FILE = "host_file";
const HOST_TEXT = "host agent file text";

function lockedFixture(t: TestContext, hostFile: boolean) {
  const root = temporary(t);
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "AGENTS.md"), HOST_TEXT);
  const config = (host_file: boolean) => ({
    prompt: { system_file: "", agent_directory: "", host_file },
    cooldown: COOLDOWN_DEFAULTS,
  });
  const f = enablementFixture(t, {
    config: config(hostFile),
    dataDirectory: root,
    hostHome: root,
  });
  const composeHostFile = async (host_file: boolean) => {
    const component = new AgentComponent({
      store: f.store,
      ...fakeCollaborations,
      credentialHolds: memoryCredentialHolds(),
      config: config(host_file),
      dataDirectory: root,
      hostHome: root,
    });
    const layers = await component.composePrompt(AGENT, background);
    return layers[0]!.sources.find(({ source }) => source === HOST_FILE)!;
  };
  return { ...f, composeHostFile };
}

test("prompt settings answer no locked switch by default and the host file when the configuration locks it", (t) => {
  const unlocked = lockedFixture(t, true);
  const locked = lockedFixture(t, false);
  for (const target of PROMPT_TARGETS) {
    const query = { ...target };
    assert.deepEqual(
      unlocked.invoke("prompt.get", null, {}, query).locked_switches,
      [],
    );
    assert.deepEqual(
      locked.invoke("prompt.get", null, {}, query).locked_switches,
      target.scope === PromptScope.System ? [HOST_FILE] : [],
    );
  }
  const put = locked.invoke(
    "prompt.put",
    { scope: PromptScope.System, custom_text: "x" },
    {},
  );
  assert.deepEqual(put.locked_switches, [HOST_FILE]);
  assert.deepEqual(put.switches, allOn(PromptScope.System));
});

test("a locked host file switch answers a refusal after the revision check and keeps the other switches writable", (t) => {
  const locked = lockedFixture(t, false);
  const body = { scope: PromptScope.System, switch: HOST_FILE, enabled: false };
  refuses(
    () => locked.invoke("prompt.switch", body, {}),
    AgentErrorCode.PromptSwitchLocked,
    HttpStatus.Conflict,
    { scope: PromptScope.System, switch: HOST_FILE },
  );
  assert.equal(
    locked.store.transaction((tx) => promptSettings(tx, PromptScope.System))
      .revision,
    ABSENT_REVISION,
  );
  const base = locked.invoke("prompt.switch", { ...body, switch: "base" }, {});
  assert.deepEqual(
    [base.switches.base, base.locked_switches, base.revision],
    [false, [HOST_FILE], FIRST_REVISION],
  );
  refuses(
    () => locked.invoke("prompt.switch", { ...body, expected_revision: 5 }, {}),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
    {
      scope: PromptScope.System,
      agent_name: "",
      current: base,
    },
  );
  const unlocked = lockedFixture(t, true);
  const written = unlocked.invoke("prompt.switch", body, {});
  assert.deepEqual(
    [written.switches[HOST_FILE], written.locked_switches],
    [false, []],
  );
});

test("the composer resolves the host file off while locked and keeps the stored switch", async (t) => {
  const f = lockedFixture(t, true);
  assert.equal(
    (await f.composeHostFile(true)).state,
    PromptSourceState.Present,
  );
  f.invoke("prompt.put", { scope: PromptScope.System, custom_text: "x" }, {});
  const locked = await f.composeHostFile(false);
  assert.equal(locked.state, PromptSourceState.Off);
  assert.equal(locked.enabled, false);
  assert.equal(
    f.store.transaction((tx) => promptSettings(tx, PromptScope.System))
      .switches[HOST_FILE],
    true,
  );
  const restored = await f.composeHostFile(true);
  assert.equal(restored.state, PromptSourceState.Present);
  assert.equal(restored.text, HOST_TEXT);
});

test("the system layer switch and the override of an agent decide its system layer", async (t) => {
  const f = enablementFixture(t);
  const operation = agentOperations.get;
  const systemLayer = async () =>
    operation.output
      .parse(
        await f.registry.get(operation.id).handler(
          operation.input.parse({
            params: { agent_name: AGENT },
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
  const target = { scope: PromptScope.Agent, agent_name: AGENT };
  const on = f.invoke("prompt.switch", { ...target, system_layer: "on" }, {});
  assert.deepEqual([on.system_layer, on.revision], ["on", FIRST_REVISION]);
  assert.equal((await systemLayer())?.enabled, true);
  f.invoke(
    "prompt.switch",
    {
      scope: PromptScope.System,
      expected_revision: 1,
      switch: "layer",
      enabled: true,
    },
    {},
  );
  f.invoke(
    "prompt.switch",
    { ...target, expected_revision: 1, system_layer: "off" },
    {},
  );
  assert.equal((await systemLayer())?.enabled, false);
});

test("a prompt switch takes either a source switch or the override of an agent scope", () => {
  const body = agentOperations["prompt.switch"].input.shape.body;
  const agent = { scope: PromptScope.Agent, agent_name: AGENT };
  for (const invalid of [
    agent,
    { ...agent, switch: "custom", enabled: false, system_layer: "on" },
    { ...agent, switch: "custom" },
    { scope: PromptScope.System, system_layer: "on" },
    { scope: PromptScope.Workbench, agent_name: AGENT, system_layer: "off" },
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
  const target = { scope: PromptScope.Agent, agent_name: AGENT };
  const first = f.invoke("prompt.put", { ...target, custom_text: "a" }, {});
  f.invoke(
    "prompt.put",
    { ...target, expected_revision: 1, custom_text: "b" },
    {},
  );
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { ...target, expected_revision: 1, custom_text: "c" },
        {},
      ),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
    {
      scope: target.scope,
      agent_name: AGENT,
      current: { ...first, custom_text: "b", revision: 2 },
    },
  );
  refuses(
    () => f.invoke("prompt.put", { ...target, custom_text: "d" }, {}),
    AgentErrorCode.PromptRevisionConflict,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke(
        "prompt.switch",
        {
          scope: PromptScope.System,
          expected_revision: 1,
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
  const target = { scope: PromptScope.Agent, agent_name: AGENT };
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { ...target, custom_text: "a".repeat(PROMPT_TEXT_MAX_BYTES + 1) },
        {},
      ),
    AgentErrorCode.PromptTooLarge,
  );
  assert.equal(
    f.invoke(
      "prompt.put",
      { ...target, custom_text: "\u00e9".repeat(PROMPT_TEXT_MAX_BYTES / 2) },
      {},
    ).revision,
    FIRST_REVISION,
  );
  f.invoke(
    "prompt.switch",
    { ...target, expected_revision: 1, switch: "agent_file", enabled: false },
    {},
  );
  f.invoke(
    "prompt.switch",
    { ...target, expected_revision: 2, switch: "shipped", enabled: false },
    {},
  );
  refuses(
    () =>
      f.invoke(
        "prompt.switch",
        { ...target, expected_revision: 3, switch: "custom", enabled: false },
        {},
      ),
    AgentErrorCode.PromptAgentLayerEmpty,
    HttpStatus.Conflict,
  );
  refuses(
    () =>
      f.invoke(
        "prompt.put",
        { scope: PromptScope.Workbench, agent_name: UNKNOWN, custom_text: "x" },
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
      agent_name: AGENT,
      switch: "bogus",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    input({
      scope: "system",
      agent_name: AGENT,
      switch: "base",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    input({ scope: "agent", switch: "custom", enabled: true }),
    false,
  );
  assert.equal(
    input({
      scope: "agent",
      agent_name: AGENT,
      switch: "custom",
      enabled: true,
    }),
    true,
  );
});

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-5";
const spareHaiku = {
  agent_provider: spare.name,
  model_identifier: HAIKU,
  reasoning_effort: DEFAULT_REASONING,
};
const primaryOpus = {
  agent_provider: provider.name,
  model_identifier: OPUS,
  reasoning_effort: DEFAULT_REASONING,
};
const chainBody = {
  agent_providers: [provider, spare],
  default_configuration: defaults,
  fallback_configurations: [spareHaiku, primaryOpus],
};

function chainOf(
  f: ReturnType<typeof enablementFixture>,
  entry: AgentEntry | null,
) {
  return f.store
    .transaction((tx) => f.agent.agentView(tx, AGENT, entry, SERVER_SCOPE))
    ?.chain.map(({ position, level, agent_provider, model_identifier }) => ({
      position,
      level,
      agent_provider,
      model_identifier,
    }));
}

test("put stores the fallback chain and the agent view resolves an inherited, a replaced and an empty tail", (t) => {
  const f = enablementFixture(t);
  assert.deepEqual(
    f.invoke("enablement.put", chainBody).fallback_configurations,
    [spareHaiku, primaryOpus],
  );
  assert.deepEqual(
    f.invoke("enablement.get").fallback_configurations,
    chainBody.fallback_configurations,
  );
  const enablement = ChainLevel.Enablement;
  const bound = ChainLevel.Binding;
  assert.deepEqual(chainOf(f, null), [
    {
      position: 0,
      level: enablement,
      agent_provider: provider.name,
      model_identifier: MODEL,
    },
    {
      position: 1,
      level: enablement,
      agent_provider: spare.name,
      model_identifier: HAIKU,
    },
    {
      position: 2,
      level: enablement,
      agent_provider: provider.name,
      model_identifier: OPUS,
    },
  ]);
  const view = f.store.transaction((tx) =>
    f.agent.agentView(tx, AGENT, null, SERVER_SCOPE),
  );
  assert.equal(view?.chain[1]?.credential, spare.credential);
  assert.deepEqual(chainOf(f, { fallback_configurations: [primaryOpus] }), [
    {
      position: 0,
      level: enablement,
      agent_provider: provider.name,
      model_identifier: MODEL,
    },
    {
      position: 1,
      level: bound,
      agent_provider: provider.name,
      model_identifier: OPUS,
    },
  ]);
  assert.deepEqual(chainOf(f, { fallback_configurations: [] }), [
    {
      position: 0,
      level: enablement,
      agent_provider: provider.name,
      model_identifier: MODEL,
    },
  ]);
  assert.deepEqual(chainOf(f, spareHaiku), [
    {
      position: 0,
      level: bound,
      agent_provider: spare.name,
      model_identifier: HAIKU,
    },
    {
      position: 1,
      level: enablement,
      agent_provider: provider.name,
      model_identifier: OPUS,
    },
  ]);
});

test("put refuses a missing tail, a long tail, a duplicate tail entry and an invalid tail entry", (t) => {
  const f = enablementFixture(t);
  const withoutTail = {
    agent_providers: chainBody.agent_providers,
    default_configuration: chainBody.default_configuration,
  };
  assert.throws(() => f.invoke("enablement.put", withoutTail));
  const longTail = Array.from(
    { length: FALLBACK_CONFIGURATIONS_MAX + 1 },
    () => primaryOpus,
  );
  assert.throws(() =>
    f.invoke("enablement.put", {
      ...chainBody,
      fallback_configurations: longTail,
    }),
  );
  for (const tail of [
    [primaryOpus, { ...primaryOpus, reasoning_effort: "high" }],
    [{ ...defaults, reasoning_effort: "high" }],
  ])
    refuses(
      () =>
        f.invoke("enablement.put", {
          ...chainBody,
          fallback_configurations: tail,
        }),
      AgentErrorCode.FallbackDuplicate,
    );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...chainBody,
        fallback_configurations: [
          { ...primaryOpus, model_identifier: MISSING_MODEL },
        ],
      }),
    AgentErrorCode.ModelUnknown,
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...chainBody,
        fallback_configurations: [{ ...primaryOpus, agent_provider: UNKNOWN }],
      }),
    AgentErrorCode.ProviderNotFound,
    HttpStatus.NotFound,
  );
  assert.equal(
    f.store.transaction((tx) => getLatestRevision(tx, AGENT)),
    null,
  );
});

test("provider removal and omission are refused while a fallback entry names the provider", (t) => {
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, { entriesOfAgent: () => entries });
  f.invoke("enablement.put", chainBody);
  refuses(
    () =>
      f.invoke(
        REMOVE_PROVIDER,
        { expected_revision: FIRST_REVISION },
        { agent_name: AGENT, provider_name: spare.name },
      ),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    { agent_name: AGENT, dependents: [{ kind: "fallback_configurations" }] },
  );
  f.invoke("enablement.put", {
    ...chainBody,
    expected_revision: FIRST_REVISION,
    fallback_configurations: [primaryOpus],
  });
  entries = [{ ...binding, entry: { fallback_configurations: [spareHaiku] } }];
  refuses(
    () =>
      f.invoke(
        REMOVE_PROVIDER,
        { expected_revision: SECOND_REVISION },
        { agent_name: AGENT, provider_name: spare.name },
      ),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      dependents: [{ binding_id: binding.binding_id, worker_name: WORKER }],
    },
  );
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...chainBody,
        expected_revision: SECOND_REVISION,
        agent_providers: [provider],
        fallback_configurations: [primaryOpus],
      }),
    AgentErrorCode.ProviderInUse,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [{ binding_id: binding.binding_id, worker_name: WORKER }],
    },
  );
});

test("a binding entry takes a tail alone and refuses a duplicate or an invalid tail entry", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", chainBody);
  const validate = (entry: AgentEntry) =>
    f.store.transaction((tx) =>
      f.agent.validateEntry(tx, AGENT, entry, [SERVER_HOLDER]),
    );
  for (const entry of [
    { fallback_configurations: [] },
    { fallback_configurations: [spareHaiku] },
    { ...spareHaiku, fallback_configurations: [primaryOpus] },
  ])
    assert.doesNotThrow(() => validate(entry));
  for (const entry of [
    { fallback_configurations: [spareHaiku, spareHaiku] },
    { fallback_configurations: [{ ...defaults, reasoning_effort: "high" }] },
    { ...spareHaiku, fallback_configurations: [spareHaiku] },
  ])
    refuses(() => validate(entry), AgentErrorCode.FallbackDuplicate);
  refuses(
    () =>
      validate({
        fallback_configurations: [
          { ...spareHaiku, reasoning_effort: "invented" },
        ],
      }),
    AgentErrorCode.ReasoningUnsupported,
  );
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.agent.agentView(
        tx,
        AGENT,
        {
          fallback_configurations: [
            { ...spareHaiku, model_identifier: MISSING_MODEL },
          ],
        },
        SERVER_SCOPE,
      ),
    ),
    {
      defaults,
      effective: null,
      chain: [],
      active_position: null,
      cooling: null,
      valid: false,
      issues: [
        {
          path: ["fallback_configurations", "0", "model_identifier"],
          code: AgentErrorCode.ModelUnknown,
        },
      ],
    },
  );
});

test("a model named only by a fallback entry makes its enablement a model dependent", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", chainBody);
  f.store.transaction((tx) => {
    assert.deepEqual(
      f.agent
        .enablementsDependentOnModel(tx, spare.credential, HAIKU)
        .map(({ agent_name }) => agent_name),
      [AGENT],
    );
    assert.deepEqual(
      f.agent.enablementsDependentOnModel(tx, spare.credential, OPUS),
      [],
    );
  });
});

const HEAD_POSITION = 0;
const SECOND_POSITION = 1;
const FIRST_STRIKE = 1;
const SECOND_STRIKE = 2;
const CLOCK_START = 1_000_000;
const DOUBLING_STRIKES = 12;
const EXECUTION_ID = "execution";
const OTHER_EXECUTION_ID = "other-execution";
const REDACTED_FIELD = "credential";
const ONE_LOG = 1;
const TWO_LOGS = 2;

function holdFixture(
  t: TestContext,
  collaborations: Partial<Dependencies> = {},
) {
  let now = CLOCK_START;
  const f = enablementFixture(t, { clock: () => now, ...collaborations });
  f.invoke("enablement.put", chainBody);
  const select = () =>
    f.store.transaction((tx) =>
      f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
    );
  const selected = () => {
    const chosen = select();
    assert.ok(chosen.kind === SelectionKind.Selected);
    return chosen.selection;
  };
  const view = () => {
    const answer = f.store.transaction((tx) =>
      f.agent.agentView(tx, AGENT, null, SERVER_SCOPE),
    );
    assert.ok(answer);
    return answer;
  };
  const fail = (selection: AgentSelection, code: AdvancingFailure) => {
    const changes = f.store.transaction((tx) =>
      f.agent.recordProviderFailure(
        tx,
        [selection],
        SERVER_HOLDER,
        code,
        EXECUTION_ID,
        now,
      ),
    );
    f.agent.recordCooldowns(changes);
    return changes;
  };
  const succeed = (selection: AgentSelection) => {
    const changes = f.store.transaction((tx) =>
      f.agent.recordSuccess(tx, [selection], SERVER_HOLDER, EXECUTION_ID),
    );
    f.agent.recordCooldowns(changes);
    return changes;
  };
  return {
    ...f,
    select,
    selected,
    view,
    fail,
    succeed,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a provider failure cools every chain entry of its credential", (t) => {
  const f = holdFixture(t);
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  const afterHead = f.view();
  const availableAt = f.now() + COOLDOWN_DEFAULTS.rate_limited_ms;
  assert.deepEqual(
    afterHead.chain.map(({ cooldown }) => cooldown),
    [
      { strikes: FIRST_STRIKE, available_at: availableAt },
      null,
      { strikes: FIRST_STRIKE, available_at: availableAt },
    ],
  );
  assert.equal(afterHead.active_position, SECOND_POSITION);
  assert.equal(afterHead.cooling, null);
  const next = f.selected();
  assert.deepEqual(
    [next.position, next.model_identifier, next.credential],
    [SECOND_POSITION, HAIKU, spare.credential],
  );
  f.fail(next, AdvancingFailure.QuotaExhausted);
  assert.deepEqual(f.select(), {
    kind: SelectionKind.Cooling,
    available_at: availableAt,
  });
  const cooling = f.view();
  assert.equal(cooling.valid, true);
  assert.equal(cooling.active_position, null);
  assert.deepEqual(cooling.cooling, {
    code: AgentErrorCode.ChainCooling,
    available_at: availableAt,
  });
  assert.deepEqual(
    cooling.chain.map(({ cooldown }) => cooldown?.available_at),
    [availableAt, f.now() + COOLDOWN_DEFAULTS.quota_exhausted_ms, availableAt],
  );
  f.advance(COOLDOWN_DEFAULTS.rate_limited_ms);
  const back = f.selected();
  assert.equal(back.position, HEAD_POSITION);
});

test("a success on any model of the credential releases the hold and resets the strikes", (t) => {
  const f = holdFixture(t);
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  f.advance(COOLDOWN_DEFAULTS.rate_limited_ms);
  f.fail(head, AdvancingFailure.RateLimited);
  assert.deepEqual(f.view().chain[HEAD_POSITION]?.cooldown, {
    strikes: SECOND_STRIKE,
    available_at: f.now() + 2 * COOLDOWN_DEFAULTS.rate_limited_ms,
  });
  const sameCredentialOtherModel = f.view().chain[2];
  assert.ok(sameCredentialOtherModel);
  assert.equal(sameCredentialOtherModel.credential, head.credential);
  assert.notEqual(
    sameCredentialOtherModel.model_identifier,
    head.model_identifier,
  );
  f.succeed({
    ...head,
    position: sameCredentialOtherModel.position,
    model_identifier: sameCredentialOtherModel.model_identifier,
  });
  assert.deepEqual(
    f.view().chain.map(({ cooldown }) => cooldown),
    [null, null, null],
  );
  assert.deepEqual(f.invoke("cooldown.list", null, {}), { items: [] });
  f.fail(head, AdvancingFailure.RateLimited);
  assert.equal(f.view().chain[HEAD_POSITION]?.cooldown?.strikes, FIRST_STRIKE);
});

test("a repeated failure doubles the hold up to the maximum and an expired hold keeps its strikes", (t) => {
  const f = holdFixture(t);
  const head = f.selected();
  const { rate_limited_ms, max_ms } = COOLDOWN_DEFAULTS;
  for (let strike = 1; strike <= DOUBLING_STRIKES; strike++) {
    f.fail(head, AdvancingFailure.RateLimited);
    assert.deepEqual(f.view().chain[HEAD_POSITION]?.cooldown, {
      strikes: strike,
      available_at:
        f.now() + Math.min(max_ms, rate_limited_ms * 2 ** (strike - 1)),
    });
    f.advance(max_ms);
  }
  const expired = f.view();
  assert.equal(expired.active_position, HEAD_POSITION);
  assert.equal(
    expired.chain[HEAD_POSITION]?.cooldown?.strikes,
    DOUBLING_STRIKES,
  );
  f.fail(head, AdvancingFailure.QuotaExhausted);
  assert.equal(
    f.view().chain[HEAD_POSITION]?.cooldown?.available_at,
    f.now() + max_ms,
  );
});

test("a provider failure returns one cooldown change per credential, logs nothing in its transaction, and recordCooldowns logs agent.fallback.cooldown_started with its strikes and end", (t) => {
  const { logger, logs } = capturedLogger();
  const f = holdFixture(t, { logger });
  const head = f.selected();
  const sameCredentialOtherModel = f.view().chain[2];
  assert.ok(sameCredentialOtherModel);
  assert.equal(sameCredentialOtherModel.credential, head.credential);
  const availableAt = f.now() + COOLDOWN_DEFAULTS.rate_limited_ms;
  const changes = f.store.transaction((tx) => {
    const made = f.agent.recordProviderFailure(
      tx,
      [
        head,
        {
          ...head,
          position: sameCredentialOtherModel.position,
          model_identifier: sameCredentialOtherModel.model_identifier,
        },
      ],
      SERVER_HOLDER,
      AdvancingFailure.RateLimited,
      EXECUTION_ID,
      f.now(),
    );
    assert.deepEqual(logs, []);
    return made;
  });
  assert.deepEqual(changes, [
    {
      kind: CooldownChangeKind.Started,
      execution_id: EXECUTION_ID,
      credential: head.credential,
      holder: SERVER_HOLDER,
      code: AdvancingFailure.RateLimited,
      strikes: FIRST_STRIKE,
      available_at: availableAt,
    },
  ]);
  f.agent.recordCooldowns(changes);
  assert.deepEqual(logs, [
    {
      level: pino.levels.values.info,
      msg: FallbackLog.CooldownStarted,
      execution_id: EXECUTION_ID,
      credential_name: head.credential,
      holder: SERVER_HOLDER,
      code: AdvancingFailure.RateLimited,
      strikes: FIRST_STRIKE,
      available_at: availableAt,
    },
  ]);
  f.advance(COOLDOWN_DEFAULTS.rate_limited_ms);
  f.fail(head, AdvancingFailure.RateLimited);
  assert.deepEqual(logs[1], {
    level: pino.levels.values.info,
    msg: FallbackLog.CooldownStarted,
    execution_id: EXECUTION_ID,
    credential_name: head.credential,
    holder: SERVER_HOLDER,
    code: AdvancingFailure.RateLimited,
    strikes: SECOND_STRIKE,
    available_at: f.now() + 2 * COOLDOWN_DEFAULTS.rate_limited_ms,
  });
  assert.equal(logs.length, TWO_LOGS);
  assert.ok(logs.every((record) => !(REDACTED_FIELD in record)));
});

test("a release of a hold returns one cleared change, and recordCooldowns logs agent.fallback.cooldown_cleared; a release without a hold returns none", (t) => {
  const { logger, logs } = capturedLogger();
  const f = holdFixture(t, { logger });
  const head = f.selected();
  const sameCredentialOtherModel = f.view().chain[2];
  assert.ok(sameCredentialOtherModel);
  assert.equal(sameCredentialOtherModel.credential, head.credential);
  const sameCredential = {
    ...head,
    position: sameCredentialOtherModel.position,
    model_identifier: sameCredentialOtherModel.model_identifier,
  };
  assert.deepEqual(f.succeed(head), []);
  assert.deepEqual(logs, []);
  f.fail(head, AdvancingFailure.RateLimited);
  logs.length = 0;
  const changes = f.store.transaction((tx) => {
    const made = f.agent.recordSuccess(
      tx,
      [head, sameCredential],
      SERVER_HOLDER,
      EXECUTION_ID,
    );
    assert.deepEqual(logs, []);
    return made;
  });
  assert.deepEqual(changes, [
    {
      kind: CooldownChangeKind.Cleared,
      execution_id: EXECUTION_ID,
      credential: head.credential,
      holder: SERVER_HOLDER,
    },
  ]);
  f.agent.recordCooldowns(changes);
  assert.deepEqual(logs, [
    {
      level: pino.levels.values.info,
      msg: FallbackLog.CooldownCleared,
      execution_id: EXECUTION_ID,
      credential_name: head.credential,
      holder: SERVER_HOLDER,
    },
  ]);
  assert.deepEqual(f.succeed(head), []);
  assert.equal(logs.length, ONE_LOG);
});

test("recordSelection logs agent.fallback.selected for each selection", (t) => {
  const { logger, logs } = capturedLogger();
  const f = holdFixture(t, { logger });
  const head = f.selected();
  const second = {
    ...head,
    position: SECOND_POSITION,
    level: ChainLevel.Binding,
    agent_provider: spare.name,
    credential: spare.credential,
    model_identifier: HAIKU,
  };
  f.agent.recordSelection([head, second], OTHER_EXECUTION_ID);
  assert.deepEqual(
    logs,
    [head, second].map((selection) => ({
      level: pino.levels.values.info,
      msg: FallbackLog.Selected,
      execution_id: OTHER_EXECUTION_ID,
      agent_name: AGENT,
      chain_position: selection.position,
      chain_level: selection.level,
      agent_provider: selection.agent_provider,
      provider: selection.provider,
      model_identifier: selection.model_identifier,
      credential_name: selection.credential,
    })),
  );
  assert.ok(logs.every((record) => !(REDACTED_FIELD in record)));
  f.agent.recordSelection([], OTHER_EXECUTION_ID);
  assert.equal(logs.length, TWO_LOGS);
});

const CHAIN_ENTRIES: ReadonlyArray<{
  entry: AgentEntry | null;
  length: number;
}> = [
  { entry: null, length: 2 },
  { entry: { fallback_configurations: [spareHaiku] }, length: 2 },
  { entry: { fallback_configurations: [] }, length: 1 },
  {
    entry: { model_identifier: HAIKU, fallback_configurations: [primaryOpus] },
    length: 1,
  },
];

test("selectionAt answers the claim selection of every chain position", (t) => {
  for (const { entry, length } of CHAIN_ENTRIES) {
    const f = enablementFixture(t);
    f.invoke("enablement.put", chainBody);
    const positions: number[] = [];
    for (;;) {
      const chosen = f.store.transaction((tx) =>
        f.agent.selectAgent(tx, AGENT, entry, SERVER_SCOPE),
      );
      if (chosen.kind === SelectionKind.Cooling) break;
      assert.ok(chosen.kind === SelectionKind.Selected);
      positions.push(chosen.selection.position);
      assert.deepEqual(
        f.store.transaction((tx) =>
          f.agent.selectionAt(
            tx,
            AGENT,
            chosen.enablement_id,
            entry,
            chosen.selection.position,
          ),
        ),
        chosen.selection,
      );
      f.store.transaction((tx) =>
        f.agent.recordProviderFailure(
          tx,
          [chosen.selection],
          SERVER_HOLDER,
          AdvancingFailure.RateLimited,
          EXECUTION_ID,
          Date.now(),
        ),
      );
    }
    assert.equal(positions.length, length);
    assert.deepEqual(positions, [...positions.keys()]);
  }
});

test("selectionAt keeps the pinned enablement revision after a newer revision", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", chainBody);
  const chosen = f.store.transaction((tx) =>
    f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
  );
  assert.ok(chosen.kind === SelectionKind.Selected);
  f.invoke("enablement.put", {
    ...chainBody,
    expected_revision: FIRST_REVISION,
    default_configuration: { ...defaults, model_identifier: HAIKU },
    fallback_configurations: [],
  });
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.agent.selectionAt(tx, AGENT, chosen.enablement_id, null, 0),
    ),
    chosen.selection,
  );
  assert.throws(() =>
    f.store.transaction((tx) =>
      f.agent.selectionAt(tx, AGENT, chosen.enablement_id, null, 3),
    ),
  );
  assert.throws(() =>
    f.store.transaction((tx) =>
      f.agent.selectionAt(tx, AGENT, "agent_enablement_absent", null, 0),
    ),
  );
});

test("a hold is shared by every agent that names the credential, and an invalid chain selects nothing", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", chainBody);
  f.invoke("enablement.put", chainBody, { agent_name: OTHER_AGENT });
  const selected = f.store.transaction((tx) =>
    f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
  );
  assert.ok(selected.kind === SelectionKind.Selected);
  f.store.transaction((tx) =>
    f.agent.recordProviderFailure(
      tx,
      [selected.selection],
      SERVER_HOLDER,
      AdvancingFailure.RateLimited,
      EXECUTION_ID,
      Date.now(),
    ),
  );
  const other = f.store.transaction((tx) =>
    f.agent.selectAgent(tx, OTHER_AGENT, null, SERVER_SCOPE),
  );
  assert.ok(other.kind === SelectionKind.Selected);
  assert.equal(other.selection.position, SECOND_POSITION);
  assert.equal(other.selection.agent_name, OTHER_AGENT);
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.agent.selectAgent(
        tx,
        AGENT,
        { model_identifier: MISSING_MODEL },
        SERVER_SCOPE,
      ),
    ),
    { kind: SelectionKind.Invalid },
  );
});

test("a human lists the holds and clears one by credential name, and a clear of an absent hold answers not found", (t) => {
  const now = 2_000_000;
  const f = enablementFixture(t, { clock: () => now });
  f.invoke("enablement.put", chainBody);
  const selected = f.store.transaction((tx) =>
    f.agent.selectAgent(tx, AGENT, null, SERVER_SCOPE),
  );
  assert.ok(selected.kind === SelectionKind.Selected);
  f.store.transaction((tx) =>
    f.agent.recordProviderFailure(
      tx,
      [selected.selection],
      SERVER_HOLDER,
      AdvancingFailure.QuotaExhausted,
      EXECUTION_ID,
      now,
    ),
  );
  assert.deepEqual(f.invoke("cooldown.list", null, {}), {
    items: [
      {
        credential: provider.credential,
        holder: SERVER_HOLDER,
        strikes: FIRST_STRIKE,
        available_at: now + COOLDOWN_DEFAULTS.quota_exhausted_ms,
      },
    ],
  });
  assert.equal(
    f.invoke("cooldown.clear", null, { credential: provider.credential }),
    null,
  );
  assert.deepEqual(f.invoke("cooldown.list", null, {}), { items: [] });
  refuses(
    () => f.invoke("cooldown.clear", null, { credential: provider.credential }),
    AgentErrorCode.CooldownNotFound,
    HttpStatus.NotFound,
    { credential: provider.credential, holder: SERVER_HOLDER },
  );
});

test("a committed human clear of a cooldown logs agent.fallback.cooldown_cleared", (t) => {
  const { logger, logs } = capturedLogger();
  const f = holdFixture(t, { logger });
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  logs.length = 0;
  f.invoke("cooldown.clear", null, { credential: head.credential });
  assert.deepEqual(logs, [
    {
      level: pino.levels.values.info,
      msg: FallbackLog.CooldownCleared,
      credential_name: head.credential,
      holder: SERVER_HOLDER,
    },
  ]);
  refuses(
    () => f.invoke("cooldown.clear", null, { credential: head.credential }),
    AgentErrorCode.CooldownNotFound,
    HttpStatus.NotFound,
    { credential: head.credential, holder: SERVER_HOLDER },
  );
  assert.equal(logs.length, ONE_LOG);
});

test("a rolled-back clear of a cooldown writes no log", (t) => {
  const { logger, logs } = capturedLogger();
  const f = holdFixture(t, { logger });
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  logs.length = 0;
  const held = f.invoke("cooldown.list", null, {});
  assert.notDeepEqual(held, { items: [] });
  const rollback = new Error("rolled back");
  const operation = agentOperations["cooldown.clear"];
  assert.throws(
    () =>
      f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { credential: head.credential },
          query: {},
          body: null,
        }),
        {
          ...f.caller,
          commit: (write) =>
            f.store.transaction((tx) => {
              write(tx);
              throw rollback;
            }),
        },
      ),
    rollback,
  );
  assert.deepEqual(logs, []);
  assert.deepEqual(f.invoke("cooldown.list", null, {}), held);
});

test("the holder rule refuses a holder without a live copy at the entry write, the enablement write and the resolution, the fallback entry included", (t) => {
  const RELAY_A = "relay-a";
  const RELAY_B = "relay-b";
  const held = new Set([`${provider.credential}/${RELAY_A}`]);
  let entries: AgentDependentBinding[] = [];
  const f = enablementFixture(t, {
    copyHeld: (_tx, credential, holder) =>
      holder === SERVER_HOLDER || held.has(`${credential}/${holder}`),
    entriesOfAgent: () => entries,
  });
  f.invoke("enablement.put", putBody);
  const validate = (holders: string[]) =>
    f.store.transaction((tx) =>
      f.agent.validateEntry(tx, AGENT, null, holders),
    );
  validate([RELAY_A]);
  refuses(
    () => validate([RELAY_A, RELAY_B]),
    AgentErrorCode.CredentialHolderMismatch,
    HttpStatus.BadRequest,
    {
      agent: AGENT,
      agent_provider: provider.name,
      credential: provider.credential,
      holder: RELAY_B,
    },
  );
  const scope = { holders: [RELAY_A], claimant: RELAY_A };
  const select = () =>
    f.store.transaction((tx) => f.agent.selectAgent(tx, AGENT, null, scope));
  assert.equal(select().kind, SelectionKind.Selected);
  entries = [{ ...binding, holders: [RELAY_A] }];
  refuses(
    () => f.invoke("enablement.put", { ...chainBody, expected_revision: 1 }),
    AgentErrorCode.InvalidatesBindings,
    HttpStatus.Conflict,
    {
      agent_name: AGENT,
      bindings: [
        {
          binding_id: binding.binding_id,
          worker_name: WORKER,
          code: AgentErrorCode.CredentialHolderMismatch,
        },
      ],
    },
  );
  entries = [];
  f.invoke("enablement.put", { ...chainBody, expected_revision: 1 });
  assert.equal(select().kind, SelectionKind.Invalid);
  held.add(`${spare.credential}/${RELAY_A}`);
  assert.equal(select().kind, SelectionKind.Selected);
  held.delete(`${provider.credential}/${RELAY_A}`);
  assert.equal(select().kind, SelectionKind.Invalid);
  assert.deepEqual(
    f.store.transaction((tx) => f.agent.agentView(tx, AGENT, null, scope))
      ?.issues,
    [
      {
        path: ["agent_provider"],
        code: AgentErrorCode.CredentialHolderMismatch,
      },
      {
        path: ["fallback_configurations", "1", "agent_provider"],
        code: AgentErrorCode.CredentialHolderMismatch,
      },
    ],
  );
});

test("a view without a claimant shows the hold with the latest available_at over the holders of the binding", (t) => {
  const RELAY_A = "relay-a";
  const RELAY_B = "relay-b";
  const EARLY = 1000;
  const LATE = 9000;
  const holds = memoryCredentialHolds();
  const f = enablementFixture(t, { credentialHolds: holds });
  f.invoke("enablement.put", putBody);
  f.store.transaction((tx) => {
    holds.hold(tx, provider.credential, RELAY_A, EARLY, FIRST_STRIKE);
    holds.hold(tx, provider.credential, RELAY_B, LATE, SECOND_STRIKE);
  });
  const cooldownOf = (scope: HolderScope) =>
    f.store.transaction((tx) => f.agent.agentView(tx, AGENT, null, scope))
      ?.chain[0]?.cooldown;
  assert.deepEqual(
    cooldownOf({ holders: [RELAY_A, RELAY_B], claimant: null }),
    { available_at: LATE, strikes: SECOND_STRIKE },
  );
  assert.deepEqual(
    cooldownOf({ holders: [RELAY_A, RELAY_B], claimant: RELAY_A }),
    { available_at: EARLY, strikes: FIRST_STRIKE },
  );
  assert.equal(cooldownOf(SERVER_SCOPE), null);
});

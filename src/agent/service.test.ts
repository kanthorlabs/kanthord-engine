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
  type ChainEntry,
  PromptOrigin,
  PromptPart,
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
import { getAgentDeclaration } from "./catalog.ts";
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
import {
  SHIPPED_TEMPLATES,
  TemplateInvalidReason,
} from "./prompt-templates.ts";
import {
  capturedLogger,
  FallbackLog,
  memoryCredentialHolds,
} from "./test-support.ts";

const PROVIDER_CAPABILITY = "model-list read";
const DEFAULT_REASONING = "off";
const PROJECT_TEXT = "project prompt text";
const REVIEW_TEXT = "review prompt text";
const FRAMING_WORKBENCH = "framing-workbench";
const OVERRIDE_TEXT = "Write the smallest complete change.";
const INVALID_OVERRIDE_TEXT = "bell\u0007";
const AGENT = "swe@1";
const OTHER_AGENT = "re@1";
const ENV_AGENT = "env@1";
const WORKER = "coder@1";
const MODEL = "claude-sonnet-4-5";
const SUBSCRIPTION_MODEL = "claude-haiku-5-5";
const MISSING_MODEL = "claude-3-5-sonnet-20241022";
const UNKNOWN = "unknown";
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
    prompt: { agent_directory: "" },
    cooldown: COOLDOWN_DEFAULTS,
  },
  dataDirectory: "/nonexistent/data",
  custodySuitability: () => {},
  copyHeld: () => true,
  approvedModels: () => null,
  entriesOfAgent: () => [],
  repositoryPromptsOf: () => null,
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

function promptReader(f: ReturnType<typeof enablementFixture>) {
  const operation = agentOperations.get;
  return async (agentName: string, query: Record<string, unknown> = {}) =>
    operation.output.parse(
      await f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { agent_name: agentName },
          query,
          body: null,
        }),
        f.caller,
      ),
    );
}

test("agent read answers the shipped parts, the workbench part of a workbench agent and the final prompt", async (t) => {
  const f = enablementFixture(t);
  const read = promptReader(f);
  const answer = await read(AGENT);
  const parts = answer.prompt.parts!;
  assert.deepEqual(
    parts.map(({ part, name, origin, path }) => [part, name, origin, path]),
    [
      [PromptPart.Standard, "base.md", PromptOrigin.Binary, null],
      [PromptPart.Role, `${AGENT}.md`, PromptOrigin.Binary, null],
      [PromptPart.Workbench, "workbench.md", PromptOrigin.Binary, null],
    ],
  );
  assert.equal(parts[1]!.text, getAgentDeclaration(AGENT)!.agent_prompt);
  assert.match(parts[0]!.digest, /^[a-f0-9]{64}$/);
  assert.equal(
    answer.prompt.final,
    [
      ...parts.map(({ text }) => text),
      framing(SHIPPED_TEMPLATES, PromptConsumer.Workbench),
    ].join("\n\n"),
  );
  const final = await read(AGENT, { view: "final" });
  assert.equal(final.prompt.parts, undefined);
  assert.equal(final.prompt.final, answer.prompt.final);
  const env = await read(ENV_AGENT);
  assert.deepEqual(
    env.prompt.parts!.map(({ part }) => part),
    [PromptPart.Standard, PromptPart.Role],
  );
  assert.ok(
    env.prompt.final.endsWith(
      framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
    ),
  );
});

test("an override file of the agent directory replaces the shipped text and an invalid one answers a conflict", async (t) => {
  const root = temporary(t);
  const directory = join(root, "agents");
  mkdirSync(directory);
  const f = enablementFixture(t, {
    config: {
      prompt: { agent_directory: "agents" },
      cooldown: COOLDOWN_DEFAULTS,
    },
    dataDirectory: root,
  });
  const read = promptReader(f);
  const overridePath = join(directory, `${AGENT}.md`);
  writeFileSync(overridePath, OVERRIDE_TEXT);
  const parts = (await read(AGENT)).prompt.parts!;
  assert.deepEqual(parts[0]!.path, join(directory, "base.md"));
  assert.equal(parts[0]!.origin, PromptOrigin.Binary);
  assert.deepEqual(
    {
      origin: parts[1]!.origin,
      path: parts[1]!.path,
      text: parts[1]!.text,
    },
    { origin: PromptOrigin.File, path: overridePath, text: OVERRIDE_TEXT },
  );
  const final = (await read(AGENT)).prompt.final;
  assert.ok(final.includes(OVERRIDE_TEXT));
  assert.ok(!final.includes(getAgentDeclaration(AGENT)!.agent_prompt));
  writeFileSync(overridePath, INVALID_OVERRIDE_TEXT);
  await assert.rejects(read(AGENT), {
    status: HttpStatus.Conflict,
    code: AgentErrorCode.PromptTemplateInvalid,
    details: {
      file: `${AGENT}.md`,
      path: overridePath,
      reason: "control_character",
    },
  });
});

test("agent read renders the framing from the template files of the agent directory", async (t) => {
  const root = temporary(t);
  const templates = join(root, "agents", "prompts");
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, "framing-workbench.md"), "Custom framing.\n");
  const f = enablementFixture(t, {
    config: {
      prompt: { agent_directory: "agents" },
      cooldown: COOLDOWN_DEFAULTS,
    },
    dataDirectory: root,
  });
  const read = promptReader(f);
  const answer = await read(AGENT, { view: "final" });
  assert.ok(answer.prompt.final.endsWith("Custom framing."));
  writeFileSync(join(templates, "framing-workbench.md"), "{{#if}}");
  await assert.rejects(read(AGENT), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, AgentErrorCode.PromptTemplateInvalid);
    assert.deepEqual(error.details, {
      template: FRAMING_WORKBENCH,
      file: `prompts/${FRAMING_WORKBENCH}.md`,
      path: join(templates, `${FRAMING_WORKBENCH}.md`),
      reason: TemplateInvalidReason.Syntax,
    });
    return true;
  });
});

test("agent read with a repository binding answers the binding prompt of the agent in the worker final", async (t) => {
  const root = temporary(t);
  const policies: Record<
    string,
    { project_id: string; prompts: Record<string, string> }
  > = {
    "binding-on": {
      project_id: "project-a",
      prompts: { [AGENT]: PROJECT_TEXT, "re@1": REVIEW_TEXT },
    },
    "binding-blank": {
      project_id: "project-a",
      prompts: { [AGENT]: " \n" },
    },
  };
  const f = enablementFixture(t, {
    dataDirectory: root,
    repositoryPromptsOf: (_, id) =>
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
  const on = await read({ project_id: "project-a", binding_id: "binding-on" });
  assert.deepEqual(
    on.prompt.parts!.map(({ part, origin, path, text }) => [
      part,
      origin,
      path,
      part === PromptPart.Binding ? text : null,
    ]),
    [
      [PromptPart.Standard, PromptOrigin.Binary, null, null],
      [PromptPart.Role, PromptOrigin.Binary, null, null],
      [PromptPart.Binding, PromptOrigin.Database, null, PROJECT_TEXT],
    ],
  );
  assert.ok(
    on.prompt.final.endsWith(
      `Instructions of repository repo:\n\n${PROJECT_TEXT}\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Worker)}`,
    ),
  );
  assert.ok(!on.prompt.final.includes(REVIEW_TEXT));
  const blank = await read({
    project_id: "project-a",
    binding_id: "binding-blank",
  });
  assert.ok(!blank.prompt.final.includes("Instructions of repository"));
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
  const parts = declaration.prompt.parts!;
  assert.ok(parts[0]!.text.startsWith("This text is the default standard."));
  assert.ok(parts[1]!.text.startsWith("## Role"));
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

test("put checks catalog then live expected revision and restarts enabled", (t) => {
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
    () => f.invoke("enablement.put", { ...putBody, expected_revision: 3 }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agent_name: AGENT, revision: null },
  );
  refuses(
    () => f.invoke("enablement.get"),
    AgentErrorCode.NotFound,
    HttpStatus.NotFound,
  );
  const restored = f.invoke("enablement.put", putBody);
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

test("put after remove creates the enablement with no expected revision at the next revision", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", putBody);
  f.invoke("enablement.remove", { expected_revision: 1 });
  const created = f.invoke("enablement.put", putBody);
  assert.equal(created.revision, THIRD_REVISION);
  assert.equal(created.state, EnablementState.Enabled);
  assert.deepEqual(f.invoke("enablement.get"), created);
});

test("put after remove refuses the removal revision", (t) => {
  const f = enablementFixture(t);
  f.invoke("enablement.put", putBody);
  f.invoke("enablement.remove", { expected_revision: 1 });
  refuses(
    () =>
      f.invoke("enablement.put", {
        ...putBody,
        expected_revision: SECOND_REVISION,
      }),
    AgentErrorCode.RevisionConflict,
    HttpStatus.Conflict,
    { agent_name: AGENT, revision: null },
  );
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

const INSTANCE_HOLDER = "instance-holder";

async function readAgent(f: ReturnType<typeof enablementFixture>) {
  const operation = agentOperations.get;
  return operation.output.parse(
    await f.registry.get(operation.id).handler(
      operation.input.parse({
        params: { agent_name: AGENT },
        query: {},
        body: null,
      }),
      f.caller,
    ),
  );
}

function selectionOf(entry: ChainEntry): AgentSelection {
  return {
    agent_name: AGENT,
    position: entry.position,
    level: entry.level,
    agent_provider: entry.agent_provider,
    provider: entry.provider,
    credential: entry.credential,
    model_identifier: entry.model_identifier,
    reasoning_effort: entry.reasoning_effort,
  };
}

test("agent read answers the chain of the enablement with no cooldown, with no copy check and without the hold of an instance copy", async (t) => {
  const holds = memoryCredentialHolds();
  const f = holdFixture(t, {
    credentialHolds: holds,
    copyHeld: () => false,
  });
  f.store.transaction((tx) =>
    holds.hold(
      tx,
      provider.credential,
      INSTANCE_HOLDER,
      f.now() + COOLDOWN_DEFAULTS.max_ms,
      FIRST_STRIKE,
    ),
  );
  const answer = await readAgent(f);
  assert.deepEqual(answer.chain, [
    {
      position: HEAD_POSITION,
      level: ChainLevel.Enablement,
      agent_provider: provider.name,
      provider: provider.provider,
      credential: provider.credential,
      model_identifier: MODEL,
      reasoning_effort: defaults.reasoning_effort,
      cooldown: null,
    },
    {
      position: SECOND_POSITION,
      level: ChainLevel.Enablement,
      agent_provider: spare.name,
      provider: spare.provider,
      credential: spare.credential,
      model_identifier: HAIKU,
      reasoning_effort: spareHaiku.reasoning_effort,
      cooldown: null,
    },
    {
      position: 2,
      level: ChainLevel.Enablement,
      agent_provider: provider.name,
      provider: provider.provider,
      credential: provider.credential,
      model_identifier: OPUS,
      reasoning_effort: primaryOpus.reasoning_effort,
      cooldown: null,
    },
  ]);
  assert.equal(answer.active_position, HEAD_POSITION);
  assert.equal(answer.cooling, null);
});

test("agent read shows one cooling entry and keeps the head active", async (t) => {
  const f = holdFixture(t);
  const second = f.view().chain[SECOND_POSITION];
  assert.ok(second);
  f.fail(selectionOf(second), AdvancingFailure.RateLimited);
  const answer = await readAgent(f);
  assert.deepEqual(
    answer.chain.map(({ cooldown }) => cooldown),
    [
      null,
      {
        strikes: FIRST_STRIKE,
        available_at: f.now() + COOLDOWN_DEFAULTS.rate_limited_ms,
      },
      null,
    ],
  );
  assert.equal(answer.active_position, HEAD_POSITION);
  assert.equal(answer.cooling, null);
});

test("agent read answers no active position and the earliest end when every entry cools", async (t) => {
  const f = holdFixture(t);
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  const afterHead = await readAgent(f);
  assert.equal(afterHead.active_position, SECOND_POSITION);
  assert.equal(afterHead.cooling, null);
  f.fail(f.selected(), AdvancingFailure.QuotaExhausted);
  const answer = await readAgent(f);
  const headEnd = f.now() + COOLDOWN_DEFAULTS.rate_limited_ms;
  assert.deepEqual(
    answer.chain.map(({ cooldown }) => cooldown?.available_at),
    [headEnd, f.now() + COOLDOWN_DEFAULTS.quota_exhausted_ms, headEnd],
  );
  assert.equal(answer.active_position, null);
  assert.deepEqual(answer.cooling, {
    code: AgentErrorCode.ChainCooling,
    available_at: headEnd,
  });
});

test("agent read shows an expired cooldown with its strikes and selects its entry", async (t) => {
  const f = holdFixture(t);
  const head = f.selected();
  f.fail(head, AdvancingFailure.RateLimited);
  const end = f.now() + COOLDOWN_DEFAULTS.rate_limited_ms;
  f.advance(COOLDOWN_DEFAULTS.rate_limited_ms);
  const answer = await readAgent(f);
  assert.deepEqual(answer.chain[HEAD_POSITION]?.cooldown, {
    strikes: FIRST_STRIKE,
    available_at: end,
  });
  assert.equal(answer.active_position, HEAD_POSITION);
  assert.equal(answer.cooling, null);
});

test("agent read answers an empty chain for an absent, a disabled and an invalid enablement", async (t) => {
  let failure: OperationError | null = null;
  const f = enablementFixture(t, {
    custodySuitability: () => {
      if (failure) throw failure;
    },
  });
  const empty = { chain: [], active_position: null, cooling: null };
  const absent = await readAgent(f);
  assert.equal(absent.enablement, null);
  assert.deepEqual(
    {
      chain: absent.chain,
      active_position: absent.active_position,
      cooling: absent.cooling,
    },
    empty,
  );
  const put = f.invoke("enablement.put", chainBody);
  const disabled = f.invoke("enablement.disable", {
    expected_revision: put.revision,
  });
  const off = await readAgent(f);
  assert.equal(off.enablement?.state, EnablementState.Disabled);
  assert.deepEqual(
    {
      chain: off.chain,
      active_position: off.active_position,
      cooling: off.cooling,
    },
    empty,
  );
  f.invoke("enablement.enable", { expected_revision: disabled.revision });
  failure = new OperationError(
    HttpStatus.NotFound,
    "credential.credential.not_found",
    "Missing credential.",
  );
  const invalid = await readAgent(f);
  assert.ok(invalid.enablement);
  assert.deepEqual(
    {
      chain: invalid.chain,
      active_position: invalid.active_position,
      cooling: invalid.cooling,
    },
    empty,
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

test("env@1 enablement takes a credential with the holder server", (t) => {
  const f = enablementFixture(t, {
    copyHeld: (_tx, _credential, holder) => holder === SERVER_HOLDER,
  });
  const params = { agent_name: ENV_AGENT };
  const put = f.invoke("enablement.put", putBody, params);
  assert.equal(put.agent_name, ENV_AGENT);
  const view = (agentName: string) =>
    f.store.transaction((tx) =>
      f.agent.agentView(tx, agentName, null, SERVER_SCOPE),
    );
  assert.equal(view(ENV_AGENT)?.valid, true);
  assert.deepEqual(view(AGENT)?.issues, [
    { path: [], code: AgentErrorCode.Unavailable },
  ]);
});

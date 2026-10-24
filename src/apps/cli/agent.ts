import assert from "node:assert/strict";
import { Command } from "commander";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { httpClient } from "../../gateway/client.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { addFileBodyHelp } from "./file-body.ts";
import {
  agentOperations,
  agentProviderItemSchema,
  agentProviderKindSchema,
  defaultConfigurationSchema,
  fallbackConfigurationsSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  PromptView,
} from "../../agent/contract.ts";
import { resolveClient } from "../../gateway/client.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const agentEnablementPutBodySchema = z.strictObject({
  expected_revision: z.number().int().positive().optional(),
  agent_providers: z.array(agentProviderItemSchema).min(1),
  default_configuration: defaultConfigurationSchema,
  fallback_configurations: fallbackConfigurationsSchema,
});
const providerAddBodySchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  name: z.string().min(1),
  provider: agentProviderKindSchema,
  credential: z.string().min(1),
});

const ENABLEMENT_EXAMPLE = {
  agent_providers: [
    { name: "main", provider: "anthropic", credential: "anthropic-main" },
  ],
  default_configuration: {
    agent_provider: "main",
    model_identifier: "claude-sonnet-4-5",
    reasoning_effort: "medium",
  },
  fallback_configurations: [],
};
const PROVIDER_ADD_EXAMPLE = {
  expected_revision: 1,
  name: "main",
  provider: "anthropic",
  credential: "anthropic-main",
};

const ENABLEMENT = "enablement";
const PROVIDER = "provider";
const MODEL = "model";
const COOLDOWN = "cooldown";
const CLEAR = "clear";
const COOLDOWN_LIST_TOKEN_REQUIRED = "cli.agent.cooldown.list.token_required";
const COOLDOWN_LIST_INDETERMINATE = "cli.agent.cooldown.list.indeterminate";
const COOLDOWN_CLEAR_TOKEN_REQUIRED = "cli.agent.cooldown.clear.token_required";
const COOLDOWN_CLEAR_INDETERMINATE = "cli.agent.cooldown.clear.indeterminate";
const LIST = "list";
const GET = "get";
const PUT = "put";
const ENABLE = "enable";
const DISABLE = "disable";
const REMOVE = "remove";
const ADD = "add";
const FILE_OPTION = "--file";
const REVISION_OPTION = "--expected-revision";
const KEY_OPTION = "--idempotency-key";
const GET_INVALID_VIEW = "cli.agent.get.invalid_view";
const GET_BINDING_PAIR = "cli.agent.get.project_binding_pair_required";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const LIST_TOKEN_REQUIRED = "cli.agent.enablement.list.token_required";
const GET_TOKEN_REQUIRED = "cli.agent.enablement.get.token_required";
const PUT_TOKEN_REQUIRED = "cli.agent.enablement.put.token_required";
const ENABLE_TOKEN_REQUIRED = "cli.agent.enablement.enable.token_required";
const DISABLE_TOKEN_REQUIRED = "cli.agent.enablement.disable.token_required";
const REMOVE_TOKEN_REQUIRED = "cli.agent.enablement.remove.token_required";
const ADD_TOKEN_REQUIRED = "cli.agent.enablement.provider.add.token_required";
const PROVIDER_REMOVE_TOKEN_REQUIRED =
  "cli.agent.enablement.provider.remove.token_required";
const MODEL_LIST_TOKEN_REQUIRED =
  "cli.agent.enablement.provider.model.list.token_required";
const LIST_INDETERMINATE = "cli.agent.enablement.list.indeterminate";
const GET_INDETERMINATE = "cli.agent.enablement.get.indeterminate";
const PUT_INDETERMINATE = "cli.agent.enablement.put.indeterminate";
const ENABLE_INDETERMINATE = "cli.agent.enablement.enable.indeterminate";
const DISABLE_INDETERMINATE = "cli.agent.enablement.disable.indeterminate";
const REMOVE_INDETERMINATE = "cli.agent.enablement.remove.indeterminate";
const ADD_INDETERMINATE = "cli.agent.enablement.provider.add.indeterminate";
const PROVIDER_REMOVE_INDETERMINATE =
  "cli.agent.enablement.provider.remove.indeterminate";
const MODEL_LIST_INDETERMINATE =
  "cli.agent.enablement.provider.model.list.indeterminate";
const CREDENTIAL_MODEL_LIST_TOKEN_REQUIRED =
  "cli.agent.model.list.token_required";
const CREDENTIAL_MODEL_LIST_INDETERMINATE =
  "cli.agent.model.list.indeterminate";
const CREDENTIAL_MODEL_LIST_INVALID_PROVIDER =
  "cli.agent.model.list.invalid_provider";
const ENABLE_INVALID_REVISION = "cli.agent.enablement.enable.invalid_revision";
const DISABLE_INVALID_REVISION =
  "cli.agent.enablement.disable.invalid_revision";
const REMOVE_INVALID_REVISION = "cli.agent.enablement.remove.invalid_revision";
const PROVIDER_REMOVE_INVALID_REVISION =
  "cli.agent.enablement.provider.remove.invalid_revision";

async function list(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LIST_TOKEN_REQUIRED);
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.list"
  ]({
    params: {},
    query: {
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, LIST_INDETERMINATE))}\n`,
  );
}

async function agentGet(agentName: string, command: Command): Promise<void> {
  assert.equal(agentOperations.get.access, AccessPolicy.Human);
  assert.equal(agentOperations.get.mutation, false);
  const options = command.optsWithGlobals();
  if (
    options.view !== undefined &&
    !Object.values(PromptView).includes(options.view)
  )
    throw new Diagnostic(GET_INVALID_VIEW, "the only view is final");
  if ((options.project === undefined) !== (options.bindingId === undefined))
    throw new Diagnostic(
      GET_BINDING_PAIR,
      "--project and --binding-id go together",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.agent.get.token_required");
  const result = await httpClient(agentOperations, endpoint, token).get({
    params: { agent_name: agentName },
    query: {
      ...(options.view !== undefined ? { view: options.view } : {}),
      ...(options.project !== undefined
        ? { project_id: options.project, binding_id: options.bindingId }
        : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.agent.get.indeterminate"))}\n`,
  );
}

async function get(agentName: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, GET_TOKEN_REQUIRED);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.get"
  ]({ params: { agent_name: agentName }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, GET_INDETERMINATE))}\n`,
  );
}

async function put(agentName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, PUT_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, agentEnablementPutBodySchema);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.put"
  ](
    { params: { agent_name: agentName }, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, PUT_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function enable(agentName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const expectedRevision = parsePositiveInt(
    options.expectedRevision,
    ENABLE_INVALID_REVISION,
  );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, ENABLE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.enable"
  ](
    {
      params: { agent_name: agentName },
      query: {},
      body: { expected_revision: expectedRevision },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, ENABLE_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function disable(agentName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const expectedRevision = parsePositiveInt(
    options.expectedRevision,
    DISABLE_INVALID_REVISION,
  );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, DISABLE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.disable"
  ](
    {
      params: { agent_name: agentName },
      query: {},
      body: { expected_revision: expectedRevision },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, DISABLE_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function remove(agentName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const expectedRevision = parsePositiveInt(
    options.expectedRevision,
    REMOVE_INVALID_REVISION,
  );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, REMOVE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.remove"
  ](
    {
      params: { agent_name: agentName },
      query: {},
      body: { expected_revision: expectedRevision },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, REMOVE_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function providerAdd(agentName: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, ADD_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const body = readJsonFileAs(options.file, providerAddBodySchema);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.provider.add"
  ](
    { params: { agent_name: agentName }, query: {}, body },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, ADD_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function providerRemove(
  agentName: string,
  providerName: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const expectedRevision = parsePositiveInt(
    options.expectedRevision,
    PROVIDER_REMOVE_INVALID_REVISION,
  );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, PROVIDER_REMOVE_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.provider.remove"
  ](
    {
      params: { agent_name: agentName, provider_name: providerName },
      query: {},
      body: { expected_revision: expectedRevision },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, PROVIDER_REMOVE_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function providerModelList(
  agentName: string,
  providerName: string,
  command: Command,
): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, MODEL_LIST_TOKEN_REQUIRED);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.provider.model.list"
  ]({
    params: { agent_name: agentName, provider_name: providerName },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, MODEL_LIST_INDETERMINATE))}\n`,
  );
}

async function credentialModelList(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const provider = agentProviderKindSchema.safeParse(options.provider);
  if (!provider.success)
    throw new Diagnostic(
      CREDENTIAL_MODEL_LIST_INVALID_PROVIDER,
      "the provider is not an agent provider kind",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, CREDENTIAL_MODEL_LIST_TOKEN_REQUIRED);
  const result = await httpClient(agentOperations, endpoint, token)[
    "model.list"
  ]({
    params: {},
    query: { provider: provider.data, credential: options.credential },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, CREDENTIAL_MODEL_LIST_INDETERMINATE))}\n`,
  );
}

async function cooldownList(command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, COOLDOWN_LIST_TOKEN_REQUIRED);
  const result = await httpClient(agentOperations, endpoint, token)[
    "cooldown.list"
  ]({ params: {}, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, COOLDOWN_LIST_INDETERMINATE))}\n`,
  );
}

async function cooldownClear(
  credential: string,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, COOLDOWN_CLEAR_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "cooldown.clear"
  ](
    {
      params: { credential },
      query: options.holder === undefined ? {} : { holder: options.holder },
      body: null,
    },
    { idempotencyKey: key },
  );
  handleMutationResult(result, COOLDOWN_CLEAR_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ idempotency_key: key })}\n`);
}

export function addAgentCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Agent),
  );
  const agent = program
    .command(CommandName.Agent)
    .description("Agent component commands")
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--token <token>",
      "Caller JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  agent
    .command("get")
    .argument("<agent-name>", "Agent name")
    .description("Get an agent declaration (human JWT)")
    .option(
      "--view <view>",
      "Answer the final prompt only",
      singleUse("--view"),
    )
    .option("--project <project-id>", "Project", singleUse("--project"))
    .option(
      "--binding-id <binding-id>",
      "Repository binding revision",
      singleUse("--binding-id"),
    )
    .action((agentName: string, _options, command: Command) =>
      agentGet(agentName, command),
    );
  agent.action(() => agent.help());
  const model = agent
    .command(MODEL)
    .description("Inspect the models of a credential");
  model.action(() => model.help());
  model
    .command(LIST)
    .description("List the models of a credential as JSON")
    .requiredOption(
      "--provider <provider>",
      "Agent provider kind",
      singleUse("--provider"),
    )
    .requiredOption(
      "--credential <credential>",
      "Credential name",
      singleUse("--credential"),
    )
    .action((_options, command: Command) => credentialModelList(command));
  const cooldown = agent
    .command(COOLDOWN)
    .description("Inspect and clear credential cooldowns");
  cooldown.action(() => cooldown.help());
  cooldown
    .command(LIST)
    .description("List the cooldowns as JSON")
    .action((_options, command: Command) => cooldownList(command));
  cooldown
    .command(CLEAR)
    .description("Clear the cooldown of one credential")
    .argument("<credential>", "Credential name")
    .option(
      "--holder <name>",
      "Holder of the cooldown: server or an instance name (default server)",
      singleUse("--holder"),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((credential: string, _options, command: Command) =>
      cooldownClear(credential, command),
    );
  const enablement = agent
    .command(ENABLEMENT)
    .description("Manage agent enablements");
  enablement.action(() => enablement.help());
  enablement
    .command(LIST)
    .description("List agent enablements as JSON")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  enablement
    .command(GET)
    .description("Get an agent enablement as JSON")
    .argument("<agent-name>", "Agent name")
    .action((agentName: string, _options, command: Command) =>
      get(agentName, command),
    );
  addFileBodyHelp(
    enablement
      .command(PUT)
      .description("Create or replace an agent enablement as JSON")
      .argument("<agent-name>", "Agent name")
      .requiredOption(
        "--file <path>",
        "Enablement JSON file",
        singleUse(FILE_OPTION),
      )
      .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION)),
    {
      schema: agentEnablementPutBodySchema,
      example: ENABLEMENT_EXAMPLE,
      note: "Add expected_revision to replace an existing enablement.",
    },
  ).action((agentName: string, _options, command: Command) =>
    put(agentName, command),
  );
  enablement
    .command(ENABLE)
    .description("Enable an agent enablement as JSON")
    .argument("<agent-name>", "Agent name")
    .requiredOption(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((agentName: string, _options, command: Command) =>
      enable(agentName, command),
    );
  enablement
    .command(DISABLE)
    .description("Disable an agent enablement as JSON")
    .argument("<agent-name>", "Agent name")
    .requiredOption(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((agentName: string, _options, command: Command) =>
      disable(agentName, command),
    );
  enablement
    .command(REMOVE)
    .description("Remove an agent enablement as JSON")
    .argument("<agent-name>", "Agent name")
    .requiredOption(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((agentName: string, _options, command: Command) =>
      remove(agentName, command),
    );
  const provider = enablement
    .command(PROVIDER)
    .description("Manage enablement providers");
  provider.action(() => provider.help());
  addFileBodyHelp(
    provider
      .command(ADD)
      .description("Add a provider as JSON")
      .argument("<agent-name>", "Agent name")
      .requiredOption(
        "--file <path>",
        "Provider JSON file",
        singleUse(FILE_OPTION),
      )
      .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION)),
    { schema: providerAddBodySchema, example: PROVIDER_ADD_EXAMPLE },
  ).action((agentName: string, _options, command: Command) =>
    providerAdd(agentName, command),
  );
  provider
    .command(REMOVE)
    .description("Remove a provider as JSON")
    .argument("<agent-name>", "Agent name")
    .argument("<provider-name>", "Provider name")
    .requiredOption(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action(
      (agentName: string, providerName: string, _options, command: Command) =>
        providerRemove(agentName, providerName, command),
    );
  const providerModel = provider
    .command(MODEL)
    .description("Inspect the models of a provider");
  providerModel.action(() => providerModel.help());
  providerModel
    .command(LIST)
    .description("List the models of a provider as JSON")
    .argument("<agent-name>", "Agent name")
    .argument("<provider-name>", "Provider name")
    .action(
      (agentName: string, providerName: string, _options, command: Command) =>
        providerModelList(agentName, providerName, command),
    );
}

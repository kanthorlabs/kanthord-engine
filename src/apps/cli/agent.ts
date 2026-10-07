import assert from "node:assert/strict";
import { Command } from "commander";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { httpClient } from "../../gateway/client.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
  agentOperations,
  agentProviderItemSchema,
  agentProviderKindSchema,
  defaultConfigurationSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  PROMPT_SWITCHES,
  PromptScope,
  PromptView,
} from "../../agent/contract.ts";
import { resolveClient } from "../../gateway/client.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  readTextFile,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const agentEnablementPutBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  agentProviders: z.array(agentProviderItemSchema).min(1),
  defaultConfiguration: defaultConfigurationSchema,
});
const providerAddBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  name: z.string().min(1),
  provider: agentProviderKindSchema,
  credential: z.string().min(1),
});

const ENABLEMENT = "enablement";
const PROVIDER = "provider";
const MODEL = "model";
const LIST = "list";
const GET = "get";
const PUT = "put";
const ENABLE = "enable";
const DISABLE = "disable";
const REMOVE = "remove";
const ADD = "add";
const PROMPT = "prompt";
const SWITCH = "switch";
const FILE_OPTION = "--file";
const REVISION_OPTION = "--expected-revision";
const KEY_OPTION = "--idempotency-key";
const GET_INVALID_VIEW = "cli.agent.get.invalid_view";
const GET_BINDING_PAIR = "cli.agent.get.project_binding_pair_required";
const PROMPT_PUT_TOKEN_REQUIRED = "cli.agent.prompt.put.token_required";
const PROMPT_PUT_INDETERMINATE = "cli.agent.prompt.put.indeterminate";
const PROMPT_PUT_INVALID_SCOPE = "cli.agent.prompt.put.invalid_scope";
const PROMPT_PUT_INVALID_REVISION = "cli.agent.prompt.put.invalid_revision";
const PROMPT_PUT_AGENT_REQUIRED = "cli.agent.prompt.put.agent_required";
const PROMPT_PUT_AGENT_REFUSED = "cli.agent.prompt.put.agent_refused";
const PROMPT_SWITCH_TOKEN_REQUIRED = "cli.agent.prompt.switch.token_required";
const PROMPT_SWITCH_INDETERMINATE = "cli.agent.prompt.switch.indeterminate";
const PROMPT_SWITCH_INVALID_SCOPE = "cli.agent.prompt.switch.invalid_scope";
const PROMPT_SWITCH_INVALID_REVISION =
  "cli.agent.prompt.switch.invalid_revision";
const PROMPT_SWITCH_AGENT_REQUIRED = "cli.agent.prompt.switch.agent_required";
const PROMPT_SWITCH_AGENT_REFUSED = "cli.agent.prompt.switch.agent_refused";
const PROMPT_SWITCH_INVALID_SWITCH = "cli.agent.prompt.switch.invalid_switch";
const PROMPT_SWITCH_STATE_REQUIRED = "cli.agent.prompt.switch.state_required";
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
  if ((options.project === undefined) !== (options.binding === undefined))
    throw new Diagnostic(
      GET_BINDING_PAIR,
      "--project and --binding go together",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.agent.get.token_required");
  const result = await httpClient(agentOperations, endpoint, token).get({
    params: { agentName },
    query: {
      ...(options.view !== undefined ? { view: options.view } : {}),
      ...(options.project !== undefined
        ? { projectId: options.project, bindingId: options.binding }
        : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.agent.get.indeterminate"))}\n`,
  );
}

type PromptCodes = {
  scope: string;
  revision: string;
  agentRequired: string;
  agentRefused: string;
};

function promptTarget(
  options: Record<string, string | undefined>,
  codes: PromptCodes,
) {
  const scope = Object.values(PromptScope).find(
    (value) => value === options.scope,
  );
  if (scope === undefined)
    throw new Diagnostic(codes.scope, "scope is system, agent or workbench");
  if (scope === PromptScope.System && options.agent !== undefined)
    throw new Diagnostic(codes.agentRefused, "the system scope takes no agent");
  if (scope !== PromptScope.System && options.agent === undefined)
    throw new Diagnostic(codes.agentRequired, "the scope requires --agent");
  return {
    scope,
    ...(options.agent !== undefined ? { agentName: options.agent } : {}),
    ...(options.expectedRevision !== undefined
      ? {
          expectedRevision: parsePositiveInt(
            options.expectedRevision,
            codes.revision,
          ),
        }
      : {}),
  };
}

async function promptPut(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const target = promptTarget(options, {
    scope: PROMPT_PUT_INVALID_SCOPE,
    revision: PROMPT_PUT_INVALID_REVISION,
    agentRequired: PROMPT_PUT_AGENT_REQUIRED,
    agentRefused: PROMPT_PUT_AGENT_REFUSED,
  });
  const { endpoint, token } = resolveClient(options);
  requireToken(token, PROMPT_PUT_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const customText = readTextFile(options.file);
  const result = await httpClient(agentOperations, endpoint, token)[
    "prompt.put"
  ](
    {
      params: {},
      query: {},
      body: { ...target, customText },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, PROMPT_PUT_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function promptSwitch(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const target = promptTarget(options, {
    scope: PROMPT_SWITCH_INVALID_SCOPE,
    revision: PROMPT_SWITCH_INVALID_REVISION,
    agentRequired: PROMPT_SWITCH_AGENT_REQUIRED,
    agentRefused: PROMPT_SWITCH_AGENT_REFUSED,
  });
  if (!PROMPT_SWITCHES[target.scope].includes(options.switch))
    throw new Diagnostic(
      PROMPT_SWITCH_INVALID_SWITCH,
      "the switch is not a source of the scope",
    );
  if (options.on === options.off)
    throw new Diagnostic(
      PROMPT_SWITCH_STATE_REQUIRED,
      "pass exactly one of --on and --off",
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, PROMPT_SWITCH_TOKEN_REQUIRED);
  const key = resolveKey(options);
  const result = await httpClient(agentOperations, endpoint, token)[
    "prompt.switch"
  ](
    {
      params: {},
      query: {},
      body: { ...target, switch: options.switch, enabled: options.on === true },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, PROMPT_SWITCH_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function get(agentName: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, GET_TOKEN_REQUIRED);
  const result = await httpClient(agentOperations, endpoint, token)[
    "enablement.get"
  ]({ params: { agentName }, query: {}, body: null });
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
  ]({ params: { agentName }, query: {}, body }, { idempotencyKey: key });
  const data = handleMutationResult(result, PUT_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
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
    { params: { agentName }, query: {}, body: { expectedRevision } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, ENABLE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
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
    { params: { agentName }, query: {}, body: { expectedRevision } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, DISABLE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
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
    { params: { agentName }, query: {}, body: { expectedRevision } },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, REMOVE_INDETERMINATE, key);
  process.stdout.write(
    `${JSON.stringify({ agentName: data.agentName, idempotencyKey: key })}\n`,
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
  ]({ params: { agentName }, query: {}, body }, { idempotencyKey: key });
  const data = handleMutationResult(result, ADD_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
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
      params: { agentName, providerName },
      query: {},
      body: { expectedRevision },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, PROVIDER_REMOVE_INDETERMINATE, key);
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
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
  ]({ params: { agentName, providerName }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, MODEL_LIST_INDETERMINATE))}\n`,
  );
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
    .command("get <agent-name>")
    .description("Get an agent declaration (human JWT)")
    .option(
      "--view <view>",
      "Answer the final prompt only",
      singleUse("--view"),
    )
    .option("--project <project-id>", "Project", singleUse("--project"))
    .option(
      "--binding <binding-id>",
      "Repository binding",
      singleUse("--binding"),
    )
    .action((agentName: string, _options, command: Command) =>
      agentGet(agentName, command),
    );
  agent.action(() => agent.help());
  const prompt = agent
    .command(PROMPT)
    .description("Manage the prompt settings");
  prompt.action(() => prompt.help());
  prompt
    .command(PUT)
    .description("Replace the custom text of a prompt scope as JSON")
    .requiredOption(
      "--scope <scope>",
      "system, agent or workbench",
      singleUse("--scope"),
    )
    .option("--agent <agent-name>", "Agent name", singleUse("--agent"))
    .option(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .requiredOption("--file <path>", "Custom text file", singleUse(FILE_OPTION))
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => promptPut(command));
  prompt
    .command(SWITCH)
    .description("Turn one prompt source of a scope on or off as JSON")
    .requiredOption(
      "--scope <scope>",
      "system, agent or workbench",
      singleUse("--scope"),
    )
    .option("--agent <agent-name>", "Agent name", singleUse("--agent"))
    .option(
      "--expected-revision <revision>",
      "Current revision",
      singleUse(REVISION_OPTION),
    )
    .requiredOption("--switch <source>", "Prompt source", singleUse("--switch"))
    .option("--on", "Turn the source on")
    .option("--off", "Turn the source off")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => promptSwitch(command));
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
  enablement
    .command(PUT)
    .description("Create or replace an agent enablement as JSON")
    .argument("<agent-name>", "Agent name")
    .requiredOption(
      "--file <path>",
      "Enablement JSON file",
      singleUse(FILE_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((agentName: string, _options, command: Command) =>
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
  provider
    .command(ADD)
    .description("Add a provider as JSON")
    .argument("<agent-name>", "Agent name")
    .requiredOption(
      "--file <path>",
      "Provider JSON file",
      singleUse(FILE_OPTION),
    )
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((agentName: string, _options, command: Command) =>
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
  const model = provider
    .command(MODEL)
    .description("Inspect the models of a provider");
  model.action(() => model.help());
  model
    .command(LIST)
    .description("List the models of a provider as JSON")
    .argument("<agent-name>", "Agent name")
    .argument("<provider-name>", "Provider name")
    .action(
      (agentName: string, providerName: string, _options, command: Command) =>
        providerModelList(agentName, providerName, command),
    );
}

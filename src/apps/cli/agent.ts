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
const LIST_INDETERMINATE = "cli.agent.enablement.list.indeterminate";
const GET_INDETERMINATE = "cli.agent.enablement.get.indeterminate";
const PUT_INDETERMINATE = "cli.agent.enablement.put.indeterminate";
const ENABLE_INDETERMINATE = "cli.agent.enablement.enable.indeterminate";
const DISABLE_INDETERMINATE = "cli.agent.enablement.disable.indeterminate";
const REMOVE_INDETERMINATE = "cli.agent.enablement.remove.indeterminate";
const ADD_INDETERMINATE = "cli.agent.enablement.provider.add.indeterminate";
const PROVIDER_REMOVE_INDETERMINATE =
  "cli.agent.enablement.provider.remove.indeterminate";
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
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.agent.get.token_required");
  const result = await httpClient(agentOperations, endpoint, token).get({
    params: { agentName },
    query: {},
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
    .action((agentName: string, _options, command: Command) =>
      agentGet(agentName, command),
    );
  agent.action(() => agent.help());
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
}

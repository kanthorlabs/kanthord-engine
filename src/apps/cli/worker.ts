import assert from "node:assert/strict";
import { Command } from "commander";
import { ulid } from "ulid";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
  agentProviderItemSchema,
  agentProviderKindSchema,
  defaultConfigurationSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  workerOperations,
} from "../../worker/contract.ts";
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

const AGENT = "agent";
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
const LIST_TOKEN_REQUIRED = "cli.worker.agent.enablement.list.token_required";
const GET_TOKEN_REQUIRED = "cli.worker.agent.enablement.get.token_required";
const PUT_TOKEN_REQUIRED = "cli.worker.agent.enablement.put.token_required";
const ENABLE_TOKEN_REQUIRED =
  "cli.worker.agent.enablement.enable.token_required";
const DISABLE_TOKEN_REQUIRED =
  "cli.worker.agent.enablement.disable.token_required";
const REMOVE_TOKEN_REQUIRED =
  "cli.worker.agent.enablement.remove.token_required";
const ADD_TOKEN_REQUIRED =
  "cli.worker.agent.enablement.provider.add.token_required";
const PROVIDER_REMOVE_TOKEN_REQUIRED =
  "cli.worker.agent.enablement.provider.remove.token_required";
const LIST_INDETERMINATE = "cli.worker.agent.enablement.list.indeterminate";
const GET_INDETERMINATE = "cli.worker.agent.enablement.get.indeterminate";
const PUT_INDETERMINATE = "cli.worker.agent.enablement.put.indeterminate";
const ENABLE_INDETERMINATE = "cli.worker.agent.enablement.enable.indeterminate";
const DISABLE_INDETERMINATE =
  "cli.worker.agent.enablement.disable.indeterminate";
const REMOVE_INDETERMINATE = "cli.worker.agent.enablement.remove.indeterminate";
const ADD_INDETERMINATE =
  "cli.worker.agent.enablement.provider.add.indeterminate";
const PROVIDER_REMOVE_INDETERMINATE =
  "cli.worker.agent.enablement.provider.remove.indeterminate";
const ENABLE_INVALID_REVISION =
  "cli.worker.agent.enablement.enable.invalid_revision";
const DISABLE_INVALID_REVISION =
  "cli.worker.agent.enablement.disable.invalid_revision";
const REMOVE_INVALID_REVISION =
  "cli.worker.agent.enablement.remove.invalid_revision";
const PROVIDER_REMOVE_INVALID_REVISION =
  "cli.worker.agent.enablement.provider.remove.invalid_revision";

async function register(command: Command): Promise<void> {
  assert.equal(workerOperations.register.access, AccessPolicy.Client);
  assert.equal(workerOperations.register.requiresRegistration, false);
  const options = command.optsWithGlobals();
  const config = resolveClient(options);
  if (!config.token?.trim())
    throw new Diagnostic(
      "cli.worker.register.token_required",
      "worker register: supply a machine JWT through --token, KANTHORD_TOKEN or cli.yaml.",
    );
  const key = options.idempotencyKey ?? ulid();
  if (!ulidSchema.safeParse(key).success)
    throw new Diagnostic(
      "cli.worker.register.invalid_idempotency_key",
      "worker register: --idempotency-key must be a canonical ULID.",
    );
  const result = await httpClient(
    workerOperations,
    config.endpoint,
    config.token,
  ).register({ params: {}, query: {}, body: null }, { idempotencyKey: key });
  if (result.type === OperationResultType.Indeterminate)
    throw new Diagnostic(
      "cli.worker.register.indeterminate",
      `worker register: result is indeterminate; retry with --idempotency-key ${key}.`,
    );
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(
      result.error.error.code,
      `worker register: request failed (HTTP ${result.status}); idempotency key ${key}.`,
    );
  process.stdout.write(
    `${JSON.stringify({ ...result.data, idempotencyKey: key })}\n`,
  );
}

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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.list"
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

async function get(agentName: string, command: Command): Promise<void> {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, GET_TOKEN_REQUIRED);
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.get"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.put"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.enable"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.disable"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.remove"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.provider.add"
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
  const result = await httpClient(workerOperations, endpoint, token)[
    "agent.enablement.provider.remove"
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

export function addWorkerCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Worker),
  );
  const worker = program
    .command(CommandName.Worker)
    .description("Worker Service commands")
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--token <token>",
      "Human JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  worker.action(() => worker.help());
  worker
    .command("register")
    .description(
      "Register a worker instance with a machine JWT and print its runtime identity and idempotency key as JSON",
    )
    .option(
      "--token <jwt>",
      "Machine JWT (otherwise KANTHORD_TOKEN or an operator-supplied client file)",
    )
    .option(
      "--idempotency-key <ulid>",
      "Reuse this key when retrying the same registration; generated when omitted",
    )
    .action((_options, command: Command) => register(command));
  const agent = worker.command(AGENT).description("Worker agent commands");
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

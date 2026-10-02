import assert from "node:assert/strict";
import { Command } from "commander";
import { ulid } from "ulid";
import { z } from "zod";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema, ulidSchema } from "../../kernel/identity.ts";
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
  bindingNameSchema,
  workerResourceIdentity,
} from "../../project/contract.ts";
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

async function handover(executionId: string, command: Command): Promise<void> {
  assert.equal(workerOperations.handover.access, AccessPolicy.Client);
  assert.equal(workerOperations.handover.secret, true);
  if (!identitySchema("execution").safeParse(executionId).success)
    throw new Diagnostic(
      "cli.worker.handover.invalid_execution_id",
      "Expected a canonical execution identity.",
    );
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.handover.token_required");
  const key = resolveKey(options);
  const result = await httpClient(workerOperations, endpoint, token).handover(
    { params: {}, query: {}, body: { executionId } },
    { idempotencyKey: key },
  );
  if (result.type === OperationResultType.Indeterminate)
    throw new Diagnostic(
      "cli.worker.handover.indeterminate",
      "worker handover: result is indeterminate; retry with a new --idempotency-key.",
    );
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(
      result.error.error.code,
      `worker handover: request failed (HTTP ${result.status}); idempotency key ${key}.`,
    );
  process.stdout.write(
    `${JSON.stringify({ received: true, idempotencyKey: key })}\n`,
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

async function catalogList(command: Command): Promise<void> {
  assert.equal(workerOperations["catalog.list"].access, AccessPolicy.Human);
  assert.equal(workerOperations["catalog.list"].mutation, false);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.list.token_required");
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
    "catalog.list"
  ]({
    params: {},
    query: {
      limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.list.indeterminate"))}\n`,
  );
}

async function heartbeat(command: Command): Promise<void> {
  assert.equal(workerOperations.heartbeat.access, AccessPolicy.Client);
  assert.equal(workerOperations.heartbeat.mutation, false);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.heartbeat.token_required");
  const result = await httpClient(workerOperations, endpoint, token).heartbeat({
    params: {},
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.heartbeat.indeterminate"))}\n`,
  );
}

async function deregister(
  runtimeIdentity: string,
  command: Command,
): Promise<void> {
  assert.equal(
    workerOperations["instance.deregister"].access,
    AccessPolicy.Client,
  );
  assert.equal(workerOperations["instance.deregister"].mutation, true);
  if (!identitySchema("worker_instance").safeParse(runtimeIdentity).success)
    throw new Diagnostic(
      "cli.worker.instance.deregister.invalid_runtime_identity",
      "Expected a canonical worker_instance identity.",
    );
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.instance.deregister.token_required");
  const key = resolveKey(options);
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.deregister"
  ](
    { params: { runtimeIdentity }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.instance.deregister.indeterminate",
    key,
  );
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

async function catalogGet(workerName: string, command: Command): Promise<void> {
  assert.equal(workerOperations["catalog.get"].access, AccessPolicy.Human);
  assert.equal(workerOperations["catalog.get"].mutation, false);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.get.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "catalog.get"
  ]({ params: { workerName }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.get.indeterminate"))}\n`,
  );
}

async function resume(
  runtimeIdentity: string,
  command: Command,
): Promise<void> {
  assert.equal(workerOperations["instance.resume"].access, AccessPolicy.Human);
  assert.equal(workerOperations["instance.resume"].mutation, true);
  if (!identitySchema("worker_instance").safeParse(runtimeIdentity).success)
    throw new Diagnostic(
      "cli.worker.instance.resume.invalid_runtime_identity",
      "Expected a canonical worker_instance identity.",
    );
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.instance.resume.token_required");
  const key = resolveKey(options);
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.resume"
  ](
    { params: { runtimeIdentity }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.instance.resume.indeterminate",
    key,
  );
  process.stdout.write(`${JSON.stringify({ ...data, idempotencyKey: key })}\n`);
}

function instanceListQuery(options: Record<string, string | undefined>) {
  assert.equal(workerOperations["instance.list"].access, AccessPolicy.Human);
  assert.equal(workerOperations["instance.list"].mutation, false);
  if (
    options.project !== undefined &&
    !identitySchema("project").safeParse(options.project).success
  )
    throw new Diagnostic(
      "cli.worker.instance.list.invalid_project_id",
      "Expected a canonical project identity.",
    );
  if (
    options.binding !== undefined &&
    !bindingNameSchema.safeParse(options.binding).success
  )
    throw new Diagnostic(
      "cli.worker.instance.list.invalid_binding_name",
      "Expected a worker binding name.",
    );
  if (options.binding !== undefined && options.project === undefined)
    throw new Diagnostic(
      "cli.worker.instance.list.binding_without_project",
      "--binding requires --project.",
    );
  const limit =
    options.limit === undefined
      ? LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit > LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${LIST_LIMIT_MAX}`,
    );
  return {
    projectId: options.project,
    resourceIdentity:
      options.binding === undefined
        ? undefined
        : workerResourceIdentity(options.binding),
    limit,
    cursor: options.cursor,
  };
}

async function instanceList(command: Command): Promise<void> {
  assert.equal(workerOperations["instance.list"].access, AccessPolicy.Human);
  assert.equal(workerOperations["instance.list"].mutation, false);
  const options = command.optsWithGlobals();
  const query = instanceListQuery(options);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.worker.instance.list.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.list"
  ]({ params: {}, query, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.instance.list.indeterminate"))}\n`,
  );
}

async function instanceGet(
  runtimeIdentity: string,
  command: Command,
): Promise<void> {
  assert.equal(workerOperations["instance.get"].access, AccessPolicy.Human);
  assert.equal(workerOperations["instance.get"].mutation, false);
  if (!identitySchema("worker_instance").safeParse(runtimeIdentity).success)
    throw new Diagnostic(
      "cli.worker.instance.get.invalid_runtime_identity",
      "Expected a canonical worker_instance identity.",
    );
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.instance.get.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "instance.get"
  ]({ params: { runtimeIdentity }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.instance.get.indeterminate"))}\n`,
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
      "Caller JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  worker.action(() => worker.help());
  const instance = worker
    .command("instance")
    .description("Worker instance commands");
  instance.action(() => instance.help());
  instance
    .command(LIST)
    .description("List live worker instances")
    .option(
      "--project <project-id>",
      "Project identity",
      singleUse("--project"),
    )
    .option(
      "--binding <binding-name>",
      "Worker binding name",
      singleUse("--binding"),
    )
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => instanceList(command));
  instance
    .command(GET)
    .description("Read a live worker instance")
    .argument("<runtime-identity>", "Runtime identity")
    .action((runtimeIdentity: string, _options, command: Command) =>
      instanceGet(runtimeIdentity, command),
    );
  instance
    .command("resume")
    .description("Resume an ended registration with a running execution")
    .argument("<runtime-identity>", "Runtime identity")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((runtimeIdentity: string, _options, command: Command) =>
      resume(runtimeIdentity, command),
    );
  instance
    .command("deregister")
    .description("End an owned live registration using a machine JWT")
    .argument("<runtime-identity>", "Runtime identity")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((runtimeIdentity: string, _options, command: Command) =>
      deregister(runtimeIdentity, command),
    );
  worker
    .command("heartbeat")
    .description("Renew a registered instance heartbeat")
    .option("--token <jwt>", "Machine JWT", singleUse("--token"))
    .action((_options, command: Command) => heartbeat(command));
  worker
    .command(LIST)
    .description("List supplied workers as JSON")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => catalogList(command));
  worker
    .command(GET)
    .description("Get a supplied worker declaration as JSON")
    .argument("<worker-name>", "Exact worker name")
    .action((workerName: string, _options, command: Command) =>
      catalogGet(workerName, command),
    );
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
  worker
    .command("handover")
    .description("Receive execution credentials and print only receipt status")
    .argument("<execution-id>", "Execution identity")
    .option("--token <jwt>", "Machine JWT", singleUse("--token"))
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((executionId: string, _options, command: Command) =>
      handover(executionId, command),
    );
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

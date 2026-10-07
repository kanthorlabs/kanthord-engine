import assert from "node:assert/strict";
import { Command } from "commander";
import { ulid } from "ulid";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema, ulidSchema } from "../../kernel/identity.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
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
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const LIST = "list";
const GET = "get";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

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
    `${JSON.stringify({ ...result.data, idempotency_key: key })}\n`,
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
    { params: {}, query: {}, body: { execution_id: executionId } },
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
    `${JSON.stringify({ received: true, idempotency_key: key })}\n`,
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
    { params: { runtime_identity: runtimeIdentity }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.instance.deregister.indeterminate",
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function catalogGet(workerName: string, command: Command): Promise<void> {
  assert.equal(workerOperations["catalog.get"].access, AccessPolicy.Human);
  assert.equal(workerOperations["catalog.get"].mutation, false);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.worker.get.token_required");
  const result = await httpClient(workerOperations, endpoint, token)[
    "catalog.get"
  ]({ params: { worker_name: workerName }, query: {}, body: null });
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
    { params: { runtime_identity: runtimeIdentity }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    "cli.worker.instance.resume.indeterminate",
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
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
    project_id: options.project,
    resource_identity:
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
  ]({ params: { runtime_identity: runtimeIdentity }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.worker.instance.get.indeterminate"))}\n`,
  );
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
}

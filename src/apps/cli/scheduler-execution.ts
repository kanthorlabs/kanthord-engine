import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  schedulerOperations,
  workPullSchema,
  executionReleaseSchema,
  QUEUE_LIST_LIMIT_DEFAULT,
  QUEUE_LIST_LIMIT_MIN,
  QUEUE_LIST_LIMIT_MAX,
} from "../../scheduler/contract.ts";
import { CommandName } from "./constants.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const WORK = "work";
const PULL = "pull";
const TOKEN_REQUIRED = "cli.scheduler.work.pull.token_required";
const INDETERMINATE = "cli.scheduler.work.pull.indeterminate";
const EXECUTION = "execution";
const RELEASE = "release";
const CLAIM = "claim";
const GET = "get";
const LIST = "list";

async function executionGet(
  executionId: string,
  command: Command,
): Promise<void> {
  if (!identitySchema(EXECUTION).safeParse(executionId).success)
    throw new Diagnostic(
      "cli.scheduler.execution.get.invalid_execution_id",
      "invalid execution ID",
    );
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.scheduler.execution.get.token_required");
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).executionGet({
    params: { execution_id: executionId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.scheduler.execution.get.indeterminate"))}\n`,
  );
}

async function executionList(
  projectId: string,
  command: Command,
): Promise<void> {
  if (!identitySchema("project").safeParse(projectId).success)
    throw new Diagnostic(
      "cli.scheduler.execution.list.invalid_project_id",
      "invalid project ID",
    );
  const options = command.optsWithGlobals();
  if (
    options.node !== undefined &&
    !identitySchema("node").safeParse(options.node).success
  )
    throw new Diagnostic(
      "cli.scheduler.execution.list.invalid_node_id",
      "invalid node ID",
    );
  const attempt =
    options.attempt === undefined
      ? undefined
      : parsePositiveInt(
          options.attempt,
          "cli.scheduler.execution.list.invalid_attempt",
        );
  const limit =
    options.limit === undefined
      ? QUEUE_LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, "cli.pagination.limit_invalid");
  if (limit < QUEUE_LIST_LIMIT_MIN || limit > QUEUE_LIST_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be between ${QUEUE_LIST_LIMIT_MIN} and ${QUEUE_LIST_LIMIT_MAX}`,
    );
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.scheduler.execution.list.token_required");
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).executionList({
    params: { project_id: projectId },
    query: { limit, node_id: options.node, attempt, cursor: options.cursor },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.scheduler.execution.list.indeterminate"))}\n`,
  );
}

async function claimGet(executionId: string, command: Command): Promise<void> {
  if (!identitySchema(EXECUTION).safeParse(executionId).success)
    throw new Diagnostic(
      "cli.scheduler.claim.get.invalid_execution_id",
      "invalid execution ID",
    );
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, "cli.scheduler.claim.get.token_required");
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).claimGet({ params: { execution_id: executionId }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, "cli.scheduler.claim.get.indeterminate"))}\n`,
  );
}

async function release(executionId: string, command: Command): Promise<void> {
  if (!identitySchema(EXECUTION).safeParse(executionId).success)
    throw new Diagnostic(
      "cli.scheduler.execution.release.invalid_execution_id",
      "invalid execution ID",
    );
  const options = command.optsWithGlobals();
  const body = readJsonFileAs(options.file, executionReleaseSchema);
  const key = resolveKey(options);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, "cli.scheduler.execution.release.token_required");
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).executionRelease(
    { params: { execution_id: executionId }, query: {}, body },
    { idempotencyKey: key },
  );
  process.stdout.write(
    `${JSON.stringify({ ...handleMutationResult(result, "cli.scheduler.execution.release.indeterminate", key), idempotency_key: key })}\n`,
  );
}

async function pull(command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const body = readJsonFileAs(options.file, workPullSchema);
  const key = resolveKey(options);
  const { endpoint, token } = resolveClient(options);
  requireToken(token, TOKEN_REQUIRED);
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).workPull({ params: {}, query: {}, body }, { idempotencyKey: key });
  process.stdout.write(
    `${JSON.stringify({ ...handleMutationResult(result, INDETERMINATE, key), idempotency_key: key })}\n`,
  );
}

export function addExecutionCommands(scheduler: Command): void {
  assert.equal(scheduler.name(), CommandName.Scheduler);
  assert.ok(!scheduler.commands.some((command) => command.name() === WORK));
  const claim = scheduler
    .command(CLAIM)
    .description("Read this instance's claims");
  claim.action(() => claim.help());
  claim
    .command(GET)
    .description("Read a claim as JSON")
    .argument("<execution-id>", "Execution ID")
    .action((executionId: string, _options, command: Command) =>
      claimGet(executionId, command),
    );
  const execution = scheduler
    .command(EXECUTION)
    .description("Inspect and release executions");
  execution.action(() => execution.help());
  execution
    .command(GET)
    .description("Read an execution as JSON")
    .argument("<execution-id>", "Execution ID")
    .action((executionId: string, _options, command: Command) =>
      executionGet(executionId, command),
    );
  execution
    .command(LIST)
    .description("List executions as JSON")
    .argument("<project-id>", "Project ID")
    .option("--node <node-id>", "Filter by node", singleUse("--node"))
    .option(
      "--attempt <n>",
      "Filter by attempt with --node",
      singleUse("--attempt"),
    )
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((projectId: string, _options, command: Command) =>
      executionList(projectId, command),
    );
  execution
    .command(RELEASE)
    .description("Release an execution as JSON")
    .argument("<execution-id>", "Execution ID")
    .requiredOption(
      "--file <path>",
      "Execution release JSON file",
      singleUse("--file"),
    )
    .option(
      "--idempotency-key <key>",
      "Mutation retry key",
      singleUse("--idempotency-key"),
    )
    .action((executionId: string, _options, command: Command) =>
      release(executionId, command),
    );
  const work = scheduler
    .command(WORK)
    .description("Acquire work for a registered instance");
  work.action(() => work.help());
  work
    .command(PULL)
    .description("Pull compatible work as JSON")
    .requiredOption("--file <path>", "Work pull JSON file", singleUse("--file"))
    .option(
      "--idempotency-key <key>",
      "Mutation retry key",
      singleUse("--idempotency-key"),
    )
    .action((_options, command: Command) => pull(command));
}

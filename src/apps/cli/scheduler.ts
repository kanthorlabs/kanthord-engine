import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  QUEUE_LIST_LIMIT_DEFAULT,
  QUEUE_LIST_LIMIT_MAX,
  QUEUE_LIST_LIMIT_MIN,
  schedulerOperations,
} from "../../scheduler/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { addExecutionCommands } from "./scheduler-execution.ts";
import {
  handleReadResult,
  parsePositiveInt,
  requireToken,
  singleUse,
} from "./shared.ts";

const QUEUE = "queue";
const LIST = "list";
const PEEK = "peek";
const PROJECT = "project";
const LIST_INVALID_PROJECT_ID = "cli.scheduler.queue.list.invalid_project_id";
const PEEK_INVALID_PROJECT_ID = "cli.scheduler.queue.peek.invalid_project_id";
const LIST_TOKEN_REQUIRED = "cli.scheduler.queue.list.token_required";
const PEEK_TOKEN_REQUIRED = "cli.scheduler.queue.peek.token_required";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const LIST_INDETERMINATE = "cli.scheduler.queue.list.indeterminate";
const PEEK_INDETERMINATE = "cli.scheduler.queue.peek.indeterminate";

async function list(projectId: string, command: Command): Promise<void> {
  if (!identitySchema(PROJECT).safeParse(projectId).success)
    throw new Diagnostic(LIST_INVALID_PROJECT_ID, "invalid project ID");
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, LIST_TOKEN_REQUIRED);
  const limit =
    options.limit === undefined
      ? QUEUE_LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, LIMIT_INVALID);
  if (limit < QUEUE_LIST_LIMIT_MIN || limit > QUEUE_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be between ${QUEUE_LIST_LIMIT_MIN} and ${QUEUE_LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).queueList({
    params: { project_id: projectId },
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

async function peek(projectId: string, command: Command): Promise<void> {
  if (!identitySchema(PROJECT).safeParse(projectId).success)
    throw new Diagnostic(PEEK_INVALID_PROJECT_ID, "invalid project ID");
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, PEEK_TOKEN_REQUIRED);
  const result = await httpClient(
    schedulerOperations,
    endpoint,
    token,
  ).queuePeek({
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, PEEK_INDETERMINATE))}\n`,
  );
}

export function addSchedulerCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some(
      (command) => command.name() === CommandName.Scheduler,
    ),
  );
  const scheduler = program
    .command(CommandName.Scheduler)
    .description("Scheduler Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  scheduler.action(() => scheduler.help());
  addExecutionCommands(scheduler);
  const queue = scheduler.command(QUEUE).description("Inspect the work queue");
  queue.action(() => queue.help());
  queue
    .command(LIST)
    .description("List queued jobs as JSON")
    .argument("<project-id>", "Project ID")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((projectId: string, _options, command: Command) =>
      list(projectId, command),
    );
  queue
    .command(PEEK)
    .description("Peek at the next queued job as JSON")
    .argument("<project-id>", "Project ID")
    .action((projectId: string, _options, command: Command) =>
      peek(projectId, command),
    );
}

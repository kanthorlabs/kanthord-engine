import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  schedulerOperations,
  workPullSchema,
  executionReleaseSchema,
} from "../../scheduler/contract.ts";
import { CommandName } from "./constants.ts";
import {
  handleMutationResult,
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
    { params: { executionId }, query: {}, body },
    { idempotencyKey: key },
  );
  process.stdout.write(
    `${JSON.stringify({ ...handleMutationResult(result, "cli.scheduler.execution.release.indeterminate", key), idempotencyKey: key })}\n`,
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
    `${JSON.stringify({ ...handleMutationResult(result, INDETERMINATE, key), idempotencyKey: key })}\n`,
  );
}

export function addExecutionCommands(scheduler: Command): void {
  assert.equal(scheduler.name(), CommandName.Scheduler);
  assert.ok(!scheduler.commands.some((command) => command.name() === WORK));
  const execution = scheduler
    .command(EXECUTION)
    .description("Inspect and release executions");
  execution.action(() => execution.help());
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

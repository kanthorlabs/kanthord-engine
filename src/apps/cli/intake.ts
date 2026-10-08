import assert from "node:assert/strict";
import { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import {
  OUTBOUND_LIST_LIMIT_MAX,
  OUTBOUND_REQUEST_ID_PREFIX,
  intakeOperations,
} from "../../intake/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { addEventCommands } from "./intake-event.ts";
import { addInboundCommands } from "./intake-inbound.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const OUTBOUND = "outbound";
const LIST = "list";
const GET = "get";
const DISCARD = "discard";
const DELETE = "delete";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

type Options = Record<string, string | boolean | string[] | undefined>;

function code(leaf: string, suffix: string): string {
  return `cli.intake.${OUTBOUND}.${leaf}.${suffix}`;
}

function requireIdentity(value: string, leaf: string): void {
  if (!identitySchema(OUTBOUND_REQUEST_ID_PREFIX).safeParse(value).success)
    throw new Diagnostic(
      code(leaf, "invalid_outbound_request_id"),
      "Expected a canonical outbound_request identity.",
    );
}

function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function list(command: Command): Promise<void> {
  const operation = intakeOperations["outbound.request.list"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(LIST, "token_required"));
  const limit =
    options.limit === undefined
      ? undefined
      : parsePositiveInt(options.limit as string, LIMIT_INVALID);
  if (limit !== undefined && limit > OUTBOUND_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${OUTBOUND_LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(intakeOperations, endpoint, token)[
    "outbound.request.list"
  ]({
    params: {},
    query: present({
      project_id: options.project as string | undefined,
      state: options.state as never,
      operation: options.operation as never,
      limit,
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(LIST, "indeterminate")))}\n`,
  );
}

async function get(outboundRequestId: string, command: Command): Promise<void> {
  const operation = intakeOperations["outbound.request.get"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  requireIdentity(outboundRequestId, GET);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, code(GET, "token_required"));
  const result = await httpClient(intakeOperations, endpoint, token)[
    "outbound.request.get"
  ]({
    params: { outbound_request_id: outboundRequestId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(GET, "indeterminate")))}\n`,
  );
}

async function discard(
  outboundRequestId: string,
  command: Command,
): Promise<void> {
  const operation = intakeOperations["outbound.request.discard"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  requireIdentity(outboundRequestId, DISCARD);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(DISCARD, "token_required"));
  const key = resolveKey(options);
  const result = await httpClient(intakeOperations, endpoint, token)[
    "outbound.request.discard"
  ](
    {
      params: { outbound_request_id: outboundRequestId },
      query: {},
      body: null,
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(
    result,
    code(DISCARD, "indeterminate"),
    key,
  );
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function remove(command: Command): Promise<void> {
  const operation = intakeOperations["outbound.request.delete"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(DELETE, "token_required"));
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await httpClient(intakeOperations, endpoint, token)[
    "outbound.request.delete"
  ](
    {
      params: {},
      query: {},
      body: {
        force: options.force === true,
        ...present({
          state: options.state as never,
          from: options.from as never,
          to: options.to as never,
          ids: options.id as never,
        }),
      },
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, code(DELETE, "indeterminate"), key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

export function addIntakeCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Intake),
  );
  const intake = program
    .command(CommandName.Intake)
    .description("Intake Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "Caller JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  intake.action(() => intake.help());
  addInboundCommands(intake);
  addEventCommands(intake);
  const outbound = intake
    .command(OUTBOUND)
    .description("Outbound request commands");
  outbound.action(() => outbound.help());
  outbound
    .command(LIST)
    .description("List outbound requests as JSON")
    .option("--project <id>", "Project identity", singleUse("--project"))
    .option("--state <state>", "Filter by state", singleUse("--state"))
    .option(
      "--operation <operation>",
      "Filter by operation",
      singleUse("--operation"),
    )
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  outbound
    .command(GET)
    .description("Get an outbound request as JSON")
    .argument("<outbound-request-id>", "Outbound request identity")
    .action((id: string, _options, command: Command) => get(id, command));
  outbound
    .command(DISCARD)
    .description("Discard a pending outbound request")
    .argument("<outbound-request-id>", "Outbound request identity")
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((id: string, _options, command: Command) => discard(id, command));
  outbound
    .command(DELETE)
    .description("Delete settled outbound requests")
    .option("--force", "Accept that a repeat of a deleted request key writes")
    .option("--state <state>", "State of the range", singleUse("--state"))
    .option("--from <id>", "First identity of the range", singleUse("--from"))
    .option("--to <id>", "Last identity of the range", singleUse("--to"))
    .option(
      "--id <id>",
      "Identity to delete; repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => remove(command));
}

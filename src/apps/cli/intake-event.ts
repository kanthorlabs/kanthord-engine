import assert from "node:assert/strict";
import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import {
  INBOUND_EVENT_ID_PREFIX,
  INBOUND_EVENT_LIST_LIMIT_MAX,
  intakeOperations,
} from "../../intake/contract.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const EVENT = "event";
const LIST = "list";
const GET = "get";
const RETRY = "retry";
const DISCARD = "discard";
const DELETE = "delete";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

type Options = Record<string, string | boolean | string[] | undefined>;

function code(leaf: string, suffix: string): string {
  return `cli.intake.${EVENT}.${leaf}.${suffix}`;
}

function requireIdentity(value: string, leaf: string): void {
  if (!identitySchema(INBOUND_EVENT_ID_PREFIX).safeParse(value).success)
    throw new Diagnostic(
      code(leaf, "invalid_inbound_event_id"),
      "Expected a canonical inbound_event identity.",
    );
}

function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function list(command: Command): Promise<void> {
  const operation = intakeOperations["inbound.event.list"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(LIST, "token_required"));
  const limit =
    options.limit === undefined
      ? undefined
      : parsePositiveInt(options.limit as string, LIMIT_INVALID);
  if (limit !== undefined && limit > INBOUND_EVENT_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${INBOUND_EVENT_LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.event.list"
  ]({
    params: {},
    query: present({
      inbound_id: options.inbound as string | undefined,
      state: options.state as never,
      limit,
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(LIST, "indeterminate")))}\n`,
  );
}

async function get(eventId: string, command: Command): Promise<void> {
  const operation = intakeOperations["inbound.event.get"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  if (!identitySchema(INBOUND_EVENT_ID_PREFIX).safeParse(eventId).success)
    throw new Diagnostic(
      code(GET, "invalid_inbound_event_id"),
      "Expected a canonical inbound_event identity.",
    );
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, code(GET, "token_required"));
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.event.get"
  ]({ params: { inbound_event_id: eventId }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(GET, "indeterminate")))}\n`,
  );
}

async function transition(
  operationName: "inbound.event.retry" | "inbound.event.discard",
  leaf: string,
  eventId: string,
  command: Command,
): Promise<void> {
  const operation = intakeOperations[operationName];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  requireIdentity(eventId, leaf);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(leaf, "token_required"));
  const key = resolveKey(options);
  const result = await httpClient(intakeOperations, endpoint, token)[
    operationName
  ](
    { params: { inbound_event_id: eventId }, query: {}, body: null },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, code(leaf, "indeterminate"), key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function remove(command: Command): Promise<void> {
  const operation = intakeOperations["inbound.event.delete"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(DELETE, "token_required"));
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.event.delete"
  ](
    {
      params: {},
      query: {},
      body: present({
        state: options.state as never,
        from: options.from as never,
        to: options.to as never,
        ids: options.id as never,
      }),
    },
    { idempotencyKey: key },
  );
  const data = handleMutationResult(result, code(DELETE, "indeterminate"), key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

export function addEventCommands(intake: Command): void {
  const event = intake.command(EVENT).description("Inbound event commands");
  event.action(() => event.help());
  event
    .command(LIST)
    .description("List inbound events as JSON")
    .option("--inbound <id>", "Inbound identity", singleUse("--inbound"))
    .option("--state <state>", "Filter by state", singleUse("--state"))
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  event
    .command(GET)
    .description("Get an inbound event as JSON")
    .argument("<inbound-event-id>", "Inbound event identity")
    .action((id: string, _options, command: Command) => get(id, command));
  event
    .command(RETRY)
    .description("Turn a failed inbound event back to pending")
    .argument("<inbound-event-id>", "Inbound event identity")
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((id: string, _options, command: Command) =>
      transition("inbound.event.retry", RETRY, id, command),
    );
  event
    .command(DISCARD)
    .description("Discard a pending or a failed inbound event")
    .argument("<inbound-event-id>", "Inbound event identity")
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((id: string, _options, command: Command) =>
      transition("inbound.event.discard", DISCARD, id, command),
    );
  event
    .command(DELETE)
    .description("Delete settled inbound events")
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

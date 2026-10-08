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
  handleReadResult,
  parsePositiveInt,
  requireToken,
  singleUse,
} from "./shared.ts";

const EVENT = "event";
const LIST = "list";
const GET = "get";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

type Options = Record<string, string | boolean | string[] | undefined>;

function code(leaf: string, suffix: string): string {
  return `cli.intake.${EVENT}.${leaf}.${suffix}`;
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
}

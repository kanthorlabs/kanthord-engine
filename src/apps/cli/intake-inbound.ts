import assert from "node:assert/strict";
import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import {
  INBOUND_ID_PREFIX,
  INBOUND_LIST_LIMIT_MAX,
  inboundCreateSchema,
  intakeOperations,
} from "../../intake/contract.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readJsonFileAs,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const INBOUND = "inbound";
const CREATE = "create";
const LIST = "list";
const GET = "get";
const DELETE = "delete";
const KEY_OPTION = "--idempotency-key";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";

type Options = Record<string, string | boolean | string[] | undefined>;

function code(leaf: string, suffix: string): string {
  return `cli.intake.${INBOUND}.${leaf}.${suffix}`;
}

function requireIdentity(value: string, leaf: string): void {
  if (!identitySchema(INBOUND_ID_PREFIX).safeParse(value).success)
    throw new Diagnostic(
      code(leaf, "invalid_inbound_id"),
      "Expected a canonical inbound identity.",
    );
}

function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function create(command: Command): Promise<void> {
  const operation = intakeOperations["inbound.create"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(CREATE, "token_required"));
  const key = resolveKey(options as { idempotencyKey?: string });
  const body = readJsonFileAs(options.file as string, inboundCreateSchema);
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.create"
  ]({ params: {}, query: {}, body }, { idempotencyKey: key });
  const data = handleMutationResult(result, code(CREATE, "indeterminate"), key);
  process.stdout.write(
    `${JSON.stringify({ ...data, idempotency_key: key })}\n`,
  );
}

async function list(command: Command): Promise<void> {
  const operation = intakeOperations["inbound.list"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  const options = command.optsWithGlobals<Options>();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(LIST, "token_required"));
  const limit =
    options.limit === undefined
      ? undefined
      : parsePositiveInt(options.limit as string, LIMIT_INVALID);
  if (limit !== undefined && limit > INBOUND_LIST_LIMIT_MAX)
    throw new Diagnostic(
      LIMIT_OUT_OF_RANGE,
      `limit must be at most ${INBOUND_LIST_LIMIT_MAX}`,
    );
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.list"
  ]({
    params: {},
    query: present({
      project_id: options.project as string | undefined,
      kind: options.kind as never,
      platform: options.platform as never,
      limit,
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(LIST, "indeterminate")))}\n`,
  );
}

async function get(inboundId: string, command: Command): Promise<void> {
  const operation = intakeOperations["inbound.get"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, false);
  requireIdentity(inboundId, GET);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, code(GET, "token_required"));
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.get"
  ]({ params: { inbound_id: inboundId }, query: {}, body: null });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code(GET, "indeterminate")))}\n`,
  );
}

async function remove(inboundId: string, command: Command): Promise<void> {
  const operation = intakeOperations["inbound.delete"];
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  requireIdentity(inboundId, DELETE);
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, code(DELETE, "token_required"));
  const key = resolveKey(options);
  const result = await httpClient(intakeOperations, endpoint, token)[
    "inbound.delete"
  ](
    { params: { inbound_id: inboundId }, query: {}, body: null },
    { idempotencyKey: key },
  );
  handleMutationResult(result, code(DELETE, "indeterminate"), key);
  process.stdout.write(`${JSON.stringify({ idempotency_key: key })}\n`);
}

export function addInboundCommands(intake: Command): void {
  const inbound = intake.command(INBOUND).description("Inbound commands");
  inbound.action(() => inbound.help());
  inbound
    .command(CREATE)
    .description("Create an inbound from a JSON file")
    .requiredOption("--file <path>", "Create file", singleUse("--file"))
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => create(command));
  inbound
    .command(LIST)
    .description("List inbounds as JSON")
    .option("--project <id>", "Project identity", singleUse("--project"))
    .option("--kind <kind>", "Filter by kind", singleUse("--kind"))
    .option(
      "--platform <platform>",
      "Filter by platform",
      singleUse("--platform"),
    )
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => list(command));
  inbound
    .command(GET)
    .description("Get an inbound as JSON")
    .argument("<inbound-id>", "Inbound identity")
    .action((id: string, _options, command: Command) => get(id, command));
  inbound
    .command(DELETE)
    .description("Delete an inbound and its events")
    .argument("<inbound-id>", "Inbound identity")
    .option("--idempotency-key <ulid>", "Mutation key", singleUse(KEY_OPTION))
    .action((id: string, _options, command: Command) => remove(id, command));
}

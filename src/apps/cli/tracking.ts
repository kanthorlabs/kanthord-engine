import assert from "node:assert/strict";
import { Command } from "commander";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  SPAN_LIST_LIMIT_DEFAULT,
  SPAN_LIST_LIMIT_MAX,
  SPAN_LIST_LIMIT_MIN,
  traceIdSchema,
  trackingOperations,
} from "../../tracking/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import {
  handleReadResult,
  parsePositiveInt,
  requireToken,
  singleUse,
} from "./shared.ts";

const TRACE = "trace";
const SPAN = "span";
const TEXT = "text";
const GET = "get";
const LIST = "list";
const TEXT_IDENTITY = /^[0-9a-f]{16}:[a-z][a-z0-9_.]*$/;

function requireTraceId(traceId: string, leaf: string): void {
  assert.ok(leaf);
  if (!traceIdSchema.safeParse(traceId).success)
    throw new Diagnostic(
      `cli.tracking.${leaf}.invalid_trace_id`,
      "invalid trace ID",
    );
}

function client(command: Command, leaf: string) {
  assert.ok(leaf);
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, `cli.tracking.${leaf}.token_required`);
  return httpClient(trackingOperations, endpoint, token);
}

async function traceGet(traceId: string, command: Command): Promise<void> {
  const leaf = `${TRACE}.${GET}`;
  requireTraceId(traceId, leaf);
  const result = await client(command, leaf).traceGet({
    params: { trace_id: traceId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, `cli.tracking.${leaf}.indeterminate`))}\n`,
  );
}

async function spanList(traceId: string, command: Command): Promise<void> {
  const leaf = `${SPAN}.${LIST}`;
  requireTraceId(traceId, leaf);
  const options = command.optsWithGlobals();
  const limit =
    options.limit === undefined
      ? SPAN_LIST_LIMIT_DEFAULT
      : parsePositiveInt(options.limit, "cli.pagination.limit_invalid");
  if (limit < SPAN_LIST_LIMIT_MIN || limit > SPAN_LIST_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be between ${SPAN_LIST_LIMIT_MIN} and ${SPAN_LIST_LIMIT_MAX}`,
    );
  const result = await client(command, leaf).spanList({
    params: { trace_id: traceId },
    query: { limit, cursor: options.cursor },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, `cli.tracking.${leaf}.indeterminate`))}\n`,
  );
}

async function textGet(
  traceId: string,
  textId: string,
  command: Command,
): Promise<void> {
  const leaf = `${TEXT}.${GET}`;
  requireTraceId(traceId, leaf);
  if (!TEXT_IDENTITY.test(textId))
    throw new Diagnostic(
      `cli.tracking.${leaf}.invalid_text_id`,
      "invalid text ID",
    );
  const result = await client(command, leaf).textGet({
    params: { trace_id: traceId, text_id: textId },
    query: {},
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, `cli.tracking.${leaf}.indeterminate`))}\n`,
  );
}

export function addTrackingCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some(
      (command) => command.name() === CommandName.Tracking,
    ),
  );
  const tracking = program
    .command(CommandName.Tracking)
    .description("Tracking Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  tracking.action(() => tracking.help());
  const trace = tracking.command(TRACE).description("Read traces");
  trace.action(() => trace.help());
  trace
    .command(GET)
    .description("Read a trace header as JSON")
    .argument("<trace-id>", "Trace ID")
    .action((traceId: string, _options, command: Command) =>
      traceGet(traceId, command),
    );
  const span = tracking.command(SPAN).description("Read the spans of a trace");
  span.action(() => span.help());
  span
    .command(LIST)
    .description("List the stored spans of a trace as JSON")
    .argument("<trace-id>", "Trace ID")
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((traceId: string, _options, command: Command) =>
      spanList(traceId, command),
    );
  const text = tracking
    .command(TEXT)
    .description("Read the telemetry texts of a trace");
  text.action(() => text.help());
  text
    .command(GET)
    .description("Read a telemetry text as JSON")
    .argument("<trace-id>", "Trace ID")
    .argument("<text-id>", "Text ID")
    .action((traceId: string, textId: string, _options, command: Command) =>
      textGet(traceId, textId, command),
    );
}

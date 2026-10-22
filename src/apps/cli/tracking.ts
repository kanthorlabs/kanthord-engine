import assert from "node:assert/strict";
import { Command } from "commander";
import type { z } from "zod";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  SPAN_LIST_LIMIT_DEFAULT,
  SPAN_LIST_LIMIT_MAX,
  SPAN_LIST_LIMIT_MIN,
  TRACE_LIST_LIMIT_DEFAULT,
  TRACE_LIST_LIMIT_MAX,
  TRACE_LIST_LIMIT_MIN,
  TraceSort,
  traceIdSchema,
  traceSortSchema,
  traceStateSchema,
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
const FACET = "facet";
const PROJECT_IDENTITY_PREFIX = "project";
const NODE_IDENTITY_PREFIX = "node";
const GET = "get";
const LIST = "list";
const TEXT_IDENTITY = /^[0-9a-f]{16}:[a-z][a-z0-9_.-]*$/;

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

function optionOf<T>(
  schema: z.ZodType<T>,
  value: string | undefined,
  code: string,
  description: string,
): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Diagnostic(code, `invalid ${description}`);
  return parsed.data;
}

function traceListLimit(value: string | undefined): number {
  if (value === undefined) return TRACE_LIST_LIMIT_DEFAULT;
  const limit = parsePositiveInt(value, "cli.pagination.limit_invalid");
  if (limit < TRACE_LIST_LIMIT_MIN || limit > TRACE_LIST_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be between ${TRACE_LIST_LIMIT_MIN} and ${TRACE_LIST_LIMIT_MAX}`,
    );
  return limit;
}

async function traceList(command: Command): Promise<void> {
  const leaf = `${TRACE}.${LIST}`;
  const options = command.optsWithGlobals();
  const code = (suffix: string) => `cli.tracking.${leaf}.${suffix}`;
  const query = {
    project_id: optionOf(
      identitySchema(PROJECT_IDENTITY_PREFIX),
      options.project,
      code("invalid_project_id"),
      "project ID",
    ),
    node_id: optionOf(
      identitySchema(NODE_IDENTITY_PREFIX),
      options.node,
      code("invalid_node_id"),
      "node ID",
    ),
    state: optionOf(
      traceStateSchema,
      options.state,
      code("invalid_state"),
      "state",
    ),
    q: options.query,
    sort:
      optionOf(
        traceSortSchema,
        options.sort,
        code("invalid_sort"),
        "sort field",
      ) ?? TraceSort.StartedAt,
    limit: traceListLimit(options.limit),
    cursor: options.cursor,
  };
  const result = await client(command, leaf).traceList({
    params: {},
    query,
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code("indeterminate")))}\n`,
  );
}

async function facetGet(command: Command): Promise<void> {
  const leaf = `${FACET}.${GET}`;
  const options = command.optsWithGlobals();
  const projectId = optionOf(
    identitySchema(PROJECT_IDENTITY_PREFIX),
    options.project,
    `cli.tracking.${leaf}.invalid_project_id`,
    "project ID",
  );
  const result = await client(command, leaf).facetGet({
    params: {},
    query: { project_id: projectId },
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
  trace
    .command(LIST)
    .description("List trace summaries as JSON")
    .option("--project <project-id>", "Project ID", singleUse("--project"))
    .option("--node <node-id>", "Node ID", singleUse("--node"))
    .option("--state <state>", "Trace state", singleUse("--state"))
    .option("--query <text>", "Search text", singleUse("--query"))
    .option("--sort <field>", "Sort field", singleUse("--sort"))
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => traceList(command));
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
  const facet = tracking
    .command(FACET)
    .description("Read the filter values of the traces");
  facet.action(() => facet.help());
  facet
    .command(GET)
    .description("Read the distinct filter values as JSON")
    .option("--project <project-id>", "Project ID", singleUse("--project"))
    .action((_options, command: Command) => facetGet(command));
}

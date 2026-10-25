import assert from "node:assert/strict";
import { Command } from "commander";
import type { z } from "zod";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { causeCategorySchema } from "../../kernel/cause.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  ENTRY_LIST_LIMIT_DEFAULT,
  ENTRY_LIST_LIMIT_MAX,
  ENTRY_LIST_LIMIT_MIN,
  SPAN_LIST_LIMIT_DEFAULT,
  SPAN_LIST_LIMIT_MAX,
  SPAN_LIST_LIMIT_MIN,
  TRACE_LIST_LIMIT_DEFAULT,
  TRACE_LIST_LIMIT_MAX,
  TRACE_LIST_LIMIT_MIN,
  TIMELINE_LIMIT_MAX,
  TIMELINE_LIMIT_MIN,
  TimelineScope,
  TraceSort,
  analyticsBucketSchema,
  analyticsMeasureSchema,
  causeLabelTextIdSchema,
  costGroupBySchema,
  durationGroupBySchema,
  entryIdentitySchema,
  spanIdSchema,
  timelineDepthSchema,
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
const SESSION = "session";
const ENTRY = "entry";
const FACET = "facet";
const TIMELINE = "timeline";
const ANALYTICS = "analytics";
const COST = "cost";
const DURATION = "duration";
const PROJECT_IDENTITY_PREFIX = "project";
const NODE_IDENTITY_PREFIX = "node";
const EXECUTION_IDENTITY_PREFIX = "execution";
const ONE_SCOPE = 1;
const UNIX_MS = /^\d+$/;
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

function unixMsOption(
  value: string | undefined,
  code: string,
): number | undefined {
  if (value === undefined) return undefined;
  const time = Number(value);
  if (!UNIX_MS.test(value) || !Number.isSafeInteger(time))
    throw new Diagnostic(code, "invalid Unix milliseconds time");
  return time;
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
    cause_category: optionOf(
      causeCategorySchema,
      options.causeCategory,
      code("invalid_cause_category"),
      "cause category",
    ),
    q: optionOf(
      trackingOperations.traceList.input.shape.query.shape.q,
      options.query,
      code("invalid_query"),
      "query text",
    ),
    sort:
      optionOf(
        traceSortSchema,
        options.sort,
        code("invalid_sort"),
        "sort field",
      ) ?? TraceSort.StartedAt,
    from: unixMsOption(options.from, code("invalid_query")),
    to: unixMsOption(options.to, code("invalid_query")),
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

function timelineLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = parsePositiveInt(value, "cli.pagination.limit_invalid");
  if (limit < TIMELINE_LIMIT_MIN || limit > TIMELINE_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be between ${TIMELINE_LIMIT_MIN} and ${TIMELINE_LIMIT_MAX}`,
    );
  return limit;
}

async function timelineList(command: Command): Promise<void> {
  const leaf = `${TIMELINE}.${LIST}`;
  const options = command.optsWithGlobals();
  const code = (suffix: string) => `cli.tracking.${leaf}.${suffix}`;
  const scopes = [options.execution, options.node, options.project].filter(
    (scope) => scope !== undefined,
  );
  if (scopes.length !== ONE_SCOPE)
    throw new Diagnostic(
      code("invalid_query"),
      "exactly one of --execution, --node and --project is required",
    );
  const query = {
    [TimelineScope.ExecutionId]: optionOf(
      identitySchema(EXECUTION_IDENTITY_PREFIX),
      options.execution,
      code("invalid_execution_id"),
      "execution ID",
    ),
    [TimelineScope.NodeId]: optionOf(
      identitySchema(NODE_IDENTITY_PREFIX),
      options.node,
      code("invalid_node_id"),
      "node ID",
    ),
    [TimelineScope.ProjectId]: optionOf(
      identitySchema(PROJECT_IDENTITY_PREFIX),
      options.project,
      code("invalid_project_id"),
      "project ID",
    ),
    depth: optionOf(
      timelineDepthSchema,
      options.depth,
      code("invalid_depth"),
      "depth",
    ),
    from: unixMsOption(options.from, code("invalid_query")),
    to: unixMsOption(options.to, code("invalid_query")),
    limit: timelineLimit(options.limit),
    cursor: options.cursor,
  };
  const result = await client(command, leaf).timelineList({
    params: {},
    query,
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code("indeterminate")))}\n`,
  );
}

function analyticsFilter(
  options: Record<string, string | undefined>,
  code: (suffix: string) => string,
) {
  return {
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
    from: unixMsOption(options.from, code("invalid_query")),
    to: unixMsOption(options.to, code("invalid_query")),
  };
}

async function analyticsCost(command: Command): Promise<void> {
  const leaf = `${ANALYTICS}.${COST}`;
  const options = command.optsWithGlobals();
  const code = (suffix: string) => `cli.tracking.${leaf}.${suffix}`;
  const query = {
    ...analyticsFilter(options, code),
    group_by: optionOf(
      costGroupBySchema,
      options.groupBy,
      code("invalid_query"),
      "group",
    ),
    bucket: optionOf(
      analyticsBucketSchema,
      options.bucket,
      code("invalid_query"),
      "bucket",
    ),
  };
  const result = await client(command, leaf).analyticsCost({
    params: {},
    query,
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, code("indeterminate")))}\n`,
  );
}

async function analyticsDuration(command: Command): Promise<void> {
  const leaf = `${ANALYTICS}.${DURATION}`;
  const options = command.optsWithGlobals();
  const code = (suffix: string) => `cli.tracking.${leaf}.${suffix}`;
  const measure = optionOf(
    analyticsMeasureSchema,
    options.measure,
    code("invalid_query"),
    "measure",
  );
  if (measure === undefined)
    throw new Diagnostic(code("invalid_query"), "--measure is required");
  const query = {
    ...analyticsFilter(options, code),
    measure,
    operation: optionOf(
      trackingOperations.analyticsDuration.input.shape.query.shape.operation,
      options.operation,
      code("invalid_query"),
      "operation",
    ),
    group_by: optionOf(
      durationGroupBySchema,
      options.groupBy,
      code("invalid_query"),
      "group",
    ),
    bucket: optionOf(
      analyticsBucketSchema,
      options.bucket,
      code("invalid_query"),
      "bucket",
    ),
  };
  const result = await client(command, leaf).analyticsDuration({
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
  if (
    !TEXT_IDENTITY.test(textId) &&
    !causeLabelTextIdSchema.safeParse(textId).success
  )
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

function requireSpanId(spanId: string, leaf: string): void {
  if (!spanIdSchema.safeParse(spanId).success)
    throw new Diagnostic(
      `cli.tracking.${leaf}.invalid_session_id`,
      "invalid session ID",
    );
}

function entryListLimit(value: string | undefined): number {
  if (value === undefined) return ENTRY_LIST_LIMIT_DEFAULT;
  const limit = parsePositiveInt(value, "cli.pagination.limit_invalid");
  if (limit < ENTRY_LIST_LIMIT_MIN || limit > ENTRY_LIST_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be between ${ENTRY_LIST_LIMIT_MIN} and ${ENTRY_LIST_LIMIT_MAX}`,
    );
  return limit;
}

async function sessionEntryList(
  traceId: string,
  sessionId: string,
  command: Command,
): Promise<void> {
  const leaf = `${SESSION}.${ENTRY}.${LIST}`;
  requireTraceId(traceId, leaf);
  requireSpanId(sessionId, leaf);
  const options = command.optsWithGlobals();
  const limit = entryListLimit(options.limit);
  const result = await client(command, leaf).sessionEntryList({
    params: { trace_id: traceId, session_id: sessionId },
    query: { limit, cursor: options.cursor, tool_call_id: options.toolCall },
    body: null,
  });
  process.stdout.write(
    `${JSON.stringify(handleReadResult(result, `cli.tracking.${leaf}.indeterminate`))}\n`,
  );
}

async function sessionEntryGet(
  traceId: string,
  sessionId: string,
  entryId: string,
  command: Command,
): Promise<void> {
  const leaf = `${SESSION}.${ENTRY}.${GET}`;
  requireTraceId(traceId, leaf);
  requireSpanId(sessionId, leaf);
  if (!entryIdentitySchema.safeParse(entryId).success)
    throw new Diagnostic(
      `cli.tracking.${leaf}.invalid_entry_id`,
      "invalid entry ID",
    );
  const result = await client(command, leaf).sessionEntryGet({
    params: { trace_id: traceId, session_id: sessionId, entry_id: entryId },
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
    .option(
      "--cause-category <category>",
      "Effective cause category",
      singleUse("--cause-category"),
    )
    .option("--query <text>", "Search text", singleUse("--query"))
    .option("--sort <field>", "Sort field", singleUse("--sort"))
    .option("--from <unix-ms>", "Window start", singleUse("--from"))
    .option("--to <unix-ms>", "Window end", singleUse("--to"))
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => traceList(command));
  const timeline = tracking
    .command(TIMELINE)
    .description("Read the timeline of an execution, a node or a project");
  timeline.action(() => timeline.help());
  timeline
    .command(LIST)
    .description("List the timeline spans of one scope as JSON")
    .option(
      "--execution <execution-id>",
      "Execution ID",
      singleUse("--execution"),
    )
    .option("--node <node-id>", "Node ID", singleUse("--node"))
    .option("--project <project-id>", "Project ID", singleUse("--project"))
    .option("--depth <1|2>", "Span depth", singleUse("--depth"))
    .option("--from <unix-ms>", "Window start", singleUse("--from"))
    .option("--to <unix-ms>", "Window end", singleUse("--to"))
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((_options, command: Command) => timelineList(command));
  const analytics = tracking
    .command(ANALYTICS)
    .description("Read the cost and the duration analytics of the traces");
  analytics.action(() => analytics.help());
  analytics
    .command(COST)
    .description("Sum the tokens and the cost of the agent turns as JSON")
    .option("--group-by <field>", "Group field", singleUse("--group-by"))
    .option("--bucket <size>", "Time bucket", singleUse("--bucket"))
    .option("--project <project-id>", "Project ID", singleUse("--project"))
    .option("--node <node-id>", "Node ID", singleUse("--node"))
    .option("--from <unix-ms>", "Range start", singleUse("--from"))
    .option("--to <unix-ms>", "Range end", singleUse("--to"))
    .action((_options, command: Command) => analyticsCost(command));
  analytics
    .command(DURATION)
    .description("Summarize one duration measure as JSON")
    .option("--measure <measure>", "Measure", singleUse("--measure"))
    .option("--operation <name>", "Span operation", singleUse("--operation"))
    .option("--group-by <field>", "Group field", singleUse("--group-by"))
    .option("--bucket <size>", "Time bucket", singleUse("--bucket"))
    .option("--project <project-id>", "Project ID", singleUse("--project"))
    .option("--node <node-id>", "Node ID", singleUse("--node"))
    .option("--from <unix-ms>", "Range start", singleUse("--from"))
    .option("--to <unix-ms>", "Range end", singleUse("--to"))
    .action((_options, command: Command) => analyticsDuration(command));
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
  const session = tracking
    .command(SESSION)
    .description("Read the agent sessions of a trace");
  session.action(() => session.help());
  const entry = session
    .command(ENTRY)
    .description("Read the entries of an agent session");
  entry.action(() => entry.help());
  entry
    .command(LIST)
    .description("List the stored entries of an agent session as JSON")
    .argument("<trace-id>", "Trace ID")
    .argument("<session-id>", "Session ID")
    .option(
      "--tool-call <tool-call-id>",
      "Tool call ID",
      singleUse("--tool-call"),
    )
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <opaque>",
      "Continue from a cursor",
      singleUse("--cursor"),
    )
    .action((traceId: string, sessionId: string, _options, command: Command) =>
      sessionEntryList(traceId, sessionId, command),
    );
  entry
    .command(GET)
    .description("Read an agent session entry as JSON")
    .argument("<trace-id>", "Trace ID")
    .argument("<session-id>", "Session ID")
    .argument("<entry-id>", "Entry ID")
    .action(
      (
        traceId: string,
        sessionId: string,
        entryId: string,
        _options,
        command: Command,
      ) => sessionEntryGet(traceId, sessionId, entryId, command),
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

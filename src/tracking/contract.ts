import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
export const TRACKING_SERVICE_NAME = "tracking";
export const EXECUTION_IDENTITY_PREFIX = "execution";
export const ROOT_SPAN_OPERATION = "scheduler.execution";
export const SCHEDULER_PRODUCER = "scheduler";
export const MISSION_PRODUCER = "mission";
const ONE_KIND_AT_MOST = 1;
export const TRACKING_TIMEOUT_MS = 30000;
export const TELEMETRY_WRITE_MAX_BODY_BYTES = 1048576;
export const TELEMETRY_WRITE_RECORDS_MAX = 1000;
export const TELEMETRY_RECORD_MAX_BYTES = 65536;
export const EXECUTION_RECORD_LIMIT = 50000;
export const ATTRIBUTES_MAX = 128;
export const COLLECTION_MAX = 128;
export const NAME_MAX_BYTES = 256;
export const RECORD_IDENTITY_MAX = 128;
export const SPAN_LIST_LIMIT_DEFAULT = 500;
export const SPAN_LIST_LIMIT_MIN = 1;
export const SPAN_LIST_LIMIT_MAX = 1000;
export const TRACE_LIST_LIMIT_MIN = 1;
export const TRACE_LIST_LIMIT_MAX = 1000;
export const TRACE_LIST_LIMIT_DEFAULT = 100;
export const TRACE_QUERY_MAX_CHARACTERS = 200;
export const FACET_VALUES_MAX = 200;

export const SpanStatus = { Unset: "Unset", Ok: "Ok", Error: "Error" } as const;
export const spanStatusSchema = z.enum(SpanStatus);
export type SpanStatus = z.infer<typeof spanStatusSchema>;

export const SpanOrigin = {
  Observed: "observed",
  Asserted: "asserted",
} as const;
export const spanOriginSchema = z.enum(SpanOrigin);
export type SpanOrigin = z.infer<typeof spanOriginSchema>;

export const RecordKind = {
  Span: "span",
  Text: "text",
  SessionEntry: "session_entry",
} as const;
export const recordKindSchema = z.enum(RecordKind);
export type RecordKind = z.infer<typeof recordKindSchema>;

export const Disposition = { Stored: "Stored", Refused: "Refused" } as const;
export const dispositionSchema = z.enum(Disposition);
export type Disposition = z.infer<typeof dispositionSchema>;

export const RefusalReason = {
  TraceMismatch: "trace_mismatch",
  ExecutionBound: "execution_bound",
  RecordTooLarge: "record_too_large",
  SelfParent: "self_parent",
  ForeignProducer: "foreign_producer",
  ValueReplaced: "value_replaced",
  TextExists: "text_exists",
} as const;
export const refusalReasonSchema = z.enum(RefusalReason);
export type RefusalReason = z.infer<typeof refusalReasonSchema>;

export const TraceState = { Open: "open", Ok: "ok", Error: "error" } as const;
export const traceStateSchema = z.enum(TraceState);
export type TraceState = z.infer<typeof traceStateSchema>;

export const TraceSort = {
  StartedAt: "started_at",
  DurationMs: "duration_ms",
  TotalTokens: "total_tokens",
  CostUsd: "cost_usd",
} as const;
export const traceSortSchema = z.enum(TraceSort);
export type TraceSort = z.infer<typeof traceSortSchema>;

export const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((value) => !/^0+$/.test(value));
export const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((value) => !/^0+$/.test(value));
const boundedName = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= NAME_MAX_BYTES);
const recordIdentitySchema = z
  .string()
  .max(RECORD_IDENTITY_MAX)
  .regex(/^[0-9a-f]{16}:[a-z][a-z0-9_.-]*$/);
export const entryIdentitySchema = z
  .string()
  .regex(/^[0-9a-z][0-9a-z-]{0,63}$/);
const safeInteger = z
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const primitiveSchema = z.union([
  z.string(),
  z.boolean(),
  safeInteger,
  z.number().finite(),
]);
function homogeneous(values: readonly unknown[]): boolean {
  const kinds = new Set(values.map((value) => typeof value));
  return kinds.size <= ONE_KIND_AT_MOST;
}
export const attributeValueSchema = z.union([
  primitiveSchema,
  z.array(primitiveSchema).max(COLLECTION_MAX).refine(homogeneous),
]);
export type AttributeValue = z.infer<typeof attributeValueSchema>;
export const attributesSchema = z
  .record(boundedName, attributeValueSchema)
  .refine((value) => Object.keys(value).length <= ATTRIBUTES_MAX);
export type Attributes = z.infer<typeof attributesSchema>;
export const spanEventSchema = z.strictObject({
  name: boundedName,
  time: timestamp,
  attributes: attributesSchema.optional(),
});
export type SpanEvent = z.infer<typeof spanEventSchema>;
export const spanLinkSchema = z.strictObject({
  trace_id: traceIdSchema,
  span_id: spanIdSchema,
});
export type SpanLink = z.infer<typeof spanLinkSchema>;

export const spanRecordSchema = z
  .strictObject({
    record_id: recordIdentitySchema,
    trace_id: traceIdSchema,
    kind: z.literal(RecordKind.Span),
    span_id: spanIdSchema,
    operation: boundedName,
    parent_span_id: spanIdSchema,
    start_time: timestamp.optional(),
    end_time: timestamp.optional(),
    status: spanStatusSchema.optional(),
    attributes: attributesSchema.optional(),
    events: z.array(spanEventSchema).max(COLLECTION_MAX).optional(),
    links: z.array(spanLinkSchema).max(COLLECTION_MAX).optional(),
    text_ids: z.array(recordIdentitySchema).max(COLLECTION_MAX).optional(),
  })
  .refine(
    (record) =>
      record.start_time !== undefined || record.end_time !== undefined,
    { path: ["start_time"] },
  );
export type SpanRecord = z.infer<typeof spanRecordSchema>;
export const textRecordSchema = z.strictObject({
  record_id: recordIdentitySchema,
  trace_id: traceIdSchema,
  kind: z.literal(RecordKind.Text),
  text_id: recordIdentitySchema,
  text: z.string().refine((value) => value.isWellFormed()),
});
export type TextRecord = z.infer<typeof textRecordSchema>;
export const sessionEntryRecordSchema = z
  .strictObject({
    record_id: recordIdentitySchema,
    trace_id: traceIdSchema,
    kind: z.literal(RecordKind.SessionEntry),
    session_id: spanIdSchema,
    entry_id: entryIdentitySchema,
    parent_entry_id: entryIdentitySchema.nullable(),
    sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    entry_type: boundedName,
    entry_time: timestamp,
    tool_call_id: boundedName.nullable(),
    truncated: z.boolean(),
    entry: z.record(z.string(), z.unknown()),
  })
  .refine(
    (record) =>
      record.record_id === `${record.session_id}:entry.${record.entry_id}`,
    { path: ["record_id"] },
  );
export type SessionEntryRecord = z.infer<typeof sessionEntryRecordSchema>;
export const telemetryRecordSchema = z.discriminatedUnion("kind", [
  spanRecordSchema,
  textRecordSchema,
  sessionEntryRecordSchema,
]);
export type TelemetryRecord = z.infer<typeof telemetryRecordSchema>;

export const telemetryWriteSchema = z.strictObject({
  records: z
    .array(telemetryRecordSchema)
    .min(1)
    .max(TELEMETRY_WRITE_RECORDS_MAX),
});
export const recordDispositionSchema = z.strictObject({
  record_id: recordIdentitySchema,
  disposition: dispositionSchema,
  reason: refusalReasonSchema.nullable(),
});
export type RecordDisposition = z.infer<typeof recordDispositionSchema>;
export const acknowledgementSchema = z.strictObject({
  dispositions: z.array(recordDispositionSchema),
  submitted: z.int().min(0),
  stored: z.int().min(0),
  refused: z.int().min(0),
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

const count = z.int().min(0);
export const traceSummarySchema = z.strictObject({
  trace_id: traceIdSchema,
  project_id: identitySchema("project").nullable(),
  execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX).nullable(),
  node_id: identitySchema("node").nullable(),
  attempt: z.int().min(1).nullable(),
  root_span_id: spanIdSchema,
  created_at: timestamp,
  state: traceStateSchema,
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  duration_ms: count.nullable(),
  stop_reason: z.string().nullable(),
  worker_name: z.string().nullable(),
  agent_names: z.array(z.string()),
  models: z.array(z.string()),
  error_types: z.array(z.string()),
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: count,
  cache_creation_tokens: count,
  total_tokens: count,
  cost_usd: z.number().finite().min(0),
  span_count: count,
  turn_count: count,
  tool_count: count,
  error_count: count,
  first_error_span_id: spanIdSchema.nullable(),
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export const spanSchema = z.strictObject({
  trace_id: traceIdSchema,
  span_id: spanIdSchema,
  parent_span_id: spanIdSchema.nullable(),
  producer: z.string().min(1),
  origin: spanOriginSchema,
  operation: z.string().min(1),
  start_time: timestamp.nullable(),
  end_time: timestamp.nullable(),
  status: spanStatusSchema,
  attributes: z.record(z.string(), attributeValueSchema),
  events: z.array(spanEventSchema),
  links: z.array(spanLinkSchema),
  text_ids: z.array(z.string()),
  created_at: timestamp,
});
export type Span = z.infer<typeof spanSchema>;
export const telemetryTextSchema = z.strictObject({
  trace_id: traceIdSchema,
  text_id: z.string().min(1),
  content: z.string(),
  created_at: timestamp,
});
export type TelemetryText = z.infer<typeof telemetryTextSchema>;

export interface ExecutionTrace {
  execution_id: string;
  project_id: string;
  node_id: string;
  attempt: number;
  trace_id: string;
  root_span_id: string;
}
export interface ExecutionTraces {
  traceOf(executionId: string): ExecutionTrace | undefined;
}
export const ExecutionEnd = { Finished: "finished", Lost: "lost" } as const;
export type ExecutionEnd = (typeof ExecutionEnd)[keyof typeof ExecutionEnd];
export interface RootSpanEnd {
  trace: ExecutionTrace;
  ended_at: number;
  end: ExecutionEnd;
  stop: { reason: string; code: string | null; detail?: string } | null;
}
export interface ExecutionTelemetry {
  executionOpened(trace: ExecutionTrace, createdAt: number): void;
  executionEnded(end: RootSpanEnd): void;
}

const traceParams = z.strictObject({ trace_id: traceIdSchema });
const nonNegativeInteger = z.coerce.number().int().min(0);
const nonNegativeCost = z.coerce.number().finite().min(0);

export const trackingOperations = {
  telemetryWrite: {
    id: "tracking.telemetry.write",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Post,
    path: "/api/tracking/execution/:execution_id/telemetry",
    access: AccessPolicy.Client,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: true,
    body: true,
    requiresExecution: true,
    maxBodyBytes: TELEMETRY_WRITE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    description:
      "Store the spans and telemetry texts that a native worker observed in its live execution.",
    input: z.strictObject({
      params: z.strictObject({
        execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: telemetryWriteSchema,
    }),
    output: acknowledgementSchema,
  },
  traceGet: {
    id: "tracking.trace.get",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/tracking/trace/:trace_id",
    access: AccessPolicy.Human,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "Read the summary of one trace.",
    input: z.strictObject({
      params: traceParams,
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: traceSummarySchema,
  },
  traceList: {
    id: "tracking.trace.list",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/tracking/trace",
    access: AccessPolicy.Human,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "List one page of trace summaries, newest first by default.",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({
        project_id: identitySchema("project").optional(),
        node_id: identitySchema("node").optional(),
        execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX).optional(),
        worker_name: boundedName.optional(),
        agent_name: boundedName.optional(),
        model: boundedName.optional(),
        error_type: boundedName.optional(),
        state: traceStateSchema.optional(),
        q: z.string().min(1).max(TRACE_QUERY_MAX_CHARACTERS).optional(),
        started_from: nonNegativeInteger.optional(),
        started_to: nonNegativeInteger.optional(),
        min_duration_ms: nonNegativeInteger.optional(),
        max_duration_ms: nonNegativeInteger.optional(),
        min_total_tokens: nonNegativeInteger.optional(),
        max_total_tokens: nonNegativeInteger.optional(),
        min_cost_usd: nonNegativeCost.optional(),
        max_cost_usd: nonNegativeCost.optional(),
        sort: traceSortSchema.default(TraceSort.StartedAt),
        limit: z.coerce
          .number()
          .int()
          .min(TRACE_LIST_LIMIT_MIN)
          .max(TRACE_LIST_LIMIT_MAX)
          .default(TRACE_LIST_LIMIT_DEFAULT),
        cursor: z.string().min(1).optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(traceSummarySchema),
      next_cursor: z.string().nullable(),
    }),
  },
  facetGet: {
    id: "tracking.facet.get",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/tracking/facet",
    access: AccessPolicy.Human,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "Read the distinct worker names, agent names, models and error types of the traces.",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({
        project_id: identitySchema("project").optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      worker_names: z.array(z.string()),
      agent_names: z.array(z.string()),
      models: z.array(z.string()),
      error_types: z.array(z.string()),
    }),
  },
  spanList: {
    id: "tracking.span.list",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/tracking/trace/:trace_id/span",
    access: AccessPolicy.Human,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "List one page of the stored spans of a trace, oldest first. The page promises no complete trace.",
    input: z.strictObject({
      params: traceParams,
      query: z.strictObject({
        limit: z.coerce
          .number()
          .int()
          .min(SPAN_LIST_LIMIT_MIN)
          .max(SPAN_LIST_LIMIT_MAX)
          .default(SPAN_LIST_LIMIT_DEFAULT),
        cursor: z.string().min(1).optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(spanSchema),
      next_cursor: z.string().nullable(),
    }),
  },
  textGet: {
    id: "tracking.text.get",
    service: TRACKING_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/tracking/trace/:trace_id/text/:text_id",
    access: AccessPolicy.Human,
    store: StoreName.Tracking,
    lifetime: OperationLifetime.Unary,
    timeoutMs: TRACKING_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "Read one telemetry text.",
    input: z.strictObject({
      params: z.strictObject({
        trace_id: traceIdSchema,
        text_id: recordIdentitySchema,
      }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: telemetryTextSchema,
  },
} as const satisfies Record<string, Operation>;

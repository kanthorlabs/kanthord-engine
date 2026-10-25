import assert from "node:assert/strict";
import {
  CAUSE_SUBCATEGORIES,
  CauseAssigner,
  CauseAttribute,
  CauseCategory,
  effectiveCauseSchema,
  type CauseSubcategory,
  type EffectiveCause,
} from "../kernel/cause.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  SpanOrigin,
  SpanStatus,
  TraceState,
  type Attributes,
  type Span,
} from "./contract.ts";
import { readTrace } from "./trace-store.ts";

export { causeLabelSpanIdSchema, causeLabelTextIdSchema } from "./contract.ts";

export const CAUSE_LABEL_OPERATION = "tracking.cause_label";
export const CAUSE_LABEL_SUFFIX = ".cause_label";
export const TRACKING_PRODUCER = "tracking";
export const HUMAN_USERNAME_ATTRIBUTE = "kanthord.human.username";
export const REASON_TEXT = "reason";
export const CauseLabelCode = {
  TraceOpen: "tracking.cause.trace_open",
  SubcategoryMismatch: "tracking.cause.subcategory_mismatch",
} as const;
const TRACE_NOT_FOUND_CODE = "tracking.trace.not_found";
const CAUSE_LABEL_REASON_SUFFIX = `${CAUSE_LABEL_SUFFIX}:${REASON_TEXT}`;

export interface CauseLabelBody {
  category: CauseCategory;
  subcategory: CauseSubcategory;
  reason: string;
}

export function causeLabelSpanId(rootSpanId: string): string {
  return `${rootSpanId}${CAUSE_LABEL_SUFFIX}`;
}

export function causeLabelReasonTextId(rootSpanId: string): string {
  return `${rootSpanId}${CAUSE_LABEL_REASON_SUFFIX}`;
}

function subcategoryOf(attributes: Attributes) {
  const subcategory = attributes[CauseAttribute.Subcategory];
  return subcategory === undefined ? {} : { subcategory };
}

function causeOfLabel(label: Attributes): unknown {
  return {
    category: label[CauseAttribute.Category],
    assigner: CauseAssigner.Human,
    ...subcategoryOf(label),
  };
}

function causeOfRoot(root: Attributes): unknown {
  const category = root[CauseAttribute.Category];
  return {
    category,
    assigner: root[CauseAttribute.Assigner],
    ...subcategoryOf(root),
    ...(category === CauseCategory.Unattributed
      ? { suspects: root[CauseAttribute.Suspects] ?? [] }
      : {}),
  };
}

function candidateOf(
  root: Attributes | null,
  label: Attributes | null,
): unknown {
  if (label !== null && CauseAttribute.Category in label)
    return causeOfLabel(label);
  if (root !== null && CauseAttribute.Category in root)
    return causeOfRoot(root);
  return null;
}

export function effectiveCauseOf(
  root: Attributes | null,
  label: Attributes | null,
): EffectiveCause | null {
  const parsed = effectiveCauseSchema.safeParse(candidateOf(root, label));
  return parsed.success ? parsed.data : null;
}

const UPSERT_SPAN =
  "INSERT INTO tracking_span (trace_id, span_id, parent_span_id, producer, origin, operation, start_time, end_time, status, attributes, events, links, text_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trace_id, span_id) DO UPDATE SET parent_span_id = excluded.parent_span_id, producer = excluded.producer, origin = excluded.origin, operation = excluded.operation, start_time = excluded.start_time, end_time = excluded.end_time, status = excluded.status, attributes = excluded.attributes, events = excluded.events, links = excluded.links, text_ids = excluded.text_ids, created_at = excluded.created_at";
const UPSERT_TEXT =
  "INSERT INTO tracking_telemetry_text (trace_id, text_id, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (trace_id, text_id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at";

export function writeCauseLabel(
  tx: Transaction,
  traceId: string,
  body: CauseLabelBody,
  username: string,
  now: number,
): Span {
  assert.ok(traceId);
  assert.ok(username);
  const trace = readTrace(tx, traceId);
  if (trace === null)
    throw new OperationError(
      HttpStatus.NotFound,
      TRACE_NOT_FOUND_CODE,
      "The trace is unknown or expired.",
    );
  if (trace.state === TraceState.Open)
    throw new OperationError(
      HttpStatus.Conflict,
      CauseLabelCode.TraceOpen,
      "The trace is still open.",
    );
  if (!CAUSE_SUBCATEGORIES[body.category].includes(body.subcategory))
    throw new OperationError(
      HttpStatus.BadRequest,
      CauseLabelCode.SubcategoryMismatch,
      "The subcategory does not belong to the category.",
      { category: body.category, subcategory: body.subcategory },
    );
  const span: Span = {
    trace_id: traceId,
    span_id: causeLabelSpanId(trace.root_span_id),
    parent_span_id: trace.root_span_id,
    producer: TRACKING_PRODUCER,
    origin: SpanOrigin.Asserted,
    operation: CAUSE_LABEL_OPERATION,
    start_time: now,
    end_time: now,
    status: SpanStatus.Ok,
    attributes: {
      [CauseAttribute.Category]: body.category,
      [CauseAttribute.Subcategory]: body.subcategory,
      [HUMAN_USERNAME_ATTRIBUTE]: username,
    },
    events: [],
    links: [],
    text_ids: [causeLabelReasonTextId(trace.root_span_id)],
    created_at: now,
  };
  tx.database
    .prepare(UPSERT_SPAN)
    .run(
      span.trace_id,
      span.span_id,
      span.parent_span_id,
      span.producer,
      span.origin,
      span.operation,
      span.start_time,
      span.end_time,
      span.status,
      JSON.stringify(span.attributes),
      JSON.stringify(span.events),
      JSON.stringify(span.links),
      JSON.stringify(span.text_ids),
      span.created_at,
    );
  tx.database
    .prepare(UPSERT_TEXT)
    .run(traceId, causeLabelReasonTextId(trace.root_span_id), body.reason, now);
  return span;
}

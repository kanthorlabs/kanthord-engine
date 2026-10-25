import assert from "node:assert/strict";
import { test } from "node:test";
import { CauseAttribute } from "../kernel/cause.ts";
import {
  CAUSE_LABEL_OPERATION,
  CAUSE_LABEL_SUFFIX,
  causeLabelReasonTextId,
  causeLabelSpanId,
  causeLabelSpanIdSchema,
  causeLabelTextIdSchema,
  effectiveCauseOf,
} from "./cause-label.ts";
import { spanSchema, trackingOperations } from "./contract.ts";

const ROOT_SPAN_ID = "0123456789abcdef";
const OPERATION = "tracking.cause_label";
const SUFFIX = ".cause_label";
const TRACE_ID = "a".repeat(32);

const ROOT_CAUSE = {
  [CauseAttribute.Category]: "model",
  [CauseAttribute.Subcategory]: "no_progress",
  [CauseAttribute.Assigner]: "rule",
};
const LABEL_CAUSE = {
  [CauseAttribute.Category]: "prompt",
  [CauseAttribute.Subcategory]: "context_missing",
};
const UNATTRIBUTED_ROOT = {
  [CauseAttribute.Category]: "unattributed",
  [CauseAttribute.Assigner]: "rule",
  [CauseAttribute.Suspects]: ["model", "prompt"],
};

test("the label identities add the suffix to the root span identity", () => {
  assert.equal(CAUSE_LABEL_OPERATION, OPERATION);
  assert.equal(CAUSE_LABEL_SUFFIX, SUFFIX);
  assert.equal(causeLabelSpanId(ROOT_SPAN_ID), `${ROOT_SPAN_ID}.cause_label`);
  assert.equal(
    causeLabelReasonTextId(ROOT_SPAN_ID),
    `${ROOT_SPAN_ID}.cause_label:reason`,
  );
});

test("the label span identity schema accepts the label identity only", () => {
  assert.ok(
    causeLabelSpanIdSchema.safeParse(causeLabelSpanId(ROOT_SPAN_ID)).success,
  );
  assert.ok(!causeLabelSpanIdSchema.safeParse(ROOT_SPAN_ID).success);
  assert.ok(!causeLabelSpanIdSchema.safeParse(`${ROOT_SPAN_ID}.other`).success);
});

test("the label text identity schema accepts the reason identity and refuses a plain reason", () => {
  assert.ok(
    causeLabelTextIdSchema.safeParse(causeLabelReasonTextId(ROOT_SPAN_ID))
      .success,
  );
  assert.ok(
    !causeLabelTextIdSchema.safeParse(`${ROOT_SPAN_ID}:reason`).success,
  );
});

test("the textGet params accept the reason identity and a record identity and refuse another label text", () => {
  const { params } = trackingOperations.textGet.input.shape;
  const parse = (text_id: string) =>
    params.safeParse({ trace_id: TRACE_ID, text_id }).success;
  assert.ok(parse(causeLabelReasonTextId(ROOT_SPAN_ID)));
  assert.ok(parse(`${ROOT_SPAN_ID}:reason`));
  assert.ok(!parse(`${ROOT_SPAN_ID}.cause_label:other`));
});

test("the span schema accepts the label span identity", () => {
  const span = {
    trace_id: TRACE_ID,
    span_id: causeLabelSpanId(ROOT_SPAN_ID),
    parent_span_id: ROOT_SPAN_ID,
    producer: "server",
    origin: "asserted",
    operation: CAUSE_LABEL_OPERATION,
    start_time: 1,
    end_time: 2,
    status: "Unset",
    attributes: {},
    events: [],
    links: [],
    text_ids: [],
    created_at: 1,
  };
  assert.ok(spanSchema.safeParse(span).success);
  assert.ok(
    !spanSchema.safeParse({ ...span, parent_span_id: causeLabelSpanId("0") })
      .success,
  );
});

test("the effective cause is the label cause with the assigner human", () => {
  assert.deepEqual(effectiveCauseOf(ROOT_CAUSE, LABEL_CAUSE), {
    category: "prompt",
    subcategory: "context_missing",
    assigner: "human",
  });
});

test("the effective cause is the root cause without a label category", () => {
  assert.deepEqual(effectiveCauseOf(ROOT_CAUSE, null), {
    category: "model",
    subcategory: "no_progress",
    assigner: "rule",
  });
  assert.deepEqual(effectiveCauseOf(ROOT_CAUSE, {}), {
    category: "model",
    subcategory: "no_progress",
    assigner: "rule",
  });
});

test("an unattributed root cause answers its suspects, an empty list when it holds none", () => {
  assert.deepEqual(effectiveCauseOf(UNATTRIBUTED_ROOT, null), {
    category: "unattributed",
    assigner: "rule",
    suspects: ["model", "prompt"],
  });
  assert.deepEqual(
    effectiveCauseOf(
      {
        [CauseAttribute.Category]: "unattributed",
        [CauseAttribute.Assigner]: "rule",
      },
      null,
    ),
    { category: "unattributed", assigner: "rule", suspects: [] },
  );
});

test("the effective cause is null without a cause or with an invalid cause", () => {
  assert.equal(effectiveCauseOf(null, null), null);
  assert.equal(effectiveCauseOf({}, {}), null);
  assert.equal(
    effectiveCauseOf(
      { ...ROOT_CAUSE, [CauseAttribute.Subcategory]: "context_missing" },
      null,
    ),
    null,
  );
});

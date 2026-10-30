import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IdentityKind } from "../kernel/caller.ts";
import { CauseAttribute } from "../kernel/cause.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  CAUSE_LABEL_OPERATION,
  CAUSE_LABEL_SUFFIX,
  type CauseLabelBody,
  CauseLabelCode,
  causeLabelReasonTextId,
  causeLabelSpanId,
  causeLabelSpanIdSchema,
  causeLabelTextIdSchema,
  effectiveCauseOf,
  HUMAN_USERNAME_ATTRIBUTE,
  TRACKING_PRODUCER,
  writeCauseLabel,
} from "./cause-label.ts";
import {
  CAUSE_REASON_MAX_CHARACTERS,
  SpanOrigin,
  spanSchema,
  SpanStatus,
  TRACKING_SERVICE_NAME,
  trackingOperations,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { TrackingService } from "./service.ts";
import { insertTrace, listSpans, readSpan, readText } from "./trace-store.ts";
import { stopAfter } from "../kernel/test-support.ts";

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

const PROJECT_ID = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const USERNAME = "account_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const OTHER_USERNAME = "account_01JZ8R2B3C4D5E6F7G8H9J0K1N";
const UNKNOWN_TRACE_ID = "b".repeat(32);
const CREATED_AT = 1000;
const FIRST_LABEL_TIME = 5000;
const SECOND_LABEL_TIME = 6000;
const ONE_ROW = 1;
const NO_ROWS = 0;
const TRIMMED_REASON = "why";
const TRACE_NOT_FOUND = "tracking.trace.not_found";
const FIRST_BODY: CauseLabelBody = {
  category: "prompt",
  subcategory: "context_missing",
  reason: "The prompt lacked the build command.",
};
const SECOND_BODY: CauseLabelBody = {
  category: "plan",
  subcategory: "oversized",
  reason: "The node held two jobs.",
};

function endedTrace(t: TestContext, state = "ok"): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  store.transaction((tx) => {
    insertTrace(
      tx,
      {
        trace_id: TRACE_ID,
        project_id: PROJECT_ID,
        execution_id: null,
        node_id: null,
        attempt: null,
        root_span_id: ROOT_SPAN_ID,
      },
      CREATED_AT,
    );
    tx.database
      .prepare("UPDATE tracking_trace SET state = ? WHERE trace_id = ?")
      .run(state, TRACE_ID);
  });
  return store;
}

function traceRow(store: Store) {
  return store.transaction((tx) =>
    tx.database
      .prepare("SELECT * FROM tracking_trace WHERE trace_id = ?")
      .get(TRACE_ID),
  );
}

function label(
  store: Store,
  body: CauseLabelBody,
  now: number,
  traceId = TRACE_ID,
  username = USERNAME,
) {
  return store.transaction((tx) =>
    writeCauseLabel(tx, traceId, body, username, now),
  );
}

function refusal(action: () => unknown): OperationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof OperationError);
    return error;
  }
  return assert.fail("the label was not refused");
}

function spanCount(store: Store): number {
  return store.transaction((tx) => listSpans(tx, TRACE_ID, 0, 10)).items.length;
}

function recordCount(store: Store): number {
  return store.transaction((tx) =>
    Number(
      tx.database.prepare("SELECT COUNT(*) AS count FROM tracking_record").get()
        ?.count,
    ),
  );
}

test("a label on an ended trace writes the label span and the reason text", (t) => {
  const store = endedTrace(t);
  label(store, FIRST_BODY, FIRST_LABEL_TIME);
  const span = store.transaction((tx) =>
    readSpan(tx, TRACE_ID, causeLabelSpanId(ROOT_SPAN_ID)),
  );
  assert.deepEqual(span, {
    trace_id: TRACE_ID,
    span_id: causeLabelSpanId(ROOT_SPAN_ID),
    parent_span_id: ROOT_SPAN_ID,
    producer: TRACKING_PRODUCER,
    origin: SpanOrigin.Asserted,
    operation: CAUSE_LABEL_OPERATION,
    start_time: FIRST_LABEL_TIME,
    end_time: FIRST_LABEL_TIME,
    status: SpanStatus.Ok,
    attributes: {
      [CauseAttribute.Category]: FIRST_BODY.category,
      [CauseAttribute.Subcategory]: FIRST_BODY.subcategory,
      [HUMAN_USERNAME_ATTRIBUTE]: USERNAME,
    },
    events: [],
    links: [],
    text_ids: [causeLabelReasonTextId(ROOT_SPAN_ID)],
    created_at: FIRST_LABEL_TIME,
  });
  const text = store.transaction((tx) =>
    readText(tx, TRACE_ID, causeLabelReasonTextId(ROOT_SPAN_ID)),
  );
  assert.equal(text?.content, FIRST_BODY.reason);
  assert.equal(recordCount(store), NO_ROWS);
});

test("a second label replaces the span attributes and the text and keeps one span row", (t) => {
  const store = endedTrace(t);
  label(store, FIRST_BODY, FIRST_LABEL_TIME);
  label(store, SECOND_BODY, SECOND_LABEL_TIME, TRACE_ID, OTHER_USERNAME);
  const spans = store.transaction((tx) => listSpans(tx, TRACE_ID, 0, 10)).items;
  assert.equal(spans.length, ONE_ROW);
  assert.deepEqual(spans[0]?.attributes, {
    [CauseAttribute.Category]: SECOND_BODY.category,
    [CauseAttribute.Subcategory]: SECOND_BODY.subcategory,
    [HUMAN_USERNAME_ATTRIBUTE]: OTHER_USERNAME,
  });
  assert.equal(spans[0]?.start_time, SECOND_LABEL_TIME);
  const texts = store.transaction((tx) =>
    tx.database.prepare("SELECT content FROM tracking_telemetry_text").all(),
  );
  assert.deepEqual(
    texts.map((row) => row.content),
    [SECOND_BODY.reason],
  );
});

test("an open trace answers tracking.cause.trace_open and writes nothing", (t) => {
  const store = endedTrace(t, "open");
  const error = refusal(() => label(store, FIRST_BODY, FIRST_LABEL_TIME));
  assert.equal(error.status, HttpStatus.Conflict);
  assert.equal(error.code, CauseLabelCode.TraceOpen);
  assert.equal(spanCount(store), NO_ROWS);
});

test("an unknown trace answers tracking.trace.not_found", (t) => {
  const store = endedTrace(t);
  const error = refusal(() =>
    label(store, FIRST_BODY, FIRST_LABEL_TIME, UNKNOWN_TRACE_ID),
  );
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, TRACE_NOT_FOUND);
});

test("a subcategory outside its category answers tracking.cause.subcategory_mismatch", (t) => {
  const store = endedTrace(t);
  const body: CauseLabelBody = { ...FIRST_BODY, subcategory: "oversized" };
  const error = refusal(() => label(store, body, FIRST_LABEL_TIME));
  assert.equal(error.status, HttpStatus.BadRequest);
  assert.equal(error.code, CauseLabelCode.SubcategoryMismatch);
  assert.deepEqual(error.details, {
    category: body.category,
    subcategory: body.subcategory,
  });
  assert.equal(spanCount(store), NO_ROWS);
});

test("a label leaves the trace row unchanged", (t) => {
  const store = endedTrace(t);
  const before = traceRow(store);
  label(store, FIRST_BODY, FIRST_LABEL_TIME);
  label(store, SECOND_BODY, SECOND_LABEL_TIME);
  assert.deepEqual(traceRow(store), before);
});

test("tracking.text.get answers the reason of the last label", (t) => {
  const store = endedTrace(t);
  const service = new TrackingService({
    store,
    retentionDays: 30,
    executions: { traceOf: () => undefined },
  });
  const caller: CallerContext = {
    identity: {
      kind: IdentityKind.Human,
      accountId: USERNAME,
      name: "Ulrich",
      jti: "jti",
    },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  label(store, FIRST_BODY, FIRST_LABEL_TIME);
  label(store, SECOND_BODY, SECOND_LABEL_TIME);
  const text = service.textGet(
    TRACE_ID,
    causeLabelReasonTextId(ROOT_SPAN_ID),
    caller,
  );
  assert.equal(text.content, SECOND_BODY.reason);
  assert.equal(text.created_at, SECOND_LABEL_TIME);
});

test("the cause label body refuses unattributed, a blank reason and an unknown field and trims the reason", () => {
  const { body } = trackingOperations.causeLabel.input.shape;
  assert.ok(body.safeParse(FIRST_BODY).success);
  assert.ok(
    !body.safeParse({ ...FIRST_BODY, category: "unattributed" }).success,
  );
  assert.ok(!body.safeParse({ ...FIRST_BODY, reason: "  " }).success);
  assert.ok(
    !body.safeParse({
      ...FIRST_BODY,
      reason: "x".repeat(CAUSE_REASON_MAX_CHARACTERS + 1),
    }).success,
  );
  assert.ok(!body.safeParse({ ...FIRST_BODY, extra: true }).success);
  assert.equal(
    body.parse({ ...FIRST_BODY, reason: ` ${TRIMMED_REASON} ` }).reason,
    TRIMMED_REASON,
  );
});

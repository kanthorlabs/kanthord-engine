import assert from "node:assert/strict";
import { test } from "node:test";
import { type ServerTrace, SpanStatus } from "../tracking/contract.ts";
import {
  EnvironmentAttribute,
  environmentRootEnd,
  environmentRootStart,
  EnvironmentSpan,
  environmentSpanSchema,
  environmentStepSpan,
  type EnvironmentStepSpan,
} from "./environment-telemetry.ts";

const TRACE: ServerTrace = {
  trace_id: "a".repeat(32),
  root_span_id: "b".repeat(16),
  project_id: "project_1",
  created_at: 10,
  node_id: null,
  attempt: null,
};
const STEP_SPAN_ID = "c".repeat(16);
const RUN = {
  binding_name: "app",
  target: "image",
  source: "repository",
  digest: "digest_1",
} as const;
const SETUP_FAILED = "setup_failed";
const BUILD_FAILED = "build_failed";
const START_TIME = 11;
const END_TIME = 12;
const TAIL = "SECRET_TAIL_TEXT";
const OUTPUT = "SECRET_COMMAND_OUTPUT";
const ENVIRONMENT_VALUE = "SECRET_ENVIRONMENT_VALUE";
const ALLOWED_ATTRIBUTES = new Set<string>(Object.values(EnvironmentAttribute));

function passedStep(operation: EnvironmentStepSpan) {
  return {
    span_id: STEP_SPAN_ID,
    operation,
    start_time: START_TIME,
    end_time: END_TIME,
    status: SpanStatus.Ok,
    error_type: null,
  };
}

test("environmentRootStart answers the root span with the five attributes", () => {
  const contribution = environmentRootStart(TRACE, RUN);
  assert.equal(contribution.span_id, TRACE.root_span_id);
  assert.equal(contribution.parent_span_id, null);
  assert.equal(contribution.operation, EnvironmentSpan.Root);
  assert.equal(contribution.start_time, TRACE.created_at);
  assert.deepEqual(contribution.attributes, {
    "project.id": "project_1",
    "project.binding.name": "app",
    "environment.target": "image",
    "environment.source": "repository",
    "environment.digest": "digest_1",
  });
});

test("environmentRootEnd answers Ok for a passed run", () => {
  const contribution = environmentRootEnd(TRACE, {
    end_time: END_TIME,
    status: SpanStatus.Ok,
    error_type: null,
  });
  assert.equal(contribution.span_id, TRACE.root_span_id);
  assert.equal(contribution.parent_span_id, null);
  assert.equal(contribution.operation, EnvironmentSpan.Root);
  assert.equal(contribution.end_time, END_TIME);
  assert.equal(contribution.status, SpanStatus.Ok);
  assert.equal(contribution.attributes?.["error.type"], undefined);
});

test("environmentRootEnd answers Error and the class for a failed run", () => {
  const contribution = environmentRootEnd(TRACE, {
    end_time: END_TIME,
    status: SpanStatus.Error,
    error_type: SETUP_FAILED,
  });
  assert.equal(contribution.status, SpanStatus.Error);
  assert.equal(contribution.attributes?.["error.type"], SETUP_FAILED);
});

test("environmentRootEnd answers Error and no class for a cancelled run", () => {
  const contribution = environmentRootEnd(TRACE, {
    end_time: END_TIME,
    status: SpanStatus.Error,
    error_type: null,
  });
  assert.equal(contribution.status, SpanStatus.Error);
  assert.equal(contribution.attributes?.["error.type"], undefined);
});

test("root start and root end hold distinct record identities", () => {
  const start = environmentRootStart(TRACE, RUN);
  const end = environmentRootEnd(TRACE, {
    end_time: END_TIME,
    status: SpanStatus.Ok,
    error_type: null,
  });
  assert.notEqual(start.record_id, end.record_id);
});

test("environmentStepSpan answers one child span for each step operation", () => {
  for (const operation of [
    EnvironmentSpan.Build,
    EnvironmentSpan.Setup,
    EnvironmentSpan.Proof,
  ]) {
    const contribution = environmentStepSpan(TRACE, passedStep(operation));
    assert.equal(contribution.operation, operation);
    assert.equal(contribution.span_id, STEP_SPAN_ID);
    assert.equal(contribution.parent_span_id, TRACE.root_span_id);
    assert.equal(contribution.start_time, START_TIME);
    assert.equal(contribution.end_time, END_TIME);
    assert.equal(contribution.status, SpanStatus.Ok);
  }
});

test("environmentStepSpan holds Error and the class for a failed step", () => {
  const contribution = environmentStepSpan(TRACE, {
    ...passedStep(EnvironmentSpan.Build),
    status: SpanStatus.Error,
    error_type: BUILD_FAILED,
  });
  assert.equal(contribution.status, SpanStatus.Error);
  assert.equal(contribution.attributes?.["error.type"], BUILD_FAILED);
});

test("the span names form a closed set", () => {
  assert.deepEqual(environmentSpanSchema.options, [
    "project.environment",
    "environment.build",
    "environment.setup",
    "environment.proof",
  ]);
});

test("no contribution holds an output tail, a command output or an environment value", () => {
  const failed = {
    ...passedStep(EnvironmentSpan.Setup),
    status: SpanStatus.Error,
    error_type: SETUP_FAILED,
    tail: TAIL,
    output: OUTPUT,
    environment: { TOKEN: ENVIRONMENT_VALUE },
  };
  const contributions = [
    environmentRootStart(TRACE, RUN),
    environmentRootEnd(TRACE, {
      end_time: END_TIME,
      status: SpanStatus.Error,
      error_type: SETUP_FAILED,
    }),
    environmentStepSpan(TRACE, failed),
  ];
  const text = JSON.stringify(contributions);
  for (const secret of [TAIL, OUTPUT, ENVIRONMENT_VALUE])
    assert.ok(!text.includes(secret));
  for (const contribution of contributions) {
    for (const name of Object.keys(contribution.attributes ?? {}))
      assert.ok(ALLOWED_ATTRIBUTES.has(name), name);
  }
});

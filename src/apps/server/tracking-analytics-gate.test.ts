import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import {
  AssessmentResult,
  AssetKind,
  Intent,
  missionOperations,
} from "../../mission/contract.ts";
import {
  projectOperations,
  workerResourceIdentity,
} from "../../project/contract.ts";
import {
  ClaimState,
  type ExecutionRecord,
  ExecutionStopReason,
  schedulerOperations,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import {
  AnalyticsBucket,
  AnalyticsMeasure,
  type AttributeValue,
  CostGroupBy,
  DurationGroupBy,
  RecordKind,
  trackingOperations,
} from "../../tracking/contract.ts";
import { InstancePlacement, workerOperations } from "../../worker/contract.ts";
import {
  createInstances,
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
  instanceNames,
} from "./test-support.ts";
import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
const REWORK_CAUSE = attributed(
  CauseCategory.Model,
  CauseSubcategory.WorkDefect,
  CauseAssigner.Reviewer,
);

const JOURNEY_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 30000;
const STOP_BACKOFF_SECONDS = 1;
const RETRY_POLL_MS = 250;
const RETRY_POLL_BOUND = 40;
const STEP_GAP_MS = 5;
const FIRST_BINDING_SET_VERSION = 1;
const SINGLE = 1;
const HALF_DIVISOR = 2;
const DISTINCT_MODELS = 2;
const DISTINCT_NODES = 2;
const DISTINCT_DAYS = 2;
const NO_REFUSALS = 0;
const NO_REVISIONS = 0;
const MONDAY_INDEX = 0;
const SECOND_NODE_TOTAL_TOKENS = 330;
const SECOND_NODE_COST = 2;
const MODEL_A_FIRST_NODE_COST = 0.5;
const WEEK_TURNS = 3;
const WEEK_COST = 3.75;
const TOOL_MAX_MS = 100;
const VERIFICATION_MAX_MS = 300;
const BAD_REQUEST = 400;
const WAIT_TOLERANCE_MS = 1000;
const NUMBER_TOLERANCE = 0.000001;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const WEEK_DAYS = 7;
const OLD_DAYS = 8;
const STEPS_BINDING = "steps";
const REVIEWER_BINDING = "reviewer";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const RANGE_INVALID = "tracking.filter.range_invalid";
const COST_PATH = "/api/tracking/analytics/cost";
const DURATION_PATH = "/api/tracking/analytics/duration";
const TURN_OPERATION = "agent.turn";
const TOOL_OPERATION = "agent.tool";
const VERIFICATION_OPERATION = "worker.verification";
const RESPONSE_MODEL = "gen_ai.response.model";
const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const CACHE_READ_TOKENS = "gen_ai.usage.cache_read.input_tokens";
const CACHE_CREATION_TOKENS = "gen_ai.usage.cache_creation.input_tokens";
const COST = "kanthord.usage.cost_usd";
const TOOL_NAME = "gen_ai.tool.name";
const MODEL_A = "model_a";
const MODEL_B = "model_b";
const MODEL_OLD = "model_old";
const TOOL_BASH = "bash";
const TOOL_DURATIONS_MS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const VERIFICATION_DURATIONS_MS = [120, 300];
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const NODE_CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
  intent: Intent.Examine,
};
const EMPTY = { params: {}, query: {} } as const;

type Caller = ReturnType<typeof humanCaller>;
type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;
interface Worker {
  call: Caller;
  runtime_identity: string;
  resource_identity: string;
}
interface Run {
  execution: ExecutionRecord;
  worker: Worker;
}
interface SpanSeed {
  operation: string;
  start: number;
  end?: number;
  attributes?: Record<string, AttributeValue>;
}
interface Usage {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost: number;
}

function weekdayIndex(time: number): number {
  return (new Date(time).getUTCDay() + 6) % WEEK_DAYS;
}

function datesOfRun(now: number) {
  const yesterday = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  const second =
    weekdayIndex(yesterday) === MONDAY_INDEX ? yesterday - DAY_MS : yesterday;
  const first = second - DAY_MS;
  return {
    first,
    second,
    week: first - weekdayIndex(first) * DAY_MS,
    old: first - OLD_DAYS * DAY_MS,
  };
}

function closeTo(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < NUMBER_TOLERANCE,
    `${actual} is not ${expected}`,
  );
}

async function project(fixture: Fixture, name: string) {
  const human = humanCaller(fixture);
  const created = await human(projectOperations.create, {
    ...EMPTY,
    body: { name },
  });
  await createInstances(fixture, instanceNames(`${name}-${STEPS_BINDING}`, 1));
  await createInstances(
    fixture,
    instanceNames(`${name}-${REVIEWER_BINDING}`, 1),
    InstancePlacement.Server,
    "reviewer@1",
  );
  await human(projectOperations["bindingSet.write"], {
    params: { project_id: created.id },
    query: {},
    body: {
      version: FIRST_BINDING_SET_VERSION,
      bindings: {
        [STEPS_BINDING]: {
          kind: "worker",
          config: {
            worker: "coder@1",
            worker_instances: instanceNames(`${name}-${STEPS_BINDING}`, 1),
            entries: [{ agent: "swe@1", ...CONFIGURATION }],
          },
        },
        [REVIEWER_BINDING]: {
          kind: "worker",
          config: {
            worker: "reviewer@1",
            worker_instances: instanceNames(`${name}-${REVIEWER_BINDING}`, 1),
            entries: [{ agent: "re@1", ...CONFIGURATION }],
          },
        },
      },
    },
  });
  const mission = await human(missionOperations.get, {
    params: { project_id: created.id },
    query: {},
    body: null,
  });
  const worker = async (binding: string): Promise<Worker> => {
    const { token } = await fixture.slotClient(created.id, binding);
    const call = humanCaller({ endpoint: fixture.endpoint, token });
    const registration = await call(workerOperations.register, {
      ...EMPTY,
      body: null,
    });
    assert.equal(
      registration.resource_identity,
      workerResourceIdentity(binding),
    );
    return {
      call,
      runtime_identity: registration.runtime_identity,
      resource_identity: registration.resource_identity,
    };
  };
  return {
    project_id: created.id,
    mission_id: mission.id,
    steps: await worker(STEPS_BINDING),
    reviewer: await worker(REVIEWER_BINDING),
  };
}

type Project = Awaited<ReturnType<typeof project>>;

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    fakeSlots: true,
    scheduler: { stop_backoff: STOP_BACKOFF_SECONDS },
  });
  await enableCoveringAgents({
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  });
  return {
    fixture,
    human: humanCaller(fixture),
    first: await project(fixture, "analytics-first"),
    second: await project(fixture, "analytics-second"),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function operations(h: Harness) {
  const createNode = async (p: Project) => {
    const mission = await h.human(missionOperations.get, {
      params: { project_id: p.project_id },
      query: {},
      body: null,
    });
    const change = await h.human(missionOperations["node.create"], {
      params: { mission_id: p.mission_id },
      query: {},
      body: {
        filename: "examine-1.md",
        content: NODE_CONTENT,
        tasks: [],
        reason: "plan",
        expected_mission_version: mission.version,
      },
    });
    return change.revisions[0]!.node_id;
  };
  const queuedAt = async (p: Project, nodeId: string) => {
    const queue = await h.human(schedulerOperations.queueList, {
      params: { project_id: p.project_id },
      query: {},
      body: null,
    });
    const job = queue.items.find((item) => item.node_id === nodeId);
    assert.ok(job);
    return job.queued_at;
  };
  const claim = async (
    worker: Worker,
    nodeId: string,
  ): Promise<Run | undefined> => {
    const answer = await worker.call(schedulerOperations.workPull, {
      ...EMPTY,
      body: {
        resource_identity: worker.resource_identity,
        runtime_identity: worker.runtime_identity,
      },
    });
    if (answer.kind !== WorkPullKind.Claimed) return undefined;
    assert.equal(answer.execution.node_id, nodeId);
    assert.equal(answer.execution.claim_state, ClaimState.Running);
    return { execution: answer.execution, worker };
  };
  const pull = async (worker: Worker, nodeId: string): Promise<Run> => {
    const run = await claim(worker, nodeId);
    assert.ok(run);
    return run;
  };
  const pullRetry = async (worker: Worker, nodeId: string): Promise<Run> => {
    for (let poll = 0; poll < RETRY_POLL_BOUND; poll++) {
      const run = await claim(worker, nodeId);
      if (run) return run;
      await delay(RETRY_POLL_MS);
    }
    assert.fail("the stopped node never became claimable again");
  };
  const submit = async (run: Run, label: string) => {
    const { execution } = run;
    const submitted = await run.worker.call(
      missionOperations["evidence.submit"],
      {
        params: { node_id: execution.node_id },
        query: {},
        body: {
          execution_id: execution.execution_id,
          attempt: execution.attempt,
          node_revision: execution.pinned_revision,
          subject: label,
          assets: [
            {
              kind: AssetKind.Produced,
              content: {
                media_type: "text/plain",
                encoding: "base64",
                data: Buffer.from(label).toString("base64"),
              },
            },
          ],
        },
      },
    );
    const asset = submitted.evidence.assets[0]!;
    assert.ok(asset.kind === AssetKind.Produced);
    return { id: submitted.evidence.id, address: asset.address };
  };
  const release = (run: Run, furtherWork: boolean, stop: boolean) =>
    run.worker.call(schedulerOperations.executionRelease, {
      params: { execution_id: run.execution.execution_id },
      query: {},
      body: {
        further_work: furtherWork,
        stop: stop
          ? { reason: ExecutionStopReason.OperationFailed, code: null }
          : null,
      },
    });
  const assessNotMet = (
    run: Run,
    evidence: Awaited<ReturnType<typeof submit>>,
  ) =>
    run.worker.call(missionOperations["assessment.submit"], {
      params: { node_id: run.execution.node_id },
      query: {},
      body: {
        execution_id: run.execution.execution_id,
        attempt: run.execution.attempt,
        node_revision: run.execution.pinned_revision,
        evidence_ids: [evidence.id],
        dependency_outcome_ids: [],
        result: AssessmentResult.CriterionNotMet,
        cause: REWORK_CAUSE,
        rationale: "not met",
        tested_input: evidence.address,
      },
    });
  return {
    createNode,
    queuedAt,
    pull,
    pullRetry,
    submit,
    release,
    assessNotMet,
  };
}

function telemetry() {
  let counter = 0;
  const spanId = () => (++counter).toString(16).padStart(16, "0");
  const write = async (run: Run, seeds: readonly SpanSeed[]) => {
    const { execution } = run;
    const records = seeds.map((seed) => {
      const id = spanId();
      return {
        record_id: `${id}:start`,
        trace_id: execution.trace_id,
        kind: RecordKind.Span,
        span_id: id,
        operation: seed.operation,
        parent_span_id: execution.root_span_id,
        start_time: seed.start,
        ...(seed.end === undefined ? {} : { end_time: seed.end }),
        ...(seed.attributes === undefined
          ? {}
          : { attributes: seed.attributes }),
      };
    });
    const acknowledgement = await run.worker.call(
      trackingOperations.telemetryWrite,
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: { records },
      },
    );
    assert.equal(acknowledgement.submitted, seeds.length);
    assert.equal(acknowledgement.stored, seeds.length);
    assert.equal(acknowledgement.refused, NO_REFUSALS);
  };
  return { write };
}

function turn(start: number, usage: Usage): SpanSeed {
  return {
    operation: TURN_OPERATION,
    start,
    end: start + HOUR_MS / HALF_DIVISOR,
    attributes: {
      [RESPONSE_MODEL]: usage.model,
      [INPUT_TOKENS]: usage.input,
      [OUTPUT_TOKENS]: usage.output,
      [CACHE_READ_TOKENS]: usage.cache_read,
      [CACHE_CREATION_TOKENS]: usage.cache_creation,
      [COST]: usage.cost,
    },
  };
}

function reads(h: Harness) {
  const cost = (
    query: z.input<typeof trackingOperations.analyticsCost.input>["query"],
  ) =>
    h.human(trackingOperations.analyticsCost, {
      params: {},
      query,
      body: null,
    });
  const duration = async (
    query: z.input<typeof trackingOperations.analyticsDuration.input>["query"],
  ) => {
    const answer = await h.human(trackingOperations.analyticsDuration, {
      params: {},
      query,
      body: null,
    });
    const items = answer.items.map((item) => {
      assert.ok("p50" in item);
      return item;
    });
    return { ...answer, items };
  };
  const refused = async (path: string, query: Record<string, string>) => {
    const response = await fetch(
      `${h.fixture.endpoint}${path}?${new URLSearchParams(query)}`,
      {
        headers: { authorization: `Bearer ${h.fixture.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: body.error.code };
  };
  return { cost, duration, refused };
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, SINGLE);
  return items[0]!;
}

function keyed<T extends { key: string | null }>(
  items: readonly T[],
  key: string,
): T {
  return only(items.filter((item) => item.key === key));
}

test(
  "Analytics through the composed server",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const h = await setup(t);
    const o = operations(h);
    const r = reads(h);
    const writer = telemetry();
    const dates = datesOfRun(Date.now());
    const modelAUsage: Usage = {
      model: MODEL_A,
      input: 100,
      output: 50,
      cache_read: 10,
      cache_creation: 5,
      cost: 0.5,
    };
    const modelBUsage: Usage = {
      model: MODEL_B,
      input: 200,
      output: 100,
      cache_read: 0,
      cache_creation: 0,
      cost: 1.25,
    };
    const secondNodeUsage: Usage = {
      model: MODEL_A,
      input: 300,
      output: 30,
      cache_read: 0,
      cache_creation: 20,
      cost: 2,
    };
    const oldUsage: Usage = {
      model: MODEL_OLD,
      input: 1,
      output: 1,
      cache_read: 0,
      cache_creation: 0,
      cost: 4,
    };

    const firstNode = await o.createNode(h.first);
    const firstQueuedAt = await o.queuedAt(h.first, firstNode);
    await delay(STEP_GAP_MS);
    const firstSteps = await o.pull(h.first.steps, firstNode);
    await writer.write(firstSteps, [
      turn(dates.first + 10 * HOUR_MS, modelAUsage),
      turn(dates.first + 11 * HOUR_MS, modelBUsage),
      ...TOOL_DURATIONS_MS.map((length): SpanSeed => ({
        operation: TOOL_OPERATION,
        start: dates.first + 12 * HOUR_MS,
        end: dates.first + 12 * HOUR_MS + length,
        attributes: { [TOOL_NAME]: TOOL_BASH },
      })),
    ]);
    const evidence = await o.submit(firstSteps, "first work");
    await o.release(firstSteps, false, false);
    const reviewQueuedAt = await o.queuedAt(h.first, firstNode);
    await delay(STEP_GAP_MS);
    const evaluation = await o.pull(h.first.reviewer, firstNode);
    await o.assessNotMet(evaluation, evidence);
    await delay(STEP_GAP_MS);
    await o.pull(h.first.steps, firstNode);

    const secondNode = await o.createNode(h.second);
    const stoppedSteps = await o.pull(h.second.steps, secondNode);
    await writer.write(stoppedSteps, [
      turn(dates.second + 10 * HOUR_MS, secondNodeUsage),
      turn(dates.old + 10 * HOUR_MS, oldUsage),
      ...VERIFICATION_DURATIONS_MS.map((length): SpanSeed => ({
        operation: VERIFICATION_OPERATION,
        start: dates.second + 12 * HOUR_MS,
        end: dates.second + 12 * HOUR_MS + length,
      })),
    ]);
    await o.release(stoppedSteps, true, true);
    const retrySteps = await o.pullRetry(h.second.steps, secondNode);
    assert.notEqual(
      retrySteps.execution.execution_id,
      stoppedSteps.execution.execution_id,
    );

    await t.test("1 cost by model, node and project", async () => {
      const models = await r.cost({
        from: dates.first,
        group_by: CostGroupBy.Model,
        bucket: AnalyticsBucket.None,
      });
      assert.equal(models.truncated, false);
      assert.equal(models.items.length, DISTINCT_MODELS);
      assert.deepEqual(keyed(models.items, MODEL_A), {
        key: MODEL_A,
        bucket_start: null,
        turn_count: 2,
        input_tokens: 400,
        output_tokens: 80,
        cache_read_tokens: 10,
        cache_creation_tokens: 25,
        total_tokens: 480,
        cost_usd: 2.5,
      });
      assert.deepEqual(keyed(models.items, MODEL_B), {
        key: MODEL_B,
        bucket_start: null,
        turn_count: 1,
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_tokens: 300,
        cost_usd: 1.25,
      });
      const nodes = await r.cost({
        from: dates.first,
        group_by: CostGroupBy.NodeId,
        bucket: AnalyticsBucket.None,
      });
      assert.equal(nodes.items.length, DISTINCT_NODES);
      assert.deepEqual(keyed(nodes.items, firstNode), {
        key: firstNode,
        bucket_start: null,
        turn_count: 2,
        input_tokens: 300,
        output_tokens: 150,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        total_tokens: 450,
        cost_usd: 1.75,
      });
      const secondNodeItem = keyed(nodes.items, secondNode);
      assert.equal(secondNodeItem.turn_count, SINGLE);
      assert.equal(secondNodeItem.total_tokens, SECOND_NODE_TOTAL_TOKENS);
      assert.equal(secondNodeItem.cost_usd, SECOND_NODE_COST);
      const project = await r.cost({
        from: dates.first,
        project_id: h.second.project_id,
        group_by: CostGroupBy.ProjectId,
        bucket: AnalyticsBucket.None,
      });
      assert.deepEqual(only(project.items), {
        key: h.second.project_id,
        bucket_start: null,
        turn_count: 1,
        input_tokens: 300,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_creation_tokens: 20,
        total_tokens: 330,
        cost_usd: 2,
      });
      const projectModels = await r.cost({
        from: dates.first,
        project_id: h.first.project_id,
        group_by: CostGroupBy.Model,
        bucket: AnalyticsBucket.None,
      });
      assert.deepEqual(projectModels.items.map((item) => item.key).sort(), [
        MODEL_A,
        MODEL_B,
      ]);
      assert.equal(
        keyed(projectModels.items, MODEL_A).cost_usd,
        MODEL_A_FIRST_NODE_COST,
      );
      const node = await r.cost({
        from: dates.first,
        node_id: secondNode,
        group_by: CostGroupBy.None,
        bucket: AnalyticsBucket.None,
      });
      assert.equal(only(node.items).total_tokens, SECOND_NODE_TOTAL_TOKENS);
    });

    await t.test("2 buckets by day and by week", async () => {
      const days = await r.cost({
        from: dates.first,
        group_by: CostGroupBy.None,
        bucket: AnalyticsBucket.Day,
      });
      assert.equal(days.items.length, DISTINCT_DAYS);
      assert.deepEqual(
        days.items.map((item) => [item.bucket_start, item.turn_count]),
        [
          [dates.first, 2],
          [dates.second, 1],
        ],
      );
      const weeks = await r.cost({
        from: dates.first,
        group_by: CostGroupBy.None,
        bucket: AnalyticsBucket.Week,
      });
      const week = only(weeks.items);
      assert.equal(week.bucket_start, dates.week);
      assert.equal(week.turn_count, WEEK_TURNS);
      assert.equal(week.cost_usd, WEEK_COST);
    });

    await t.test("3 tool latency", async () => {
      const latency = await r.duration({
        from: dates.first,
        measure: AnalyticsMeasure.ToolLatency,
        group_by: DurationGroupBy.ToolName,
      });
      const item = only(latency.items);
      assert.equal(item.key, TOOL_BASH);
      assert.equal(item.count, TOOL_DURATIONS_MS.length);
      closeTo(item.p50, 55);
      closeTo(item.p90, 91);
      closeTo(item.p99, 99.1);
      closeTo(item.mean, 55);
      assert.equal(item.max, TOOL_MAX_MS);
    });

    await t.test("4 verification time", async () => {
      const verification = await r.duration({
        from: dates.first,
        measure: AnalyticsMeasure.VerificationTime,
      });
      const item = only(verification.items);
      assert.equal(item.count, VERIFICATION_DURATIONS_MS.length);
      assert.equal(item.max, VERIFICATION_MAX_MS);
    });

    await t.test("5 queue wait and review wait", async () => {
      const windowOf = (run: Run) => ({
        from: run.execution.created_at,
        to: run.execution.created_at,
        node_id: run.execution.node_id,
      });
      const queue = await r.duration({
        ...windowOf(firstSteps),
        measure: AnalyticsMeasure.QueueWait,
      });
      const queueWait = only(queue.items);
      assert.equal(queueWait.count, SINGLE);
      assert.ok(
        Math.abs(
          queueWait.max - (firstSteps.execution.created_at - firstQueuedAt),
        ) < WAIT_TOLERANCE_MS,
      );
      const review = await r.duration({
        ...windowOf(evaluation),
        measure: AnalyticsMeasure.ReviewWait,
      });
      const reviewWait = only(review.items);
      assert.equal(reviewWait.count, SINGLE);
      assert.ok(
        Math.abs(
          reviewWait.max - (evaluation.execution.created_at - reviewQueuedAt),
        ) < WAIT_TOLERANCE_MS,
      );
    });

    await t.test("6 revision turns", async () => {
      const turns = await r.duration({
        from: dates.first,
        measure: AnalyticsMeasure.RevisionTurns,
        group_by: DurationGroupBy.NodeId,
      });
      const revised = keyed(turns.items, firstNode);
      assert.equal(revised.count, SINGLE);
      assert.equal(revised.max, SINGLE);
      const stopped = keyed(turns.items, secondNode);
      assert.equal(stopped.count, SINGLE);
      assert.equal(stopped.max, NO_REVISIONS);
      const all = await r.duration({
        from: dates.first,
        measure: AnalyticsMeasure.RevisionTurns,
      });
      assert.equal(only(all.items).max, SINGLE);
    });

    await t.test("7 defaults and refusals", async () => {
      const defaults = await r.cost({});
      assert.equal(defaults.truncated, false);
      const explicit = await r.cost({
        from: dates.first,
        group_by: CostGroupBy.Model,
        bucket: AnalyticsBucket.Day,
      });
      assert.deepEqual(defaults, explicit);
      assert.deepEqual(
        defaults.items.map((item) => item.bucket_start),
        [dates.first, dates.first, dates.second],
      );
      assert.equal(
        defaults.items.some((item) => item.key === MODEL_OLD),
        false,
      );
      const widened = await r.cost({
        from: dates.old,
        group_by: CostGroupBy.Model,
        bucket: AnalyticsBucket.Day,
      });
      assert.equal(
        widened.items.some((item) => item.key === MODEL_OLD),
        true,
      );
      assert.deepEqual(await r.refused(DURATION_PATH, { measure: "bogus" }), {
        status: BAD_REQUEST,
        code: VALIDATION_FAILED,
      });
      assert.deepEqual(
        await r.refused(DURATION_PATH, {
          measure: AnalyticsMeasure.FloorShare,
          group_by: DurationGroupBy.WorkerInstance,
        }),
        { status: BAD_REQUEST, code: VALIDATION_FAILED },
      );
      const longRange = { from: "0", to: String(32 * DAY_MS) };
      assert.deepEqual(await r.refused(COST_PATH, longRange), {
        status: BAD_REQUEST,
        code: RANGE_INVALID,
      });
      assert.deepEqual(
        await r.refused(DURATION_PATH, {
          ...longRange,
          measure: AnalyticsMeasure.ToolLatency,
        }),
        { status: BAD_REQUEST, code: RANGE_INVALID },
      );
    });
  },
);

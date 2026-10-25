import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import {
  AssessmentResult,
  AssetKind,
  Intent,
  NodeState,
  ResumeTarget,
  missionOperations,
} from "../../mission/contract.ts";
import {
  projectOperations,
  workerResourceIdentity,
} from "../../project/contract.ts";
import {
  ClaimState,
  WorkPullKind,
  schedulerOperations,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  ExecutionKind,
  TRANSITION_SPAN_OPERATION,
  TimelineDepth,
  trackingOperations,
  type TraceSummary,
} from "../../tracking/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
} from "./test-support.ts";

const JOURNEY_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 30000;
const STOP_BACKOFF_SECONDS = 1;
const STEP_GAP_MS = 5;
const FIRST_BINDING_SET_VERSION = 1;
const SINGLE = 1;
const NO_TRACES = 0;
const EXECUTION_TRACES = 3;
const ACT_TRACES = 2;
const PAGE_SIZE = 3;
const PAGE_BOUND = 50;
const BAD_REQUEST = 400;
const STEPS_BINDING = "steps";
const REVIEWER_BINDING = "reviewer";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
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
const PAUSE_REASON = "hold the node for a human look";
const KIND_ATTRIBUTE = "kanthord.execution.kind";
const WAIT_ATTRIBUTE = "kanthord.queue.wait_ms";
const NUMBER_TYPE = "number";
const TIMELINE_PATH = "/api/tracking/timeline";

type Caller = ReturnType<typeof humanCaller>;
interface Worker {
  call: Caller;
  runtime_identity: string;
  resource_identity: string;
  worker_name: string;
  kind: ExecutionKind;
}
interface Run {
  execution: ExecutionRecord;
  worker: Worker;
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    fakeSlots: true,
    scheduler: { stop_backoff: STOP_BACKOFF_SECONDS },
  });
  await enableCoveringAgents({
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  });
  const human = humanCaller(fixture);
  const project = await human(projectOperations.create, {
    ...EMPTY,
    body: { name: "timeline" },
  });
  await human(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: {
      version: FIRST_BINDING_SET_VERSION,
      bindings: {
        [STEPS_BINDING]: {
          kind: "worker",
          config: {
            worker: "coder@1",
            placement: "server",
            instance_count: 1,
            entries: [{ agent: "swe@1", ...CONFIGURATION }],
          },
        },
        [REVIEWER_BINDING]: {
          kind: "worker",
          config: {
            worker: "reviewer@1",
            placement: "server",
            instance_count: 1,
            entries: [{ agent: "re@1", ...CONFIGURATION }],
          },
        },
      },
    },
  });
  const mission = await human(missionOperations.get, {
    params: { project_id: project.id },
    query: {},
    body: null,
  });
  const worker = async (
    binding: string,
    kind: ExecutionKind,
  ): Promise<Worker> => {
    const { token } = await fixture.slotClient(project.id, binding);
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
      worker_name: registration.worker_name,
      kind,
    };
  };
  return {
    fixture,
    human,
    project_id: project.id,
    mission_id: mission.id,
    steps: await worker(STEPS_BINDING, ExecutionKind.Steps),
    reviewer: await worker(REVIEWER_BINDING, ExecutionKind.Evaluation),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function operations(h: Harness) {
  const missionVersion = async () =>
    (
      await h.human(missionOperations.get, {
        params: { project_id: h.project_id },
        query: {},
        body: null,
      })
    ).version;
  const createNode = async () => {
    const change = await h.human(missionOperations["node.create"], {
      params: { mission_id: h.mission_id },
      query: {},
      body: {
        filename: "examine-1.md",
        content: NODE_CONTENT,
        tasks: [],
        reason: "plan",
        expected_mission_version: await missionVersion(),
      },
    });
    return change.revisions[0]!.node_id;
  };
  const node = async (nodeId: string) => {
    const answer = await h.human(missionOperations["node.get"], {
      params: { node_id: nodeId },
      query: {},
      body: null,
    });
    assert.ok("state" in answer);
    return answer;
  };
  const act = async (state: string, nodeId: string) => {
    const current = await node(nodeId);
    assert.equal(current.state, state);
    return {
      reason: PAUSE_REASON,
      expected_mission_version: await missionVersion(),
      expected_state: current.state,
      expected_attempt: current.attempt,
    };
  };
  const pull = async (worker: Worker, nodeId: string): Promise<Run> => {
    const answer = await worker.call(schedulerOperations.workPull, {
      ...EMPTY,
      body: {
        resource_identity: worker.resource_identity,
        runtime_identity: worker.runtime_identity,
      },
    });
    assert.equal(answer.kind, WorkPullKind.Claimed);
    assert.equal(answer.execution.node_id, nodeId);
    assert.equal(answer.execution.claim_state, ClaimState.Running);
    return { execution: answer.execution, worker };
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
  const releaseSteps = (run: Run) =>
    run.worker.call(schedulerOperations.executionRelease, {
      params: { execution_id: run.execution.execution_id },
      query: {},
      body: { further_work: false, stop: null },
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
        rationale: "not met",
        tested_input: evidence.address,
      },
    });
  return {
    createNode,
    node,
    act,
    pull,
    submit,
    releaseSteps,
    assessNotMet,
    missionVersion,
  };
}

async function drive(h: Harness, nodeId: string) {
  const o = operations(h);
  const firstSteps = await o.pull(h.steps, nodeId);
  const evidence = await o.submit(firstSteps, "first work");
  await o.releaseSteps(firstSteps);
  await delay(STEP_GAP_MS);
  const evaluation = await o.pull(h.reviewer, nodeId);
  await o.assessNotMet(evaluation, evidence);
  assert.equal((await o.node(nodeId)).state, NodeState.Available);
  await delay(STEP_GAP_MS);
  const secondSteps = await o.pull(h.steps, nodeId);
  await delay(STEP_GAP_MS);
  await h.human(missionOperations["node.pause"], {
    params: { node_id: nodeId },
    query: {},
    body: await o.act(NodeState.Executing, nodeId),
  });
  assert.equal((await o.node(nodeId)).state, NodeState.Paused);
  await delay(STEP_GAP_MS);
  await h.human(missionOperations["node.resume"], {
    params: { node_id: nodeId },
    query: {},
    body: {
      ...(await o.act(NodeState.Paused, nodeId)),
      target: ResumeTarget.Available,
    },
  });
  assert.equal((await o.node(nodeId)).state, NodeState.Available);
  return { firstSteps, evaluation, secondSteps };
}

function reads(h: Harness) {
  const traces = async (nodeId: string) =>
    (
      await h.human(trackingOperations.traceList, {
        params: {},
        query: { node_id: nodeId },
        body: null,
      })
    ).items;
  const spans = async (traceId: string) =>
    (
      await h.human(trackingOperations.spanList, {
        params: { trace_id: traceId },
        query: {},
        body: null,
      })
    ).items;
  const timeline = async (
    query: z.input<typeof trackingOperations.timelineList.input>["query"],
  ) =>
    h.human(trackingOperations.timelineList, {
      params: {},
      query,
      body: null,
    });
  const refused = async (query: Record<string, string>) => {
    const response = await fetch(
      `${h.fixture.endpoint}${TIMELINE_PATH}?${new URLSearchParams(query)}`,
      {
        headers: { authorization: `Bearer ${h.fixture.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: body.error.code };
  };
  return { traces, spans, timeline, refused };
}

function traceTime(summary: TraceSummary): number {
  return summary.started_at ?? summary.created_at;
}

function byTraceStart(left: TraceSummary, right: TraceSummary): number {
  return (
    traceTime(left) - traceTime(right) ||
    (left.trace_id < right.trace_id ? -1 : 1)
  );
}

function itemKey(item: { trace_id: string; span_id: string }): string {
  return `${item.trace_id}:${item.span_id}`;
}

test(
  "Timeline of a node and of a project through the composed server",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const h = await setup(t);
    const o = operations(h);
    const r = reads(h);
    const nodeId = await o.createNode();
    const runs = await drive(h, nodeId);
    const summaries = (await r.traces(nodeId)).sort(byTraceStart);
    const spansOf = new Map(
      await Promise.all(
        summaries.map(
          async (summary) =>
            [summary.trace_id, await r.spans(summary.trace_id)] as const,
        ),
      ),
    );
    const rootOf = (summary: TraceSummary) => {
      const root = spansOf
        .get(summary.trace_id)!
        .find((span) => span.span_id === summary.root_span_id);
      assert.ok(root);
      return root;
    };
    const summaryOf = (run: Run) => {
      const found = summaries.filter(
        (summary) => summary.execution_id === run.execution.execution_id,
      );
      assert.equal(found.length, SINGLE);
      return found[0]!;
    };
    const expectedKeys = (kept: TraceSummary[], depth: number) =>
      kept.flatMap((summary) => {
        const all = spansOf.get(summary.trace_id)!;
        const root = rootOf(summary);
        const children = all
          .filter(
            (span) =>
              depth === TimelineDepth.Child &&
              span.parent_span_id === root.span_id,
          )
          .sort(
            (left, right) =>
              (left.start_time ?? left.end_time ?? 0) -
                (right.start_time ?? right.end_time ?? 0) ||
              (left.span_id < right.span_id ? -1 : 1),
          );
        return [root, ...children].map(itemKey);
      });
    const executionSummaries = summaries.filter(
      (summary) => summary.execution_id !== null,
    );
    const actSummaries = summaries.filter(
      (summary) => summary.execution_id === null,
    );
    assert.equal(executionSummaries.length, EXECUTION_TRACES);
    assert.equal(actSummaries.length, ACT_TRACES);

    await t.test("1 node scope, depth 1", async () => {
      const page = await r.timeline({
        node_id: nodeId,
        depth: TimelineDepth.Root,
      });
      assert.equal(page.next_cursor, null);
      assert.deepEqual(
        page.items.map(itemKey),
        expectedKeys(summaries, TimelineDepth.Root),
      );
      assert.deepEqual(
        page.items.map((item) => item.trace_id),
        summaries.map((summary) => summary.trace_id),
      );
      for (const item of page.items) {
        assert.equal(item.depth, TimelineDepth.Root);
        assert.equal(item.parent_span_id, null);
        assert.equal(item.node_id, nodeId);
        assert.equal(item.project_id, h.project_id);
      }
      const rootStarts = page.items.map(
        (item) => item.start_time ?? item.end_time ?? 0,
      );
      assert.deepEqual(
        rootStarts,
        [...rootStarts].sort((left, right) => left - right),
      );
      const workers = [
        [runs.firstSteps, h.steps, ExecutionKind.Steps],
        [runs.evaluation, h.reviewer, ExecutionKind.Evaluation],
        [runs.secondSteps, h.steps, ExecutionKind.Steps],
      ] as const;
      for (const [run, worker, kind] of workers) {
        const summary = summaryOf(run);
        const item = page.items.find(
          (entry) => entry.trace_id === summary.trace_id,
        );
        assert.ok(item);
        assert.equal(item.execution_id, run.execution.execution_id);
        assert.equal(item.worker_name, worker.worker_name);
        assert.equal(item.attributes[KIND_ATTRIBUTE], kind);
        assert.equal(typeof item.attributes[WAIT_ATTRIBUTE], NUMBER_TYPE);
      }
      for (const summary of actSummaries) {
        const item = page.items.find(
          (entry) => entry.trace_id === summary.trace_id,
        );
        assert.ok(item);
        assert.equal(item.execution_id, null);
        assert.equal(item.worker_name, null);
      }
    });

    await t.test("2 node scope, depth 2, paged", async () => {
      const full = await r.timeline({ node_id: nodeId });
      assert.equal(full.next_cursor, null);
      const expected = expectedKeys(summaries, TimelineDepth.Child);
      assert.deepEqual(full.items.map(itemKey), expected);
      assert.ok(
        full.items.some(
          (item) =>
            item.depth === TimelineDepth.Child &&
            item.operation === TRANSITION_SPAN_OPERATION,
        ),
      );
      for (const item of full.items) {
        if (item.depth === TimelineDepth.Child)
          assert.equal(item.worker_name, null);
      }
      const traceOrder = full.items
        .map((item) => item.trace_id)
        .filter((id, index, ids) => ids.indexOf(id) === index);
      assert.deepEqual(
        traceOrder,
        summaries.map((summary) => summary.trace_id),
      );
      for (const traceId of traceOrder) {
        const own = full.items.filter((item) => item.trace_id === traceId);
        assert.equal(own[0]!.depth, TimelineDepth.Root);
        assert.equal(
          own.filter((item) => item.depth === TimelineDepth.Root).length,
          SINGLE,
        );
      }

      const walked: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < PAGE_BOUND; pages++) {
        const page: Awaited<ReturnType<typeof r.timeline>> = await r.timeline({
          node_id: nodeId,
          limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        assert.ok(page.items.length <= PAGE_SIZE);
        walked.push(...page.items.map(itemKey));
        cursor = page.next_cursor;
        if (cursor === null) break;
      }
      assert.equal(cursor, null);
      assert.equal(new Set(walked).size, walked.length);
      assert.deepEqual(walked, expected);
    });

    await t.test("3 window", async () => {
      const first = summaryOf(runs.firstSteps);
      assert.notEqual(first.ended_at, null);
      const from = first.ended_at! + SINGLE;
      const page = await r.timeline({ project_id: h.project_id, from });
      const ids = new Set(page.items.map((item) => item.trace_id));
      assert.equal(ids.has(first.trace_id), false);
      const kept = summaries.filter(
        (summary) => summary.ended_at === null || summary.ended_at >= from,
      );
      assert.ok(kept.length > NO_TRACES);
      assert.ok(kept.length < summaries.length);
      assert.deepEqual(
        page.items.map(itemKey),
        expectedKeys(kept, TimelineDepth.Child),
      );
      for (const summary of kept) assert.equal(ids.has(summary.trace_id), true);
    });

    await t.test("4 execution scope", async () => {
      const summary = summaryOf(runs.firstSteps);
      const page = await r.timeline({
        execution_id: runs.firstSteps.execution.execution_id,
      });
      assert.equal(page.next_cursor, null);
      assert.deepEqual(
        page.items.map(itemKey),
        expectedKeys([summary], TimelineDepth.Child),
      );
      assert.ok(page.items.length > SINGLE);
      for (const item of page.items) {
        assert.equal(item.trace_id, summary.trace_id);
        assert.equal(item.execution_id, runs.firstSteps.execution.execution_id);
      }
    });

    await t.test("5 refusals", async () => {
      assert.deepEqual(await r.refused({}), {
        status: BAD_REQUEST,
        code: VALIDATION_FAILED,
      });
      assert.deepEqual(
        await r.refused({ node_id: nodeId, project_id: h.project_id }),
        { status: BAD_REQUEST, code: VALIDATION_FAILED },
      );
      assert.deepEqual(
        await r.refused({ node_id: nodeId, cursor: "invalid" }),
        { status: BAD_REQUEST, code: CURSOR_INVALID },
      );
      const traceCursor = (
        await h.human(trackingOperations.traceList, {
          params: {},
          query: { node_id: nodeId, limit: SINGLE },
          body: null,
        })
      ).next_cursor;
      assert.ok(traceCursor);
      assert.deepEqual(
        await r.refused({ node_id: nodeId, cursor: traceCursor }),
        { status: BAD_REQUEST, code: CURSOR_INVALID },
      );
    });
  },
);

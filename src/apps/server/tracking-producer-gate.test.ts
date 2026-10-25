import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AssessmentResult,
  AssetKind,
  Intent,
  NodeState,
  missionOperations,
} from "../../mission/contract.ts";
import {
  projectOperations,
  workerResourceIdentity,
} from "../../project/contract.ts";
import {
  ClaimState,
  ExecutionStopReason,
  WorkPullKind,
  schedulerOperations,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import {
  ExecutionEnd,
  ExecutionKind,
  RevokeCause,
  SpanStatus,
  TRANSITION_SPAN_OPERATION,
  TraceState,
  TransitionRule,
  trackingOperations,
  type Span,
  type TraceSummary,
} from "../../tracking/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
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
const STOP_BACKOFF_SECONDS = 1;
const ACT_GAP_MS = 2;
const FIRST_BINDING_SET_VERSION = 1;
const SINGLE = 1;
const NO_WAIT = 0;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const FAILURE_LIMIT = 3;
const REWORK_LIMIT = 2;
const STEPS_BINDING = "steps";
const REVIEWER_BINDING = "reviewer";
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
const WORKER_ATTRIBUTE = "kanthord.worker.name";
const WAIT_ATTRIBUTE = "kanthord.queue.wait_ms";
const END_ATTRIBUTE = "kanthord.execution.end";
const CAUSE_ATTRIBUTE = "kanthord.revoke.cause";
const FROM_ATTRIBUTE = "kanthord.node.state.from";
const TO_ATTRIBUTE = "kanthord.node.state.to";
const RULE_ATTRIBUTE = "kanthord.transition.rule";
const COUNT_ATTRIBUTE = "kanthord.transition.count";
const LIMIT_ATTRIBUTE = "kanthord.transition.limit";
const NODE_ATTRIBUTE = "kanthord.node.id";
const ATTEMPT_ATTRIBUTE = "kanthord.attempt";
const NUMBER_TYPE = "number";
const Act = {
  Pause: missionOperations["node.pause"].id,
  Block: missionOperations["node.block"].id,
  Unblock: missionOperations["node.unblock"].id,
} as const;
const ActAttribute = {
  NodeId: NODE_ATTRIBUTE,
  Attempt: ATTEMPT_ATTRIBUTE,
  StateFrom: FROM_ATTRIBUTE,
  StateTo: TO_ATTRIBUTE,
} as const;

type Caller = ReturnType<typeof humanCaller>;
interface Worker {
  call: Caller;
  runtime_identity: string;
  resource_identity: string;
  worker_name: string;
  kind: ExecutionKind;
}
interface Evidence {
  id: string;
  address: { kind: typeof AssetKind.Produced; sha256: string };
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
    body: { name: "tracking" },
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
    human,
    project_id: project.id,
    mission_id: mission.id,
    steps: await worker(STEPS_BINDING, ExecutionKind.Steps),
    reviewer: await worker(REVIEWER_BINDING, ExecutionKind.Evaluation),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function numberOf(span: Span, name: string): number {
  const value = span.attributes[name];
  assert.equal(typeof value, NUMBER_TYPE, name);
  return value as number;
}

function operations(h: Harness) {
  const missionVersion = async () =>
    (
      await h.human(missionOperations.get, {
        params: { project_id: h.project_id },
        query: {},
        body: null,
      })
    ).version;
  const createNode = async (filename: string) => {
    const change = await h.human(missionOperations["node.create"], {
      params: { mission_id: h.mission_id },
      query: {},
      body: {
        filename,
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
  const act = async (state: string, nodeId: string, reason: string) => {
    const current = await node(nodeId);
    assert.equal(current.state, state);
    return {
      reason,
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
  const submit = async (run: Run, label: string): Promise<Evidence> => {
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
  const release = (run: Run, furtherWork: boolean, stop = false) =>
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
  const assessNotMet = (run: Run, evidence: Evidence) =>
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
  const review = async (nodeId: string, label: string) => {
    const steps = await pull(h.steps, nodeId);
    const evidence = await submit(steps, label);
    await release(steps, false);
    const evaluation = await pull(h.reviewer, nodeId);
    const answer = await assessNotMet(evaluation, evidence);
    return { steps, evaluation, answer };
  };
  const traces = async (nodeId: string, state?: TraceState) =>
    (
      await h.human(trackingOperations.traceList, {
        params: {},
        query: { node_id: nodeId, ...(state ? { state } : {}) },
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
  const text = (traceId: string, textId: string) =>
    h.human(trackingOperations.textGet, {
      params: { trace_id: traceId, text_id: textId },
      query: {},
      body: null,
    });
  const executionTrace = async (run: Run) => {
    const [summary, ...rest] = (
      await h.human(trackingOperations.traceList, {
        params: {},
        query: { execution_id: run.execution.execution_id },
        body: null,
      })
    ).items;
    assert.ok(summary);
    assert.deepEqual(rest, []);
    const all = await spans(summary.trace_id);
    const root = all.find((span) => span.parent_span_id === null);
    assert.ok(root);
    return {
      summary,
      root,
      transitions: all.filter(
        (span) => span.operation === TRANSITION_SPAN_OPERATION,
      ),
    };
  };
  const actTraces = async (nodeId: string) => {
    const found: { summary: TraceSummary; root: Span }[] = [];
    const items = (await traces(nodeId)).filter(
      (summary) => summary.execution_id === null,
    );
    for (const summary of items) {
      const root = (await spans(summary.trace_id)).find(
        (span) => span.parent_span_id === null,
      );
      assert.ok(root);
      found.push({ summary, root });
    }
    return found.sort(
      (left, right) =>
        (left.summary.started_at ?? 0) - (right.summary.started_at ?? 0),
    );
  };
  return {
    missionVersion,
    createNode,
    node,
    act,
    pull,
    submit,
    release,
    review,
    traces,
    text,
    executionTrace,
    actTraces,
  };
}

function assertTransition(
  transitions: Span[],
  expected: { from: string; to: string; rule: string },
  counted?: { count: number; limit: number },
) {
  assert.equal(transitions.length, SINGLE);
  const attributes = transitions[0]!.attributes;
  assert.equal(attributes[FROM_ATTRIBUTE], expected.from);
  assert.equal(attributes[TO_ATTRIBUTE], expected.to);
  assert.equal(attributes[RULE_ATTRIBUTE], expected.rule);
  assert.equal(
    attributes[COUNT_ATTRIBUTE],
    counted === undefined ? undefined : counted.count,
  );
  assert.equal(
    attributes[LIMIT_ATTRIBUTE],
    counted === undefined ? undefined : counted.limit,
  );
}

test(
  "Execution traces, transitions and act traces through the composed server",
  { timeout: JOURNEY_TIMEOUT_MS },
  async (t) => {
    const h = await setup(t);
    const o = operations(h);
    const nodeId = await o.createNode("examine-1.md");
    const runs: Run[] = [];
    let reviewed!: Awaited<ReturnType<typeof o.review>>;
    let paused!: Run;
    const failed: Run[] = [];

    const assertReviewNotPassed = async () => {
      const steps = await o.executionTrace(reviewed.steps);
      assert.equal(steps.summary.state, TraceState.Ok);
      assertTransition(steps.transitions, {
        from: NodeState.Executing,
        to: NodeState.Waiting,
        rule: TransitionRule.None,
      });
      const evaluation = await o.executionTrace(reviewed.evaluation);
      assert.equal(evaluation.summary.state, TraceState.Ok);
      assert.equal(evaluation.root.status, SpanStatus.Ok);
      assert.equal(
        evaluation.root.attributes[END_ATTRIBUTE],
        ExecutionEnd.Revoked,
      );
      assert.equal(
        evaluation.root.attributes[CAUSE_ATTRIBUTE],
        RevokeCause.Assessment,
      );
      assertTransition(evaluation.transitions, {
        from: NodeState.Evaluating,
        to: NodeState.Available,
        rule: TransitionRule.None,
      });
    };

    const assertPause = async () => {
      const trace = await o.executionTrace(paused);
      assert.equal(trace.summary.state, TraceState.Error);
      assert.equal(trace.summary.stop_reason, null);
      assert.equal(trace.root.attributes[END_ATTRIBUTE], ExecutionEnd.Revoked);
      assert.equal(trace.root.attributes[CAUSE_ATTRIBUTE], RevokeCause.Human);
      assert.deepEqual(trace.transitions, []);
      const acts = (await o.actTraces(nodeId)).filter(
        (act) => act.root.operation === Act.Pause,
      );
      assert.equal(acts.length, SINGLE);
      const { summary, root } = acts[0]!;
      assert.equal(summary.node_id, nodeId);
      assert.equal(root.attributes[ActAttribute.NodeId], nodeId);
      assert.equal(
        root.attributes[ActAttribute.StateFrom],
        NodeState.Executing,
      );
      assert.equal(root.attributes[ActAttribute.StateTo], NodeState.Paused);
      assert.deepEqual(root.links, [
        { trace_id: trace.summary.trace_id, span_id: trace.root.span_id },
      ]);
      assert.equal(root.text_ids.length, SINGLE);
      const reason = await o.text(summary.trace_id, root.text_ids[0]!);
      assert.equal(reason.content, PAUSE_REASON);
    };

    const assertRedirect = async () => {
      const acts = await o.actTraces(nodeId);
      assert.deepEqual(
        acts.map((act) => act.root.operation),
        [Act.Pause, Act.Block, Act.Unblock],
      );
      const [, block, unblock] = acts;
      assert.equal(
        block!.root.attributes[ActAttribute.StateFrom],
        NodeState.Paused,
      );
      assert.equal(
        block!.root.attributes[ActAttribute.StateTo],
        NodeState.Blocked,
      );
      assert.equal(block!.root.attributes[ActAttribute.Attempt], FIRST_ATTEMPT);
      assert.equal(
        unblock!.root.attributes[ActAttribute.StateFrom],
        NodeState.Blocked,
      );
      assert.equal(
        unblock!.root.attributes[ActAttribute.StateTo],
        NodeState.Available,
      );
      assert.equal(
        unblock!.root.attributes[ActAttribute.Attempt],
        SECOND_ATTEMPT,
      );
      assert.equal(unblock!.summary.attempt, SECOND_ATTEMPT);
    };

    const assertFailureLimit = async () => {
      assert.equal(failed.length, FAILURE_LIMIT);
      for (const run of failed.slice(0, FAILURE_LIMIT - SINGLE)) {
        const trace = await o.executionTrace(run);
        assertTransition(trace.transitions, {
          from: NodeState.Executing,
          to: NodeState.Available,
          rule: TransitionRule.None,
        });
      }
      const last = await o.executionTrace(failed[FAILURE_LIMIT - SINGLE]!);
      assertTransition(
        last.transitions,
        {
          from: NodeState.Executing,
          to: NodeState.Paused,
          rule: TransitionRule.FailureLimit,
        },
        { count: FAILURE_LIMIT, limit: FAILURE_LIMIT },
      );
    };

    const assertKindWorkerWait = async (group: Run[], id: string) => {
      for (const run of group) {
        const trace = await o.executionTrace(run);
        assert.equal(trace.root.attributes[KIND_ATTRIBUTE], run.worker.kind);
        assert.equal(
          trace.root.attributes[WORKER_ATTRIBUTE],
          run.worker.worker_name,
        );
        assert.ok(numberOf(trace.root, WAIT_ATTRIBUTE) >= NO_WAIT);
        assert.equal(trace.summary.worker_name, run.worker.worker_name);
        assert.equal(trace.summary.node_id, id);
      }
    };

    const assertNoOpenTrace = async (id: string) => {
      assert.deepEqual(await o.traces(id, TraceState.Open), []);
    };

    await t.test("1 review not passed", async () => {
      reviewed = await o.review(nodeId, "first work");
      assert.equal((await o.node(nodeId)).state, NodeState.Available);
      runs.push(reviewed.steps, reviewed.evaluation);
      await assertReviewNotPassed();
    });

    await t.test("2 pause", async () => {
      paused = await o.pull(h.steps, nodeId);
      runs.push(paused);
      await h.human(missionOperations["node.pause"], {
        params: { node_id: nodeId },
        query: {},
        body: await o.act(NodeState.Executing, nodeId, PAUSE_REASON),
      });
      assert.equal((await o.node(nodeId)).state, NodeState.Paused);
      await assertPause();
    });

    await t.test("3 redirect", async () => {
      await delay(ACT_GAP_MS);
      await h.human(missionOperations["node.block"], {
        params: { node_id: nodeId },
        query: {},
        body: await o.act(NodeState.Paused, nodeId, "block it"),
      });
      await delay(ACT_GAP_MS);
      const blocked = await o.node(nodeId);
      assert.equal(blocked.state, NodeState.Blocked);
      await h.human(missionOperations["node.unblock"], {
        params: { node_id: nodeId },
        query: {},
        body: {
          blocked_attempt: blocked.attempt!,
          expected_revision: blocked.visible_revision,
          expected_mission_version: await o.missionVersion(),
        },
      });
      const reopened = await o.node(nodeId);
      assert.equal(reopened.state, NodeState.Available);
      assert.equal(reopened.attempt, SECOND_ATTEMPT);
      await assertRedirect();
    });

    await t.test("4 failure limit", async () => {
      for (let index = 0; index < FAILURE_LIMIT; index++) {
        const run = await o.pull(h.steps, nodeId);
        await o.release(run, true, true);
        failed.push(run);
      }
      runs.push(...failed);
      assert.equal((await o.node(nodeId)).state, NodeState.Paused);
      await assertFailureLimit();
    });

    await t.test("5 kind, worker and wait", async () => {
      await assertKindWorkerWait(runs, nodeId);
    });

    await t.test("6 no open trace", async () => {
      await assertNoOpenTrace(nodeId);
    });

    await t.test("7 rework limit", async () => {
      const secondId = await o.createNode("examine-2.md");
      const secondRuns: Run[] = [];
      for (let rework = 0; rework < REWORK_LIMIT; rework++) {
        const round = await o.review(secondId, `second work ${rework}`);
        secondRuns.push(round.steps, round.evaluation);
        assert.equal((await o.node(secondId)).state, NodeState.Available);
        const trace = await o.executionTrace(round.evaluation);
        assertTransition(trace.transitions, {
          from: NodeState.Evaluating,
          to: NodeState.Available,
          rule: TransitionRule.None,
        });
      }
      const third = await o.review(secondId, "second work last");
      secondRuns.push(third.steps, third.evaluation);
      assert.equal((await o.node(secondId)).state, NodeState.Blocked);
      const trace = await o.executionTrace(third.evaluation);
      assertTransition(
        trace.transitions,
        {
          from: NodeState.Evaluating,
          to: NodeState.Blocked,
          rule: TransitionRule.ReworkLimit,
        },
        { count: REWORK_LIMIT, limit: REWORK_LIMIT },
      );
      await assertKindWorkerWait(secondRuns, secondId);
      await assertNoOpenTrace(secondId);
      await assertReviewNotPassed();
      await assertPause();
      await assertRedirect();
      await assertFailureLimit();
      await assertKindWorkerWait(runs, nodeId);
      await assertNoOpenTrace(nodeId);
    });
  },
);

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import { ZodError } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  type AssessmentSubmit,
  AssetKind,
  ClosingEvent,
  FindingAction,
  FindingCauseOwner,
  FindingDecision,
  FindingKind,
  FindingRoute,
  FindingStatus,
  Intent,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  RepositoryLanding,
  RevokeCause,
  type RevokedExecution,
  TransitionRule,
} from "./contract.ts";
import {
  closeAttempt,
  deleteEvidence,
  insertAssessment,
  insertOutcome,
  listAssessments,
  openAttempt,
  readAssessment,
  readEvidence,
  readOpenAttempt,
  readOutcomesOfAttempt,
} from "./record-store.ts";
import {
  insertDependency,
  insertNode,
  insertRevision,
  setNodeState,
} from "./store.ts";
import { getRevision } from "./node-read.ts";
import { insertFinding } from "./finding-store.ts";
import { landsByHuman } from "./authorization.ts";
import { gateFilesOf } from "./gate-files.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import {
  evidenceHarness,
  executionHarness,
  markDelivered,
  refusedAt,
  reviewerFinding,
  reviewHarness,
  revokedExecution,
  unexpectedCollaboration,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_HUMAN_LABEL = "H1";
const FIRST_SUGGESTION_LABEL = "S1";
const SUCCESSFUL_EXIT_CODE = 0;
const NO_ATTEMPT = 0;
const NO_CALLS = 0;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION = "gateway.request.validation_failed";
const QUEUE_INSERT = "workQueue.insert";
const REWORK_OFF = 0;
const ROLLBACK = "rollback";
const EXECUTION_REVOKED = "schedulerClaims.executionRevoked";
const SECOND_ATTEMPT = 2;
const FIRST_REWORK = 1;
const HUMAN_REASON = "Hold";
const TRANSITION_ARGUMENT = 2;
const GIT_FAILED = "repository.connector.git_failed";
const BAD_GATEWAY = 502;
const ONE_ASSESSMENT = 1;
const FAILURE_CAUSE_ARGUMENT = 3;
const FIRST_QUEUED_AT = 40;
const FIXED_FINDING_IDS = "fixed_finding_ids";
const REWORK_CAUSE = attributed(
  CauseCategory.Model,
  CauseSubcategory.WorkDefect,
  CauseAssigner.Reviewer,
);

const PLAN_CAUSE = attributed(
  CauseCategory.Plan,
  CauseSubcategory.RequirementConflict,
  CauseAssigner.Reviewer,
);

function revokedTransition(calls: { method: string; arguments: unknown[] }[]) {
  const ends = calls.filter((call) => call.method === EXECUTION_REVOKED);
  return ends.at(-1)!.arguments[TRANSITION_ARGUMENT];
}

function revokedFailureCause(
  calls: { method: string; arguments: unknown[] }[],
) {
  const ends = calls.filter((call) => call.method === EXECUTION_REVOKED);
  return ends.at(-1)!.arguments[FAILURE_CAUSE_ARGUMENT];
}

test("examine currency follows real dependency outcomes and only current closure releases dependent work", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const dependentId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      filename: "child.md",
      created_at: FIRST_REVISION,
    });
    insertDependency(tx, h.mission_id, h.node_id, childId);
    insertRevision(tx, {
      ...base,
      node_id: childId,
      filename: "child.md",
      content: { ...base.content, intent: Intent.Implement },
      tasks: [],
    });
    insertNode(tx, {
      id: dependentId,
      mission_id: h.mission_id,
      filename: "dependent.md",
      created_at: FIRST_REVISION,
    });
    insertRevision(tx, {
      ...base,
      node_id: dependentId,
      filename: "dependent.md",
    });
    insertDependency(tx, h.mission_id, dependentId, h.node_id);
    setNodeState(tx, h.node_id, NodeState.Evaluating);
  });
  const input = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Run",
      assets: [
        {
          kind: AssetKind.Produced,
          content: {
            media_type: "text/plain",
            encoding: "base64",
            data: "b2s=",
          },
        },
      ],
      verification: {
        tested_input: input,
        results: [
          {
            command: "true",
            exit_code: SUCCESSFUL_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  const body = {
    ...h.context,
    evidence_ids: [evidence.evidence.id],
    dependency_outcome_ids: [] as string[],
    result: AssessmentResult.Success,
    rationale: "Passed",
    tested_input: input,
  };
  const submit = () =>
    h.invoke("assessment.submit", {
      params: { node_id: h.node_id },
      query: {},
      body,
    });
  const first = await submit();
  assert.equal(first.assessment.currency?.current, false);
  assert.equal(first.outcome, null);
  assert.equal(
    h.calls.filter((call) => call.method === QUEUE_INSERT).length,
    NO_CALLS,
  );
  const stalePlan = await h.invoke("assessment.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...body,
      result: AssessmentResult.CriterionNotMet,
      cause: PLAN_CAUSE,
    },
  });
  assert.equal(stalePlan.assessment.currency?.current, false);
  assert.equal(stalePlan.outcome, null);
  assert.ok("state" in stalePlan.node);
  assert.equal(stalePlan.node.state, NodeState.Evaluating);
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
  assert.ok(h.store.transaction((tx) => readOpenAttempt(tx, h.node_id)));
  const outcomeId = createIdentity("outcome");
  h.store.transaction((tx) => {
    const id = createIdentity("assessment");
    insertAssessment(tx, {
      id,
      node_id: childId,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Override",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: FIRST_REVISION,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: childId,
      result: AssessmentResult.Success,
      assessment_id: id,
      evidence_ids: "[]",
      created_at: FIRST_REVISION,
    });
    setNodeState(tx, childId, NodeState.Completed);
  });
  await assert.rejects(
    submit(),
    (error) => error instanceof OperationError && error.code === VALIDATION,
  );
  body.dependency_outcome_ids = [outcomeId];
  const final = await submit();
  assert.equal(final.assessment.currency?.current, true);
  assert.equal(final.outcome?.result, AssessmentResult.Success);
  assert.ok(
    h.calls.some(
      (call) =>
        call.method === QUEUE_INSERT && call.arguments.includes(dependentId),
    ),
  );
});

async function fixture(
  t: TestContext,
  action: RepositoryAction | null = null,
  landing: (typeof RepositoryLanding)[keyof typeof RepositoryLanding] = RepositoryLanding.Human,
) {
  const h = evidenceHarness(t, IDENTITY);
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    binding_id: h.repositoryId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action,
    landing,
  });
  const address = {
    kind: AssetKind.Repository,
    binding_id: h.repositoryId,
    commit: "a".repeat(40),
  } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address }],
      verification: {
        tested_input: address,
        results: [
          {
            command: "true",
            exit_code: SUCCESSFUL_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  let revokes = NO_CALLS;
  h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) => {
    revokes++;
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return revokedExecution(h.claim.executionId, nodeId, now);
  };
  const body: AssessmentSubmit = {
    ...h.context,
    evidence_ids: [evidence.evidence.id],
    dependency_outcome_ids: [],
    result: AssessmentResult.Success,
    rationale: "Passed",
    tested_input: address,
    proposals: [],
    findings: [],
    fixed_finding_ids: [],
  };
  const submit = (input = body) =>
    h.invoke("assessment.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: input,
    });
  assert.equal(h.node().state, NodeState.Evaluating);
  assert.equal(body.evidence_ids.length, FIRST_REVISION);
  return { ...h, body, submit, address, revokes: () => revokes };
}

test("current passing assessments close attempts and revoke claims without an external action", async (t) => {
  const h = await fixture(t);
  const result = await h.submit();
  assert.ok("state" in result.node);
  assert.equal(result.node.state, NodeState.Completed);
  assert.equal(result.outcome?.closing_event, ClosingEvent.AssessmentPassed);
  assert.equal(result.outcome?.assessment_id, result.assessment.id);
  assert.equal(
    h.store.transaction((tx) => readOpenAttempt(tx, h.node_id)),
    null,
  );
  assert.equal(h.revokes(), FIRST_REVISION);
  await assert.rejects(
    h.submit(),
    (error) => error instanceof OperationError && error.code === NOT_RUNNING,
  );
});

const GATE_PATH = "package.json";
const OTHER_GATE_PATH = "pnpm-lock.yaml";

function answerGateFiles(
  h: Awaited<ReturnType<typeof fixture>>,
  paths: string[],
) {
  h.dependencies.intakeGateFiles.read = async () => ({ paths });
}

function storedGateFiles(
  h: Awaited<ReturnType<typeof fixture>>,
  assessmentId: string,
) {
  return h.store.transaction((tx) => readAssessment(tx, assessmentId)!);
}

test("an assessment stores the server gate files", async (t) => {
  const h = await fixture(t, RepositoryAction.Push);
  answerGateFiles(h, [OTHER_GATE_PATH]);
  const result = await h.submit();
  assert.equal(
    storedGateFiles(h, result.assessment.id).gate_files,
    canonicalJSON([
      { binding_id: h.address.binding_id, paths: [OTHER_GATE_PATH] },
    ]),
  );
});

test("a server gate file keeps the human landing of a merge push", async (t) => {
  const h = await fixture(t, RepositoryAction.Push);
  answerGateFiles(h, [GATE_PATH]);
  const result = await h.submit();
  const [action] = h.store.transaction((tx) =>
    requiredActionsOf(
      tx,
      h.dependencies.bindings,
      h.node_id,
      h.claim.pinnedRevision,
    ),
  );
  assert.equal(
    landsByHuman(
      action!,
      gateFilesOf(storedGateFiles(h, result.assessment.id), h.repositoryId),
    ),
    true,
  );
});

test("a server gate file keeps the service merge closed", async (t) => {
  const h = await fixture(
    t,
    RepositoryAction.PullRequest,
    RepositoryLanding.KanthorD,
  );
  answerGateFiles(h, [GATE_PATH]);
  const result = await h.submit();
  assert.deepEqual(
    gateFilesOf(storedGateFiles(h, result.assessment.id), h.repositoryId),
    [GATE_PATH],
  );
});

test("a change with no gate file stores null and keeps the service merge open", async (t) => {
  const h = await fixture(
    t,
    RepositoryAction.PullRequest,
    RepositoryLanding.KanthorD,
  );
  answerGateFiles(h, []);
  const result = await h.submit();
  assert.equal(storedGateFiles(h, result.assessment.id).gate_files, null);
});

test("a failed gate file read refuses the assessment and stores none", async (t) => {
  const h = await fixture(t, RepositoryAction.Push);
  h.dependencies.intakeGateFiles.read = async () => {
    throw new OperationError(BAD_GATEWAY, GIT_FAILED, "The git read fails.");
  };
  await assert.rejects(
    h.submit(),
    (error) => error instanceof OperationError && error.code === GIT_FAILED,
  );
  assert.deepEqual(
    h.store.transaction((tx) =>
      listAssessments(tx, h.node_id, null, null, ONE_ASSESSMENT),
    ),
    [],
  );
  assert.equal(h.node().state, NodeState.Evaluating);
});

test("a gate file read receives the binding, the base branch, the tested commit and the execution caller", async (t) => {
  const h = await fixture(t, RepositoryAction.Push);
  const reads: unknown[][] = [];
  h.dependencies.intakeGateFiles.read = async (...args) => {
    reads.push(args);
    return { paths: [] };
  };
  await h.submit();
  assert.deepEqual(reads, [
    [
      {
        context: h.caller.context,
        identity: IDENTITY,
        executionId: h.claim.executionId,
      },
      {
        binding_id: h.repositoryId,
        base_branch: "main",
        commit: "a".repeat(40),
      },
    ],
  ]);
});

test("an assessment of a node with no action reads no gate files", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeGateFiles.read = unexpectedCollaboration;
  const result = await h.submit();
  assert.equal(result.assessment.result, AssessmentResult.Success);
});

test("an assessment of a node with no action stores gate_files null", async (t) => {
  const h = await fixture(t);
  const result = await h.submit();
  assert.equal(
    h.store.transaction(
      (tx) => readAssessment(tx, result.assessment.id)?.gate_files,
    ),
    null,
  );
});

test("a not-met assessment that sends rework and a passed assessment that completes the node end the root span with the assessment cause", async (t) => {
  for (const [result, state] of [
    [AssessmentResult.CriterionNotMet, NodeState.Available],
    [AssessmentResult.Success, NodeState.Completed],
  ] as const) {
    const h = await fixture(t);
    const notMet = result === AssessmentResult.CriterionNotMet;
    const answer = await h.submit({
      ...h.body,
      result,
      ...(notMet ? { cause: REWORK_CAUSE } : {}),
    });
    assert.ok("state" in answer.node);
    assert.equal(answer.node.state, state);
    const ends = h.calls.filter((call) => call.method === EXECUTION_REVOKED);
    assert.equal(ends.length, FIRST_REVISION);
    const [execution, cause] = ends[0]!.arguments as [RevokedExecution, string];
    assert.equal(execution.execution_id, h.claim.executionId);
    assert.equal(execution.trace.execution_id, h.claim.executionId);
    assert.equal(cause, RevokeCause.Assessment);
    assert.deepEqual(
      ends[0]!.arguments[FAILURE_CAUSE_ARGUMENT],
      notMet ? REWORK_CAUSE : null,
    );
  }
});

test("a revocation by an assessment hands over the states and the rule that does not limit", async (t) => {
  for (const [result, to] of [
    [AssessmentResult.Success, NodeState.Completed],
    [AssessmentResult.Undetermined, NodeState.Blocked],
  ] as const) {
    const h = await fixture(t);
    await h.submit({ ...h.body, result });
    assert.deepEqual(revokedTransition(h.calls), {
      from: NodeState.Evaluating,
      to,
      rule: TransitionRule.None,
      count: null,
      limit: null,
      first_available_at: null,
    });
  }
});

test("a transition to Completed hands the first queue time and another transition hands null", async (t) => {
  for (const [result, to, firstAvailableAt] of [
    [AssessmentResult.Success, NodeState.Completed, FIRST_QUEUED_AT],
    [AssessmentResult.Undetermined, NodeState.Blocked, null],
  ] as const) {
    const h = await fixture(t);
    h.dependencies.workQueue.firstQueuedAt = () => FIRST_QUEUED_AT;
    await h.submit({ ...h.body, result });
    assert.deepEqual(revokedTransition(h.calls), {
      from: NodeState.Evaluating,
      to,
      rule: TransitionRule.None,
      count: null,
      limit: null,
      first_available_at: firstAvailableAt,
    });
  }
});

test("a required-action pass keeps the claim and ends no root span", async (t) => {
  const h = await fixture(t, RepositoryAction.PullRequest);
  await h.submit();
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
});

test("a rolled back assessment ends no root span", async (t) => {
  const h = await fixture(t);
  h.dependencies.workQueue.insert = () => {
    throw new Error(ROLLBACK);
  };
  await assert.rejects(
    h.submit({
      ...h.body,
      result: AssessmentResult.CriterionNotMet,
      cause: REWORK_CAUSE,
    }),
    { message: ROLLBACK },
  );
  assert.equal(h.revokes(), FIRST_REVISION);
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
});

test("current nonpassing assessments block and a required-action pass keeps evaluation live", async (t) => {
  for (const result of [
    AssessmentResult.CriterionNotMet,
    AssessmentResult.Undetermined,
  ]) {
    const h = await fixture(t);
    if (result === AssessmentResult.CriterionNotMet)
      h.dependencies.config.rework_limit = REWORK_OFF;
    const answer = await h.submit({
      ...h.body,
      result,
      ...(result === AssessmentResult.CriterionNotMet
        ? { cause: REWORK_CAUSE }
        : {}),
    });
    assert.ok("state" in answer.node);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(
      answer.outcome?.closing_event,
      ClosingEvent.AssessmentNotPassed,
    );
    assert.equal(h.revokes(), FIRST_REVISION);
  }
  const h = await fixture(t, RepositoryAction.PullRequest);
  const answer = await h.submit();
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Evaluating);
  assert.equal(answer.outcome, null);
  assert.equal(h.revokes(), NO_CALLS);
  assert.ok(h.store.transaction((tx) => readOpenAttempt(tx, h.node_id)));
});

test("a criterion-not-met assessment of an attempt with a request closes into Blocked below the rework limit and preserves the request", async (t) => {
  for (const [cause, rule] of [
    [REWORK_CAUSE, TransitionRule.None],
    [PLAN_CAUSE, TransitionRule.PlanDefect],
  ] as const) {
    const h = await fixture(t, RepositoryAction.PullRequest);
    await h.submit();
    const request = await h.invoke("evidence.request", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "PR",
        requirement_key: "repo.pull_request",
        address: {
          kind: PlatformAddressKind.PullRequest,
          resource_identity: "repository:github:owner/repo",
          number: FIRST_REVISION,
        },
      },
    });
    const answer = await h.submit({
      ...h.body,
      result: AssessmentResult.CriterionNotMet,
      cause,
    });
    assert.ok("state" in answer.node);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(h.revokes(), FIRST_REVISION);
    assert.equal(
      (revokedTransition(h.calls) as { rule: TransitionRule }).rule,
      rule,
    );
    h.store.transaction((tx) => {
      assert.equal(readOpenAttempt(tx, h.node_id), null);
      assert.equal(readEvidence(tx, request.id)?.end_state, null);
    });
  }
});

test("a criterion-not-met assessment below the rework limit returns the node to Available and blocks at the limit", async (t) => {
  for (const finalCause of [REWORK_CAUSE, PLAN_CAUSE]) {
    const h = await fixture(t);
    const limit = h.dependencies.config.rework_limit;
    const finalTransition =
      finalCause === PLAN_CAUSE
        ? { rule: TransitionRule.PlanDefect, count: null, limit: null }
        : { rule: TransitionRule.ReworkLimit, count: limit, limit };
    const live = () => {
      h.dependencies.schedulerClaims.liveExecutionOf = () => ({
        execution_id: h.claim.executionId,
        runtime_identity: h.claim.runtimeIdentity,
        attempt: h.claim.attempt,
        pinned_revision: h.claim.pinnedRevision,
      });
    };
    const evaluateAgain = () => {
      live();
      h.store.transaction((tx) =>
        setNodeState(tx, h.node_id, NodeState.Evaluating),
      );
    };
    const readRework = () =>
      h.invoke("execution.rework_assessment.get", {
        params: { execution_id: h.claim.executionId },
        query: {},
        body: null,
      });
    const notFound = (error: unknown) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound;
    await assert.rejects(readRework(), notFound);
    const notMet = {
      ...h.body,
      result: AssessmentResult.CriterionNotMet,
      cause: REWORK_CAUSE,
    };
    for (let rework = FIRST_REWORK; rework <= limit; rework++) {
      if (rework > FIRST_REWORK) evaluateAgain();
      const inserts = h.calls.filter((call) => call.method === QUEUE_INSERT);
      const answer = await h.submit(notMet);
      assert.ok("state" in answer.node);
      assert.equal(answer.node.state, NodeState.Available);
      assert.equal(answer.outcome, null);
      assert.equal(h.revokes(), rework);
      assert.deepEqual(revokedFailureCause(h.calls), REWORK_CAUSE);
      assert.deepEqual(revokedTransition(h.calls), {
        from: NodeState.Evaluating,
        to: NodeState.Available,
        rule: TransitionRule.None,
        count: null,
        limit: null,
        first_available_at: null,
      });
      assert.ok(
        h.calls
          .filter((call) => call.method === QUEUE_INSERT)
          .slice(inserts.length)
          .some((call) => call.arguments.includes(h.node_id)),
      );
      h.store.transaction((tx) => {
        assert.equal(readOpenAttempt(tx, h.node_id)?.attempt, h.claim.attempt);
        assert.deepEqual(
          readOutcomesOfAttempt(tx, h.node_id, h.claim.attempt),
          [],
        );
      });
      live();
      assert.equal((await readRework()).id, answer.assessment.id);
    }
    evaluateAgain();
    const blocked = await h.submit({ ...notMet, cause: finalCause });
    assert.ok("state" in blocked.node);
    assert.equal(blocked.node.state, NodeState.Blocked);
    assert.deepEqual(revokedFailureCause(h.calls), finalCause);
    assert.deepEqual(revokedTransition(h.calls), {
      from: NodeState.Evaluating,
      to: NodeState.Blocked,
      ...finalTransition,
      first_available_at: null,
    });
    assert.equal(
      blocked.outcome?.closing_event,
      ClosingEvent.AssessmentNotPassed,
    );
    assert.equal(
      h.store.transaction((tx) => readOpenAttempt(tx, h.node_id)),
      null,
    );
    h.store.transaction((tx) =>
      openAttempt(tx, h.node_id, FIRST_REVISION, h.actor, FIRST_REVISION),
    );
    h.claim.attempt = SECOND_ATTEMPT;
    evaluateAgain();
    await assert.rejects(readRework(), notFound);
    const context = { ...h.context, attempt: SECOND_ATTEMPT };
    const evidence = await h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...context,
        subject: "Verified",
        assets: [
          {
            kind: AssetKind.Repository,
            address: h.address,
          },
        ],
        verification: {
          tested_input: h.address,
          results: [
            {
              command: "true",
              exit_code: SUCCESSFUL_EXIT_CODE,
              signal: null,
              timed_out: false,
            },
          ],
        },
      },
    });
    const next = await h.submit({
      ...notMet,
      ...context,
      evidence_ids: [evidence.evidence.id],
    });
    assert.ok("state" in next.node);
    assert.equal(next.node.state, NodeState.Available);
    assert.equal(next.outcome, null);
  }
});

test("a plan cause blocks at the first criterion-not-met assessment with the rule plan_defect", async (t) => {
  for (const subcategory of [
    CauseSubcategory.RequirementConflict,
    CauseSubcategory.CriterionUnstated,
  ]) {
    const h = await fixture(t);
    assert.ok(h.dependencies.config.rework_limit > REWORK_OFF);
    const cause = attributed(
      CauseCategory.Plan,
      subcategory,
      CauseAssigner.Reviewer,
    );
    const answer = await h.submit({
      ...h.body,
      result: AssessmentResult.CriterionNotMet,
      cause,
    });
    assert.ok("state" in answer.node);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(
      answer.outcome?.closing_event,
      ClosingEvent.AssessmentNotPassed,
    );
    assert.equal(h.revokes(), FIRST_REVISION);
    assert.deepEqual(revokedFailureCause(h.calls), cause);
    assert.deepEqual(revokedTransition(h.calls), {
      from: NodeState.Evaluating,
      to: NodeState.Blocked,
      rule: TransitionRule.PlanDefect,
      count: null,
      limit: null,
      first_available_at: null,
    });
    assert.equal(
      h.store.transaction((tx) => readOpenAttempt(tx, h.node_id)),
      null,
    );
  }
});

test("the cleared assessment read answers the assessment that the cleared outcome names", async (t) => {
  for (const humanBlock of [false, true]) {
    const h = await fixture(t);
    const readCleared = () =>
      h.invoke("execution.cleared_assessment.get", {
        params: { execution_id: h.claim.executionId },
        query: {},
        body: null,
      });
    const notFound = (error: unknown) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound;
    await assert.rejects(readCleared(), notFound);
    h.dependencies.bindings.resolveBindingIdentity = (_tx, _project, id) => ({
      binding_id: id,
      resource_identity:
        id === h.repositoryId
          ? "repository:github:owner/repo"
          : "storage:s3:bucket",
    });
    let blocked: { id: string; rationale: string };
    let content;
    if (humanBlock) {
      h.store.transaction((tx) =>
        setNodeState(tx, h.node_id, NodeState.Paused),
      );
      const answer = await h.invoke("node.block", {
        params: { node_id: h.node_id },
        query: {},
        body: {
          reason: HUMAN_REASON,
          expected_mission_version: FIRST_REVISION,
          expected_state: NodeState.Paused,
          expected_attempt: h.claim.attempt,
        },
      });
      assert.ok(answer.outcome);
      content = answer.node.content;
      blocked = h.store.transaction((tx) => {
        const assessment = readAssessment(tx, answer.outcome!.assessment_id);
        assert.ok(assessment);
        return assessment;
      });
    } else {
      const answer = await h.submit({
        ...h.body,
        result: AssessmentResult.Undetermined,
      });
      assert.ok("content" in answer.node);
      content = answer.node.content;
      blocked = answer.assessment;
    }
    await h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: h.claim.attempt,
        expected_revision: FIRST_REVISION,
        expected_mission_version: FIRST_REVISION,
        change: { content, reason: "Redirect", tasks: [] },
      },
    });
    h.claim.attempt = SECOND_ATTEMPT;
    h.dependencies.schedulerClaims.liveExecutionOf = () => ({
      execution_id: h.claim.executionId,
      runtime_identity: h.claim.runtimeIdentity,
      attempt: h.claim.attempt,
      pinned_revision: h.claim.pinnedRevision,
    });
    h.store.transaction((tx) =>
      setNodeState(tx, h.node_id, NodeState.Executing),
    );
    const cleared = await readCleared();
    assert.equal(cleared.id, blocked.id);
    assert.equal(
      cleared.rationale,
      humanBlock ? HUMAN_REASON : h.body.rationale,
    );
  }
});

const FIRST_ROUND = 1;
const SECOND_ROUND = 2;
const FINAL_ROUND = 3;
const REWORK_ONCE = 1;
const FAILED_EXIT_CODE = 1;

test("a success with an action:yes finding reworks below the limit and the final round reports its findings", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const first = await h.submit({ findings: [reviewerFinding("S1")] });
  assert.equal(first.assessment.round, FIRST_ROUND);
  assert.ok("state" in first.node);
  assert.equal(first.node.state, NodeState.Available);
  assert.equal(first.outcome, null);
  assert.equal(revokedFailureCause(h.calls), null);
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Fix);
  const s1 = await h.byLabel("S1");
  h.evaluate();
  const second = await h.submit({
    findings: [reviewerFinding("S2")],
    fixed_finding_ids: [s1.id],
  });
  assert.equal(second.assessment.round, SECOND_ROUND);
  assert.ok("state" in second.node);
  assert.equal(second.node.state, NodeState.Available);
  const fixed = await h.byLabel("S1");
  assert.equal(fixed.status, FindingStatus.Fixed);
  assert.equal(fixed.fixed_assessment_id, second.assessment.id);
  h.evaluate();
  const final = await h.submit({ findings: [reviewerFinding("S3")] });
  assert.equal(final.assessment.round, FINAL_ROUND);
  assert.ok("state" in final.node);
  assert.equal(final.node.state, NodeState.Completed);
  assert.equal(final.outcome?.result, AssessmentResult.Success);
  assert.equal((await h.byLabel("S3")).route, FindingRoute.Report);
  const unlisted = await h.byLabel("S2");
  assert.equal(unlisted.route, FindingRoute.Report);
  assert.equal(unlisted.status, FindingStatus.Open);
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Fix);
});

test("an unlisted open finding keeps its text, reworks a success and reads fixed when the final round lists it", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({
    ...h.notMet,
    findings: [reviewerFinding("B1"), reviewerFinding("S1")],
  });
  const [b1, s1] = [await h.byLabel("B1"), await h.byLabel("S1")];
  h.evaluate();
  const second = await h.submit({ fixed_finding_ids: [b1.id] });
  assert.ok("state" in second.node);
  assert.equal(second.node.state, NodeState.Available);
  assert.equal(second.outcome, null);
  assert.equal(revokedFailureCause(h.calls), null);
  assert.deepEqual(await h.byLabel("S1"), s1);
  h.evaluate();
  const final = await h.submit({ fixed_finding_ids: [s1.id] });
  assert.ok("state" in final.node);
  assert.equal(final.node.state, NodeState.Completed);
  const listed = await h.byLabel("S1");
  assert.equal(listed.route, FindingRoute.Fix);
  assert.equal(listed.status, FindingStatus.Fixed);
  assert.equal(listed.fixed_assessment_id, final.assessment.id);
});

test("a criterion-not-met final round blocks with the rule rework_limit and reports the open findings", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  h.evaluate();
  await h.submit(h.notMet);
  h.evaluate();
  const final = await h.submit(h.notMet);
  assert.ok("state" in final.node);
  assert.equal(final.node.state, NodeState.Blocked);
  assert.deepEqual(revokedTransition(h.calls), {
    from: NodeState.Evaluating,
    to: NodeState.Blocked,
    rule: TransitionRule.ReworkLimit,
    count: h.dependencies.config.rework_limit,
    limit: h.dependencies.config.rework_limit,
    first_available_at: null,
  });
  const b1 = await h.byLabel("B1");
  assert.equal(b1.route, FindingRoute.Report);
  assert.equal(b1.status, FindingStatus.Open);
});

test("a final round with a failed verification blocks with the rule rework_limit", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  h.evaluate();
  await h.submit(h.notMet);
  h.evaluate();
  const failed = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verification failed",
      assets: [{ kind: AssetKind.Repository, address: h.address }],
      verification: {
        tested_input: h.address,
        results: [
          {
            command: "true",
            exit_code: FAILED_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  const final = await h.submit({
    ...h.notMet,
    evidence_ids: [failed.evidence.id],
  });
  assert.equal(final.assessment.round, FINAL_ROUND);
  assert.ok("state" in final.node);
  assert.equal(final.node.state, NodeState.Blocked);
  assert.equal(final.outcome?.closing_event, ClosingEvent.AssessmentNotPassed);
  assert.deepEqual(revokedTransition(h.calls), {
    from: NodeState.Evaluating,
    to: NodeState.Blocked,
    rule: TransitionRule.ReworkLimit,
    count: h.dependencies.config.rework_limit,
    limit: h.dependencies.config.rework_limit,
    first_available_at: null,
  });
  assert.equal((await h.byLabel("B1")).route, FindingRoute.Report);
});

test("a round after a request evidence reports its action:yes findings and causes no rework", async (t) => {
  const h = await reviewHarness(t, IDENTITY, RepositoryAction.PullRequest);
  await h.submit();
  await requestPullRequest(h);
  assert.equal((await h.reviewRound()).final, true);
  const answer = await h.submit({ findings: [reviewerFinding("S1")] });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Evaluating);
  assert.equal(h.revokes(), NO_CALLS);
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Report);
});

test("a current success that requests the actions reports the open findings", async (t) => {
  const h = await reviewHarness(t, IDENTITY, RepositoryAction.PullRequest);
  h.dependencies.config.rework_limit = REWORK_ONCE;
  await h.submit({ ...h.notMet, findings: [reviewerFinding("S1")] });
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Fix);
  h.evaluate();
  const answer = await h.submit();
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Evaluating);
  assert.equal(answer.outcome, null);
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Report);
});

test("a forced request delete keeps the requesting round, so the attempt gets one rework less", async (t) => {
  const h = await reviewHarness(t, IDENTITY, RepositoryAction.PullRequest);
  await h.submit();
  const request = await requestPullRequest(h);
  h.store.transaction((tx) => deleteEvidence(tx, request.id));
  const second = await h.submit(h.notMet);
  assert.equal(second.assessment.round, SECOND_ROUND);
  assert.ok("state" in second.node);
  assert.equal(second.node.state, NodeState.Available);
  h.evaluate();
  const final = await h.submit(h.notMet);
  assert.ok("state" in final.node);
  assert.equal(final.node.state, NodeState.Blocked);
  assert.equal(
    (revokedTransition(h.calls) as { rule: TransitionRule }).rule,
    TransitionRule.ReworkLimit,
  );
});

test("the refusals at fixed_finding_ids", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({
    ...h.notMet,
    findings: [
      reviewerFinding("B1"),
      reviewerFinding("S1"),
      reviewerFinding("S2", { action: FindingAction.No }),
    ],
  });
  const [b1, s1, s2] = [
    await h.byLabel("B1"),
    await h.byLabel("S1"),
    await h.byLabel("S2"),
  ];
  assert.equal(s2.route, FindingRoute.Record);
  h.evaluate();
  for (const ids of [[createIdentity("finding")], [s2.id]])
    await assert.rejects(
      h.submit({ ...h.notMet, fixed_finding_ids: ids }),
      refusedAt(FIXED_FINDING_IDS),
    );
  await assert.rejects(
    h.submit({ fixed_finding_ids: [s1.id] }),
    refusedAt(FIXED_FINDING_IDS),
  );
  await assert.rejects(
    h.submit({ ...h.notMet, fixed_finding_ids: [b1.id, b1.id] }),
    (error) =>
      error instanceof ZodError &&
      error.issues.some((issue) => issue.path.includes(FIXED_FINDING_IDS)),
  );
  await h.submit({ ...h.notMet, fixed_finding_ids: [s1.id] });
  h.evaluate();
  await assert.rejects(
    h.submit({ ...h.notMet, fixed_finding_ids: [s1.id] }),
    refusedAt(FIXED_FINDING_IDS),
  );
  const done = await h.submit({ fixed_finding_ids: [b1.id] });
  assert.ok("state" in done.node);
  assert.equal(done.node.state, NodeState.Completed);
});

test("a fixed_finding_ids identity of a report finding is refused", async (t) => {
  const h = await reviewHarness(t, IDENTITY, RepositoryAction.PullRequest);
  h.dependencies.config.rework_limit = REWORK_OFF;
  await h.submit({ findings: [reviewerFinding("S1")] });
  const s1 = await h.byLabel("S1");
  assert.equal(s1.route, FindingRoute.Report);
  await assert.rejects(
    h.submit({ fixed_finding_ids: [s1.id] }),
    refusedAt(FIXED_FINDING_IDS),
  );
});

test("a current success is admitted while the attempt holds an open human blocker H1", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const first = await h.submit({
    ...h.notMet,
    findings: [reviewerFinding("S1")],
  });
  markDelivered(h, FIRST_ATTEMPT);
  const human = await h.invoke("finding.create", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      expected_mission_version: FIRST_REVISION,
      assessment_id: first.assessment.id,
      kind: FindingKind.Blocker,
      task_id: null,
      name: "Missed",
      description: "A defect after delivery",
      fix: "Fix it",
      why: "It breaks",
      cause_owner: FindingCauseOwner.Reviewer,
    },
  });
  assert.equal(human.label, FIRST_HUMAN_LABEL);
  h.evaluate();
  const s1 = await h.byLabel("S1");
  const done = await h.submit({ fixed_finding_ids: [s1.id] });
  assert.ok("state" in done.node);
  assert.equal(done.node.state, NodeState.Completed);
  assert.equal((await h.byLabel("H1")).route, FindingRoute.Report);
});

test("rework_limit 0 gives one final round", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  h.dependencies.config.rework_limit = REWORK_OFF;
  const round = await h.reviewRound();
  assert.equal(round.round, FIRST_ROUND);
  assert.equal(round.final, true);
  const answer = await h.submit({ findings: [reviewerFinding("S1")] });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Completed);
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Report);
});

async function requestPullRequest(
  h: Awaited<ReturnType<typeof reviewHarness>>,
) {
  return h.invoke("evidence.request", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "PR",
      requirement_key: "repo.pull_request",
      address: {
        kind: PlatformAddressKind.PullRequest,
        resource_identity: "repository:github:owner/repo",
        number: FIRST_REVISION,
      },
    },
  });
}

async function examineFixture(t: TestContext, earlierReport = false) {
  const h = executionHarness(t, IDENTITY);
  const earlierFindingId = createIdentity("finding");
  const childId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      filename: "child.md",
      created_at: FIRST_REVISION,
    });
    insertDependency(tx, h.mission_id, h.node_id, childId);
    insertRevision(tx, {
      ...base,
      node_id: childId,
      filename: "child.md",
      content: { ...base.content, intent: Intent.Implement },
      tasks: [],
    });
    setNodeState(tx, h.node_id, NodeState.Evaluating);
    if (!earlierReport) return;
    const earlierAssessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: earlierAssessmentId,
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.CriterionNotMet,
      rationale: "Earlier",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: FIRST_REVISION,
    });
    insertFinding(tx, {
      id: earlierFindingId,
      node_id: h.node_id,
      assessment_id: earlierAssessmentId,
      label: "S1",
      kind: FindingKind.Suggestion,
      action: FindingAction.Yes,
      task_id: null,
      ground: null,
      name: "Earlier",
      description: "Earlier",
      fix: "Earlier",
      why: "Earlier",
      route: FindingRoute.Report,
      fixed_assessment_id: null,
      cause_owner: null,
      created_by: null,
      decision: null,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
    });
    closeAttempt(tx, h.node_id, FIRST_ATTEMPT, FIRST_REVISION);
    openAttempt(
      tx,
      h.node_id,
      FIRST_REVISION,
      h.executionActor,
      FIRST_REVISION,
    );
  });
  if (earlierReport) {
    h.claim.attempt = SECOND_ATTEMPT;
    h.context.attempt = SECOND_ATTEMPT;
  }
  const input = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Run",
      assets: [
        {
          kind: AssetKind.Produced,
          content: {
            media_type: "text/plain",
            encoding: "base64",
            data: "b2s=",
          },
        },
      ],
      verification: {
        tested_input: input,
        results: [
          {
            command: "true",
            exit_code: SUCCESSFUL_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  const body: AssessmentSubmit = {
    ...h.context,
    evidence_ids: [evidence.evidence.id],
    dependency_outcome_ids: [],
    result: AssessmentResult.Success,
    rationale: "Passed",
    tested_input: input,
    proposals: [],
    findings: [],
    fixed_finding_ids: [],
  };
  const submit = (input: Partial<AssessmentSubmit> = {}) =>
    h.invoke("assessment.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: { ...body, ...input },
    });
  const findings = async () =>
    (
      await h.invoke("finding.list", {
        params: { node_id: h.node_id },
        query: {},
        body: null,
      })
    ).items;
  const completeChild = () =>
    h.store.transaction((tx) => {
      const id = createIdentity("assessment");
      insertAssessment(tx, {
        id,
        node_id: childId,
        attempt: NO_ATTEMPT,
        result: AssessmentResult.Success,
        rationale: "Override",
        evidence_ids: "[]",
        dependency_outcome_ids: "[]",
        tested_input: null,
        gate_files: null,
        execution_id: null,
        actor: canonicalJSON(h.actor),
        node_revision: FIRST_REVISION,
        created_at: FIRST_REVISION,
      });
      const outcome = insertOutcome(tx, {
        id: createIdentity("outcome"),
        node_id: childId,
        result: AssessmentResult.Success,
        assessment_id: id,
        evidence_ids: "[]",
        created_at: FIRST_REVISION,
      });
      setNodeState(tx, childId, NodeState.Completed);
      return outcome.id;
    });
  return {
    ...h,
    submit,
    findings,
    completeChild,
    earlierFindingId,
    childId,
  };
}

test("a non-current submit stores its findings as records and changes no earlier finding", async (t) => {
  const h = await examineFixture(t);
  const stale = await h.submit({
    result: AssessmentResult.CriterionNotMet,
    cause: REWORK_CAUSE,
    findings: [reviewerFinding("B1")],
  });
  assert.equal(stale.assessment.currency?.current, false);
  const [b1] = await h.findings();
  assert.equal(b1?.route, FindingRoute.Record);
  const seeded = createIdentity("finding");
  h.store.transaction((tx) =>
    insertFinding(tx, {
      id: seeded,
      node_id: h.node_id,
      assessment_id: stale.assessment.id,
      label: "S9",
      kind: FindingKind.Suggestion,
      action: FindingAction.Yes,
      task_id: null,
      ground: null,
      name: "Seeded",
      description: "Seeded",
      fix: "Seeded",
      why: "Seeded",
      route: FindingRoute.Fix,
      fixed_assessment_id: null,
      cause_owner: null,
      created_by: null,
      decision: null,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
    }),
  );
  const listing = await h.submit({
    findings: [reviewerFinding("S1")],
    fixed_finding_ids: [seeded],
  });
  assert.equal(listing.assessment.currency?.current, false);
  const afterStale = await h.findings();
  const seededRow = afterStale.find((item) => item.id === seeded);
  assert.equal(seededRow?.fixed_assessment_id, null);
  assert.equal(seededRow?.route, FindingRoute.Fix);
  assert.equal(
    afterStale.find((item) => item.label === FIRST_SUGGESTION_LABEL)?.route,
    FindingRoute.Record,
  );
  const undecided = await h.invoke("finding.undecided.list", {
    params: { project_id: h.project_id },
    query: {},
    body: null,
  });
  assert.deepEqual(undecided.items, []);
  const outcomeId = h.completeChild();
  const current = await h.submit({ dependency_outcome_ids: [outcomeId] });
  assert.equal(current.assessment.currency?.current, true);
  assert.ok("state" in current.node);
  assert.equal(current.node.state, NodeState.Completed);
  const routes = (await h.findings()).map((item) => [item.label, item.route]);
  assert.deepEqual(routes.sort(), [
    ["B1", FindingRoute.Record],
    ["S1", FindingRoute.Record],
    ["S9", FindingRoute.Report],
  ]);
});

test("an examine finding never gets the route fix, causes no rework and is reported only by the closing round", async (t) => {
  const h = await examineFixture(t);
  const outcomeId = h.completeChild();
  const rework = await h.submit({
    result: AssessmentResult.CriterionNotMet,
    cause: REWORK_CAUSE,
    dependency_outcome_ids: [outcomeId],
    findings: [reviewerFinding("B1"), reviewerFinding("S1")],
  });
  assert.ok("state" in rework.node);
  assert.equal(rework.node.state, NodeState.Available);
  assert.ok(
    (await h.findings()).every((item) => item.route === FindingRoute.Record),
  );
  h.dependencies.schedulerClaims.liveExecutionOf = () => ({
    execution_id: h.claim.executionId,
    runtime_identity: h.claim.runtimeIdentity,
    attempt: h.claim.attempt,
    pinned_revision: h.claim.pinnedRevision,
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  const round = await h.invoke("execution.review_round.get", {
    params: { execution_id: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.deepEqual(round.findings, []);
  assert.equal(round.review_base, null);
  const closing = await h.submit({
    dependency_outcome_ids: [outcomeId],
    findings: [reviewerFinding("S2")],
  });
  assert.ok("state" in closing.node);
  assert.equal(closing.node.state, NodeState.Completed);
  const routes = (await h.findings()).map((item) => [item.label, item.route]);
  assert.deepEqual(routes.sort(), [
    ["B1", FindingRoute.Record],
    ["S1", FindingRoute.Record],
    ["S2", FindingRoute.Report],
  ]);
});

test("a success of an examine node in a later attempt leaves the earlier report findings open", async (t) => {
  const h = await examineFixture(t, true);
  const outcomeId = h.completeChild();
  const answer = await h.submit({ dependency_outcome_ids: [outcomeId] });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Completed);
  const earlier = (await h.findings()).find(
    (item) => item.id === h.earlierFindingId,
  );
  assert.equal(earlier?.route, FindingRoute.Report);
  assert.equal(earlier?.fixed_assessment_id, null);
  assert.equal(earlier?.status, FindingStatus.Open);
});

async function blockedFirstAttempt(
  h: Awaited<ReturnType<typeof reviewHarness>>,
) {
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  const b1 = await h.byLabel("B1");
  assert.equal(b1.route, FindingRoute.Fix);
  h.dependencies.bindings.resolveBindingIdentity = (_tx, _project, id) => ({
    binding_id: id,
    resource_identity:
      id === h.repositoryId
        ? "repository:github:owner/repo"
        : "storage:s3:bucket",
  });
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  const blocked = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      reason: HUMAN_REASON,
      expected_mission_version: FIRST_REVISION,
      expected_state: NodeState.Paused,
      expected_attempt: FIRST_ATTEMPT,
    },
  });
  const reported = await h.byLabel("B1");
  assert.equal(reported.route, FindingRoute.Report);
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expected_mission_version: FIRST_REVISION,
      change: { content: blocked.node.content, reason: "Redirect", tasks: [] },
    },
  });
  h.claim.attempt = SECOND_ATTEMPT;
  h.context.attempt = SECOND_ATTEMPT;
  h.evaluate();
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address: h.address }],
      verification: {
        tested_input: h.address,
        results: [
          {
            command: "true",
            exit_code: SUCCESSFUL_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  return {
    b1: reported,
    submitSecond: (input: Partial<AssessmentSubmit> = {}) =>
      h.submit({
        ...h.context,
        evidence_ids: [evidence.evidence.id],
        ...input,
      }),
  };
}

test("a success of a later attempt marks the earlier report findings of the node fixed by that assessment", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const { b1, submitSecond } = await blockedFirstAttempt(h);
  const undecided = () =>
    h.invoke("finding.undecided.list", {
      params: { project_id: h.project_id },
      query: {},
      body: null,
    });
  assert.deepEqual(
    (await undecided()).items.map((item) => item.id),
    [b1.id],
  );
  const answer = await submitSecond();
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Completed);
  const fixed = await h.byLabel("B1");
  assert.equal(fixed.fixed_assessment_id, answer.assessment.id);
  assert.equal(fixed.status, FindingStatus.Fixed);
  assert.equal(fixed.route, FindingRoute.Report);
  assert.equal(fixed.decision, null);
  assert.deepEqual((await undecided()).items, []);
});

test("a criterion-not-met assessment of a later attempt changes no earlier finding", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const { b1, submitSecond } = await blockedFirstAttempt(h);
  await submitSecond(h.notMet);
  assert.deepEqual(await h.byLabel("B1"), b1);
});

test("a success of a later attempt keeps the decision of an earlier finding", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const { b1, submitSecond } = await blockedFirstAttempt(h);
  await h.invoke("finding.decide", {
    params: { finding_id: b1.id },
    query: {},
    body: { decision: FindingDecision.Accepted, decision_reason: "Real" },
  });
  await submitSecond();
  const kept = await h.byLabel("B1");
  assert.equal(kept.fixed_assessment_id, null);
  assert.equal(kept.decision, FindingDecision.Accepted);
});

test("a success of a later attempt keeps a human finding of an earlier attempt open", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const { b1, submitSecond } = await blockedFirstAttempt(h);
  const humanId = createIdentity("finding");
  h.store.transaction((tx) =>
    insertFinding(tx, {
      ...b1,
      id: humanId,
      decided_by: null,
      label: FIRST_HUMAN_LABEL,
      route: FindingRoute.Report,
      created_by: canonicalJSON(h.actor),
    }),
  );
  await submitSecond();
  const human = (await h.findings()).find((item) => item.id === humanId);
  assert.equal(human?.fixed_assessment_id, null);
  assert.equal(human?.status, FindingStatus.Open);
});

test("a success of a later attempt keeps its own report finding open", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const { submitSecond } = await blockedFirstAttempt(h);
  h.dependencies.config.rework_limit = REWORK_OFF;
  const answer = await submitSecond({ findings: [reviewerFinding("S1")] });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Completed);
  const own = await h.byLabel("S1");
  assert.equal(own.route, FindingRoute.Report);
  assert.equal(own.fixed_assessment_id, null);
  assert.equal(
    (await h.byLabel("B1")).fixed_assessment_id,
    answer.assessment.id,
  );
});

function fixProposal(dependencyId: string, findingLabels: string[]) {
  return {
    dependency_id: dependencyId,
    name: "Fix",
    requirement: "Repair the defect",
    criterion: "The defect is gone",
    task: {
      name: "Repair",
      requirement: "Change the code",
      criterion: "The test passes",
      verifications: ["pnpm test"],
    },
    finding_labels: findingLabels,
  };
}

function undecidedOf(h: Awaited<ReturnType<typeof examineFixture>>) {
  return h.invoke("finding.undecided.list", {
    params: { project_id: h.project_id },
    query: {},
    body: null,
  });
}

test("a blocker that a proposal names gets the route record and waits for no human", async (t) => {
  const h = await examineFixture(t);
  const outcomeId = h.completeChild();
  await h.submit({
    result: AssessmentResult.Undetermined,
    dependency_outcome_ids: [outcomeId],
    findings: [reviewerFinding("B1"), reviewerFinding("B2")],
    proposals: [fixProposal(h.childId, ["B1", "B2"])],
  });
  assert.deepEqual(
    (await h.findings()).map((item) => [item.label, item.route]),
    [
      ["B1", FindingRoute.Record],
      ["B2", FindingRoute.Record],
    ],
  );
  assert.deepEqual((await undecidedOf(h)).items, []);
});

test("a blocker that no proposal names keeps the route report", async (t) => {
  const h = await examineFixture(t);
  const outcomeId = h.completeChild();
  await h.submit({
    result: AssessmentResult.Undetermined,
    dependency_outcome_ids: [outcomeId],
    findings: [reviewerFinding("B1"), reviewerFinding("B2")],
    proposals: [fixProposal(h.childId, ["B1"])],
  });
  assert.deepEqual(
    (await h.findings()).map((item) => [item.label, item.route]),
    [
      ["B1", FindingRoute.Record],
      ["B2", FindingRoute.Report],
    ],
  );
  assert.deepEqual(
    (await undecidedOf(h)).items.map((item) => item.label),
    ["B2"],
  );
});

test("a finding label that names no blocker, repeats or two proposals name refuses the submit", async (t) => {
  const h = await examineFixture(t);
  const outcomeId = h.completeChild();
  const refused = (proposals: ReturnType<typeof fixProposal>[]) =>
    assert.rejects(
      h.submit({
        result: AssessmentResult.Undetermined,
        dependency_outcome_ids: [outcomeId],
        findings: [reviewerFinding("B1"), reviewerFinding("S1")],
        proposals,
      }),
      (error) =>
        error instanceof ZodError &&
        error.issues.some(
          (issue) =>
            issue.path.join(".") ===
            `body.proposals.${proposals.length - 1}.finding_labels`,
        ),
    );
  await refused([fixProposal(h.childId, ["B9"])]);
  await refused([fixProposal(h.childId, ["S1"])]);
  await refused([fixProposal(h.childId, ["B1", "B1"])]);
  await refused([
    fixProposal(h.childId, ["B1"]),
    fixProposal(h.childId, ["B1"]),
  ]);
  assert.deepEqual(await h.findings(), []);
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  NodeState,
  RepositoryAction,
  RepositoryLanding,
  PlatformAddressKind,
  Intent,
  MissionErrorCode,
  RevokeCause,
  TransitionRule,
  type AssessmentSubmit,
  type RevokedExecution,
} from "./contract.ts";
import {
  readOpenAttempt,
  readEvidence,
  readAssessment,
  listAssessments,
  readOutcomesOfAttempt,
  insertAssessment,
  insertOutcome,
  openAttempt,
} from "./record-store.ts";
import {
  setNodeState,
  insertNode,
  insertRevision,
  insertDependency,
} from "./store.ts";
import { getRevision } from "./node-read.ts";
import { landsByHuman } from "./authorization.ts";
import { gateFilesOf } from "./gate-files.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import {
  evidenceHarness,
  executionHarness,
  revokedExecution,
  unexpectedCollaboration,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SUCCESSFUL_EXIT_CODE = 0;
const NO_ATTEMPT = 0;
const NO_CALLS = 0;
const FIRST_REVISION = 1;
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
const REWORK_CAUSE = attributed(
  CauseCategory.Model,
  CauseSubcategory.WorkDefect,
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
  const h = await fixture(t, RepositoryAction.MergePush);
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
  const h = await fixture(t, RepositoryAction.MergePush);
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
  const h = await fixture(t, RepositoryAction.MergePush);
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
  const h = await fixture(t, RepositoryAction.MergePush);
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
    cause: REWORK_CAUSE,
  });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Blocked);
  assert.equal(h.revokes(), FIRST_REVISION);
  h.store.transaction((tx) => {
    assert.equal(readOpenAttempt(tx, h.node_id), null);
    assert.equal(readEvidence(tx, request.id)?.end_state, null);
  });
});

test("a criterion-not-met assessment below the rework limit returns the node to Available and blocks at the limit", async (t) => {
  const h = await fixture(t);
  const limit = h.dependencies.config.rework_limit;
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
  const blocked = await h.submit(notMet);
  assert.ok("state" in blocked.node);
  assert.equal(blocked.node.state, NodeState.Blocked);
  assert.deepEqual(revokedFailureCause(h.calls), REWORK_CAUSE);
  assert.deepEqual(revokedTransition(h.calls), {
    from: NodeState.Evaluating,
    to: NodeState.Blocked,
    rule: TransitionRule.ReworkLimit,
    count: limit,
    limit,
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

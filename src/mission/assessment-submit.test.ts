import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
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
  PlatformAddressKind,
  NodeKind,
  type AssessmentSubmit,
} from "./contract.ts";
import {
  readOpenAttempt,
  readEvidence,
  insertAssessment,
  insertOutcome,
} from "./record-store.ts";
import {
  setNodeState,
  insertNode,
  insertRevision,
  insertDependency,
} from "./store.ts";
import { getRevision } from "./node-read.ts";
import { evidenceHarness, executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION = "gateway.request.validation_failed";
const QUEUE_INSERT = "workQueue.insert";

test("initiative currency follows real child outcomes and only current closure releases dependent work", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const dependentId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.nodeId, ONE);
    insertNode(tx, {
      id: childId,
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.nodeId,
      created_at: ONE,
    });
    insertRevision(tx, {
      ...base,
      nodeId: childId,
      filename: "child.md",
      tasks: [],
    });
    insertNode(tx, {
      id: dependentId,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "dependent.md",
      parent_id: null,
      created_at: ONE,
    });
    insertRevision(tx, {
      ...base,
      nodeId: dependentId,
      filename: "dependent.md",
    });
    insertDependency(tx, h.missionId, dependentId, h.nodeId);
    setNodeState(tx, h.nodeId, NodeState.Evaluating);
  });
  const input = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "Run",
      assets: [
        {
          kind: AssetKind.Produced,
          content: {
            mediaType: "text/plain",
            encoding: "base64",
            data: "b2s=",
          },
        },
      ],
      verification: {
        testedInput: input,
        results: [
          { command: "true", exitCode: ZERO, signal: null, timedOut: false },
        ],
      },
    },
  });
  const body = {
    ...h.context,
    evidenceIds: [evidence.evidence.id],
    childOutcomeIds: [] as string[],
    result: AssessmentResult.Success,
    rationale: "Passed",
    testedInput: input,
  };
  const submit = () =>
    h.invoke("assessment.submit", {
      params: { nodeId: h.nodeId },
      query: {},
      body,
    });
  const first = await submit();
  assert.equal(first.assessment.currency?.current, false);
  assert.equal(first.outcome, null);
  assert.equal(
    h.calls.filter((call) => call.method === QUEUE_INSERT).length,
    ZERO,
  );
  const outcomeId = createIdentity("outcome");
  h.store.transaction((tx) => {
    const id = createIdentity("assessment");
    insertAssessment(tx, {
      id,
      node_id: childId,
      attempt: ZERO,
      result: AssessmentResult.Success,
      rationale: "Override",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: ONE,
      created_at: ONE,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: childId,
      result: AssessmentResult.Success,
      assessment_id: id,
      evidence_ids: "[]",
      created_at: ONE,
    });
    setNodeState(tx, childId, NodeState.Completed);
  });
  await assert.rejects(
    submit(),
    (error) => error instanceof OperationError && error.code === VALIDATION,
  );
  body.childOutcomeIds = [outcomeId];
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

async function fixture(t: TestContext, action: RepositoryAction | null = null) {
  const h = evidenceHarness(t, IDENTITY);
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId: h.repositoryId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action,
    projectPrompt: null,
  });
  const address = {
    kind: AssetKind.Repository,
    bindingId: h.repositoryId,
    commit: "a".repeat(40),
  } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address }],
      verification: {
        testedInput: address,
        results: [
          { command: "true", exitCode: ZERO, signal: null, timedOut: false },
        ],
      },
    },
  });
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  let revokes = ZERO;
  h.dependencies.schedulerClaims.revoke = () => {
    revokes++;
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return h.claim.executionId;
  };
  const body: AssessmentSubmit = {
    ...h.context,
    evidenceIds: [evidence.evidence.id],
    childOutcomeIds: [],
    result: AssessmentResult.Success,
    rationale: "Passed",
    testedInput: address,
  };
  const submit = (input = body) =>
    h.invoke("assessment.submit", {
      params: { nodeId: h.nodeId },
      query: {},
      body: input,
    });
  assert.equal(h.node().state, NodeState.Evaluating);
  assert.equal(body.evidenceIds.length, ONE);
  return { ...h, body, submit, revokes: () => revokes };
}

test("current passing assessments close attempts and revoke claims without an external action", async (t) => {
  const h = await fixture(t);
  const result = await h.submit();
  assert.ok("state" in result.node);
  assert.equal(result.node.state, NodeState.Completed);
  assert.equal(result.outcome?.closingEvent, ClosingEvent.AssessmentPassed);
  assert.equal(result.outcome?.assessmentId, result.assessment.id);
  assert.equal(
    h.store.transaction((tx) => readOpenAttempt(tx, h.nodeId)),
    null,
  );
  assert.equal(h.revokes(), ONE);
  await assert.rejects(
    h.submit(),
    (error) => error instanceof OperationError && error.code === NOT_RUNNING,
  );
});

test("current nonpassing assessments block and a required-action pass keeps evaluation live", async (t) => {
  for (const result of [
    AssessmentResult.CriterionNotMet,
    AssessmentResult.Undetermined,
  ]) {
    const h = await fixture(t);
    const answer = await h.submit({ ...h.body, result });
    assert.ok("state" in answer.node);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(
      answer.outcome?.closingEvent,
      ClosingEvent.AssessmentNotPassed,
    );
    assert.equal(h.revokes(), ONE);
  }
  const h = await fixture(t, RepositoryAction.PullRequest);
  const answer = await h.submit();
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Evaluating);
  assert.equal(answer.outcome, null);
  assert.equal(h.revokes(), ZERO);
  assert.ok(h.store.transaction((tx) => readOpenAttempt(tx, h.nodeId)));
});

test("nonpassing assessment closes into Blocked while preserving its unresolved request", async (t) => {
  const h = await fixture(t, RepositoryAction.PullRequest);
  await h.submit();
  const request = await h.invoke("evidence.request", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "PR",
      requirementKey: "repo.pull_request",
      address: {
        kind: PlatformAddressKind.PullRequest,
        resourceIdentity: "repository:github:owner/repo",
        number: ONE,
      },
    },
  });
  const answer = await h.submit({
    ...h.body,
    result: AssessmentResult.CriterionNotMet,
  });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Blocked);
  assert.equal(h.revokes(), ONE);
  h.store.transaction((tx) => {
    assert.equal(readOpenAttempt(tx, h.nodeId), null);
    assert.equal(readEvidence(tx, request.id)?.end_state, null);
  });
});

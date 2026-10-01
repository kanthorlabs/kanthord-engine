import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  NodeState,
  RepositoryAction,
  type AssessmentSubmit,
} from "./contract.ts";
import { readOpenAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const NOT_RUNNING = "scheduler.execution.not_running";

async function fixture(t: TestContext, action: RepositoryAction | null = null) {
  const h = evidenceHarness(t, IDENTITY);
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId: h.repositoryId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
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

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
const SUCCESSFUL_EXIT_CODE = 0;
const NO_ATTEMPT = 0;
const NO_CALLS = 0;
const FIRST_REVISION = 1;
const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION = "gateway.request.validation_failed";
const QUEUE_INSERT = "workQueue.insert";

test("initiative currency follows real child outcomes and only current closure releases dependent work", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const dependentId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.node_id,
      created_at: FIRST_REVISION,
    });
    insertRevision(tx, {
      ...base,
      node_id: childId,
      filename: "child.md",
      tasks: [],
    });
    insertNode(tx, {
      id: dependentId,
      mission_id: h.mission_id,
      kind: NodeKind.Initiative,
      filename: "dependent.md",
      parent_id: null,
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
    child_outcome_ids: [] as string[],
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
      child_outcome_ids: "[]",
      tested_input: null,
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
  body.child_outcome_ids = [outcomeId];
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
    binding_id: h.repositoryId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action,
    project_prompt: null,
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
  h.dependencies.schedulerClaims.revoke = () => {
    revokes++;
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return h.claim.executionId;
  };
  const body: AssessmentSubmit = {
    ...h.context,
    evidence_ids: [evidence.evidence.id],
    child_outcome_ids: [],
    result: AssessmentResult.Success,
    rationale: "Passed",
    tested_input: address,
  };
  const submit = (input = body) =>
    h.invoke("assessment.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: input,
    });
  assert.equal(h.node().state, NodeState.Evaluating);
  assert.equal(body.evidence_ids.length, FIRST_REVISION);
  return { ...h, body, submit, revokes: () => revokes };
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

test("nonpassing assessment closes into Blocked while preserving its unresolved request", async (t) => {
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
  });
  assert.ok("state" in answer.node);
  assert.equal(answer.node.state, NodeState.Blocked);
  assert.equal(h.revokes(), FIRST_REVISION);
  h.store.transaction((tx) => {
    assert.equal(readOpenAttempt(tx, h.node_id), null);
    assert.equal(readEvidence(tx, request.id)?.end_state, null);
  });
});

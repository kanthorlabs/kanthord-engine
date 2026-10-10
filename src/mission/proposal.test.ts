import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  MissionErrorCode,
  NodeKind,
  NodeState,
  type ProposalContent,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { getRevision } from "./node-read.ts";
import {
  insertAssessment,
  readOpenAttempt,
  insertOutcome,
  readOutcomesOfAttempt,
} from "./record-store.ts";
import { claimableMap } from "./routing.ts";
import {
  insertNode,
  insertRevision,
  readCurrentRevision,
  readMissionNodes,
  readNode,
  setNodeState,
} from "./store.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const NO_PROPOSALS = 0;
const SINGLE_PROPOSAL = 1;
const TWO_PROPOSALS = 2;
const NOW = 100;
const VALIDATION = "gateway.request.validation_failed";
const RESOURCE_IDENTITY = "repository:github:owner/repo";

async function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const repositoryId = createIdentity("binding");
  const childId = createIdentity("node");
  const input = [
    {
      kind: AssetKind.Repository,
      binding_id: repositoryId,
      commit: "a".repeat(40),
    },
  ] as const;
  h.dependencies.bindings.getBindingRevision = (_tx, id) =>
    id === repositoryId
      ? {
          binding_id: repositoryId,
          project_id: h.project_id,
          name: "repo",
          resource_identity: RESOURCE_IDENTITY,
          revision: FIRST_REVISION,
          tombstone: false,
          disabled: false,
        }
      : null;
  h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) =>
    projectId === h.project_id && id === repositoryId
      ? { binding_id: repositoryId, resource_identity: RESOURCE_IDENTITY }
      : null;
  const childOutcomeId = h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.node_id,
      created_at: NOW,
    });
    insertRevision(tx, {
      ...base,
      node_id: childId,
      filename: "child.md",
      content: { ...base.content, bindings: [repositoryId] },
      tasks: [],
    });
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
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
      created_at: NOW,
    });
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: childId,
      result: AssessmentResult.Success,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: NOW,
    });
    setNodeState(tx, childId, NodeState.Completed);
    setNodeState(tx, h.node_id, NodeState.Evaluating);
    return outcome.id;
  });
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
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
  });
  const proposal = (objectiveId = childId, name = "Fix"): ProposalContent => ({
    objective_id: objectiveId,
    name,
    requirement: "Repair the defect",
    criterion: "The defect is gone",
    task: {
      name: "Repair",
      requirement: "Change the code",
      criterion: "The test passes",
      verifications: ["pnpm test"],
    },
  });
  const body = (
    proposals: ProposalContent[],
    result: AssessmentResult = AssessmentResult.Undetermined,
  ) => ({
    ...h.context,
    evidence_ids: [evidence.evidence.id],
    child_outcome_ids: [childOutcomeId],
    result,
    rationale: "Defect found",
    tested_input: input,
    proposals,
  });
  const submit = (proposals: ProposalContent[], result?: AssessmentResult) =>
    h.invoke("assessment.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: body(proposals, result),
    });
  const list = (attempt?: number) =>
    h.invoke("proposal.list", {
      params: { node_id: h.node_id },
      query: attempt === undefined ? {} : { attempt: String(attempt) },
      body: null,
    });
  const approve = (proposalId: string, version = FIRST_REVISION) =>
    h.invoke("proposal.approve", {
      params: { proposal_id: proposalId },
      query: {},
      body: { expected_mission_version: version },
    });
  return { ...h, repositoryId, childId, proposal, submit, list, approve };
}

function refusal(promise: Promise<unknown>, code: string, field?: string) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    if (field)
      assert.deepEqual(error.details, [{ path: [field], code: "custom" }]);
    return true;
  });
}

test("proposals are refused on a success result and an unknown objective", async (t) => {
  const h = await fixture(t);
  await refusal(
    h.submit([h.proposal()], AssessmentResult.Success),
    VALIDATION,
    "proposals",
  );
  await refusal(
    h.submit([h.proposal(createIdentity("node"))]),
    VALIDATION,
    "proposals",
  );
  assert.equal((await h.list()).items.length, NO_PROPOSALS);
});

test("an undetermined initiative assessment records one row per proposal", async (t) => {
  const h = await fixture(t);
  const result = await h.submit([h.proposal(), h.proposal(h.childId, "Other")]);
  assert.equal(result.outcome?.result, AssessmentResult.Undetermined);
  assert.equal(result.node.kind, NodeKind.Initiative);
  assert.equal(h.node().state, NodeState.Blocked);
  const page = await h.list();
  assert.equal(page.items.length, TWO_PROPOSALS);
  assert.equal(page.next_cursor, null);
  for (const item of page.items) {
    assert.equal(item.node_id, h.node_id);
    assert.equal(item.attempt, FIRST_ATTEMPT);
    assert.equal(item.assessment_id, result.assessment.id);
    assert.equal(item.objective_node_id, null);
    assert.equal(item.approved_at, null);
  }
  assert.deepEqual(page.items.map((item) => item.content.name).sort(), [
    "Fix",
    "Other",
  ]);
  assert.equal((await h.list(SECOND_ATTEMPT)).items.length, NO_PROPOSALS);
});

test("approving a proposal creates the objective with its task and unblocks the initiative", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.approve(proposalId);
  const objectiveId = result.objective.revisions[0]!.node_id;
  const objective = h.store.transaction((tx) => ({
    node: readNode(tx, objectiveId)!,
    revision: readCurrentRevision(tx, objectiveId)!,
  }));
  assert.equal(objective.node.kind, NodeKind.Objective);
  assert.equal(objective.node.parent_id, h.node_id);
  assert.equal(objective.node.state, NodeState.Available);
  assert.deepEqual(JSON.parse(objective.revision.bindings), [h.repositoryId]);
  assert.deepEqual(JSON.parse(objective.revision.verifications), ["pnpm test"]);
  const tasks = h.store.transaction((tx) =>
    readMissionNodes(tx, h.mission_id).filter(
      (node) => node.kind === NodeKind.Task && node.parent_id === objectiveId,
    ),
  );
  assert.equal(tasks.length, SINGLE_PROPOSAL);
  assert.equal(result.objective.revisions.at(-1)?.tasks?.[0]?.id, tasks[0]!.id);
  assert.equal(result.initiative.node.id, h.node_id);
  assert.equal(result.initiative.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(h.node().attempt, SECOND_ATTEMPT);
  assert.equal(h.node().state, NodeState.Available);
  const approved = (await h.list()).items[0]!;
  assert.equal(approved.objective_node_id, objectiveId);
  assert.notEqual(approved.approved_at, null);
  const claimable = () =>
    h.store.transaction((tx) =>
      claimableMap(tx, h.mission_id, h.dependencies.bindings),
    );
  assert.equal(claimable().get(h.node_id), false);
  assert.equal(claimable().get(objectiveId), true);
  h.store.transaction((tx) =>
    setNodeState(tx, objectiveId, NodeState.Completed),
  );
  assert.equal(claimable().get(h.node_id), true);
  h.store.transaction((tx) => {
    assert.ok(readOpenAttempt(tx, h.node_id));
    assert.equal(
      readOutcomesOfAttempt(tx, h.node_id, FIRST_ATTEMPT).length,
      SINGLE_PROPOSAL,
    );
  });
});

test("approving twice refuses with already_approved", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.approve(proposalId);
  await refusal(
    h.approve(proposalId, result.objective.mission_version),
    MissionErrorCode.ProposalAlreadyApproved,
  );
});

test("approving refuses an unknown proposal, a stale version and a changed initiative state", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  await refusal(
    h.approve(createIdentity("proposal")),
    MissionErrorCode.RecordNotFound,
  );
  await refusal(
    h.approve(proposalId, FIRST_REVISION + FIRST_REVISION),
    MissionErrorCode.VersionConflict,
  );
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  const before = h.store.transaction((tx) =>
    readMissionNodes(tx, h.mission_id),
  );
  await assert.rejects(h.approve(proposalId), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, ControlError.StateConflict);
    assert.deepEqual(error.details, {
      state: NodeState.Paused,
      attempt: FIRST_ATTEMPT,
    });
    return true;
  });
  assert.equal(
    h.store.transaction((tx) => readMissionNodes(tx, h.mission_id)).length,
    before.length,
  );
  assert.equal((await h.list()).items[0]!.approved_at, null);
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  ClaimableState,
  Intent,
  MissionErrorCode,
  NodeState,
  type ProposalContent,
  StartPoint,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { ControlError } from "./control.ts";
import { getRevision } from "./node-read.ts";
import {
  insertAssessment,
  insertOutcome,
  readOpenAttempt,
  readOutcomesOfAttempt,
} from "./record-store.ts";
import { claimableMap, routeMission } from "./routing.ts";
import {
  insertDependency,
  insertNode,
  insertRevision,
  readCurrentRevision,
  readMissionNodes,
  readNode,
  setNodeState,
} from "./store.ts";
import {
  actCalls,
  databaseSnapshot,
  executionHarness,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const NO_PROPOSALS = 0;
const SINGLE_PROPOSAL = 1;
const TWO_PROPOSALS = 2;
const NOW = 100;
const NO_ACTS = 0;
const ONE_ACT = 1;
const DEPENDENCY_TAG = "platform.linux";
const VALIDATION = "gateway.request.validation_failed";
const RESOURCE_IDENTITY = "repository:github:owner/repo";

async function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const repositoryId = createIdentity("binding");
  const childId = createIdentity("node");
  const input = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
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
  const dependencyOutcomeId = h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      filename: "child.md",
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, h.node_id, childId);
    insertRevision(tx, {
      ...base,
      node_id: childId,
      filename: "child.md",
      content: {
        ...base.content,
        intent: Intent.Implement,
        tags: [DEPENDENCY_TAG],
        bindings: [repositoryId],
      },
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
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
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
  const proposal = (dependencyId = childId, name = "Fix"): ProposalContent => ({
    dependency_id: dependencyId,
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
    dependency_outcome_ids: [dependencyOutcomeId],
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

test("proposals are refused on a success result and an unknown dependency", async (t) => {
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

test("an undetermined proposer assessment records one row per proposal", async (t) => {
  const h = await fixture(t);
  const result = await h.submit([h.proposal(), h.proposal(h.childId, "Other")]);
  assert.equal(result.outcome?.result, AssessmentResult.Undetermined);
  assert.equal(result.node.intent, Intent.Examine);
  assert.equal(h.node().state, NodeState.Blocked);
  const page = await h.list();
  assert.equal(page.items.length, TWO_PROPOSALS);
  assert.equal(page.next_cursor, null);
  for (const item of page.items) {
    assert.equal(item.node_id, h.node_id);
    assert.equal(item.attempt, FIRST_ATTEMPT);
    assert.equal(item.assessment_id, result.assessment.id);
    assert.equal(item.created_node_id, null);
    assert.equal(item.approved_at, null);
  }
  assert.deepEqual(page.items.map((item) => item.content.name).sort(), [
    "Fix",
    "Other",
  ]);
  assert.equal((await h.list(SECOND_ATTEMPT)).items.length, NO_PROPOSALS);
});

test("approval adds a dependency of the proposer on the created node and routes the proposer to Pending", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.approve(proposalId);
  const createdId = result.created.revisions[0]!.node_id;
  const created = h.store.transaction((tx) => ({
    node: readNode(tx, createdId)!,
    revision: readCurrentRevision(tx, createdId)!,
  }));
  assert.equal(created.revision.intent, Intent.Implement);
  assert.deepEqual(JSON.parse(created.revision.tags), [DEPENDENCY_TAG]);
  assert.equal(created.node.state, NodeState.Available);
  assert.deepEqual(JSON.parse(created.revision.bindings), [h.repositoryId]);
  assert.deepEqual(JSON.parse(created.revision.verifications), ["pnpm test"]);
  const tasks = JSON.parse(created.revision.tasks) as { id: string }[];
  assert.equal(tasks.length, SINGLE_PROPOSAL);
  assert.match(tasks[0]!.id, /^task_/);
  assert.equal(result.created.revisions.at(-1)?.tasks[0]?.id, tasks[0]!.id);
  assert.equal(result.proposer.node.id, h.node_id);
  assert.equal(result.proposer.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(result.proposer.attempt?.start_point, StartPoint.NodeBranch);
  assert.equal(h.node().attempt, SECOND_ATTEMPT);
  assert.equal(h.node().state, NodeState.Pending);
  assert.deepEqual(result.created.added_edges.at(-1), {
    dependent_id: h.node_id,
    depends_on_id: createdId,
  });
  const approved = (await h.list()).items[0]!;
  assert.equal(approved.created_node_id, createdId);
  assert.notEqual(approved.approved_at, null);
  const claimable = () =>
    h.store.transaction((tx) =>
      claimableMap(tx, h.mission_id, h.dependencies.bindings),
    );
  assert.equal(claimable().get(h.node_id), false);
  assert.equal(claimable().get(createdId), true);
  h.store.transaction((tx) => {
    setNodeState(tx, createdId, NodeState.Completed);
    routeMission(tx, h.mission_id);
  });
  assert.equal(claimable().get(h.node_id), true);
  h.store.transaction((tx) => {
    assert.ok(readOpenAttempt(tx, h.node_id));
    assert.equal(
      readOutcomesOfAttempt(tx, h.node_id, FIRST_ATTEMPT).length,
      SINGLE_PROPOSAL,
    );
  });
});

test("an approval that adds an unmatched pair is refused and writes nothing", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  h.dependencies.bindings.repositoryPolicyOf = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: null,
    landing: "human",
  });
  h.dependencies.schedulerMatch = {
    unmatchedClaims: (tx, projectId) =>
      h.service
        .claimFactsOf(tx, projectId)
        .filter(({ tags }) => tags.includes(DEPENDENCY_TAG))
        .flatMap(({ node_id, revision, claims }) =>
          claims.map((claim) => ({ node_id, revision, claim })),
        ),
  };
  const before = databaseSnapshot(h.store);
  await assert.rejects(h.approve(proposalId), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, MissionErrorCode.TagsUnmatched);
    const details = error.details as unknown as {
      claims: { revision: number; claim: string }[];
    };
    assert.deepEqual(
      details.claims.map(({ revision, claim }) => ({ revision, claim })),
      [
        { revision: FIRST_REVISION, claim: ClaimableState.Available },
        { revision: FIRST_REVISION, claim: ClaimableState.Waiting },
      ],
    );
    return true;
  });
  assert.deepEqual(databaseSnapshot(h.store), before);
});

test("an approval whose new content names mixed environments is refused and keeps the proposal open", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const secondId = createIdentity("binding");
  const identities = new Map([
    [h.repositoryId, RESOURCE_IDENTITY],
    [secondId, "repository:github:owner/other"],
  ]);
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([h.repositoryId, secondId]), h.childId),
  );
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    binding_id: id,
    project_id: h.project_id,
    name: "repo",
    resource_identity: identities.get(id)!,
    revision: FIRST_REVISION,
    tombstone: false,
    disabled: false,
  });
  h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) =>
    projectId === h.project_id && identities.has(id)
      ? { binding_id: id, resource_identity: identities.get(id)! }
      : null;
  h.dependencies.environments = { environmentsMixed: () => true };
  const before = databaseSnapshot(h.store);
  await assert.rejects(h.approve(proposalId), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, MissionErrorCode.EnvironmentMixed);
    assert.deepEqual(error.details, { bindings: [h.repositoryId, secondId] });
    return true;
  });
  assert.deepEqual(databaseSnapshot(h.store), before);
  const open = (await h.list()).items[0]!;
  assert.equal(open.created_node_id, null);
  assert.equal(open.approved_at, null);
});

test("approving twice refuses with already_approved", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.approve(proposalId);
  await refusal(
    h.approve(proposalId, result.created.mission_version),
    MissionErrorCode.ProposalAlreadyApproved,
  );
});

test("approving refuses an unknown proposal, a stale version and a changed proposer state", async (t) => {
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

test("an approve writes one act trace that names the created node and no state before", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.invoke("proposal.approve", {
    params: { proposal_id: proposalId },
    query: {},
    body: { expected_mission_version: FIRST_REVISION, reason: "Fix it." },
  });
  const createdId = result.created.revisions[0]!.node_id;
  const written = actCalls(h);
  assert.equal(written.length, ONE_ACT);
  const [trace, contribution] = written[0]!;
  assert.equal(contribution.operation, Act.ApproveProposal);
  assert.equal(trace.project_id, h.project_id);
  assert.equal(trace.node_id, createdId);
  assert.equal(trace.attempt, null);
  assert.equal(contribution.attributes[ActAttribute.NodeId], createdId);
  assert.equal(ActAttribute.StateFrom in contribution.attributes, false);
  assert.equal(
    contribution.attributes[ActAttribute.MissionVersion],
    result.created.mission_version,
  );
  assert.equal(
    contribution.attributes[ActAttribute.StateTo],
    NodeState.Available,
  );
  assert.deepEqual(contribution.texts, [
    { text_id: `${trace.root_span_id}:reason`, text: "Fix it." },
  ]);
});

test("an approve without a reason writes an act trace without a text", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  await h.approve((await h.list()).items[0]!.id);
  assert.equal(actCalls(h)[0]![1].texts, undefined);
});

test("a refused approve writes no act trace", async (t) => {
  const h = await fixture(t);
  await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  await refusal(
    h.approve(proposalId, FIRST_REVISION + FIRST_REVISION),
    MissionErrorCode.VersionConflict,
  );
  assert.equal(actCalls(h).length, NO_ACTS);
});

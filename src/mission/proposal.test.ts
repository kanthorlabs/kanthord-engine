import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ZodError } from "zod";
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
import { insertProposal } from "./proposal-store.ts";
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
  readDependsOnIds,
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
  const { dependencyOutcomeId, dependencyAssessmentId } = h.store.transaction(
    (tx) => {
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
      return {
        dependencyOutcomeId: outcome.id,
        dependencyAssessmentId: assessmentId,
      };
    },
  );
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
  const decide = (
    assessmentId: string,
    approvedProposalIds: string[],
    version = FIRST_REVISION,
  ) =>
    h.invoke("proposal.decide", {
      params: { assessment_id: assessmentId },
      query: {},
      body: {
        expected_mission_version: version,
        approved_proposal_ids: approvedProposalIds,
      },
    });
  return {
    ...h,
    repositoryId,
    childId,
    dependencyAssessmentId,
    proposal,
    submit,
    list,
    decide,
  };
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

test("a decision adds a dependency of the proposer on the created node and routes the proposer to Pending", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.decide(submitted.assessment.id, [proposalId]);
  assert.equal(result.created.length, SINGLE_PROPOSAL);
  assert.deepEqual(result.rejected_proposal_ids, []);
  const change = result.created[0]!;
  const createdId = change.revisions[0]!.node_id;
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
  assert.equal(change.revisions.at(-1)?.tasks[0]?.id, tasks[0]!.id);
  assert.equal(result.proposer.node.id, h.node_id);
  assert.equal(result.proposer.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(result.proposer.attempt?.start_point, StartPoint.NodeBranch);
  assert.equal(h.node().attempt, SECOND_ATTEMPT);
  assert.equal(h.node().state, NodeState.Pending);
  assert.deepEqual(change.added_edges.at(-1), {
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

test("a decision approves two of three proposals, rejects the third and unblocks the proposer once", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([
    h.proposal(h.childId, "First"),
    h.proposal(h.childId, "Second"),
    h.proposal(h.childId, "Third"),
  ]);
  const byName = new Map(
    (await h.list()).items.map((item) => [item.content.name, item.id]),
  );
  const first = byName.get("First")!;
  const second = byName.get("Second")!;
  const third = byName.get("Third")!;
  const result = await h.decide(submitted.assessment.id, [first, third]);
  assert.equal(result.created.length, TWO_PROPOSALS);
  const createdIds = result.created.map(
    (change) => change.revisions[0]!.node_id,
  );
  const createdNames = h.store.transaction((tx) =>
    createdIds.map((id) => readCurrentRevision(tx, id)!.name),
  );
  assert.deepEqual(createdNames, ["First", "Third"]);
  const dependsOn = h.store.transaction((tx) =>
    readDependsOnIds(tx, h.node_id),
  );
  for (const id of createdIds) assert.ok(dependsOn.includes(id));
  assert.deepEqual(result.rejected_proposal_ids, [second]);
  const records = new Map(
    (await h.list()).items.map((item) => [item.id, item]),
  );
  assert.equal(records.get(first)!.created_node_id, createdIds[0]);
  assert.notEqual(records.get(first)!.approved_at, null);
  assert.equal(records.get(third)!.created_node_id, createdIds[1]);
  assert.notEqual(records.get(third)!.approved_at, null);
  assert.equal(records.get(second)!.approved_at, null);
  assert.notEqual(records.get(second)!.rejected_at, null);
  assert.equal(records.get(second)!.created_node_id, null);
  assert.equal(result.proposer.node.id, h.node_id);
  assert.equal(result.proposer.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(h.node().state, NodeState.Pending);
  assert.equal(h.node().attempt, SECOND_ATTEMPT);
  h.store.transaction((tx) => {
    assert.equal(readOpenAttempt(tx, h.node_id)?.attempt, SECOND_ATTEMPT);
  });
});

test("a decision that adds an unmatched pair is refused and writes nothing", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
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
  await assert.rejects(
    h.decide(submitted.assessment.id, [proposalId]),
    (error) => {
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
    },
  );
  assert.deepEqual(databaseSnapshot(h.store), before);
});

test("a decision whose new content names mixed environments is refused and keeps the proposal open", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
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
  await assert.rejects(
    h.decide(submitted.assessment.id, [proposalId]),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.EnvironmentMixed);
      assert.deepEqual(error.details, {
        bindings: [h.repositoryId, secondId],
      });
      return true;
    },
  );
  assert.deepEqual(databaseSnapshot(h.store), before);
  const open = (await h.list()).items[0]!;
  assert.equal(open.created_node_id, null);
  assert.equal(open.approved_at, null);
  assert.equal(open.rejected_at, null);
});

test("a decision that takes a used filename is refused and writes nothing", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([
    h.proposal(h.childId, "First"),
    h.proposal(h.childId, "Second"),
  ]);
  const byName = new Map(
    (await h.list()).items.map((item) => [item.content.name, item.id]),
  );
  const first = byName.get("First")!;
  const second = byName.get("Second")!;
  const usedFilename = `proposal-${second.slice("proposal_".length).toLowerCase()}.md`;
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    const occupantId = createIdentity("node");
    insertNode(tx, {
      id: occupantId,
      mission_id: h.mission_id,
      filename: usedFilename,
      created_at: NOW,
    });
    insertRevision(tx, {
      ...base,
      node_id: occupantId,
      filename: usedFilename,
      content: { ...base.content, intent: Intent.Implement },
      tasks: [],
    });
  });
  const before = databaseSnapshot(h.store);
  await assert.rejects(
    h.decide(submitted.assessment.id, [first, second]),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.FilenameConflict);
      assert.deepEqual(error.details, { filename: usedFilename });
      return true;
    },
  );
  assert.deepEqual(databaseSnapshot(h.store), before);
  for (const item of (await h.list()).items) {
    assert.equal(item.approved_at, null);
    assert.equal(item.rejected_at, null);
    assert.equal(item.created_node_id, null);
  }
  assert.equal(h.node().state, NodeState.Blocked);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
});

test("a repeated decision refuses with decided", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.decide(submitted.assessment.id, [proposalId]);
  const before = databaseSnapshot(h.store);
  await assert.rejects(
    h.decide(
      submitted.assessment.id,
      [proposalId],
      result.created.at(-1)!.mission_version,
    ),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.ProposalDecided);
      assert.deepEqual(error.details, {
        assessment_id: submitted.assessment.id,
      });
      return true;
    },
  );
  assert.deepEqual(databaseSnapshot(h.store), before);
});

test("a decision refuses an unknown assessment, a foreign proposal, an invalid list, a stale version and a changed proposer state", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  const assessmentId = submitted.assessment.id;
  const proposalId = (await h.list()).items[0]!.id;
  const foreignId = createIdentity("proposal");
  h.store.transaction((tx) =>
    insertProposal(tx, {
      id: foreignId,
      node_id: h.childId,
      attempt: NO_ATTEMPT,
      assessment_id: h.dependencyAssessmentId,
      content: canonicalJSON(h.proposal()),
      created_node_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: NOW,
    }),
  );
  const refusedWithoutWrite = async (
    promise: Promise<unknown>,
    check: (error: unknown) => boolean,
  ) => {
    const before = databaseSnapshot(h.store);
    await assert.rejects(promise, check);
    assert.deepEqual(databaseSnapshot(h.store), before);
  };
  const operationError =
    (code: string, details?: unknown) => (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, code);
      if (details !== undefined) assert.deepEqual(error.details, details);
      return true;
    };
  const invalidList = (error: unknown) => {
    assert.ok(error instanceof ZodError);
    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      [["body", "approved_proposal_ids"]],
    );
    return true;
  };
  await refusedWithoutWrite(
    h.decide(createIdentity("assessment"), [proposalId]),
    operationError(MissionErrorCode.RecordNotFound),
  );
  await refusedWithoutWrite(
    h.decide(assessmentId, [proposalId, foreignId]),
    operationError(MissionErrorCode.ProposalAssessmentMismatch, {
      proposal_ids: [foreignId],
    }),
  );
  await refusedWithoutWrite(h.decide(assessmentId, []), invalidList);
  await refusedWithoutWrite(
    h.decide(assessmentId, [proposalId, proposalId]),
    invalidList,
  );
  await refusedWithoutWrite(
    h.decide(assessmentId, [proposalId], FIRST_REVISION + FIRST_REVISION),
    operationError(MissionErrorCode.VersionConflict),
  );
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  await refusedWithoutWrite(
    h.decide(assessmentId, [proposalId]),
    operationError(ControlError.StateConflict, {
      state: NodeState.Paused,
      attempt: FIRST_ATTEMPT,
    }),
  );
  const record = (await h.list()).items[0]!;
  assert.equal(record.approved_at, null);
  assert.equal(record.rejected_at, null);
});

test("a decision writes one act trace that names the proposer and the state Blocked", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  const result = await h.invoke("proposal.decide", {
    params: { assessment_id: submitted.assessment.id },
    query: {},
    body: {
      expected_mission_version: FIRST_REVISION,
      approved_proposal_ids: [proposalId],
      reason: "Fix it.",
    },
  });
  const written = actCalls(h);
  assert.equal(written.length, ONE_ACT);
  const [trace, contribution] = written[0]!;
  assert.equal(contribution.operation, Act.DecideProposals);
  assert.equal(trace.project_id, h.project_id);
  assert.equal(trace.node_id, h.node_id);
  assert.equal(trace.attempt, SECOND_ATTEMPT);
  assert.equal(contribution.attributes[ActAttribute.NodeId], h.node_id);
  assert.equal(
    contribution.attributes[ActAttribute.StateFrom],
    NodeState.Blocked,
  );
  assert.equal(
    contribution.attributes[ActAttribute.StateTo],
    result.proposer.node.state,
  );
  assert.equal(
    contribution.attributes[ActAttribute.MissionVersion],
    result.created.at(-1)!.mission_version,
  );
  assert.deepEqual(contribution.texts, [
    { text_id: `${trace.root_span_id}:reason`, text: "Fix it." },
  ]);
});

test("a decision without a reason writes an act trace without a text", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  await h.decide(submitted.assessment.id, [(await h.list()).items[0]!.id]);
  assert.equal(actCalls(h)[0]![1].texts, undefined);
});

test("a refused decision writes no act trace", async (t) => {
  const h = await fixture(t);
  const submitted = await h.submit([h.proposal()]);
  const proposalId = (await h.list()).items[0]!.id;
  await refusal(
    h.decide(
      submitted.assessment.id,
      [proposalId],
      FIRST_REVISION + FIRST_REVISION,
    ),
    MissionErrorCode.VersionConflict,
  );
  assert.equal(actCalls(h).length, NO_ACTS);
});

const proposerActs = [
  {
    name: "an unblock",
    operation: "node.unblock",
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expected_mission_version: FIRST_REVISION,
    },
  },
  {
    name: "a discard",
    operation: "node.discard",
    body: {
      reason: "Drop it.",
      expected_mission_version: FIRST_REVISION,
      expected_state: NodeState.Blocked,
      expected_attempt: FIRST_ATTEMPT,
    },
  },
  {
    name: "an override",
    operation: "node.override",
    body: {
      reason: "Done by hand.",
      expected_mission_version: FIRST_REVISION,
      expected_state: NodeState.Blocked,
      expected_attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
    },
  },
] as const;

for (const act of proposerActs)
  test(`${act.name} of the proposer rejects every open proposal`, async (t) => {
    const h = await fixture(t);
    await h.submit([h.proposal(), h.proposal(h.childId, "Other")]);
    await h.invoke(act.operation, {
      params: { node_id: h.node_id },
      query: {},
      body: act.body,
    });
    const items = (await h.list(FIRST_ATTEMPT)).items;
    assert.equal(items.length, TWO_PROPOSALS);
    for (const item of items) {
      assert.notEqual(item.rejected_at, null);
      assert.equal(item.approved_at, null);
    }
  });

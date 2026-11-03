import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  AssessmentResult,
  AssetKind,
  FindingAction,
  FindingCauseOwner,
  type FindingCreate,
  FindingDecision,
  FindingKind,
  FindingRoute,
  FindingSource,
  FindingStatus,
  MissionErrorCode,
  NodeState,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { setNodeState } from "./store.ts";
import {
  actCalls,
  codedAs,
  controlHarness,
  markDelivered,
  refusedAt,
  reviewerFinding,
  reviewHarness,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_HUMAN_LABEL = "H1";
const RENAMED = "Renamed";
const MISSION_VERSION = 1;
const STALE_VERSION = 2;
const FIRST_ATTEMPT = 1;
const FIRST_REVISION = 1;
const SECOND_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const REWORK_OFF = 0;
const LATER_COMMIT = "b".repeat(40);
const TWO_CREATES = 2;
const ONE_UPDATE = 1;

function report(assessmentId: string): FindingCreate {
  return {
    expected_mission_version: MISSION_VERSION,
    assessment_id: assessmentId,
    kind: FindingKind.Blocker,
    task_id: null,
    name: "Missed",
    description: "Found after delivery",
    fix: "Change it",
    why: "It breaks",
    cause_owner: FindingCauseOwner.Agent,
  };
}

test("a human creates findings H1 and H2 on a delivered attempt and the create keeps the mission version", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  assert.equal(h.node().state, NodeState.Available);
  markDelivered(h, FIRST_ATTEMPT);
  const create = (body: FindingCreate, nodeId = h.node_id) =>
    h.invoke("finding.create", {
      params: { node_id: nodeId },
      query: {},
      body,
    });
  const h1 = await create(report(a1.assessment.id));
  const h2 = await create(report(a1.assessment.id));
  assert.deepEqual([h1.label, h2.label], ["H1", "H2"]);
  assert.equal(h1.source, FindingSource.Human);
  assert.equal(h1.action, FindingAction.Yes);
  assert.equal(h1.ground, null);
  assert.equal(h1.route, FindingRoute.Report);
  assert.equal(h1.round, null);
  assert.equal(h1.attempt, FIRST_ATTEMPT);
  assert.deepEqual(h1.created_by, {
    kind: ActorKind.Human,
    account: "ulrich",
    name: "Ulrich",
  });
  const mission = await h.invoke("get", {
    params: { project_id: h.project_id },
    query: {},
    body: null,
  });
  assert.equal(mission.version, MISSION_VERSION);
  await assert.rejects(
    create({
      ...report(a1.assessment.id),
      expected_mission_version: STALE_VERSION,
    }),
    codedAs(MissionErrorCode.VersionConflict),
  );
  await assert.rejects(
    create(report(a1.assessment.id), h.examine_id),
    refusedAt("assessment_id"),
  );
  await assert.rejects(
    create(report(createIdentity("assessment"))),
    refusedAt("assessment_id"),
  );
  await assert.rejects(
    create({ ...report(a1.assessment.id), task_id: createIdentity("task") }),
    refusedAt("task_id"),
  );
  await assert.rejects(
    create(report(a1.assessment.id), createIdentity("node")),
    codedAs(MissionErrorCode.NodeNotFound),
  );
  const creates = actCalls(h).filter(
    ([, contribution]) => contribution.operation === Act.CreateFinding,
  );
  assert.equal(creates.length, TWO_CREATES);
  for (const [, contribution] of creates)
    assert.equal(
      contribution.attributes[ActAttribute.StateFrom],
      contribution.attributes[ActAttribute.StateTo],
    );
});

test("a human creates a finding on a Completed node and a Blocked node with no landed commit answers 400", async (t) => {
  const completed = await reviewHarness(t, IDENTITY);
  completed.dependencies.config.rework_limit = REWORK_OFF;
  const closing = await completed.submit();
  assert.equal(completed.node().state, NodeState.Completed);
  const onCompleted = await completed.invoke("finding.create", {
    params: { node_id: completed.node_id },
    query: {},
    body: report(closing.assessment.id),
  });
  assert.equal(onCompleted.label, FIRST_HUMAN_LABEL);
  const blocked = await reviewHarness(t, IDENTITY);
  blocked.store.transaction((tx) =>
    setNodeState(tx, blocked.node_id, NodeState.Paused),
  );
  const block = await blocked.invoke("node.block", {
    params: { node_id: blocked.node_id },
    query: {},
    body: {
      reason: "Hold",
      expected_mission_version: MISSION_VERSION,
      expected_state: NodeState.Paused,
      expected_attempt: FIRST_ATTEMPT,
    },
  });
  assert.ok(block.outcome);
  await assert.rejects(
    blocked.invoke("finding.create", {
      params: { node_id: blocked.node_id },
      query: {},
      body: report(block.outcome.assessment_id),
    }),
    refusedAt("assessment_id"),
  );
});

test("a human finding on an unjudged round changes neither the next review base nor any status", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  h.evaluate();
  const address = { ...h.address, commit: LATER_COMMIT };
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verified again",
      assets: [{ kind: AssetKind.Repository, address }],
      verification: {
        tested_input: address,
        results: [
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
  });
  const unjudged = await h.submit({
    ...h.notMet,
    evidence_ids: [evidence.evidence.id],
    tested_input: address,
  });
  markDelivered(h, FIRST_ATTEMPT);
  await h.invoke("finding.create", {
    params: { node_id: h.node_id },
    query: {},
    body: report(unjudged.assessment.id),
  });
  h.evaluate();
  const round = await h.reviewRound();
  assert.deepEqual(round.review_base, h.address);
  assert.deepEqual(
    round.findings.map((item) => [item.label, item.status]),
    [["B1", FindingStatus.Open]],
  );
});

test("a human updates the cause owner and the texts of a human finding until a decision", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  markDelivered(h, FIRST_ATTEMPT);
  const h1 = await h.invoke("finding.create", {
    params: { node_id: h.node_id },
    query: {},
    body: report(a1.assessment.id),
  });
  const update = (id: string, body: Record<string, unknown>) =>
    h.invoke("finding.update", {
      params: { finding_id: id },
      query: {},
      body: { expected_mission_version: MISSION_VERSION, ...body },
    });
  const updated = await update(h1.id, {
    cause_owner: FindingCauseOwner.Plan,
    kind: FindingKind.Suggestion,
    name: "Renamed",
  });
  assert.equal(updated.cause_owner, FindingCauseOwner.Plan);
  assert.equal(updated.kind, FindingKind.Suggestion);
  assert.equal(updated.name, RENAMED);
  assert.equal(updated.description, h1.description);
  assert.equal(updated.label, FIRST_HUMAN_LABEL);
  const b1 = await h.byLabel("B1");
  await assert.rejects(
    update(b1.id, { name: "Renamed" }),
    codedAs(MissionErrorCode.FindingNotHuman),
  );
  await assert.rejects(
    update(h1.id, { name: "Renamed", expected_mission_version: STALE_VERSION }),
    codedAs(MissionErrorCode.VersionConflict),
  );
  await assert.rejects(
    update(createIdentity("finding"), { name: "Renamed" }),
    codedAs(MissionErrorCode.RecordNotFound),
  );
  await h.invoke("finding.decide", {
    params: { finding_id: h1.id },
    query: {},
    body: {
      decision: FindingDecision.Accepted,
      decision_reason: "A defect",
    },
  });
  await assert.rejects(
    update(h1.id, { name: "Again" }),
    codedAs(MissionErrorCode.FindingDecided),
  );
  assert.equal(
    actCalls(h).filter(
      ([, contribution]) => contribution.operation === Act.UpdateFinding,
    ).length,
    ONE_UPDATE,
  );
});

function discardOf(state: NodeState) {
  return {
    reason: "Drop it",
    expected_mission_version: MISSION_VERSION,
    expected_state: state,
    expected_attempt: FIRST_ATTEMPT,
  };
}

function createOn(
  h: Awaited<ReturnType<typeof reviewHarness>>,
  assessmentId: string,
) {
  return h.invoke("finding.create", {
    params: { node_id: h.node_id },
    query: {},
    body: report(assessmentId),
  });
}

test("an assessment of an attempt with no landed commit and no successful outcome answers 400", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  assert.equal(h.node().state, NodeState.Available);
  await assert.rejects(
    createOn(h, a1.assessment.id),
    refusedAt("assessment_id"),
  );
});

test("a success override at attempt 0 admits its human assessment", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Pending));
  const override = await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Pending, NO_ATTEMPT),
      result: AssessmentResult.Success,
    },
  });
  assert.equal(h.node().state, NodeState.Completed);
  assert.ok(override.outcome);
  const finding = await h.invoke("finding.create", {
    params: { node_id: h.node_id },
    query: {},
    body: report(override.outcome.assessment_id),
  });
  assert.equal(finding.attempt, NO_ATTEMPT);
});

test("a success override of a node blocked at attempt 0 admits both human assessments", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  const block = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, NO_ATTEMPT),
  });
  assert.equal(h.node().state, NodeState.Blocked);
  assert.ok(block.outcome);
  const override = await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Blocked, NO_ATTEMPT),
      result: AssessmentResult.Success,
    },
  });
  assert.equal(h.node().state, NodeState.Completed);
  assert.ok(override.outcome);
  for (const assessmentId of [
    block.outcome.assessment_id,
    override.outcome.assessment_id,
  ]) {
    const finding = await h.invoke("finding.create", {
      params: { node_id: h.node_id },
      query: {},
      body: report(assessmentId),
    });
    assert.equal(finding.attempt, NO_ATTEMPT);
  }
});

test("a reopened node admits only its delivered attempt", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  h.dependencies.config.rework_limit = REWORK_OFF;
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  assert.equal(h.node().state, NodeState.Blocked);
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expected_mission_version: MISSION_VERSION,
    },
  });
  h.claim.attempt = SECOND_ATTEMPT;
  h.evaluate();
  const context = { ...h.context, attempt: SECOND_ATTEMPT };
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address: h.address }],
      verification: {
        tested_input: h.address,
        results: [
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
  });
  const a2 = await h.submit({
    ...context,
    evidence_ids: [evidence.evidence.id],
  });
  assert.equal(h.node().state, NodeState.Completed);
  const finding = await createOn(h, a2.assessment.id);
  assert.equal(finding.attempt, SECOND_ATTEMPT);
  await assert.rejects(
    createOn(h, a1.assessment.id),
    refusedAt("assessment_id"),
  );
});

test("a success override of a Blocked node admits its execution assessment", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  h.dependencies.config.rework_limit = REWORK_OFF;
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  assert.equal(h.node().state, NodeState.Blocked);
  const override = await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      reason: "Done by hand",
      expected_mission_version: MISSION_VERSION,
      expected_state: NodeState.Blocked,
      expected_attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
    },
  });
  assert.equal(h.node().state, NodeState.Completed);
  assert.ok(override.outcome);
  for (const assessmentId of [a1.assessment.id, override.outcome.assessment_id])
    assert.equal((await createOn(h, assessmentId)).attempt, FIRST_ATTEMPT);
});

test("a discarded node with no landed commit answers 400", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  const discard = await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: discardOf(NodeState.Available),
  });
  assert.equal(h.node().state, NodeState.Discarded);
  assert.ok(discard.outcome);
  for (const assessmentId of [a1.assessment.id, discard.outcome.assessment_id])
    await assert.rejects(createOn(h, assessmentId), refusedAt("assessment_id"));
});

test("an evidence delete of the landed commit refuses a new create and keeps the stored finding", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  const landed = markDelivered(h, FIRST_ATTEMPT);
  const h1 = await createOn(h, a1.assessment.id);
  await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: discardOf(NodeState.Available),
  });
  await h.invoke("evidence.delete", {
    params: { evidence_id: landed },
    query: {},
    body: {
      expected_mission_version: MISSION_VERSION,
      force: true,
      reason: "Remove",
    },
  });
  await assert.rejects(
    createOn(h, a1.assessment.id),
    refusedAt("assessment_id"),
  );
  const stored = await h.invoke("finding.get", {
    params: { finding_id: h1.id },
    query: {},
    body: null,
  });
  assert.deepEqual(stored, h1);
});

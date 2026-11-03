import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
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

test("a human creates findings H1 and H2 on an Available node and the create keeps the mission version", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  assert.equal(h.node().state, NodeState.Available);
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

test("a human creates a finding on a Completed node and on a Blocked node with a human assessment", async (t) => {
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
  const onBlocked = await blocked.invoke("finding.create", {
    params: { node_id: blocked.node_id },
    query: {},
    body: report(block.outcome.assessment_id),
  });
  assert.equal(onBlocked.label, FIRST_HUMAN_LABEL);
  assert.equal(onBlocked.round, null);
  assert.equal(onBlocked.attempt, FIRST_ATTEMPT);
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

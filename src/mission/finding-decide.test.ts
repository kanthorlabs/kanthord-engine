import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  FindingAction,
  FindingDecision,
  MissionErrorCode,
  NodeState,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import {
  actCalls,
  codedAs,
  reviewerFinding,
  reviewHarness,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ACCEPTED_REASON = "Reason accepted";
const NUMBER_TYPE = "number";
const REWORK_OFF = 0;
const TWO_DECISIONS = 2;

test("a human decides a reported finding of a Completed node once", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  h.dependencies.config.rework_limit = REWORK_OFF;
  const closing = await h.submit({
    findings: [
      reviewerFinding("S1"),
      reviewerFinding("S2"),
      reviewerFinding("S3", { action: FindingAction.No }),
    ],
  });
  assert.ok("state" in closing.node);
  assert.equal(closing.node.state, NodeState.Completed);
  const decide = (id: string, decision: FindingDecision) =>
    h.invoke("finding.decide", {
      params: { finding_id: id },
      query: {},
      body: { decision, decision_reason: `Reason ${decision}` },
    });
  const [s1, s2, s3] = [
    await h.byLabel("S1"),
    await h.byLabel("S2"),
    await h.byLabel("S3"),
  ];
  const accepted = await decide(s1.id, FindingDecision.Accepted);
  assert.equal(accepted.decision, FindingDecision.Accepted);
  assert.equal(accepted.decision_reason, ACCEPTED_REASON);
  assert.deepEqual(accepted.decided_by, {
    kind: ActorKind.Human,
    account: "ulrich",
    name: "Ulrich",
  });
  assert.equal(typeof accepted.decided_at, NUMBER_TYPE);
  const dismissed = await decide(s2.id, FindingDecision.Dismissed);
  assert.equal(dismissed.decision, FindingDecision.Dismissed);
  await assert.rejects(
    decide(s1.id, FindingDecision.Dismissed),
    codedAs(MissionErrorCode.FindingDecided),
  );
  await assert.rejects(
    decide(s3.id, FindingDecision.Accepted),
    codedAs(MissionErrorCode.FindingNotReported),
  );
  await assert.rejects(
    decide(createIdentity("finding"), FindingDecision.Accepted),
    codedAs(MissionErrorCode.RecordNotFound),
  );
  assert.equal(h.node().state, NodeState.Completed);
  const acts = actCalls(h).filter(
    ([, contribution]) => contribution.operation === Act.DecideFinding,
  );
  assert.equal(acts.length, TWO_DECISIONS);
  const [, contribution] = acts[0]!;
  assert.equal(contribution.attributes[ActAttribute.NodeId], h.node_id);
  assert.equal(
    contribution.attributes[ActAttribute.StateFrom],
    NodeState.Completed,
  );
  assert.equal(
    contribution.attributes[ActAttribute.StateTo],
    NodeState.Completed,
  );
  assert.equal(contribution.texts?.[0]?.text, ACCEPTED_REASON);
  const undecided = await h.invoke("finding.undecided.list", {
    params: { project_id: h.project_id },
    query: {},
    body: null,
  });
  assert.deepEqual(undecided.items, []);
});

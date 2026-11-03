import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity, identityTime } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  FindingCauseOwner,
  FindingKind,
  FindingSource,
  FindingStatus,
  MissionErrorCode,
} from "./contract.ts";
import { closeAttempt, openAttempt } from "./record-store.ts";
import { codedAs, reviewerFinding, reviewHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_BLOCKER_LABEL = "B1";
const SECOND_HUMAN_LABEL = "H2";
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const FIRST_ROUND = 1;
const SECOND_ROUND = 2;
const FIRST_REVISION = 1;
const CLOSED_AT = 200;
const PAGE_SIZE = "2";
const SINGLE = "1";

async function twoAttempts(t: Parameters<typeof reviewHarness>[0]) {
  const h = await reviewHarness(t, IDENTITY);
  const a1 = await h.submit({
    ...h.notMet,
    findings: [
      reviewerFinding("S1"),
      reviewerFinding("B10"),
      reviewerFinding("B2"),
    ],
  });
  h.evaluate();
  const a2 = await h.submit({ ...h.notMet, findings: [reviewerFinding("S1")] });
  h.store.transaction((tx) => {
    closeAttempt(tx, h.node_id, FIRST_ATTEMPT, CLOSED_AT);
    openAttempt(tx, h.node_id, FIRST_REVISION, h.executionActor, CLOSED_AT);
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
  const a3 = await h.submit({
    ...h.notMet,
    ...context,
    evidence_ids: [evidence.evidence.id],
    findings: [reviewerFinding("B1")],
  });
  const report = (assessmentId: string) =>
    h.invoke("finding.create", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        expected_mission_version: FIRST_REVISION,
        assessment_id: assessmentId,
        kind: FindingKind.Suggestion,
        task_id: null,
        name: "Missed",
        description: "Found after delivery",
        fix: "Change it",
        why: "It breaks",
        cause_owner: FindingCauseOwner.Agent,
      },
    });
  const h1 = await report(a1.assessment.id);
  return { ...h, a1, a2, a3, h1, report };
}

test("the finding list filters by attempt and round, orders by round, kind and label number and pages", async (t) => {
  const h = await twoAttempts(t);
  const labels = (items: { label: string }[]) =>
    items.map((item) => item.label);
  assert.deepEqual(labels(await h.findings()), [
    "B1",
    "B2",
    "B10",
    "S1",
    "S1",
    "H1",
  ]);
  assert.deepEqual(
    labels(await h.findings({ attempt: String(FIRST_ATTEMPT) })),
    ["B2", "B10", "S1", "S1", "H1"],
  );
  assert.deepEqual(
    labels(await h.findings({ attempt: String(SECOND_ATTEMPT) })),
    ["B1"],
  );
  const second = await h.findings({ round: String(SECOND_ROUND) });
  assert.deepEqual(labels(second), ["S1"]);
  assert.equal(second[0]?.assessment_id, h.a2.assessment.id);
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { label: string }[]; next_cursor: string | null } =
      await h.invoke("finding.list", {
        params: { node_id: h.node_id },
        query: {
          limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        },
        body: null,
      });
    pages.push(labels(page.items));
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(pages, [
    ["B1", "B2"],
    ["B10", "S1"],
    ["S1", "H1"],
  ]);
  await assert.rejects(
    h.invoke("finding.list", {
      params: { node_id: createIdentity("node") },
      query: {},
      body: null,
    }),
    codedAs(MissionErrorCode.NodeNotFound),
  );
});

test("the read computes the attempt, the round, the status, the source and the creation time", async (t) => {
  const h = await twoAttempts(t);
  const items = await h.findings();
  const b1 = items.find((item) => item.label === FIRST_BLOCKER_LABEL);
  assert.equal(b1?.attempt, SECOND_ATTEMPT);
  assert.equal(b1?.round, FIRST_ROUND);
  assert.equal(b1?.source, FindingSource.Reviewer);
  assert.equal(b1?.status, FindingStatus.Open);
  assert.equal(b1?.created_by, null);
  const human = await h.invoke("finding.get", {
    params: { finding_id: h.h1.id },
    query: {},
    body: null,
  });
  assert.deepEqual(human, h.h1);
  assert.equal(human.attempt, FIRST_ATTEMPT);
  assert.equal(human.round, null);
  assert.equal(human.source, FindingSource.Human);
  assert.equal(human.cause_owner, FindingCauseOwner.Agent);
  for (const item of items)
    assert.equal(item.created_at, identityTime(item.id));
  const rounds = (
    await h.invoke("assessment.list", {
      params: { node_id: h.node_id },
      query: {},
      body: null,
    })
  ).items.map((item) => [item.id, item.attempt, item.round]);
  assert.deepEqual(rounds, [
    [h.a3.assessment.id, SECOND_ATTEMPT, FIRST_ROUND],
    [h.a2.assessment.id, FIRST_ATTEMPT, SECOND_ROUND],
    [h.a1.assessment.id, FIRST_ATTEMPT, FIRST_ROUND],
  ]);
  assert.equal(h.a1.assessment.round, FIRST_ROUND);
  assert.equal(h.a2.assessment.round, SECOND_ROUND);
  await assert.rejects(
    h.invoke("finding.get", {
      params: { finding_id: createIdentity("finding") },
      query: {},
      body: null,
    }),
    codedAs(MissionErrorCode.RecordNotFound),
  );
});

test("the undecided list holds the human findings of the project in identity order with the last identity as the cursor", async (t) => {
  const h = await twoAttempts(t);
  const h2 = await h.report(h.a3.assessment.id);
  assert.equal(h2.label, SECOND_HUMAN_LABEL);
  assert.equal(h2.attempt, SECOND_ATTEMPT);
  const first = await h.invoke("finding.undecided.list", {
    params: { project_id: h.project_id },
    query: { limit: SINGLE },
    body: null,
  });
  const [newer, older] = [h.h1, h2].sort((left, right) =>
    left.id < right.id ? 1 : -1,
  );
  assert.ok(newer && older);
  assert.deepEqual(
    first.items.map((item) => item.id),
    [newer.id],
  );
  assert.equal(first.items[0]?.attempt, newer.attempt);
  assert.ok(first.next_cursor);
  const second = await h.invoke("finding.undecided.list", {
    params: { project_id: h.project_id },
    query: { limit: SINGLE, cursor: first.next_cursor },
    body: null,
  });
  assert.deepEqual(
    second.items.map((item) => item.id),
    [older.id],
  );
  assert.equal(second.next_cursor, null);
  await assert.rejects(
    h.invoke("finding.undecided.list", {
      params: { project_id: createIdentity("project") },
      query: {},
      body: null,
    }),
    codedAs(MissionErrorCode.MissionNotFound),
  );
});

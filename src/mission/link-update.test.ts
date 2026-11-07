import assert from "node:assert/strict";
import { test } from "node:test";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { createIdentity, identityTime } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import {
  AdmissionRefusal,
  Disposition,
  linkUpdateRowSchema,
  NodeState,
  type PlatformAddress,
  PlatformAddressKind,
} from "./contract.ts";
import { DELIVERY_ADMIT_OPERATION } from "./delivery-telemetry.ts";
import {
  LINK_ACTOR,
  LINK_EVENT_BODY,
  LINK_MENTION,
  LINK_OCCURRED_AT,
  LINK_UPDATE_KEY,
  linkOf,
  linkUpdateHarness,
  OTHER_LINK_NUMBER,
  updateOf,
} from "./link-update-test-support.ts";
import { actCalls, databaseSnapshot } from "./test-support.ts";

const INTAKE_IDENTITY = testServiceIdentity(INTAKE_SERVICE_NAME);
const NO_ROWS = 0;
const NO_CALLS = 0;
const SINGLE_ROW = 1;
const CLOCK_TOLERANCE_MS = 60000;
const LINK_TABLE = "mission_link_update";
const CLAIM_CALLS = new Set([
  "schedulerClaims.revoke",
  "schedulerClaims.executionRevoked",
  "schedulerClaims.executionsLost",
  "schedulerClaims.settle",
]);
const UNLINKED_STATES = [
  NodeState.Blocked,
  NodeState.Completed,
  NodeState.Discarded,
] as const;

function withoutLinkRows(snapshot: Record<string, unknown[]>) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([name]) => name !== LINK_TABLE),
  );
}

test("a human update on a linked thread inserts one row and changes no node", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const nodeId = h.addNode([linkOf()]);
  h.decoding.update = updateOf();
  const before = withoutLinkRows(databaseSnapshot(h.store));
  const inboundEventId = createIdentity("inbound_event");
  const started = Date.now();
  const answer = await h.admit(inboundEventId);
  assert.deepEqual(answer, {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  const [row] = h.rows();
  assert.equal(h.rows().length, SINGLE_ROW);
  assert.ok(linkUpdateRowSchema.safeParse(row).success);
  assert.deepEqual(
    { ...row, id: null },
    {
      id: null,
      mission_id: h.mission_id,
      external_link: canonicalJSON(linkOf()),
      update_key: LINK_UPDATE_KEY,
      inbound_event_id: inboundEventId,
      actor_id: LINK_ACTOR,
      occurred_at: LINK_OCCURRED_AT,
    },
  );
  assert.ok(
    Math.abs(identityTime(String(row?.id)) - started) < CLOCK_TOLERANCE_MS,
  );
  assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
  assert.equal(h.node().state, NodeState.Available);
  assert.equal(h.intakeChecks.length, NO_CALLS);
  assert.equal(
    h.store.database
      .prepare("SELECT state FROM mission_node WHERE id = ?")
      .get(nodeId)?.state,
    NodeState.Available,
  );
});

test("a node in Executing keeps its claim, attempt and execution", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const nodeId = h.addNode([linkOf()], NodeState.Executing);
  h.decoding.update = updateOf();
  const before = withoutLinkRows(databaseSnapshot(h.store));
  const callsBefore = h.calls.length;
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
  assert.equal(
    h.calls.slice(callsBefore).filter((call) => CLAIM_CALLS.has(call.method))
      .length,
    NO_CALLS,
  );
  assert.equal(
    h.store.database
      .prepare("SELECT state FROM mission_node WHERE id = ?")
      .get(nodeId)?.state,
    NodeState.Executing,
  );
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("an actor that no link_trust names gets a row too", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf({ actor_id: "424242" });
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("two nodes that link the thread give one row", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.addNode([linkOf(), linkOf(OTHER_LINK_NUMBER)]);
  h.decoding.update = updateOf();
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  assert.equal(h.rows().length, SINGLE_ROW);
});

for (const state of UNLINKED_STATES) {
  test(`a ${state} node that links the thread gives one row and keeps its state`, async (t) => {
    const h = linkUpdateHarness(t, INTAKE_IDENTITY);
    const nodeId = h.addNode([linkOf()], state);
    h.decoding.update = updateOf();
    const before = withoutLinkRows(databaseSnapshot(h.store));
    const answer = await h.admit();
    assert.equal(answer.disposition, Disposition.AcceptedObservation);
    assert.equal(h.rows().length, SINGLE_ROW);
    assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
    assert.equal(
      h.store.database
        .prepare("SELECT state FROM mission_node WHERE id = ?")
        .get(nodeId)?.state,
      state,
    );
  });
}

test("a thread that only a retired node links answers unmatched", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.retire(h.addNode([linkOf()]));
  h.decoding.update = updateOf();
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.rows().length, NO_ROWS);
});

test("a repeat with the same update_key answers duplicate and inserts nothing", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf();
  await h.admit();
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Duplicate,
    reason: null,
  });
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("a duplicate answers before the match check", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.retire(h.addNode([linkOf()]));
  h.decoding.update = updateOf();
  h.store.database
    .prepare(
      "INSERT INTO mission_link_update (id, mission_id, external_link, update_key, inbound_event_id, actor_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      createIdentity("link_update"),
      h.mission_id,
      canonicalJSON(linkOf()),
      LINK_UPDATE_KEY,
      createIdentity("inbound_event"),
      LINK_ACTOR,
      LINK_OCCURRED_AT,
    );
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.Duplicate);
});

for (const [name, overrides] of [
  ["an automated actor", { actor_automated: true }],
  ["a null actor_id", { actor_id: null }],
] as const) {
  test(`${name} answers actor_ignored and inserts nothing`, async (t) => {
    const h = linkUpdateHarness(t, INTAKE_IDENTITY);
    h.addNode([linkOf()]);
    h.decoding.update = updateOf(overrides);
    const answer = await h.admit();
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.ActorIgnored,
    });
    assert.equal(h.rows().length, NO_ROWS);
  });
}

test("an object that no node links answers unmatched", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf(OTHER_LINK_NUMBER)]);
  h.decoding.update = updateOf();
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.rows().length, NO_ROWS);
});

test("an event that decodes to nothing answers undecodable", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Undecodable,
  });
  assert.equal(h.rows().length, NO_ROWS);
});

for (const [name, overrides] of [
  ["an ignored actor", { actor_automated: true }],
  ["an unmatched thread", { external_link: linkOf(OTHER_LINK_NUMBER) }],
] as const) {
  test(`the span of ${name} holds its actor_id and no update content`, async (t) => {
    const h = linkUpdateHarness(t, INTAKE_IDENTITY);
    h.addNode([linkOf()]);
    h.decoding.update = updateOf(overrides);
    const answer = await h.admit();
    assert.equal(answer.disposition, Disposition.Refused);
    const [call] = actCalls(h);
    assert.equal(actCalls(h).length, SINGLE_ROW);
    const [trace, contribution] = call!;
    assert.equal(trace.project_id, h.project_id);
    assert.equal(contribution.operation, DELIVERY_ADMIT_OPERATION);
    assert.ok(Object.values(contribution.attributes).includes(LINK_ACTOR));
    const text = JSON.stringify(call);
    for (const content of [
      LINK_EVENT_BODY,
      Buffer.from(LINK_EVENT_BODY).toString("base64"),
      LINK_MENTION,
      LINK_UPDATE_KEY,
    ])
      assert.ok(!text.includes(content), content);
  });
}

test("an accepted link update writes no span", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf();
  await h.admit();
  assert.equal(actCalls(h).length, NO_CALLS);
});

test("an event that decodes to a request address follows the request path", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  const address: PlatformAddress = {
    kind: PlatformAddressKind.PullRequest,
    resource_identity: "repository:github:acme/app",
    number: OTHER_LINK_NUMBER,
  };
  h.decoding.address = address;
  h.decoding.update = updateOf();
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.decoding.updateCalls, NO_CALLS);
  assert.equal(h.rows().length, NO_ROWS);
});

test("admission calls no Intake check for a link update", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf();
  await h.admit();
  h.decoding.update = updateOf({ update_key: "issue_comment:5002" });
  await h.admit();
  assert.equal(h.intakeChecks.length, NO_CALLS);
  assert.equal(h.rows().length, SINGLE_ROW + SINGLE_ROW);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { createIdentity, identityTime } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
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
  LINK_RESOURCE,
  LINK_UPDATE_KEY,
  linkOf,
  linkUpdateHarness,
  OTHER_ACTOR,
  OTHER_LINK_NUMBER,
  TRUSTED_ACTOR,
  updateOf,
} from "./link-update-test-support.ts";
import { actCalls, databaseSnapshot } from "./test-support.ts";

const HUMAN_IDENTITY = testHumanIdentity("ulrich", "Ulrich", "jti_ulrich");
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

const FIRST_OCCURRED_AT = 1700000001000;
const SECOND_OCCURRED_AT = 1700000002000;
const THIRD_OCCURRED_AT = 1700000003000;
const BINDING_REVISION_TWO = 2;
const SECOND_MISSION_VERSION = 1;
const BOTH_ROWS = 2;
const OTHER_RESOURCE = "conversation:github:acme/other";

function actorsOf(page: { items: { actor_id: string }[] }) {
  return page.items.map((item) => item.actor_id);
}

test("a node reads the row of a trusted actor and not the row of another actor", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const binding = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  h.addNode([linkOf()], NodeState.Available, [binding]);
  const nodeId = h.addNode([linkOf()], NodeState.Available, [binding]);
  h.insertUpdate(linkOf(), OTHER_ACTOR, FIRST_OCCURRED_AT);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, SECOND_OCCURRED_AT);
  assert.deepEqual(actorsOf(await h.listedOf(nodeId)), [TRUSTED_ACTOR]);
});

test("a binding write does not change a pinned node and a rebind reads the older row too", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const pinned = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const written = h.addBinding(
    LINK_RESOURCE,
    [TRUSTED_ACTOR, OTHER_ACTOR],
    BINDING_REVISION_TWO,
  );
  const nodeId = h.addNode([linkOf()], NodeState.Available, [pinned]);
  h.insertUpdate(linkOf(), OTHER_ACTOR, FIRST_OCCURRED_AT);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, SECOND_OCCURRED_AT);
  assert.deepEqual(actorsOf(await h.listedOf(nodeId)), [TRUSTED_ACTOR]);
  const revisionBefore = h.currentRevision(nodeId);
  await h.invoke("node.rebind", {
    params: { mission_id: h.mission_id },
    query: {},
    body: {
      binding_id: written,
      node_id: nodeId,
      reason: "Trust the second actor",
      expected_mission_version: SECOND_MISSION_VERSION,
    },
  });
  assert.ok(h.currentRevision(nodeId) > revisionBefore);
  assert.deepEqual(actorsOf(await h.listedOf(nodeId)), [
    TRUSTED_ACTOR,
    OTHER_ACTOR,
  ]);
});

test("a revision that pins no binding of the link resource reads no row", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const other = h.addBinding(OTHER_RESOURCE, [TRUSTED_ACTOR]);
  const nodeId = h.addNode([linkOf()], NodeState.Available, [other]);
  const unpinned = h.addNode([linkOf()]);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, FIRST_OCCURRED_AT);
  assert.deepEqual((await h.listedOf(nodeId)).items, []);
  assert.deepEqual((await h.listedOf(unpinned)).items, []);
});

test("a binding with no link_trust trusts nobody", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const binding = h.addBinding(LINK_RESOURCE, undefined);
  const nodeId = h.addNode([linkOf()], NodeState.Available, [binding]);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, FIRST_OCCURRED_AT);
  assert.deepEqual((await h.listedOf(nodeId)).items, []);
});

test("a node with two links reads both threads newest first by occurred_at", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const binding = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const nodeId = h.addNode(
    [linkOf(), linkOf(OTHER_LINK_NUMBER)],
    NodeState.Available,
    [binding],
  );
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, SECOND_OCCURRED_AT);
  h.insertUpdate(linkOf(OTHER_LINK_NUMBER), TRUSTED_ACTOR, THIRD_OCCURRED_AT);
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, FIRST_OCCURRED_AT);
  const page = await h.listedOf(nodeId);
  assert.deepEqual(
    page.items.map((item) => item.occurred_at),
    [THIRD_OCCURRED_AT, SECOND_OCCURRED_AT, FIRST_OCCURRED_AT],
  );
  assert.equal(page.items.length, BOTH_ROWS + SINGLE_ROW);
});

test("a read takes each pinned binding revision once", async (t) => {
  const h = linkUpdateHarness(t, HUMAN_IDENTITY);
  const binding = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const nodeId = h.addNode(
    [linkOf(), linkOf(OTHER_LINK_NUMBER)],
    NodeState.Available,
    [binding],
  );
  h.insertUpdate(linkOf(), TRUSTED_ACTOR, FIRST_OCCURRED_AT);
  h.reads.length = NO_CALLS;
  await h.listedOf(nodeId);
  assert.deepEqual(h.reads, [binding]);
});

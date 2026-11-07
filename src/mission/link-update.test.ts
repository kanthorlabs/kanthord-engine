import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
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
  InboxReason,
  linkUpdateRowSchema,
  NodeState,
  type PlatformAddress,
  PlatformAddressKind,
} from "./contract.ts";
import { DELIVERY_ADMIT_OPERATION } from "./delivery-telemetry.ts";
import {
  INBOX_ACTOR,
  INBOX_HANDLE,
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
import { setNodeState } from "./store.ts";
import { actCalls, databaseSnapshot } from "./test-support.ts";

const HUMAN_IDENTITY = testHumanIdentity("ulrich", "Ulrich", "jti_ulrich");
const INTAKE_IDENTITY = testServiceIdentity(INTAKE_SERVICE_NAME);
const NO_ROWS = 0;
const NO_CALLS = 0;
const SINGLE_ROW = 1;
const TWO_ROWS = 2;
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
      reason: InboxReason.Linked,
      binding_id: null,
      done_at: null,
      snoozed_until: null,
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
      "INSERT INTO mission_link_update (id, mission_id, external_link, update_key, inbound_event_id, actor_id, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      createIdentity("link_update"),
      h.mission_id,
      canonicalJSON(linkOf()),
      LINK_UPDATE_KEY,
      createIdentity("inbound_event"),
      LINK_ACTOR,
      LINK_OCCURRED_AT,
      InboxReason.Linked,
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

const LAST_ATTEMPT = 2;
const NODE_TIME = 100;
const NO_ATTEMPT = 0;
const FIRST_REVISION = 1;
const TERMINAL_STATES = [NodeState.Completed, NodeState.Discarded] as const;

function trustedHarness(
  t: TestContext,
  state: NodeState,
  attempts = LAST_ATTEMPT,
) {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const bindingId = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR]);
  const nodeId = h.addNode([linkOf()], NodeState.Available, [bindingId]);
  h.addAttempts(nodeId, attempts);
  h.store.transaction((tx) => setNodeState(tx, nodeId, state));
  let sequence = 0;
  const update = async (actorId = TRUSTED_ACTOR) => {
    sequence++;
    h.decoding.update = updateOf({
      actor_id: actorId,
      update_key: `issue_comment:${sequence}`,
    });
    return h.admit();
  };
  const settle = (column: "rejected_at" | "approved_at", createdId?: string) =>
    h.store.database
      .prepare(
        `UPDATE mission_proposal SET ${column} = ?, created_node_id = ? WHERE node_id = ? AND ${column} IS NULL`,
      )
      .run(NODE_TIME, createdId ?? null, nodeId);
  return { ...h, nodeId, update, settle };
}

for (const state of TERMINAL_STATES) {
  test(`a trusted update of a ${state} node opens one follow-up proposal`, async (t) => {
    const h = trustedHarness(t, state);
    const answer = await h.update();
    assert.equal(answer.disposition, Disposition.AcceptedObservation);
    assert.equal(h.rows().length, SINGLE_ROW);
    const [proposal] = h.proposals();
    assert.equal(h.proposals().length, SINGLE_ROW);
    assert.match(String(proposal?.id), /^proposal_/);
    assert.equal(proposal?.node_id, h.nodeId);
    assert.equal(proposal?.attempt, LAST_ATTEMPT);
    assert.equal(proposal?.assessment_id, null);
    assert.equal(
      proposal?.content,
      canonicalJSON({ node_revision: FIRST_REVISION }),
    );
    assert.equal(proposal?.created_node_id, null);
    assert.equal(proposal?.approved_at, null);
    assert.equal(proposal?.rejected_at, null);
    assert.equal(
      h.store.database
        .prepare("SELECT state FROM mission_node WHERE id = ?")
        .get(h.nodeId)?.state,
      state,
    );
  });
}

test("a trusted update of a node discarded at attempt 0 opens one proposal of attempt 0", async (t) => {
  const h = trustedHarness(t, NodeState.Discarded, NO_ATTEMPT);
  await h.update();
  const [proposal] = h.proposals();
  assert.equal(h.proposals().length, SINGLE_ROW);
  assert.equal(proposal?.attempt, NO_ATTEMPT);
  assert.equal(proposal?.assessment_id, null);
});

for (const state of TERMINAL_STATES) {
  test(`an update of an actor outside link_trust of a ${state} node opens nothing`, async (t) => {
    const h = trustedHarness(t, state);
    await h.update(OTHER_ACTOR);
    assert.equal(h.rows().length, SINGLE_ROW);
    assert.equal(h.proposals().length, NO_ROWS);
  });
}

test("a second update while the proposal is open opens nothing", async (t) => {
  const h = trustedHarness(t, NodeState.Completed);
  await h.update();
  await h.update();
  assert.equal(h.rows().length, TWO_ROWS);
  assert.equal(h.proposals().length, SINGLE_ROW);
});

test("an update after a rejection opens a new proposal", async (t) => {
  const h = trustedHarness(t, NodeState.Completed);
  await h.update();
  h.settle("rejected_at");
  await h.update();
  assert.equal(h.proposals().length, TWO_ROWS);
  assert.equal(
    h.proposals().filter((row) => row.rejected_at === null).length,
    SINGLE_ROW,
  );
});

test("an update opens nothing while the created node of an approval is not retired", async (t) => {
  const h = trustedHarness(t, NodeState.Completed);
  await h.update();
  const created = h.addNode([linkOf()]);
  h.settle("approved_at", created);
  await h.update();
  assert.equal(h.proposals().length, SINGLE_ROW);
  h.retire(created);
  await h.update();
  assert.equal(h.proposals().length, TWO_ROWS);
});

test("an update of a retired terminal node opens nothing", async (t) => {
  const h = trustedHarness(t, NodeState.Completed);
  h.addNode([linkOf()]);
  h.retire(h.nodeId);
  await h.update();
  assert.equal(h.rows().length, SINGLE_ROW);
  assert.equal(h.proposals().length, NO_ROWS);
});

for (const state of [
  NodeState.Available,
  NodeState.Executing,
  NodeState.Blocked,
]) {
  test(`a trusted update of a ${state} node opens nothing and keeps its state`, async (t) => {
    const h = trustedHarness(t, state, SINGLE_ROW);
    const before = withoutLinkRows(databaseSnapshot(h.store));
    await h.update();
    assert.equal(h.rows().length, SINGLE_ROW);
    assert.equal(h.proposals().length, NO_ROWS);
    assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
  });
}

const REPLY_UPDATE_KEY = "issue_comment:6001";
const OWN_REPLY_UPDATE_KEY = "issue_comment:6002";
const REPLY_ACCOUNT = "2002";

test("an update whose update_key equals a succeeded reply answers actor_ignored and records nothing, also for a listed actor", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const binding = h.addBinding(LINK_RESOURCE, [REPLY_ACCOUNT]);
  h.addNode([linkOf()], NodeState.Available, [binding]);
  h.replies.answer = { succeeded: true, pending_actor_ids: [] };
  h.decoding.update = updateOf({
    update_key: REPLY_UPDATE_KEY,
    actor_id: REPLY_ACCOUNT,
  });
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.ActorIgnored,
  });
  assert.equal(h.rows().length, NO_ROWS);
  assert.deepEqual(h.replies.inputs, [
    { update_key: REPLY_UPDATE_KEY, external_link: linkOf() },
  ]);
  assert.equal(h.node().state, NodeState.Available);
});

test("the reply of another project answers actor_ignored in the mission of this project and records nothing", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  const otherProjectReplies = new Set([OWN_REPLY_UPDATE_KEY]);
  h.dependencies.intakeLinks.replyMatch = async (_context, input) => ({
    succeeded: otherProjectReplies.has(input.update_key),
    pending_actor_ids: [],
  });
  h.decoding.update = updateOf({ update_key: OWN_REPLY_UPDATE_KEY });
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.ActorIgnored,
  });
  assert.equal(h.rows().length, NO_ROWS);
  h.decoding.update = updateOf({ update_key: REPLY_UPDATE_KEY });
  assert.equal((await h.admit()).disposition, Disposition.AcceptedObservation);
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("an update of the reply account while a reply on the link is pending answers actor_ignored and records nothing", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.replies.answer = { succeeded: false, pending_actor_ids: [REPLY_ACCOUNT] };
  h.decoding.update = updateOf({ actor_id: REPLY_ACCOUNT });
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.ActorIgnored,
  });
  assert.equal(h.rows().length, NO_ROWS);
  const [call] = actCalls(h);
  assert.ok(Object.values(call![1].attributes).includes(REPLY_ACCOUNT));
});

test("an update of another human actor while the reply is pending records its row and keeps the state of the node", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const nodeId = h.addNode([linkOf()], NodeState.Executing);
  h.replies.answer = { succeeded: false, pending_actor_ids: [REPLY_ACCOUNT] };
  h.decoding.update = updateOf({ actor_id: OTHER_ACTOR });
  const before = withoutLinkRows(databaseSnapshot(h.store));
  assert.equal((await h.admit()).disposition, Disposition.AcceptedObservation);
  assert.equal(h.rows().length, SINGLE_ROW);
  assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
  assert.equal(
    h.store.database
      .prepare("SELECT state FROM mission_node WHERE id = ?")
      .get(nodeId)?.state,
    NodeState.Executing,
  );
});

test("an update of the reply account after the reply succeeded with another update_key records its row", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.replies.answer = { succeeded: false, pending_actor_ids: [] };
  h.decoding.update = updateOf({
    update_key: REPLY_UPDATE_KEY,
    actor_id: REPLY_ACCOUNT,
  });
  assert.equal((await h.admit()).disposition, Disposition.AcceptedObservation);
  assert.equal(h.rows().length, SINGLE_ROW);
  assert.equal(h.rows()[0]?.actor_id, REPLY_ACCOUNT);
});

test("an automated actor and a null actor_id ask Intake nothing about replies", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf({ actor_automated: true });
  await h.admit();
  h.decoding.update = updateOf({ actor_id: null });
  await h.admit();
  assert.deepEqual(h.replies.inputs, []);
});

const BOB_ACTOR = "2002";
const CAROL_ACTOR = "2003";
const SECOND_INBOX_HANDLE = "ulrich-two";
const FIRST_COMMENT_KEY = "issue_comment:6001";
const SECOND_COMMENT_KEY = "issue_comment:6002";
const THIRD_COMMENT_KEY = "issue_comment:6003";
const INBOX_IDENTITY = { actor_id: INBOX_ACTOR, handle: INBOX_HANDLE };

function lastRow(h: ReturnType<typeof linkUpdateHarness>) {
  const row = h.rows().at(-1);
  assert.ok(row);
  return row;
}

test("a mention of the handle on a thread that no node links inserts a mentioned row with the pin", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const pin = h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  const row = lastRow(h);
  assert.ok(linkUpdateRowSchema.safeParse(row).success);
  assert.equal(row.reason, InboxReason.Mentioned);
  assert.equal(row.binding_id, pin);
  assert.equal(row.done_at, null);
  assert.equal(row.snoozed_until, null);
});

test("a mention of the actor id inserts a mentioned row", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_ACTOR],
  });
  await h.admit();
  assert.equal(lastRow(h).reason, InboxReason.Mentioned);
});

test("a later comment with no mention on a thread that holds a row inserts a participating row", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const pin = h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  await h.admit();
  h.decoding.update = updateOf({
    actor_id: CAROL_ACTOR,
    update_key: SECOND_COMMENT_KEY,
    mentions: [],
  });
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  const row = lastRow(h);
  assert.equal(row.reason, InboxReason.Participating);
  assert.equal(row.binding_id, pin);
  assert.equal(row.done_at, null);
});

test("an update of the inbox actor inserts a participating row with done_at and closes nothing else", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const pin = h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  await h.admit();
  h.decoding.update = updateOf({
    actor_id: INBOX_ACTOR,
    update_key: SECOND_COMMENT_KEY,
    mentions: [],
  });
  const started = Date.now();
  await h.admit();
  const [first, own] = h.rows();
  assert.equal(first?.done_at, null);
  assert.equal(own?.reason, InboxReason.Participating);
  assert.equal(own?.binding_id, pin);
  assert.ok(Math.abs(Number(own?.done_at) - started) < CLOCK_TOLERANCE_MS);
});

test("an own update with no row on the thread is admitted and done", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: INBOX_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [],
  });
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  assert.notEqual(lastRow(h).done_at, null);
});

test("a comment on a linked thread inserts a linked row with the pin and keeps the node state", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const pin = h.writeInbox(INBOX_IDENTITY);
  const nodeId = h.addNode([linkOf()]);
  const before = withoutLinkRows(databaseSnapshot(h.store));
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [],
  });
  const answer = await h.admit();
  assert.equal(answer.disposition, Disposition.AcceptedObservation);
  const row = lastRow(h);
  assert.equal(row.reason, InboxReason.Linked);
  assert.equal(row.binding_id, pin);
  assert.deepEqual(withoutLinkRows(databaseSnapshot(h.store)), before);
  assert.equal(
    h.store.database
      .prepare("SELECT state FROM mission_node WHERE id = ?")
      .get(nodeId)?.state,
    NodeState.Available,
  );
});

test("a linked thread that mentions the handle takes linked, the highest rank", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(INBOX_IDENTITY);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  await h.admit();
  assert.equal(lastRow(h).reason, InboxReason.Linked);
});

test("a comment with no mention on an unlinked thread with no row answers unmatched", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [],
  });
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.rows().length, NO_ROWS);
});

test("a binding without inbox inserts a linked row with a null binding_id and refuses a mention", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(null);
  h.addNode([linkOf()]);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [],
  });
  await h.admit();
  const row = lastRow(h);
  assert.equal(row.reason, InboxReason.Linked);
  assert.equal(row.binding_id, null);
  h.decoding.update = updateOf({
    external_link: linkOf(OTHER_LINK_NUMBER),
    actor_id: BOB_ACTOR,
    update_key: SECOND_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.rows().length, SINGLE_ROW);
});

test("a change of inbox.handle keeps the pin of a pinned thread and a thread with no pin takes the new revision", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  const first = h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  await h.admit();
  const second = h.writeInbox(
    { actor_id: INBOX_ACTOR, handle: SECOND_INBOX_HANDLE },
    BINDING_REVISION_TWO,
  );
  assert.notEqual(first, second);
  h.decoding.update = updateOf({
    actor_id: CAROL_ACTOR,
    update_key: SECOND_COMMENT_KEY,
    mentions: [],
  });
  await h.admit();
  assert.equal(lastRow(h).binding_id, first);
  h.decoding.update = updateOf({
    external_link: linkOf(OTHER_LINK_NUMBER),
    actor_id: BOB_ACTOR,
    update_key: THIRD_COMMENT_KEY,
    mentions: [SECOND_INBOX_HANDLE],
  });
  await h.admit();
  const row = lastRow(h);
  assert.equal(row.reason, InboxReason.Mentioned);
  assert.equal(row.binding_id, second);
});

test("a mention by an automated actor answers actor_ignored and inserts nothing", async (t) => {
  const h = linkUpdateHarness(t, INTAKE_IDENTITY);
  h.writeInbox(INBOX_IDENTITY);
  h.decoding.update = updateOf({
    actor_id: BOB_ACTOR,
    actor_automated: true,
    update_key: FIRST_COMMENT_KEY,
    mentions: [INBOX_HANDLE],
  });
  const answer = await h.admit();
  assert.deepEqual(answer, {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.ActorIgnored,
  });
  assert.equal(h.rows().length, NO_ROWS);
});

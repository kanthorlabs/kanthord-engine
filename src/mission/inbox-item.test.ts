import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IntakeErrorCode } from "../intake/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  type InboxItemList,
  InboxItemState,
  InboxReason,
  MissionErrorCode,
} from "./contract.ts";
import {
  INBOX_ACTOR,
  INBOX_HANDLE,
  LINK_RESOURCE,
  linkOf,
  linkUpdateHarness,
  OTHER_ACTOR,
  TRUSTED_ACTOR,
} from "./link-update-test-support.ts";
import { SNOOZE_MAX_MS } from "./inbox-item.ts";
import { insertLinkUpdate } from "./record-store.ts";
import { insertMission } from "./store.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "jti_ulrich");
const START = 1800000000000;
const MS_PER_DAY = 86400000;
const FIRST_AT = 1700000001000;
const SECOND_AT = 1700000002000;
const THIRD_AT = 1700000003000;
const FOURTH_AT = 1700000004000;
const FIFTH_AT = 1700000005000;
const SECOND_NUMBER = 8;
const THIRD_NUMBER = 9;
const FOURTH_NUMBER = 10;
const THREE_THREADS = 3;
const TWO_THREADS = 2;
const SINGLE = 1;
const NO_ITEMS = 0;
const BODY = "Please take a look";
const AUTHOR = "bob";
const URL_OF_COMMENT = "https://github.com/acme/app/issues/7#issuecomment-1";
const EVENT_TIME = 1700000000500;
const EMPTY_OBJECT = {};
const DESCRIBED = {
  author: AUTHOR,
  body: BODY,
  url: URL_OF_COMMENT,
  occurred_at: EVENT_TIME,
};

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const h = linkUpdateHarness(t, IDENTITY);
  const pin = h.addBinding(LINK_RESOURCE, [TRUSTED_ACTOR], 1, {
    actor_id: INBOX_ACTOR,
    handle: INBOX_HANDLE,
  });
  const described: string[] = [];
  const missing = new Set<string>();
  h.dependencies.intakeLinks.describe = async (_context, inboundEventId) => {
    described.push(inboundEventId);
    if (missing.has(inboundEventId))
      throw new OperationError(
        HttpStatus.NotFound,
        IntakeErrorCode.InboundEventNotFound,
        "Inbound event not found.",
      );
    return DESCRIBED;
  };
  const row = (
    number: number,
    actor: string,
    occurredAt: number,
    reason: InboxReason = InboxReason.Mentioned,
    binding: string | null = pin,
    missionId = h.mission_id,
  ) =>
    h.store.transaction((tx) =>
      insertLinkUpdate(tx, {
        mission_id: missionId,
        external_link: canonicalJSON(linkOf(number)),
        update_key: `issue_comment:${number}:${occurredAt}`,
        inbound_event_id: createIdentity("inbound_event"),
        actor_id: actor,
        occurred_at: occurredAt,
        reason,
        binding_id: binding,
        done_at: null,
        snoozed_until: null,
      }),
    );
  const list = (query: object = {}): Promise<InboxItemList> =>
    h.invoke("inbox_item.list", { params: EMPTY_OBJECT, query, body: null });
  const done = (id: string, body: object = {}) =>
    h.invoke("inbox_item.done", {
      params: { link_update_id: id },
      query: EMPTY_OBJECT,
      body,
    });
  return { ...h, pin, row, list, done, described, missing };
}

function refusedWith(status: number, code: string, details?: unknown) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  };
}

test("the list answers one item for a thread of three rows with the values of the newest row", async (t) => {
  const h = harness(t);
  const nodeId = h.addNode([linkOf()]);
  h.row(7, OTHER_ACTOR, FIRST_AT, InboxReason.Participating);
  h.row(7, OTHER_ACTOR, SECOND_AT, InboxReason.Mentioned);
  const newest = h.row(7, TRUSTED_ACTOR, THIRD_AT, InboxReason.Participating);
  const page = await h.list();
  assert.equal(page.items.length, SINGLE);
  const [item] = page.items;
  assert.equal(item?.link_update_id, newest);
  assert.equal(item?.project_id, h.project_id);
  assert.deepEqual(item?.external_link, linkOf());
  assert.equal(item?.reason, InboxReason.Mentioned);
  assert.equal(item?.state, InboxItemState.Open);
  assert.equal(item?.occurred_at, THIRD_AT);
  assert.equal(item?.actor_id, TRUSTED_ACTOR);
  assert.equal(item?.trusted, true);
  assert.equal(item?.done_at, null);
  assert.equal(item?.snoozed_until, null);
  assert.deepEqual(item?.linked_node_ids, [nodeId]);
  assert.deepEqual(item?.content, DESCRIBED);
  assert.deepEqual(page.counts, { open: SINGLE, snoozed: NO_ITEMS });
  assert.equal(page.next_cursor, null);
});

test("a thread of an actor outside link_trust answers trusted false", async (t) => {
  const h = harness(t);
  h.row(7, OTHER_ACTOR, FIRST_AT);
  const [item] = (await h.list()).items;
  assert.equal(item?.trusted, false);
  assert.deepEqual(item?.linked_node_ids, []);
});

test("a retired node is no linked node", async (t) => {
  const h = harness(t);
  h.retire(h.addNode([linkOf()]));
  h.row(7, OTHER_ACTOR, FIRST_AT);
  assert.deepEqual((await h.list()).items[NO_ITEMS]?.linked_node_ids, []);
});

test("a row with a null binding_id adds no item", async (t) => {
  const h = harness(t);
  h.row(7, OTHER_ACTOR, FIRST_AT, InboxReason.Linked, null);
  const page = await h.list();
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.counts, { open: NO_ITEMS, snoozed: NO_ITEMS });
});

test("the list orders by the newest row, filters by state and project, pages and counts", async (t) => {
  const h = harness(t);
  const later = h.row(7, OTHER_ACTOR, FOURTH_AT);
  const earlier = h.row(SECOND_NUMBER, OTHER_ACTOR, FIRST_AT);
  const finished = h.row(THIRD_NUMBER, OTHER_ACTOR, SECOND_AT);
  const parked = h.row(FOURTH_NUMBER, OTHER_ACTOR, THIRD_AT);
  await h.done(finished);
  await h.done(parked, { snoozed_until: START + MS_PER_DAY });
  const otherProject = createIdentity("project");
  const otherMission = h.store.transaction((tx) =>
    insertMission(tx, otherProject, FIRST_AT),
  );
  const foreign = h.row(
    7,
    OTHER_ACTOR,
    FIFTH_AT,
    InboxReason.Mentioned,
    h.pin,
    otherMission,
  );
  const open = await h.list();
  assert.deepEqual(
    open.items.map((item) => item.link_update_id),
    [earlier, later, foreign],
  );
  assert.deepEqual(open.counts, { open: THREE_THREADS, snoozed: SINGLE });
  const first = await h.list({ limit: TWO_THREADS });
  assert.deepEqual(
    first.items.map((item) => item.link_update_id),
    [earlier, later],
  );
  assert.ok(first.next_cursor);
  const second = await h.list({
    limit: TWO_THREADS,
    cursor: first.next_cursor,
  });
  assert.deepEqual(
    second.items.map((item) => item.link_update_id),
    [foreign],
  );
  assert.equal(second.next_cursor, null);
  const scoped = await h.list({ project_id: h.project_id });
  assert.deepEqual(
    scoped.items.map((item) => item.link_update_id),
    [earlier, later],
  );
  assert.deepEqual(scoped.counts, { open: TWO_THREADS, snoozed: SINGLE });
  const doneItems = await h.list({ state: InboxItemState.Done });
  assert.deepEqual(
    doneItems.items.map((item) => item.link_update_id),
    [finished],
  );
  const snoozedItems = await h.list({ state: InboxItemState.Snoozed });
  assert.deepEqual(
    snoozedItems.items.map((item) => item.link_update_id),
    [parked],
  );
});

test("the item answers content from the description and null for a deleted event", async (t) => {
  const h = harness(t);
  const kept = h.row(7, OTHER_ACTOR, FIRST_AT);
  const deleted = h.row(SECOND_NUMBER, OTHER_ACTOR, SECOND_AT);
  const eventOf = (id: string) =>
    (
      h.store.database
        .prepare(
          "SELECT inbound_event_id FROM mission_link_update WHERE id = ?",
        )
        .get(id) as { inbound_event_id: string }
    ).inbound_event_id;
  h.missing.add(eventOf(deleted));
  const page = await h.list();
  assert.deepEqual(
    page.items.map((item) => [item.link_update_id, item.content]),
    [
      [kept, DESCRIBED],
      [deleted, null],
    ],
  );
  assert.deepEqual(h.described, [eventOf(kept), eventOf(deleted)]);
});

test("done of the newest row answers done and a later row reopens the thread with the card reason of the later rows", async (t) => {
  const h = harness(t);
  h.row(7, OTHER_ACTOR, FIRST_AT, InboxReason.Linked);
  const newest = h.row(7, OTHER_ACTOR, SECOND_AT, InboxReason.Mentioned);
  const closed = await h.done(newest);
  assert.equal(closed.state, InboxItemState.Done);
  assert.equal(closed.reason, InboxReason.Mentioned);
  assert.equal(closed.done_at, START);
  assert.equal(closed.snoozed_until, null);
  assert.deepEqual(
    (await h.list({ state: InboxItemState.Done })).items.map(
      (item) => item.link_update_id,
    ),
    [newest],
  );
  const reopening = h.row(7, OTHER_ACTOR, THIRD_AT, InboxReason.Participating);
  const [reopened] = (await h.list()).items;
  assert.equal(reopened?.link_update_id, reopening);
  assert.equal(reopened?.state, InboxItemState.Open);
  assert.equal(reopened?.reason, InboxReason.Participating);
});

test("done of an older row answers open", async (t) => {
  const h = harness(t);
  const older = h.row(7, OTHER_ACTOR, FIRST_AT, InboxReason.Linked);
  const newest = h.row(7, OTHER_ACTOR, SECOND_AT, InboxReason.Participating);
  const answer = await h.done(older);
  assert.equal(answer.state, InboxItemState.Open);
  assert.equal(answer.link_update_id, newest);
  assert.equal(answer.reason, InboxReason.Participating);
});

test("a second done keeps the first done_at", async (t) => {
  const h = harness(t);
  const id = h.row(7, OTHER_ACTOR, FIRST_AT);
  await h.done(id);
  t.mock.timers.tick(MS_PER_DAY);
  const again = await h.done(id, { snoozed_until: null });
  assert.equal(again.done_at, START);
});

test("snooze answers snoozed, the thread opens after snoozed_until and done clears the snooze", async (t) => {
  const h = harness(t);
  const id = h.row(7, OTHER_ACTOR, FIRST_AT);
  const until = START + MS_PER_DAY;
  const snoozed = await h.done(id, { snoozed_until: until });
  assert.equal(snoozed.state, InboxItemState.Snoozed);
  assert.equal(snoozed.snoozed_until, until);
  assert.equal(snoozed.done_at, null);
  assert.deepEqual((await h.list()).counts, {
    open: NO_ITEMS,
    snoozed: SINGLE,
  });
  t.mock.timers.tick(MS_PER_DAY + SINGLE);
  const [reopened] = (await h.list()).items;
  assert.equal(reopened?.state, InboxItemState.Open);
  const resnoozed = await h.done(id, { snoozed_until: START + 3 * MS_PER_DAY });
  assert.equal(resnoozed.state, InboxItemState.Snoozed);
  const finished = await h.done(id);
  assert.equal(finished.state, InboxItemState.Done);
  assert.equal(finished.snoozed_until, null);
  assert.notEqual(finished.done_at, null);
});

test("a snooze in the past or 31 days ahead answers snooze_invalid", async (t) => {
  const h = harness(t);
  const id = h.row(7, OTHER_ACTOR, FIRST_AT);
  for (const snoozed_until of [
    START - SINGLE,
    START,
    START + SNOOZE_MAX_MS + MS_PER_DAY,
  ])
    await assert.rejects(
      h.done(id, { snoozed_until }),
      refusedWith(
        HttpStatus.BadRequest,
        MissionErrorCode.InboxItemSnoozeInvalid,
      ),
    );
  const [item] = (await h.list()).items;
  assert.equal(item?.snoozed_until, null);
  await h.done(id, { snoozed_until: START + SNOOZE_MAX_MS });
});

test("an unknown row and a row with a null binding_id answer not_found", async (t) => {
  const h = harness(t);
  const outside = h.row(7, OTHER_ACTOR, FIRST_AT, InboxReason.Linked, null);
  const unknown = createIdentity("link_update");
  for (const id of [unknown, outside])
    await assert.rejects(
      h.done(id),
      refusedWith(HttpStatus.NotFound, MissionErrorCode.InboxItemNotFound, {
        link_update_id: id,
      }),
    );
});

test("a project_id with no mission answers mission not_found", async (t) => {
  const h = harness(t);
  await assert.rejects(
    h.list({ project_id: createIdentity("project") }),
    refusedWith(HttpStatus.NotFound, MissionErrorCode.MissionNotFound),
  );
});

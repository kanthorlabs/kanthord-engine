import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { isString } from "../../kernel/values.ts";
import { WORKBENCH_OPENING_TEXT } from "../../workbench/contract.ts";
import {
  completed,
  createHost,
  DEFAULT,
  OFF,
  sendMessage,
  SONNET,
  untilIdle,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-merged");
const { conversationFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const OPS_DISPLAY_NAME = "Yumi";
const REVIEW_DISPLAY_NAME = "RE";
const MENTION_REQUEST = "@RE summarize the open objectives.";
const FOLLOW_UP = "And what else?";
const ANSWER = "Two objectives are open.";
const SECOND_ANSWER = "Still two.";
const GREETING_PREFIX = "Hi, I am ";
const MESSAGE_ENTRY = "message";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const NO_TEXT = "";
const WHOLE_SESSION_ID = /^workbench_session_[0-9A-Z]{26}$/;
const NO_ITEMS = 0;
const SINGLE = 1;
const TWO_MEMBERS = 2;
const TEST_TIMEOUT_MS = 60000;

type Fixture = WorkbenchFixture;
type Entry = Record<string, unknown> & {
  id: string;
  session_id: string;
  agent_name: string;
};

function answers() {
  return [
    async () => fauxAssistantMessage(ANSWER),
    async () => fauxAssistantMessage(SECOND_ANSWER),
  ];
}

async function poll(fixture: Fixture, hostId: string, after?: string) {
  return completed(
    await fixture.workbench["session.events"](
      {
        params: { session_id: hostId },
        query: after === undefined ? {} : { after },
        body: null,
      },
      fixture.options,
    ),
  );
}

function cursorOf(entries: readonly Entry[]): string {
  const latest = new Map<string, string>();
  for (const entry of entries) latest.set(entry.session_id, entry.id);
  return [...latest].map(([member, id]) => `${member}:${id}`).join(",");
}

function userTexts(entries: readonly Entry[]): string[] {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .filter(({ role }) => role === USER_ROLE)
    .map(({ content }) =>
      isString(content)
        ? content
        : (content as { text?: string }[])
            .map((block) => block.text ?? "")
            .join(""),
    );
}

function assistantTexts(entries: readonly Entry[]): string[] {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .filter(({ role }) => role === ASSISTANT_ROLE)
    .map(({ content }) => (content as { text?: string }[])[0]?.text ?? "");
}

async function started(t: Parameters<typeof conversationFixture>[0]) {
  const { fixture, state } = await conversationFixture(t, answers());
  const host = await createHost(fixture, OPS);
  return { fixture, state, host };
}

test(
  "(happy path) the merged poll shows the greeting, the human message once and the members",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await started(t);
    const before = await poll(fixture, host.id);
    assert.deepEqual(before.members, [
      {
        session_id: host.id,
        agent_name: OPS,
        display_name: OPS_DISPLAY_NAME,
        configuration: {
          agent_provider: DEFAULT,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
    ]);
    assert.equal(
      assistantTexts(before.entries as Entry[]).filter((text) =>
        text.startsWith(GREETING_PREFIX),
      ).length,
      SINGLE,
    );
    assert.ok(
      !userTexts(before.entries as Entry[]).includes(WORKBENCH_OPENING_TEXT),
    );
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const polled = await poll(fixture, host.id);
    const viewed = completed(
      await fixture.workbench["session.get"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    for (const answer of [polled, viewed]) {
      assert.deepEqual(
        answer.members.map(({ agent_name, display_name }) => [
          agent_name,
          display_name,
        ]),
        [
          [OPS, OPS_DISPLAY_NAME],
          [REVIEW_AGENT, REVIEW_DISPLAY_NAME],
        ],
      );
      const entries = answer.entries as Entry[];
      assert.equal(
        userTexts(entries).filter((text) => text === MENTION_REQUEST).length,
        SINGLE,
      );
      assert.ok(!userTexts(entries).includes(WORKBENCH_OPENING_TEXT));
      assert.ok(assistantTexts(entries).includes(ANSWER));
      assert.equal(
        entries.find(
          (entry) =>
            entry.type === MESSAGE_ENTRY && entry.agent_name === REVIEW_AGENT,
        )?.session_id,
        answer.members[SINGLE]!.session_id,
      );
    }
  },
);

test(
  "(invariant, data loss) a cursor with one pair per member resumes with no loss and no repeat",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await started(t);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const first = (await poll(fixture, host.id)).entries as Entry[];
    const after = cursorOf(first);
    assert.equal(after.split(",").length, TWO_MEMBERS);
    completed(await sendMessage(fixture, host.id, FOLLOW_UP));
    await untilIdle(fixture, host.id, t.signal);
    const delta = (await poll(fixture, host.id, after)).entries as Entry[];
    const all = (await poll(fixture, host.id)).entries as Entry[];
    const known = new Set(first.map(({ id }) => id));
    assert.deepEqual(
      delta.map(({ id }) => id),
      all.filter(({ id }) => !known.has(id)).map(({ id }) => id),
    );
    assert.ok(delta.length > NO_ITEMS);
    assert.equal(new Set(delta.map(({ id }) => id)).size, delta.length);
    assert.deepEqual(userTexts(delta), [FOLLOW_UP]);
  },
);

test(
  "(invariant, data loss) a plain entry id names the host pair and the participant entries start from the start",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await started(t);
    const greeting = (await poll(fixture, host.id)).entries.at(-SINGLE)!;
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const all = (await poll(fixture, host.id)).entries as Entry[];
    const delta = (await poll(fixture, host.id, greeting.id))
      .entries as Entry[];
    const participant = all.filter(
      ({ agent_name }) => agent_name === REVIEW_AGENT,
    );
    assert.ok(participant.length > NO_ITEMS);
    assert.deepEqual(
      delta.filter(({ agent_name }) => agent_name === REVIEW_AGENT),
      participant,
    );
    const hostAll = all.filter(({ agent_name }) => agent_name === OPS);
    const greetingAt = hostAll.findIndex(({ id }) => id === greeting.id);
    assert.deepEqual(
      delta.filter(({ agent_name }) => agent_name === OPS),
      hostAll.slice(greetingAt + SINGLE),
    );
  },
);

test(
  "(happy path) the list nests participants and the host follows its latest member",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await started(t);
    const listed = async () =>
      completed(
        await fixture.workbench["session.list"](
          { params: {}, query: {}, body: null },
          fixture.options,
        ),
      ).items;
    const [fresh] = await listed();
    assert.equal(fresh!.first_message, NO_TEXT);
    assert.equal(fresh!.message_count, SINGLE);
    assert.equal(fresh!.name, null);
    assert.deepEqual(fresh!.participants, []);
    assert.equal(fresh!.display_name, OPS_DISPLAY_NAME);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const items = await listed();
    assert.equal(items.length, SINGLE);
    const [top] = items;
    assert.equal(top!.id, host.id);
    assert.equal(top!.host_session_id, null);
    assert.equal(top!.name, MENTION_REQUEST);
    assert.equal(top!.run_active, false);
    const [participant] = top!.participants;
    assert.equal(participant!.agent_name, REVIEW_AGENT);
    assert.equal(participant!.display_name, REVIEW_DISPLAY_NAME);
    assert.equal(participant!.host_session_id, host.id);
    assert.deepEqual(participant!.participants, []);
    assert.ok(top!.modified >= participant!.modified);
    const filtered = completed(
      await fixture.workbench["session.list"](
        { params: {}, query: { agent_name: REVIEW_AGENT }, body: null },
        fixture.options,
      ),
    ).items;
    assert.deepEqual(filtered, []);
    completed(await sendMessage(fixture, host.id, FOLLOW_UP));
    await untilIdle(fixture, host.id, t.signal);
    const [again] = await listed();
    assert.ok(again!.modified >= again!.participants[0]!.modified);
    assert.ok(again!.participants[0]!.modified >= participant!.modified);
  },
);

test(
  "(invariant, data loss) after a restart the list nests the participant and the merged poll answers both members",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, state, host } = await started(t);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(
      (await fixture.workbenchService.stop()) ?? undefined,
      undefined,
    );
    const { workbenchFixture } = workbenchHarness(identity);
    const second = await workbenchFixture(t, [], state);
    const items = completed(
      await second.workbench["session.list"](
        { params: {}, query: {}, body: null },
        second.options,
      ),
    ).items;
    assert.deepEqual(
      items.map(({ id }) => id),
      [host.id],
    );
    const [participant] = items[0]!.participants;
    assert.match(participant!.host_session_id!, WHOLE_SESSION_ID);
    assert.equal(participant!.host_session_id, host.id);
    const polled = await poll(second, host.id);
    assert.deepEqual(
      polled.members.map(({ agent_name }) => agent_name),
      [OPS, REVIEW_AGENT],
    );
    const entries = polled.entries as Entry[];
    assert.equal(
      userTexts(entries).filter((text) => text === MENTION_REQUEST).length,
      SINGLE,
    );
    assert.ok(assistantTexts(entries).includes(ANSWER));
    assert.equal(
      new Set(entries.map(({ session_id }) => session_id)).size,
      TWO_MEMBERS,
    );
  },
);

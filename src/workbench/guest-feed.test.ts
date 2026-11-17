import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";
import type { MemberEntry } from "./contract.ts";
import {
  WORKBENCH_STREAM_QUEUE_BYTES,
  WORKBENCH_STREAM_TICK_MS,
} from "./contract.ts";
import { type FeedState, GuestFeed } from "./guest-feed.ts";

const SESSION_ID = "workbench_session_A";
const AGENT_NAME = "yumi@1";
const INVITE_ID = "workbench_invite_A";
const DELTA_COUNT = 500;
const RUN_MS = 2000;
const DELTA_MS = RUN_MS / DELTA_COUNT;
const POLL_ANSWER_LIMIT = RUN_MS / WORKBENCH_STREAM_TICK_MS + 3;
const START_MS = 1_000_000;
const LATER_MS = 100;
const EXPIRY_MS = 5000;
const EARLY_MS = EXPIRY_MS - 1;
const SINGLE = 1;
const OVERSIZE_TEXT = "x".repeat(WORKBENCH_STREAM_QUEUE_BYTES + SINGLE);
const ENTRIES_EVENT = "entries";
const STATE_EVENT = "state";
const NEXT_TEXT = "next";
const FRAME_PATTERN = /^event: (\w+)\ndata: (.*)\n\n$/s;

interface Frame {
  event: string;
  data: unknown;
}

function frameOf(chunk: Uint8Array | undefined): Frame {
  assert.ok(chunk);
  const match = FRAME_PATTERN.exec(new TextDecoder().decode(chunk));
  assert.ok(match);
  return { event: match[1]!, data: JSON.parse(match[2]!) };
}

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Frame> {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  return frameOf(chunk.value);
}

function userEntry(id: number, text: string): MemberEntry {
  return {
    id: `entry_${id}`,
    parentId: null,
    timestamp: new Date(START_MS + id).toISOString(),
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
    session_id: SESSION_ID,
    agent_name: AGENT_NAME,
  };
}

function conversation(t: TestContext) {
  mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: START_MS,
  });
  const entries: MemberEntry[] = [];
  const state: FeedState = {
    run_active: false,
    display_name: null,
    auto_mode: true,
    streaming: null,
  };
  const feed = new GuestFeed({
    entries: () => [...entries],
    state: () => ({ ...state }),
  });
  t.after(() => {
    feed.stop();
    mock.timers.reset();
  });
  const open = (expiresAt = START_MS + EXPIRY_MS * EXPIRY_MS) =>
    feed.open({
      inviteId: INVITE_ID,
      expiresAt,
      after: undefined,
      signal: new AbortController().signal,
    });
  return { feed, entries, state, open };
}

test("invariant, data loss: 500 deltas over 2 s give at most 5 owner poll answers and the last holds the final text", (t) => {
  const { feed, state } = conversation(t);
  const answers: { version: number; text: string }[] = [];
  const unsubscribe = feed.subscribe(() =>
    answers.push({
      version: feed.version,
      text: String(state.streaming?.text ?? ""),
    }),
  );
  t.after(unsubscribe);
  let text = "";
  for (let delta = 0; delta < DELTA_COUNT; delta++) {
    text += "x";
    state.streaming = { text };
    feed.notify();
    mock.timers.tick(DELTA_MS);
  }
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.ok(answers.length <= POLL_ANSWER_LIMIT, String(answers.length));
  assert.equal(answers.at(-SINGLE)?.text, text);
  assert.equal(feed.version, answers.length);
});

test("invariant, data loss: a configure within one tick after a run end still publishes the end", async (t) => {
  const { feed, state, open } = conversation(t);
  const reader = open().getReader();
  assert.deepEqual((await nextFrame(reader)).data, {
    run_active: false,
    display_name: null,
    auto_mode: true,
    streaming: null,
  });
  state.run_active = true;
  state.display_name = "Yumi";
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.equal((await nextFrame(reader)).event, STATE_EVENT);
  state.run_active = false;
  state.display_name = null;
  feed.notify();
  mock.timers.tick(LATER_MS);
  state.auto_mode = false;
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.deepEqual(await nextFrame(reader), {
    event: STATE_EVENT,
    data: {
      run_active: false,
      display_name: null,
      auto_mode: false,
      streaming: null,
    },
  });
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  state.auto_mode = true;
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.deepEqual((await nextFrame(reader)).data, {
    run_active: false,
    display_name: null,
    auto_mode: true,
    streaming: null,
  });
});

test("invariant, data loss: a full stream closes at the next write and the other streams get the frame", async (t) => {
  const { feed, entries, open } = conversation(t);
  const full = open().getReader();
  const other = open().getReader();
  await nextFrame(full);
  await nextFrame(other);
  entries.push(userEntry(SINGLE, OVERSIZE_TEXT));
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.equal((await nextFrame(other)).event, ENTRIES_EVENT);
  entries.push(userEntry(SINGLE + SINGLE, NEXT_TEXT));
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  const second = await nextFrame(other);
  assert.equal(second.event, ENTRIES_EVENT);
  assert.equal((second.data as { text: string }[])[0]?.text, NEXT_TEXT);
  assert.equal((await nextFrame(full)).event, ENTRIES_EVENT);
  assert.ok((await full.read()).done);
});

test("security, refused path: a stream closes at expires_at of its invite", async (t) => {
  const { feed, state, open } = conversation(t);
  const reader = open(START_MS + EXPIRY_MS).getReader();
  await nextFrame(reader);
  mock.timers.tick(EARLY_MS);
  state.auto_mode = false;
  feed.notify();
  mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  assert.equal((await nextFrame(reader)).event, STATE_EVENT);
  assert.ok((await reader.read()).done);
});

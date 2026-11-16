import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { loadPi } from "../../agent/pi.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_FORK_ACK,
  WORKBENCH_FORK_FRAME,
  WORKBENCH_FORK_PREFIX,
} from "../../workbench/contract.ts";
import {
  AGENT,
  completed,
  DEFAULT,
  OFF,
  SONNET,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-fork-test");
const { workbenchFixture } = workbenchHarness(identity);
const SOURCE_ID = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FORK_ID = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PLAIN_ID = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const FORK_NAME = "Forked work";
const SUMMARY = "Goal: finish node_9.\nOpen in the earlier conversation: none.";
const PROVIDER = "anthropic";
const NO_MESSAGES = 0;
const SINGLE = 1;
const MESSAGE_ENTRY = "message";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const TEXT_BLOCK = "text";
const PLAIN_TEXT = "Plain first message.";
const NO_COST = 0;

function placeOf(state: string) {
  return {
    cwd: join(state, "workbench", AGENT),
    sessionDir: join(state, "pi", "sessions", "workbench", AGENT),
  };
}

async function seededSession(state: string, id: string) {
  const pi = await loadPi();
  const { cwd, sessionDir } = placeOf(state);
  const manager = pi.SessionManager.create(cwd, sessionDir, { id });
  manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
    agent_provider: DEFAULT,
  });
  manager.appendModelChange(PROVIDER, SONNET);
  manager.appendThinkingLevelChange(OFF);
  return manager;
}

async function seededFork(state: string, id: string, summary: string) {
  const manager = await seededSession(state, id);
  const timestamp = Date.now();
  manager.appendMessage({
    role: USER_ROLE,
    content: [
      {
        type: TEXT_BLOCK,
        text: `${WORKBENCH_FORK_PREFIX}${SOURCE_ID}.${WORKBENCH_FORK_FRAME}${summary}`,
      },
    ],
    timestamp,
  });
  manager.appendMessage({
    role: ASSISTANT_ROLE,
    content: [{ type: TEXT_BLOCK, text: WORKBENCH_FORK_ACK }],
    api: "anthropic-messages",
    provider: PROVIDER,
    model: SONNET,
    usage: {
      input: NO_COST,
      output: NO_COST,
      cacheRead: NO_COST,
      cacheWrite: NO_COST,
      totalTokens: NO_COST,
      cost: {
        input: NO_COST,
        output: NO_COST,
        cacheRead: NO_COST,
        cacheWrite: NO_COST,
        total: NO_COST,
      },
    },
    stopReason: "stop",
    timestamp,
  });
  manager.appendSessionInfo(FORK_NAME);
}

test("(happy path) list and get answer forked_from and the ack of a fork file stays hidden", async (t) => {
  const state = temporary(t);
  await seededFork(state, FORK_ID, SUMMARY);
  const plain = await seededSession(state, PLAIN_ID);
  plain.appendMessage({
    role: USER_ROLE,
    content: PLAIN_TEXT,
    timestamp: Date.now(),
  });
  const fixture = await workbenchFixture(t, [], state);
  const listed = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: {}, body: null },
      fixture.options,
    ),
  );
  const forked = listed.items.find(({ id }) => id === FORK_ID);
  assert.ok(forked);
  assert.equal(forked.forked_from, SOURCE_ID);
  assert.equal(forked.first_message, FORK_NAME);
  assert.equal(forked.message_count, NO_MESSAGES);
  const unforked = listed.items.find(({ id }) => id === PLAIN_ID);
  assert.ok(unforked);
  assert.equal(unforked.forked_from, null);
  assert.equal(unforked.first_message, PLAIN_TEXT);

  const read = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: FORK_ID }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(read.forked_from, SOURCE_ID);
  const texts = read.entries.flatMap((entry) =>
    entry.type === MESSAGE_ENTRY
      ? [JSON.stringify((entry.message as { content: unknown }).content)]
      : [],
  );
  assert.equal(texts.length, SINGLE);
  assert.ok(texts[0]!.includes(SUMMARY.split("\n")[0]!));
  assert.ok(!texts.some((text) => text.includes(WORKBENCH_FORK_ACK)));
});

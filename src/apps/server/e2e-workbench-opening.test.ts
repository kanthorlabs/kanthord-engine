import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { directClient } from "../../gateway/index.ts";
import { loadPi } from "../../agent/pi.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  WORKBENCH_OPENING_TEXT,
  workbenchOperations,
} from "../../workbench/contract.ts";
import { gatewayFixture } from "./test-support.ts";

const HOST_AGENT = "re@1";
const PARTICIPANT_AGENT = "ops@1";
const HOST_ID = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PARTICIPANT_ID = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const GREETING = "Hi, I am RE on claude-sonnet-4-5. What do you need?";
const MENTION_REQUEST = "@RE summarize the open objectives.";
const OPENING_MESSAGE_COUNT = 1;
const NO_COUNT = 0;
const NO_TEXT = "";
const TEST_TIMEOUT_MS = 60000;
const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-opening");

function completed<T>(result: OperationResult<T>): T {
  assert.equal(result.type, OperationResultType.Completed);
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

function placeOf(state: string, agentName: string) {
  return {
    cwd: join(state, "workbench", agentName),
    sessionDir: join(state, "pi", "sessions", "workbench", agentName),
  };
}

test(
  "the list hides the opening pair and names the host of a participant",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const pi = await loadPi();
    const host = pi.SessionManager.create(
      placeOf(state, HOST_AGENT).cwd,
      placeOf(state, HOST_AGENT).sessionDir,
      { id: HOST_ID },
    );
    host.appendMessage({
      role: "user",
      content: [{ type: "text", text: WORKBENCH_OPENING_TEXT }],
      timestamp: Date.now(),
    });
    host.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: GREETING }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: NO_COUNT,
        output: NO_COUNT,
        cacheRead: NO_COUNT,
        cacheWrite: NO_COUNT,
        totalTokens: NO_COUNT,
        cost: {
          input: NO_COUNT,
          output: NO_COUNT,
          cacheRead: NO_COUNT,
          cacheWrite: NO_COUNT,
          total: NO_COUNT,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const hostFile = host.getSessionFile();
    assert.ok(hostFile);
    const participant = pi.SessionManager.create(
      placeOf(state, PARTICIPANT_AGENT).cwd,
      placeOf(state, PARTICIPANT_AGENT).sessionDir,
      { id: PARTICIPANT_ID, parentSession: hostFile },
    );
    participant.appendMessage({
      role: "user",
      content: MENTION_REQUEST,
      timestamp: Date.now(),
    });
    const fixture = await gatewayFixture(t, { stateDirectory: state });
    const workbench = directClient(workbenchOperations, fixture.invocation);
    const listed = completed(
      await workbench["session.list"](
        { params: {}, query: {}, body: null },
        { identity },
      ),
    );
    const byId = new Map(listed.items.map((item) => [item.id, item]));
    assert.equal(byId.get(HOST_ID)?.first_message, NO_TEXT);
    assert.equal(byId.get(HOST_ID)?.message_count, OPENING_MESSAGE_COUNT);
    assert.equal(byId.get(HOST_ID)?.host_session_id, null);
    assert.equal(byId.get(PARTICIPANT_ID)?.first_message, MENTION_REQUEST);
    assert.equal(byId.get(PARTICIPANT_ID)?.host_session_id, HOST_ID);
  },
);

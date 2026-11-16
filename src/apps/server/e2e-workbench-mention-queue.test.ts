import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  OPS_AGENT_PROMPT,
  RE_AGENT_PROMPT,
} from "../../agent/prompt-assets.ts";
import { AgentErrorCode } from "../../agent/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { MessageDelivery } from "../../workbench/contract.ts";
import {
  completed,
  createHost,
  heldAnswer,
  sendMessage,
  untilAbort,
  untilIdle,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-queue");
const { conversationFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const REVIEW_DISPLAY_NAME = "RE";
const FIRST_REQUEST = "Which objectives are open?";
const REVIEW_REQUEST = "@RE check the open objectives.";
const UNTAGGED_REQUEST = "And what else?";
const UNKNOWN_REQUEST = "@Guard hi";
const ANSWER = "Two objectives are open.";
const REVIEW_ANSWER = "RE checked them.";
const LAST_ANSWER = "RE has nothing else.";
const NO_ITEMS = 0;
const SINGLE = 1;
const TEST_TIMEOUT_MS = 60000;

type Fixture = WorkbenchFixture;

function failed(
  result: OperationResult<unknown>,
  status: number,
  code: string,
): void {
  assert.equal(result.type, OperationResultType.Failure);
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
}

async function snapshotOf(fixture: Fixture, hostId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: hostId }, query: {}, body: null },
      fixture.options,
    ),
  ).snapshot;
}

function promptsOf(fixture: Fixture): (string | undefined)[] {
  return fixture.provider.calls.map(({ systemPrompt }) => {
    if (systemPrompt?.includes(RE_AGENT_PROMPT)) return REVIEW_AGENT;
    if (systemPrompt?.includes(OPS_AGENT_PROMPT)) return OPS;
    return undefined;
  });
}

async function runningHost(
  t: TestContext,
  script: Parameters<typeof conversationFixture>[1],
) {
  const { fixture } = await conversationFixture(t, script);
  const host = await createHost(fixture, OPS);
  const started = completed(await sendMessage(fixture, host.id, FIRST_REQUEST));
  assert.equal(started.agent_name, OPS);
  return { fixture, host };
}

test(
  "(happy path) an @RE item queued during a Yumi run runs re@1 and the untagged item behind it runs the last responder",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(ANSWER);
    const { fixture, host } = await runningHost(t, [
      first.step,
      async () => fauxAssistantMessage(REVIEW_ANSWER),
      async () => fauxAssistantMessage(LAST_ANSWER),
    ]);
    const mentioned = completed(
      await sendMessage(fixture, host.id, REVIEW_REQUEST),
    );
    assert.equal(mentioned.agent_name, REVIEW_AGENT);
    assert.ok(mentioned.queued_message_id);
    const untagged = completed(
      await sendMessage(fixture, host.id, UNTAGGED_REQUEST),
    );
    assert.equal(untagged.agent_name, null);
    assert.ok(untagged.queued_message_id);
    assert.deepEqual((await snapshotOf(fixture, host.id)).queue, [
      {
        id: mentioned.queued_message_id,
        text: REVIEW_REQUEST,
        agent_name: REVIEW_AGENT,
        display_name: REVIEW_DISPLAY_NAME,
      },
      {
        id: untagged.queued_message_id,
        text: UNTAGGED_REQUEST,
        agent_name: null,
        display_name: null,
      },
    ]);
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    assert.deepEqual(promptsOf(fixture), [OPS, REVIEW_AGENT, REVIEW_AGENT]);
    assert.equal((await snapshotOf(fixture, host.id)).queue.length, NO_ITEMS);
  },
);

test(
  "(happy path, stop) a stop during an re@1 run aborts the re@1 agent and clears the queue",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const waiting = untilAbort(ANSWER);
    const { fixture } = await conversationFixture(t, [
      async (context, options) => {
        started.resolve();
        return waiting(context, options);
      },
      async () => fauxAssistantMessage(LAST_ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    const accepted = completed(
      await sendMessage(fixture, host.id, REVIEW_REQUEST),
    );
    assert.equal(accepted.agent_name, REVIEW_AGENT);
    await started.promise;
    const queued = completed(
      await sendMessage(fixture, host.id, UNTAGGED_REQUEST),
    );
    const stopped = completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    assert.deepEqual(stopped, {
      session_id: host.id,
      run_active: false,
      cleared: [
        {
          id: queued.queued_message_id,
          text: UNTAGGED_REQUEST,
          agent_name: null,
          display_name: null,
        },
      ],
    });
    const snapshot = await snapshotOf(fixture, host.id);
    assert.equal(snapshot.run_active, false);
    assert.equal(snapshot.queue.length, NO_ITEMS);
    assert.equal(fixture.provider.calls.length, SINGLE);
  },
);

test(
  "(security, argument guard) an unknown mention during a run answers 404 and leaves the queue unchanged",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(ANSWER);
    const { fixture, host } = await runningHost(t, [first.step]);
    const queued = completed(
      await sendMessage(fixture, host.id, UNTAGGED_REQUEST),
    );
    const before = (await snapshotOf(fixture, host.id)).queue;
    failed(
      await sendMessage(fixture, host.id, UNKNOWN_REQUEST),
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
    );
    failed(
      await fixture.workbench["session.message"](
        {
          params: { session_id: host.id },
          query: {},
          body: { text: UNKNOWN_REQUEST, delivery: MessageDelivery.Replace },
        },
        fixture.options,
      ),
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
    );
    const after = await snapshotOf(fixture, host.id);
    assert.deepEqual(after.queue, before);
    assert.equal(after.queue[0]!.id, queued.queued_message_id);
    assert.equal(after.run_active, true);
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
  },
);

test(
  "(security, argument guard) an @RE item whose agent is disabled before its start is dropped with an error and the next item runs",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(ANSWER);
    const { fixture, host } = await runningHost(t, [
      first.step,
      async () => fauxAssistantMessage(LAST_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, REVIEW_REQUEST));
    completed(await sendMessage(fixture, host.id, UNTAGGED_REQUEST));
    const enablement = completed(
      await fixture.agent["enablement.get"](
        { params: { agent_name: REVIEW_AGENT }, query: {}, body: null },
        fixture.options,
      ),
    );
    completed(
      await fixture.agent["enablement.disable"](
        {
          params: { agent_name: REVIEW_AGENT },
          query: {},
          body: { expected_revision: enablement.revision },
        },
        fixture.options,
      ),
    );
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    const snapshot = await snapshotOf(fixture, host.id);
    assert.ok(snapshot.error_message);
    assert.equal(snapshot.queue.length, NO_ITEMS);
    assert.deepEqual(promptsOf(fixture), [OPS, OPS]);
    const items = completed(
      await fixture.workbench["session.list"](
        { params: {}, query: {}, body: null },
        fixture.options,
      ),
    ).items;
    assert.deepEqual(items[0]!.participants, []);
  },
);

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { WorkbenchErrorCode } from "../../workbench/contract.ts";
import { type SeededNode, seedEvidence } from "./evidence-test-support.ts";
import {
  completed,
  createHost,
  invitedProjectIds,
  pumpTimers,
  sendMessage,
  toolCall,
  untilIdle,
  untilSettled,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "evidence-shared");
const { workbenchFixture } = workbenchHarness(identity);
const REVIEW_AGENT = "re@1";
const EVIDENCE_READ = "evidence_read";
const DOWNLOAD_OPERATION = "mission.evidence.asset.content.download";
const SHARED_CONVERSATION = "workbench.evidence.shared_conversation";
const TOOL_RESULT = "toolResult";
const MESSAGE_ENTRY = "message";
const ALPHA_TEXT = "alpha evidence text";
const BETA_TEXT = "beta evidence text";
const ANSWER = "The evidence is read.";
const GUEST_NAME = "Mira";
const MENTION = "@RE read the evidence.";
const FIRST_ASSET = 0;
const SECOND_ASSET = 1;
const NO_ITEMS = 0;
const SINGLE = 1;
const TEST_TIMEOUT_MS = 60000;
const FIRST_NODE = 0;
const NAME_DIFFERENCE = "x";

interface EvidenceTarget {
  nodes: SeededNode[];
}

interface ToolOutcome {
  isError: boolean;
  text: string;
}

function failed(
  result: OperationResult<unknown>,
  status: number,
  code: string,
): void {
  assert.equal(
    result.type,
    OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
}

function evidenceCall(target: EvidenceTarget, asset: number) {
  return () => {
    const found = target.nodes[FIRST_NODE]!.produced[asset]!;
    return toolCall(EVIDENCE_READ, {
      evidence_id: found.evidenceId,
      asset_id: found.assetId,
    });
  };
}

async function evidenceHost(
  t: TestContext,
  script: (target: EvidenceTarget) => FauxResponseStep[],
) {
  const target: EvidenceTarget = { nodes: [] };
  const fixture = await workbenchFixture(
    t,
    script(target),
    undefined,
    undefined,
    [REVIEW_AGENT],
  );
  target.nodes = await seedEvidence(t, fixture, [
    { produced: [ALPHA_TEXT, BETA_TEXT] },
  ]);
  const host = await createHost(fixture, REVIEW_AGENT);
  const nodeId = target.nodes[FIRST_NODE]!.nodeId;
  const node = completed(
    await fixture.missions["node.get"](
      { params: { node_id: nodeId }, query: {}, body: null },
      fixture.options,
    ),
  );
  return { fixture, host, nodeId, nodeName: node.content.name };
}

async function invite(fixture: WorkbenchFixture, sessionId: string) {
  return completed(
    await fixture.workbench["invite.create"](
      {
        params: { session_id: sessionId },
        query: {},
        body: {
          invitee_name: GUEST_NAME,
          project_ids: await invitedProjectIds(fixture),
        },
      },
      fixture.options,
    ),
  );
}

function decide(
  fixture: WorkbenchFixture,
  sessionId: string,
  decision: { toolCallId: string; approved: boolean; nodeName?: string },
) {
  return fixture.workbench["session.approve"](
    {
      params: { session_id: sessionId },
      query: {},
      body: {
        tool_call_id: decision.toolCallId,
        approved: decision.approved,
        ...(decision.nodeName === undefined
          ? {}
          : { node_name: decision.nodeName }),
      },
    },
    fixture.options,
  );
}

async function pendingOf(fixture: WorkbenchFixture, sessionId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  ).snapshot.pending_approval;
}

async function toolOutcomes(
  fixture: WorkbenchFixture,
  sessionId: string,
): Promise<ToolOutcome[]> {
  const { entries } = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map(
      (entry) =>
        entry.message as {
          role: string;
          isError?: boolean;
          content: { text?: string }[];
        },
    )
    .filter(({ role }) => role === TOOL_RESULT)
    .map(({ isError, content }) => ({
      isError: isError === true,
      text: content.map((block) => block.text ?? "").join(""),
    }));
}

async function sharedCard(
  t: TestContext,
  fixture: WorkbenchFixture,
  sessionId: string,
  text = MENTION,
) {
  completed(await sendMessage(fixture, sessionId, text));
  const pending = await untilSettled(fixture, sessionId, t.signal);
  assert.ok(pending);
  assert.equal(pending.operation_id, DOWNLOAD_OPERATION);
  assert.equal(pending.input.shared, true);
  return pending;
}

async function rejectAndSettle(
  t: TestContext,
  fixture: WorkbenchFixture,
  sessionId: string,
  toolCallId: string,
) {
  completed(await decide(fixture, sessionId, { toolCallId, approved: false }));
  await untilIdle(fixture, sessionId, t.signal);
}

test(
  "(security, authorization) a live invite empties the grants so a node granted before the invite shows a danger approval",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, SECOND_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, MENTION));
    const plain = await untilSettled(fixture, host.id, t.signal);
    assert.ok(plain);
    assert.equal(plain.input.shared, undefined);
    completed(
      await decide(fixture, host.id, {
        toolCallId: plain.tool_call_id,
        approved: true,
      }),
    );
    await untilIdle(fixture, host.id, t.signal);
    await invite(fixture, host.id);
    const pending = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, pending.tool_call_id);
  },
);

test(
  "(security, authorization) an owner message that holds the node id still shows the danger approval",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeId } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    const pending = await sharedCard(
      t,
      fixture,
      host.id,
      `@RE read the evidence of ${nodeId}.`,
    );
    assert.equal(pending.input.node_id, nodeId);
    await rejectAndSettle(t, fixture, host.id, pending.tool_call_id);
  },
);

test(
  "(security, argument guard) an approve with no node name answers 409 name_mismatch and the approval stays pending",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    const pending = await sharedCard(t, fixture, host.id);
    failed(
      await decide(fixture, host.id, {
        toolCallId: pending.tool_call_id,
        approved: true,
      }),
      HttpStatus.Conflict,
      WorkbenchErrorCode.EvidenceNameMismatch,
    );
    assert.equal(
      (await pendingOf(fixture, host.id))?.tool_call_id,
      pending.tool_call_id,
    );
    assert.equal(fixture.provider.calls.length, SINGLE);
    await rejectAndSettle(t, fixture, host.id, pending.tool_call_id);
  },
);

test(
  "(security, argument guard) an approve with a name that differs in one byte answers 409 name_mismatch and the approval stays pending",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeName } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    const pending = await sharedCard(t, fixture, host.id);
    for (const typed of [
      `${nodeName.slice(NO_ITEMS, -SINGLE)}${NAME_DIFFERENCE}`,
      nodeName.toLowerCase(),
      ` ${nodeName}`,
    ])
      failed(
        await decide(fixture, host.id, {
          toolCallId: pending.tool_call_id,
          approved: true,
          nodeName: typed,
        }),
        HttpStatus.Conflict,
        WorkbenchErrorCode.EvidenceNameMismatch,
      );
    assert.equal(
      (await pendingOf(fixture, host.id))?.tool_call_id,
      pending.tool_call_id,
    );
    await rejectAndSettle(t, fixture, host.id, pending.tool_call_id);
  },
);

test(
  "(happy path) an approve with the exact node name runs the read and a second asset of the node runs with no approval",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeName } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      evidenceCall(target, SECOND_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    const pending = await sharedCard(t, fixture, host.id);
    completed(
      await decide(fixture, host.id, {
        toolCallId: pending.tool_call_id,
        approved: true,
        nodeName,
      }),
    );
    assert.equal(await untilSettled(fixture, host.id, t.signal), null);
    const outcomes = await toolOutcomes(fixture, host.id);
    assert.deepEqual(
      outcomes.map(({ isError }) => isError),
      [false, false],
    );
    assert.ok(outcomes[FIRST_ASSET]!.text.includes(ALPHA_TEXT));
    assert.ok(outcomes[SECOND_ASSET]!.text.includes(BETA_TEXT));
  },
);

test(
  "(security, refused path) a reject fails the call and grants nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    const first = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, first.tool_call_id);
    const outcomes = await toolOutcomes(fixture, host.id);
    assert.equal(outcomes.length, SINGLE);
    assert.ok(outcomes[FIRST_ASSET]!.isError);
    assert.ok(!outcomes[FIRST_ASSET]!.text.includes(ALPHA_TEXT));
    const second = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, second.tool_call_id);
  },
);

test(
  "(security, refused path) a typed approve after the expiry answers 404 approval_not_found and grants nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeName } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    await invite(fixture, host.id);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    pumpTimers(t);
    const pending = await sharedCard(t, fixture, host.id);
    t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
    await untilIdle(fixture, host.id, t.signal);
    failed(
      await decide(fixture, host.id, {
        toolCallId: pending.tool_call_id,
        approved: true,
        nodeName,
      }),
      HttpStatus.NotFound,
      WorkbenchErrorCode.ApprovalNotFound,
    );
    const next = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, next.tool_call_id);
  },
);

test(
  "(security, refused path) a plain approval after invite.create fails the call with shared_conversation and grants nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, MENTION));
    const plain = await untilSettled(fixture, host.id, t.signal);
    assert.ok(plain);
    assert.equal(plain.input.shared, undefined);
    await invite(fixture, host.id);
    completed(
      await decide(fixture, host.id, {
        toolCallId: plain.tool_call_id,
        approved: true,
      }),
    );
    await untilIdle(fixture, host.id, t.signal);
    const [outcome] = await toolOutcomes(fixture, host.id);
    assert.ok(outcome?.isError);
    assert.ok(outcome.text.includes(SHARED_CONVERSATION));
    assert.ok(!outcome.text.includes(ALPHA_TEXT));
    const next = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, next.tool_call_id);
  },
);

test(
  "(security, authorization) after the last revoke the typed grant still covers its node and a new invite clears it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeName } = await evidenceHost(t, (target) => [
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, SECOND_ASSET),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, FIRST_ASSET),
      fauxAssistantMessage(ANSWER),
    ]);
    const created = await invite(fixture, host.id);
    const pending = await sharedCard(t, fixture, host.id);
    completed(
      await decide(fixture, host.id, {
        toolCallId: pending.tool_call_id,
        approved: true,
        nodeName,
      }),
    );
    await untilIdle(fixture, host.id, t.signal);
    completed(
      await fixture.workbench["invite.revoke"](
        { params: { invite_id: created.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    completed(await sendMessage(fixture, host.id, MENTION));
    assert.equal(await untilSettled(fixture, host.id, t.signal), null);
    const outcomes = await toolOutcomes(fixture, host.id);
    assert.deepEqual(
      outcomes.map(({ isError }) => isError),
      [false, false],
    );
    await invite(fixture, host.id);
    const again = await sharedCard(t, fixture, host.id);
    await rejectAndSettle(t, fixture, host.id, again.tool_call_id);
  },
);

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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
import { temporaryDirectory } from "../../kernel/test-support.ts";
import { isString } from "../../kernel/values.ts";
import { WorkbenchErrorCode } from "../../workbench/contract.ts";
import { type SeededNode, seedEvidence } from "./evidence-test-support.ts";
import {
  AGENT,
  completed,
  DEFAULT,
  OFF,
  SONNET,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-members");
const SECOND_HUMAN = testHumanIdentity(
  "kanthord",
  "Grace",
  "workbench-members-2",
);
const { workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const ANSWER = "Two objectives are open.";
const SECOND_ANSWER = "Still two.";
const MENTION_REQUEST = "@RE summarize the open objectives.";
const FOLLOW_UP = "And what else?";
const EVIDENCE_READ = "evidence_read";
const EVIDENCE_TEXT = "alpha evidence text";
const DOWNLOAD_OPERATION = "mission.evidence.asset.content.download";
const MESSAGE_ENTRY = "message";
const USER_ROLE = "user";
const TOOL_USE = "toolUse" as const;
const QUEUED_MESSAGE_ID = "workbench_queued_message_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NO_ITEMS = 0;
const SINGLE = 1;
const TWO_RUNS = 2;
const TEST_TIMEOUT_MS = 60000;
const CONFIGURATION = {
  agent_provider: DEFAULT,
  model_identifier: SONNET,
  reasoning_effort: OFF,
};

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Entry = Record<string, unknown>;

function failed(
  result: OperationResult<unknown>,
  status: number,
  code: string,
): Record<string, unknown> | null | undefined {
  assert.equal(
    result.type,
    OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  return result.error.error.details as Record<string, unknown> | null;
}

function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: TOOL_USE,
  });
}

function sessionFiles(state: string, agentName: string): string[] {
  const directory = join(state, "pi", "sessions", "workbench", agentName);
  return existsSync(directory)
    ? readdirSync(directory).map((name) => join(directory, name))
    : [];
}

function fileEntries(file: string): Entry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry);
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

async function createHost(fixture: Fixture, agentName = OPS) {
  return completed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: { agent_name: agentName, ...CONFIGURATION },
      },
      fixture.options,
    ),
  );
}

function send(
  fixture: Fixture,
  sessionId: string,
  text: string,
  options = fixture.options,
) {
  return fixture.workbench["session.message"](
    { params: { session_id: sessionId }, query: {}, body: { text } },
    options,
  );
}

async function settled(
  fixture: Fixture,
  sessionId: string,
  signal: AbortSignal,
) {
  let version: number | undefined;
  let after: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const answer = completed(
      await fixture.workbench["session.events"](
        {
          params: { session_id: sessionId },
          query: {
            ...(after === undefined ? {} : { after }),
            ...(version === undefined ? {} : { version }),
          },
          body: null,
        },
        fixture.options,
      ),
    );
    after = (answer.entries.at(-SINGLE)?.id as string | undefined) ?? after;
    if (answer.snapshot.pending_approval)
      return answer.snapshot.pending_approval;
    if (!answer.snapshot.run_active && !answer.snapshot.queue.length)
      return null;
    version = answer.version;
  }
}

async function untilIdle(
  fixture: Fixture,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  assert.equal(await settled(fixture, sessionId, signal), null);
}

function decide(
  fixture: Fixture,
  sessionId: string,
  toolCallId: string,
  approved: boolean,
) {
  return fixture.workbench["session.approve"](
    {
      params: { session_id: sessionId },
      query: {},
      body: { tool_call_id: toolCallId, approved },
    },
    fixture.options,
  );
}

async function listed(fixture: Fixture) {
  return completed(
    await fixture.workbench["session.list"](
      { params: {}, query: {}, body: null },
      fixture.options,
    ),
  ).items;
}

async function participantOf(fixture: Fixture, hostId: string) {
  const [participant] = (await listed(fixture)).filter(
    (item) => item.host_session_id === hostId,
  );
  assert.ok(participant);
  return participant;
}

function agentCalls(fixture: Fixture, prompt: string) {
  return fixture.provider.calls.filter(({ systemPrompt }) =>
    systemPrompt?.includes(prompt),
  );
}

async function members(
  t: TestContext,
  script: FauxResponseStep[] = [fauxAssistantMessage(ANSWER)],
  enabled: readonly string[] = [OPS, REVIEW_AGENT, AGENT],
) {
  const state = temporaryDirectory();
  const fixture = await workbenchFixture(t, script, state, undefined, enabled);
  return { state, fixture };
}

interface EvidenceTarget {
  nodes: SeededNode[];
}

function evidenceCall(target: EvidenceTarget) {
  return () => {
    const found = target.nodes[0]!.produced[0]!;
    return toolCall(EVIDENCE_READ, {
      evidence_id: found.evidenceId,
      asset_id: found.assetId,
    });
  };
}

async function evidenceMembers(
  t: TestContext,
  script: (target: EvidenceTarget) => FauxResponseStep[],
) {
  const target: EvidenceTarget = { nodes: [] };
  const built = await members(t, script(target));
  target.nodes = await seedEvidence(t, built.fixture, [
    { produced: [EVIDENCE_TEXT] },
  ]);
  const host = await createHost(built.fixture);
  return { ...built, target, host, nodeId: target.nodes[0]!.nodeId };
}

test(
  "(happy path, mention) a first message with @RE in an ops@1 host creates an re@1 participant and runs it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await members(t);
    const host = await createHost(fixture);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const [hostFile] = sessionFiles(state, OPS);
    const [participantFile] = sessionFiles(state, REVIEW_AGENT);
    assert.ok(hostFile && participantFile);
    assert.equal(fileEntries(participantFile)[0]!.parentSession, hostFile);
    const participant = await participantOf(fixture, host.id);
    assert.equal(participant.agent_name, REVIEW_AGENT);
    assert.equal(fixture.provider.calls.length, SINGLE);
    assert.ok(agentCalls(fixture, RE_AGENT_PROMPT).length === SINGLE);
    assert.deepEqual(userTexts(fileEntries(participantFile)).slice(-SINGLE), [
      MENTION_REQUEST,
    ]);
    assert.ok(!userTexts(fileEntries(hostFile)).includes(MENTION_REQUEST));
    assert.equal(
      sessionFiles(state, AGENT).length +
        sessionFiles(state, REVIEW_AGENT).length,
      SINGLE,
    );
  },
);

test(
  "(happy path, untagged) an untagged follow-up after the RE answer runs re@1, the member that answered last",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await members(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const host = await createHost(fixture);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(await send(fixture, host.id, FOLLOW_UP));
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, TWO_RUNS);
    assert.equal(agentCalls(fixture, RE_AGENT_PROMPT).length, TWO_RUNS);
    assert.equal(agentCalls(fixture, OPS_AGENT_PROMPT).length, NO_ITEMS);
    assert.equal(
      (await listed(fixture)).filter((item) => item.host_session_id === host.id)
        .length,
      SINGLE,
    );
  },
);

test(
  "(happy path, approve) approve takes the participant session id of the pending call",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceMembers(t, (target) => [
      evidenceCall(target),
      fauxAssistantMessage(ANSWER),
    ]);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    const pending = await settled(fixture, host.id, t.signal);
    assert.ok(pending);
    const participant = await participantOf(fixture, host.id);
    assert.equal(pending.session_id, participant.id);
    assert.equal(pending.operation_id, DOWNLOAD_OPERATION);
    failed(
      await decide(fixture, host.id, pending.tool_call_id, true),
      HttpStatus.NotFound,
      WorkbenchErrorCode.ApprovalNotFound,
    );
    assert.deepEqual(
      completed(
        await decide(fixture, participant.id, pending.tool_call_id, true),
      ),
      {
        session_id: participant.id,
        tool_call_id: pending.tool_call_id,
        approved: true,
      },
    );
    await untilIdle(fixture, host.id, t.signal);
    const context = JSON.stringify(
      fixture.provider.calls.at(-SINGLE)!.messages,
    );
    assert.ok(context.includes(EVIDENCE_TEXT));
  },
);

test(
  "(security, refused path) the host-only operations on a participant id answer 409 not_host",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await members(t);
    const host = await createHost(fixture);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const participant = await participantOf(fixture, host.id);
    const params = { session_id: participant.id };
    const answers = [
      await fixture.workbench["session.get"](
        { params, query: {}, body: null },
        fixture.options,
      ),
      await fixture.workbench["session.events"](
        { params, query: {}, body: null },
        fixture.options,
      ),
      await send(fixture, participant.id, FOLLOW_UP),
      await fixture.workbench["session.abort"](
        { params, query: {}, body: null },
        fixture.options,
      ),
      await fixture.workbench["session.queue.remove"](
        {
          params: { ...params, queued_message_id: QUEUED_MESSAGE_ID },
          query: {},
          body: null,
        },
        fixture.options,
      ),
      await fixture.workbench["session.autoMode.set"](
        { params, query: {}, body: { enabled: false } },
        fixture.options,
      ),
    ];
    for (const answer of answers)
      assert.deepEqual(
        failed(answer, HttpStatus.Conflict, WorkbenchErrorCode.NotHost),
        { session_id: participant.id, host_session_id: host.id },
      );
    assert.equal(fixture.provider.calls.length, SINGLE);
  },
);

test(
  "(security, guard floor) a participant run reads the auto mode of its host",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeId } = await evidenceMembers(t, (target) => [
      evidenceCall(target),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await send(fixture, host.id, `@RE Review ${nodeId}`));
    await untilIdle(fixture, host.id, t.signal);
    completed(
      await fixture.workbench["session.autoMode.set"](
        {
          params: { session_id: host.id },
          query: {},
          body: { enabled: false },
        },
        fixture.options,
      ),
    );
    completed(await send(fixture, host.id, `@RE Review ${nodeId} again`));
    const pending = await settled(fixture, host.id, t.signal);
    assert.ok(pending);
    assert.equal(pending.input.node_id, nodeId);
    assert.equal(
      pending.session_id,
      (await participantOf(fixture, host.id)).id,
    );
    completed(
      await decide(fixture, pending.session_id, pending.tool_call_id, false),
    );
    await untilIdle(fixture, host.id, t.signal);
  },
);

test(
  "(security, argument guard) @Guard answers 404 and creates no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await members(t, []);
    const host = await createHost(fixture);
    const details = failed(
      await send(fixture, host.id, "@Guard hi"),
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
    );
    assert.deepEqual(details, { mention: "Guard" });
    assert.equal((await listed(fixture)).length, SINGLE);
    assert.equal(sessionFiles(state, REVIEW_AGENT).length, NO_ITEMS);
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
    const snapshot = completed(
      await fixture.workbench["session.events"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    ).snapshot;
    assert.equal(snapshot.run_active, false);
  },
);

test(
  "(security, argument guard) a mention of a disabled agent answers 400 and creates no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await members(t, []);
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
    const host = await createHost(fixture);
    failed(
      await send(fixture, host.id, MENTION_REQUEST),
      HttpStatus.BadRequest,
      AgentErrorCode.Unavailable,
    );
    assert.equal((await listed(fixture)).length, SINGLE);
    assert.equal(sessionFiles(state, REVIEW_AGENT).length, NO_ITEMS);
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
  },
);

test(
  "(security, authorization) an evidence grant on the host covers an @SWE member read of the same node",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await evidenceMembers(t, (target) => [
      evidenceCall(target),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    const pending = await settled(fixture, host.id, t.signal);
    assert.ok(pending);
    completed(
      await decide(fixture, pending.session_id, pending.tool_call_id, true),
    );
    await untilIdle(fixture, host.id, t.signal);
    completed(await send(fixture, host.id, "@SWE read the evidence."));
    await untilIdle(fixture, host.id, t.signal);
    const swe = (await listed(fixture)).find(
      (item) => item.agent_name === AGENT,
    );
    assert.equal(swe?.host_session_id, host.id);
    assert.ok(
      JSON.stringify(fixture.provider.calls.at(-SINGLE)!.messages).includes(
        EVIDENCE_TEXT,
      ),
    );
  },
);

test(
  "(security, authorization) a participant run uses the requester of its own message",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await members(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const host = await createHost(fixture);
    const authorize = t.mock.method(fixture.workbenchService, "authorize");
    completed(await send(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(
      await send(fixture, host.id, FOLLOW_UP, { identity: SECOND_HUMAN }),
    );
    await untilIdle(fixture, host.id, t.signal);
    const requesters = authorize.mock.calls
      .map(({ arguments: [, requester] }) => requester.jti)
      .filter((jti, index, all) => jti !== all[index - SINGLE]);
    assert.deepEqual(requesters, [identity.jti, SECOND_HUMAN.jti]);
  },
);

test(
  "(invariant, two-writer race) configure on a participant during a run answers 409 run_active and keeps the participant agent open",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const gate = Promise.withResolvers<void>();
    const { fixture } = await members(t, [
      async () => {
        await gate.promise;
        return fauxAssistantMessage(ANSWER);
      },
    ]);
    const host = await createHost(fixture);
    completed(await send(fixture, host.id, MENTION_REQUEST));
    const participant = await participantOf(fixture, host.id);
    const service = fixture.workbenchService as unknown as {
      sessions: Map<string, { agent: unknown }>;
    };
    assert.ok(service.sessions.get(participant.id)?.agent);
    failed(
      await fixture.workbench["session.configure"](
        {
          params: { session_id: participant.id },
          query: {},
          body: CONFIGURATION,
        },
        fixture.options,
      ),
      HttpStatus.Conflict,
      WorkbenchErrorCode.RunActive,
    );
    assert.ok(service.sessions.get(participant.id)?.agent);
    gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
  },
);

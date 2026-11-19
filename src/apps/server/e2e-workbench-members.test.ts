import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  OPS_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "../../agent/prompt-assets.ts";
import { AgentErrorCode } from "../../agent/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { isString } from "../../kernel/values.ts";
import { WorkbenchErrorCode } from "../../workbench/contract.ts";
import { toolName } from "../../workbench/index.ts";
import { type SeededNode, seedEvidence } from "./evidence-test-support.ts";
import {
  AGENT,
  completed,
  createHost,
  DEFAULT,
  OFF,
  sendMessage,
  SONNET,
  toolCall,
  untilIdle,
  untilSettled,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-members");
const SECOND_HUMAN = testHumanIdentity(
  "kanthord",
  "Grace",
  "workbench-members-2",
);
const { conversationFixture, workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const ANSWER = "Two objectives are open.";
const SECOND_ANSWER = "Still two.";
const MENTION_REQUEST = "@RE summarize the open objectives.";
const FOLLOW_UP = "And what else?";
const EVIDENCE_READ = "evidence_read";
const EVIDENCE_TEXT = "alpha evidence text";
const NODE_GET_OPERATION = "mission.node.get";
const DOWNLOAD_OPERATION = "mission.evidence.asset.content.download";
const MESSAGE_ENTRY = "message";
const USER_ROLE = "user";
const QUEUED_MESSAGE_ID = "workbench_queued_message_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NO_ITEMS = 0;
const SINGLE = 1;
const TWO_RUNS = 2;
const THREE_RUNS = 3;
const TWO_MEMBERS = 2;
const MASTER_KEY_BYTES = 32;
const JSONL_SUFFIX = ".jsonl";
const VARIANT_NAME = "Software Architecture";
const VARIANT_INSTRUCTION = "Review the design before any code.";
const VARIANT_REQUEST = `@${VARIANT_NAME} review the plan.`;
const NIGHT_OPS_NAME = "Night Ops";
const BASE_MENTION_REQUEST = "@Yumi what is open?";
const BOOM = "participant start failed";
const TEST_TIMEOUT_MS = 60000;
const CONFIGURATION = {
  agent_provider: DEFAULT,
  model_identifier: SONNET,
  reasoning_effort: OFF,
};

type Fixture = WorkbenchFixture;
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
  ).items.flatMap((item) => [item, ...item.participants]);
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
  const built = await conversationFixture(t, script(target));
  target.nodes = await seedEvidence(t, built.fixture, [
    { produced: [EVIDENCE_TEXT] },
  ]);
  const host = await createHost(built.fixture, OPS);
  return { ...built, target, host, nodeId: target.nodes[0]!.nodeId };
}

test(
  "(happy path, mention) a first message with @RE in an ops@1 host creates an re@1 participant and runs it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
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
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, FOLLOW_UP));
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
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    const pending = await untilSettled(fixture, host.id, t.signal);
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
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
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
      await sendMessage(fixture, participant.id, FOLLOW_UP),
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
    completed(await sendMessage(fixture, host.id, `@RE Review ${nodeId}`));
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
    completed(
      await sendMessage(fixture, host.id, `@RE Review ${nodeId} again`),
    );
    const pending = await untilSettled(fixture, host.id, t.signal);
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
    const { state, fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const details = failed(
      await sendMessage(fixture, host.id, "@Guard hi"),
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
    const { state, fixture } = await conversationFixture(t, []);
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
    const host = await createHost(fixture, OPS);
    failed(
      await sendMessage(fixture, host.id, MENTION_REQUEST),
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
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    const pending = await untilSettled(fixture, host.id, t.signal);
    assert.ok(pending);
    completed(
      await decide(fixture, pending.session_id, pending.tool_call_id, true),
    );
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, "@SWE read the evidence."));
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
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    const authorize = t.mock.method(fixture.workbenchService, "authorize");
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(
      await sendMessage(fixture, host.id, FOLLOW_UP, {
        identity: SECOND_HUMAN,
      }),
    );
    await untilIdle(fixture, host.id, t.signal);
    const requesters = authorize.mock.calls
      .map(({ arguments: [, requester] }) => requester.jti)
      .filter((jti, index, all) => jti !== all[index - SINGLE]);
    assert.deepEqual(requesters, [identity.jti, SECOND_HUMAN.jti]);
  },
);

test(
  "(security, authorization) a participant operation tool call runs with the requester of the run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, nodeId } = await evidenceMembers(t, (target) => [
      () =>
        toolCall(toolName(NODE_GET_OPERATION), {
          params: { node_id: target.nodes[0]!.nodeId },
        }),
      fauxAssistantMessage(ANSWER),
    ]);
    const service = fixture.workbenchService as unknown as {
      dependencies: { invoke: unknown };
    };
    const invoke = t.mock.method(
      service.dependencies,
      "invoke" as never,
    ) as unknown as {
      mock: {
        calls: {
          arguments: [{ id: string }, unknown, { identity?: unknown }];
        }[];
      };
    };
    completed(
      await sendMessage(fixture, host.id, `@RE Review ${nodeId}`, {
        identity: SECOND_HUMAN,
      }),
    );
    await untilIdle(fixture, host.id, t.signal);
    const identities = invoke.mock.calls
      .filter(
        ({ arguments: [operation] }) => operation.id === NODE_GET_OPERATION,
      )
      .map(({ arguments: [, , options] }) => options.identity);
    assert.deepEqual(identities, [SECOND_HUMAN]);
  },
);

test(
  "(invariant, two-writer race) configure on a participant during a run answers 409 run_active and keeps the participant agent open",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const gate = Promise.withResolvers<void>();
    const { fixture } = await conversationFixture(t, [
      async () => {
        await gate.promise;
        return fauxAssistantMessage(ANSWER);
      },
    ]);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
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

function variantFiles(
  state: string,
  agentName: string,
  variantId: string,
): string[] {
  const directory = join(
    state,
    "pi",
    "sessions",
    "workbench",
    agentName,
    variantId,
  );
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(JSONL_SUFFIX))
        .map((name) => join(directory, name))
    : [];
}

function baseFiles(state: string, agentName: string): string[] {
  const directory = join(state, "pi", "sessions", "workbench", agentName);
  return readdirSync(directory)
    .filter((name) => name.endsWith(JSONL_SUFFIX))
    .map((name) => join(directory, name));
}

async function newVariant(
  fixture: Fixture,
  agentName: string,
  displayName: string,
) {
  return completed(
    await fixture.agent["variant.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: agentName,
          display_name: displayName,
          instruction: VARIANT_INSTRUCTION,
        },
      },
      fixture.options,
    ),
  );
}

function deleteVariant(
  fixture: Fixture,
  variant: { id: string; revision: number },
) {
  return fixture.agent["variant.delete"](
    {
      params: { variant_id: variant.id },
      query: {},
      body: { expected_revision: variant.revision },
    },
    fixture.options,
  );
}

async function pollMembers(fixture: Fixture, hostId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: hostId }, query: {}, body: null },
      fixture.options,
    ),
  );
}

test(
  "(happy path, variant mention) @Software Architecture in an ops@1 host starts a variant participant in the variant directory",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    const variant = await newVariant(fixture, AGENT, VARIANT_NAME);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, VARIANT_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const [hostFile] = sessionFiles(state, OPS);
    const [participantFile] = variantFiles(state, AGENT, variant.id);
    assert.ok(hostFile && participantFile);
    assert.equal(baseFiles(state, AGENT).length, NO_ITEMS);
    assert.equal(fileEntries(participantFile)[0]!.parentSession, hostFile);
    assert.deepEqual(userTexts(fileEntries(participantFile)).slice(-SINGLE), [
      VARIANT_REQUEST,
    ]);
    assert.ok(!userTexts(fileEntries(hostFile)).includes(VARIANT_REQUEST));
    const participant = await participantOf(fixture, host.id);
    assert.equal(participant.variant_id, variant.id);
    assert.equal(participant.display_name, VARIANT_NAME);
    const prompt = fixture.provider.calls[0]!.systemPrompt!;
    const identityPart = prompt.indexOf(`Your name is ${VARIANT_NAME}.`);
    const role = prompt.indexOf(SWE_AGENT_PROMPT);
    const instruction = prompt.indexOf(VARIANT_INSTRUCTION);
    const workbench = prompt.indexOf(WORKBENCH_PROMPT);
    assert.ok(identityPart >= NO_ITEMS);
    assert.ok(identityPart < role);
    assert.ok(role < instruction);
    assert.ok(instruction < workbench);
    const { members } = await pollMembers(fixture, host.id);
    assert.deepEqual(
      members.map(({ agent_name, display_name }) => [agent_name, display_name]),
      [
        [OPS, "Yumi"],
        [AGENT, VARIANT_NAME],
      ],
    );
    assert.equal(members[1]!.session_id, participant.id);
  },
);

test(
  "(happy path, two members) SWE and Software Architecture hold two sessions and a second variant mention reuses the first",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
      fauxAssistantMessage(ANSWER),
    ]);
    const variant = await newVariant(fixture, AGENT, VARIANT_NAME);
    const host = await createHost(fixture, OPS);
    for (const text of [
      "@SWE read the plan.",
      VARIANT_REQUEST,
      `${VARIANT_REQUEST} again`,
    ]) {
      completed(await sendMessage(fixture, host.id, text));
      await untilIdle(fixture, host.id, t.signal);
    }
    assert.equal(baseFiles(state, AGENT).length, SINGLE);
    assert.equal(variantFiles(state, AGENT, variant.id).length, SINGLE);
    const participants = (await listed(fixture)).filter(
      (item) => item.host_session_id === host.id,
    );
    assert.deepEqual(
      participants.map(({ variant_id }) => variant_id),
      [null, variant.id],
    );
    assert.equal(
      (await pollMembers(fixture, host.id)).members.length,
      THREE_RUNS,
    );
  },
);

test(
  "(happy path, variant host) @Yumi in a Night Ops host starts a base ops@1 participant and the host stays the Night Ops member",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    const variant = await newVariant(fixture, OPS, NIGHT_OPS_NAME);
    const host = completed(
      await fixture.workbench["session.create"](
        {
          params: {},
          query: {},
          body: { agent_name: OPS, variant_id: variant.id, ...CONFIGURATION },
        },
        fixture.options,
      ),
    );
    completed(await sendMessage(fixture, host.id, BASE_MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const [hostFile] = variantFiles(state, OPS, variant.id);
    const [participantFile] = baseFiles(state, OPS);
    assert.ok(hostFile && participantFile);
    assert.equal(fileEntries(participantFile)[0]!.parentSession, hostFile);
    const { members } = await pollMembers(fixture, host.id);
    assert.deepEqual(
      members.map(({ agent_name, display_name }) => [agent_name, display_name]),
      [
        [OPS, NIGHT_OPS_NAME],
        [OPS, "Yumi"],
      ],
    );
    assert.notEqual(members[0]!.session_id, members[1]!.session_id);
    assert.equal(members[0]!.session_id, host.id);
  },
);

test(
  "(happy path, D8) an untagged message after the variant answer runs the variant member",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    await newVariant(fixture, AGENT, VARIANT_NAME);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, VARIANT_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, FOLLOW_UP));
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, TWO_RUNS);
    for (const { systemPrompt } of fixture.provider.calls)
      assert.ok(systemPrompt?.includes(VARIANT_INSTRUCTION));
    assert.equal(
      (await listed(fixture)).filter((item) => item.host_session_id === host.id)
        .length,
      SINGLE,
    );
  },
);

test(
  "(happy path, restart) after a restart the list nests the variant participant and the merged poll answers it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const persistence = {
      path: join(temporary(t), "operational.db"),
      masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      resumed: false,
    };
    const agents = [OPS, REVIEW_AGENT, AGENT];
    const ids = { host: "", variant: "" };
    await t.test("start the conversation", async (step) => {
      const first = await workbenchFixture(
        step,
        [fauxAssistantMessage(ANSWER)],
        state,
        undefined,
        agents,
        undefined,
        persistence,
      );
      const variant = await newVariant(first, AGENT, VARIANT_NAME);
      const host = await createHost(first, OPS);
      completed(await sendMessage(first, host.id, VARIANT_REQUEST));
      await untilIdle(first, host.id, step.signal);
      ids.host = host.id;
      ids.variant = variant.id;
      assert.equal(
        (await first.workbenchService.stop()) ?? undefined,
        undefined,
      );
    });
    const second = await workbenchFixture(
      t,
      [],
      state,
      undefined,
      agents,
      undefined,
      { ...persistence, resumed: true },
    );
    const items = completed(
      await second.workbench["session.list"](
        { params: {}, query: {}, body: null },
        second.options,
      ),
    ).items;
    assert.deepEqual(
      items.map(({ id }) => id),
      [ids.host],
    );
    assert.deepEqual(
      items[0]!.participants.map(({ variant_id, display_name }) => [
        variant_id,
        display_name,
      ]),
      [[ids.variant, VARIANT_NAME]],
    );
    const polled = await pollMembers(second, ids.host);
    assert.deepEqual(
      polled.members.map(({ agent_name, display_name }) => [
        agent_name,
        display_name,
      ]),
      [
        [OPS, "Yumi"],
        [AGENT, VARIANT_NAME],
      ],
    );
    assert.equal(
      new Set(polled.entries.map(({ session_id }) => session_id)).size,
      TWO_MEMBERS,
    );
  },
);

test(
  "(invariant guard, in use) deleting a variant that is a member answers 409 in_use and keeps the participant file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    const variant = await newVariant(fixture, AGENT, VARIANT_NAME);
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, VARIANT_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    failed(
      await deleteVariant(fixture, variant),
      HttpStatus.Conflict,
      AgentErrorCode.VariantInUse,
    );
    assert.equal(variantFiles(state, AGENT, variant.id).length, SINGLE);
  },
);

test(
  "(invariant guard, rollback) a participant start that throws after the directory creation leaves no variant directory",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversationFixture(t, []);
    const variant = await newVariant(fixture, AGENT, VARIANT_NAME);
    const host = await createHost(fixture, OPS);
    t.mock.method(
      fixture.workbenchService,
      "buildRuntime" as never,
      (async () => {
        throw new Error(BOOM);
      }) as never,
      { times: SINGLE },
    );
    const result = await sendMessage(fixture, host.id, VARIANT_REQUEST);
    assert.equal(result.type, OperationResultType.Failure);
    assert.equal(
      existsSync(join(state, "pi", "sessions", "workbench", AGENT, variant.id)),
      false,
    );
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
    completed(await deleteVariant(fixture, variant));
  },
);

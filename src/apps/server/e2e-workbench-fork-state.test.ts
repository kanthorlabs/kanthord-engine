import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PromptTemplate } from "../../agent/contract.ts";
import { FORK_SUMMARY_PROMPT } from "../../agent/prompt-assets.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../../agent/prompt-templates.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import { WORKBENCH_FORK_PREFIX } from "../../workbench/contract.ts";
import { toolName } from "../../workbench/index.ts";
import { seedEvidence } from "./evidence-test-support.ts";
import {
  AGENT,
  callsOf,
  completed,
  createHost,
  fileOf,
  forkOf,
  GUARD_AGENT,
  pass,
  sendMessage,
  sessionFiles,
  storedEntries,
  textOf,
  toolCall,
  untilIdle,
  untilSettled,
  userRequestOf,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity(
  "kanthord",
  "Ulrich",
  "workbench-fork-state",
);
const { workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const FIRST_QUESTION = "How many objectives are open?";
const FIRST_ANSWER = "Two objectives are open.";
const ACTIVE_REQUEST = "Pause the operations project.";
const QUEUED_REQUEST = "Then list the objectives again.";
const SUMMARY =
  "Goal: finish node_9.\nOpen in the earlier conversation: node_9 is still blocked; no decision was made.";
const FORK_TEXT = "Continue with node_9.";
const FORK_ANSWER = "I continue with node_9.";
const REVIEW_ANSWER = "RE read the summary.";
const RELAY_HEAD = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Relay, {});
const RELAY_MAX_BYTES = 65536;
const RECORD_ENTRY = "kanthord.workbench.record";
const CUSTOM_ENTRY = "custom";
const USER_ROLE = "user";
const OFFER_ACTION = "offer_action";
const PROJECT_PAUSE = "project.pause";
const PROJECT_RESUME = "project.resume";
const DOWNLOAD_OPERATION = "mission.evidence.asset.content.download";
const ALPHA_TEXT = "alpha evidence text";
const BETA_TEXT = "beta evidence text";
const MASTER_KEY_BYTES = 32;
const LATER_MESSAGES = 7;
const LATER_BYTES = 10240;
const NO_ITEMS = 0;
const SINGLE = 1;
const TEST_TIMEOUT_MS = 60000;

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function firstTurn(
  t: TestContext,
  fixture: Fixture,
  agentName: string,
  text = FIRST_QUESTION,
) {
  const source = await createHost(fixture, agentName);
  completed(await sendMessage(fixture, source.id, text));
  await untilIdle(fixture, source.id, t.signal);
  return source;
}

async function createdProject(fixture: Fixture): Promise<string> {
  return completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: "operations" } },
      fixture.options,
    ),
  ).id;
}

function snapshotOf(fixture: Fixture, sessionId: string) {
  return fixture.workbench["session.events"](
    { params: { session_id: sessionId }, query: {}, body: null },
    fixture.options,
  ).then((result) => completed(result).snapshot);
}

function recordKinds(file: string): string[] {
  return storedEntries(file).flatMap((entry) =>
    entry.type === CUSTOM_ENTRY && entry.customType === RECORD_ENTRY
      ? [(entry.data as { kind: string }).kind]
      : [],
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

async function blockedSource(t: TestContext) {
  const state = temporary(t);
  const target = { projectId: "" };
  const fixture = await workbenchFixture(
    t,
    [
      fauxAssistantMessage(FIRST_ANSWER),
      () =>
        toolCall(toolName(PROJECT_PAUSE), {
          params: { project_id: target.projectId },
        }),
      fauxAssistantMessage(SUMMARY),
      pass(),
      fauxAssistantMessage(FORK_ANSWER),
      fauxAssistantMessage(FIRST_ANSWER),
      fauxAssistantMessage(FIRST_ANSWER),
    ],
    state,
    undefined,
    [OPS, GUARD_AGENT],
  );
  target.projectId = await createdProject(fixture);
  const source = await firstTurn(t, fixture, OPS);
  completed(
    await fixture.workbench["session.autoMode.set"](
      {
        params: { session_id: source.id },
        query: {},
        body: { enabled: false },
      },
      fixture.options,
    ),
  );
  completed(await sendMessage(fixture, source.id, ACTIVE_REQUEST));
  const pending = await untilSettled(fixture, source.id, t.signal);
  assert.ok(pending);
  completed(await sendMessage(fixture, source.id, QUEUED_REQUEST));
  return { state, fixture, source, pending };
}

async function finishSource(
  t: TestContext,
  state: {
    fixture: Fixture;
    source: { id: string };
    pending: { tool_call_id: string };
  },
) {
  completed(
    await decide(
      state.fixture,
      state.source.id,
      state.pending.tool_call_id,
      false,
    ),
  );
  await untilIdle(state.fixture, state.source.id, t.signal);
}

test(
  "(happy path, active source run) the material ends before the run request and holds the in-progress line",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const blocked = await blockedSource(t);
    const forked = completed(
      await forkOf(blocked.fixture, blocked.source.id, FORK_TEXT),
    );
    await untilIdle(blocked.fixture, forked.session_id, t.signal);
    const [summarizer] = callsOf(blocked.fixture, FORK_SUMMARY_PROMPT);
    const { conversation } = userRequestOf(summarizer!);
    assert.ok(conversation!.includes(`to @Yumi: ${FIRST_QUESTION}`));
    assert.ok(conversation!.includes(`Yumi: ${FIRST_ANSWER}`));
    assert.ok(
      conversation!.endsWith(
        `In progress in the earlier conversation: ${ACTIVE_REQUEST}.`,
      ),
    );
    assert.ok(!conversation!.includes(`to @Yumi: ${ACTIVE_REQUEST}`));
    assert.ok(!conversation!.includes(QUEUED_REQUEST));
    await finishSource(t, blocked);
  },
);

test(
  "(invariant, data loss) the source approval and queue stay after the fork and the fork queue is empty",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const blocked = await blockedSource(t);
    const before = readFileSync(fileOf(blocked.state, blocked.source.id, OPS));
    const forked = completed(
      await forkOf(blocked.fixture, blocked.source.id, FORK_TEXT),
    );
    await untilIdle(blocked.fixture, forked.session_id, t.signal);
    const source = await snapshotOf(blocked.fixture, blocked.source.id);
    assert.equal(
      source.pending_approval?.tool_call_id,
      blocked.pending.tool_call_id,
    );
    assert.deepEqual(
      source.queue.map(({ text }) => text),
      [QUEUED_REQUEST],
    );
    assert.equal(source.run_active, true);
    const fork = await snapshotOf(blocked.fixture, forked.session_id);
    assert.deepEqual(fork.queue, []);
    assert.equal(fork.pending_approval, null);
    assert.deepEqual(
      readFileSync(fileOf(blocked.state, blocked.source.id, OPS)),
      before,
    );
    await finishSource(t, blocked);
  },
);

test(
  "(happy path, mention) text with @RE runs re@1 first, its parentSession names the fork file and its relay starts with the summary",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const fixture = await workbenchFixture(
      t,
      [
        fauxAssistantMessage(FIRST_ANSWER),
        fauxAssistantMessage(SUMMARY),
        pass(),
        fauxAssistantMessage(REVIEW_ANSWER),
      ],
      state,
      undefined,
      [AGENT, REVIEW_AGENT, GUARD_AGENT],
    );
    const source = await firstTurn(t, fixture, AGENT);
    const forked = completed(
      await forkOf(fixture, source.id, `@RE ${FORK_TEXT}`),
    );
    await untilIdle(fixture, forked.session_id, t.signal);
    const [participantFile] = sessionFiles(state, REVIEW_AGENT);
    assert.ok(participantFile);
    assert.equal(
      storedEntries(participantFile)[0]!.parentSession,
      fileOf(state, forked.session_id),
    );
    const run = fixture.provider.calls.at(-SINGLE)!;
    const relays = (run.messages as { role: string; content: unknown }[])
      .filter(({ role }) => role === USER_ROLE)
      .map(({ content }) => textOf(content))
      .filter((text) => text.startsWith(RELAY_HEAD));
    assert.equal(relays.length, SINGLE);
    assert.ok(relays[0]!.startsWith(`${RELAY_HEAD}\n\n${SUMMARY}`));
    assert.ok(!relays[0]!.includes(WORKBENCH_FORK_PREFIX));
  },
);

test(
  "(invariant, data loss) a 60 KiB relay to re@1 keeps the summary",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const later = Array.from(
      { length: LATER_MESSAGES },
      (_, index) => `m${index}:${"x".repeat(LATER_BYTES)}`,
    );
    const fixture = await workbenchFixture(
      t,
      [
        fauxAssistantMessage(FIRST_ANSWER),
        fauxAssistantMessage(SUMMARY),
        pass(),
        fauxAssistantMessage(FORK_ANSWER),
        ...later.map(() => fauxAssistantMessage(FIRST_ANSWER)),
        fauxAssistantMessage(REVIEW_ANSWER),
      ],
      undefined,
      undefined,
      [AGENT, REVIEW_AGENT, GUARD_AGENT],
    );
    const source = await firstTurn(t, fixture, AGENT);
    const forked = completed(await forkOf(fixture, source.id, FORK_TEXT));
    await untilIdle(fixture, forked.session_id, t.signal);
    for (const text of later) {
      completed(await sendMessage(fixture, forked.session_id, text));
      await untilIdle(fixture, forked.session_id, t.signal);
    }
    completed(await sendMessage(fixture, forked.session_id, "@RE read this."));
    await untilIdle(fixture, forked.session_id, t.signal);
    const run = fixture.provider.calls.at(-SINGLE)!;
    const [relay] = (run.messages as { role: string; content: unknown }[])
      .filter(({ role }) => role === USER_ROLE)
      .map(({ content }) => textOf(content))
      .filter((text) => text.startsWith(RELAY_HEAD));
    assert.ok(relay);
    assert.ok(Buffer.byteLength(relay) <= RELAY_MAX_BYTES);
    assert.ok(relay.startsWith(`${RELAY_HEAD}\n\n${SUMMARY}`));
    assert.ok(relay.includes(later.at(-SINGLE)!));
    assert.ok(!relay.includes(later[0]!));
  },
);

test(
  "(security, authorization) a source with action_offer and guard records gives a fork with none of them",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const target = { projectId: "" };
    const fixture = await workbenchFixture(
      t,
      [
        () =>
          toolCall(toolName(PROJECT_PAUSE), {
            params: { project_id: target.projectId },
          }),
        fauxAssistantMessage(FIRST_ANSWER),
        () =>
          toolCall(OFFER_ACTION, {
            operation_id: PROJECT_RESUME,
            target_id: target.projectId,
          }),
        fauxAssistantMessage(FIRST_ANSWER),
        fauxAssistantMessage(SUMMARY),
        pass(),
        fauxAssistantMessage(FORK_ANSWER),
      ],
      state,
      undefined,
      [OPS, GUARD_AGENT],
    );
    target.projectId = await createdProject(fixture);
    const source = await createHost(fixture, OPS);
    for (const request of [FIRST_QUESTION, ACTIVE_REQUEST]) {
      completed(await sendMessage(fixture, source.id, request));
      await untilIdle(fixture, source.id, t.signal);
    }
    const sourceFile = fileOf(state, source.id, OPS);
    const before = readFileSync(sourceFile);
    assert.ok(recordKinds(sourceFile).includes("guard"));
    assert.ok(recordKinds(sourceFile).includes("action_offer"));
    const forked = completed(await forkOf(fixture, source.id, FORK_TEXT));
    await untilIdle(fixture, forked.session_id, t.signal);
    assert.deepEqual(recordKinds(fileOf(state, forked.session_id, OPS)), [
      "fork",
    ]);
    assert.deepEqual(readFileSync(sourceFile), before);
  },
);

test(
  "(security, authorization) a fork of a source with an evidence grant shows an approval on its first evidence_read",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const nodes: Awaited<ReturnType<typeof seedEvidence>> = [];
    const read = (asset: number) => () => {
      const found = nodes[0]!.produced[asset]!;
      return toolCall("evidence_read", {
        evidence_id: found.evidenceId,
        asset_id: found.assetId,
      });
    };
    const fixture = await workbenchFixture(
      t,
      [
        read(0),
        fauxAssistantMessage(FIRST_ANSWER),
        fauxAssistantMessage(SUMMARY),
        pass(),
        read(1),
        fauxAssistantMessage(FORK_ANSWER),
      ],
      undefined,
      undefined,
      [REVIEW_AGENT, GUARD_AGENT],
    );
    nodes.push(
      ...(await seedEvidence(t, fixture, [
        { produced: [ALPHA_TEXT, BETA_TEXT] },
      ])),
    );
    const source = await createHost(fixture, REVIEW_AGENT);
    completed(await sendMessage(fixture, source.id, FIRST_QUESTION));
    const granted = await untilSettled(fixture, source.id, t.signal);
    assert.ok(granted);
    completed(await decide(fixture, source.id, granted.tool_call_id, true));
    await untilIdle(fixture, source.id, t.signal);
    const forked = completed(await forkOf(fixture, source.id, FORK_TEXT));
    const pending = await untilSettled(fixture, forked.session_id, t.signal);
    assert.ok(pending);
    assert.equal(pending.operation_id, DOWNLOAD_OPERATION);
    assert.equal(pending.input.node_id, nodes[0]!.nodeId);
    completed(
      await decide(fixture, forked.session_id, pending.tool_call_id, false),
    );
    await untilIdle(fixture, forked.session_id, t.signal);
  },
);

test(
  "(security, guard floor) a source with auto mode off gives a fork with auto mode on and no auto_mode record, also after a restart",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const persistence = {
      path: join(temporary(t), "operational.db"),
      masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      resumed: false,
    };
    const enabled = [AGENT, GUARD_AGENT];
    const ids = { source: "", fork: "" };
    await t.test("fork a source with auto mode off", async (step) => {
      const first = await workbenchFixture(
        step,
        [
          fauxAssistantMessage(FIRST_ANSWER),
          fauxAssistantMessage(SUMMARY),
          pass(),
          fauxAssistantMessage(FORK_ANSWER),
        ],
        state,
        undefined,
        enabled,
        undefined,
        persistence,
      );
      const source = await firstTurn(step, first, AGENT);
      completed(
        await first.workbench["session.autoMode.set"](
          {
            params: { session_id: source.id },
            query: {},
            body: { enabled: false },
          },
          first.options,
        ),
      );
      const forked = completed(await forkOf(first, source.id, FORK_TEXT));
      await untilIdle(first, forked.session_id, step.signal);
      ids.source = source.id;
      ids.fork = forked.session_id;
      assert.equal((await snapshotOf(first, ids.fork)).auto_mode, true);
      assert.equal((await snapshotOf(first, ids.source)).auto_mode, false);
      assert.ok(!recordKinds(fileOf(state, ids.fork)).includes("auto_mode"));
    });
    const second = await workbenchFixture(
      t,
      [],
      state,
      undefined,
      enabled,
      undefined,
      { ...persistence, resumed: true },
    );
    assert.equal((await snapshotOf(second, ids.fork)).auto_mode, true);
    assert.equal((await snapshotOf(second, ids.source)).auto_mode, false);
    assert.equal(second.provider.calls.length, NO_ITEMS);
  },
);

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_DECLARATIONS } from "../../agent/catalog.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../../agent/prompt-templates.ts";
import { isString } from "../../kernel/values.ts";
import { temporary } from "../../kernel/test-support.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import {
  MessageDelivery,
  PlanPhase,
  WORKBENCH_PLAN_ENTRY,
} from "../../workbench/contract.ts";
import { toolName } from "../../workbench/index.ts";
import {
  completed,
  createHost,
  forkOf,
  heldAnswer,
  pass,
  sendMessage,
  toolCall,
  untilAbort,
  untilIdle,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-plan");
const SECOND_HUMAN = testHumanIdentity("kanthord", "Grace", "workbench-plan-2");
const { workbenchFixture } = workbenchHarness(identity);
const PLAN = "plan@1";
const OPS = "ops@1";
const GUARD = "guard@1";
const REQUEST = "Plan the billing mission.";
const REPLACEMENT = "Plan the shipping mission.";
const DRAFT = "## Conclusion\nThe draft.";
const REVIEW_TWO_OPEN = [
  "## Conclusion",
  "The final plan.",
  "",
  "## Review",
  "- B1 - status:OPEN - action:YES - a - b - fix:c - why:d",
  "- B2 - status:OPEN - action:YES - e - f - fix:g - why:h",
  "- S1 - status:FIXED - action:YES - i - j - fix:k - why:l",
].join("\n");
const REVIEW_CLEAN = "## Conclusion\nClean.\n\n## Review\n- none";
const MENTION_REQUEST = `@Jeremy ${REQUEST}`;
const FOLLOW_UP = "And the shipping side too.";
const YUMI_REQUEST = "@Yumi what is next?";
const YUMI_ANSWER = "Yumi answers.";
const FINAL_PLAN = "## Conclusion\nZq final plan.\n\n## Review\n- none";
const SUMMARY = "Goal: apply the plan.";
const FORK_TEXT = "@Yumi continue with the plan.";
const FORK_ANSWER = "Yumi continues.";
const PROVIDER_FAILURE = "zq-planner-provider-failure";
const PROJECT_LIST = "project--list";
const OFFER_ACTION_TOOL = "offer_action";
const HUMAN_INTERLOCUTOR_HEADING = "## Human interlocutor";
const TEST_TIMEOUT_MS = 60000;
const SETTLE_TURNS = 20;
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const READ_COUNT = 8;
const NO_ENTRIES = 0;
const SINGLE = 1;
const PAIR = 2;
const TRIPLE = 3;
const MASTER_KEY_BYTES = 32;
const RELAY_HEAD = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Relay, {});
const MESSAGE_ENTRY = "message";
const CUSTOM_MESSAGE_ENTRY = "custom_message";
const JSONL_EXTENSION = ".jsonl";
const EXPECTED_CLASSES: Record<string, string> = {
  "mission.node.pause": "reversible",
  "mission.node.resume": "reversible",
  "mission.node.check": "reversible",
  "mission.node.priority.set": "reversible",
  "mission.dependency.add": "reversible",
  "mission.dependency.remove": "reversible",
  "project.pause": "reversible",
  "project.resume": "reversible",
  "agent.cooldown.clear": "reversible",
  "mission.node.unblock": "judged",
  "mission.node.block": "judged",
  "mission.node.create": "judged",
  "mission.node.update": "judged",
  "mission.proposal.decide": "judged",
  "mission.criterion.set": "judged",
  "mission.import.apply": "card",
};

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Stored = Record<string, unknown>;

function planDirectory(state: string): string {
  return join(state, "pi", "sessions", "workbench", PLAN);
}

function readLines(path: string): Stored[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Stored);
}

function hostEntries(state: string): Stored[] {
  const files = readdirSync(planDirectory(state)).filter((name) =>
    name.endsWith(JSONL_EXTENSION),
  );
  assert.equal(files.length, SINGLE);
  return readLines(join(planDirectory(state), files[0]!));
}

function phaseFiles(state: string): string[] {
  const directory = join(planDirectory(state), "phases");
  return readdirSync(directory)
    .sort()
    .map((name) => join(directory, name));
}

function plansOf(state: string): Stored[] {
  return hostEntries(state).filter(
    (entry) =>
      entry.type === CUSTOM_MESSAGE_ENTRY &&
      entry.customType === WORKBENCH_PLAN_ENTRY,
  );
}

function textOf(content: unknown): string {
  return isString(content)
    ? content
    : (content as { text?: string }[])
        .map((block) => block.text ?? "")
        .join("");
}

function requestMessages(fixture: Fixture, call: number) {
  const { messages } = fixture.provider.calls[call]!;
  return messages.filter(({ role }) => role !== SYSTEM_ROLE);
}

function mutationLines(): string[] {
  return Object.entries(EXPECTED_CLASSES).map(
    ([id, guardClass]) => `- ${id} - guard:${guardClass}`,
  );
}

async function untilCalls(
  fixture: Fixture,
  count: number,
  signal: AbortSignal,
) {
  while (fixture.provider.calls.length < count) {
    signal.throwIfAborted();
    await setImmediate();
  }
}

async function snapshotOf(fixture: Fixture, hostId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: hostId }, query: {}, body: null },
      fixture.options,
    ),
  ).snapshot;
}

function sendAs(
  fixture: Fixture,
  hostId: string,
  text: string,
  delivery: MessageDelivery,
) {
  return fixture.workbench["session.message"](
    { params: { session_id: hostId }, query: {}, body: { text, delivery } },
    fixture.options,
  );
}

async function planFixture(
  t: TestContext,
  script: Parameters<typeof workbenchFixture>[1],
) {
  const state = temporary(t);
  const fixture = await workbenchFixture(t, script, state, undefined, [PLAN]);
  const host = await createHost(fixture, PLAN);
  return { state, fixture, host };
}

async function settleTurns() {
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
}

test(
  "(happy path) a plan run writes two fresh phase files and the reviewer text as one plan entry",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const planner = heldAnswer(DRAFT);
    const reviewer = heldAnswer(REVIEW_TWO_OPEN);
    const { state, fixture, host } = await planFixture(t, [
      toolCall(PROJECT_LIST, { query: {} }),
      planner.step,
      reviewer.step,
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, PAIR, t.signal);
    const during = await snapshotOf(fixture, host.id);
    assert.equal(during.phase, PlanPhase.Planner);
    assert.equal(during.run_active, true);
    planner.gate.resolve();
    await untilCalls(fixture, TRIPLE, t.signal);
    const between = await snapshotOf(fixture, host.id);
    assert.equal(between.phase, PlanPhase.Reviewer);
    assert.equal(between.run_active, true);
    reviewer.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    const after = await snapshotOf(fixture, host.id);
    assert.equal(after.phase, null);
    assert.equal(after.run_active, false);
    assert.equal(fixture.provider.calls.length, TRIPLE);

    const files = phaseFiles(state);
    assert.equal(files.length, PAIR);
    const headers = files.map((file) => readLines(file)[0]!);
    for (const header of headers) assert.equal(header.parentSession, undefined);
    const [plan, ...extra] = plansOf(state);
    assert.deepEqual(extra, []);
    assert.equal(plan!.content, REVIEW_TWO_OPEN);
    assert.deepEqual(plan!.details, {
      phases: [
        { phase: PlanPhase.Planner, session_id: headers[0]!.id },
        { phase: PlanPhase.Reviewer, session_id: headers[1]!.id },
      ],
      unresolved: 2,
    });
    const assistants = hostEntries(state).filter(
      (entry) =>
        entry.type === MESSAGE_ENTRY &&
        (entry.message as { role: string }).role === ASSISTANT_ROLE,
    );
    assert.equal(assistants.length, SINGLE);
  },
);

test(
  "(happy path) each phase request holds the mutation ids with their class and the reviewer request holds no planner message",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const planner = requestMessages(fixture, 0);
    const reviewer = requestMessages(fixture, SINGLE);
    assert.equal(planner.length, SINGLE);
    assert.equal(reviewer.length, SINGLE);
    for (const request of [planner, reviewer]) {
      const text = textOf(request[0]!.content);
      assert.equal(request[0]!.role, USER_ROLE);
      assert.ok(text.includes(REQUEST));
      for (const line of mutationLines()) assert.ok(text.includes(line), line);
    }
    assert.ok(textOf(reviewer[0]!.content).includes(DRAFT));
    assert.ok(!JSON.stringify(reviewer).includes("assistant"));
    const snapshot = await snapshotOf(fixture, host.id);
    assert.equal(snapshot.error_message, null);
  },
);

test(
  "(happy path, stop) a stop during the reviewer phase writes no plan entry and settles the run once",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      untilAbort(REVIEW_CLEAN),
    ]);
    const service = fixture.workbenchService as unknown as {
      startNext(): void;
    };
    const startNext = t.mock.method(service, "startNext");
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, PAIR, t.signal);
    assert.equal(
      (await snapshotOf(fixture, host.id)).phase,
      PlanPhase.Reviewer,
    );
    completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    await settleTurns();
    const snapshot = await snapshotOf(fixture, host.id);
    assert.equal(snapshot.run_active, false);
    assert.equal(snapshot.phase, null);
    assert.equal(snapshot.error_message, null);
    assert.equal(fixture.provider.calls.length, PAIR);
    assert.deepEqual(plansOf(state), []);
    assert.equal(phaseFiles(state).length, PAIR);
    assert.equal(startNext.mock.callCount(), SINGLE);
  },
);

test(
  "(happy path, replace) a replace during the planner phase starts no reviewer phase and runs the replacing item",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      untilAbort(DRAFT),
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, SINGLE, t.signal);
    completed(
      await sendAs(fixture, host.id, REPLACEMENT, MessageDelivery.Replace),
    );
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, TRIPLE);
    assert.ok(
      textOf(requestMessages(fixture, SINGLE)[0]!.content).includes(
        REPLACEMENT,
      ),
    );
    assert.equal(phaseFiles(state).length, TRIPLE);
    const [plan, ...extra] = plansOf(state);
    assert.deepEqual(extra, []);
    assert.equal(plan!.content, REVIEW_CLEAN);
    assert.equal((plan!.details as { unresolved: unknown }).unresolved, null);
  },
);

test(
  "(invariant, rollback) a provider error in the planner ends the run with its error and writes no reviewer phase and no plan",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: PROVIDER_FAILURE,
      }),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const snapshot = await snapshotOf(fixture, host.id);
    assert.equal(snapshot.error_message, PROVIDER_FAILURE);
    assert.equal(snapshot.run_active, false);
    assert.equal(snapshot.phase, null);
    assert.equal(fixture.provider.calls.length, SINGLE);
    assert.equal(phaseFiles(state).length, SINGLE);
    assert.deepEqual(plansOf(state), []);
  },
);

test(
  "(invariant, rollback) a restart during the pipeline ends the run with no plan",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporary(t);
    const persistence = {
      path: join(temporary(t), "operational.db"),
      masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      resumed: false,
    };
    const enabled = [PLAN, GUARD];
    let hostId = "";
    await t.test("stop the service in the planner phase", async (step) => {
      const first = await workbenchFixture(
        step,
        [untilAbort(DRAFT), fauxAssistantMessage(REVIEW_CLEAN)],
        state,
        undefined,
        enabled,
        undefined,
        persistence,
      );
      const host = await createHost(first, PLAN);
      hostId = host.id;
      completed(await sendMessage(first, host.id, REQUEST));
      await untilCalls(first, SINGLE, step.signal);
      assert.equal(
        (await first.workbenchService.stop()) ?? undefined,
        undefined,
      );
      await settleTurns();
      assert.equal(first.provider.calls.length, SINGLE);
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
    const read = completed(
      await second.workbench["session.get"](
        { params: { session_id: hostId }, query: {}, body: null },
        second.options,
      ),
    );
    assert.equal(read.run_active, false);
    assert.equal((await snapshotOf(second, hostId)).run_active, false);
    assert.deepEqual(plansOf(state), []);
  },
);

test(
  "(security, authorization) each phase tool call runs under the requester of the run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      toolCall(PROJECT_LIST, { query: {} }),
      fauxAssistantMessage(DRAFT),
      toolCall(PROJECT_LIST, { query: {} }),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    const dependencies = (
      fixture.workbenchService as unknown as {
        dependencies: { invoke: (...input: unknown[]) => Promise<unknown> };
      }
    ).dependencies;
    const invoke = t.mock.method(dependencies, "invoke");
    completed(
      await fixture.workbench["session.message"](
        {
          params: { session_id: host.id },
          query: {},
          body: { text: REQUEST },
        },
        { identity: SECOND_HUMAN },
      ),
    );
    await untilIdle(fixture, host.id, t.signal);
    const requesters = invoke.mock.calls.map(
      ({ arguments: [, , options] }) =>
        (options as { identity: { jti: string } }).identity.jti,
    );
    assert.deepEqual(requesters, [SECOND_HUMAN.jti, SECOND_HUMAN.jti]);
  },
);

test(
  "(security, authorization) the tools of each phase are the eight listed reads and no offer_action",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const listed = AGENT_DECLARATIONS[PLAN].tools.operation
      .map(toolName)
      .sort();
    assert.equal(listed.length, READ_COUNT);
    assert.deepEqual(
      fixture.provider.tools.map((tools) => [...tools].sort()),
      [listed, listed],
    );
  },
);

test(
  "(happy path) a phase system prompt holds no offer_action text and an ops@1 system prompt holds it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, PAIR);
    for (const call of fixture.provider.calls) {
      assert.ok(call.systemPrompt?.includes(HUMAN_INTERLOCUTOR_HEADING));
      assert.ok(!call.systemPrompt?.includes(OFFER_ACTION_TOOL));
    }
    const ops = await workbenchFixture(
      t,
      [fauxAssistantMessage(YUMI_ANSWER)],
      temporary(t),
      undefined,
      [OPS],
    );
    const opsHost = await createHost(ops, OPS);
    completed(await sendMessage(ops, opsHost.id, YUMI_REQUEST));
    await untilIdle(ops, opsHost.id, t.signal);
    assert.ok(ops.provider.calls[0]!.systemPrompt?.includes(OFFER_ACTION_TOOL));
  },
);

test(
  "(invariant guard) a finished plan run reads each phase file once for every later get and poll",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    const open = t.mock.method((await loadPi()).SessionManager, "open");
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const first = await getOf(fixture, host.id);
    const second = await getOf(fixture, host.id);
    await pollOf(fixture, host.id, new Map());
    assert.equal(open.mock.callCount(), PAIR);
    assert.deepEqual(second.entries, first.entries);
  },
);

test(
  "(invariant, rollback) a service stop during a phase lets the phase settle with no error and no plan",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      untilAbort(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    const hostOf = t.mock.method(
      fixture.workbenchService as unknown as { hostOf(): unknown },
      "hostOf",
    );
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, SINGLE, t.signal);
    assert.equal(
      (await fixture.workbenchService.stop()) ?? undefined,
      undefined,
    );
    await settleTurns();
    assert.ok(hostOf.mock.callCount() > NO_ENTRIES);
    assert.deepEqual(
      hostOf.mock.calls.filter(({ error }) => error !== undefined),
      [],
    );
    assert.equal(fixture.provider.calls.length, SINGLE);
    assert.deepEqual(plansOf(state), []);
  },
);

test(
  "(invariant, rollback) a service stop clears the cache of the finished phase entries",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW_CLEAN),
    ]);
    const { finishedPhaseEntries } = fixture.workbenchService as unknown as {
      finishedPhaseEntries: Map<string, unknown>;
    };
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    await getOf(fixture, host.id);
    assert.equal(finishedPhaseEntries.size, PAIR);
    assert.equal(
      (await fixture.workbenchService.stop()) ?? undefined,
      undefined,
    );
    assert.equal(finishedPhaseEntries.size, NO_ENTRIES);
  },
);

interface PhaseAnswerProbe {
  phaseAnswer(
    launch: { run: { stopped: boolean }; host: { runError: string | null } },
    session: { id: string; agent: { state: { messages: unknown[] } } },
  ): unknown;
}

function phaseAnswerOf(
  fixture: Fixture,
  stopped: boolean,
  messages: unknown[],
) {
  const launch = { run: { stopped }, host: { runError: null } };
  const answer = (
    fixture.workbenchService as unknown as PhaseAnswerProbe
  ).phaseAnswer(launch, { id: "phase", agent: { state: { messages } } });
  return { answer, runError: launch.host.runError };
}

test(
  "regression: a stopped phase with no assistant message answers null with no assertion error and no run error",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await planFixture(t, []);
    assert.deepEqual(phaseAnswerOf(fixture, true, []), {
      answer: null,
      runError: null,
    });
  },
);

test(
  "regression: a phase that ends with no assistant message answers null with no assertion error",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await planFixture(t, []);
    assert.deepEqual(phaseAnswerOf(fixture, false, []), {
      answer: null,
      runError: null,
    });
  },
);

interface PollEntry {
  id: string;
  session_id: string;
  agent_name: string;
  phase?: string | undefined;
}

async function pollOf(
  fixture: Fixture,
  hostId: string,
  cursor: Map<string, string>,
  version?: number,
) {
  const after = [...cursor].map(([member, entry]) => `${member}:${entry}`);
  const answer = completed(
    await fixture.workbench["session.events"](
      {
        params: { session_id: hostId },
        query: {
          ...(after.length ? { after: after.join(",") } : {}),
          ...(version === undefined ? {} : { version }),
        },
        body: null,
      },
      fixture.options,
    ),
  );
  for (const entry of answer.entries) cursor.set(entry.session_id, entry.id);
  return answer;
}

async function getOf(fixture: Fixture, hostId: string) {
  return completed(
    await fixture.workbench["session.get"](
      { params: { session_id: hostId }, query: {}, body: null },
      fixture.options,
    ),
  );
}

function phaseEntriesOf(entries: readonly PollEntry[]): PollEntry[] {
  return entries.filter((entry) => entry.phase !== undefined);
}

function phaseIds(state: string): string[] {
  return phaseFiles(state).map((file) => readLines(file)[0]!.id as string);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - SINGLE;
}

function relaysOf(fixture: Fixture, call: number): string[] {
  return requestMessages(fixture, call)
    .map(({ content }) => textOf(content))
    .filter((text) => text.startsWith(RELAY_HEAD));
}

async function mentionedPlan(
  t: TestContext,
  script: Parameters<typeof workbenchFixture>[1],
  enabled: readonly string[] = [OPS, PLAN],
) {
  const state = temporary(t);
  const fixture = await workbenchFixture(t, script, state, undefined, enabled);
  const host = await createHost(fixture, OPS);
  completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
  await untilIdle(fixture, host.id, t.signal);
  return { state, fixture, host };
}

test(
  "(happy path) the list shows no phase session and the merged poll and get hold the same phase entries",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await mentionedPlan(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
    ]);
    const listed = completed(
      await fixture.workbench["session.list"](
        { params: {}, query: {}, body: null },
        fixture.options,
      ),
    ).items;
    const listedIds = listed.flatMap((item) => [
      item.id,
      ...item.participants.map(({ id }) => id),
    ]);
    assert.equal(listed.length, SINGLE);
    assert.equal(listed[0]!.participants.length, SINGLE);
    assert.equal(listed[0]!.participants[0]!.agent_name, PLAN);
    const phases = phaseIds(state);
    assert.equal(phases.length, PAIR);
    for (const id of phases) assert.ok(!listedIds.includes(id), id);
    const entries = hostEntries(state);
    const users = entries.filter(
      (entry) =>
        entry.type === MESSAGE_ENTRY &&
        (entry.message as { role: string }).role === USER_ROLE,
    );
    assert.deepEqual(
      users.map((entry) =>
        textOf((entry.message as { content: unknown }).content),
      ),
      [MENTION_REQUEST],
    );
    const [plan] = plansOf(state);
    assert.equal(plan!.display, true);
    assert.equal(plan!.content, FINAL_PLAN);
    const poll = await pollOf(fixture, host.id, new Map());
    const read = await getOf(fixture, host.id);
    const polled = phaseEntriesOf(poll.entries);
    assert.deepEqual(phaseEntriesOf(read.entries), polled);
    assert.deepEqual(
      new Set(polled.map(({ phase }) => phase)),
      new Set([PlanPhase.Planner, PlanPhase.Reviewer]),
    );
    for (const entry of polled) {
      assert.ok(phases.includes(entry.session_id));
      assert.equal(entry.agent_name, PLAN);
    }
    const memberIds = poll.members.map(({ session_id: id }) => id);
    for (const entry of poll.entries.filter(({ phase }) => phase === undefined))
      assert.ok(memberIds.includes(entry.session_id));
    assert.deepEqual(read.entries, poll.entries);
  },
);

test(
  "(happy path, plan@1 host) the list, the membership, the poll members and the relay hold no phase session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, FOLLOW_UP));
    await untilIdle(fixture, host.id, t.signal);
    const phases = phaseIds(state);
    assert.equal(phases.length, TRIPLE + SINGLE);
    const listed = completed(
      await fixture.workbench["session.list"](
        { params: {}, query: {}, body: null },
        fixture.options,
      ),
    ).items;
    assert.deepEqual(
      listed.map(({ id, participants }) => [id, participants.length]),
      [[host.id, 0]],
    );
    const read = await getOf(fixture, host.id);
    const poll = await pollOf(fixture, host.id, new Map());
    for (const members of [read.members, poll.members])
      assert.deepEqual(
        members.map(({ session_id: id }) => id),
        [host.id],
      );
    assert.ok(phaseEntriesOf(poll.entries).length > NO_ENTRIES);
    for (const call of [0, PAIR]) assert.deepEqual(relaysOf(fixture, call), []);
    const second = textOf(requestMessages(fixture, PAIR)[0]!.content);
    assert.ok(second.includes(FOLLOW_UP));
    assert.ok(!second.includes(DRAFT));
  },
);

test(
  "(happy path) after a plan a @Yumi run receives one relay with the plan text once and no phase entry",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await mentionedPlan(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
      fauxAssistantMessage(YUMI_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, YUMI_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, TRIPLE);
    const relays = relaysOf(fixture, PAIR);
    assert.equal(relays.length, SINGLE);
    assert.equal(occurrences(relays[0]!, `Jeremy: ${FINAL_PLAN}`), SINGLE);
    assert.equal(occurrences(relays[0]!, FINAL_PLAN), SINGLE);
    assert.ok(!relays[0]!.includes(DRAFT));
    for (const line of mutationLines())
      assert.ok(!relays[0]!.includes(line), line);
  },
);

test(
  "(happy path) an untagged follow-up after a plan runs plan@1",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await mentionedPlan(t, [
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(FINAL_PLAN),
    ]);
    const queued = completed(await sendMessage(fixture, host.id, FOLLOW_UP));
    assert.equal(queued.agent_name, PLAN);
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(fixture.provider.calls.length, TRIPLE + SINGLE);
    assert.ok(
      textOf(requestMessages(fixture, PAIR)[0]!.content).includes(FOLLOW_UP),
    );
    assert.equal(plansOf(state).length, PAIR);
  },
);

test(
  "(invariant, data loss) a poll resumed with the phase pairs repeats no entry and loses none",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const planner = heldAnswer(DRAFT);
    const reviewer = heldAnswer(FINAL_PLAN);
    const { state, fixture, host } = await planFixture(t, [
      planner.step,
      reviewer.step,
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, SINGLE, t.signal);
    const cursor = new Map<string, string>();
    const collected: PollEntry[] = [];
    let answer = await pollOf(fixture, host.id, cursor);
    collected.push(...answer.entries);
    const early = phaseEntriesOf(answer.entries);
    assert.ok(early.length > NO_ENTRIES);
    for (const entry of early) assert.equal(entry.phase, PlanPhase.Planner);
    planner.gate.resolve();
    await untilCalls(fixture, PAIR, t.signal);
    answer = await pollOf(fixture, host.id, cursor, answer.version);
    collected.push(...answer.entries);
    reviewer.gate.resolve();
    while (answer.snapshot.run_active) {
      answer = await pollOf(fixture, host.id, cursor, answer.version);
      collected.push(...answer.entries);
    }
    assert.deepEqual((await pollOf(fixture, host.id, cursor)).entries, []);
    const full = await pollOf(fixture, host.id, new Map());
    const key = ({ session_id: sessionId, id }: PollEntry) =>
      `${sessionId}:${id}`;
    assert.equal(new Set(collected.map(key)).size, collected.length);
    assert.deepEqual(
      new Set(collected.map(key)),
      new Set(full.entries.map(key)),
    );
    assert.deepEqual(
      new Set(phaseEntriesOf(collected).map(({ session_id: id }) => id)),
      new Set(phaseIds(state)),
    );
  },
);

test(
  "(invariant, data loss) after a stop the poll answers no phase entry of the stopped run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture, host } = await planFixture(t, [
      fauxAssistantMessage(DRAFT),
      untilAbort(FINAL_PLAN),
    ]);
    completed(await sendMessage(fixture, host.id, REQUEST));
    await untilCalls(fixture, PAIR, t.signal);
    const during = await pollOf(fixture, host.id, new Map());
    assert.ok(phaseEntriesOf(during.entries).length > NO_ENTRIES);
    completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    await settleTurns();
    assert.equal(phaseFiles(state).length, PAIR);
    const after = await pollOf(fixture, host.id, new Map());
    assert.deepEqual(phaseEntriesOf(after.entries), []);
    assert.deepEqual(
      phaseEntriesOf((await getOf(fixture, host.id)).entries),
      [],
    );
  },
);

test(
  "(invariant, data loss) the fork material of a source with a Jeremy plan holds one plan item with the author Jeremy",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await mentionedPlan(
      t,
      [
        fauxAssistantMessage(DRAFT),
        fauxAssistantMessage(FINAL_PLAN),
        fauxAssistantMessage(SUMMARY),
        pass(),
        fauxAssistantMessage(FORK_ANSWER),
      ],
      [OPS, PLAN, GUARD],
    );
    const forked = completed(await forkOf(fixture, host.id, FORK_TEXT));
    await untilIdle(fixture, forked.session_id, t.signal);
    const [request] = requestMessages(fixture, PAIR);
    const { conversation: material } = JSON.parse(textOf(request!.content)) as {
      conversation: string;
    };
    assert.equal(occurrences(material, `Jeremy: ${FINAL_PLAN}`), SINGLE);
    assert.equal(occurrences(material, FINAL_PLAN), SINGLE);
    assert.ok(!material.includes(DRAFT));
    for (const line of mutationLines())
      assert.ok(!material.includes(line), line);
  },
);

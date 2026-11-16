import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_DECLARATIONS } from "../../agent/catalog.ts";
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
  heldAnswer,
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
const PROVIDER_FAILURE = "zq-planner-provider-failure";
const PROJECT_LIST = "project--list";
const TEST_TIMEOUT_MS = 60000;
const SETTLE_TURNS = 20;
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const READ_COUNT = 8;
const SINGLE = 1;
const PAIR = 2;
const TRIPLE = 3;
const MASTER_KEY_BYTES = 32;
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

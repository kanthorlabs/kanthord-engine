import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { type GuestIdentity, isReadOnlyIdentity } from "../../kernel/caller.ts";
import { background } from "../../kernel/context.ts";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
  testReadOnlyIdentity,
} from "../../kernel/test-identity.ts";
import {
  AuthorKind,
  WORKBENCH_EXPIRY_REASON,
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WORKBENCH_RECORD_ENTRY,
  workbenchGuestScopeText,
  WorkbenchRecordKind,
} from "../../workbench/contract.ts";
import { toolName } from "../../workbench/index.ts";
import { seedEvidence } from "./evidence-test-support.ts";
import {
  AGENT,
  completed,
  COVERING_WORKER_BINDINGS,
  createHost,
  forkOf,
  GUARD_AGENT,
  heldAnswer,
  pass,
  PRIMARY_CREDENTIAL,
  pumped,
  pumpTimers,
  toolCall,
  untilAbort,
  untilIdle,
  untilSettled,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-scope");
const APPROVER = testHumanIdentity("kanthord", "Grace", "workbench-scope-2");
const { workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const PLAN = "plan@1";
const COVERED_AGENTS = [AGENT, "re@1"];
const GUEST_NAME = "Mira";
const GUEST_MENTION = "@Yumi tighten the criterion.";
const READ_MENTION = "@Yumi list the projects.";
const PLAN_MENTION = "@Jeremy plan the next mission.";
const GUEST_RUN_MENTION = "@Yumi check the node.";
const EVIDENCE_TEXT = "alpha evidence text";
const EVIDENCE_LENGTH = 16;
const FIRST_ASSET = 0;
const OWNER_NOTE = "The owner adds a note.";
const FORK_TEXT = "@Yumi continue with the plan.";
const FORK_SUMMARY = "Goal: continue with the plan.";
const ANSWER = "Done.";
const DRAFT = "## Conclusion\nThe draft.";
const REVIEW = "## Conclusion\nClean.\n\n## Review\n- none";
const NEW_CRITERION = "The thread is reviewed twice";
const CRITERION_SET = toolName("mission.criterion.set");
const NODE_GET = toolName("mission.node.get");
const NODE_PAUSE = toolName("mission.node.pause");
const NODE_LIST = toolName("mission.node.list");
const PROJECT_LIST = toolName("project.list");
const SESSION_LIST = toolName("workbench.session.list");
const OFFER_ACTION = "offer_action";
const NODE_PAUSE_ID = "mission.node.pause";
const ROTATE_ID = "llm.credential.rotate";
const TARGET_REFUSED = "workbench.action.target_refused";
const SCOPE_REFUSED = "gateway.scope.refused";
const GUEST_ENTRIES_PATH = "/api/workbench/guest/session";
const FRAME_END = "\n\n";
const FRAME_PATTERN = /^event: (\w+)\ndata: (.*)$/s;
const STATE_EVENT = "state";
const MESSAGE_ENTRY = "message";
const TOOL_RESULT = "toolResult";
const IDENTITY_TEXT = /\b[a-z_]+_[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
const ID_PLACEHOLDER = "<id>";
const FIRST_VERSION = 1;
const FIRST_REVISION = 1;
const NO_ITEMS = 0;
const SINGLE = 1;
const PAIR = 2;
const TRIPLE = 3;
const TEST_TIMEOUT_MS = 60000;

type Fixture = WorkbenchFixture;
type Entry = Record<string, unknown>;

interface Seeded {
  projectId: string;
  missionId: string;
  missionVersion: number;
  nodeId: string;
}

interface World {
  fixture: Fixture;
  hostId: string;
  token: string;
  inviteId: string;
  guest: GuestIdentity;
  first: Seeded;
  second: Seeded;
}

interface Frame {
  event: string;
  data: unknown;
}

async function seeded(fixture: Fixture, name: string): Promise<Seeded> {
  const project = completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name } },
      fixture.options,
    ),
  );
  completed(
    await fixture.projects["bindingSet.write"](
      {
        params: { project_id: project.id },
        query: {},
        body: { version: FIRST_VERSION, bindings: COVERING_WORKER_BINDINGS },
      } as never,
      fixture.options,
    ),
  );
  const mission = completed(
    await fixture.missions.get(
      { params: { project_id: project.id }, query: {}, body: null },
      fixture.options,
    ),
  );
  const created = completed(
    await fixture.missions["node.create"](
      {
        params: { mission_id: mission.id },
        query: {},
        body: {
          filename: "review.md",
          content: {
            name: "Review the thread",
            requirement: "Review the thread",
            criterion: "The thread is reviewed",
            verifications: ["true"],
            bindings: [],
            intent: "examine",
          },
          tasks: [],
          reason: "plan",
          expected_mission_version: mission.version,
        },
      } as never,
      fixture.options,
    ),
  ) as { revisions: { node_id: string }[]; mission_version: number };
  return {
    projectId: project.id,
    missionId: mission.id,
    missionVersion: created.mission_version,
    nodeId: created.revisions[0]!.node_id,
  };
}

async function inviteGuest(
  fixture: Fixture,
  hostId: string,
  projectIds: string[],
) {
  const created = completed(
    await fixture.workbench["invite.create"](
      {
        params: { session_id: hostId },
        query: {},
        body: { invitee_name: GUEST_NAME, project_ids: projectIds },
      },
      fixture.options,
    ),
  );
  const joined = completed(
    await fixture.workbench["invite.join"](
      {
        params: {},
        query: {},
        body: { invite_token: created.invite_token, name: GUEST_NAME },
      },
      fixture.options,
    ),
  );
  return {
    token: joined.guest_token,
    inviteId: created.id,
    guest: testGuestIdentity({
      guestId: joined.guest_id,
      name: GUEST_NAME,
      inviteId: created.id,
      sessionId: hostId,
      invitedBy: identity.accountId,
      reader: testReadOnlyIdentity(identity.accountId, {
        inviteId: created.id,
        projectIds,
      }),
      jti: "workbench-scope-guest",
    }),
  };
}

async function scopeWorld(
  t: TestContext,
  script: (world: World) => FauxResponseStep[],
  agents: readonly string[] = [OPS, PLAN, ...COVERED_AGENTS],
): Promise<World> {
  const world = {} as World;
  const fixture = await workbenchFixture(
    t,
    script(world),
    undefined,
    undefined,
    agents,
  );
  const first = await seeded(fixture, "scope-one");
  const second = await seeded(fixture, "scope-two");
  const host = await createHost(fixture, OPS);
  const invited = await inviteGuest(fixture, host.id, [first.projectId]);
  return Object.assign(world, {
    fixture,
    hostId: host.id,
    ...invited,
    first,
    second,
  });
}

function asGuest(world: World, path: string, init: RequestInit = {}) {
  return world.fixture.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${world.token}`,
      ...(init.body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "Idempotency-Key": createIdempotencyKey(),
          }),
    },
  });
}

function guestMention(world: World, text: string) {
  return world.fixture.workbenchService.guestMessage(
    world.guest,
    text,
    background,
  );
}

async function guestEntries(world: World) {
  const response = await asGuest(world, GUEST_ENTRIES_PATH);
  assert.equal(response.status, HttpStatus.OK);
  const body = (await response.json()) as { entries: Entry[] };
  return body.entries;
}

async function openStream(t: TestContext, world: World) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await world.fixture.workbenchService.guestStream(
    world.guest,
    undefined,
    { ...background, signal: controller.signal },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const next = async (): Promise<Frame> => {
    for (;;) {
      const end = buffered.indexOf(FRAME_END);
      if (end >= NO_ITEMS) {
        const block = buffered.slice(NO_ITEMS, end);
        buffered = buffered.slice(end + FRAME_END.length);
        const match = FRAME_PATTERN.exec(block);
        if (!match) continue;
        return { event: match[1]!, data: JSON.parse(match[2]!) };
      }
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, close: () => reader.cancel() };
}

async function untilState(
  next: () => Promise<Frame>,
  accept: (waiting: { operation_id: string } | null) => boolean,
) {
  for (;;) {
    const frame = await pumped(next());
    if (frame.event !== STATE_EVENT) continue;
    const { waiting_for_approval } = frame.data as {
      waiting_for_approval: { operation_id: string } | null;
    };
    if (accept(waiting_for_approval)) return waiting_for_approval;
  }
}

async function ownerEntries(fixture: Fixture, sessionId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  ).entries as Entry[];
}

function toolResults(entries: readonly Entry[]) {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map(
      (entry) =>
        entry.message as {
          role: string;
          toolName?: string;
          isError?: boolean;
          content: { type: string; text?: string }[];
        },
    )
    .filter((message) => message.role === TOOL_RESULT)
    .map((message) => ({
      toolName: message.toolName,
      isError: message.isError === true,
      text: message.content.map((block) => block.text ?? "").join(""),
    }));
}

function recordsOf(entries: readonly Entry[], kind: string) {
  return entries.flatMap((entry) => {
    const data = entry.data as { kind?: string } | undefined;
    return entry.customType === WORKBENCH_RECORD_ENTRY && data?.kind === kind
      ? [data]
      : [];
  });
}

function withoutIdentity(entry: Entry): Entry {
  const { id, timestamp, ...rest } = entry;
  assert.ok(id !== undefined && timestamp !== undefined);
  return rest;
}

function withoutIds(text: string): string {
  return text.replaceAll(IDENTITY_TEXT, ID_PLACEHOLDER);
}

function criterionInput(world: World) {
  return {
    params: { node_id: world.first.nodeId },
    body: {
      criterion: NEW_CRITERION,
      verifications: ["true"],
      reason: "tighten",
      expected_revision: FIRST_REVISION,
      expected_mission_version: world.first.missionVersion,
    },
  };
}

function criterionStep(world: World) {
  return () => toolCall(CRITERION_SET, criterionInput(world));
}

async function criterionOf(world: World): Promise<string> {
  return completed(
    await world.fixture.missions["node.get"](
      { params: { node_id: world.first.nodeId }, query: {}, body: null },
      world.fixture.options,
    ),
  ).content.criterion;
}

function approve(
  world: World,
  toolCallId: string,
  approved: boolean,
  options = world.fixture.options,
) {
  return world.fixture.workbench["session.approve"](
    {
      params: { session_id: world.hostId },
      query: {},
      body: { tool_call_id: toolCallId, approved },
    },
    options,
  );
}

function sessionOf(world: World) {
  const session = world.fixture.workbenchService["sessions"].get(world.hostId);
  assert.ok(session);
  return session;
}

function runRequester(world: World) {
  const service = world.fixture.workbenchService;
  const session = sessionOf(world);
  return service["memberOfRun"](session, session.run).requester;
}

async function untilCalls(world: World, count: number, signal: AbortSignal) {
  while (world.fixture.provider.calls.length < count) {
    signal.throwIfAborted();
    await setImmediate();
  }
}

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

test(
  "(happy path) a guest run mutation waits on a card of the guest, and the card expiry clears waiting_for_approval in the guest frame",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, (target) => [
      criterionStep(target),
      fauxAssistantMessage(ANSWER),
    ]);
    const stream = await openStream(t, world);
    const { next } = stream;
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      pumpTimers(t);
      await guestMention(world, GUEST_MENTION);
      const waiting = await untilState(next, (state) => state !== null);
      assert.deepEqual(waiting, { operation_id: "mission.criterion.set" });
      const pending = await untilSettled(world.fixture, world.hostId, t.signal);
      assert.ok(pending);
      assert.deepEqual(pending.requested_by, {
        kind: AuthorKind.Guest,
        name: GUEST_NAME,
      });
      t.mock.timers.tick(world.fixture.config.workbench.approval_wait_ms);
      assert.equal(await untilState(next, (state) => state === null), null);
      await untilIdle(world.fixture, world.hostId, t.signal);
      assert.deepEqual(
        toolResults(await ownerEntries(world.fixture, world.hostId)).map(
          ({ text }) => text,
        ),
        [WORKBENCH_EXPIRY_REASON],
      );
      assert.notEqual(await criterionOf(world), NEW_CRITERION);
    } finally {
      t.mock.timers.reset();
      await stream.close();
    }
  },
);

test(
  "(security) the owner approval of a guest run card runs the mutation under the approver",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, (target) => [
      criterionStep(target),
      fauxAssistantMessage(ANSWER),
    ]);
    await guestMention(world, GUEST_MENTION);
    const pending = await untilSettled(world.fixture, world.hostId, t.signal);
    assert.ok(pending);
    completed(
      await approve(world, pending.tool_call_id, true, {
        identity: APPROVER,
      }),
    );
    await untilIdle(world.fixture, world.hostId, t.signal);
    assert.equal(await criterionOf(world), NEW_CRITERION);
    const revisions = completed(
      await world.fixture.missions["node.revision.list"](
        {
          params: { node_id: world.first.nodeId },
          query: {},
          body: null,
        },
        world.fixture.options,
      ),
    ).items;
    const latest = revisions.reduce((left, right) =>
      right.revision > left.revision ? right : left,
    );
    assert.deepEqual(latest.actor, {
      kind: "human",
      account: APPROVER.accountId,
      name: APPROVER.name,
    });
  },
);

test(
  "(security) a guest run blocks workbench.session.list with guest_scope and no entry of another session reaches the guest",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, () => [
      toolCall(SESSION_LIST, { query: {} }),
      fauxAssistantMessage(ANSWER),
    ]);
    const other = await createHost(world.fixture, OPS);
    await guestMention(world, GUEST_MENTION);
    await untilIdle(world.fixture, world.hostId, t.signal);
    const results = toolResults(
      await ownerEntries(world.fixture, world.hostId),
    );
    assert.deepEqual(results, [
      {
        toolName: SESSION_LIST,
        isError: true,
        text: workbenchGuestScopeText("workbench.session.list"),
      },
    ]);
    assert.ok(!JSON.stringify(await guestEntries(world)).includes(other.id));
    assert.equal(
      completed(
        await world.fixture.workbench["session.events"](
          { params: { session_id: world.hostId }, query: {}, body: null },
          world.fixture.options,
        ),
      ).snapshot.pending_approval,
      null,
    );
  },
);

test(
  "(security) an owner approve, abort, note, autoMode.set and fork during guest runs keep the next guest run read read-only",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const readers: boolean[] = [];
    const reading = (target: World) => () => {
      readers.push(isReadOnlyIdentity(runRequester(target)));
      return toolCall(PROJECT_LIST, { query: {} });
    };
    const world = await scopeWorld(
      t,
      (target) => [
        criterionStep(target),
        fauxAssistantMessage(ANSWER),
        untilAbort(ANSWER),
        fauxAssistantMessage(FORK_SUMMARY),
        pass(),
        fauxAssistantMessage(ANSWER),
        reading(target),
        fauxAssistantMessage(ANSWER),
      ],
      [OPS, GUARD_AGENT, ...COVERED_AGENTS],
    );
    await guestMention(world, GUEST_MENTION);
    const pending = await untilSettled(world.fixture, world.hostId, t.signal);
    assert.ok(pending);
    completed(await approve(world, pending.tool_call_id, true));
    await untilIdle(world.fixture, world.hostId, t.signal);
    await guestMention(world, GUEST_MENTION);
    await untilCalls(world, TRIPLE, t.signal);
    assert.ok(isReadOnlyIdentity(runRequester(world)));
    await world.fixture.workbenchService.note(
      world.hostId,
      { kind: AuthorKind.Owner, name: identity.name },
      OWNER_NOTE,
    );
    completed(
      await world.fixture.workbench["session.autoMode.set"](
        {
          params: { session_id: world.hostId },
          query: {},
          body: { enabled: false },
        },
        world.fixture.options,
      ),
    );
    assert.ok(isReadOnlyIdentity(runRequester(world)));
    completed(await forkOf(world.fixture, world.hostId, FORK_TEXT));
    await untilCalls(world, TRIPLE + TRIPLE, t.signal);
    assert.ok(isReadOnlyIdentity(runRequester(world)));
    completed(
      await world.fixture.workbench["session.abort"](
        { params: { session_id: world.hostId }, query: {}, body: null },
        world.fixture.options,
      ),
    );
    await guestMention(world, READ_MENTION);
    await untilIdle(world.fixture, world.hostId, t.signal);
    assert.deepEqual(readers, [true]);
    const listing = toolResults(
      await ownerEntries(world.fixture, world.hostId),
    ).filter(({ toolName: name }) => name === PROJECT_LIST);
    assert.equal(listing.length, SINGLE);
    assert.ok(listing[0]!.text.includes(world.first.projectId));
    assert.ok(!listing[0]!.text.includes(world.second.projectId));
  },
);

test(
  "(happy path) a guest run offers an action card on a node of the invite project and writes the action_offer record",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, (target) => [
      () =>
        toolCall(OFFER_ACTION, {
          operation_id: NODE_PAUSE_ID,
          target_id: target.first.nodeId,
        }),
      fauxAssistantMessage(ANSWER),
    ]);
    await guestMention(world, GUEST_MENTION);
    await untilIdle(world.fixture, world.hostId, t.signal);
    const entries = await ownerEntries(world.fixture, world.hostId);
    assert.deepEqual(
      toolResults(entries).map(({ isError }) => isError),
      [false],
    );
    const offers = recordsOf(entries, WorkbenchRecordKind.ActionOffer);
    assert.equal(offers.length, SINGLE);
    assert.equal(
      (offers[0] as { target_id?: string }).target_id,
      world.first.nodeId,
    );
  },
);

test(
  "(security) a guest run @Jeremy phase call of mission.node.list on a mission of another project blocks with project_scope",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, (target) => [
      () =>
        toolCall(NODE_LIST, {
          params: { mission_id: target.second.missionId },
          query: {},
        }),
      fauxAssistantMessage(DRAFT),
      fauxAssistantMessage(REVIEW),
    ]);
    await guestMention(world, PLAN_MENTION);
    await untilIdle(world.fixture, world.hostId, t.signal);
    const [, afterTool] = world.fixture.provider.calls;
    assert.ok(afterTool);
    const results = afterTool.messages.filter(
      ({ role }) => role === TOOL_RESULT,
    );
    assert.equal(results.length, SINGLE);
    assert.ok(
      JSON.stringify(results).includes(WORKBENCH_PROJECT_SCOPE_TEXT),
      JSON.stringify(results),
    );
    assert.ok(!JSON.stringify(results).includes(world.second.nodeId));
  },
);

test(
  "(security) a guest run offer_action on a node of another project and on a credential answers target_refused",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const world = await scopeWorld(t, (target) => [
      () =>
        toolCall(OFFER_ACTION, {
          operation_id: NODE_PAUSE_ID,
          target_id: target.second.nodeId,
        }),
      toolCall(OFFER_ACTION, {
        operation_id: ROTATE_ID,
        target_id: PRIMARY_CREDENTIAL,
      }),
      fauxAssistantMessage(ANSWER),
    ]);
    await guestMention(world, GUEST_MENTION);
    await untilIdle(world.fixture, world.hostId, t.signal);
    const entries = await ownerEntries(world.fixture, world.hostId);
    const results = toolResults(entries);
    assert.equal(results.length, PAIR);
    for (const result of results) {
      assert.ok(result.isError);
      assert.ok(result.text.startsWith(`${TARGET_REFUSED}:`), result.text);
    }
    assert.equal(
      recordsOf(entries, WorkbenchRecordKind.ActionOffer).length,
      NO_ITEMS,
    );
  },
);

test(
  "(security) a guest run gets equal tool results, equal lookup counts and equal guest frames for a node of another project and an absent node",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const targets = { id: "" };
    const calls = () => [
      () => toolCall(NODE_GET, { params: { node_id: targets.id } }),
      () =>
        toolCall(NODE_PAUSE, {
          params: { node_id: targets.id },
          body: {
            reason: "hold",
            expected_mission_version: FIRST_VERSION,
            expected_state: "Available",
            expected_attempt: FIRST_VERSION,
          },
        }),
      fauxAssistantMessage(ANSWER),
    ];
    const world = await scopeWorld(t, () => [...calls(), ...calls()]);
    const lookups = [
      t.mock.method(world.fixture.mission, "projectOf"),
      t.mock.method(world.fixture.project, "projectOf"),
    ];
    const lookupCount = () =>
      lookups.reduce((sum, lookup) => sum + lookup.mock.callCount(), NO_ITEMS);
    const outcomes: {
      results: string[];
      lookups: number;
      frames: string;
    }[] = [];
    let before = (await guestEntries(world)).length;
    for (const id of [world.second.nodeId, createIdentity("node")]) {
      targets.id = id;
      const lookupsBefore = lookupCount();
      const resultsBefore = toolResults(
        await ownerEntries(world.fixture, world.hostId),
      ).length;
      await guestMention(world, GUEST_RUN_MENTION);
      await untilIdle(world.fixture, world.hostId, t.signal);
      const results = toolResults(
        await ownerEntries(world.fixture, world.hostId),
      ).slice(resultsBefore);
      const frames = (await guestEntries(world)).slice(before);
      before += frames.length;
      outcomes.push({
        results: results.map((result) =>
          withoutIds(JSON.stringify(result)).replaceAll(id, ID_PLACEHOLDER),
        ),
        lookups: lookupCount() - lookupsBefore,
        frames: JSON.stringify(frames.map(withoutIdentity)),
      });
    }
    const [foreign, absent] = outcomes;
    assert.equal(foreign!.results.length, PAIR);
    assert.deepEqual(foreign!.results, absent!.results);
    assert.ok(
      foreign!.results.every((text) =>
        text.includes(WORKBENCH_PROJECT_SCOPE_TEXT),
      ),
    );
    assert.ok(foreign!.lookups > NO_ITEMS);
    assert.equal(foreign!.lookups, absent!.lookups);
    assert.equal(foreign!.frames, absent!.frames);
  },
);

test(
  "(security) the evidence_read hook blocks in a guest run with guest_scope, and the download under the read-only identity answers 403",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const hold = heldAnswer(ANSWER);
    const target = { evidenceId: "", assetId: "" };
    const fixture = await workbenchFixture(
      t,
      [hold.step],
      undefined,
      undefined,
      [OPS, ...COVERED_AGENTS],
    );
    const [node] = await seedEvidence(t, fixture, [
      { produced: [EVIDENCE_TEXT] },
    ]);
    target.evidenceId = node!.produced[FIRST_ASSET]!.evidenceId;
    target.assetId = node!.produced[FIRST_ASSET]!.assetId;
    const host = await createHost(fixture, OPS);
    const projects = completed(
      await fixture.projects.list(
        { params: {}, query: {}, body: null },
        fixture.options,
      ),
    ).items.map(({ id }) => id);
    const world = {
      fixture,
      hostId: host.id,
      ...(await inviteGuest(fixture, host.id, projects)),
    } as World;
    await guestMention(world, GUEST_MENTION);
    await untilCalls(world, SINGLE, t.signal);
    const decision = await fixture.workbenchService["evidenceGrant"](
      sessionOf(world),
      {
        type: "tool_call",
        toolCallId: "call_evidence",
        toolName: "evidence_read",
        input: { evidence_id: target.evidenceId, asset_id: target.assetId },
      },
      { signal: t.signal },
    );
    assert.deepEqual(decision, {
      allowed: false,
      reason: workbenchGuestScopeText("evidence_read"),
      terminate: false,
    });
    failed(
      await fixture.missions["evidence.asset.content.download"](
        {
          params: { asset_id: target.assetId },
          query: { length: EVIDENCE_LENGTH },
          body: null,
        } as never,
        { identity: runRequester(world) as never },
      ),
      HttpStatus.Forbidden,
      SCOPE_REFUSED,
    );
    hold.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
  },
);

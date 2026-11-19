import assert from "node:assert/strict";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentOperations } from "../agent/contract.ts";
import { loadPi } from "../agent/pi.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { type Operation, OperationResultType } from "../kernel/operation.ts";
import { ProjectScope } from "../kernel/project-scope.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { testReadOnlyIdentity } from "../kernel/test-identity.ts";
import { missionOperations } from "../mission/contract.ts";
import { offerActionTool } from "./actions.ts";
import {
  AuthorKind,
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WORKBENCH_REQUEST_OWNER_ACT_TOOL,
  WORKBENCH_SERVICE_NAME,
  WORKBENCH_STREAM_TICK_MS,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { mergeEntries } from "./conversation.ts";
import { GuardAction, guardDecision } from "./guard.ts";
import { projectEntries } from "./guest-view.ts";
import { WorkbenchInvites } from "./invites.ts";
import { workbenchMigrations } from "./migrations.ts";
import {
  type OwnerActCall,
  requestOwnerActTool,
  type ScopeRequests,
} from "./scope-requests.ts";
import { recordOf } from "./sessions.ts";
import { toolName } from "./tools.ts";
import { type Dependencies, WorkbenchService } from "./service.ts";

const OWNER = "kanthord";
const HOST_AGENT = "ops@1";
const GUEST_NAME = "Mira";
const REQUEST = "pause the node";
const NO_ITEMS = 0;
const FIRST_CALL = "call_1";
const WRITE_CALL = "call_write";
const SINGLE = 1;
const PAIR = 2;
const RAISE_BLOCK_MS = 2000;
const FRAME_SKEW_LIMIT_MS = WORKBENCH_STREAM_TICK_MS / PAIR;
const FRAME_TEST_TIMEOUT_MS = 20000;
const RAISE_SETTLE_MS = 50;
const SCOPE_STOP_KIND = "scope_stop";
const P1 = createIdentity("project");
const P2 = createIdentity("project");
const OWN_NODE = createIdentity("node");
const PAUSE = missionOperations["node.pause"];
const BLOCK = missionOperations["node.block"];
const NODE_GET = missionOperations["node.get"];
const NODE_CREATE = missionOperations["node.create"];
const COOLDOWN_CLEAR = agentOperations["cooldown.clear"];
const HUMAN_ACT = {
  reason: "plan",
  expected_mission_version: 1,
  expected_state: "Available",
  expected_attempt: 1,
};
const OPERATION_LIST: readonly Operation[] = [
  ...Object.values(missionOperations),
  ...Object.values(agentOperations),
] as Operation[];
const FIXED_TEXT = WORKBENCH_PROJECT_SCOPE_TEXT;

interface HeldRun {
  request: string;
  origin: { kind: string; name: string } | null;
  inviteId: string | null;
  endingCall: string | null;
  scopeStop: { tool_call_id: string; operation_id: string } | null;
  settle: () => void;
}

interface HeldSession {
  id: string;
  hostId: string | null;
  members: HeldSession[];
  agentName: string;
  variantId: string | null;
  manager: SessionManager;
  requester: unknown;
  run: HeldRun | null;
  autoMode: boolean;
  agent: unknown;
  runError: string | null;
  queuedMessages: unknown[];
  approvals: Map<string, unknown>;
  approvers: Map<string, unknown>;
}

interface Internals {
  sessions: Map<string, HeldSession>;
  scopeRequests: ScopeRequests;
  claim(
    session: HeldSession,
    options: { clearError: boolean; request: string },
  ): HeldRun;
  guardRun(
    session: HeldSession,
    signal: undefined,
  ): Parameters<typeof guardDecision>[2];
  guardOutcome(
    session: HeldSession,
    decision: Awaited<ReturnType<typeof guardDecision>>,
    options: {
      call: { toolCallId: string };
      operation: Operation;
      input: Record<string, unknown>;
      signal: undefined;
    },
  ): Promise<{ allowed: boolean; reason?: string; terminate?: boolean }>;
  requestOwnerAct(
    session: HeldSession,
    toolCallId: string,
    call: OwnerActCall,
  ): void;
  applyRunTools(session: HeldSession, guestRun: boolean): void;
  feedOf(session: HeldSession): {
    open(request: {
      inviteId: string;
      expiresAt: number;
      after: undefined;
      signal: AbortSignal;
    }): ReadableStream<Uint8Array>;
  };
  memberEntries(
    host: HeldSession,
    limited: boolean,
  ): Parameters<typeof mergeEntries>[0];
}

async function fixture(t: TestContext) {
  const pi = await loadPi();
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  ]);
  const invites = new WorkbenchInvites(
    store,
    (ids) => new Map(ids.map((id) => [id, "alpha"])),
  );
  const owners = new Map<string, string>([[OWN_NODE, P1]]);
  const projectScope = new ProjectScope({
    projectOf: (_prefix, id) => owners.get(id) ?? null,
  });
  const invoked: string[] = [];
  const logged: unknown[] = [];
  const warned: { fields: Record<string, unknown>; message: string }[] = [];
  const service = new WorkbenchService({
    store,
    invites,
    projectScope,
    operations: () => OPERATION_LIST,
    logger: {
      error: (...args: unknown[]) => logged.push(args),
      warn: (fields: Record<string, unknown>, message: string) =>
        warned.push({ fields, message }),
    },
    invoke: (operation: Operation) => {
      invoked.push(operation.id);
      return Promise.resolve({
        type: OperationResultType.Completed,
        status: HttpStatus.OK,
        data: {},
      });
    },
  } as unknown as Dependencies);
  const internals = service as unknown as Internals;
  const host = (): HeldSession => {
    const session: HeldSession = {
      id: createIdentity("workbench_session"),
      hostId: null,
      members: [],
      agentName: HOST_AGENT,
      variantId: null,
      manager: pi.SessionManager.inMemory(),
      requester: undefined,
      run: null,
      autoMode: true,
      agent: null,
      runError: null,
      queuedMessages: [],
      approvals: new Map(),
      approvers: new Map(),
    };
    session.members.push(session);
    internals.sessions.set(session.id, session);
    return session;
  };
  const invite = (session: HeldSession, granted: readonly string[] = []) =>
    invites.create(
      session.id,
      { accountId: OWNER, name: "Ulrich" },
      {
        name: GUEST_NAME,
        projectIds: [P1],
        agentName: HOST_AGENT,
        grantedOperations: granted,
      },
    );
  const guestRun = (session: HeldSession, created: { id: string }) => {
    const run = internals.claim(session, {
      clearError: true,
      request: REQUEST,
    });
    run.origin = { kind: AuthorKind.Guest, name: GUEST_NAME };
    run.inviteId = created.id;
    session.requester = testReadOnlyIdentity(OWNER, {
      inviteId: created.id,
      projectIds: [P1],
      guestName: GUEST_NAME,
    });
    return run;
  };
  const foreignNode = () => {
    const id = createIdentity("node");
    owners.set(id, P2);
    return id;
  };
  const tool = (session: HeldSession) =>
    requestOwnerActTool((toolCallId, call) =>
      internals.requestOwnerAct(session, toolCallId, call),
    );
  const call = async (
    session: HeldSession,
    toolCallId: string,
    params: Record<string, unknown>,
  ) => {
    const result = await tool(session).execute(
      toolCallId,
      params as never,
      undefined,
      undefined,
      undefined as never,
    );
    return result;
  };
  const scopeStops = (session: HeldSession) =>
    session.manager
      .getEntries()
      .map((entry) => recordOf(entry as never))
      .filter(
        (
          record,
        ): record is Extract<
          WorkbenchRecord,
          { kind: typeof WorkbenchRecordKind.ScopeStop }
        > => record?.kind === WorkbenchRecordKind.ScopeStop,
      );
  const guestView = (session: HeldSession) =>
    projectEntries(mergeEntries(internals.memberEntries(session, false)));
  return {
    service,
    internals,
    invites,
    host,
    invite,
    guestRun,
    foreignNode,
    call,
    scopeStops,
    guestView,
    invoked,
    logged,
    warned,
    owners,
  };
}

function pauseCall(nodeId: string, body: Record<string, unknown> = {}) {
  return {
    operation_id: PAUSE.id,
    input: {
      params: { node_id: nodeId },
      body: { reason: "plan", ...body },
    },
  };
}

function pauseInput(nodeId: string) {
  return { params: { node_id: nodeId }, body: HUMAN_ACT };
}

function normalised(view: readonly Record<string, unknown>[]) {
  return JSON.stringify(
    view.map(({ id, timestamp, operation_id, ...rest }) => {
      assert.ok(id !== undefined && timestamp !== undefined);
      return { ...rest, operation_id: operation_id === undefined ? null : "x" };
    }),
  );
}

test("(security) request_owner_act gives the same guest view, tool result and scope_stop line for every target", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const mission = createIdentity("mission");
  f.owners.set(mission, P2);
  const foreign = f.foreignNode();
  const scenarios: { name: string; params: Record<string, unknown> }[] = [
    { name: "absent", params: pauseCall(createIdentity("node")) },
    { name: "foreign", params: pauseCall(foreign) },
    {
      name: "global",
      params: {
        operation_id: COOLDOWN_CLEAR.id,
        input: { params: { credential: "primary" } },
      },
    },
    {
      name: "ineligible",
      params: {
        operation_id: NODE_CREATE.id,
        input: { params: { mission_id: mission }, body: {} },
      },
    },
    { name: "dropped", params: pauseCall(foreign) },
    {
      name: "raised",
      params: { ...pauseCall(f.foreignNode()), operation_id: BLOCK.id },
    },
  ];
  const outcomes: { name: string; result: string; view: string }[] = [];
  let seen = NO_ITEMS;
  for (const [index, scenario] of scenarios.entries()) {
    const run = f.guestRun(host, created);
    const result = await f.call(host, `call_${index}`, scenario.params);
    await setImmediate();
    run.settle();
    const view = f.guestView(host).slice(seen);
    seen += view.length;
    outcomes.push({
      name: scenario.name,
      result: JSON.stringify(result),
      view: normalised(view as never),
    });
  }
  const [first] = outcomes;
  assert.ok(first);
  for (const outcome of outcomes) {
    assert.equal(outcome.result, first.result, outcome.name);
    assert.equal(outcome.view, first.view, outcome.name);
  }
  assert.ok(first.result.includes(FIXED_TEXT));
  assert.ok(first.result.includes('"terminate":true'));
  assert.equal(f.scopeStops(host).length, scenarios.length);
  assert.equal(f.internals.scopeRequests.count(host.id), PAIR);
});

test("(security) an input with an expected_ key or blocked_attempt is refused with the same line and raises nothing", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const node = f.foreignNode();
  const plain = f.guestRun(host, created);
  const baseline = await f.call(host, "call_plain", {
    operation_id: PAUSE.id,
    input: { params: { node_id: createIdentity("node") } },
  });
  plain.settle();
  for (const [index, key] of [
    "expected_mission_version",
    "blocked_attempt",
  ].entries()) {
    const run = f.guestRun(host, created);
    const result = await f.call(
      host,
      `call_${index}`,
      pauseCall(node, { [key]: SINGLE }),
    );
    await setImmediate();
    run.settle();
    assert.deepEqual(result, baseline);
  }
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
  assert.equal(f.scopeStops(host).length, PAIR + SINGLE);
});

test("(security) the act never runs in the run", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, [PAUSE.id]);
  const run = f.guestRun(host, created);
  await f.call(host, "call_1", pauseCall(f.foreignNode()));
  await setImmediate();
  run.settle();
  assert.deepEqual(f.invoked, []);
  assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
});

test("(security) the tool names of an owner-started run hold no request_owner_act and a guest-started run holds it", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  let active = ["mission--node--pause"];
  host.agent = {
    getActiveToolNames: () => active,
    setActiveToolsByName: (names: string[]) => {
      active = names;
    },
  };
  f.internals.applyRunTools(host, true);
  assert.ok(active.includes(WORKBENCH_REQUEST_OWNER_ACT_TOOL));
  f.internals.applyRunTools(host, false);
  assert.deepEqual(active, ["mission--node--pause"]);
});

test("(security) the run end does not wait on the raise: the raise runs only after the tool result", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  f.guestRun(host, created);
  let ran = false;
  t.mock.method(f.internals.scopeRequests, "raise", () => {
    ran = true;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      RAISE_BLOCK_MS,
    );
    return null;
  });
  const started = performance.now();
  const result = await f.call(host, "call_1", pauseCall(f.foreignNode()));
  const ended = performance.now() - started;
  assert.equal(ran, false);
  assert.equal(host.run?.endingCall, FIRST_CALL);
  assert.ok(JSON.stringify(result).includes('"terminate":true'));
  assert.ok(ended < RAISE_BLOCK_MS / PAIR);
  await setImmediate();
  assert.equal(ran, true);
});

test("(invariant) a guest run on an existing out-of-scope node leaves one open request for the id and the tool name of the act", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  for (const [index, operationId] of [
    PAUSE.id,
    "mission--node--pause",
  ].entries()) {
    const run = f.guestRun(host, created);
    await f.call(host, `call_${index}`, {
      ...pauseCall(f.foreignNode()),
      operation_id: operationId,
    });
    await setImmediate();
    run.settle();
    assert.equal(f.internals.scopeRequests.count(host.id), index + SINGLE);
  }
});

test("(invariant) a call that fails to parse keeps the raw operation_id in scope_stop and uses an empty one only when it is absent", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const calls: [string, Record<string, unknown>][] = [
    ["call_text", { operation_id: PAUSE.id, input: "not an object" }],
    ["call_extra", { operation_id: PAUSE.id, input: {}, extra: true }],
    ["call_absent", { input: {} }],
  ];
  for (const [toolCallId, params] of calls) {
    const run = f.guestRun(host, created);
    await f.call(host, toolCallId, params);
    await setImmediate();
    run.settle();
  }
  assert.deepEqual(
    f.scopeStops(host).map(({ operation_id }) => operation_id),
    [PAUSE.id, PAUSE.id, ""],
  );
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(security) a revoke during a guest run ends the run at the next granted act with scope_stop, no card and no request", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, [PAUSE.id]);
  const run = f.guestRun(host, created);
  f.invites.revoke(created.id);
  const input = pauseInput(OWN_NODE);
  const decision = await guardDecision(
    PAUSE,
    input,
    f.internals.guardRun(host, undefined),
  );
  assert.equal(decision.action, GuardAction.Block);
  const outcome = await f.internals.guardOutcome(host, decision, {
    call: { toolCallId: "call_1" },
    operation: PAUSE,
    input,
    signal: undefined,
  });
  assert.deepEqual(outcome, {
    allowed: false,
    reason: WORKBENCH_PROJECT_SCOPE_TEXT,
    terminate: true,
  });
  assert.equal(run.endingCall, FIRST_CALL);
  assert.equal(host.approvals.size, NO_ITEMS);
  run.settle();
  assert.deepEqual(f.scopeStops(host), [
    {
      kind: WorkbenchRecordKind.ScopeStop,
      tool_call_id: "call_1",
      operation_id: PAUSE.id,
    },
  ]);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(invariant) a blocked read keeps the run alive and a blocked mutation ends it", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  const node = f.foreignNode();
  const read = { params: { node_id: node } };
  const readDecision = await guardDecision(
    NODE_GET,
    read,
    f.internals.guardRun(host, undefined),
  );
  assert.deepEqual(
    await f.internals.guardOutcome(host, readDecision, {
      call: { toolCallId: "call_read" },
      operation: NODE_GET,
      input: read,
      signal: undefined,
    }),
    { allowed: false, reason: WORKBENCH_PROJECT_SCOPE_TEXT, terminate: false },
  );
  assert.equal(run.endingCall, null);
  assert.equal(run.scopeStop, null);
  const input = pauseInput(node);
  const decision = await guardDecision(
    PAUSE,
    input,
    f.internals.guardRun(host, undefined),
  );
  const outcome = await f.internals.guardOutcome(host, decision, {
    call: { toolCallId: "call_write" },
    operation: PAUSE,
    input,
    signal: undefined,
  });
  assert.equal(outcome.terminate, true);
  assert.equal(run.endingCall, WRITE_CALL);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(invariant) a revoke between the request_owner_act call and its raise raises nothing", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  await f.call(host, "call_1", pauseCall(f.foreignNode()));
  f.invites.revoke(created.id);
  await setImmediate();
  run.settle();
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
  assert.equal(f.scopeStops(host).length, SINGLE);
  assert.deepEqual(f.logged, []);
});

test("(security) a refused offer_action on a P2 target in a guest-started run raises no request and the run continues", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  const offer = offerActionTool({
    operations: OPERATION_LIST,
    invoke: () => Promise.reject(new Error("The offer reads nothing.")),
    requester: () => undefined,
    guestRun: () => true,
    offer: { taken: () => false, append: () => {} },
  });
  await assert.rejects(
    offer.execute(
      "call_offer",
      { operation_id: PAUSE.id, target_id: f.foreignNode() } as never,
      undefined,
      undefined,
      undefined as never,
    ),
  );
  await setImmediate();
  assert.equal(run.endingCall, null);
  assert.equal(run.scopeStop, null);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
  run.settle();
  assert.deepEqual(f.scopeStops(host), []);
});

test("(invariant) a batch with two request_owner_act calls gives one scope_stop record and at most one request", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  const first = await f.call(host, "call_1", pauseCall(f.foreignNode()));
  const second = await f.call(host, "call_2", pauseCall(f.foreignNode()));
  await setImmediate();
  assert.deepEqual(second, first);
  assert.equal(run.endingCall, FIRST_CALL);
  run.settle();
  assert.deepEqual(f.scopeStops(host), [
    {
      kind: WorkbenchRecordKind.ScopeStop,
      tool_call_id: "call_1",
      operation_id: PAUSE.id,
    },
  ]);
  assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
});

test(
  "(security) the guest scope_stop frame time is the same for an existing out-of-scope node and an absent node",
  { timeout: FRAME_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await fixture(t);
    const host = f.host();
    const created = f.invite(host);
    const abort = new AbortController();
    t.after(() => abort.abort());
    const reader = f.internals
      .feedOf(host)
      .open({
        inviteId: created.id,
        expiresAt: Date.now() + FRAME_TEST_TIMEOUT_MS,
        after: undefined,
        signal: abort.signal,
      })
      .getReader();
    const decoder = new TextDecoder();
    const scopeStopDelay = async (nodeId: string) => {
      const run = f.guestRun(host, created);
      await sleep(PAIR * WORKBENCH_STREAM_TICK_MS + RAISE_SETTLE_MS);
      await f.call(host, `call_${nodeId}`, pauseCall(nodeId));
      await sleep(RAISE_SETTLE_MS);
      const started = performance.now();
      run.settle();
      for (;;) {
        const { value, done } = await reader.read();
        assert.ok(!done && value);
        if (decoder.decode(value).includes(SCOPE_STOP_KIND))
          return performance.now() - started;
      }
    };
    const absent = await scopeStopDelay(createIdentity("node"));
    const existing = await scopeStopDelay(f.foreignNode());
    assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
    assert.ok(
      Math.abs(existing - absent) < FRAME_SKEW_LIMIT_MS,
      `${existing} against ${absent}`,
    );
  },
);

test("(invariant) the input description of request_owner_act names the body reason to give and the expected_ keys to leave out", () => {
  const { parameters } = requestOwnerActTool(() => undefined);
  const { description } = (
    parameters as { properties: { input: { description: string } } }
  ).properties.input;
  assert.match(description, /body\.reason/);
  assert.match(description, /expected_/);
  assert.match(description, /blocked_attempt/);
});

test("(invariant) a raise that a drop ends writes one warn log with the drop reason", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const scenarios: [string, Record<string, unknown>][] = [
    [
      "unknown_operation",
      { ...pauseCall(f.foreignNode()), operation_id: "x.y" },
    ],
    ["input_parse_failure", { operation_id: PAUSE.id, input: "text" }],
    [
      "concurrency_key_in_input",
      pauseCall(f.foreignNode(), { expected_mission_version: SINGLE }),
    ],
    ["no_raise", pauseCall(createIdentity("node"))],
  ];
  for (const [index, [, params]] of scenarios.entries()) {
    const run = f.guestRun(host, created);
    await f.call(host, `call_${index}`, params);
    await setImmediate();
    run.settle();
  }
  assert.deepEqual(
    f.warned.map(({ fields, message }) => [message, fields.reason]),
    scenarios.map(([reason]) => ["workbench.scope_request.dropped", reason]),
  );
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(invariant) scope_stop holds the operation id when the call names the tool name and the raw string when nothing matches", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  for (const [index, operationId] of [
    "mission--node--pause",
    PAUSE.id,
    "x.y",
  ].entries()) {
    const run = f.guestRun(host, created);
    await f.call(host, `call_${index}`, {
      ...pauseCall(f.foreignNode()),
      operation_id: operationId,
    });
    await setImmediate();
    run.settle();
  }
  assert.deepEqual(
    f.scopeStops(host).map(({ operation_id }) => operation_id),
    [PAUSE.id, PAUSE.id, "x.y"],
  );
});

test("(invariant) a second request_owner_act call in a stopped run writes one warn log with the reason run_stopped", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  await f.call(host, "call_first", pauseCall(f.foreignNode()));
  await setImmediate();
  f.warned.length = NO_ITEMS;
  await f.call(host, "call_second", pauseCall(f.foreignNode()));
  run.settle();
  assert.deepEqual(
    f.warned.map(({ fields, message }) => [
      message,
      fields.reason,
      fields.operation_id,
    ]),
    [["workbench.scope_request.dropped", "run_stopped", PAUSE.id]],
  );
});

test("(invariant) an early drop logs the operation id when the call names the tool name", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host);
  const run = f.guestRun(host, created);
  await f.call(host, "call_tool", {
    operation_id: toolName(PAUSE.id),
    input: "text",
  });
  run.settle();
  assert.deepEqual(
    f.warned.map(({ fields }) => [fields.reason, fields.operation_id]),
    [["input_parse_failure", PAUSE.id]],
  );
});

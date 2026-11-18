import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPi } from "../agent/pi.ts";
import { isReadOnlyIdentity, readOnlyInviteOf } from "../kernel/caller.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { type Operation, OperationResultType } from "../kernel/operation.ts";
import { ProjectScope } from "../kernel/project-scope.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { testReadOnlyIdentity } from "../kernel/test-identity.ts";
import { missionOperations } from "../mission/contract.ts";
import {
  AuthorKind,
  type GrantClaim,
  WORKBENCH_SERVICE_NAME,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { ClassifyKind } from "./guard-classifier.ts";
import {
  GuardAction,
  type GuardDecision,
  guardDecision,
  HUMAN_ONLY_OPERATIONS,
} from "./guard.ts";
import { WorkbenchInvites } from "./invites.ts";
import { workbenchMigrations } from "./migrations.ts";
import { recordOf } from "./sessions.ts";
import { type Dependencies, WorkbenchService } from "./service.ts";
import { type InvokeOperation, operationTool } from "./tools.ts";

const OWNER = "kanthord";
const HOST_AGENT = "ops@1";
const GUEST_A = "Mira";
const GUEST_B = "Noor";
const REQUEST = "pause the node";
const GRANT_REFUSED = "gateway.grant.refused";
const NO_ITEMS = 0;
const SINGLE = 1;
const PAIR = 2;
const PROJECT = createIdentity("project");
const OWN_NODE = createIdentity("node");
const PAUSE = missionOperations["node.pause"];
const RESUME = missionOperations["node.resume"];
const BLOCK = missionOperations["node.block"];
const UNBLOCK = missionOperations["node.unblock"];
const HUMAN_ACT = {
  reason: "plan",
  expected_mission_version: 1,
  expected_state: "Available",
  expected_attempt: 1,
};
const UNBLOCK_BODY = {
  blocked_attempt: 1,
  expected_revision: 1,
  expected_mission_version: 1,
};
const GUEST_RUN_CONFIRM = {
  action: "confirm",
  guard: { cause: "guest_run", reason: null, confidence: null },
};
const AUTO_MODE_OFF_CONFIRM = {
  action: "confirm",
  guard: { cause: "auto_mode_off", reason: null, confidence: null },
};
const AUTO_VERDICT = {
  tier: "auto",
  confidence: 1,
  request_quote: REQUEST,
  reason: "The message directs the call.",
} as const;

interface HeldSession {
  id: string;
  hostId: string | null;
  members: HeldSession[];
  agentName: string;
  manager: SessionManager;
  requester: unknown;
  run: HeldRun | null;
  autoMode: boolean;
  agent: null;
  runError: string | null;
  queuedMessages: unknown[];
  approvals: Map<string, unknown>;
  approvers: Map<string, unknown>;
}

interface HeldRun {
  request: string;
  origin: { kind: string; name: string } | null;
  inviteId: string | null;
  settle: () => void;
}

interface Internals {
  sessions: Map<string, HeldSession>;
  grantTickets: Map<
    string,
    { session_id: string; invite_id: string; operation_id: string }
  >;
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
    decision: GuardDecision,
    options: {
      call: { toolCallId: string };
      operation: Operation;
      input: Record<string, unknown>;
      signal: undefined;
    },
  ): Promise<unknown>;
  callerOf(
    session: HeldSession,
    toolCallId: string,
  ): { identity: unknown; grant?: { sessionId: string; toolCallId: string } };
  guardClassifier: () => Promise<unknown>;
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
  const owners = new Map([[OWN_NODE, PROJECT]]);
  const projectScope = new ProjectScope({
    projectOf: (_prefix, id) => owners.get(id) ?? null,
  });
  const service = new WorkbenchService({
    store,
    invites,
    projectScope,
  } as unknown as Dependencies);
  const internals = service as unknown as Internals;
  const classifier = {
    calls: NO_ITEMS,
    during: (): void => {},
  };
  internals.guardClassifier = async () => async () => {
    classifier.calls += SINGLE;
    classifier.during();
    return { kind: ClassifyKind.Verdict, verdict: AUTO_VERDICT };
  };
  const host = (): HeldSession => {
    const session: HeldSession = {
      id: createIdentity("workbench_session"),
      hostId: null,
      members: [],
      agentName: HOST_AGENT,
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
    internals.sessions.set(session.id, session);
    return session;
  };
  const invite = (
    session: HeldSession,
    name: string,
    granted: readonly string[],
  ) =>
    invites.create(
      session.id,
      { accountId: OWNER, name: "Ulrich" },
      {
        name,
        projectIds: [PROJECT],
        agentName: HOST_AGENT,
        grantedOperations: granted,
      },
    );
  const guestRun = (
    session: HeldSession,
    created: { id: string },
    name: string,
  ): HeldRun => {
    const run = internals.claim(session, {
      clearError: true,
      request: REQUEST,
    });
    run.origin = { kind: AuthorKind.Guest, name };
    run.inviteId = created.id;
    session.requester = testReadOnlyIdentity(OWNER, {
      inviteId: created.id,
      projectIds: [PROJECT],
      guestName: name,
    });
    return run;
  };
  const ownerRun = (session: HeldSession): HeldRun => {
    const run = internals.claim(session, {
      clearError: true,
      request: REQUEST,
    });
    run.origin = { kind: AuthorKind.Owner, name: OWNER };
    return run;
  };
  const decide = async (
    session: HeldSession,
    operation: Operation,
    input: Record<string, unknown>,
    toolCallId: string,
  ) => {
    const decision = await guardDecision(
      operation,
      input,
      internals.guardRun(session, undefined),
    );
    if (decision.action === GuardAction.Auto)
      await internals.guardOutcome(session, decision, {
        call: { toolCallId },
        operation,
        input,
        signal: undefined,
      });
    return decision;
  };
  const missionChanges: string[] = [];
  const statuses: number[] = [];
  const invoke: InvokeOperation = (operation, input, options) => {
    const { identity, grant } = options;
    if (operation.mutation && isReadOnlyIdentity(identity) && !grant)
      return failed(HttpStatus.Unauthorized, "unauthorized");
    if (grant) {
      const inviteId = readOnlyInviteOf(identity);
      const claim: GrantClaim = {
        inviteId: inviteId ?? "",
        sessionId: grant.sessionId,
        toolCallId: grant.toolCallId,
        operationId: operation.id,
        input,
      };
      if (inviteId === null || service.claimGrant(claim) === null)
        return failed(HttpStatus.Unauthorized, GRANT_REFUSED);
    }
    missionChanges.push(operation.id);
    return Promise.resolve({
      type: OperationResultType.Completed,
      status: HttpStatus.OK,
      data: {},
    });
  };
  const failed = (status: number, code: string) => {
    statuses.push(status);
    return Promise.resolve({
      type: OperationResultType.Failure,
      status,
      error: {
        error: { code, message: "refused", details: null },
        request_id: "r",
      },
    } as const);
  };
  const runTool = async (
    session: HeldSession,
    operation: Operation,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<string | null> => {
    const tool = operationTool(operation, invoke, {
      callerOf: (id) => internals.callerOf(session, id) as never,
      scopeOf: () => new Set([PROJECT]),
      projectScope,
      completed: () => undefined,
    });
    try {
      await tool.execute(
        toolCallId,
        input,
        undefined,
        undefined,
        undefined as never,
      );
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  return {
    service,
    internals,
    invites,
    classifier,
    host,
    invite,
    guestRun,
    ownerRun,
    decide,
    runTool,
    missionChanges,
    statuses,
  };
}

function pauseInput() {
  return { params: { node_id: OWN_NODE }, body: HUMAN_ACT };
}

function unblockInput() {
  return { params: { node_id: OWN_NODE }, body: UNBLOCK_BODY };
}

function claimOf(
  host: HeldSession,
  inviteId: string,
  toolCallId: string,
  operation: Operation = PAUSE,
  input: unknown = pauseInput(),
): GrantClaim {
  return {
    inviteId,
    sessionId: host.id,
    toolCallId,
    operationId: operation.id,
    input,
  };
}

test("(security) rule 4: an uncovered call of a guest run gives confirm guest_run with no model call", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  const other = f.invite(host, GUEST_B, [BLOCK.id]);
  f.guestRun(host, created, GUEST_A);
  assert.deepEqual(
    await f.decide(host, BLOCK, pauseInput(), "call_1"),
    GUEST_RUN_CONFIRM,
  );
  f.guestRun(host, other, GUEST_B);
  assert.deepEqual(
    await f.decide(host, PAUSE, pauseInput(), "call_2"),
    GUEST_RUN_CONFIRM,
  );
  assert.equal(f.classifier.calls, NO_ITEMS);
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
});

test("(security) auto mode off gives auto_mode_off for a covered R1 call", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  f.guestRun(host, created, GUEST_A);
  host.autoMode = false;
  assert.deepEqual(
    await f.decide(host, PAUSE, pauseInput(), "call_1"),
    AUTO_MODE_OFF_CONFIRM,
  );
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
});

test("(invariant) a switch of auto mode to off during a covered R2 classification gives auto_mode_off", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [BLOCK.id]);
  f.guestRun(host, created, GUEST_A);
  f.classifier.during = () => {
    host.autoMode = false;
  };
  assert.deepEqual(
    await f.decide(host, BLOCK, pauseInput(), "call_1"),
    AUTO_MODE_OFF_CONFIRM,
  );
  assert.equal(f.classifier.calls, SINGLE);
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
});

test("(security) a switch of auto mode to off after the decision and before the claim gives 401 gateway.grant.refused", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  f.guestRun(host, created, GUEST_A);
  assert.equal(
    (await f.decide(host, PAUSE, pauseInput(), "call_1")).action,
    GuardAction.Auto,
  );
  host.autoMode = false;
  const message = await f.runTool(host, PAUSE, pauseInput(), "call_1");
  assert.ok(message?.startsWith(GRANT_REFUSED), String(message));
  assert.deepEqual(f.statuses, [HttpStatus.Unauthorized]);
  assert.deepEqual(f.missionChanges, []);
});

test("(invariant) a revoke between rule 4 and the verdict gives guest_run", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [BLOCK.id]);
  f.guestRun(host, created, GUEST_A);
  f.classifier.during = () => {
    f.invites.revoke(created.id);
  };
  assert.deepEqual(
    await f.decide(host, BLOCK, pauseInput(), "call_1"),
    GUEST_RUN_CONFIRM,
  );
  assert.equal(f.classifier.calls, SINGLE);
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
});

test("(security) a revoke after the decision and before the claim gives 401 gateway.grant.refused, no Mission change and a tool result with the code", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  f.guestRun(host, created, GUEST_A);
  assert.equal(
    (await f.decide(host, PAUSE, pauseInput(), "call_1")).action,
    GuardAction.Auto,
  );
  f.invites.revoke(created.id);
  const message = await f.runTool(host, PAUSE, pauseInput(), "call_1");
  assert.ok(message?.startsWith(`${GRANT_REFUSED}: `), String(message));
  assert.deepEqual(f.statuses, [HttpStatus.Unauthorized]);
  assert.deepEqual(f.missionChanges, []);
});

test("(security) narrowing: a human-only list that adds a granted id gives block", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  f.guestRun(host, created, GUEST_A);
  const humanOnly = HUMAN_ONLY_OPERATIONS as Set<string>;
  humanOnly.add(PAUSE.id);
  try {
    const decision = await f.decide(host, PAUSE, pauseInput(), "call_1");
    assert.equal(decision.action, GuardAction.Block);
  } finally {
    humanOnly.delete(PAUSE.id);
  }
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
});

test("(security) starter: the grant of the guest who started the run applies, and an owner run never reads a grant", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const inviteA = f.invite(host, GUEST_A, [PAUSE.id]);
  const inviteB = f.invite(host, GUEST_B, []);
  const runA = f.guestRun(host, inviteA, GUEST_A);
  assert.equal(
    (await f.decide(host, PAUSE, pauseInput(), "call_a")).action,
    GuardAction.Auto,
  );
  assert.equal(await f.runTool(host, PAUSE, pauseInput(), "call_a"), null);
  assert.deepEqual(f.missionChanges, [PAUSE.id]);
  runA.settle();
  const runB = f.guestRun(host, inviteB, GUEST_B);
  assert.deepEqual(
    await f.decide(host, PAUSE, pauseInput(), "call_b"),
    GUEST_RUN_CONFIRM,
  );
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
  runB.settle();
  const owner = f.ownerRun(host);
  host.requester = undefined;
  const decision = await f.decide(host, PAUSE, pauseInput(), "call_o");
  assert.equal(decision.action, GuardAction.Auto);
  assert.equal(f.internals.grantTickets.size, NO_ITEMS);
  assert.equal(f.internals.callerOf(host, "call_o").grant, undefined);
  assert.equal(f.classifier.calls, NO_ITEMS);
  owner.settle();
});

test("(invariant) settle deletes the unclaimed tickets of the run", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  const run = f.guestRun(host, created, GUEST_A);
  const foreign = `${createIdentity("workbench_session")}:call_x`;
  f.internals.grantTickets.set(foreign, {
    session_id: foreign,
    invite_id: created.id,
    operation_id: PAUSE.id,
  });
  assert.equal(
    (await f.decide(host, PAUSE, pauseInput(), "call_1")).action,
    GuardAction.Auto,
  );
  assert.equal(f.internals.grantTickets.size, PAIR);
  run.settle();
  assert.deepEqual([...f.internals.grantTickets.keys()], [foreign]);
});

test("(security) an auto decision of a guest run stores one ticket and appends the guard record with the grant", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id]);
  f.guestRun(host, created, GUEST_A);
  await f.decide(host, PAUSE, pauseInput(), "call_1");
  assert.deepEqual(f.internals.grantTickets.get(`${host.id}:call_1`), {
    session_id: host.id,
    invite_id: created.id,
    operation_id: PAUSE.id,
  });
  const records = host.manager
    .getEntries()
    .map((entry) => recordOf(entry as never))
    .filter((record): record is WorkbenchRecord => record !== null);
  assert.deepEqual(records, [
    {
      kind: WorkbenchRecordKind.Guard,
      tool_call_id: "call_1",
      operation_id: PAUSE.id,
      reason: "reversible",
      grant: {
        invite_id: created.id,
        author: { kind: AuthorKind.Guest, name: GUEST_A },
      },
    },
  ]);
});

const REFUSALS = {
  "an absent ticket": (f: Setup) =>
    f.service.claimGrant(claimOf(f.host, f.created.id, "call_absent")),
  "another invite": (f: Setup) =>
    f.service.claimGrant(claimOf(f.host, f.other.id, "call_1")),
  "another operation": (f: Setup) =>
    f.service.claimGrant(claimOf(f.host, f.created.id, "call_1", RESUME)),
  "an invite row that does not resolve": (f: Setup) => {
    f.invites.revoke(f.created.id);
    return f.service.claimGrant(claimOf(f.host, f.created.id, "call_1"));
  },
  "an invite of another session": (f: Setup) => {
    f.internals.grantTickets.set(`${f.host.id}:call_1`, {
      session_id: f.host.id,
      invite_id: f.foreign.id,
      operation_id: PAUSE.id,
    });
    return f.service.claimGrant(claimOf(f.host, f.foreign.id, "call_1"));
  },
  "auto mode off": (f: Setup) => {
    f.host.autoMode = false;
    return f.service.claimGrant(claimOf(f.host, f.created.id, "call_1"));
  },
  "a grant that does not cover the call": (f: Setup) =>
    f.service.claimGrant(
      claimOf(f.host, f.created.id, "call_u", UNBLOCK, {
        params: { node_id: OWN_NODE },
        body: { ...UNBLOCK_BODY, change: {} },
      }),
    ),
};

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(t: TestContext) {
  const f = await fixture(t);
  const host = f.host();
  const created = f.invite(host, GUEST_A, [PAUSE.id, UNBLOCK.id]);
  const other = f.invite(host, GUEST_B, []);
  const foreign = f.invite(f.host(), GUEST_B, []);
  f.guestRun(host, created, GUEST_A);
  assert.equal(
    (await f.decide(host, PAUSE, pauseInput(), "call_1")).action,
    GuardAction.Auto,
  );
  f.classifier.during = () => {};
  assert.equal(
    (await f.decide(host, UNBLOCK, unblockInput(), "call_u")).action,
    GuardAction.Auto,
  );
  return { ...f, host, created, other, foreign };
}

for (const [name, refuse] of Object.entries(REFUSALS))
  test(`(security) claimGrant answers null for ${name}`, async (t) => {
    const f = await setup(t);
    assert.equal(refuse(f), null);
  });

test("(invariant) a second claim of one ticket answers null", async (t) => {
  const f = await setup(t);
  assert.deepEqual(
    f.service.claimGrant(claimOf(f.host, f.created.id, "call_1")),
    { invitedBy: OWNER, projectIds: [PROJECT] },
  );
  assert.equal(
    f.service.claimGrant(claimOf(f.host, f.created.id, "call_1")),
    null,
  );
});

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import { isReadOnlyIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  type CallerContext,
  type ClientOptions,
  type Operation,
  OperationResultType,
} from "../kernel/operation.ts";
import { ProjectScope } from "../kernel/project-scope.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
  testReadOnlyIdentity,
} from "../kernel/test-identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { background } from "../kernel/context.ts";
import { PROJECT_NAME_MAX_LENGTH } from "../kernel/project-name.ts";
import { missionOperations } from "../mission/contract.ts";
import { ProjectErrorCode, projectOperations } from "../project/contract.ts";
import {
  ActionOutcome,
  AuthorKind,
  ScopeRequestState,
  WORKBENCH_SERVICE_NAME,
  WorkbenchErrorCode,
  workbenchOperations,
} from "./contract.ts";
import { HUMAN_ONLY_OPERATIONS } from "./guard.ts";
import { WorkbenchInvites } from "./invites.ts";
import { workbenchMigrations } from "./migrations.ts";
import { createSession, sessionPlace } from "./sessions.ts";
import { type Dependencies, WorkbenchService } from "./service.ts";
import { operationTool } from "./tools.ts";
import type { OwnerActCall } from "./scope-requests.ts";

const OWNER = "kanthord";
const HOST_AGENT = "ops@1";
const GUEST_NAME = "Mira";
const PROJECT_NAME = "shop-v2";
const NO_ITEMS = 0;
const SINGLE = 1;
const PAIR = 2;
const OWNER_IDENTITY = testHumanIdentity(OWNER, "Ulrich", "scope-request");
const P1 = createIdentity("project");
const P2 = createIdentity("project");
const OWN_NODE = createIdentity("node");
const PAUSE = missionOperations["node.pause"];
const FULFILLED = "fulfilled";
const SETTLED_LINE = "workbench.scope_request.settled";
const STALE_CODE = "mission.node.stale";
const EXPECTED = {
  expected_attempt: 1,
  expected_mission_version: 3,
  expected_state: "Available",
};
const AUDIT_FIELDS = [
  "conversation_id",
  "request_id",
  "invite_id",
  "guest_name",
  "operation_id",
  "target_id",
  "project_id",
  "typed_name",
  "decision",
  "outcome_code",
];
const OPERATION_LIST: readonly Operation[] = [
  ...Object.values(missionOperations),
  ...Object.values(projectOperations),
  ...Object.values(workbenchOperations),
] as Operation[];

interface HeldRun {
  request: string;
  origin: { kind: string; name: string } | null;
  inviteId: string | null;
  settle: () => void;
}

interface HeldSession {
  id: string;
  hostId: string | null;
  members: HeldSession[];
  agentName: string;
  manager: SessionManager;
  requester: unknown;
  run: HeldRun | null;
  autoMode: boolean;
  agent: unknown;
  runError: string | null;
  queuedMessages: unknown[];
  approvals: Map<string, unknown>;
  approvers: Map<string, unknown>;
  evidenceGrants: Set<string>;
  configuration: unknown;
}

interface Internals {
  sessions: Map<string, HeldSession>;
  grantTickets: Map<string, unknown>;
  scopeRequests: {
    open(
      sessionId: string,
    ): { id: string; state: string; error: string | null }[];
    count(sessionId: string): number;
  };
  claim(
    session: HeldSession,
    options: { clearError: boolean; request: string },
  ): HeldRun;
  requestOwnerAct(
    session: HeldSession,
    toolCallId: string,
    call: OwnerActCall,
  ): void;
}

interface Call {
  operation: Operation;
  input: unknown;
  options: ClientOptions;
}

function caller(): CallerContext {
  return {
    identity: OWNER_IDENTITY,
    context: background,
    requestId: "request",
    commit: () => {
      throw new Error("The scope request handlers commit nothing.");
    },
  };
}

function completed(data: unknown) {
  return Promise.resolve({
    type: OperationResultType.Completed,
    status: HttpStatus.OK,
    data,
  } as const);
}

function failed(status: number, code: string) {
  return Promise.resolve({
    type: OperationResultType.Failure,
    status,
    error: {
      error: { code, message: "refused", details: null },
      request_id: "r",
    },
  } as const);
}

async function fixture(t: TestContext, stateDirectory = temporary(t)) {
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
  const calls: Call[] = [];
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const behaviour = {
    projectName: PROJECT_NAME,
    projectMissing: false,
    projectStatus: null as number | null,
    pause: (): Promise<
      Awaited<ReturnType<typeof completed>> | Awaited<ReturnType<typeof failed>>
    > => completed({}),
  };
  const service = new WorkbenchService({
    store,
    invites,
    projectScope,
    stateDirectory,
    declarationOf: (name: string) => AGENT_DECLARATIONS[name as never],
    projectNames: (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, "alpha"])),
    operations: () => OPERATION_LIST,
    logger: {
      info: (fields: Record<string, unknown>, message: string) =>
        logged.push({ fields, message }),
      warn: () => {},
      error: () => {},
    },
    invoke: (operation: Operation, input: unknown, options: ClientOptions) => {
      calls.push({ operation, input, options });
      if (operation.id === projectOperations.get.id && behaviour.projectMissing)
        return failed(HttpStatus.NotFound, ProjectErrorCode.ProjectNotFound);
      if (operation.id === projectOperations.get.id && behaviour.projectStatus)
        return failed(behaviour.projectStatus, "project.store.unavailable");
      if (operation.id === projectOperations.get.id)
        return completed({
          id: P2,
          name: behaviour.projectName,
          binding_set_version: 1,
          created_at: 1,
          paused_at: null,
          workspace_directory: "/tmp/workspace",
        });
      if (operation.id === PAUSE.id) return behaviour.pause();
      return completed({ items: [] });
    },
  } as unknown as Dependencies);
  const internals = service as unknown as Internals;
  const host = async (): Promise<HeldSession> => {
    const id = createIdentity("workbench_session");
    const place = sessionPlace(stateDirectory, HOST_AGENT);
    const session: HeldSession = {
      id,
      hostId: null,
      members: [],
      agentName: HOST_AGENT,
      manager: await createSession(place, id, {}),
      requester: undefined,
      run: null,
      autoMode: true,
      agent: null,
      runError: null,
      queuedMessages: [],
      approvals: new Map(),
      approvers: new Map(),
      evidenceGrants: new Set(),
      configuration: {},
    };
    session.members.push(session);
    internals.sessions.set(id, session);
    return session;
  };
  const persisted = (session: HeldSession) => {
    const timestamp = Date.now();
    session.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp,
    });
    session.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp,
    } as never);
    return session;
  };
  const participant = (hostSession: HeldSession): HeldSession => {
    const session = {
      ...hostSession,
      id: createIdentity("workbench_session"),
      hostId: hostSession.id,
      members: [],
    };
    internals.sessions.set(session.id, session);
    return session;
  };
  const invite = (session: HeldSession) =>
    invites.create(
      session.id,
      { accountId: OWNER, name: "Ulrich" },
      {
        name: GUEST_NAME,
        projectIds: [P1],
        agentName: HOST_AGENT,
        grantedOperations: [],
      },
    );
  const foreignNode = () => {
    const id = createIdentity("node");
    owners.set(id, P2);
    return id;
  };
  const raise = async (
    session: HeldSession,
    created: { id: string },
    nodeId = foreignNode(),
  ) => {
    const run = internals.claim(session, { clearError: true, request: "go" });
    run.origin = { kind: AuthorKind.Guest, name: GUEST_NAME };
    run.inviteId = created.id;
    session.requester = testReadOnlyIdentity(OWNER, {
      inviteId: created.id,
      projectIds: [P1],
      guestName: GUEST_NAME,
    });
    internals.requestOwnerAct(session, `call_${nodeId}`, {
      operationId: PAUSE.id,
      input: {
        params: { node_id: nodeId },
        body: { reason: "hold" },
      },
      drop: null,
    });
    await setImmediate();
    run.settle();
    const open = internals.scopeRequests.open(session.id);
    const request = open.at(-SINGLE);
    assert.ok(request);
    return request;
  };
  const approve = (
    session: HeldSession,
    requestId: string,
    body: { project_name: string; expected: Record<string, number | string> },
  ) =>
    service.scopeRequestApprove(caller(), {
      sessionId: session.id,
      requestId,
      body,
    });
  return {
    service,
    internals,
    invites,
    calls,
    logged,
    behaviour,
    host,
    persisted,
    participant,
    invite,
    raise,
    approve,
    stateDirectory,
  };
}

async function refusedWith(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

function actCalls(calls: readonly Call[]) {
  return calls.filter(({ operation }) => operation.id === PAUSE.id);
}

test("(security) a typed name that differs by a space, the case or the id answers 409 name_mismatch and leaves the request open", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  for (const typed of [` ${PROJECT_NAME}`, `${PROJECT_NAME} `, "Shop-v2", P2]) {
    await refusedWith(
      f.approve(host, request.id, { project_name: typed, expected: EXPECTED }),
      HttpStatus.Conflict,
      WorkbenchErrorCode.ScopeRequestNameMismatch,
    );
    const [open] = f.internals.scopeRequests.open(host.id);
    assert.equal(open?.id, request.id);
    assert.equal(open?.state, ScopeRequestState.Open);
  }
  assert.deepEqual(actCalls(f.calls), []);
});

test("(invariant) an approve on a deleted project settles the request and answers 409 refused", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  f.behaviour.projectMissing = true;
  await refusedWith(
    f.approve(host, request.id, {
      project_name: PROJECT_NAME,
      expected: EXPECTED,
    }),
    HttpStatus.Conflict,
    WorkbenchErrorCode.ScopeRequestRefused,
  );
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
  assert.deepEqual(actCalls(f.calls), []);
  await refusedWith(
    f.approve(host, request.id, {
      project_name: PROJECT_NAME,
      expected: EXPECTED,
    }),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ScopeRequestNotFound,
  );
});

test("(invariant) an approve with a 503 project read rethrows it and keeps the request open", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  f.behaviour.projectStatus = HttpStatus.ServiceUnavailable;
  await refusedWith(
    f.approve(host, request.id, {
      project_name: PROJECT_NAME,
      expected: EXPECTED,
    }),
    HttpStatus.ServiceUnavailable,
    "project.store.unavailable",
  );
  const [open] = f.internals.scopeRequests.open(host.id);
  assert.equal(open?.id, request.id);
  assert.equal(open?.state, ScopeRequestState.Open);
  assert.deepEqual(actCalls(f.calls), []);
});

test("(security) a key set unequal to expected_keys answers 400 expected_invalid and leaves the request open", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  const wrongKeys: Record<string, number | string>[] = [
    {},
    { expected_attempt: 1 },
    { ...EXPECTED, expected_extra: 1 },
  ];
  for (const expected of wrongKeys)
    await refusedWith(
      f.approve(host, request.id, { project_name: PROJECT_NAME, expected }),
      HttpStatus.BadRequest,
      WorkbenchErrorCode.ScopeRequestExpectedInvalid,
    );
  await refusedWith(
    f.approve(host, request.id, {
      project_name: PROJECT_NAME,
      expected: { ...EXPECTED, expected_attempt: "one" },
    }),
    HttpStatus.BadRequest,
    WorkbenchErrorCode.ScopeRequestExpectedInvalid,
  );
  assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
  assert.deepEqual(actCalls(f.calls), []);
});

test("(invariant) a second approve answers 404 and two parallel approves give one act", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  const body = { project_name: PROJECT_NAME, expected: EXPECTED };
  const outcomes = await Promise.allSettled([
    f.approve(host, request.id, body),
    f.approve(host, request.id, body),
  ]);
  assert.equal(
    outcomes.filter(({ status }) => status === FULFILLED).length,
    SINGLE,
  );
  assert.equal(actCalls(f.calls).length, SINGLE);
  await refusedWith(
    f.approve(host, request.id, body),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ScopeRequestNotFound,
  );
  assert.equal(actCalls(f.calls).length, SINGLE);
});

test("(security) the act runs once under the owner identity with the merged input and no grant", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  const answer = await f.approve(host, request.id, {
    project_name: PROJECT_NAME,
    expected: EXPECTED,
  });
  assert.deepEqual(answer, {
    request_id: request.id,
    outcome: ActionOutcome.Done,
    error_code: null,
  });
  const [act] = actCalls(f.calls);
  assert.ok(act);
  assert.equal(act.options.identity, OWNER_IDENTITY);
  assert.equal(isReadOnlyIdentity(act.options.identity), false);
  assert.equal(act.options.grant, undefined);
  assert.ok(act.options.idempotencyKey);
  assert.deepEqual((act.input as { body: unknown }).body, {
    reason: "hold",
    ...EXPECTED,
  });
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(invariant) a stale expected value gives the owning error and outcome failed, and the request stays open with the code", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  f.behaviour.pause = () => failed(HttpStatus.Conflict, STALE_CODE);
  const answer = await f.approve(host, request.id, {
    project_name: PROJECT_NAME,
    expected: EXPECTED,
  });
  assert.deepEqual(answer, {
    request_id: request.id,
    outcome: ActionOutcome.Failed,
    error_code: STALE_CODE,
  });
  const [open] = f.internals.scopeRequests.open(host.id);
  assert.equal(open?.state, ScopeRequestState.Open);
  assert.equal(open?.error, STALE_CODE);
  f.behaviour.pause = () => completed({});
  const retried = await f.approve(host, request.id, {
    project_name: PROJECT_NAME,
    expected: EXPECTED,
  });
  assert.equal(retried.outcome, ActionOutcome.Done);
});

test("(invariant) a revoke while an approve runs lets the act finish and keeps the request deleted", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const created = f.invite(host);
  const request = await f.raise(host, created);
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  f.behaviour.pause = () => {
    started.resolve();
    return gate.promise.then(() => completed({}));
  };
  const approving = f.approve(host, request.id, {
    project_name: PROJECT_NAME,
    expected: EXPECTED,
  });
  await started.promise;
  f.service.inviteRevoke(created.id);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
  gate.resolve();
  const answer = await approving;
  assert.equal(answer.outcome, ActionOutcome.Done);
  assert.equal(actCalls(f.calls).length, SINGLE);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(security) a revoke deletes the requests of the invite", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const created = f.invite(host);
  await f.raise(host, created);
  await f.raise(host, created);
  assert.equal(f.internals.scopeRequests.count(host.id), PAIR);
  f.service.inviteRevoke(created.id);
  assert.equal(f.internals.scopeRequests.count(host.id), NO_ITEMS);
});

test("(security) a participant id answers 409 not_host on approve and reject", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const request = await f.raise(host, f.invite(host));
  const member = f.participant(host);
  await refusedWith(
    f.approve(member, request.id, {
      project_name: PROJECT_NAME,
      expected: EXPECTED,
    }),
    HttpStatus.Conflict,
    WorkbenchErrorCode.NotHost,
  );
  await refusedWith(
    f.service.scopeRequestReject(member.id, request.id),
    HttpStatus.Conflict,
    WorkbenchErrorCode.NotHost,
  );
  assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
});

test("(security) both operations are human-only and no agent tool list holds them", () => {
  const ids = [
    workbenchOperations["session.scopeRequest.approve"].id,
    workbenchOperations["session.scopeRequest.reject"].id,
  ];
  for (const id of ids) assert.ok(HUMAN_ONLY_OPERATIONS.has(id), id);
  for (const declaration of Object.values(AGENT_DECLARATIONS))
    for (const id of ids)
      assert.ok(
        !declaration.tools.operation.includes(id),
        `${declaration.agent_name} lists ${id}`,
      );
});

test("(security) the guest read holds no request, and the owner snapshot and the list show none after the invite expiry", async (t) => {
  const f = await fixture(t);
  const host = f.persisted(await f.host());
  const created = f.invite(host);
  const request = await f.raise(host, created);
  const guest = testGuestIdentity({
    guestId: "guest",
    name: GUEST_NAME,
    inviteId: created.id,
    sessionId: host.id,
    invitedBy: OWNER,
    reader: testReadOnlyIdentity(OWNER, {
      inviteId: created.id,
      projectIds: [P1],
      guestName: GUEST_NAME,
    }),
    jti: "guest-jti",
  });
  const guestText = JSON.stringify(await f.service.guestGet(guest));
  assert.ok(!guestText.includes(request.id));
  assert.ok(!guestText.includes("scope_request"));
  const shown = await f.service.get(host.id);
  assert.equal(shown.scope_requests.length, SINGLE);
  assert.equal(shown.scope_requests[NO_ITEMS]?.id, request.id);
  const listed = await f.service.list(undefined);
  assert.equal(
    listed.items.find(({ id }) => id === host.id)?.scope_requests,
    SINGLE,
  );
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 86_400_000);
  assert.deepEqual((await f.service.get(host.id)).scope_requests, []);
  assert.equal(
    (await f.service.list(undefined)).items.find(({ id }) => id === host.id)
      ?.scope_requests,
    NO_ITEMS,
  );
});

test("(security) the tool result of workbench--session--list drops scope_requests and the service answer keeps it", async (t) => {
  const f = await fixture(t);
  const host = f.persisted(await f.host());
  await f.raise(host, f.invite(host));
  const listOperation = workbenchOperations["session.list"];
  const tool = operationTool(
    listOperation,
    async () => completed(await f.service.list(undefined)),
    {
      callerOf: () => ({ identity: OWNER_IDENTITY }),
      scopeOf: () => null,
      projectScope: new ProjectScope({ projectOf: () => null }),
    },
  );
  const answer = await f.service.list(undefined);
  const item = answer.items.find(({ id }) => id === host.id);
  assert.equal(item?.scope_requests, SINGLE);
  const result = await tool.execute(
    "call_list",
    {} as never,
    undefined,
    undefined,
    undefined as never,
  );
  const text = JSON.stringify(result);
  assert.ok(text.includes(host.id));
  assert.ok(!text.includes("scope_requests"));
});

test("(security) approve and reject each write one settled line with every audit field", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  const created = f.invite(host);
  const first = await f.raise(host, created);
  const second = await f.raise(host, created);
  await f.approve(host, first.id, {
    project_name: PROJECT_NAME,
    expected: EXPECTED,
  });
  await f.service.scopeRequestReject(host.id, second.id);
  const lines = f.logged.filter(({ message }) => message === SETTLED_LINE);
  assert.equal(lines.length, PAIR);
  for (const { fields } of lines)
    assert.deepEqual(Object.keys(fields).sort(), [...AUDIT_FIELDS].sort());
  assert.deepEqual(
    lines.map(({ fields }) => fields.decision),
    ["approved", "rejected"],
  );
  assert.equal(lines[NO_ITEMS]?.fields.typed_name, PROJECT_NAME);
  assert.equal(lines[NO_ITEMS]?.fields.request_id, first.id);
  assert.equal(lines[NO_ITEMS]?.fields.invite_id, created.id);
  assert.equal(lines[NO_ITEMS]?.fields.guest_name, GUEST_NAME);
  assert.equal(lines[NO_ITEMS]?.fields.operation_id, PAUSE.id);
  assert.equal(lines[NO_ITEMS]?.fields.project_id, P2);
  assert.equal(lines[NO_ITEMS]?.fields.conversation_id, host.id);
});

test("(security) a new service on the same state directory holds no request and no grant ticket", async (t) => {
  const f = await fixture(t);
  const host = await f.host();
  await f.raise(host, f.invite(host));
  assert.equal(f.internals.scopeRequests.count(host.id), SINGLE);
  const restarted = await fixture(t, f.stateDirectory);
  assert.equal(restarted.internals.scopeRequests.count(host.id), NO_ITEMS);
  assert.equal(restarted.internals.grantTickets.size, NO_ITEMS);
});

test("(invariant) the approve body refuses a project_name longer than the project name limit", () => {
  const { body } = workbenchOperations["session.scopeRequest.approve"].input
    .shape as unknown as {
    body: { safeParse(input: unknown): { success: boolean } };
  };
  const approve = (name: string) =>
    body.safeParse({ project_name: name, expected: EXPECTED }).success;
  assert.equal(approve("a".repeat(PROJECT_NAME_MAX_LENGTH)), true);
  assert.equal(approve("a".repeat(PROJECT_NAME_MAX_LENGTH + SINGLE)), false);
});

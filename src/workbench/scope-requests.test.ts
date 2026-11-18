import assert from "node:assert/strict";
import { test } from "node:test";
import { ScopeRequestState } from "./contract.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Operation } from "../kernel/operation.ts";
import { ProjectScope } from "../kernel/project-scope.ts";
import { missionOperations } from "../mission/contract.ts";
import { projectOperations } from "../project/contract.ts";
import {
  isConcurrencyKey,
  ScopeRequests,
  WORKBENCH_SCOPE_REQUEST_LIMIT,
  WORKBENCH_SCOPE_REQUEST_REPEAT_MS,
} from "./scope-requests.ts";

const HOST_AGENT = "ops@1";
const NO_ITEMS = 0;
const CONFLICT_CODE = "mission.node.conflict";
const ONE_ITEM = 1;
const INVITE_LIFETIME_MS = 604_800_000;
const START = 1_000_000;
const SESSION = createIdentity("workbench_session");
const INVITE = createIdentity("workbench_invite");
const P1 = createIdentity("project");
const P2 = createIdentity("project");
const OWN_NODE = createIdentity("node");
const SCOPE: ReadonlySet<string> = new Set([P1]);
const PAUSE = missionOperations["node.pause"];
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

function fixture() {
  const owners = new Map<string, string>([[OWN_NODE, P1]]);
  const scope = new ProjectScope({
    projectOf: (_prefix, id) => owners.get(id) ?? null,
  });
  const clock = { now: START };
  const requests = new ScopeRequests(() => clock.now);
  const foreignNode = () => {
    const id = createIdentity("node");
    owners.set(id, P2);
    return id;
  };
  const raise = (
    operation: Operation,
    input: unknown,
    options: { inviteId?: string; projects?: Map<string, string | null> } = {},
  ) =>
    requests.raise({
      sessionId: SESSION,
      inviteId: options.inviteId ?? INVITE,
      inviteExpiresAt: START + INVITE_LIFETIME_MS,
      guestName: "Mira",
      agentName: HOST_AGENT,
      operation,
      input,
      projects:
        options.projects ??
        scope.resolve(operation, {
          input: input as never,
          scope: SCOPE,
        }).projects,
      scope: SCOPE,
    });
  return { owners, clock, requests, foreignNode, raise };
}

function pause(nodeId: string, body: Record<string, unknown> = HUMAN_ACT) {
  return { params: { node_id: nodeId }, query: {}, body };
}

function unblock(nodeId: string, body: Record<string, unknown>) {
  return { params: { node_id: nodeId }, query: {}, body };
}

test("a raised request holds the target, the ids, the project and the sorted concurrency keys", () => {
  const f = fixture();
  const node = f.foreignNode();
  const request = f.raise(PAUSE, pause(node));
  assert.ok(request);
  assert.equal(request.targetId, node);
  assert.deepEqual(request.ids, [node]);
  assert.equal(request.projectId, P2);
  assert.deepEqual(request.expectedKeys, [
    "expected_attempt",
    "expected_mission_version",
    "expected_state",
  ]);
  assert.equal(request.state, ScopeRequestState.Open);
  assert.equal(request.expiresAt, START + INVITE_LIFETIME_MS);
  const other = f.raise(UNBLOCK, unblock(f.foreignNode(), UNBLOCK_BODY));
  assert.deepEqual(other?.expectedKeys, [
    "blocked_attempt",
    "expected_mission_version",
    "expected_revision",
  ]);
  const project = f.raise(
    projectOperations.pause,
    { params: { project_id: P2 }, query: {}, body: null },
    { projects: new Map([[P2, P2]]) },
  );
  assert.deepEqual(project?.expectedKeys, []);
  assert.equal(project?.targetId, P2);
});

test("isConcurrencyKey matches the expected_ prefix and blocked_attempt", () => {
  assert.ok(isConcurrencyKey("expected_revision"));
  assert.ok(isConcurrencyKey("blocked_attempt"));
  assert.equal(isConcurrencyKey("reason"), false);
});

test("(security) raise answers null for an absent id", () => {
  const f = fixture();
  assert.equal(f.raise(PAUSE, pause(createIdentity("node"))), null);
  assert.equal(f.requests.count(SESSION), NO_ITEMS);
});

test("(security) raise answers null for a mixed in-scope and P2 input", () => {
  const f = fixture();
  const input = {
    params: { node_id: OWN_NODE, depends_on_id: f.foreignNode() },
    query: {},
    body: HUMAN_ACT,
  };
  assert.equal(f.raise(missionOperations["dependency.add"], input), null);
  assert.equal(f.requests.count(SESSION), NO_ITEMS);
});

test("(security) raise answers null for an in-scope id", () => {
  const f = fixture();
  assert.equal(f.raise(PAUSE, pause(OWN_NODE)), null);
});

test("(security) raise answers null for mission.proposal.decide on a P2 assessment", () => {
  const f = fixture();
  const assessment = createIdentity("assessment");
  const input = { params: { assessment_id: assessment }, query: {}, body: {} };
  assert.equal(
    f.raise(missionOperations["proposal.decide"], input, {
      projects: new Map([[assessment, P2]]),
    }),
    null,
  );
});

test("(security) raise answers null for mission.node.create on a P2 mission", () => {
  const f = fixture();
  const mission = createIdentity("mission");
  const input = { params: { mission_id: mission }, query: {}, body: {} };
  assert.equal(
    f.raise(missionOperations["node.create"], input, {
      projects: new Map([[mission, P2]]),
    }),
    null,
  );
});

test("(security) raise answers null for mission.node.unblock with change and raises it without", () => {
  const f = fixture();
  const node = f.foreignNode();
  assert.equal(
    f.raise(UNBLOCK, unblock(node, { ...UNBLOCK_BODY, change: {} })),
    null,
  );
  assert.ok(f.raise(UNBLOCK, unblock(node, UNBLOCK_BODY)));
});

test("(security) limit: an eleventh open request of one invite is dropped", () => {
  const f = fixture();
  for (let index = NO_ITEMS; index < WORKBENCH_SCOPE_REQUEST_LIMIT; index++)
    assert.ok(f.raise(PAUSE, pause(f.foreignNode())));
  assert.equal(f.raise(PAUSE, pause(f.foreignNode())), null);
  assert.equal(f.requests.count(SESSION), WORKBENCH_SCOPE_REQUEST_LIMIT);
  const otherInvite = createIdentity("workbench_invite");
  assert.ok(f.raise(PAUSE, pause(f.foreignNode()), { inviteId: otherInvite }));
});

test("(invariant) repeat: an equal act gives one request while open and for 24 hours after approve or reject", () => {
  const f = fixture();
  const node = f.foreignNode();
  const first = f.raise(PAUSE, pause(node));
  assert.ok(first);
  assert.equal(f.raise(PAUSE, pause(node)), null);
  assert.equal(
    f.raise(PAUSE, pause(node, { ...HUMAN_ACT, expected_mission_version: 2 })),
    null,
  );
  assert.equal(f.requests.count(SESSION), ONE_ITEM);
  assert.ok(f.requests.reject(SESSION, first.id));
  assert.equal(f.raise(PAUSE, pause(node)), null);
  f.clock.now += WORKBENCH_SCOPE_REQUEST_REPEAT_MS - ONE_ITEM;
  assert.equal(f.raise(PAUSE, pause(node)), null);
  f.clock.now += ONE_ITEM;
  const again = f.raise(PAUSE, pause(node));
  assert.ok(again);
  const claimed = f.requests.claim(SESSION, again.id);
  assert.ok(claimed);
  f.requests.settle(claimed);
  assert.equal(f.raise(PAUSE, pause(node)), null);
  f.clock.now += WORKBENCH_SCOPE_REQUEST_REPEAT_MS;
  assert.ok(f.raise(PAUSE, pause(node)));
});

test("(security) lifetime: open and count show no request after inviteExpiresAt", () => {
  const f = fixture();
  assert.ok(f.raise(PAUSE, pause(f.foreignNode())));
  assert.equal(f.requests.count(SESSION), ONE_ITEM);
  f.clock.now += INVITE_LIFETIME_MS;
  assert.deepEqual(f.requests.open(SESSION), []);
  assert.equal(f.requests.count(SESSION), NO_ITEMS);
});

test("(invariant) a release after dropInvite does not bring the request back", () => {
  const f = fixture();
  const request = f.raise(PAUSE, pause(f.foreignNode()));
  assert.ok(request);
  const claimed = f.requests.claim(SESSION, request.id);
  assert.ok(claimed);
  f.requests.dropInvite(INVITE);
  f.requests.release(claimed, CONFLICT_CODE);
  assert.deepEqual(f.requests.open(SESSION), []);
});

test("a release after a claim brings the request back open with the error code", () => {
  const f = fixture();
  const request = f.raise(PAUSE, pause(f.foreignNode()));
  assert.ok(request);
  const claimed = f.requests.claim(SESSION, request.id);
  assert.ok(claimed);
  f.requests.release(claimed, CONFLICT_CODE);
  assert.equal(f.requests.open(SESSION)[NO_ITEMS]?.error, CONFLICT_CODE);
  assert.equal(
    f.requests.open(SESSION)[NO_ITEMS]?.state,
    ScopeRequestState.Open,
  );
});

test("(invariant) claim of a claimed request answers null", () => {
  const f = fixture();
  const request = f.raise(PAUSE, pause(f.foreignNode()));
  assert.ok(request);
  assert.ok(f.requests.claim(SESSION, request.id));
  assert.equal(f.requests.claim(SESSION, request.id), null);
  assert.equal(
    f.requests.claim(SESSION, createIdentity("workbench_scope_request")),
    null,
  );
  assert.equal(f.requests.reject(SESSION, request.id), null);
});

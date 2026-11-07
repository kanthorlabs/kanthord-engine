import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssetKind,
  Disposition,
  EndState,
  type ExternalLink,
  ExternalLinkKind,
  Intent,
  MISSION_SERVICE_NAME,
  NodeState,
  type PlatformAddress,
  PlatformAddressKind,
  RevisionWrite,
  StartPoint,
} from "./contract.ts";
import {
  linkDemandCount,
  MatchKind,
  matchRequests,
  TERMINAL_LINK_DEMAND_MS,
  unresolvedRequestCount,
} from "./delivery-match.ts";
import { missionMigrations } from "./migrations.ts";
import { closeAttempt, insertEvidence, openAttempt } from "./record-store.ts";
import {
  insertMission,
  insertNode,
  insertRevision,
  readNode,
  setNodeState,
} from "./store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const NOW = 100;
const FIRST_REVISION = 1;
const FIRST_ATTEMPT = 1;
const REQUIREMENT_KEY = "gated.pull_request";
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const ADDRESS = {
  kind: PlatformAddressKind.PullRequest,
  resource_identity: "repository:github:owner/gated",
  number: 7,
} as const satisfies PlatformAddress;
const OTHER_ADDRESS: PlatformAddress = { ...ADDRESS, number: 8 };

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  const projectId = createIdentity("project");
  const otherProjectId = createIdentity("project");
  const missions = store.transaction((tx) => ({
    [projectId]: insertMission(tx, projectId, NOW),
    [otherProjectId]: insertMission(tx, otherProjectId, NOW),
  }));
  const node = (project: string) =>
    store.transaction((tx) => {
      const id = createIdentity("node");
      insertNode(tx, {
        id,
        mission_id: missions[project]!,
        filename: `${id}.md`,
        created_at: NOW,
      });
      openAttempt(tx, id, FIRST_REVISION, ACTOR, NOW);
      return id;
    });
  const request = (
    nodeId: string,
    address: PlatformAddress,
    endState: EndState | null = null,
  ) =>
    store.transaction((tx) => {
      const id = createIdentity("evidence");
      insertEvidence(
        tx,
        {
          id,
          node_id: nodeId,
          attempt: FIRST_ATTEMPT,
          subject: REQUIREMENT_KEY,
          requirement_key: REQUIREMENT_KEY,
          end_state: endState,
          verification: null,
          provenance: canonicalJSON({
            kind: ActorKind.Service,
            service: ActorService.Mission,
          }),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("asset"),
            evidence_id: id,
            kind: AssetKind.Platform,
            content: canonicalJSON(address),
            published_at: NOW,
            expired_at: null,
          },
        ],
      );
      return id;
    });
  const close = (nodeId: string) =>
    store.transaction((tx) => closeAttempt(tx, nodeId, FIRST_ATTEMPT, NOW));
  const match = (address: PlatformAddress, project = projectId) =>
    store.transaction((tx) => matchRequests(tx, project, address));
  const restart = (nodeId: string) =>
    store.transaction((tx) =>
      openAttempt(
        tx,
        nodeId,
        FIRST_REVISION,
        ACTOR,
        NOW,
        StartPoint.BaseBranch,
      ),
    );
  const snapshot = (nodeId: string) =>
    store.transaction((tx) => ({
      node: readNode(tx, nodeId),
      attempts: tx.database
        .prepare("SELECT * FROM mission_attempt WHERE node_id = ?")
        .all(nodeId),
    }));
  return {
    store,
    missions,
    projectId,
    otherProjectId,
    node,
    request,
    close,
    match,
    restart,
    snapshot,
  };
}

const unmatched = {
  kind: MatchKind.Answer,
  answer: {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  },
};

test("a request of an open attempt matches its address", (t) => {
  const h = fixture(t);
  const evidenceId = h.request(h.node(h.projectId), ADDRESS);
  h.request(h.node(h.projectId), OTHER_ADDRESS);
  assert.deepEqual(h.match(ADDRESS), {
    kind: MatchKind.Request,
    evidence_id: evidenceId,
  });
});

test("a request of a closed attempt with no end state does not match", (t) => {
  const h = fixture(t);
  const nodeId = h.node(h.projectId);
  h.request(nodeId, ADDRESS);
  h.close(nodeId);
  assert.deepEqual(h.match(ADDRESS), unmatched);
});

test("two open attempts of two nodes with one address refuse as ambiguous", (t) => {
  const h = fixture(t);
  h.request(h.node(h.projectId), ADDRESS);
  h.request(h.node(h.projectId), ADDRESS);
  assert.deepEqual(h.match(ADDRESS), {
    kind: MatchKind.Answer,
    answer: {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Ambiguous,
    },
  });
});

test("a resolved request answers duplicate", (t) => {
  const h = fixture(t);
  const nodeId = h.node(h.projectId);
  h.request(nodeId, ADDRESS, EndState.Expected);
  h.close(nodeId);
  assert.deepEqual(h.match(ADDRESS), {
    kind: MatchKind.Answer,
    answer: { disposition: Disposition.Duplicate, reason: null },
  });
});

test("one unresolved match takes priority over a resolved match", (t) => {
  const h = fixture(t);
  const resolved = h.node(h.projectId);
  h.request(resolved, ADDRESS, EndState.Other);
  h.close(resolved);
  const evidenceId = h.request(h.node(h.projectId), ADDRESS);
  assert.deepEqual(h.match(ADDRESS), {
    kind: MatchKind.Request,
    evidence_id: evidenceId,
  });
});

test("a request of another project never matches", (t) => {
  const h = fixture(t);
  h.request(h.node(h.otherProjectId), ADDRESS);
  const resolved = h.node(h.otherProjectId);
  h.request(resolved, ADDRESS, EndState.Expected);
  assert.deepEqual(h.match(ADDRESS), unmatched);
});

test("a reordered JSON member still matches", (t) => {
  const h = fixture(t);
  const evidenceId = h.request(h.node(h.projectId), ADDRESS);
  const reordered: PlatformAddress = {
    number: ADDRESS.number,
    resource_identity: ADDRESS.resource_identity,
    kind: ADDRESS.kind,
  };
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(ADDRESS));
  assert.deepEqual(h.match(reordered), {
    kind: MatchKind.Request,
    evidence_id: evidenceId,
  });
});

test("after a restart from the base branch, an event for the earlier pull request changes no state", (t) => {
  const h = fixture(t);
  const open = h.node(h.projectId);
  h.request(open, ADDRESS);
  h.close(open);
  assert.equal(h.restart(open).start_point, StartPoint.BaseBranch);
  const resolved = h.node(h.projectId);
  h.request(resolved, OTHER_ADDRESS, EndState.Other);
  h.close(resolved);
  h.restart(resolved);
  const before = [h.snapshot(open), h.snapshot(resolved)];
  assert.deepEqual(h.match(ADDRESS), unmatched);
  assert.deepEqual(h.match(OTHER_ADDRESS), {
    kind: MatchKind.Answer,
    answer: { disposition: Disposition.Duplicate, reason: null },
  });
  assert.deepEqual([h.snapshot(open), h.snapshot(resolved)], before);
});

const DAY_MS = 86400000;
const WITHIN_WINDOW_DAYS = 13;
const OUTSIDE_WINDOW_DAYS = 15;
const SINGLE_LINK = 1;
const TWO_LINKS = 2;
const NO_LINKS = 0;
const LINK_RESOURCE = "conversation:github:acme/app";
const OTHER_LINK_RESOURCE = "conversation:github:acme/other";
const FIRST_NUMBER = 1;
const SECOND_NUMBER = 2;
const NOW_MS = Date.parse("2026-11-07T00:00:00Z");

function linkTo(resource: string, number: number): ExternalLink {
  return {
    kind: ExternalLinkKind.GitHubIssue,
    resource_identity: resource,
    number,
  };
}

function linkFixture(t: TestContext) {
  const h = fixture(t);
  const linked = (
    project: string,
    links: ExternalLink[],
    state: NodeState,
    options: { closedAgoMs?: number; retired?: boolean } = {},
  ) =>
    h.store.transaction((tx) => {
      const id = createIdentity("node");
      insertNode(tx, {
        id,
        mission_id: h.missions[project]!,
        filename: `${id}.md`,
        created_at: NOW,
      });
      insertRevision(tx, {
        node_id: id,
        revision: FIRST_REVISION,
        filename: `${id}.md`,
        reason: "plan",
        actor: ACTOR,
        created_at: NOW,
        content: {
          name: "Name",
          requirement: "Requirement",
          criterion: "Criterion",
          verifications: ["true"],
          bindings: [],
          intent: Intent.Examine,
          tags: [],
          external_links: links,
        },
        tasks: [],
        change: {
          write: RevisionWrite.NodeCreate,
          previous_revision: null,
          changed_fields: [],
        },
        pinned_by_attempts: [],
      });
      if (options.closedAgoMs !== undefined) {
        openAttempt(tx, id, FIRST_REVISION, ACTOR, NOW);
        closeAttempt(tx, id, FIRST_ATTEMPT, NOW_MS - options.closedAgoMs);
      }
      setNodeState(tx, id, state);
      if (options.retired === true)
        tx.database
          .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
          .run(NOW, id);
      return id;
    });
  const demand = (resource = LINK_RESOURCE, project = h.projectId) =>
    h.store.transaction((tx) => linkDemandCount(tx, project, resource, NOW_MS));
  return { ...h, linked, demand };
}

test("link_count counts the links of nodes that are not terminal", (t) => {
  const h = linkFixture(t);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER), linkTo(LINK_RESOURCE, SECOND_NUMBER)],
    NodeState.Available,
  );
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Blocked,
  );
  assert.equal(h.demand(), TWO_LINKS + SINGLE_LINK);
});

for (const state of [NodeState.Completed, NodeState.Discarded] as const) {
  test(`a ${state} node counts 13 days after the close of its last attempt and not 15 days after`, (t) => {
    const h = linkFixture(t);
    h.linked(h.projectId, [linkTo(LINK_RESOURCE, FIRST_NUMBER)], state, {
      closedAgoMs: WITHIN_WINDOW_DAYS * DAY_MS,
    });
    assert.equal(h.demand(), SINGLE_LINK);
    h.linked(h.projectId, [linkTo(LINK_RESOURCE, FIRST_NUMBER)], state, {
      closedAgoMs: OUTSIDE_WINDOW_DAYS * DAY_MS,
    });
    assert.equal(h.demand(), SINGLE_LINK);
  });
}

test("the window of a terminal node ends at TERMINAL_LINK_DEMAND_MS", (t) => {
  const h = linkFixture(t);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Completed,
    { closedAgoMs: TERMINAL_LINK_DEMAND_MS },
  );
  assert.equal(h.demand(), NO_LINKS);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Completed,
    { closedAgoMs: TERMINAL_LINK_DEMAND_MS - 1 },
  );
  assert.equal(h.demand(), SINGLE_LINK);
});

test("a terminal node with no attempt counts nothing", (t) => {
  const h = linkFixture(t);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Discarded,
  );
  assert.equal(h.demand(), NO_LINKS);
});

test("a retired node, a link of another resource and a link of another project count nothing", (t) => {
  const h = linkFixture(t);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Available,
    { retired: true },
  );
  h.linked(
    h.projectId,
    [linkTo(OTHER_LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Available,
  );
  h.linked(
    h.otherProjectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Available,
  );
  assert.equal(h.demand(), NO_LINKS);
  assert.equal(h.demand(OTHER_LINK_RESOURCE), SINGLE_LINK);
});

test("count keeps its value beside link_count", (t) => {
  const h = linkFixture(t);
  const nodeId = h.node(h.projectId);
  h.request(nodeId, ADDRESS);
  h.linked(
    h.projectId,
    [linkTo(LINK_RESOURCE, FIRST_NUMBER)],
    NodeState.Available,
  );
  assert.equal(
    h.store.transaction((tx) =>
      unresolvedRequestCount(tx, h.projectId, ADDRESS.resource_identity),
    ),
    SINGLE_LINK,
  );
  assert.equal(h.demand(ADDRESS.resource_identity), NO_LINKS);
  assert.equal(h.demand(), SINGLE_LINK);
});

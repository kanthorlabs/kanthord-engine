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
  MISSION_SERVICE_NAME,
  NodeKind,
  PlatformAddressKind,
  type PlatformAddress,
} from "./contract.ts";
import { MatchKind, matchRequests } from "./delivery-match.ts";
import { missionMigrations } from "./migrations.ts";
import { closeAttempt, insertEvidence, openAttempt } from "./record-store.ts";
import { insertMission, insertNode } from "./store.ts";

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
  t.after(() => store.close());
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
        kind: NodeKind.Objective,
        filename: `${id}.md`,
        parent_id: null,
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
  return { projectId, otherProjectId, node, request, close, match };
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

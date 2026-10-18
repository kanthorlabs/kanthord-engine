import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  EndState,
  NodeState,
  RepositoryAction,
} from "./contract.ts";
import {
  closureUnsatisfied,
  continuationHolds,
  readinessOf,
} from "./conditions.ts";
import { openAttempt, closeAttempt, insertEvidence } from "./record-store.ts";
import { claimableMap } from "./routing.ts";
import {
  insertMission,
  insertNode,
  insertDependency,
  readNode,
  setNodeState,
} from "./store.ts";
import { missionHarness } from "./test-support.ts";

const NOW = 100;
const FIRST_ATTEMPT = 1;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const REQUEST_KEY = "repo.pull_request";

function fixture(t: TestContext) {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const missionId = h.store.transaction((tx) =>
    insertMission(tx, projectId, NOW),
  );
  function node() {
    return h.store.transaction((tx) => {
      const id = createIdentity("node");
      insertNode(tx, {
        id,
        mission_id: missionId,
        filename: `${id}.md`,
        created_at: NOW,
      });
      return id;
    });
  }
  return { ...h, project_id: projectId, mission_id: missionId, node };
}

test("readiness at attempt zero holds when the closure holds", (t) => {
  const h = fixture(t);
  const examine = h.node();
  const dependency = h.node();
  h.store.transaction((tx) => {
    const dependent = readNode(tx, examine)!;
    assert.deepEqual(readinessOf(tx, dependent), {
      holds: true,
      unsatisfied_ids: [],
    });
    insertDependency(tx, h.mission_id, examine, dependency);
    assert.deepEqual(readinessOf(tx, dependent), {
      holds: false,
      unsatisfied_ids: [dependency],
    });
    setNodeState(tx, dependency, NodeState.Completed);
    assert.equal(readinessOf(tx, dependent).holds, true);
    assert.equal(
      continuationHolds(tx, h.dependencies.bindings, dependent),
      false,
    );
  });
});

test("the dependency closure holds the direct dependencies alone and requires Completed, not Discarded", (t) => {
  const h = fixture(t);
  const first = h.node();
  const second = h.node();
  const third = h.node();
  h.store.transaction((tx) => {
    insertDependency(tx, h.mission_id, first, second);
    insertDependency(tx, h.mission_id, second, third);
    setNodeState(tx, second, NodeState.Discarded);
    assert.deepEqual(closureUnsatisfied(tx, readNode(tx, first)!), [second]);
    setNodeState(tx, second, NodeState.Completed);
    assert.deepEqual(closureUnsatisfied(tx, readNode(tx, first)!), []);
  });
});

test("claimability covers all twelve states, attempt zero and retirement", (t) => {
  const h = fixture(t);
  const id = h.node();
  h.store.transaction((tx) => {
    for (const state of Object.values(NodeState)) {
      setNodeState(tx, id, state);
      assert.equal(
        claimableMap(tx, h.mission_id, h.dependencies.bindings).get(id),
        state === NodeState.Available || state === NodeState.Waiting,
        state,
      );
    }
    setNodeState(tx, id, NodeState.Waiting);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, id);
    assert.equal(
      claimableMap(tx, h.mission_id, h.dependencies.bindings).get(id),
      false,
    );
  });
});

test("open-attempt unresolved actions do not block readiness but stop continuation", (t) => {
  const h = fixture(t);
  const nodeId = h.node();
  const bindingId = createIdentity("binding");
  const bindings = {
    ...h.dependencies.bindings,
    getBindingRevision: () => ({
      binding_id: bindingId,
      project_id: h.project_id,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      disabled: false,
      tombstone: false,
    }),
    repositoryPolicyOf: () => ({
      binding_id: bindingId,
      project_id: h.project_id,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: "main",
      action: RepositoryAction.PullRequest,
      landing: "human" as const,
      project_prompt: null,
    }),
  };
  h.store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, tasks, change, reason, actor, created_at) VALUES (?, 1, 'implement.md', 'name', 'requirement', 'criterion', '[]', ?, 'implement', '[]', '[]', '{}', 'reason', ?, ?)",
      )
      .run(nodeId, canonicalJSON([bindingId]), canonicalJSON(ACTOR), NOW);
    openAttempt(tx, nodeId, FIRST_ATTEMPT, ACTOR, NOW);
    const node = readNode(tx, nodeId)!;
    assert.equal(continuationHolds(tx, bindings, node), true);
    setNodeState(tx, nodeId, NodeState.ExternalRequested);
    assert.equal(claimableMap(tx, h.mission_id, bindings).get(nodeId), true);
    const id = createIdentity("evidence");
    insertEvidence(
      tx,
      {
        id,
        node_id: nodeId,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: REQUEST_KEY,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(ACTOR),
        created_at: NOW,
      },
      [],
    );
    assert.deepEqual(readinessOf(tx, node), {
      holds: true,
      unsatisfied_ids: [],
    });
    assert.equal(continuationHolds(tx, bindings, node), false);
    assert.equal(claimableMap(tx, h.mission_id, bindings).get(nodeId), false);
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(EndState.Expected, id);
    assert.equal(readinessOf(tx, node).holds, true);
    closeAttempt(tx, nodeId, FIRST_ATTEMPT, NOW);
    assert.equal(continuationHolds(tx, bindings, node), false);
  });
});

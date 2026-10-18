import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  ClaimableState,
  NodeState,
  RepositoryAction,
  Intent,
  type MissionBindings,
} from "./contract.ts";
import { actionsOfRevision } from "./frozen-action.ts";
import { openAttempt } from "./record-store.ts";
import {
  insertMission,
  insertNode,
  readClaimRevisions,
  setNodeState,
} from "./store.ts";
import { missionHarness } from "./test-support.ts";

const NOW = 100;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const NO_ACTIONS = 0;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const MACOS = "platform.macos";

function factsHarness(
  t: TestContext,
  overrides: Partial<MissionBindings> = {},
) {
  const projectId = createIdentity("project");
  const pullRequestBinding = createIdentity("binding");
  const bindings: MissionBindings = {
    storageBindingOf: () => assert.fail("Claim facts read no storage."),
    resolveBinding: () => assert.fail("Claim facts resolve no name."),
    resolveBindingIdentity: () =>
      assert.fail("Claim facts resolve no revision."),
    getBindingRevision: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_REVISION,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
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
    ...overrides,
  };
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"), {
    bindings,
  });
  const missionId = h.store.transaction((tx) =>
    insertMission(tx, projectId, NOW),
  );
  function revise(
    tx: Transaction,
    nodeId: string,
    revision: number,
    input: { bindings?: string[]; tags?: string[]; intent?: Intent },
  ) {
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, tasks, change, reason, actor, created_at) VALUES (?, ?, ?, 'name', 'requirement', 'criterion', '[]', ?, ?, ?, '[]', '{}', 'reason', ?, ?)",
      )
      .run(
        nodeId,
        revision,
        `${nodeId}.md`,
        canonicalJSON(input.bindings ?? []),
        input.intent ?? Intent.Implement,
        canonicalJSON(input.tags ?? []),
        canonicalJSON(ACTOR),
        NOW,
      );
  }
  function node(input: {
    bindings?: string[];
    tags?: string[];
    intent?: Intent;
  }) {
    const nodeId = createIdentity("node");
    h.store.transaction((tx) => {
      insertNode(tx, {
        id: nodeId,
        mission_id: missionId,
        filename: `${nodeId}.md`,
        created_at: NOW,
      });
      revise(tx, nodeId, FIRST_REVISION, input);
      setNodeState(tx, nodeId, NodeState.Available);
    });
    return nodeId;
  }
  const facts = (nodeId: string) =>
    h.store.transaction((tx) => h.service.claimFacts(tx, nodeId));
  const factsOf = () =>
    h.store.transaction((tx) => h.service.claimFactsOf(tx, projectId));
  return {
    ...h,
    projectId,
    missionId,
    pullRequestBinding,
    node,
    revise,
    facts,
    factsOf,
  };
}

test("a node with a pull request action claims External.Requested", (t) => {
  const h = factsHarness(t);
  const action = h.node({ bindings: [h.pullRequestBinding] });
  const plain = h.node({ intent: Intent.Examine, tags: [MACOS] });
  const rows = h.factsOf();
  assert.deepEqual(
    rows.find((row) => row.node_id === action),
    {
      node_id: action,
      revision: FIRST_REVISION,
      intent: Intent.Implement,
      tags: [],
      claims: [
        ClaimableState.Available,
        ClaimableState.Waiting,
        ClaimableState.ExternalRequested,
      ],
    },
  );
  assert.deepEqual(
    rows.find((row) => row.node_id === plain),
    {
      node_id: plain,
      revision: FIRST_REVISION,
      intent: Intent.Examine,
      tags: [MACOS],
      claims: [ClaimableState.Available, ClaimableState.Waiting],
    },
  );
  assert.equal(rows.length, [action, plain].length);
  assert.deepEqual(h.facts(plain), { intent: Intent.Examine, tags: [MACOS] });
  assert.deepEqual(h.factsOf(), rows);
});

test("an open attempt adds its pinned revision", (t) => {
  const h = factsHarness(t);
  const nodeId = h.node({ tags: [] });
  h.store.transaction((tx) => {
    openAttempt(tx, nodeId, FIRST_REVISION, ACTOR, NOW);
    h.revise(tx, nodeId, SECOND_REVISION, { tags: [MACOS] });
  });
  assert.deepEqual(
    h.factsOf().map(({ revision, tags }) => ({ revision, tags })),
    [
      { revision: SECOND_REVISION, tags: [MACOS] },
      { revision: FIRST_REVISION, tags: [] },
    ],
  );
  assert.deepEqual(h.facts(nodeId), { intent: Intent.Implement, tags: [] });
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_attempt SET closed_at = ? WHERE node_id = ?")
      .run(NOW, nodeId),
  );
  assert.deepEqual(
    h.factsOf().map(({ revision }) => revision),
    [SECOND_REVISION],
  );
  assert.deepEqual(h.facts(nodeId), {
    intent: Intent.Implement,
    tags: [MACOS],
  });
});

test("a terminal node answers no row", (t) => {
  const h = factsHarness(t);
  const completed = h.node({});
  const discarded = h.node({});
  const retired = h.node({});
  h.store.transaction((tx) => {
    setNodeState(tx, completed, NodeState.Completed);
    setNodeState(tx, discarded, NodeState.Discarded);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, retired);
  });
  assert.deepEqual(h.factsOf(), []);
  for (const nodeId of [completed, discarded, retired, createIdentity("node")])
    assert.equal(h.facts(nodeId), null);
  assert.deepEqual(
    h.store.transaction((tx) =>
      h.service.claimFactsOf(tx, createIdentity("project")),
    ),
    [],
  );
  assert.deepEqual(
    h.calls.filter(({ method }) => !method.startsWith("bindings.")),
    [],
  );
});

test("claimFactsOf reads each binding once per call", (t) => {
  const revisionCalls: string[] = [];
  const policyCalls: string[] = [];
  const fixtures = factsHarness(t);
  const h = factsHarness(t, {
    getBindingRevision: (tx, bindingId) => {
      revisionCalls.push(bindingId);
      return fixtures.dependencies.bindings.getBindingRevision(tx, bindingId);
    },
    repositoryPolicyOf: (tx, bindingId) => {
      policyCalls.push(bindingId);
      return fixtures.dependencies.bindings.repositoryPolicyOf(tx, bindingId);
    },
  });
  const nodes = [
    h.node({ bindings: [h.pullRequestBinding] }),
    h.node({ bindings: [h.pullRequestBinding] }),
    h.node({ bindings: [h.pullRequestBinding] }),
  ];
  assert.equal(h.factsOf().length, nodes.length);
  assert.deepEqual(revisionCalls, [h.pullRequestBinding]);
  assert.deepEqual(policyCalls, [h.pullRequestBinding]);
  assert.equal(h.factsOf().length, nodes.length);
  assert.deepEqual(revisionCalls, [h.pullRequestBinding, h.pullRequestBinding]);
  assert.deepEqual(policyCalls, [h.pullRequestBinding, h.pullRequestBinding]);
});

test("claimFactsOf answers the same rows with the binding map", (t) => {
  const withoutActionBinding = createIdentity("binding");
  const fixtures = factsHarness(t);
  const h = factsHarness(t, {
    repositoryPolicyOf: (tx, bindingId) => {
      const policy = fixtures.dependencies.bindings.repositoryPolicyOf(
        tx,
        bindingId,
      );
      return policy && bindingId === withoutActionBinding
        ? { ...policy, action: null }
        : policy;
    },
  });
  const examine = h.node({
    intent: Intent.Examine,
    bindings: [h.pullRequestBinding],
  });
  const withAction = h.node({ bindings: [h.pullRequestBinding] });
  const withoutAction = h.node({ bindings: [withoutActionBinding] });
  const withTwo = h.node({
    bindings: [withoutActionBinding, h.pullRequestBinding],
  });
  const bindings = h.dependencies.bindings;
  const expected = h.store.transaction((tx) =>
    readClaimRevisions(tx, h.missionId).map((revision) => [
      revision.node_id,
      actionsOfRevision(tx, bindings, revision).length > NO_ACTIONS,
    ]),
  );
  assert.deepEqual(
    Object.fromEntries(expected),
    Object.fromEntries([
      [examine, false],
      [withAction, true],
      [withoutAction, false],
      [withTwo, true],
    ]),
  );
  assert.deepEqual(
    h
      .factsOf()
      .map(({ node_id, claims }) => [
        node_id,
        claims.includes(ClaimableState.ExternalRequested),
      ]),
    expected,
  );
});

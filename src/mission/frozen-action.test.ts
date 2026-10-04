import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  EndState,
  ExpectedEndState,
  NodeKind,
  RepositoryAction,
  Resolution,
  type MissionBindings,
} from "./contract.ts";
import {
  actionStatesOf,
  eligibleUnrequested,
  requiredActionsOf,
  unresolvedKeys,
  type ActionState,
} from "./frozen-action.ts";
import { openAttempt, insertEvidence } from "./record-store.ts";
import { insertMission, insertNode } from "./store.ts";
import { missionHarness } from "./test-support.ts";

const FIRST = 1;
const SECOND = 2;
const NOW = 100;
const BASE_BRANCH = "main";
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const REQUEST_KEY = "repo.pull_request";

test("required actions preserve pinned policies across later revisions and omit initiatives", (t) => {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const oldBinding = createIdentity("binding");
  const newBinding = createIdentity("binding");
  const policies = new Map([
    [
      oldBinding,
      {
        bindingId: oldBinding,
        projectId,
        name: "repo",
        address: "git@github.com:owner/repo.git",
        platform: "github",
        credential: "github",
        baseBranch: BASE_BRANCH,
        action: RepositoryAction.PullRequest,
        projectPrompt: null,
      },
    ],
    [
      newBinding,
      {
        bindingId: newBinding,
        projectId,
        name: "repo",
        address: "git@github.com:owner/repo.git",
        platform: "github",
        credential: "github",
        baseBranch: "develop",
        action: RepositoryAction.MergePush,
        projectPrompt: null,
      },
    ],
  ]);
  const bindings: MissionBindings = {
    storageBindingOf: () =>
      assert.fail("Actions do not read storage configuration."),
    resolveBinding: () =>
      assert.fail("Pinned reads never resolve the latest name."),
    resolveBindingIdentity: () =>
      assert.fail("Pinned reads never resolve the latest revision."),
    getBindingRevision: (_tx, bindingId) => ({
      bindingId,
      projectId,
      name: "repo",
      resourceIdentity: "repository:github:owner/repo",
      revision: FIRST,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: (_tx, bindingId) => policies.get(bindingId) ?? null,
  };
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    const nodeId = createIdentity("node");
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: null,
      created_at: NOW,
    });
    const statement = tx.database.prepare(
      "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, change, reason, actor, created_at) VALUES (?, ?, 'objective.md', 'name', 'requirement', 'criterion', '[]', ?, '{}', 'reason', ?, ?)",
    );
    statement.run(
      nodeId,
      FIRST,
      canonicalJSON([oldBinding]),
      canonicalJSON(ACTOR),
      NOW,
    );
    openAttempt(tx, nodeId, FIRST, ACTOR, NOW);
    statement.run(
      nodeId,
      SECOND,
      canonicalJSON([newBinding]),
      canonicalJSON(ACTOR),
      NOW,
    );
    const expected = {
      key: REQUEST_KEY,
      bindingId: oldBinding,
      action: RepositoryAction.PullRequest,
      expectedEndState: ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { baseBranch: BASE_BRANCH },
    };
    assert.deepEqual(requiredActionsOf(tx, bindings, nodeId, FIRST), [
      expected,
    ]);
    assert.equal(
      requiredActionsOf(tx, bindings, nodeId, SECOND)[0]?.expectedEndState,
      ExpectedEndState.BaseBranchPushed,
    );
    assert.deepEqual(actionStatesOf(tx, bindings, nodeId, FIRST), [
      { action: expected, request: null, resolution: Resolution.Unrequested },
    ]);
    const requestId = createIdentity("evidence");
    insertEvidence(
      tx,
      {
        id: requestId,
        node_id: nodeId,
        attempt: FIRST,
        subject: "Request",
        requirement_key: REQUEST_KEY,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(ACTOR),
        created_at: NOW,
      },
      [],
    );
    const unresolved = actionStatesOf(tx, bindings, nodeId, FIRST);
    assert.equal(unresolved[0]?.resolution, Resolution.Unresolved);
    assert.deepEqual(unresolvedKeys(unresolved), [REQUEST_KEY]);
    assert.deepEqual(eligibleUnrequested(unresolved), []);
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(EndState.Expected, requestId);
    assert.equal(
      actionStatesOf(tx, bindings, nodeId, FIRST)[0]?.resolution,
      Resolution.ExpectedEnd,
    );
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(EndState.Other, requestId);
    assert.equal(
      actionStatesOf(tx, bindings, nodeId, FIRST)[0]?.resolution,
      Resolution.OtherEnd,
    );
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(NodeKind.Initiative, nodeId);
    assert.deepEqual(requiredActionsOf(tx, bindings, nodeId, FIRST), []);
  });
});

test("eligibility requires a satisfied predecessor and an unrequested action", () => {
  const first: ActionState = {
    action: {
      key: REQUEST_KEY,
      bindingId: createIdentity("binding"),
      action: RepositoryAction.PullRequest,
      expectedEndState: ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { baseBranch: BASE_BRANCH },
    },
    request: null,
    resolution: Resolution.Unrequested,
  };
  const second = {
    ...first,
    action: {
      ...first.action,
      key: "next.pull_request",
      follows: first.action.key,
    },
  };
  assert.deepEqual(eligibleUnrequested([first, second]), [first]);
  assert.deepEqual(
    eligibleUnrequested([
      { ...first, resolution: Resolution.ExpectedEnd },
      second,
    ]),
    [second],
  );
  assert.deepEqual(
    eligibleUnrequested([
      { ...first, resolution: Resolution.OtherEnd },
      second,
    ]),
    [],
  );
  assert.deepEqual(unresolvedKeys([first, second]), []);
});

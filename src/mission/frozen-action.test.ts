import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  type ExternalLink,
  ExternalLinkKind,
} from "../kernel/external-link.ts";
import {
  actionKeySchema,
  ActorKind,
  ConversationAction,
  EndState,
  ExpectedEndState,
  Intent,
  type MissionBindings,
  RepositoryAction,
  Resolution,
} from "./contract.ts";
import {
  actionsOfRevision,
  type ActionState,
  actionStatesOf,
  eligibleUnrequested,
  requiredActionsOf,
  unresolvedKeys,
} from "./frozen-action.ts";
import { insertEvidence, openAttempt } from "./record-store.ts";
import { insertMission, insertNode, readRevision } from "./store.ts";
import { missionHarness } from "./test-support.ts";

const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NOW = 100;
const BASE_BRANCH = "main";
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const REQUEST_KEY = "repo.pull_request";

test("an examine node with a repository binding requires no external action, and required actions preserve pinned policies across later revisions", (t) => {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const oldBinding = createIdentity("binding");
  const newBinding = createIdentity("binding");
  const policies = new Map([
    [
      oldBinding,
      {
        binding_id: oldBinding,
        project_id: projectId,
        name: "repo",
        address: "git@github.com:owner/repo.git",
        platform: "github",
        ssh_credential: "github-ssh",
        credential: "github",
        base_branch: BASE_BRANCH,
        action: RepositoryAction.PullRequest,
        landing: "human" as const,
      },
    ],
    [
      newBinding,
      {
        binding_id: newBinding,
        project_id: projectId,
        name: "repo",
        address: "git@github.com:owner/repo.git",
        platform: "github",
        ssh_credential: "github-ssh",
        credential: "github",
        base_branch: "develop",
        action: RepositoryAction.Push,
        landing: "human" as const,
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
    conversationInboxOf: () => assert.fail("Pinned reads never read an inbox."),
    getBindingRevision: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: (_tx, bindingId) => policies.get(bindingId) ?? null,
    conversationPolicyOf: () =>
      assert.fail("A repository binding has no conversation policy."),
  };
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    const nodeId = createIdentity("node");
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      filename: "implement.md",
      created_at: NOW,
    });
    const statement = tx.database.prepare(
      "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, external_links, tasks, change, reason, actor, created_at) VALUES (?, ?, 'implement.md', 'name', 'requirement', 'criterion', '[]', ?, 'implement', '[]', '[]', '[]', '{}', 'reason', ?, ?)",
    );
    statement.run(
      nodeId,
      FIRST_ATTEMPT,
      canonicalJSON([oldBinding]),
      canonicalJSON(ACTOR),
      NOW,
    );
    openAttempt(tx, nodeId, FIRST_ATTEMPT, ACTOR, NOW);
    statement.run(
      nodeId,
      SECOND_ATTEMPT,
      canonicalJSON([newBinding]),
      canonicalJSON(ACTOR),
      NOW,
    );
    const expected = {
      key: REQUEST_KEY,
      binding_id: oldBinding,
      action: RepositoryAction.PullRequest,
      expected_end_state: ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { base_branch: BASE_BRANCH, landing: "human" },
    };
    assert.deepEqual(requiredActionsOf(tx, bindings, nodeId, FIRST_ATTEMPT), [
      expected,
    ]);
    assert.equal(
      requiredActionsOf(tx, bindings, nodeId, SECOND_ATTEMPT)[0]
        ?.expected_end_state,
      ExpectedEndState.BaseBranchPushed,
    );
    assert.deepEqual(actionStatesOf(tx, bindings, nodeId, FIRST_ATTEMPT), [
      { action: expected, request: null, resolution: Resolution.Unrequested },
    ]);
    const requestId = createIdentity("evidence");
    insertEvidence(
      tx,
      {
        id: requestId,
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
    const unresolved = actionStatesOf(tx, bindings, nodeId, FIRST_ATTEMPT);
    assert.equal(unresolved[0]?.resolution, Resolution.Unresolved);
    assert.deepEqual(unresolvedKeys(unresolved), [REQUEST_KEY]);
    assert.deepEqual(eligibleUnrequested(unresolved), []);
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(EndState.Expected, requestId);
    assert.equal(
      actionStatesOf(tx, bindings, nodeId, FIRST_ATTEMPT)[0]?.resolution,
      Resolution.ExpectedEnd,
    );
    tx.database
      .prepare("UPDATE mission_evidence SET end_state = ? WHERE id = ?")
      .run(EndState.Other, requestId);
    assert.equal(
      actionStatesOf(tx, bindings, nodeId, FIRST_ATTEMPT)[0]?.resolution,
      Resolution.OtherEnd,
    );
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Examine, nodeId);
    assert.deepEqual(
      requiredActionsOf(tx, bindings, nodeId, FIRST_ATTEMPT),
      [],
    );
  });
});

test("eligibility requires a satisfied predecessor and an unrequested action", () => {
  const first: ActionState = {
    action: {
      key: REQUEST_KEY,
      binding_id: createIdentity("binding"),
      action: RepositoryAction.PullRequest,
      expected_end_state: ExpectedEndState.PullRequestMerged,
      follows: null,
      configuration: { base_branch: BASE_BRANCH, landing: "human" },
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

test("two bindings freeze one action each", (t) => {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const appId = createIdentity("binding");
  const apiId = createIdentity("binding");
  const names = new Map([
    [appId, "app"],
    [apiId, "api"],
  ]);
  const bindings: MissionBindings = {
    storageBindingOf: () =>
      assert.fail("Actions do not read storage configuration."),
    resolveBinding: () =>
      assert.fail("Pinned reads never resolve the latest name."),
    resolveBindingIdentity: () =>
      assert.fail("Pinned reads never resolve the latest revision."),
    conversationInboxOf: () => assert.fail("Pinned reads never read an inbox."),
    getBindingRevision: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: names.get(bindingId)!,
      resource_identity: `repository:github:owner/${names.get(bindingId)}`,
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    conversationPolicyOf: () =>
      assert.fail("A repository binding has no conversation policy."),
    repositoryPolicyOf: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: names.get(bindingId)!,
      address: `git@github.com:owner/${names.get(bindingId)}.git`,
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: BASE_BRANCH,
      action:
        bindingId === appId
          ? RepositoryAction.PullRequest
          : RepositoryAction.Push,
      landing: "human" as const,
    }),
  };
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    const nodeId = createIdentity("node");
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      filename: "implement.md",
      created_at: NOW,
    });
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, external_links, tasks, change, reason, actor, created_at) VALUES (?, ?, 'implement.md', 'name', 'requirement', 'criterion', '[]', ?, 'implement', '[]', '[]', '[]', '{}', 'reason', ?, ?)",
      )
      .run(
        nodeId,
        FIRST_ATTEMPT,
        canonicalJSON([appId, apiId]),
        canonicalJSON(ACTOR),
        NOW,
      );
    openAttempt(tx, nodeId, FIRST_ATTEMPT, ACTOR, NOW);
    const actions = requiredActionsOf(tx, bindings, nodeId, FIRST_ATTEMPT);
    assert.deepEqual(
      actions.map((action) => [action.key, action.binding_id, action.follows]),
      [
        ["api.push", apiId, null],
        ["app.pull_request", appId, null],
      ],
    );
    assert.deepEqual(
      eligibleUnrequested(
        actionStatesOf(tx, bindings, nodeId, FIRST_ATTEMPT),
      ).map((state) => state.action.key),
      ["api.push", "app.pull_request"],
    );
  });
});

test("actionsOfRevision with a shared map answers the actions of a new map", (t) => {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const appId = createIdentity("binding");
  const apiId = createIdentity("binding");
  const names = new Map([
    [appId, "app"],
    [apiId, "api"],
  ]);
  const bindings: MissionBindings = {
    storageBindingOf: () =>
      assert.fail("Actions do not read storage configuration."),
    resolveBinding: () =>
      assert.fail("Pinned reads never resolve the latest name."),
    resolveBindingIdentity: () =>
      assert.fail("Pinned reads never resolve the latest revision."),
    conversationInboxOf: () => assert.fail("Pinned reads never read an inbox."),
    getBindingRevision: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: names.get(bindingId)!,
      resource_identity: `repository:github:owner/${names.get(bindingId)}`,
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    conversationPolicyOf: () =>
      assert.fail("A repository binding has no conversation policy."),
    repositoryPolicyOf: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: names.get(bindingId)!,
      address: `git@github.com:owner/${names.get(bindingId)}.git`,
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: BASE_BRANCH,
      action:
        bindingId === appId
          ? RepositoryAction.PullRequest
          : RepositoryAction.Push,
      landing: "human" as const,
    }),
  };
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    const nodeId = createIdentity("node");
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      filename: "implement.md",
      created_at: NOW,
    });
    const statement = tx.database.prepare(
      "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, external_links, tasks, change, reason, actor, created_at) VALUES (?, ?, 'implement.md', 'name', 'requirement', 'criterion', '[]', ?, 'implement', '[]', '[]', '[]', '{}', 'reason', ?, ?)",
    );
    statement.run(
      nodeId,
      FIRST_ATTEMPT,
      canonicalJSON([appId, apiId]),
      canonicalJSON(ACTOR),
      NOW,
    );
    statement.run(
      nodeId,
      SECOND_ATTEMPT,
      canonicalJSON([apiId]),
      canonicalJSON(ACTOR),
      NOW,
    );
    const first = readRevision(tx, nodeId, FIRST_ATTEMPT);
    const second = readRevision(tx, nodeId, SECOND_ATTEMPT);
    assert.ok(first && second);
    const shared = new Map();
    const fromShared = [first, second].map((revision) =>
      actionsOfRevision(tx, bindings, revision, shared),
    );
    const fromNew = [first, second].map((revision) =>
      actionsOfRevision(tx, bindings, revision),
    );
    assert.deepEqual(fromShared, fromNew);
    assert.deepEqual(
      fromShared.map((actions) => actions.map((action) => action.key)),
      [["api.push", "app.pull_request"], ["api.push"]],
    );
    assert.equal(shared.size, names.size);
  });
});

const CONVERSATION_NAME = "conversation";
const CONVERSATION_RESOURCE = "conversation:github:owner/repo";
const OTHER_CONVERSATION_RESOURCE = "conversation:github:owner/other";
const FIRST_LINK_NUMBER = 7;
const SECOND_LINK_NUMBER = 8;
const TWO_DIGIT_POSITION_KEY = `${CONVERSATION_NAME}.reply.10`;

function linkTo(resourceIdentity: string, number: number): ExternalLink {
  return {
    kind: ExternalLinkKind.GitHubIssue,
    resource_identity: resourceIdentity,
    number,
  };
}

function replyHarness(
  t: TestContext,
  options: {
    replyPolicy: boolean;
    links: ExternalLink[];
    intent?: Intent;
    resource?: string;
    platform?: string;
  },
) {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const projectId = createIdentity("project");
  const conversationId = createIdentity("binding");
  const bindings: MissionBindings = {
    storageBindingOf: () =>
      assert.fail("Actions do not read storage configuration."),
    resolveBinding: () =>
      assert.fail("Pinned reads never resolve the latest name."),
    resolveBindingIdentity: () =>
      assert.fail("Pinned reads never resolve the latest revision."),
    conversationInboxOf: () => assert.fail("Pinned reads never read an inbox."),
    getBindingRevision: (_tx, bindingId) => ({
      binding_id: bindingId,
      project_id: projectId,
      name: CONVERSATION_NAME,
      resource_identity: options.resource ?? CONVERSATION_RESOURCE,
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: () =>
      assert.fail("A conversation binding has no repository policy."),
    conversationPolicyOf: (_tx, bindingId) =>
      options.replyPolicy
        ? {
            binding_id: bindingId,
            project_id: projectId,
            name: CONVERSATION_NAME,
            key: `${CONVERSATION_NAME}.${ConversationAction.Reply}`,
            platform: options.platform ?? "github",
            repository: "owner/repo",
            credential: "github",
            action: ConversationAction.Reply,
          }
        : null,
  };
  const nodeId = createIdentity("node");
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      filename: "implement.md",
      created_at: NOW,
    });
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, external_links, tasks, change, reason, actor, created_at) VALUES (?, ?, 'implement.md', 'name', 'requirement', 'criterion', '[]', ?, ?, '[]', ?, '[]', '{}', 'reason', ?, ?)",
      )
      .run(
        nodeId,
        FIRST_ATTEMPT,
        canonicalJSON([conversationId]),
        options.intent ?? Intent.Implement,
        canonicalJSON(options.links),
        canonicalJSON(ACTOR),
        NOW,
      );
    openAttempt(tx, nodeId, FIRST_ATTEMPT, ACTOR, NOW);
  });
  return {
    actions: () =>
      h.store.transaction((tx) =>
        requiredActionsOf(tx, bindings, nodeId, FIRST_ATTEMPT),
      ),
    conversationId,
  };
}

test("an implement revision with two links of a conversation binding with a reply policy freezes one reply action for each link", (t) => {
  const first = linkTo(CONVERSATION_RESOURCE, FIRST_LINK_NUMBER);
  const second = linkTo(CONVERSATION_RESOURCE, SECOND_LINK_NUMBER);
  const h = replyHarness(t, { replyPolicy: true, links: [first, second] });
  const actions = h.actions();
  assert.deepEqual(actions, [
    {
      key: `${CONVERSATION_NAME}.reply.0`,
      binding_id: h.conversationId,
      action: ConversationAction.Reply,
      expected_end_state: ExpectedEndState.Posted,
      follows: null,
      configuration: { external_link: first },
    },
    {
      key: `${CONVERSATION_NAME}.reply.1`,
      binding_id: h.conversationId,
      action: ConversationAction.Reply,
      expected_end_state: ExpectedEndState.Posted,
      follows: null,
      configuration: { external_link: second },
    },
  ]);
  for (const action of actions)
    assert.ok(actionKeySchema.safeParse(action.key).success);
  assert.equal(
    actionKeySchema.safeParse(TWO_DIGIT_POSITION_KEY).success,
    false,
  );
});

test("a reply action keeps the position of its link in external_links", (t) => {
  const other = linkTo(OTHER_CONVERSATION_RESOURCE, FIRST_LINK_NUMBER);
  const own = linkTo(CONVERSATION_RESOURCE, SECOND_LINK_NUMBER);
  const h = replyHarness(t, { replyPolicy: true, links: [other, own] });
  assert.deepEqual(
    h.actions().map((action) => [action.key, action.configuration]),
    [[`${CONVERSATION_NAME}.reply.1`, { external_link: own }]],
  );
});

test("a conversation binding without a reply policy, an examine revision and a link of another binding derive no reply action", (t) => {
  const own = linkTo(CONVERSATION_RESOURCE, FIRST_LINK_NUMBER);
  const other = linkTo(OTHER_CONVERSATION_RESOURCE, FIRST_LINK_NUMBER);
  const cases = [
    { replyPolicy: false, links: [own] },
    { replyPolicy: true, links: [own], intent: Intent.Examine },
    { replyPolicy: true, links: [other] },
    { replyPolicy: true, links: [] },
  ];
  for (const options of cases)
    assert.deepEqual(replyHarness(t, options).actions(), []);
});

const JIRA_RESOURCE_IDENTITY = "conversation:jira:acme.atlassian.net/KD";
const OTHER_JIRA_RESOURCE_IDENTITY = "conversation:jira:acme.atlassian.net/OPS";

function jiraLinkTo(resourceIdentity: string, key: string): ExternalLink {
  return {
    kind: ExternalLinkKind.JiraIssue,
    resource_identity: resourceIdentity,
    key,
  };
}

test("a jira binding with a reply policy freezes one reply action for each jira_issue link", (t) => {
  const first = jiraLinkTo(JIRA_RESOURCE_IDENTITY, "KD-1");
  const other = jiraLinkTo(OTHER_JIRA_RESOURCE_IDENTITY, "OPS-1");
  const second = jiraLinkTo(JIRA_RESOURCE_IDENTITY, "KD-2");
  const h = replyHarness(t, {
    replyPolicy: true,
    links: [first, other, second],
    resource: JIRA_RESOURCE_IDENTITY,
    platform: "jira",
  });
  const actions = h.actions();
  assert.deepEqual(actions, [
    {
      key: `${CONVERSATION_NAME}.reply.0`,
      binding_id: h.conversationId,
      action: ConversationAction.Reply,
      expected_end_state: ExpectedEndState.Posted,
      follows: null,
      configuration: { external_link: first },
    },
    {
      key: `${CONVERSATION_NAME}.reply.2`,
      binding_id: h.conversationId,
      action: ConversationAction.Reply,
      expected_end_state: ExpectedEndState.Posted,
      follows: null,
      configuration: { external_link: second },
    },
  ]);
  for (const action of actions)
    assert.ok(actionKeySchema.safeParse(action.key).success);
});

test("a jira binding without a reply policy derives no reply action", (t) => {
  assert.deepEqual(
    replyHarness(t, {
      replyPolicy: false,
      links: [jiraLinkTo(JIRA_RESOURCE_IDENTITY, "KD-1")],
      resource: JIRA_RESOURCE_IDENTITY,
      platform: "jira",
    }).actions(),
    [],
  );
});

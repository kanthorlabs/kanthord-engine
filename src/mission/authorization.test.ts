import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import {
  AssessmentResult,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
} from "./contract.ts";
import {
  authorizeAction,
  authorizeBinding,
  authorizeClaim,
} from "./authorization.ts";
import { closeAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import {
  ASSESSED_COMMIT,
  HARNESS_ACTION_KEY,
  HARNESS_CREDENTIAL,
  HARNESS_PLATFORM,
  authorizationHarness,
  evidenceHarness,
} from "./test-support.ts";

test("Mission proves live claim, node, open attempt and binding before granting a frozen action", (t) => {
  const h = evidenceHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    binding_id: h.repositoryId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: RepositoryAction.PullRequest,
    project_prompt: null,
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  const authorize = () =>
    h.store.transaction((tx) =>
      authorizeAction(tx, h.dependencies, h.claim, "repo.pull_request"),
    );
  assert.equal(authorize().binding_id, h.repositoryId);
  const refuses = (fn: () => unknown, reason: string) =>
    assert.throws(fn, {
      status: 403,
      code: MissionErrorCode.AuthorizationRefused,
      details: { reason },
    });
  const original = h.dependencies.bindings.getBindingRevision;
  for (const [field, reason] of [
    ["disabled", "binding_disabled"],
    ["tombstone", "binding_removed"],
  ] as const) {
    h.dependencies.bindings.getBindingRevision = (tx, id) => ({
      ...original(tx, id)!,
      [field]: true,
    });
    refuses(authorize, reason);
  }
  h.dependencies.bindings.getBindingRevision = () => null;
  refuses(
    () =>
      h.store.transaction((tx) =>
        authorizeBinding(tx, h.dependencies.bindings, h.repositoryId),
      ),
    "binding_removed",
  );
  h.dependencies.bindings.getBindingRevision = original;
  refuses(
    () =>
      h.store.transaction((tx) =>
        authorizeClaim(tx, h.dependencies, h.claim, createIdentity("node")),
      ),
    "node_mismatch",
  );
  const live = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  refuses(authorize, "claim_not_live");
  h.dependencies.schedulerClaims.liveExecutionOf = live;
  h.store.transaction((tx) =>
    closeAttempt(tx, h.node_id, h.claim.attempt, Date.now()),
  );
  refuses(authorize, "attempt_closed");
});

const OTHER_COMMIT = "b".repeat(40);
const PULL_REQUEST_KEY = HARNESS_ACTION_KEY;
const ISSUED_AT = 100;
const MERGE_PUSH_KEY = "repo.merge_push";

function refuses(fn: () => unknown, reason: string) {
  assert.throws(fn, {
    status: 403,
    code: MissionErrorCode.AuthorizationRefused,
    details: { reason },
  });
}

function actionHarness(t: TestContext) {
  const h = authorizationHarness(
    t,
    testHumanIdentity("ulrich", "Ulrich", "token"),
  );
  const machine = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "Harness",
      resourceIdentity: "worker:claude",
      issuedAt: ISSUED_AT,
      projectId: h.project_id,
    },
    "jti",
    h.claim.runtimeIdentity,
  );
  const frozen = (
    input: Partial<{
      key: string;
      commit: string;
      reusedEvidenceId: string | null;
    }> = {},
  ) =>
    h.store.transaction((tx) =>
      h.service.authorizeFrozenAction(tx, machine, h.claim, {
        key: PULL_REQUEST_KEY,
        commit: ASSESSED_COMMIT,
        reusedEvidenceId: null,
        ...input,
      }),
    );
  const evidence = (
    evidenceId: string,
    claim: ExecutionClaim | null = h.claim,
  ) =>
    h.store.transaction((tx) =>
      h.service.authorizeRequestEvidence(tx, machine, evidenceId, claim),
    );
  const otherNode = () => {
    const parent = h.node().parent_id;
    assert.ok(parent);
    return parent;
  };
  return { ...h, machine, frozen, evidence, otherNode };
}

function bindingRefusals(
  h: ReturnType<typeof actionHarness>,
  authorize: () => unknown,
) {
  const original = h.dependencies.bindings.getBindingRevision;
  for (const [field, reason] of [
    ["disabled", "binding_disabled"],
    ["tombstone", "binding_removed"],
  ] as const) {
    h.dependencies.bindings.getBindingRevision = (tx, id) => ({
      ...original(tx, id)!,
      [field]: true,
    });
    refuses(authorize, reason);
  }
  h.dependencies.bindings.getBindingRevision = original;
}

test("Mission authorizes a pull request action with the assessed snapshot and the binding credential", (t) => {
  const h = actionHarness(t);
  h.assess();
  const authorized = h.frozen();
  assert.equal(authorized.credential, HARNESS_CREDENTIAL);
  assert.equal(authorized.platform, HARNESS_PLATFORM);
  assert.equal(authorized.project_id, h.project_id);
  assert.equal(authorized.facts.frozen_action.key, PULL_REQUEST_KEY);
  assert.deepEqual(authorized.facts.repository, {
    binding_id: h.repositoryId,
    address: h.policy.address,
    resource_identity: h.resourceIdentity,
    base_branch: "main",
  });
  assert.equal(authorized.facts.snapshot_commit, ASSESSED_COMMIT);
  assert.equal(authorized.facts.reused_address, null);
});

test("Mission authorizes a merge push action without a credential", (t) => {
  const h = actionHarness(t);
  h.policy.action = RepositoryAction.MergePush;
  h.assess();
  const authorized = h.frozen({ key: MERGE_PUSH_KEY });
  assert.equal(authorized.credential, null);
  assert.equal(
    authorized.facts.frozen_action.action,
    RepositoryAction.MergePush,
  );
});

test("a frozen action refuses a steps claim and an evaluation claim without a current passing assessment", (t) => {
  const h = actionHarness(t);
  h.assess();
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Executing));
  refuses(() => h.frozen(), "claim_not_live");
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  assert.equal(h.frozen().facts.snapshot_commit, ASSESSED_COMMIT);
  h.assess(AssessmentResult.CriterionNotMet);
  refuses(() => h.frozen(), "claim_not_live");
});

test("a frozen action refuses without any assessment", (t) => {
  const h = actionHarness(t);
  refuses(() => h.frozen(), "claim_not_live");
});

test("a frozen action refuses a commit that differs from the assessed snapshot", (t) => {
  const h = actionHarness(t);
  h.assess();
  refuses(() => h.frozen({ commit: OTHER_COMMIT }), "node_mismatch");
  h.assess(AssessmentResult.Success, OTHER_COMMIT);
  refuses(() => h.frozen(), "node_mismatch");
  assert.equal(
    h.frozen({ commit: OTHER_COMMIT }).facts.snapshot_commit,
    OTHER_COMMIT,
  );
});

test("a frozen action refuses an unknown key, a dead claim, a closed attempt and a disabled or removed binding", (t) => {
  const h = actionHarness(t);
  h.assess();
  refuses(() => h.frozen({ key: MERGE_PUSH_KEY }), "node_mismatch");
  bindingRefusals(h, () => h.frozen());
  const live = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  refuses(() => h.frozen(), "claim_not_live");
  h.dependencies.schedulerClaims.liveExecutionOf = live;
  h.store.transaction((tx) =>
    closeAttempt(tx, h.node_id, h.claim.attempt, Date.now()),
  );
  refuses(() => h.frozen(), "attempt_closed");
});

test("a frozen action reuses only a pull request of the same node and resource", (t) => {
  const h = actionHarness(t);
  h.assess();
  const reused = h.request();
  assert.deepEqual(
    h.frozen({ reusedEvidenceId: reused }).facts.reused_address,
    h.pullRequest,
  );
  const branch = h.request(
    {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: h.resourceIdentity,
      branch: "main",
      commit: ASSESSED_COMMIT,
    },
    h.node_id,
    "branch.merge_push",
  );
  const foreign = h.request(
    { ...h.pullRequest, resource_identity: "repository:github:other/repo" },
    h.node_id,
    "foreign.pull_request",
  );
  const otherNode = h.request(h.pullRequest, h.otherNode());
  for (const id of [branch, foreign, otherNode, createIdentity("evidence")])
    refuses(() => h.frozen({ reusedEvidenceId: id }), "node_mismatch");
});

test("a request evidence answers the credential of a pull request and none for a branch push", (t) => {
  const h = actionHarness(t);
  const pullRequest = h.evidence(h.request());
  assert.equal(pullRequest.credential, HARNESS_CREDENTIAL);
  assert.equal(pullRequest.project_id, h.project_id);
  assert.deepEqual(pullRequest.facts.address, h.pullRequest);
  assert.equal(pullRequest.facts.frozen_action.key, PULL_REQUEST_KEY);
  assert.equal(pullRequest.facts.repository.binding_id, h.repositoryId);
  h.policy.action = RepositoryAction.MergePush;
  const push = h.evidence(
    h.request({
      kind: PlatformAddressKind.BranchPush,
      resource_identity: h.resourceIdentity,
      branch: "main",
      commit: ASSESSED_COMMIT,
    }),
  );
  assert.equal(push.credential, null);
  assert.equal(push.facts.address.kind, PlatformAddressKind.BranchPush);
});

test("a request evidence refuses another node, a missing claim, a dead claim and a disabled or removed binding", (t) => {
  const h = actionHarness(t);
  const id = h.request();
  refuses(
    () => h.evidence(h.request(h.pullRequest, h.otherNode())),
    "node_mismatch",
  );
  refuses(() => h.evidence(createIdentity("evidence")), "node_mismatch");
  refuses(() => h.evidence(id, null), "claim_not_live");
  bindingRefusals(h, () => h.evidence(id));
  const live = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  refuses(() => h.evidence(id), "claim_not_live");
  h.dependencies.schedulerClaims.liveExecutionOf = live;
  assert.equal(
    h.evidence(id).facts.address.kind,
    PlatformAddressKind.PullRequest,
  );
});

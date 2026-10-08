import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import {
  AssessmentResult,
  AssetKind,
  MissionErrorCode,
  OBJECT_SIZE_MAX,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
} from "./contract.ts";
import {
  AssetUse,
  authorizeAction,
  authorizeBinding,
  authorizeClaim,
} from "./authorization.ts";
import { objectLocation } from "./evidence-content.ts";
import {
  closeAttempt,
  insertAssessment,
  insertEvidence,
  insertOutcome,
  openAttempt,
} from "./record-store.ts";
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

const UPLOAD_EXPIRED_AT = Date.now() + 3600000;
const OBJECT_SIZE = 7;
const OBJECT_VERSION = "v1";
const SHA256 = "c".repeat(64);
const VALIDATION_FAILED = "gateway.request.validation_failed";

function assetHarness(t: TestContext) {
  const h = actionHarness(t);
  const human = testHumanIdentity("ulrich", "Ulrich", "token");
  const put = (
    input: Partial<{
      nodeId: string;
      assetId: string;
      storageBindingId: string;
      size: number;
    }> = {},
  ) =>
    h.store.transaction((tx) =>
      h.service.authorizeObjectPut(tx, h.machine, h.claim, {
        nodeId: h.node_id,
        assetId: createIdentity("evidence_asset"),
        storageBindingId: h.storageId,
        size: OBJECT_SIZE,
        sha256: SHA256,
        ...input,
      }),
    );
  const object = (
    fields: Partial<{
      nodeId: string;
      attempt: number;
      published: boolean;
      expiredAt: number;
    }> = {},
  ) => {
    const evidenceId = createIdentity("evidence");
    const assetId = createIdentity("evidence_asset");
    const published = fields.published ?? false;
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id: evidenceId,
          node_id: fields.nodeId ?? h.node_id,
          attempt: fields.attempt ?? h.claim.attempt,
          subject: "Object",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: Date.now(),
        },
        [
          {
            id: assetId,
            evidence_id: evidenceId,
            kind: AssetKind.Object,
            content: canonicalJSON({
              location: objectLocation(h.storage, `prefix/${assetId}`),
              size: OBJECT_SIZE,
              media_type: "text/plain",
              storage_binding_id: h.storageId,
              ...(published ? { object_version: OBJECT_VERSION } : {}),
            }),
            published_at: published ? Date.now() : null,
            expired_at: published
              ? null
              : (fields.expiredAt ?? UPLOAD_EXPIRED_AT),
          },
        ],
      ),
    );
    return { evidenceId, assetId };
  };
  const asset = (
    assetId: string,
    use: AssetUse,
    identity: CallerIdentity = use === AssetUse.Get || use === AssetUse.Delete
      ? human
      : h.machine,
    claim: ExecutionClaim | null = identity === human ? null : h.claim,
  ) =>
    h.store.transaction((tx) =>
      h.service.authorizeEvidenceAsset(tx, identity, assetId, claim, use),
    );
  return { ...h, human, put, object, asset };
}

test("an object PUT names the server key of the claim attempt and the storage credential", (t) => {
  const h = assetHarness(t);
  const assetId = createIdentity("evidence_asset");
  const granted = h.put({ assetId });
  const key = [
    h.storage.prefix,
    h.project_id,
    h.mission_id,
    h.node_id,
    h.claim.attempt,
    assetId,
  ].join("/");
  assert.deepEqual(granted, {
    credential: h.storage.credential,
    platform: "s3",
    project_id: h.project_id,
    facts: {
      storage: {
        binding_id: h.storageId,
        endpoint: h.storage.endpoint,
        bucket: h.storage.bucket,
        region: h.storage.region,
      },
      key,
      location: `s3://${h.storage.bucket}/${key}`,
      version: null,
      size: OBJECT_SIZE,
      sha256: SHA256,
    },
  });
  assert.equal(h.put({ size: OBJECT_SIZE_MAX }).facts.size, OBJECT_SIZE_MAX);
});

test("an object PUT refuses another node, a recorded asset, another storage binding and a size above the limit", (t) => {
  const h = assetHarness(t);
  refuses(() => h.put({ nodeId: h.otherNode() }), "node_mismatch");
  refuses(() => h.put({ assetId: h.object().assetId }), "node_mismatch");
  refuses(
    () => h.put({ storageBindingId: createIdentity("binding") }),
    "node_mismatch",
  );
  assert.throws(() => h.put({ size: OBJECT_SIZE_MAX + 1 }), {
    status: 400,
    code: VALIDATION_FAILED,
  });
  const live = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  refuses(() => h.put(), "claim_not_live");
  h.dependencies.schedulerClaims.liveExecutionOf = live;
});

test("a check admits a pending or a published asset of the claim attempt and answers its key", (t) => {
  const h = assetHarness(t);
  const { assetId } = h.object();
  const granted = h.asset(assetId, AssetUse.Check);
  assert.equal(granted.credential, h.storage.credential);
  assert.equal(granted.facts.key, `prefix/${assetId}`);
  assert.equal(granted.facts.version, null);
  assert.equal(granted.facts.size, OBJECT_SIZE);
  refuses(
    () => h.asset(h.object({ nodeId: h.otherNode() }).assetId, AssetUse.Check),
    "node_mismatch",
  );
  const published = h.asset(
    h.object({ published: true }).assetId,
    AssetUse.Check,
  );
  assert.equal(published.facts.version, OBJECT_VERSION);
  assert.equal(published.facts.size, OBJECT_SIZE);
  assert.throws(
    () => h.asset(h.object({ expiredAt: 1 }).assetId, AssetUse.Check),
    { status: 409, code: MissionErrorCode.EvidenceUploadExpired },
  );
  assert.throws(
    () => h.asset(createIdentity("evidence_asset"), AssetUse.Check),
    {
      status: 404,
      code: MissionErrorCode.RecordNotFound,
    },
  );
});

test("a check refuses a pending asset of an earlier attempt", (t) => {
  const h = assetHarness(t);
  const { assetId } = h.object();
  h.store.transaction((tx) => {
    closeAttempt(tx, h.node_id, h.claim.attempt, Date.now());
    openAttempt(tx, h.node_id, h.claim.pinnedRevision, h.executionActor, 1);
  });
  h.claim.attempt += 1;
  assert.throws(() => h.asset(assetId, AssetUse.Check), {
    status: 409,
    code: MissionErrorCode.ExecutionContextMismatch,
    details: { field: "attempt" },
  });
});

test("an initiative claim reads the object of a current objective outcome and nothing outside its bound", (t) => {
  const h = assetHarness(t);
  const named = h.object({ published: true });
  const unnamed = h.object({ published: true });
  h.store.transaction((tx) => {
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: h.node_id,
      attempt: h.claim.attempt,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: canonicalJSON([named.evidenceId]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: h.claim.pinnedRevision,
      created_at: Date.now(),
    });
    insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.node_id,
      assessment_id: assessmentId,
      result: AssessmentResult.Undetermined,
      evidence_ids: "[]",
      created_at: Date.now(),
    });
  });
  h.claim.nodeId = h.otherNode();
  const granted = h.asset(named.assetId, AssetUse.ExecutionGet);
  assert.equal(granted.facts.version, OBJECT_VERSION);
  assert.equal(granted.facts.key, `prefix/${named.assetId}`);
  assert.throws(() => h.asset(unnamed.assetId, AssetUse.ExecutionGet), {
    status: 404,
    code: MissionErrorCode.RecordNotFound,
  });
});

test("a human reads and deletes an object with the newest binding and refuses the machine uses", (t) => {
  const h = assetHarness(t);
  const { assetId } = h.object({ published: true });
  for (const use of [AssetUse.Get, AssetUse.Delete]) {
    const granted = h.asset(assetId, use);
    assert.equal(granted.credential, h.storage.credential);
    assert.equal(granted.facts.version, OBJECT_VERSION);
    refuses(() => h.asset(assetId, use, h.machine, h.claim), "node_mismatch");
  }
  for (const use of [AssetUse.Check, AssetUse.ExecutionGet])
    refuses(() => h.asset(assetId, use, h.human, null), "claim_not_live");
  const evidenceId = h.request();
  const platform = h.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT id FROM mission_evidence_asset WHERE evidence_id = ?")
        .get(evidenceId) as { id: string },
  );
  refuses(() => h.asset(platform.id, AssetUse.Get), "node_mismatch");
});

test("a disabled or removed storage binding refuses every use of an object", (t) => {
  const h = assetHarness(t);
  const pending = h.object().assetId;
  const published = h.object({ published: true }).assetId;
  bindingRefusals(h, () => h.put());
  bindingRefusals(h, () => h.asset(pending, AssetUse.Check));
  for (const use of [AssetUse.Get, AssetUse.ExecutionGet, AssetUse.Delete])
    bindingRefusals(h, () => h.asset(published, use));
});

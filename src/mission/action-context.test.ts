import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  PlatformAddressKind,
  RepositoryAction,
  Resolution,
  type PlatformAddress,
} from "./contract.ts";
import { insertEvidence, openAttempt, closeAttempt } from "./record-store.ts";
import { evidenceHarness, executionHarness } from "./test-support.ts";

const NOW = 100;
const NO_CALLS = 0;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const THIRD_ATTEMPT = 3;
const KEY = "repo.pull_request";
const RESOURCE = "repository:github:owner/repo";
const PR: PlatformAddress = {
  kind: PlatformAddressKind.PullRequest,
  resource_identity: RESOURCE,
  number: 42,
};

function harness(t: TestContext) {
  const h = evidenceHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity:
      bindingId === h.repositoryId ? RESOURCE : "storage:s3:bucket",
    revision: FIRST_ATTEMPT,
    tombstone: false,
    disabled: false,
  });
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
  const read = (attempt = FIRST_ATTEMPT) =>
    h.store.transaction((tx) =>
      h.service.actionContextOf(tx, h.node_id, attempt),
    );
  const request = (attempt: number, address: PlatformAddress = PR) => {
    const id = createIdentity("evidence");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: h.node_id,
          attempt,
          subject: KEY,
          requirement_key: KEY,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
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
      ),
    );
    return id;
  };
  const next = (attempt: number) =>
    h.store.transaction((tx) => {
      closeAttempt(tx, h.node_id, attempt - 1, NOW);
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.executionActor, NOW);
    });
  assert.equal(read().actions.length, FIRST_ATTEMPT);
  assert.equal(read().actions[0]?.resource_identity, RESOURCE);
  return { ...h, read, request, next };
}

test("initiative context has no actions or assessment", (t) => {
  const h = executionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const context = h.store.transaction((tx) =>
    h.service.actionContextOf(tx, h.node_id, FIRST_ATTEMPT),
  );
  assert.deepEqual(context.actions, []);
  assert.equal(context.current_assessment, null);
});

test("unrequested action is eligible and the current request removes eligibility", (t) => {
  const h = harness(t);
  assert.equal(h.read().actions[0]?.eligible, true);
  assert.equal(h.read().current_assessment, null);
  const id = h.request(FIRST_ATTEMPT);
  assert.equal(h.read().actions[0]?.resolution, Resolution.Unresolved);
  assert.equal(h.read().actions[0]?.request_evidence_id, id);
  assert.equal(h.read().actions[0]?.eligible, false);
  assert.deepEqual(h.read().actions[0]?.reuse_candidates, []);
});

test("earlier request becomes a candidate only in later attempts", (t) => {
  const h = harness(t);
  const id = h.request(FIRST_ATTEMPT);
  h.next(SECOND_ATTEMPT);
  assert.deepEqual(h.read().actions[0]?.reuse_candidates, []);
  assert.deepEqual(h.read(SECOND_ATTEMPT).actions[0]?.reuse_candidates, [
    { evidence_id: id, attempt: FIRST_ATTEMPT, address: PR },
  ]);
});

test("canonical duplicate addresses retain the newest earlier request", (t) => {
  const h = harness(t);
  h.request(FIRST_ATTEMPT);
  h.next(SECOND_ATTEMPT);
  const id = h.request(SECOND_ATTEMPT, {
    number: 42,
    resource_identity: RESOURCE,
    kind: PlatformAddressKind.PullRequest,
  });
  h.next(THIRD_ATTEMPT);
  assert.equal(
    h.read(THIRD_ATTEMPT).actions[0]?.reuse_candidates.length,
    FIRST_ATTEMPT,
  );
  assert.deepEqual(h.read(THIRD_ATTEMPT).actions[0]?.reuse_candidates, [
    { evidence_id: id, attempt: SECOND_ATTEMPT, address: PR },
  ]);
});

test("branch pushes are not reuse candidates", (t) => {
  const h = harness(t);
  h.request(FIRST_ATTEMPT, {
    kind: PlatformAddressKind.BranchPush,
    resource_identity: RESOURCE,
    branch: "main",
    commit: "b".repeat(40),
  });
  h.next(SECOND_ATTEMPT);
  assert.deepEqual(h.read(SECOND_ATTEMPT).actions[0]?.reuse_candidates, []);
  assert.equal(h.read(SECOND_ATTEMPT).actions[0]?.eligible, true);
});

test("action context uses only the caller transaction", (t) => {
  const h = harness(t);
  h.store.transaction((tx) => {
    const spy = t.mock.method(h.store, "transaction", () =>
      assert.fail("nested transaction"),
    );
    const context = h.service.actionContextOf(tx, h.node_id, FIRST_ATTEMPT);
    assert.equal(context.actions[0]?.eligible, true);
    assert.equal(spy.mock.callCount(), NO_CALLS);
    spy.mock.restore();
  });
});

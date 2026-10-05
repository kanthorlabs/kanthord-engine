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
const FIRST = 1;
const SECOND = 2;
const THIRD = 3;
const KEY = "repo.pull_request";
const RESOURCE = "repository:github:owner/repo";
const PR: PlatformAddress = {
  kind: PlatformAddressKind.PullRequest,
  resourceIdentity: RESOURCE,
  number: 42,
};

function harness(t: TestContext) {
  const h = evidenceHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity:
      bindingId === h.repositoryId ? RESOURCE : "storage:s3:bucket",
    revision: FIRST,
    tombstone: false,
    disabled: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId: h.repositoryId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action: RepositoryAction.PullRequest,
    projectPrompt: null,
  });
  const read = (attempt = FIRST) =>
    h.store.transaction((tx) =>
      h.service.actionContextOf(tx, h.nodeId, attempt),
    );
  const request = (attempt: number, address: PlatformAddress = PR) => {
    const id = createIdentity("evidence");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
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
      closeAttempt(tx, h.nodeId, attempt - 1, NOW);
      openAttempt(tx, h.nodeId, FIRST, h.executionActor, NOW);
    });
  assert.equal(read().actions.length, FIRST);
  assert.equal(read().actions[0]?.resourceIdentity, RESOURCE);
  return { ...h, read, request, next };
}

test("initiative context has no actions or assessment", (t) => {
  const h = executionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const context = h.store.transaction((tx) =>
    h.service.actionContextOf(tx, h.nodeId, FIRST),
  );
  assert.deepEqual(context.actions, []);
  assert.equal(context.currentAssessment, null);
});

test("unrequested action is eligible and the current request removes eligibility", (t) => {
  const h = harness(t);
  assert.equal(h.read().actions[0]?.eligible, true);
  assert.equal(h.read().currentAssessment, null);
  const id = h.request(FIRST);
  assert.equal(h.read().actions[0]?.resolution, Resolution.Unresolved);
  assert.equal(h.read().actions[0]?.requestEvidenceId, id);
  assert.equal(h.read().actions[0]?.eligible, false);
  assert.deepEqual(h.read().actions[0]?.reuseCandidates, []);
});

test("earlier request becomes a candidate only in later attempts", (t) => {
  const h = harness(t);
  const id = h.request(FIRST);
  h.next(SECOND);
  assert.deepEqual(h.read().actions[0]?.reuseCandidates, []);
  assert.deepEqual(h.read(SECOND).actions[0]?.reuseCandidates, [
    { evidenceId: id, attempt: FIRST, address: PR },
  ]);
});

test("canonical duplicate addresses retain the newest earlier request", (t) => {
  const h = harness(t);
  h.request(FIRST);
  h.next(SECOND);
  const id = h.request(SECOND, {
    number: 42,
    resourceIdentity: RESOURCE,
    kind: PlatformAddressKind.PullRequest,
  });
  h.next(THIRD);
  assert.equal(h.read(THIRD).actions[0]?.reuseCandidates.length, FIRST);
  assert.deepEqual(h.read(THIRD).actions[0]?.reuseCandidates, [
    { evidenceId: id, attempt: SECOND, address: PR },
  ]);
});

test("branch pushes are not reuse candidates", (t) => {
  const h = harness(t);
  h.request(FIRST, {
    kind: PlatformAddressKind.BranchPush,
    resourceIdentity: RESOURCE,
    branch: "main",
    commit: "b".repeat(40),
  });
  h.next(SECOND);
  assert.deepEqual(h.read(SECOND).actions[0]?.reuseCandidates, []);
  assert.equal(h.read(SECOND).actions[0]?.eligible, true);
});

test("action context uses only the caller transaction", (t) => {
  const h = harness(t);
  h.store.transaction((tx) => {
    const spy = t.mock.method(h.store, "transaction", () =>
      assert.fail("nested transaction"),
    );
    const context = h.service.actionContextOf(tx, h.nodeId, FIRST);
    assert.equal(context.actions[0]?.eligible, true);
    assert.equal(spy.mock.callCount(), NO_CALLS);
    spy.mock.restore();
  });
});

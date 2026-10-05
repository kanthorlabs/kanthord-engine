import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  NodeKind,
  NodeState,
  ActorKind,
  ClaimKind,
  AssetKind,
  AssessmentResult,
  ReleaseObligation,
  RepositoryAction,
  type AssetKind as AssetType,
} from "./contract.ts";
import {
  insertEvidence,
  insertAssessment,
  readOpenAttempt,
} from "./record-store.ts";
import { setNodeState, insertNode } from "./store.ts";
import { readCurrentRevision, insertRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const NOW = 100;
const ZERO = 0;
const INSERT = "workQueue.insert";
const UNMET = "mission.release.obligation_unmet";
function fixture(t: TestContext, kind: NodeKind = NodeKind.Objective) {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const executionId = createIdentity("execution");
  const opener = {
    kind: ActorKind.Execution,
    executionId,
    clientId: createIdentity("client_identity"),
    name: "Worker",
  };
  h.dependencies.bindings.getBindingRevision = () => ({
    projectId: h.projectId,
    bindingId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    projectId: h.projectId,
    bindingId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action: RepositoryAction.PullRequest,
    projectPrompt: null,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(kind, h.nodeId);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify(kind === NodeKind.Objective ? [bindingId] : []),
        h.nodeId,
      );
  });
  const claim = (states: NodeState[] = [NodeState.Available]) =>
    h.store.transaction((tx) =>
      h.service.claim(tx, h.nodeId, states, opener, NOW),
    );
  const release = (furtherWork = false) =>
    h.store.transaction((tx) =>
      h.service.release(
        tx,
        { executionId, nodeId: h.nodeId, attempt: FIRST },
        furtherWork,
        NOW,
      ),
    );
  const evidence = (
    assetKind: AssetType,
    published: boolean,
    address = bindingId,
  ) =>
    h.store.transaction((tx) => {
      const id = createIdentity("evidence");
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
          attempt: FIRST,
          subject: "Work",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: JSON.stringify(opener),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: assetKind,
            content: JSON.stringify(
              assetKind === AssetKind.Repository
                ? { bindingId: address, commit: "a".repeat(40) }
                : { data: "work" },
            ),
            published_at: published ? NOW : null,
            expired_at: null,
          },
        ],
      );
    });
  const refuses = (obligation: ReleaseObligation) => {
    const before = h.node();
    const calls = [...h.calls];
    assert.throws(
      () => release(),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, UNMET);
        assert.deepEqual(error.details, { obligation });
        return true;
      },
    );
    assert.deepEqual(h.node(), before);
    assert.deepEqual(h.calls, calls);
  };
  return {
    ...h,
    bindingId,
    executionId,
    opener,
    claim,
    release,
    evidence,
    refuses,
  };
}

test("claim rechecks stale jobs, opens once, and preserves the open attempt pin", (t) => {
  const h = fixture(t);
  assert.equal(h.claim([NodeState.Waiting]), null);
  const claim = h.claim();
  assert.deepEqual(claim, {
    kind: ClaimKind.Steps,
    projectId: h.projectId,
    attempt: FIRST,
    nodeRevision: FIRST,
  });
  assert.deepEqual(
    JSON.parse(
      h.store.transaction((tx) => readOpenAttempt(tx, h.nodeId))!.opened_by,
    ),
    h.opener,
  );
  h.release(true);
  h.store.transaction((tx) => {
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.nodeId)!);
    insertRevision(tx, {
      ...prior,
      revision: FIRST + FIRST,
      content: { ...prior.content, name: "Later direction" },
    });
  });
  assert.deepEqual(h.claim(), claim);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Blocked));
  assert.equal(h.claim([NodeState.Blocked]), null);
  assert.equal(
    h.store.transaction((tx) =>
      h.service.claim(
        tx,
        createIdentity("node"),
        [NodeState.Available],
        h.opener,
        NOW,
      ),
    ),
    null,
  );
  h.store.database
    .prepare("UPDATE mission_node SET state = ?, retired_at = ? WHERE id = ?")
    .run(NodeState.Available, NOW, h.nodeId);
  assert.equal(h.claim(), null);
});

test("initiative claim refuses nonterminal objectives and task claim is never admitted", (t) => {
  const h = fixture(t, NodeKind.Initiative);
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: createIdentity("node"),
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.nodeId,
      created_at: NOW,
    }),
  );
  assert.equal(h.claim(), null);
  assert.equal(h.node().attempt, ZERO);
  h.store.database
    .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
    .run(NodeKind.Task, h.nodeId);
  assert.equal(h.claim(), null);
});

test("objective steps release requires published evidence from the execution and pinned repository", (t) => {
  const h = fixture(t);
  h.claim();
  h.refuses(ReleaseObligation.Evidence);
  h.evidence(AssetKind.Produced, true);
  h.refuses(ReleaseObligation.Evidence);
  h.evidence(AssetKind.Repository, false);
  h.refuses(ReleaseObligation.Evidence);
  h.evidence(AssetKind.Repository, true, createIdentity("binding"));
  h.refuses(ReleaseObligation.Evidence);
  h.evidence(AssetKind.Repository, true);
  h.release();
  assert.equal(h.node().state, NodeState.Waiting);
  assert.ok(h.calls.some((call) => call.method === INSERT));
});

test("initiative steps release admits produced evidence", (t) => {
  const h = fixture(t, NodeKind.Initiative);
  h.claim();
  h.evidence(AssetKind.Produced, true);
  h.release();
  assert.equal(h.node().state, NodeState.Waiting);
  assert.equal(h.claim([NodeState.Waiting])?.kind, ClaimKind.Evaluation);
});

test("steps release excludes foreign execution and attempt evidence and requires every asset published", (t) => {
  const h = fixture(t);
  h.claim();
  const add = (executionId: string, attempt: number, pending: boolean) =>
    h.store.transaction((tx) => {
      const id = createIdentity("evidence");
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
          attempt,
          subject: "Work",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: JSON.stringify({ ...h.opener, executionId }),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Repository,
            content: JSON.stringify({
              bindingId: h.bindingId,
              commit: "a".repeat(40),
            }),
            published_at: NOW,
            expired_at: null,
          },
          ...(pending
            ? [
                {
                  id: createIdentity("evidence_asset"),
                  evidence_id: id,
                  kind: AssetKind.Object,
                  content: "{}",
                  published_at: null,
                  expired_at: NOW + FIRST,
                },
              ]
            : []),
        ],
      );
    });
  add(createIdentity("execution"), FIRST, false);
  h.refuses(ReleaseObligation.Evidence);
  add(h.executionId, ZERO, false);
  h.refuses(ReleaseObligation.Evidence);
  add(h.executionId, FIRST, true);
  h.refuses(ReleaseObligation.Evidence);
});

test("reviewer release requires a current success and every eligible request", (t) => {
  const h = fixture(t);
  h.claim();
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  h.refuses(ReleaseObligation.Assessment);
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.nodeId,
      attempt: FIRST,
      node_revision: FIRST,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.executionId,
      actor: null,
      created_at: NOW,
    }),
  );
  h.refuses(ReleaseObligation.Request);
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.nodeId,
        attempt: FIRST,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [],
    ),
  );
  h.release();
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(h.claim([NodeState.ExternalRequested]), null);
});

test("loss routes below the limit, pauses at the limit and resume permits another claim", async (t) => {
  const h = fixture(t);
  h.claim();
  h.store.transaction((tx) => h.service.loss(tx, h.nodeId, FIRST, NOW));
  assert.equal(h.node().state, NodeState.Available);
  h.claim();
  h.store.transaction((tx) =>
    h.service.loss(
      tx,
      h.nodeId,
      h.dependencies.config.consecutiveLossLimit,
      NOW,
    ),
  );
  assert.equal(h.node().state, NodeState.Paused);
  assert.equal(
    h.store.transaction((tx) => readOpenAttempt(tx, h.nodeId))?.closed_at,
    null,
  );
  await h.invoke("node.resume", {
    params: { nodeId: h.nodeId },
    query: {},
    body: { ...h.body(NodeState.Paused, FIRST), target: NodeState.Available },
  });
  assert.ok(h.claim());
  h.store.transaction((tx) => {
    setNodeState(tx, h.nodeId, NodeState.Evaluating);
    h.service.loss(tx, h.nodeId, FIRST, NOW);
  });
  assert.equal(h.node().state, NodeState.Waiting);
});

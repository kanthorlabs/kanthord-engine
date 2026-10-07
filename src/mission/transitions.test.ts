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
const FIRST_ATTEMPT = 1;
const NOW = 100;
const NO_ATTEMPT = 0;
const INSERT = "workQueue.insert";
const UNMET = "mission.release.obligation_unmet";
function fixture(t: TestContext, kind: NodeKind = NodeKind.Objective) {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const executionId = createIdentity("execution");
  const opener = {
    kind: ActorKind.Execution,
    execution_id: executionId,
    client_id: createIdentity("client_identity"),
    name: "Worker",
  };
  h.dependencies.bindings.getBindingRevision = () => ({
    project_id: h.project_id,
    binding_id: bindingId,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    project_id: h.project_id,
    binding_id: bindingId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: RepositoryAction.PullRequest,
    project_prompt: null,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(kind, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify(kind === NodeKind.Objective ? [bindingId] : []),
        h.node_id,
      );
  });
  const claim = (states: NodeState[] = [NodeState.Available]) =>
    h.store.transaction((tx) =>
      h.service.claim(tx, h.node_id, states, opener, NOW),
    );
  const release = (furtherWork = false) =>
    h.store.transaction((tx) =>
      h.service.release(
        tx,
        {
          execution_id: executionId,
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
        },
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
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
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
                ? { binding_id: address, commit: "a".repeat(40) }
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
    binding_id: bindingId,
    execution_id: executionId,
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
    project_id: h.project_id,
    attempt: FIRST_ATTEMPT,
    node_revision: FIRST_ATTEMPT,
  });
  assert.deepEqual(
    JSON.parse(
      h.store.transaction((tx) => readOpenAttempt(tx, h.node_id))!.opened_by,
    ),
    h.opener,
  );
  h.release(true);
  h.store.transaction((tx) => {
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.node_id)!);
    insertRevision(tx, {
      ...prior,
      revision: FIRST_ATTEMPT + FIRST_ATTEMPT,
      content: { ...prior.content, name: "Later direction" },
    });
  });
  assert.deepEqual(h.claim(), claim);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Blocked));
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
    .run(NodeState.Available, NOW, h.node_id);
  assert.equal(h.claim(), null);
});

test("initiative claim refuses nonterminal objectives and task claim is never admitted", (t) => {
  const h = fixture(t, NodeKind.Initiative);
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: createIdentity("node"),
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.node_id,
      created_at: NOW,
    }),
  );
  assert.equal(h.claim(), null);
  assert.equal(h.node().attempt, NO_ATTEMPT);
  h.store.database
    .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
    .run(NodeKind.Task, h.node_id);
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
          node_id: h.node_id,
          attempt,
          subject: "Work",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: JSON.stringify({
            ...h.opener,
            execution_id: executionId,
          }),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Repository,
            content: JSON.stringify({
              binding_id: h.binding_id,
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
                  expired_at: NOW + FIRST_ATTEMPT,
                },
              ]
            : []),
        ],
      );
    });
  add(createIdentity("execution"), FIRST_ATTEMPT, false);
  h.refuses(ReleaseObligation.Evidence);
  add(h.execution_id, NO_ATTEMPT, false);
  h.refuses(ReleaseObligation.Evidence);
  add(h.execution_id, FIRST_ATTEMPT, true);
  h.refuses(ReleaseObligation.Evidence);
});

test("reviewer release requires a current success and every eligible request", (t) => {
  const h = fixture(t);
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.refuses(ReleaseObligation.Assessment);
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
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
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
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
  h.store.transaction((tx) =>
    h.service.loss(tx, h.node_id, FIRST_ATTEMPT, NOW),
  );
  assert.equal(h.node().state, NodeState.Available);
  h.claim();
  h.store.transaction((tx) =>
    h.service.loss(
      tx,
      h.node_id,
      h.dependencies.config.consecutive_loss_limit,
      NOW,
    ),
  );
  assert.equal(h.node().state, NodeState.Paused);
  assert.equal(
    h.store.transaction((tx) => readOpenAttempt(tx, h.node_id))?.closed_at,
    null,
  );
  await h.invoke("node.resume", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Paused, FIRST_ATTEMPT),
      target: NodeState.Available,
    },
  });
  assert.ok(h.claim());
  h.store.transaction((tx) => {
    setNodeState(tx, h.node_id, NodeState.Evaluating);
    h.service.loss(tx, h.node_id, FIRST_ATTEMPT, NOW);
  });
  assert.equal(h.node().state, NodeState.Waiting);
});

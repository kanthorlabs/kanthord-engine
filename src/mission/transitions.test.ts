import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  Work,
  NodeState,
  ActorKind,
  ClaimKind,
  AssetKind,
  AssessmentResult,
  CheckEndState,
  EndState,
  ReleaseObligation,
  RepositoryAction,
  StartPoint,
  missionOperations,
  type AssetKind as AssetType,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import {
  insertEvidence,
  insertAssessment,
  readOpenAttempt,
  readEvidence,
} from "./record-store.ts";
import { setNodeState, insertNode, readNode } from "./store.ts";
import { readCurrentRevision, insertRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";
import { controlHarness } from "./test-support.ts";

const NO_STALLS = 0;
const FURTHER_WORK_LIMIT = 3;
const ONE_CALL = 1;

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const THIRD_ATTEMPT = 3;
const NOW = 100;
const NO_ATTEMPT = 0;
const INSERT = "workQueue.insert";
const UNMET = "mission.release.obligation_unmet";
function fixture(
  t: TestContext,
  work: Work = Work.Implement,
  overrides: Partial<Dependencies> = {},
) {
  const h = controlHarness(t, IDENTITY, overrides);
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
    landing: "human",
    project_prompt: null,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node_revision SET work = ? WHERE node_id = ?")
      .run(work, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify(work === Work.Implement ? [bindingId] : []),
        h.node_id,
      );
  });
  const claim = (states: NodeState[] = [NodeState.Available]) =>
    h.store.transaction((tx) =>
      h.service.claim(tx, h.node_id, states, opener, NOW),
    );
  const release = (furtherWork = false, stalledReleases = NO_STALLS) =>
    h.store.transaction((tx) =>
      h.service.release(
        tx,
        {
          execution_id: executionId,
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
        },
        furtherWork,
        stalledReleases,
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
    node_branch: `kanthord/${h.node_id}`,
  });
  assert.deepEqual(
    JSON.parse(
      h.store.transaction((tx) => readOpenAttempt(tx, h.node_id))!.opened_by,
    ),
    h.opener,
  );
  assert.equal(
    h.store.transaction((tx) => readOpenAttempt(tx, h.node_id))!.start_point,
    StartPoint.BaseBranch,
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

test("further-work releases without progress pause the node at the further-work limit", (t) => {
  const h = fixture(t);
  h.claim();
  h.release(true, FURTHER_WORK_LIMIT - 1);
  assert.equal(
    h.store.transaction((tx) => readNode(tx, h.node_id))!.state,
    NodeState.Available,
  );
  h.claim();
  h.release(true, FURTHER_WORK_LIMIT);
  assert.equal(
    h.store.transaction((tx) => readNode(tx, h.node_id))!.state,
    NodeState.Paused,
  );
});

test("examine claim ignores a nonterminal implement child", (t) => {
  const h = fixture(t, Work.Examine);
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: createIdentity("node"),
      mission_id: h.mission_id,
      filename: "child.md",
      created_at: NOW,
    }),
  );
  assert.equal(h.claim()?.kind, ClaimKind.Steps);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
});

test("implement steps release requires published evidence from the execution and pinned repository", (t) => {
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

test("examine steps release admits produced evidence", (t) => {
  const h = fixture(t, Work.Examine);
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
      dependency_outcome_ids: "[]",
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

test("reviewer release folds all expected end states to Completed", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
      actor: null,
      created_at: NOW,
    }),
  );
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: EndState.Expected,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [],
    ),
  );
  h.release();
  assert.equal(h.node().state, NodeState.Completed);
});

test("reviewer release folds an other end state to Blocked", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
      actor: null,
      created_at: NOW,
    }),
  );
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: EndState.Other,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [],
    ),
  );
  h.release();
  assert.equal(h.node().state, NodeState.Blocked);
});

test("a failure routes below the limit, pauses at the limit and resume permits another claim", async (t) => {
  const h = fixture(t);
  h.claim();
  h.store.transaction((tx) =>
    h.service.failure(tx, h.node_id, FIRST_ATTEMPT, NOW),
  );
  assert.equal(h.node().state, NodeState.Available);
  h.claim();
  h.store.transaction((tx) =>
    h.service.failure(
      tx,
      h.node_id,
      h.dependencies.config.consecutive_failure_limit,
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
    h.service.failure(tx, h.node_id, FIRST_ATTEMPT, NOW);
  });
  assert.equal(h.node().state, NodeState.Waiting);
});

test("an unblock from the base branch starts a new node branch that later attempts continue", async (t) => {
  const h = fixture(t);
  const restartBranch = `kanthord/${h.node_id}-a2`;
  const blockAndUnblock = async (attempt: number, startPoint?: StartPoint) => {
    h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
    await h.invoke("node.block", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Paused, attempt),
    });
    return h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: attempt,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
        ...(startPoint === undefined ? {} : { start_point: startPoint }),
      },
    });
  };
  assert.equal(h.claim()?.node_branch, `kanthord/${h.node_id}`);
  const invalid = {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
      start_point: "fresh",
    },
  };
  assert.equal(
    missionOperations["node.unblock"].input.safeParse(invalid).success,
    false,
  );
  const restarted = await blockAndUnblock(FIRST_ATTEMPT, StartPoint.BaseBranch);
  assert.equal(restarted.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(restarted.attempt?.start_point, StartPoint.BaseBranch);
  const steps = h.claim();
  assert.equal(steps?.attempt, SECOND_ATTEMPT);
  assert.equal(steps?.node_branch, restartBranch);
  const continued = await blockAndUnblock(SECOND_ATTEMPT);
  assert.equal(continued.attempt?.attempt, THIRD_ATTEMPT);
  assert.equal(continued.attempt?.start_point, StartPoint.NodeBranch);
  assert.equal(h.claim()?.node_branch, restartBranch);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Waiting));
  const evaluation = h.claim([NodeState.Waiting]);
  assert.equal(evaluation?.kind, ClaimKind.Evaluation);
  assert.equal(evaluation?.attempt, THIRD_ATTEMPT);
  assert.equal(evaluation?.node_branch, restartBranch);
});

const PULL_REQUEST_NUMBER = 1;
const LANDED_COMMIT = "a".repeat(40);
const GATED_RESOURCE = "repository:github:owner/repo";

function deferredFixture(
  t: TestContext,
  check: Awaited<ReturnType<Dependencies["intakeCheck"]["check"]>>,
) {
  let checkCalls = 0;
  const h = fixture(t, Work.Implement, {
    intakeCheck: {
      check: async () => {
        checkCalls++;
        return check;
      },
    },
  });
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
      actor: null,
      created_at: NOW,
    }),
  );
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  const evidenceId = createIdentity("evidence");
  h.store.transaction((tx) => {
    insertEvidence(
      tx,
      {
        id: evidenceId,
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [
        {
          id: createIdentity("evidence_asset"),
          evidence_id: evidenceId,
          kind: AssetKind.Platform,
          content: JSON.stringify({
            kind: "pull_request",
            resource_identity: GATED_RESOURCE,
            number: PULL_REQUEST_NUMBER,
          }),
          published_at: NOW,
          expired_at: null,
        },
      ],
    );
  });
  return { ...h, evidenceId, checkCalls: () => checkCalls };
}

test("deferred check applies expected end state and completes the node", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Expected,
    landed_commits: [LANDED_COMMIT],
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.Completed);
});

test("deferred check applies other end state and blocks the node", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Other,
    landed_commits: [],
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.Blocked);
});

test("deferred check applies conflict and returns the node to Available", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Conflict,
    landed_commits: [],
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.Available);
});

test("deferred check with none leaves the node in ExternalRequested", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(h.checkCalls(), ONE_CALL);
});

function deferredBranchPushFixture(
  t: TestContext,
  check: Awaited<ReturnType<Dependencies["intakeCheck"]["check"]>>,
) {
  const h = fixture(t, Work.Implement, {
    intakeCheck: { check: async () => check },
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    project_id: h.project_id,
    binding_id: h.binding_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: RepositoryAction.MergePush,
    landing: "human",
    project_prompt: null,
  });
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
      actor: null,
      created_at: NOW,
    }),
  );
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.store.transaction((tx) => {
    const id = createIdentity("evidence");
    insertEvidence(
      tx,
      {
        id,
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.merge_push",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [
        {
          id: createIdentity("evidence_asset"),
          evidence_id: id,
          kind: AssetKind.Platform,
          content: JSON.stringify({
            kind: "branch_push",
            resource_identity: GATED_RESOURCE,
            branch: "main",
            commit: LANDED_COMMIT,
          }),
          published_at: NOW,
          expired_at: null,
        },
      ],
    );
  });
  return h;
}

test("deferred check resolves a branch_push request and completes the node", async (t) => {
  const h = deferredBranchPushFixture(t, {
    end_state: CheckEndState.Expected,
    landed_commits: [LANDED_COMMIT],
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.Completed);
});

test("a failing deferred check leaves the node unchanged", async (t) => {
  let checkCalls = 0;
  const h = fixture(t, Work.Implement, {
    intakeCheck: {
      check: async () => {
        checkCalls++;
        throw new Error("check failed");
      },
    },
  });
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Passed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      execution_id: h.execution_id,
      actor: null,
      created_at: NOW,
    }),
  );
  h.claim();
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  h.store.transaction((tx) => {
    const id = createIdentity("evidence");
    insertEvidence(
      tx,
      {
        id,
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [
        {
          id: createIdentity("evidence_asset"),
          evidence_id: id,
          kind: AssetKind.Platform,
          content: JSON.stringify({
            kind: "pull_request",
            resource_identity: GATED_RESOURCE,
            number: PULL_REQUEST_NUMBER,
          }),
          published_at: NOW,
          expired_at: null,
        },
      ],
    );
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(checkCalls, ONE_CALL);
});

test("deferred check with a live claim and expected end state writes no end state", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Expected,
    landed_commits: [LANDED_COMMIT],
  });
  h.dependencies.schedulerClaims.liveExecutionOf = () => ({
    execution_id: h.execution_id,
    runtime_identity: createIdentity("runtime"),
    attempt: FIRST_ATTEMPT,
    pinned_revision: FIRST_ATTEMPT,
  });
  h.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.node().state, NodeState.ExternalRequested);
  const row = h.store.transaction((tx) => readEvidence(tx, h.evidenceId));
  assert.equal(row?.end_state, null);
});

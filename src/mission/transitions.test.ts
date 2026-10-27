import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  Intent,
  NodeState,
  ActorKind,
  ClaimKind,
  AssetKind,
  AssessmentResult,
  CheckEndState,
  EndState,
  ReleaseObligation,
  RepositoryAction,
  RepositoryLanding,
  StartPoint,
  TransitionRule,
  missionOperations,
  type AssetKind as AssetType,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import {
  closeAttempt,
  insertEvidence,
  insertAssessment,
  openAttempt,
  readOpenAttempt,
  readEvidence,
} from "./record-store.ts";
import { setNodeState, insertNode, readNode } from "./store.ts";
import { readCurrentRevision, insertRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";
import {
  DEFERRED_CHECK_RETRY_MS,
  DEFERRED_CHECK_ROUND_LIMIT,
  resumeDeferredChecks,
} from "./node-check.ts";
import { controlHarness, unexpectedCollaboration } from "./test-support.ts";

const NO_STALLS = 0;
const FURTHER_WORK_LIMIT = 3;
const ONE_CALL = 1;
const NO_CALLS = 0;
const NO_GATE_FILES = 0;
const FIRST_INDEX = 0;

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
  intent: Intent = Intent.Implement,
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
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(intent, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify(intent === Intent.Implement ? [bindingId] : []),
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
  const h = fixture(t, Intent.Examine);
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
  const h = fixture(t, Intent.Examine);
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
      gate_files: null,
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
      gate_files: null,
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
      gate_files: null,
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
  const branchOf = (claim: { attempt: number } | null) => {
    assert.ok(claim);
    return h.store.transaction((tx) =>
      h.service.nodeBranchesOf(tx, [
        { node_id: h.node_id, attempt: claim.attempt },
      ]),
    )[0];
  };
  assert.equal(branchOf(h.claim()), `kanthord/${h.node_id}`);
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
  assert.equal(branchOf(steps), restartBranch);
  const continued = await blockAndUnblock(SECOND_ATTEMPT);
  assert.equal(continued.attempt?.attempt, THIRD_ATTEMPT);
  assert.equal(continued.attempt?.start_point, StartPoint.NodeBranch);
  assert.equal(branchOf(h.claim()), restartBranch);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Waiting));
  const evaluation = h.claim([NodeState.Waiting]);
  assert.equal(evaluation?.kind, ClaimKind.Evaluation);
  assert.equal(evaluation?.attempt, THIRD_ATTEMPT);
  assert.equal(branchOf(evaluation), restartBranch);
});

test("nodeBranchesOf answers the branch of every attempt", (t) => {
  const h = fixture(t);
  const restartAttempt = 4;
  const attempts = [1, 2, 3, 4, 5];
  h.store.transaction((tx) => {
    for (const attempt of attempts) {
      openAttempt(
        tx,
        h.node_id,
        FIRST_ATTEMPT,
        h.opener,
        NOW,
        attempt === restartAttempt
          ? StartPoint.BaseBranch
          : StartPoint.NodeBranch,
      );
      closeAttempt(tx, h.node_id, attempt, NOW);
    }
  });
  const first = `kanthord/${h.node_id}`;
  const restarted = `kanthord/${h.node_id}-a${restartAttempt}`;
  const shuffled = [4, 2, 5, 1, 3];
  const branches = h.store.transaction((tx) =>
    h.service.nodeBranchesOf(
      tx,
      shuffled.map((attempt) => ({ node_id: h.node_id, attempt })),
    ),
  );
  assert.deepEqual(branches, [restarted, first, restarted, first, first]);
});

const WAKEUP_WAKE = "wakeup.wake";

function wakes(calls: { method: string }[]): number {
  return calls.filter((call) => call.method === WAKEUP_WAKE).length;
}

async function deferredCheckEnds(
  calls: { method: string }[],
  signal: AbortSignal,
): Promise<void> {
  const before = wakes(calls);
  while (wakes(calls) === before) await turn(undefined, { signal });
}

const PULL_REQUEST_NUMBER = 1;
const LANDED_COMMIT = "a".repeat(40);
const GATED_RESOURCE = "repository:github:owner/repo";
const TESTED_COMMIT = "b".repeat(40);
const MERGE_ADDRESS: MergeAnswer = {
  kind: "pull_request",
  resource_identity: GATED_RESOURCE,
  number: PULL_REQUEST_NUMBER,
};

type CheckAnswer = Awaited<ReturnType<Dependencies["intakeCheck"]["check"]>>;
type MergeAnswer = Awaited<ReturnType<Dependencies["intakeCheck"]["merge"]>>;
type MergeInput = Parameters<Dependencies["intakeCheck"]["merge"]>[1];
type DeferredOptions = {
  landing?: (typeof RepositoryLanding)[keyof typeof RepositoryLanding];
  gateFiles?: { binding_id: string; paths: string[] }[];
  merge?: (input: MergeInput) => Promise<MergeAnswer>;
};

function deferredFixture(
  t: TestContext,
  check: CheckAnswer | ((call: number) => Promise<CheckAnswer>),
  options: DeferredOptions = {},
) {
  let checkCalls = 0;
  const mergeInputs: MergeInput[] = [];
  const warnings: { fields: unknown; message: string }[] = [];
  const infos: { fields: unknown; message: string }[] = [];
  const h = fixture(t, Intent.Implement, {
    logger: {
      info: (fields: unknown, message: string) =>
        infos.push({ fields, message }),
      warn: (fields: unknown, message: string) =>
        warnings.push({ fields, message }),
    } as unknown as Dependencies["logger"],
    intakeCheck: {
      check: async () => {
        checkCalls++;
        return check instanceof Function ? check(checkCalls) : check;
      },
      merge: async (_context, input) => {
        mergeInputs.push(input);
        return options.merge === undefined
          ? MERGE_ADDRESS
          : options.merge(input);
      },
    },
  });
  const policy = h.dependencies.bindings.repositoryPolicyOf;
  h.dependencies.bindings.repositoryPolicyOf = (tx, bindingId) => ({
    ...policy(tx, bindingId)!,
    landing: options.landing ?? RepositoryLanding.Human,
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
      tested_input: JSON.stringify({
        kind: AssetKind.Repository,
        binding_id: h.binding_id,
        commit: TESTED_COMMIT,
      }),
      gate_files:
        options.gateFiles === undefined
          ? null
          : JSON.stringify(options.gateFiles),
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
  return {
    ...h,
    evidenceId,
    mergeInputs,
    warnings,
    infos,
    checkCalls: () => checkCalls,
  };
}

test("deferred check applies expected end state and completes the node", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Expected,
    landed_commits: [LANDED_COMMIT],
  });
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Completed);
});

test("deferred check applies other end state and blocks the node", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Other,
    landed_commits: [],
  });
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Blocked);
});

test("deferred check applies conflict and returns the node to Available", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.Conflict,
    landed_commits: [],
  });
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Available);
});

test("deferred check applies checks_failed and returns the node to Available", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.ChecksFailed,
    landed_commits: [],
  });
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Available);
});

test("deferred check with none leaves the node in ExternalRequested", async (t) => {
  const h = deferredFixture(t, {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(h.checkCalls(), ONE_CALL);
});

const MICROTASK_TURNS = 50;
const FIRST_ROUND_DELAY_MS = 0;
const JUST_BEFORE_RETRY_MS = DEFERRED_CHECK_RETRY_MS - 1;
const ONE_MS = 1;
const MERGE_FAILED = "Deferred merge failed.";
const PENDING: CheckAnswer = {
  end_state: CheckEndState.ChecksPending,
  landed_commits: [],
};
const SETTLED: CheckAnswer = {
  end_state: CheckEndState.None,
  landed_commits: [],
};
const REFUSAL: MergeAnswer = {
  class: "final_refusal",
  code: "github.final_refusal",
  message: "refused",
};

function mockTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setImmediate"] });
  return async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
  };
}

test("a pending answer schedules the next round after the retry delay", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, PENDING);
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  await advance(JUST_BEFORE_RETRY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  await advance(ONE_MS);
  assert.equal(h.checkCalls(), ONE_CALL + 1);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(h.mergeInputs.length, NO_CALLS);
});

test("a none answer of a kanthord landing merges the tested commit", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED, {
    landing: RepositoryLanding.KanthorD,
  });
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.deepEqual(h.mergeInputs, [
    {
      evidence_id: h.evidenceId,
      commit: TESTED_COMMIT,
      request_key: `${h.node_id}/${FIRST_ATTEMPT}/repo.pull_request/merge/${TESTED_COMMIT}/service`,
    },
  ]);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a none answer of a human landing calls no merge and ends the loop", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED);
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(h.mergeInputs.length, NO_CALLS);
  assert.equal(h.checkCalls(), ONE_CALL);
});

test("a none answer with a changed gate file calls no merge", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED, {
    landing: RepositoryLanding.KanthorD,
    gateFiles: [],
  });
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_assessment SET gate_files = ?")
      .run(JSON.stringify([{ binding_id: h.binding_id, paths: ["ci.yml"] }])),
  );
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  assert.equal(h.mergeInputs.length, NO_CALLS);
});

test("a none answer with a live claim calls no merge", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED, {
    landing: RepositoryLanding.KanthorD,
  });
  h.dependencies.schedulerClaims.liveExecutionOf = () => ({
    execution_id: h.execution_id,
    runtime_identity: createIdentity("runtime"),
    attempt: FIRST_ATTEMPT,
    pinned_revision: FIRST_ATTEMPT,
  });
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  assert.equal(h.mergeInputs.length, NO_CALLS);
});

test("the loop stops after the round limit", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, PENDING);
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  for (let round = 1; round < DEFERRED_CHECK_ROUND_LIMIT; round++)
    await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(h.checkCalls(), DEFERRED_CHECK_ROUND_LIMIT);
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(h.checkCalls(), DEFERRED_CHECK_ROUND_LIMIT);
});

test("a refused merge logs a warning and changes no state", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED, {
    landing: RepositoryLanding.KanthorD,
    merge: async () => REFUSAL,
  });
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.mergeInputs.length, ONE_CALL);
  assert.equal(h.warnings.length, ONE_CALL);
  assert.equal(h.warnings[FIRST_INDEX]!.message, MERGE_FAILED);
  assert.deepEqual(h.warnings[FIRST_INDEX]!.fields, {
    evidence_id: h.evidenceId,
    class: REFUSAL.class,
    code: REFUSAL.code,
  });
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.evidenceId))?.end_state,
    null,
  );
});

test("a thrown merge logs a warning and changes no state", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, SETTLED, {
    landing: RepositoryLanding.KanthorD,
    merge: async () => {
      throw new Error("merge failed");
    },
  });
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.warnings.length, ONE_CALL);
  assert.equal(h.warnings[FIRST_INDEX]!.message, MERGE_FAILED);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a failed check schedules the next round after the retry delay", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, async (call) => {
    if (call === ONE_CALL) throw new Error("check failed");
    return PENDING;
  });
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  await advance(JUST_BEFORE_RETRY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
  await advance(ONE_MS);
  assert.equal(h.checkCalls(), ONE_CALL + 1);
});

test("a merge that answers an address runs the next round at once and expected completes the node", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(
    t,
    async (call) =>
      call === ONE_CALL
        ? SETTLED
        : {
            end_state: CheckEndState.Expected,
            landed_commits: [LANDED_COMMIT],
          },
    { landing: RepositoryLanding.KanthorD },
  );
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.mergeInputs.length, ONE_CALL);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  await advance(FIRST_ROUND_DELAY_MS);
  assert.equal(h.checkCalls(), ONE_CALL + 1);
  assert.equal(h.node().state, NodeState.Completed);
});

test("no round runs after the Mission Service stops", async (t) => {
  const advance = mockTimers(t);
  const h = deferredFixture(t, PENDING);
  h.release();
  await advance(FIRST_ROUND_DELAY_MS);
  await h.service.stop();
  await advance(DEFERRED_CHECK_RETRY_MS);
  assert.equal(h.checkCalls(), ONE_CALL);
});

function deferredBranchPushFixture(
  t: TestContext,
  check: Awaited<ReturnType<Dependencies["intakeCheck"]["check"]>>,
  gateFiles: string[] = [],
) {
  const h = fixture(t, Intent.Implement, {
    intakeCheck: { check: async () => check, merge: unexpectedCollaboration },
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
      gate_files:
        gateFiles.length === NO_GATE_FILES
          ? null
          : JSON.stringify([{ binding_id: h.binding_id, paths: gateFiles }]),
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
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Completed);
});

test("a human-landing merge push waits in External.Requested until the check answers expected", async (t) => {
  const h = deferredBranchPushFixture(t, SETTLED, ["package.json"]);
  h.release();
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  h.dependencies.intakeCheck.check = async () => COMPLETING;
  resumeDeferredChecks(h.dependencies);
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.Completed);
});

test("a failing deferred check leaves the node unchanged", async (t) => {
  let checkCalls = 0;
  const h = fixture(t, Intent.Implement, {
    intakeCheck: {
      check: async () => {
        checkCalls++;
        throw new Error("check failed");
      },
      merge: unexpectedCollaboration,
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
      gate_files: null,
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
  await deferredCheckEnds(h.calls, t.signal);
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
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.node().state, NodeState.ExternalRequested);
  const row = h.store.transaction((tx) => readEvidence(tx, h.evidenceId));
  assert.equal(row?.end_state, null);
});

function repositoryPairFixture(t: TestContext) {
  const h = fixture(t);
  const secondId = createIdentity("binding");
  const lookup = h.dependencies.bindings.getBindingRevision;
  h.dependencies.bindings.getBindingRevision = (tx, bindingId) => {
    const binding = lookup(tx, bindingId);
    return binding && { ...binding, binding_id: bindingId };
  };
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([h.binding_id, secondId]), h.node_id),
  );
  const evidence = (bindingIds: string[]) =>
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
          provenance: JSON.stringify(h.opener),
          created_at: NOW,
        },
        bindingIds.map((bindingId) => ({
          id: createIdentity("evidence_asset"),
          evidence_id: id,
          kind: AssetKind.Repository,
          content: JSON.stringify({
            binding_id: bindingId,
            commit: "a".repeat(40),
          }),
          published_at: NOW,
          expired_at: null,
        })),
      );
    });
  return { ...h, second_id: secondId, evidence };
}

test("a release with one asset for one of two bindings is refused", (t) => {
  const h = repositoryPairFixture(t);
  h.claim();
  h.evidence([h.binding_id]);
  h.refuses(ReleaseObligation.Evidence);
  h.evidence([h.second_id]);
  h.refuses(ReleaseObligation.Evidence);
  h.evidence([h.binding_id, h.binding_id]);
  h.refuses(ReleaseObligation.Evidence);
  h.evidence([h.binding_id, h.second_id, createIdentity("binding")]);
  h.refuses(ReleaseObligation.Evidence);
});

test("one asset for each of two bindings releases", (t) => {
  const h = repositoryPairFixture(t);
  h.claim();
  h.evidence([h.second_id, h.binding_id]);
  h.release();
  assert.equal(h.node().state, NodeState.Waiting);
});

test("a release answers the states, the rule, the count and the limit", (t) => {
  const h = fixture(t);
  h.claim();
  h.evidence(AssetKind.Repository, true);
  assert.deepEqual(h.release(), {
    from: NodeState.Executing,
    to: NodeState.Waiting,
    rule: TransitionRule.None,
    count: null,
    limit: null,
    first_available_at: null,
  });
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Available));
  h.claim();
  assert.deepEqual(h.release(true, FURTHER_WORK_LIMIT - 1), {
    from: NodeState.Executing,
    to: NodeState.Available,
    rule: TransitionRule.None,
    count: null,
    limit: null,
    first_available_at: null,
  });
  h.claim();
  assert.deepEqual(h.release(true, FURTHER_WORK_LIMIT), {
    from: NodeState.Executing,
    to: NodeState.Paused,
    rule: TransitionRule.FurtherWorkLimit,
    count: FURTHER_WORK_LIMIT,
    limit: h.dependencies.config.further_work_limit,
    first_available_at: null,
  });
});

test("a release of an evaluating node answers the state after the fold", (t) => {
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
      gate_files: null,
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
  assert.deepEqual(h.release(), {
    from: NodeState.Evaluating,
    to: NodeState.Completed,
    rule: TransitionRule.None,
    count: null,
    limit: null,
    first_available_at: null,
  });
});

test("a failure answers the states, the rule, the count and the limit", (t) => {
  const h = fixture(t);
  const failure = (count: number) =>
    h.store.transaction((tx) => h.service.failure(tx, h.node_id, count, NOW));
  h.claim();
  assert.deepEqual(failure(FIRST_ATTEMPT), {
    from: NodeState.Executing,
    to: NodeState.Available,
    rule: TransitionRule.None,
    count: null,
    limit: null,
    first_available_at: null,
  });
  h.claim();
  const limit = h.dependencies.config.consecutive_failure_limit;
  assert.deepEqual(failure(limit), {
    from: NodeState.Executing,
    to: NodeState.Paused,
    rule: TransitionRule.FailureLimit,
    count: limit,
    limit,
    first_available_at: null,
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  assert.deepEqual(failure(FIRST_ATTEMPT), {
    from: NodeState.Evaluating,
    to: NodeState.Waiting,
    rule: TransitionRule.None,
    count: null,
    limit: null,
    first_available_at: null,
  });
});

const RESUMED = "Deferred checks resumed.";
const LIMIT_REACHED = "Deferred check start limit reached.";
const SINGLE_NODE_LIMIT = 1;
const EXPIRED_START = NOW - 1;
const COMPLETING: CheckAnswer = {
  end_state: CheckEndState.Expected,
  landed_commits: [LANDED_COMMIT],
};

test("resume checks an external node with an unresolved request and completes it on expected", async (t) => {
  const h = deferredFixture(t, COMPLETING);
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.ExternalRequested),
  );
  resumeDeferredChecks(h.dependencies);
  await deferredCheckEnds(h.calls, t.signal);
  assert.equal(h.checkCalls(), ONE_CALL);
  assert.equal(h.node().state, NodeState.Completed);
});

test("resume schedules at most the limit and logs the count and the limit warning", async (t) => {
  const h = deferredFixture(t, COMPLETING);
  h.store.transaction((tx) => {
    setNodeState(tx, h.node_id, NodeState.ExternalRequested);
    const olderId = createIdentity("node");
    insertNode(tx, {
      id: olderId,
      mission_id: h.mission_id,
      filename: "older.md",
      created_at: NOW,
    });
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.node_id)!);
    insertRevision(tx, { ...prior, node_id: olderId, filename: "older.md" });
    openAttempt(tx, olderId, FIRST_ATTEMPT, h.opener, EXPIRED_START);
    setNodeState(tx, olderId, NodeState.ExternalRequested);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: olderId,
        attempt: FIRST_ATTEMPT,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.opener),
        created_at: NOW,
      },
      [],
    );
  });
  resumeDeferredChecks(h.dependencies, SINGLE_NODE_LIMIT);
  await deferredCheckEnds(h.calls, t.signal);
  await turn(undefined, { signal: t.signal });
  assert.equal(h.checkCalls(), ONE_CALL);
  assert.deepEqual(h.infos, [
    {
      fields: { count: SINGLE_NODE_LIMIT, limit: SINGLE_NODE_LIMIT },
      message: RESUMED,
    },
  ]);
  assert.deepEqual(h.warnings, [
    { fields: { limit: SINGLE_NODE_LIMIT }, message: LIMIT_REACHED },
  ]);
});

test("resume ignores a node in another state", async (t) => {
  const h = deferredFixture(t, COMPLETING);
  assert.equal(h.node().state, NodeState.Evaluating);
  resumeDeferredChecks(h.dependencies);
  await turn(undefined, { signal: t.signal });
  await turn(undefined, { signal: t.signal });
  assert.equal(h.checkCalls(), NO_CALLS);
  assert.equal(h.node().state, NodeState.Evaluating);
});

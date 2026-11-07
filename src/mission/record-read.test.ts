import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  type MissionBindings,
  nodeSchema,
  NodeState,
  PauseRule,
  RepositoryAction,
  Resolution,
  RevisionWrite,
} from "./contract.ts";
import {
  attemptRecord,
  blockedContextOf,
  evidenceRecord,
  externalActionRecords,
  outcomeRecord,
} from "./record-read.ts";
import {
  type AssetRow,
  insertAssessment,
  insertEvidence,
  insertOutcome,
  openAttempt,
  readEvidence,
} from "./record-store.ts";
import { insertMission, insertNode, readNode, setNodeState } from "./store.ts";
import { nodeRecord } from "./node-read.ts";
import { missionHarness } from "./test-support.ts";

const NOW = 100;
const FIRST_ATTEMPT = 1;
const NO_ATTEMPT = 0;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const SHA = "a".repeat(40);
const SHA256 = "a".repeat(64);
const LOCATION = "s3://bucket/object";
const VERSION = "version";
const MEDIA = "text/plain";
const REQUEST_KEY = "repo.pull_request";

function fixture(t: TestContext, action: RepositoryAction | null = null) {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const nodeId = createIdentity("node");
  const projectId = createIdentity("project");
  const bindingId = createIdentity("binding");
  const bindings: MissionBindings = {
    ...h.dependencies.bindings,
    getBindingRevision: () => ({
      binding_id: bindingId,
      project_id: projectId,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: () => ({
      binding_id: bindingId,
      project_id: projectId,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: "main",
      action,
      landing: "human" as const,
    }),
  };
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
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, intent, tags, external_links, tasks, change, reason, actor, created_at) VALUES (?, 1, 'implement.md', 'name', 'requirement', 'criterion', '[\"true\"]', ?, 'implement', '[]', '[]', '[]', ?, 'reason', ?, ?)",
      )
      .run(
        nodeId,
        canonicalJSON([bindingId]),
        canonicalJSON({
          write: RevisionWrite.NodeCreate,
          previous_revision: null,
          changed_fields: [],
        }),
        canonicalJSON(ACTOR),
        NOW,
      );
  });
  const evidence = (requirementKey: string | null = null) => ({
    id: createIdentity("evidence"),
    node_id: nodeId,
    attempt: FIRST_ATTEMPT,
    subject: "Evidence",
    requirement_key: requirementKey,
    end_state: null,
    verification: null,
    provenance: canonicalJSON(ACTOR),
    created_at: NOW,
  });
  return { ...h, node_id: nodeId, bindings, binding_id: bindingId, evidence };
}

for (const example of [
  {
    event: ClosingEvent.SuccessOverride,
    human: true,
    result: AssessmentResult.Success,
    outcome: AssessmentResult.Success,
    state: NodeState.Completed,
    action: null,
  },
  {
    event: ClosingEvent.HumanDiscard,
    human: true,
    result: AssessmentResult.Undetermined,
    outcome: AssessmentResult.Undetermined,
    state: NodeState.Discarded,
    action: null,
  },
  {
    event: ClosingEvent.HumanBlock,
    human: true,
    result: AssessmentResult.Undetermined,
    outcome: AssessmentResult.Undetermined,
    state: NodeState.Blocked,
    action: null,
  },
  {
    event: ClosingEvent.AssessmentNotPassed,
    human: false,
    result: AssessmentResult.CriterionNotMet,
    outcome: AssessmentResult.CriterionNotMet,
    state: NodeState.Blocked,
    action: null,
  },
  {
    event: ClosingEvent.ExternalFailed,
    human: false,
    result: AssessmentResult.Success,
    outcome: AssessmentResult.Undetermined,
    state: NodeState.Blocked,
    action: RepositoryAction.PullRequest,
  },
  {
    event: ClosingEvent.AssessmentPassed,
    human: false,
    result: AssessmentResult.Success,
    outcome: AssessmentResult.Success,
    state: NodeState.Completed,
    action: null,
  },
  {
    event: ClosingEvent.ExternalSuccess,
    human: false,
    result: AssessmentResult.Success,
    outcome: AssessmentResult.Success,
    state: NodeState.Completed,
    action: RepositoryAction.PullRequest,
  },
]) {
  test(`closing event ${example.event} derives from basis and policy after a request delete`, (t) => {
    const h = fixture(t, example.action);
    h.store.transaction((tx) => {
      const attempt = openAttempt(tx, h.node_id, FIRST_ATTEMPT, ACTOR, NOW);
      const first = h.evidence();
      const second = h.evidence(REQUEST_KEY);
      insertEvidence(tx, first, []);
      insertEvidence(tx, second, []);
      const assessment = insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
        result: example.result,
        rationale: "Reviewed",
        evidence_ids: canonicalJSON([first.id]),
        dependency_outcome_ids: "[]",
        tested_input: null,
        gate_files: null,
        execution_id: example.human ? null : createIdentity("execution"),
        actor: example.human ? canonicalJSON(ACTOR) : null,
        node_revision: FIRST_ATTEMPT,
        created_at: NOW,
      });
      const outcome = insertOutcome(tx, {
        id: createIdentity("outcome"),
        node_id: h.node_id,
        assessment_id: assessment.id,
        result: example.outcome,
        evidence_ids: canonicalJSON([first.id, second.id]),
        created_at: NOW,
      });
      setNodeState(tx, h.node_id, example.state);
      const before = outcomeRecord(tx, h.bindings, outcome);
      assert.equal(before.closing_event, example.event);
      assert.deepEqual(before.evidence_ids, [first.id, second.id].sort());
      assert.equal(before.attempt, FIRST_ATTEMPT);
      assert.equal(before.node_revision, FIRST_ATTEMPT);
      assert.deepEqual(attemptRecord(tx, h.bindings, attempt).outcome_ids, [
        outcome.id,
      ]);
      tx.database
        .prepare("DELETE FROM mission_evidence WHERE id = ?")
        .run(second.id);
      assert.equal(
        outcomeRecord(tx, h.bindings, outcome).closing_event,
        example.event,
      );
    });
  });
}

test("blocked node projection includes its attempt-zero human outcome and no requests", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    const assessment = insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Held",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(ACTOR),
      node_revision: FIRST_ATTEMPT,
      created_at: NOW,
    });
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.node_id,
      result: assessment.result,
      assessment_id: assessment.id,
      evidence_ids: "[]",
      created_at: NOW,
    });
    setNodeState(tx, h.node_id, NodeState.Blocked);
    const row = readNode(tx, h.node_id)!;
    const context = blockedContextOf(tx, h.bindings, row);
    assert.equal(context.outcome.id, outcome.id);
    assert.equal(context.outcome.attempt, NO_ATTEMPT);
    assert.deepEqual(context.requests, []);
    const node = nodeSchema.parse(
      nodeRecord(tx, row, h.bindings, h.dependencies),
    );
    assert.deepEqual(node.blocked_context, context);
    assert.deepEqual(
      externalActionRecords(tx, h.bindings, h.node_id, NO_ATTEMPT),
      [],
    );
  });
});

test("evidence projects every address kind without exposing inline data or storage-only names", (t) => {
  const h = fixture(t, RepositoryAction.PullRequest);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, ACTOR, NOW);
    const row = h.evidence(REQUEST_KEY);
    const asset = (kind: AssetKind, content: unknown): AssetRow => ({
      id: createIdentity("evidence_asset"),
      evidence_id: row.id,
      kind,
      content: canonicalJSON(content),
      published_at: NOW,
      expired_at: null,
    });
    insertEvidence(tx, row, [
      asset(AssetKind.Repository, { binding_id: h.binding_id, commit: SHA }),
      asset(AssetKind.Produced, {
        sha256: SHA256,
        data: "YQ==",
        media_type: MEDIA,
      }),
      asset(AssetKind.Object, {
        location: LOCATION,
        object_version: VERSION,
        sha256: SHA256,
        storage_binding_id: h.binding_id,
        size: FIRST_ATTEMPT,
        media_type: MEDIA,
      }),
      asset(AssetKind.Platform, {
        kind: RepositoryAction.PullRequest,
        resource_identity: "repository:github:owner/repo",
        number: FIRST_ATTEMPT,
      }),
    ]);
    const evidence = evidenceRecord(tx, readEvidence(tx, row.id)!);
    assert.equal(evidence.requirement_key, REQUEST_KEY);
    assert.equal("end_state" in evidence, false);
    assert.equal("verification" in evidence, false);
    assert.deepEqual(
      evidence.assets.find((item) => item.kind === AssetKind.Repository)
        ?.address,
      { kind: AssetKind.Repository, binding_id: h.binding_id, commit: SHA },
    );
    assert.deepEqual(
      evidence.assets.find((item) => item.kind === AssetKind.Produced)?.address,
      { kind: AssetKind.Produced, sha256: SHA256 },
    );
    assert.deepEqual(
      evidence.assets.find((item) => item.kind === AssetKind.Object)?.address,
      {
        kind: AssetKind.Object,
        location: LOCATION,
        version: VERSION,
        sha256: SHA256,
      },
    );
    assert.equal(
      externalActionRecords(tx, h.bindings, h.node_id, FIRST_ATTEMPT)[0]
        ?.resolution,
      Resolution.Unresolved,
    );
    assert.equal(
      externalActionRecords(tx, h.bindings, h.node_id, FIRST_ATTEMPT)[0]
        ?.request_evidence_id,
      row.id,
    );
  });
});

const TRACE_ID = "b".repeat(32);
const FAILURE_LIMIT = 3;
const FURTHER_WORK_LIMIT = 3;
const ONE_STALL = 1;

function lastStop() {
  return {
    execution_id: createIdentity("execution"),
    reason: "operation_failed",
    code: null,
    detail: "boom",
    trace_id: TRACE_ID,
  };
}

function pausedNode(
  t: TestContext,
  facts: {
    consecutive_failures: number;
    consecutive_stalls: number;
    last_stop: ReturnType<typeof lastStop> | null;
  },
) {
  const h = fixture(t);
  h.dependencies.pauseFacts.of = () => facts;
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  return h;
}

function pausedRecord(h: ReturnType<typeof fixture>) {
  return h.store.transaction((tx) =>
    nodeSchema.parse(
      nodeRecord(tx, readNode(tx, h.node_id)!, h.bindings, h.dependencies),
    ),
  );
}

test("a node paused by failed executions answers failure_limit with the count, the limit and the last stop", (t) => {
  const stop = lastStop();
  const h = pausedNode(t, {
    consecutive_failures: FAILURE_LIMIT,
    consecutive_stalls: FURTHER_WORK_LIMIT,
    last_stop: stop,
  });
  assert.deepEqual(pausedRecord(h).paused_context, {
    rule: PauseRule.FailureLimit,
    count: FAILURE_LIMIT,
    limit: FAILURE_LIMIT,
    last_stop: stop,
  });
});

test("a node paused by stalled releases answers further_work_limit with the count and the limit", (t) => {
  const stop = lastStop();
  const h = pausedNode(t, {
    consecutive_failures: ONE_STALL,
    consecutive_stalls: FURTHER_WORK_LIMIT,
    last_stop: stop,
  });
  assert.deepEqual(pausedRecord(h).paused_context, {
    rule: PauseRule.FurtherWorkLimit,
    count: FURTHER_WORK_LIMIT,
    limit: FURTHER_WORK_LIMIT,
    last_stop: stop,
  });
});

test("a turned-off further work limit never answers further_work_limit", (t) => {
  const h = pausedNode(t, {
    consecutive_failures: 0,
    consecutive_stalls: FURTHER_WORK_LIMIT,
    last_stop: null,
  });
  h.dependencies.config.further_work_limit = 0;
  assert.equal(pausedRecord(h).paused_context?.rule, PauseRule.Human);
});

for (const stop of [lastStop(), null]) {
  test(`a node paused by a human answers human with no count, no limit and ${stop === null ? "no last stop" : "the last stop"}`, (t) => {
    const h = pausedNode(t, {
      consecutive_failures: FAILURE_LIMIT - ONE_STALL,
      consecutive_stalls: ONE_STALL,
      last_stop: stop,
    });
    assert.deepEqual(pausedRecord(h).paused_context, {
      rule: PauseRule.Human,
      count: null,
      limit: null,
      last_stop: stop,
    });
  });
}

test("a node in another state answers no paused_context", (t) => {
  const h = fixture(t);
  h.dependencies.pauseFacts.of = () => {
    throw new Error("A node that is not paused reads no pause facts.");
  };
  for (const state of [NodeState.Available, NodeState.Executing]) {
    h.store.transaction((tx) => setNodeState(tx, h.node_id, state));
    assert.equal("paused_context" in pausedRecord(h), false);
  }
});

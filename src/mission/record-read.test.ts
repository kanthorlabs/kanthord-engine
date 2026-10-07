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
  NodeKind,
  NodeState,
  RepositoryAction,
  RevisionWrite,
  Resolution,
  nodeSchema,
  type MissionBindings,
} from "./contract.ts";
import {
  attemptRecord,
  blockedContextOf,
  evidenceRecord,
  externalActionRecords,
  outcomeRecord,
} from "./record-read.ts";
import {
  openAttempt,
  insertEvidence,
  insertAssessment,
  insertOutcome,
  readEvidence,
  type AssetRow,
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
      bindingId,
      projectId,
      name: "repo",
      resourceIdentity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      tombstone: false,
      disabled: false,
    }),
    repositoryPolicyOf: () => ({
      bindingId,
      projectId,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      sshCredential: "github-ssh",
      credential: "github",
      baseBranch: "main",
      action,
      projectPrompt: null,
    }),
  };
  h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, NOW);
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: null,
      created_at: NOW,
    });
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, change, reason, actor, created_at) VALUES (?, 1, 'objective.md', 'name', 'requirement', 'criterion', '[\"true\"]', ?, ?, 'reason', ?, ?)",
      )
      .run(
        nodeId,
        canonicalJSON([bindingId]),
        canonicalJSON({
          write: RevisionWrite.NodeCreate,
          previousRevision: null,
          changedFields: [],
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
  return { ...h, nodeId, bindings, bindingId, evidence };
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
      const attempt = openAttempt(tx, h.nodeId, FIRST_ATTEMPT, ACTOR, NOW);
      const first = h.evidence();
      const second = h.evidence(REQUEST_KEY);
      insertEvidence(tx, first, []);
      insertEvidence(tx, second, []);
      const assessment = insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: h.nodeId,
        attempt: FIRST_ATTEMPT,
        result: example.result,
        rationale: "Reviewed",
        evidence_ids: canonicalJSON([first.id]),
        child_outcome_ids: "[]",
        tested_input: null,
        execution_id: example.human ? null : createIdentity("execution"),
        actor: example.human ? canonicalJSON(ACTOR) : null,
        node_revision: FIRST_ATTEMPT,
        created_at: NOW,
      });
      const outcome = insertOutcome(tx, {
        id: createIdentity("outcome"),
        node_id: h.nodeId,
        assessment_id: assessment.id,
        result: example.outcome,
        evidence_ids: canonicalJSON([first.id, second.id]),
        created_at: NOW,
      });
      setNodeState(tx, h.nodeId, example.state);
      const before = outcomeRecord(tx, h.bindings, outcome);
      assert.equal(before.closingEvent, example.event);
      assert.deepEqual(before.evidenceIds, [first.id, second.id].sort());
      assert.equal(before.attempt, FIRST_ATTEMPT);
      assert.equal(before.nodeRevision, FIRST_ATTEMPT);
      assert.deepEqual(attemptRecord(tx, h.bindings, attempt).outcomeIds, [
        outcome.id,
      ]);
      tx.database
        .prepare("DELETE FROM mission_evidence WHERE id = ?")
        .run(second.id);
      assert.equal(
        outcomeRecord(tx, h.bindings, outcome).closingEvent,
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
      node_id: h.nodeId,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Held",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(ACTOR),
      node_revision: FIRST_ATTEMPT,
      created_at: NOW,
    });
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      result: assessment.result,
      assessment_id: assessment.id,
      evidence_ids: "[]",
      created_at: NOW,
    });
    setNodeState(tx, h.nodeId, NodeState.Blocked);
    const row = readNode(tx, h.nodeId)!;
    const context = blockedContextOf(tx, h.bindings, row);
    assert.equal(context.outcome.id, outcome.id);
    assert.equal(context.outcome.attempt, NO_ATTEMPT);
    assert.deepEqual(context.requests, []);
    const node = nodeSchema.parse(nodeRecord(tx, row, h.bindings));
    assert.ok(node.kind !== NodeKind.Task);
    assert.deepEqual(node.blockedContext, context);
    assert.deepEqual(
      externalActionRecords(tx, h.bindings, h.nodeId, NO_ATTEMPT),
      [],
    );
  });
});

test("evidence projects every address kind without exposing inline data or storage-only names", (t) => {
  const h = fixture(t, RepositoryAction.PullRequest);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, ACTOR, NOW);
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
      asset(AssetKind.Repository, { bindingId: h.bindingId, commit: SHA }),
      asset(AssetKind.Produced, {
        sha256: SHA256,
        data: "YQ==",
        mediaType: MEDIA,
      }),
      asset(AssetKind.Object, {
        location: LOCATION,
        objectVersion: VERSION,
        sha256: SHA256,
        storageBindingId: h.bindingId,
        size: FIRST_ATTEMPT,
        mediaType: MEDIA,
      }),
      asset(AssetKind.Platform, {
        kind: RepositoryAction.PullRequest,
        resource_identity: "repository:github:owner/repo",
        number: FIRST_ATTEMPT,
      }),
    ]);
    const evidence = evidenceRecord(tx, readEvidence(tx, row.id)!);
    assert.equal(evidence.requirementKey, REQUEST_KEY);
    assert.equal("endState" in evidence, false);
    assert.equal("verification" in evidence, false);
    assert.deepEqual(
      evidence.assets.find((item) => item.kind === AssetKind.Repository)
        ?.address,
      { kind: AssetKind.Repository, bindingId: h.bindingId, commit: SHA },
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
      externalActionRecords(tx, h.bindings, h.nodeId, FIRST_ATTEMPT)[0]
        ?.resolution,
      Resolution.Unresolved,
    );
    assert.equal(
      externalActionRecords(tx, h.bindings, h.nodeId, FIRST_ATTEMPT)[0]
        ?.requestEvidenceId,
      row.id,
    );
  });
});

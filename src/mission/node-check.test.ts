import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  CheckEndState,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  Resolution,
  ClosingEvent,
} from "./contract.ts";
import { applyEndState } from "./node-check.ts";
import { outcomeRecord } from "./record-read.ts";
import {
  readCurrentOutcome,
  readLandedCommitEvidence,
  readEvidence,
} from "./record-store.ts";
import { readMission, setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NO_REMOTE_CALLS = 0;
const NO_RESULTS = 0;
const SUCCESS_EXIT_CODE = 0;
const FIRST_RESULT_INDEX = 0;
const NO_LANDED_COMMITS = 0;
const SINGLE_FAILURE = 1;
const PULL_REQUEST_NUMBER = 1;
const FIRST_MISSION_VERSION = 1;
const FIRST_ATTEMPT = 1;
const LANDED_COMMIT_COUNT = 2;
const COMMIT = "a".repeat(40);
const RESOURCE = "repository:github:owner/repo";

test("node check reports Mission authorization refusal without calling Intake", async (t) => {
  const h = await fixture(t);
  const original = h.dependencies.bindings.getBindingRevision;
  h.dependencies.bindings.getBindingRevision = (tx, id) => ({
    ...original(tx, id)!,
    disabled: true,
  });
  const remote = t.mock.method(
    h.dependencies.intakeCheck,
    "check",
    async () => ({ endState: CheckEndState.None, landedCommits: [] }),
  );
  const result = await h.check();
  assert.equal(remote.mock.callCount(), NO_REMOTE_CALLS);
  assert.equal(result.failures.length, SINGLE_FAILURE);
  assert.equal(
    result.failures[0]!.error.error.code,
    MissionErrorCode.AuthorizationRefused,
  );
  assert.deepEqual(result.failures[0]!.error.error.details, {
    reason: "binding_disabled",
  });
});

test("invalid Intake answers leave requests unresolved and stale mission versions refuse result writes", async (t) => {
  const h = await fixture(t);
  for (const answer of [
    { endState: CheckEndState.Expected, landedCommits: [] },
    { endState: CheckEndState.Expected, landedCommits: ["bad"] },
    { endState: CheckEndState.Other, landedCommits: [COMMIT] },
  ]) {
    h.dependencies.intakeCheck.check = async () => answer;
    const result = await h.check();
    assert.equal(result.failures.length, SINGLE_FAILURE);
    assert.equal(result.results.length, NO_RESULTS);
    assert.equal(
      h.store.transaction((tx) => readEvidence(tx, h.request.id)?.end_state),
      null,
    );
  }
  h.dependencies.intakeCheck.check = async () => {
    h.store.transaction((tx) =>
      tx.database
        .prepare(
          "UPDATE mission_mission SET version = version + 1 WHERE id = ?",
        )
        .run(h.missionId),
    );
    return { endState: CheckEndState.Expected, landedCommits: [COMMIT] };
  };
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.VersionConflict,
  );
  assert.equal(
    h.store.transaction((tx) => readEvidence(tx, h.request.id)?.end_state),
    null,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

async function fixture(t: TestContext) {
  const h = evidenceHarness(t, IDENTITY);
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
  const address = {
    kind: AssetKind.Repository,
    bindingId: h.repositoryId,
    commit: COMMIT,
  } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address }],
      verification: {
        testedInput: address,
        results: [
          {
            command: "true",
            exitCode: SUCCESS_EXIT_CODE,
            signal: null,
            timedOut: false,
          },
        ],
      },
    },
  });
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  await h.invoke("assessment.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      evidenceIds: [evidence.evidence.id],
      childOutcomeIds: [],
      result: AssessmentResult.Success,
      rationale: "Passed",
      testedInput: address,
    },
  });
  const request = await h.invoke("evidence.request", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      requirementKey: "repo.pull_request",
      subject: "PR",
      address: {
        kind: PlatformAddressKind.PullRequest,
        resourceIdentity: RESOURCE,
        number: PULL_REQUEST_NUMBER,
      },
    },
  });
  const claim = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  h.store.transaction((tx) =>
    setNodeState(tx, h.nodeId, NodeState.ExternalRequested),
  );
  const check = () =>
    h.invoke("node.check", {
      params: { nodeId: h.nodeId },
      query: {},
      body: { expectedMissionVersion: FIRST_MISSION_VERSION },
    });
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.ok(request.requirementKey);
  return { ...h, request, check, claim };
}

test("expected checks write every landed commit and close successful external attempts without changing mission version", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.Expected,
    landedCommits: [COMMIT, "b".repeat(40)],
  });
  const answer = await h.check();
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.ExpectedEnd,
  );
  assert.equal(h.node().state, NodeState.Completed);
  h.store.transaction((tx) => {
    assert.equal(
      readLandedCommitEvidence(tx, h.nodeId, FIRST_ATTEMPT).length,
      LANDED_COMMIT_COUNT,
    );
    for (const evidence of readLandedCommitEvidence(
      tx,
      h.nodeId,
      FIRST_ATTEMPT,
    ))
      assert.deepEqual(JSON.parse(evidence.provenance), {
        kind: "service",
        service: "mission",
      });
    assert.equal(
      readCurrentOutcome(tx, h.nodeId)?.result,
      AssessmentResult.Success,
    );
    assert.equal(readMission(tx, h.missionId)?.version, FIRST_MISSION_VERSION);
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.NoUnresolvedRequest,
  );
  const before = h.store.transaction((tx) =>
    outcomeRecord(
      tx,
      h.dependencies.bindings,
      readCurrentOutcome(tx, h.nodeId)!,
    ),
  );
  await h.invoke("evidence.delete", {
    params: { evidenceId: h.request.id },
    query: {},
    body: {
      expectedMissionVersion: FIRST_MISSION_VERSION,
      force: true,
      reason: "Remove request",
    },
  });
  const after = h.store.transaction((tx) =>
    outcomeRecord(
      tx,
      h.dependencies.bindings,
      readCurrentOutcome(tx, h.nodeId)!,
    ),
  );
  assert.deepEqual(after, before);
  assert.equal(after.closingEvent, ClosingEvent.ExternalSuccess);
});

test("other checks block while none stays unresolved and failed checks retain failure envelopes", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.None,
    landedCommits: [],
  });
  assert.equal(
    (await h.check()).results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  h.dependencies.intakeCheck.check = async () => {
    throw new Error("private remote failure");
  };
  const failed = await h.check();
  assert.equal(failed.results.length, NO_RESULTS);
  assert.equal(failed.failures.length, SINGLE_FAILURE);
  assert.equal(
    failed.failures[FIRST_RESULT_INDEX]!.error.request_id,
    h.caller.requestId,
  );
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.Other,
    landedCommits: [],
  });
  await h.check();
  assert.equal(h.node().state, NodeState.Blocked);
});

test("a live claim refuses a conclusive result and keeps a none result unresolved", async (t) => {
  const h = await fixture(t);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  h.dependencies.schedulerClaims.liveExecutionOf = h.claim;
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.None,
    landedCommits: [],
  });
  const none = await h.check();
  assert.equal(
    none.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(none.failures.length, NO_RESULTS);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.Expected,
    landedCommits: [COMMIT],
  });
  const refused = await h.check();
  assert.equal(refused.results.length, NO_RESULTS);
  assert.equal(refused.failures.length, SINGLE_FAILURE);
  assert.equal(
    refused.failures[FIRST_RESULT_INDEX]!.error.error.code,
    MissionErrorCode.ClaimLive,
  );
  assert.equal(h.node().state, NodeState.Evaluating);
  h.store.transaction((tx) => {
    assert.equal(readEvidence(tx, h.request.id)?.end_state, null);
    assert.equal(
      readLandedCommitEvidence(tx, h.nodeId, FIRST_ATTEMPT).length,
      NO_LANDED_COMMITS,
    );
  });
});

test("paused nodes keep their state and a concurrent conclusive end state wins", async (t) => {
  const h = await fixture(t);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Paused));
  h.dependencies.intakeCheck.check = async () => {
    h.store.transaction((tx) =>
      applyEndState(
        tx,
        h.dependencies,
        h.request.id,
        { endState: CheckEndState.Other, landedCommits: [] },
        Date.now(),
      ),
    );
    return { endState: CheckEndState.Expected, landedCommits: [COMMIT] };
  };
  const answer = await h.check();
  assert.equal(
    answer.results[FIRST_RESULT_INDEX]!.resolution,
    Resolution.OtherEnd,
  );
  assert.equal(h.node().state, NodeState.Paused);
  h.store.transaction((tx) => {
    assert.equal(
      readEvidence(tx, h.request.id)?.end_state,
      CheckEndState.Other,
    );
    assert.equal(
      readLandedCommitEvidence(tx, h.nodeId, FIRST_ATTEMPT).length,
      NO_LANDED_COMMITS,
    );
  });
});

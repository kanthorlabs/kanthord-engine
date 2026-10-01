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
} from "./contract.ts";
import { applyEndState } from "./node-check.ts";
import {
  readCurrentOutcome,
  readLandedCommitEvidence,
  readEvidence,
} from "./record-store.ts";
import { readMission, setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const COMMIT = "a".repeat(40);
const RESOURCE = "repository:github:owner/repo";

async function fixture(t: TestContext) {
  const h = evidenceHarness(t, IDENTITY);
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId: h.repositoryId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
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
          { command: "true", exitCode: ZERO, signal: null, timedOut: false },
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
        number: ONE,
      },
    },
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.nodeId, NodeState.ExternalRequested),
  );
  const check = () =>
    h.invoke("node.check", {
      params: { nodeId: h.nodeId },
      query: {},
      body: { expectedMissionVersion: ONE },
    });
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.ok(request.requirementKey);
  return { ...h, request, check };
}

test("expected checks write every landed commit and close successful external attempts without changing mission version", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.Expected,
    landedCommits: [COMMIT, "b".repeat(40)],
  });
  const answer = await h.check();
  assert.equal(answer.results[ZERO]!.resolution, Resolution.ExpectedEnd);
  assert.equal(h.node().state, NodeState.Completed);
  h.store.transaction((tx) => {
    assert.equal(readLandedCommitEvidence(tx, h.nodeId, ONE).length, TWO);
    assert.equal(
      readCurrentOutcome(tx, h.nodeId)?.result,
      AssessmentResult.Success,
    );
    assert.equal(readMission(tx, h.missionId)?.version, ONE);
  });
  await assert.rejects(
    h.check(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.NoUnresolvedRequest,
  );
});

test("other checks block while none stays unresolved and failed checks retain failure envelopes", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.None,
    landedCommits: [],
  });
  assert.equal(
    (await h.check()).results[ZERO]!.resolution,
    Resolution.Unresolved,
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  h.dependencies.intakeCheck.check = async () => {
    throw new Error("private remote failure");
  };
  const failed = await h.check();
  assert.equal(failed.results.length, ZERO);
  assert.equal(failed.failures.length, ONE);
  assert.equal(failed.failures[ZERO]!.error.requestId, h.caller.requestId);
  h.dependencies.intakeCheck.check = async () => ({
    endState: CheckEndState.Other,
    landedCommits: [],
  });
  await h.check();
  assert.equal(h.node().state, NodeState.Blocked);
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
  assert.equal(answer.results[ZERO]!.resolution, Resolution.OtherEnd);
  assert.equal(h.node().state, NodeState.Paused);
  h.store.transaction((tx) => {
    assert.equal(
      readEvidence(tx, h.request.id)?.end_state,
      CheckEndState.Other,
    );
    assert.equal(readLandedCommitEvidence(tx, h.nodeId, ONE).length, ZERO);
  });
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  NodeKind,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  Resolution,
  type EvidenceRequest,
} from "./contract.ts";
import { getRevision } from "./node-read.ts";
import { actionStatesOf } from "./frozen-action.ts";
import { insertEvidence, openAttempt } from "./record-store.ts";
import { insertNode, insertRevision, setNodeState } from "./store.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const RESOURCE = "repository:github:owner/repo";
const KEY = "repo.pull_request";
const FIRST = 1;
const ZERO = 0;
const NOW = 200;

function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const nodeId = createIdentity("node");
  const bindingId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = () => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity: RESOURCE,
    revision: FIRST,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    credential: "github",
    baseBranch: "main",
    action: RepositoryAction.PullRequest,
    projectPrompt: null,
  });
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: nodeId,
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: h.nodeId,
      created_at: NOW,
    });
    const revision = getRevision(tx, h.nodeId, FIRST);
    insertRevision(tx, {
      ...revision,
      nodeId,
      filename: "objective.md",
      content: { ...revision.content, bindings: [bindingId] },
      tasks: [],
    });
    openAttempt(tx, nodeId, FIRST, h.executionActor, NOW);
    setNodeState(tx, nodeId, NodeState.Evaluating);
  });
  h.claim.nodeId = nodeId;
  const body: EvidenceRequest = {
    ...h.context,
    subject: "Opened pull request",
    requirementKey: KEY,
    address: {
      kind: PlatformAddressKind.PullRequest,
      resourceIdentity: RESOURCE,
      number: FIRST,
    },
  };
  const request = (input = body) =>
    h.invoke("evidence.request", {
      params: { nodeId },
      query: {},
      body: input,
    });
  assert.equal(h.claim.nodeId, nodeId);
  assert.equal(body.attempt, FIRST);
  return { ...h, nodeId, body, request };
}

test("an evaluation request records one published platform asset and leaves its action unresolved", async (t) => {
  const h = fixture(t);
  const evidence = await h.request();
  assert.equal(evidence.requirementKey, KEY);
  assert.equal(evidence.endState, undefined);
  assert.deepEqual(evidence.provenance, h.executionActor);
  assert.equal(evidence.assets.length, FIRST);
  assert.equal(evidence.assets[ZERO]!.kind, AssetKind.Platform);
  assert.notEqual(evidence.assets[ZERO]!.publishedAt, null);
  assert.deepEqual(evidence.assets[ZERO]!.address, h.body.address);
  const states = h.store.transaction((tx) =>
    actionStatesOf(tx, h.dependencies.bindings, h.nodeId, FIRST),
  );
  assert.equal(states[ZERO]!.resolution, Resolution.Unresolved);
  assert.equal(states[ZERO]!.request?.id, evidence.id);
  await assert.rejects(
    h.request(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RequestAlreadyRequested,
  );
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        insertEvidence(
          tx,
          {
            id: createIdentity("evidence"),
            node_id: h.nodeId,
            attempt: FIRST,
            subject: "Duplicate",
            requirement_key: KEY,
            end_state: null,
            verification: null,
            provenance: canonicalJSON(h.executionActor),
            created_at: NOW,
          },
          [],
        ),
      ),
    /UNIQUE constraint failed/,
  );
});

test("request admission rejects a steps claim, unknown action and mismatched platform kind or resource", async (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Executing));
  await assert.rejects(
    h.request(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionClaimNotEvaluation,
  );
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  await assert.rejects(
    h.request({ ...h.body, requirementKey: "other.pull_request" }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RequestRequirementUnknown,
  );
  const addresses: EvidenceRequest["address"][] = [
    {
      kind: PlatformAddressKind.BranchPush,
      resourceIdentity: RESOURCE,
      branch: "main",
      commit: "a".repeat(40),
    },
    {
      kind: PlatformAddressKind.PullRequest,
      resourceIdentity: "repository:github:foreign/repo",
      number: FIRST,
    },
  ];
  for (const address of addresses)
    await assert.rejects(h.request({ ...h.body, address }), (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.RequestAddressMismatch);
      assert.deepEqual(error.details, { requirementKey: KEY });
      return true;
    });
  const states = h.store.transaction((tx) =>
    actionStatesOf(tx, h.dependencies.bindings, h.nodeId, FIRST),
  );
  assert.equal(states[ZERO]!.resolution, Resolution.Unrequested);
});

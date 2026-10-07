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
const FIRST_ATTEMPT = 1;
const FIRST_INDEX = 0;
const NOW = 200;

function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const nodeId = createIdentity("node");
  const bindingId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: RESOURCE,
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
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
    insertNode(tx, {
      id: nodeId,
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: h.node_id,
      created_at: NOW,
    });
    const revision = getRevision(tx, h.node_id, FIRST_ATTEMPT);
    insertRevision(tx, {
      ...revision,
      node_id: nodeId,
      filename: "objective.md",
      content: { ...revision.content, bindings: [bindingId] },
      tasks: [],
    });
    openAttempt(tx, nodeId, FIRST_ATTEMPT, h.executionActor, NOW);
    setNodeState(tx, nodeId, NodeState.Evaluating);
  });
  h.claim.nodeId = nodeId;
  const body: EvidenceRequest = {
    ...h.context,
    subject: "Opened pull request",
    requirement_key: KEY,
    address: {
      kind: PlatformAddressKind.PullRequest,
      resource_identity: RESOURCE,
      number: FIRST_ATTEMPT,
    },
  };
  const request = (input = body) =>
    h.invoke("evidence.request", {
      params: { node_id: nodeId },
      query: {},
      body: input,
    });
  assert.equal(h.claim.nodeId, nodeId);
  assert.equal(body.attempt, FIRST_ATTEMPT);
  return { ...h, node_id: nodeId, body, request };
}

test("an evaluation request records one published platform asset and leaves its action unresolved", async (t) => {
  const h = fixture(t);
  const evidence = await h.request();
  assert.equal(evidence.requirement_key, KEY);
  assert.equal(evidence.end_state, undefined);
  assert.deepEqual(evidence.provenance, h.executionActor);
  assert.equal(evidence.assets.length, FIRST_ATTEMPT);
  assert.equal(evidence.assets[FIRST_INDEX]!.kind, AssetKind.Platform);
  assert.notEqual(evidence.assets[FIRST_INDEX]!.published_at, null);
  assert.deepEqual(evidence.assets[FIRST_INDEX]!.address, h.body.address);
  const states = h.store.transaction((tx) =>
    actionStatesOf(tx, h.dependencies.bindings, h.node_id, FIRST_ATTEMPT),
  );
  assert.equal(states[FIRST_INDEX]!.resolution, Resolution.Unresolved);
  assert.equal(states[FIRST_INDEX]!.request?.id, evidence.id);
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
            node_id: h.node_id,
            attempt: FIRST_ATTEMPT,
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
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Executing));
  await assert.rejects(
    h.request(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionClaimNotEvaluation,
  );
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  await assert.rejects(
    h.request({ ...h.body, requirement_key: "other.pull_request" }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RequestRequirementUnknown,
  );
  const addresses: EvidenceRequest["address"][] = [
    {
      kind: PlatformAddressKind.BranchPush,
      resource_identity: RESOURCE,
      branch: "main",
      commit: "a".repeat(40),
    },
    {
      kind: PlatformAddressKind.PullRequest,
      resource_identity: "repository:github:foreign/repo",
      number: FIRST_ATTEMPT,
    },
  ];
  for (const address of addresses)
    await assert.rejects(h.request({ ...h.body, address }), (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.RequestAddressMismatch);
      assert.deepEqual(error.details, { requirement_key: KEY });
      return true;
    });
  const states = h.store.transaction((tx) =>
    actionStatesOf(tx, h.dependencies.bindings, h.node_id, FIRST_ATTEMPT),
  );
  assert.equal(states[FIRST_INDEX]!.resolution, Resolution.Unrequested);
});

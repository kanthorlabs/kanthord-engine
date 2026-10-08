import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { z } from "zod";
import type { CallerIdentity } from "../kernel/caller.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  OperationRegistry,
  type CallerContext,
  type ExecutionClaim,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  MISSION_SERVICE_NAME,
  missionOperations,
  ActorKind,
  NodeKind,
  NodeState,
  RevisionWrite,
  type HumanAct,
  AssessmentResult,
  AssetKind,
  PlatformAddressKind,
  RepositoryAction,
  type PlatformAddress,
} from "./contract.ts";
import {
  insertMission,
  insertNode,
  insertRevision,
  readNode,
  setNodeState,
} from "./store.ts";
import { missionMigrations } from "./migrations.ts";
import { MissionService, type Dependencies } from "./service.ts";
import {
  insertAssessment,
  insertEvidence,
  openAttempt,
} from "./record-store.ts";
import { getRevision } from "./node-read.ts";

const CONSECUTIVE_LOSS_LIMIT = 3;
const TEXT_MAX_BYTES = 32768;
const FIXTURE_TIME = 100;
const FIRST_REVISION = 1;
const UNEXPECTED_COLLABORATION = "unexpected collaboration call";

export function unexpectedCollaboration(): never {
  throw new Error(UNEXPECTED_COLLABORATION);
}

export function executionHarness(t: TestContext, identity: CallerIdentity) {
  const h = controlHarness(t, identity);
  const claim: ExecutionClaim = {
    executionId: createIdentity("execution"),
    projectId: h.project_id,
    nodeId: h.node_id,
    attempt: FIRST_REVISION,
    pinnedRevision: FIRST_REVISION,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
  };
  const actor = {
    kind: ActorKind.Execution,
    execution_id: claim.executionId,
    client_id: createIdentity("client_identity"),
    name: "Harness",
  } as const;
  h.dependencies.schedulerClaims.liveExecutionOf = () => ({
    execution_id: claim.executionId,
    runtime_identity: claim.runtimeIdentity,
    attempt: claim.attempt,
    pinned_revision: claim.pinnedRevision,
  });
  h.dependencies.executionAttribution.of = () => ({
    client_id: actor.client_id,
    name: actor.name,
    worker_name: "claude@1",
  });
  h.caller.execution = claim;
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_REVISION, actor, FIXTURE_TIME);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  const context = {
    execution_id: claim.executionId,
    attempt: claim.attempt,
    node_revision: claim.pinnedRevision,
  };
  assert.equal(h.node().attempt, claim.attempt);
  assert.equal(h.node().state, NodeState.Executing);
  return { ...h, claim, context, executionActor: actor };
}

export function evidenceHarness(t: TestContext, identity: CallerIdentity) {
  const h = executionHarness(t, identity);
  const nodeId = createIdentity("node");
  const repositoryId = createIdentity("binding");
  const storageId = createIdentity("binding");
  const storage = {
    binding_id: storageId,
    project_id: h.project_id,
    endpoint: "https://storage.example",
    bucket: "bucket",
    region: "region",
    prefix: "prefix",
    credential: "storage",
    available: true,
  };
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: bindingId === repositoryId ? "repo" : "storage",
    resource_identity:
      bindingId === repositoryId
        ? "repository:github:owner/repo"
        : "storage:s3:bucket",
    revision: FIRST_REVISION,
    tombstone: false,
    disabled: false,
  });
  h.dependencies.bindings.storageBindingOf = () => storage;
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: nodeId,
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: h.node_id,
      created_at: FIXTURE_TIME,
    });
    const revision = getRevision(tx, h.node_id, FIRST_REVISION);
    insertRevision(tx, {
      ...revision,
      node_id: nodeId,
      filename: "objective.md",
      content: { ...revision.content, bindings: [repositoryId, storageId] },
      tasks: [],
    });
    openAttempt(tx, nodeId, FIRST_REVISION, h.executionActor, FIXTURE_TIME);
    setNodeState(tx, nodeId, NodeState.Executing);
  });
  h.claim.nodeId = nodeId;
  const node = () => h.store.transaction((tx) => readNode(tx, nodeId)!);
  assert.equal(node().kind, NodeKind.Objective);
  assert.equal(node().attempt, h.claim.attempt);
  return { ...h, node_id: nodeId, node, repositoryId, storageId, storage };
}

export function controlHarness(
  t: TestContext,
  identity: CallerIdentity,
  overrides: Partial<Dependencies> = {},
) {
  const h = missionHarness(t, identity, overrides);
  const actor = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
  const projectId = createIdentity("project");
  const nodeId = createIdentity("node");
  const missionId = h.store.transaction((tx) => {
    const missionId = insertMission(tx, projectId, FIXTURE_TIME);
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      kind: NodeKind.Initiative,
      filename: "initiative.md",
      parent_id: null,
      created_at: FIXTURE_TIME,
    });
    insertRevision(tx, {
      node_id: nodeId,
      revision: FIRST_REVISION,
      filename: "initiative.md",
      reason: "plan",
      actor,
      created_at: FIXTURE_TIME,
      content: {
        name: "Name",
        requirement: "Requirement",
        criterion: "Criterion",
        verifications: ["true"],
        bindings: [],
      },
      change: {
        write: RevisionWrite.NodeCreate,
        previous_revision: null,
        changed_fields: [],
      },
      pinned_by_attempts: [],
    });
    setNodeState(tx, nodeId, NodeState.Available);
    return missionId;
  });
  const body = (
    state: NodeState = NodeState.Available,
    attempt = 0,
  ): HumanAct => ({
    reason: "Hold",
    expected_mission_version: FIRST_REVISION,
    expected_state: state,
    expected_attempt: attempt,
  });
  const node = () => h.store.transaction((tx) => readNode(tx, nodeId)!);
  return {
    ...h,
    actor,
    project_id: projectId,
    node_id: nodeId,
    mission_id: missionId,
    body,
    node,
  };
}

export function missionHarness(
  t: TestContext,
  identity: CallerIdentity,
  overrides: Partial<Dependencies> = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  const calls: { method: string; arguments: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, arguments: args });
  };
  const dependencies: Dependencies = {
    store,
    intakeStorage: {
      put: unexpectedCollaboration,
      check: unexpectedCollaboration,
      get: unexpectedCollaboration,
      executionGet: unexpectedCollaboration,
      delete: unexpectedCollaboration,
    },
    intakeCheck: { check: unexpectedCollaboration },
    decoder: { decode: unexpectedCollaboration },
    config: {
      consecutive_loss_limit: CONSECUTIVE_LOSS_LIMIT,
      text_max_bytes: TEXT_MAX_BYTES,
    },
    bindings: {
      storageBindingOf: unexpectedCollaboration,
      resolveBinding: (...args) => {
        record("bindings.resolveBinding", args);
        return null;
      },
      resolveBindingIdentity: (...args) => {
        record("bindings.resolveBindingIdentity", args);
        return null;
      },
      getBindingRevision: (...args) => {
        record("bindings.getBindingRevision", args);
        return null;
      },
      repositoryPolicyOf: (...args) => {
        record("bindings.repositoryPolicyOf", args);
        return null;
      },
    },
    workQueue: {
      insert: (...args) => record("workQueue.insert", args),
      delete: (...args) => record("workQueue.delete", args),
      priorityUpdate: (...args) => record("workQueue.priorityUpdate", args),
    },
    schedulerClaims: {
      revoke: (...args) => {
        record("schedulerClaims.revoke", args);
        return null;
      },
      settle: (...args) => record("schedulerClaims.settle", args),
      liveExecutionOf: (...args) => {
        record("schedulerClaims.liveExecutionOf", args);
        return null;
      },
    },
    wakeup: { wake: (...args) => record("wakeup.wake", args) },
    executionAttribution: {
      of: (...args) => {
        record("executionAttribution.of", args);
        return null;
      },
    },
    ...overrides,
  };
  const service = new MissionService(dependencies);
  const registry = new OperationRegistry();
  service.declare(registry);
  let commits = 0;
  const caller: CallerContext = {
    identity,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => {
      commits++;
      return store.transaction(write);
    },
  };
  async function invoke<K extends keyof typeof missionOperations>(
    key: K,
    input: unknown,
  ): Promise<z.output<(typeof missionOperations)[K]["output"]>> {
    const operation = missionOperations[key];
    const parsed = operation.input.parse(input);
    const registered = registry.get(operation.id);
    assert.equal(registered.operation, operation);
    const before = commits;
    const output = await registered.handler(parsed, caller);
    assert.equal(commits, before + 1);
    return operation.output.parse(output) as z.output<
      (typeof missionOperations)[K]["output"]
    >;
  }
  return {
    store,
    service,
    registry,
    caller,
    dependencies,
    calls,
    invoke,
    commits: () => commits,
  };
}

export const ASSESSED_COMMIT = "a".repeat(40);
export const HARNESS_PLATFORM = "github";
export const HARNESS_CREDENTIAL = "github";
export const HARNESS_ACTION_KEY = "repo.pull_request";

export function authorizationHarness(t: TestContext, identity: CallerIdentity) {
  const h = evidenceHarness(t, identity);
  const resourceIdentity = "repository:github:owner/repo";
  const policy = {
    binding_id: h.repositoryId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: HARNESS_PLATFORM,
    ssh_credential: "github-ssh",
    credential: HARNESS_CREDENTIAL,
    base_branch: "main",
    action: RepositoryAction.PullRequest as RepositoryAction,
    project_prompt: null,
  };
  h.dependencies.bindings.repositoryPolicyOf = () => ({ ...policy });
  const assess = (
    result: AssessmentResult = AssessmentResult.Success,
    commit: string = ASSESSED_COMMIT,
  ) =>
    h.store.transaction((tx) =>
      insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: h.node_id,
        attempt: h.claim.attempt,
        result,
        rationale: "Reviewed",
        evidence_ids: "[]",
        child_outcome_ids: "[]",
        tested_input: canonicalJSON({
          kind: AssetKind.Repository,
          binding_id: h.repositoryId,
          commit,
        }),
        execution_id: h.claim.executionId,
        actor: null,
        node_revision: FIRST_REVISION,
        created_at: FIXTURE_TIME,
      }),
    );
  const pullRequest: PlatformAddress = {
    kind: PlatformAddressKind.PullRequest,
    resource_identity: resourceIdentity,
    number: 42,
  };
  const request = (
    address: PlatformAddress = pullRequest,
    nodeId: string = h.node_id,
    key: string = `repo.${policy.action}`,
  ) => {
    const id = createIdentity("evidence");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: nodeId,
          attempt: h.claim.attempt,
          subject: key,
          requirement_key: key,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: FIXTURE_TIME,
        },
        [
          {
            id: createIdentity("asset"),
            evidence_id: id,
            kind: AssetKind.Platform,
            content: canonicalJSON(address),
            published_at: FIXTURE_TIME,
            expired_at: null,
          },
        ],
      ),
    );
    return id;
  };
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  assert.equal(h.node().state, NodeState.Evaluating);
  assert.equal(policy.project_id, h.claim.projectId);
  return {
    ...h,
    policy,
    assess,
    request,
    pullRequest,
    resourceIdentity,
  };
}

const REQUEST_RESOURCE = "repository:github:owner/repo";
export const REQUEST_NUMBER = 1;
const SUCCESS_EXIT_CODE = 0;

export async function externalRequestHarness(
  t: TestContext,
  identity: CallerIdentity,
) {
  const h = evidenceHarness(t, identity);
  h.dependencies.bindings.repositoryPolicyOf = (_tx, bindingId) => ({
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
  const testedInput = {
    kind: AssetKind.Repository,
    binding_id: h.repositoryId,
    commit: ASSESSED_COMMIT,
  } as const;
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verified",
      assets: [{ kind: AssetKind.Repository, address: testedInput }],
      verification: {
        tested_input: testedInput,
        results: [
          {
            command: "true",
            exit_code: SUCCESS_EXIT_CODE,
            signal: null,
            timed_out: false,
          },
        ],
      },
    },
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  await h.invoke("assessment.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      evidence_ids: [evidence.evidence.id],
      child_outcome_ids: [],
      result: AssessmentResult.Success,
      rationale: "Passed",
      tested_input: testedInput,
    },
  });
  const address: PlatformAddress = {
    kind: PlatformAddressKind.PullRequest,
    resource_identity: REQUEST_RESOURCE,
    number: REQUEST_NUMBER,
  };
  const request = await h.invoke("evidence.request", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      requirement_key: "repo.pull_request",
      subject: "PR",
      address,
    },
  });
  const claim = h.dependencies.schedulerClaims.liveExecutionOf;
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.ExternalRequested),
  );
  assert.equal(h.node().state, NodeState.ExternalRequested);
  assert.ok(request.requirement_key);
  return { ...h, request, address, claim };
}

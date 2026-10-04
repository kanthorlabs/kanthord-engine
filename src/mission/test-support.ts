import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { z } from "zod";
import type { CallerIdentity } from "../kernel/caller.ts";
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
import { openAttempt } from "./record-store.ts";
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
    projectId: h.projectId,
    nodeId: h.nodeId,
    attempt: FIRST_REVISION,
    pinnedRevision: FIRST_REVISION,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
  };
  const actor = {
    kind: ActorKind.Execution,
    executionId: claim.executionId,
    clientId: createIdentity("client_identity"),
    name: "Harness",
  } as const;
  h.dependencies.schedulerClaims.liveExecutionOf = () => claim;
  h.dependencies.executionAttribution.of = () => ({
    clientId: actor.clientId,
    name: actor.name,
    workerName: "claude@1",
  });
  h.caller.execution = claim;
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST_REVISION, actor, FIXTURE_TIME);
    setNodeState(tx, h.nodeId, NodeState.Executing);
  });
  const context = {
    executionId: claim.executionId,
    attempt: claim.attempt,
    nodeRevision: claim.pinnedRevision,
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
    bindingId: storageId,
    projectId: h.projectId,
    endpoint: "https://storage.example",
    bucket: "bucket",
    region: "region",
    prefix: "prefix",
    credential: "storage",
    available: true,
  };
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    bindingId,
    projectId: h.projectId,
    name: bindingId === repositoryId ? "repo" : "storage",
    resourceIdentity:
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
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: h.nodeId,
      created_at: FIXTURE_TIME,
    });
    const revision = getRevision(tx, h.nodeId, FIRST_REVISION);
    insertRevision(tx, {
      ...revision,
      nodeId,
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
  return { ...h, nodeId, node, repositoryId, storageId, storage };
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
      nodeId,
      revision: FIRST_REVISION,
      filename: "initiative.md",
      reason: "plan",
      actor,
      createdAt: FIXTURE_TIME,
      content: {
        name: "Name",
        requirement: "Requirement",
        criterion: "Criterion",
        verifications: ["true"],
        bindings: [],
      },
      change: {
        write: RevisionWrite.NodeCreate,
        previousRevision: null,
        changedFields: [],
      },
      pinnedByAttempts: [],
    });
    setNodeState(tx, nodeId, NodeState.Available);
    return missionId;
  });
  const body = (
    state: NodeState = NodeState.Available,
    attempt = 0,
  ): HumanAct => ({
    reason: "Hold",
    expectedMissionVersion: FIRST_REVISION,
    expectedState: state,
    expectedAttempt: attempt,
  });
  const node = () => h.store.transaction((tx) => readNode(tx, nodeId)!);
  return { ...h, actor, projectId, nodeId, missionId, body, node };
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
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes: TEXT_MAX_BYTES,
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

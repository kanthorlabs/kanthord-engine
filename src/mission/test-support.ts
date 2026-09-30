import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { z } from "zod";
import type { CallerIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
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

const CONSECUTIVE_LOSS_LIMIT = 3;
const TEXT_MAX_BYTES = 32768;
const FIXTURE_TIME = 100;
const FIRST_REVISION = 1;

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
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes: TEXT_MAX_BYTES,
    },
    bindings: {
      resolveBinding: (...args) => {
        record("bindings.resolveBinding", args);
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

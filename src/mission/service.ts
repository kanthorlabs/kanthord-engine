import assert from "node:assert/strict";
import { isHumanIdentity } from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Transaction } from "../kernel/store.ts";
import type { MissionConfig } from "./config.ts";
import {
  ActorKind,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeKind,
  missionOperations,
  type HumanActor,
  type MissionBindings,
  type MissionCollaborations,
  type WorkQueue,
  type SchedulerClaims,
  type SchedulerWakeup,
  type ExecutionAttribution,
} from "./contract.ts";
import { addDependency, removeDependency } from "./dependency.ts";
import { pauseNode, readyNode, resumeNode } from "./control-hold.ts";
import { blockNode, discardNode, overrideNode } from "./control-close.ts";
import { unblockNode } from "./control-unblock.ts";
import {
  attemptPage,
  getAttempt,
  externalActionPage,
  getExternalAction,
  assessmentPage,
  getAssessment,
  outcomePage,
  getOutcome,
} from "./record-list.ts";
import { edgeCursor, edgePage } from "./edge-read.ts";
import { exportMission } from "./export.ts";
import { previewImport } from "./import.ts";
import { applyImport } from "./import-apply.ts";
import { createNode } from "./node-create.ts";
import { moveNode } from "./node-move.ts";
import { rebindNodes } from "./node-rebind.ts";
import { planRetirement, retireNode } from "./node-retire.ts";
import { setCriterion, updateNode } from "./node-update.ts";
import {
  getNode,
  getRevision,
  nodeRecord,
  nodeCursor,
  nodePage,
  requireNode,
  revisionCursor,
  revisionPage,
} from "./node-read.ts";
import {
  insertMission,
  readLiveNodesPinning,
  readMissionByProject,
  updateNodePriority,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const QUERY_TRUE = "true";

export function humanActor(caller: CallerContext): HumanActor {
  const identity = caller.identity;
  assert.ok(
    isHumanIdentity(identity),
    "Mission writes require a human identity.",
  );
  return {
    kind: ActorKind.Human,
    account: identity.accountId,
    name: identity.name,
  };
}

export interface Dependencies {
  config: MissionConfig;
  health?: HealthRegistry;
  bindings: MissionBindings;
  workQueue: WorkQueue;
  schedulerClaims: SchedulerClaims;
  wakeup: SchedulerWakeup;
  executionAttribution: ExecutionAttribution;
}

export class MissionService implements Service, MissionCollaborations {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(MISSION_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  declare(registry: OperationRegistry): void {
    registry.register(
      missionOperations["assessment.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          assessmentPage(tx, this.dependencies, params.nodeId, query),
        ),
    );
    registry.register(
      missionOperations["assessment.get"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          getAssessment(tx, this.dependencies, params.assessmentId),
        ),
    );
    registry.register(
      missionOperations["outcome.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          outcomePage(tx, this.dependencies, params.nodeId, query),
        ),
    );
    registry.register(missionOperations["outcome.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getOutcome(tx, this.dependencies, params.outcomeId),
      ),
    );
    registry.register(
      missionOperations["attempt.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          attemptPage(tx, this.dependencies.bindings, params.nodeId, query),
        ),
    );
    registry.register(missionOperations["attempt.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getAttempt(
          tx,
          this.dependencies.bindings,
          params.nodeId,
          params.attempt,
        ),
      ),
    );
    registry.register(
      missionOperations["externalAction.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          externalActionPage(
            tx,
            this.dependencies.bindings,
            params.nodeId,
            query,
          ),
        ),
    );
    registry.register(
      missionOperations["externalAction.get"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          getExternalAction(
            tx,
            this.dependencies.bindings,
            params.nodeId,
            params.attempt,
            params.actionKey,
          ),
        ),
    );
    registry.register(
      missionOperations["node.unblock"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          unblockNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.override"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          overrideNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.block"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          blockNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.discard"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          discardNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.ready"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          readyNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.resume"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          resumeNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.pause"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          pauseNode(
            tx,
            this.dependencies,
            params.nodeId,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(missionOperations.export, ({ params, query }, caller) =>
      caller.commit((tx) =>
        exportMission(
          tx,
          params.missionId,
          query.format,
          this.dependencies.bindings,
        ),
      ),
    );
    registry.register(
      missionOperations["import.apply"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { missionId: params.missionId }, (tx) =>
          applyImport(
            tx,
            params.missionId,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["import.preview"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          previewImport(
            tx,
            requireMission(tx, params.missionId, body.missionVersion),
            body,
            params.missionId,
            this.dependencies.bindings,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["edge.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          edgePage(
            tx,
            params.missionId,
            {
              kind: query.kind,
              nodeId: query.nodeId,
              after:
                query.cursor === undefined
                  ? undefined
                  : edgeCursor(query.cursor),
            },
            query.limit,
          ),
        ),
    );
    registry.register(
      missionOperations["dependency.add"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          addDependency(
            tx,
            params.nodeId,
            params.dependsOnId,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
            this.dependencies.bindings,
            this.dependencies.schedulerClaims,
          ),
        ),
    );
    registry.register(
      missionOperations["dependency.remove"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          removeDependency(
            tx,
            params.nodeId,
            params.dependsOnId,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
            this.dependencies.bindings,
          ),
        ),
    );
    registry.register(
      missionOperations["node.list"],
      ({ params, query }, caller) => {
        const after =
          query.cursor === undefined ? undefined : nodeCursor(query.cursor);
        return caller.commit((tx) =>
          nodePage(
            tx,
            this.dependencies.bindings,
            params.missionId,
            {
              kind: query.kind,
              state: query.state,
              parentId: query.parentId,
              includeRetired: query.includeRetired === QUERY_TRUE,
              after,
            },
            query.limit,
          ),
        );
      },
    );
    registry.register(missionOperations["node.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getNode(tx, params.nodeId, this.dependencies.bindings),
      ),
    );
    registry.register(
      missionOperations["node.revision.list"],
      ({ params, query }, caller) => {
        const after =
          query.cursor === undefined ? undefined : revisionCursor(query.cursor);
        return caller.commit((tx) =>
          revisionPage(tx, params.nodeId, after, query.limit),
        );
      },
    );
    registry.register(
      missionOperations["node.revision.get"],
      ({ params }, caller) =>
        caller.commit((tx) => getRevision(tx, params.nodeId, params.revision)),
    );
    registry.register(
      missionOperations["node.rebind"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          rebindNodes(
            tx,
            params.missionId,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.retire.preview"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          planRetirement(
            tx,
            requireNode(tx, params.nodeId),
            query.force === QUERY_TRUE,
          ),
        ),
    );
    registry.register(
      missionOperations["node.retire"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          retireNode(
            tx,
            params.nodeId,
            body,
            humanActor(caller),
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
            this.dependencies.bindings,
          ),
        ),
    );
    registry.register(
      missionOperations["node.priority.set"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) => {
          const node = requireNode(tx, params.nodeId);
          requireActive(node);
          requireMission(tx, node.mission_id, body.expectedMissionVersion);
          if (node.kind === NodeKind.Task)
            throw new OperationError(
              HttpStatus.BadRequest,
              MissionErrorCode.PriorityTask,
              "Tasks have no priority.",
              { nodeId: node.id },
            );
          requireNonterminal(node);
          const now = Date.now();
          const live = this.dependencies.schedulerClaims.liveExecutionOf(
            tx,
            node.id,
            now,
          );
          if (live !== null)
            throw new OperationError(
              HttpStatus.Conflict,
              MissionErrorCode.ClaimLive,
              "Node has a live claim.",
              { nodeId: node.id, executionId: live.executionId },
            );
          updateNodePriority(tx, node.id, body.value);
          this.dependencies.workQueue.priorityUpdate(tx, node.id, body.value);
          return nodeRecord(
            tx,
            { ...node, priority: body.value },
            this.dependencies.bindings,
          );
        }),
    );
    registry.register(
      missionOperations["node.move"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { nodeId: params.nodeId }, (tx) =>
          moveNode(
            tx,
            params.nodeId,
            body,
            humanActor(caller),
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
            this.dependencies.bindings,
          ),
        ),
    );
    registry.register(
      missionOperations["criterion.set"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          setCriterion(
            tx,
            params.nodeId,
            body,
            humanActor(caller),
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.update"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          updateNode(
            tx,
            params.nodeId,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.create"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { missionId: params.missionId }, (tx) =>
          createNode(
            tx,
            params.missionId,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(missionOperations.get, ({ params }, caller) =>
      caller.commit((tx) => {
        const mission = readMissionByProject(tx, params.projectId);
        if (!mission)
          throw new OperationError(
            HttpStatus.NotFound,
            MissionErrorCode.MissionNotFound,
            "Mission not found.",
          );
        return mission;
      }),
    );
  }

  private commitGraph<T>(
    caller: CallerContext,
    scope: { missionId: string } | { nodeId: string },
    write: (tx: Transaction) => T,
  ): T {
    let projectId: string | null = null;
    const result = caller.commit((tx) => {
      const result = write(tx);
      const missionId =
        "missionId" in scope
          ? scope.missionId
          : requireNode(tx, scope.nodeId).mission_id;
      projectId = requireMission(tx, missionId).projectId;
      return result;
    });
    assert.ok(projectId);
    this.dependencies.wakeup.wake(projectId);
    return result;
  }

  createMission(tx: Transaction, projectId: string, actor: HumanActor): void {
    void actor;
    insertMission(tx, projectId, Date.now());
  }

  liveNodesPinning(tx: Transaction, bindingId: string): string[] {
    return readLiveNodesPinning(tx, bindingId);
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          MISSION_STOPPED_CODE,
          "mission: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }

  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
  }

  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= Promise.resolve(null);
    return this.stopTask;
  }

  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      operations:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

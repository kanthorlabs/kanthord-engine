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
  missionOperations,
  type HumanActor,
  type MissionBindings,
  type MissionCollaborations,
  type WorkQueue,
} from "./contract.ts";
import { addDependency, removeDependency } from "./dependency.ts";
import { edgeCursor, edgePage } from "./edge-read.ts";
import { createNode } from "./node-create.ts";
import { updateNode } from "./node-update.ts";
import {
  getNode,
  getRevision,
  nodeCursor,
  nodePage,
  revisionCursor,
  revisionPage,
} from "./node-read.ts";
import {
  insertMission,
  readLiveNodesPinning,
  readMissionByProject,
} from "./store.ts";

const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const INCLUDE_RETIRED_TRUE = "true";

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
        caller.commit((tx) =>
          addDependency(
            tx,
            params.nodeId,
            params.dependsOnId,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
          ),
        ),
    );
    registry.register(
      missionOperations["dependency.remove"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          removeDependency(
            tx,
            params.nodeId,
            params.dependsOnId,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.textMaxBytes,
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
            params.missionId,
            {
              kind: query.kind,
              state: query.state,
              parentId: query.parentId,
              includeRetired: query.includeRetired === INCLUDE_RETIRED_TRUE,
              after,
            },
            query.limit,
          ),
        );
      },
    );
    registry.register(missionOperations["node.get"], ({ params }, caller) =>
      caller.commit((tx) => getNode(tx, params.nodeId)),
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
        caller.commit((tx) =>
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

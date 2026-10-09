import assert from "node:assert/strict";
import type { Logger } from "pino";
import {
  isHumanIdentity,
  type CallerIdentity,
  type MachineIdentity,
} from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type {
  CallerContext,
  ExecutionClaim,
  OperationRegistry,
} from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
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
  type MissionTransitions,
  type MissionActions,
  type IntakeStorage,
  type IntakeCheck,
  type EventDecoder,
} from "./contract.ts";
import { addDependency, removeDependency } from "./dependency.ts";
import { pauseNode, readyNode, resumeNode } from "./control-hold.ts";
import { blockNode, discardNode, overrideNode } from "./control-close.ts";
import { unblockNode } from "./control-unblock.ts";
import { completeEvidence } from "./evidence-complete.ts";
import { requestEvidence } from "./evidence-request.ts";
import { submitEvidence } from "./evidence-submit.ts";
import { evidencePage, getEvidence } from "./evidence-read.ts";
import { executionContentBound, readContent } from "./evidence-content-read.ts";
import { submitAssessment } from "./assessment-submit.ts";
import { checkNode } from "./node-check.ts";
import { AdmissionQueue, admitDelivery } from "./delivery-admit.ts";
import { deleteEvidenceAsset, removeEvidence } from "./evidence-delete.ts";
import {
  executionRevision,
  executionRevisionPage,
  executionEvidencePage,
  clearedOutcome,
  executionObjectives,
  executionObjectiveOutcomes,
  executionObjectiveEvidence,
} from "./execution-read.ts";
import { claim, release, loss } from "./transitions.ts";
import { actionContextOf } from "./action-context.ts";
import {
  authorizeAction,
  authorizeEvidenceAsset,
  authorizeFrozenAction,
  authorizeObjectPut,
  authorizeRequest,
  authorizeRequestEvidence,
  type AssetUse,
  type ObjectPutInput,
} from "./authorization.ts";
import { repositoryBindingIdsOf } from "./evidence-content.ts";
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
  store: Store;
  intakeStorage: IntakeStorage;
  intakeCheck: IntakeCheck;
  decoder: EventDecoder;
  config: MissionConfig;
  health?: HealthRegistry;
  bindings: MissionBindings;
  workQueue: WorkQueue;
  schedulerClaims: SchedulerClaims;
  wakeup: SchedulerWakeup;
  executionAttribution: ExecutionAttribution;
  logger: Logger;
}

export class MissionService
  implements Service, MissionCollaborations, MissionTransitions, MissionActions
{
  claim(...args: Parameters<MissionTransitions["claim"]>) {
    const [tx, ...rest] = args;
    return claim(tx, this.dependencies, ...rest);
  }

  release(...args: Parameters<MissionTransitions["release"]>) {
    const [tx, ...rest] = args;
    return release(tx, this.dependencies, ...rest);
  }

  loss(...args: Parameters<MissionTransitions["loss"]>) {
    const [tx, ...rest] = args;
    return loss(tx, this.dependencies, ...rest);
  }
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly dependencies: Dependencies;
  private readonly admissions = new AdmissionQueue();

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(MISSION_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  declare(registry: OperationRegistry): void {
    registry.register(
      missionOperations["execution.objective.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionObjectives(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.objective.outcome.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionObjectiveOutcomes(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.objective.evidence.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionObjectiveEvidence(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.evidence.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionEvidencePage(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.clearedOutcome.get"],
      (_input, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          clearedOutcome(tx, this.dependencies, claim),
        );
      },
    );
    registry.register(
      missionOperations["execution.pinnedRevision.get"],
      (_input, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionRevision(tx, this.dependencies, claim),
        );
      },
    );
    registry.register(
      missionOperations["execution.revision.get"],
      ({ params }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionRevision(tx, this.dependencies, claim, params.revision),
        );
      },
    );
    registry.register(
      missionOperations["execution.revision.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionRevisionPage(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["evidence.delete"],
      ({ params, body }, caller) =>
        removeEvidence(this.dependencies, caller, params.evidence_id, body),
    );
    registry.register(
      missionOperations["evidence.asset.delete"],
      ({ params, body }, caller) =>
        deleteEvidenceAsset(this.dependencies, caller, params.asset_id, body),
    );
    registry.register(
      missionOperations["node.check"],
      ({ params, body }, caller) =>
        checkNode(
          this.dependencies,
          caller,
          params.node_id,
          body.expected_mission_version,
        ),
    );
    registry.register(missionOperations["delivery.admit"], ({ body }, caller) =>
      admitDelivery(this.admissions, this.dependencies, caller, body),
    );
    registry.register(
      missionOperations["assessment.submit"],
      ({ params, body }, caller) => {
        const claim = caller.execution;
        assert.ok(claim);
        const result = caller.commit((tx) =>
          submitAssessment(
            tx,
            this.dependencies,
            claim,
            params.node_id,
            body,
            Date.now(),
          ),
        );
        this.dependencies.wakeup.wake(claim.projectId);
        return result;
      },
    );
    registry.register(
      missionOperations["evidence.asset.content.get"],
      ({ params }, caller) =>
        readContent(
          this.dependencies,
          caller,
          params.asset_id,
          () => true,
          false,
        ),
    );
    registry.register(
      missionOperations["execution.evidence.asset.content.get"],
      ({ params }, caller) => {
        assert.ok(caller.execution);
        return readContent(
          this.dependencies,
          caller,
          params.asset_id,
          executionContentBound(this.dependencies, caller.execution),
          true,
        );
      },
    );
    registry.register(
      missionOperations["evidence.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => evidencePage(tx, params.node_id, query)),
    );
    registry.register(missionOperations["evidence.get"], ({ params }, caller) =>
      caller.commit((tx) => getEvidence(tx, params.evidence_id)),
    );
    registry.register(
      missionOperations["evidence.submit"],
      ({ params, body }, caller) =>
        submitEvidence(this.dependencies, caller, params.node_id, body),
    );
    registry.register(
      missionOperations["evidence.request"],
      ({ params, body }, caller) => {
        const claim = caller.execution;
        assert.ok(claim);
        return caller.commit((tx) =>
          requestEvidence(
            tx,
            this.dependencies,
            claim,
            params.node_id,
            body,
            Date.now(),
          ),
        );
      },
    );
    registry.register(
      missionOperations["evidence.asset.complete"],
      ({ params, body }, caller) =>
        completeEvidence(this.dependencies, caller, params.asset_id, body),
    );
    registry.register(
      missionOperations["assessment.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          assessmentPage(tx, this.dependencies, params.node_id, query),
        ),
    );
    registry.register(
      missionOperations["assessment.get"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          getAssessment(tx, this.dependencies, params.assessment_id),
        ),
    );
    registry.register(
      missionOperations["outcome.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          outcomePage(tx, this.dependencies, params.node_id, query),
        ),
    );
    registry.register(missionOperations["outcome.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getOutcome(tx, this.dependencies, params.outcome_id),
      ),
    );
    registry.register(
      missionOperations["attempt.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          attemptPage(tx, this.dependencies.bindings, params.node_id, query),
        ),
    );
    registry.register(missionOperations["attempt.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getAttempt(
          tx,
          this.dependencies.bindings,
          params.node_id,
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
            params.node_id,
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
            params.node_id,
            params.attempt,
            params.action_key,
          ),
        ),
    );
    registry.register(
      missionOperations["node.unblock"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          unblockNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.override"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          overrideNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.block"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          blockNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.discard"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          discardNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.ready"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          readyNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.resume"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          resumeNode(
            tx,
            this.dependencies,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["node.pause"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          pauseNode(
            tx,
            this.dependencies,
            params.node_id,
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
          params.mission_id,
          query.format,
          this.dependencies.bindings,
        ),
      ),
    );
    registry.register(
      missionOperations["import.apply"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { mission_id: params.mission_id }, (tx) =>
          applyImport(
            tx,
            params.mission_id,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
            this.dependencies.schedulerClaims,
          ),
        ),
    );
    registry.register(
      missionOperations["import.preview"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          previewImport(
            tx,
            requireMission(tx, params.mission_id, body.mission_version),
            body,
            params.mission_id,
            this.dependencies.bindings,
            this.dependencies.config.text_max_bytes,
          ),
        ),
    );
    registry.register(
      missionOperations["edge.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          edgePage(
            tx,
            params.mission_id,
            {
              kind: query.kind,
              node_id: query.node_id,
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
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          addDependency(
            tx,
            params.node_id,
            params.depends_on_id,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
            this.dependencies.bindings,
            this.dependencies.schedulerClaims,
          ),
        ),
    );
    registry.register(
      missionOperations["dependency.remove"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          removeDependency(
            tx,
            params.node_id,
            params.depends_on_id,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
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
            params.mission_id,
            {
              kind: query.kind,
              state: query.state,
              parent_id: query.parent_id,
              include_retired: query.include_retired === QUERY_TRUE,
              after,
            },
            query.limit,
          ),
        );
      },
    );
    registry.register(missionOperations["node.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getNode(tx, params.node_id, this.dependencies.bindings),
      ),
    );
    registry.register(
      missionOperations["node.revision.list"],
      ({ params, query }, caller) => {
        const after =
          query.cursor === undefined ? undefined : revisionCursor(query.cursor);
        return caller.commit((tx) =>
          revisionPage(tx, params.node_id, after, query.limit),
        );
      },
    );
    registry.register(
      missionOperations["node.revision.get"],
      ({ params }, caller) =>
        caller.commit((tx) => getRevision(tx, params.node_id, params.revision)),
    );
    registry.register(
      missionOperations["node.rebind"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          rebindNodes(
            tx,
            params.mission_id,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.config.text_max_bytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.retire.preview"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          planRetirement(
            tx,
            requireNode(tx, params.node_id),
            query.force === QUERY_TRUE,
          ),
        ),
    );
    registry.register(
      missionOperations["node.retire"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          retireNode(
            tx,
            params.node_id,
            body,
            humanActor(caller),
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
            this.dependencies.bindings,
          ),
        ),
    );
    registry.register(
      missionOperations["node.priority.set"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { node_id: params.node_id }, (tx) => {
          const node = requireNode(tx, params.node_id);
          requireActive(node);
          requireMission(tx, node.mission_id, body.expected_mission_version);
          if (node.kind === NodeKind.Task)
            throw new OperationError(
              HttpStatus.BadRequest,
              MissionErrorCode.PriorityTask,
              "Tasks have no priority.",
              { node_id: node.id },
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
              { node_id: node.id, execution_id: live.execution_id },
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
        this.commitGraph(caller, { node_id: params.node_id }, (tx) =>
          moveNode(
            tx,
            params.node_id,
            body,
            humanActor(caller),
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
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
            params.node_id,
            body,
            humanActor(caller),
            this.dependencies.config.text_max_bytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.update"],
      ({ params, body }, caller) =>
        caller.commit((tx) =>
          updateNode(
            tx,
            params.node_id,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.config.text_max_bytes,
          ),
        ),
    );
    registry.register(
      missionOperations["node.create"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { mission_id: params.mission_id }, (tx) =>
          createNode(
            tx,
            params.mission_id,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
          ),
        ),
    );
    registry.register(missionOperations.get, ({ params }, caller) =>
      caller.commit((tx) => {
        const mission = readMissionByProject(tx, params.project_id);
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
    scope: { mission_id: string } | { node_id: string },
    write: (tx: Transaction) => T,
  ): T {
    let projectId: string | null = null;
    const result = caller.commit((tx) => {
      const result = write(tx);
      const missionId =
        "mission_id" in scope
          ? scope.mission_id
          : requireNode(tx, scope.node_id).mission_id;
      projectId = requireMission(tx, missionId).project_id;
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

  actionContextOf(tx: Transaction, nodeId: string, attempt: number) {
    return actionContextOf(tx, this.dependencies, nodeId, attempt);
  }
  authorizeRequest(
    tx: Transaction,
    evidenceId: string,
    claim: import("../kernel/operation.ts").ExecutionClaim,
  ) {
    return authorizeRequest(tx, this.dependencies, evidenceId, claim);
  }
  authorizeAction(
    tx: Transaction,
    claim: import("../kernel/operation.ts").ExecutionClaim,
    key: string,
  ) {
    return authorizeAction(tx, this.dependencies, claim, key);
  }
  authorizeFrozenAction(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    input: { key: string; commit: string; reusedEvidenceId: string | null },
  ) {
    return authorizeFrozenAction(tx, this.dependencies, identity, claim, input);
  }
  authorizeRequestEvidence(
    tx: Transaction,
    identity: CallerIdentity,
    evidenceId: string,
    claim: ExecutionClaim | null,
  ) {
    return authorizeRequestEvidence(
      tx,
      this.dependencies,
      identity,
      evidenceId,
      claim,
    );
  }
  authorizeEvidenceAsset(
    tx: Transaction,
    identity: CallerIdentity,
    assetId: string,
    claim: ExecutionClaim | null,
    use: AssetUse,
  ) {
    return authorizeEvidenceAsset(
      tx,
      this.dependencies,
      identity,
      assetId,
      claim,
      use,
    );
  }
  authorizeObjectPut(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    input: ObjectPutInput,
  ) {
    return authorizeObjectPut(tx, this.dependencies, identity, claim, input);
  }

  repositoryBindingIdsOf(
    tx: Transaction,
    nodeId: string,
    nodeRevision: number,
  ) {
    return repositoryBindingIdsOf(
      tx,
      this.dependencies.bindings,
      nodeId,
      nodeRevision,
    );
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

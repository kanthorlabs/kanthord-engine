import { addAbortListener } from "node:events";
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
  cancelled,
  type Context,
  reasonOf,
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
import { isTerminal } from "./admission.ts";
import type { MissionConfig } from "./config.ts";
import {
  ActorKind,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  missionOperations,
  type HumanActor,
  type CurrentNodePin,
  type MissionBindings,
  type MissionCollaborations,
  type MissionEnvironments,
  type WorkQueue,
  type SchedulerClaims,
  type SchedulerMatch,
  type SchedulerWakeup,
  type ExecutionAttribution,
  type MissionTelemetry,
  type MissionTransitions,
  type MissionActions,
  type IntakeStorage,
  type IntakeCheck,
  type EventDecoder,
  type Intent,
  type ImportPreview,
  type ExecutionEnds,
} from "./contract.ts";
import {
  Act,
  recordAct,
  type ActFacts,
  type ActTelemetry,
  type Acted,
} from "./act-telemetry.ts";
import { executionEnds, reportEnds } from "./control.ts";
import { addDependency, removeDependency } from "./dependency.ts";
import { pauseNode, readyNode, resumeNode } from "./control-hold.ts";
import { blockNode, discardNode, overrideNode } from "./control-close.ts";
import { unblockNode } from "./control-unblock.ts";
import { approveProposal } from "./proposal-approve.ts";
import { proposalPage, requireProposal } from "./proposal-read.ts";
import { completeEvidence } from "./evidence-complete.ts";
import { requestEvidence } from "./evidence-request.ts";
import { submitEvidence } from "./evidence-submit.ts";
import { evidencePage, getEvidence } from "./evidence-read.ts";
import { executionContentBound, readContent } from "./evidence-content-read.ts";
import { submitAssessment } from "./assessment-submit.ts";
import { checkNode } from "./node-check.ts";
import {
  AdmissionQueue,
  admitDelivery,
  countUnresolvedRequests,
} from "./delivery-admit.ts";
import { deleteEvidenceAsset, removeEvidence } from "./evidence-delete.ts";
import {
  executionRevision,
  executionRevisionPage,
  executionEvidencePage,
  clearedOutcome,
  clearedAssessment,
  reworkAssessment,
  executionDependencies,
  executionDependencyOutcomes,
  executionDependencyEvidence,
} from "./execution-read.ts";
import { claim, release, failure, nodeBranchesOf } from "./transitions.ts";
import { actionContextOf } from "./action-context.ts";
import { claimFacts, claimFactsOf, openingFacts } from "./claim-facts.ts";
import { guardCoverage } from "./coverage.ts";
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
import { prepareImport } from "./import.ts";
import { applyImport, probeCoverage } from "./import-apply.ts";
import { createNode } from "./node-create.ts";
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
  readCurrentPins,
  readMissionByProject,
  updateNodePriority,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const NO_VIOLATIONS = 0;

class ProbeRollback extends Error {}
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

type WriteScope =
  { mission_id: string } | { node_id: string } | { proposal_id: string };

function projectOf(tx: Transaction, scope: WriteScope): string {
  const missionId =
    "mission_id" in scope
      ? scope.mission_id
      : "node_id" in scope
        ? requireNode(tx, scope.node_id).mission_id
        : requireNode(tx, requireProposal(tx, scope.proposal_id).node_id)
            .mission_id;
  return requireMission(tx, missionId).project_id;
}

export interface Dependencies {
  store: Store;
  intakeStorage: IntakeStorage;
  intakeCheck: IntakeCheck;
  decoder: EventDecoder;
  config: MissionConfig;
  health?: HealthRegistry;
  bindings: MissionBindings;
  environments: MissionEnvironments;
  workQueue: WorkQueue;
  schedulerClaims: SchedulerClaims;
  schedulerMatch: SchedulerMatch;
  wakeup: SchedulerWakeup;
  executionAttribution: ExecutionAttribution;
  telemetry: MissionTelemetry;
  acts: ActTelemetry;
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

  failure(...args: Parameters<MissionTransitions["failure"]>) {
    const [tx, ...rest] = args;
    return failure(tx, this.dependencies, ...rest);
  }

  nodeBranchesOf(...args: Parameters<typeof nodeBranchesOf>) {
    return nodeBranchesOf(...args);
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
      missionOperations["execution.dependency.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionDependencies(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.dependency.outcome.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionDependencyOutcomes(tx, this.dependencies, claim, query),
        );
      },
    );
    registry.register(
      missionOperations["execution.dependency.evidence.list"],
      ({ query }, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          executionDependencyEvidence(tx, this.dependencies, claim, query),
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
      missionOperations["execution.cleared_assessment.get"],
      (_input, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          clearedAssessment(tx, this.dependencies, claim),
        );
      },
    );
    registry.register(
      missionOperations["execution.rework_assessment.get"],
      (_input, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) =>
          reworkAssessment(tx, this.dependencies, claim),
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
      missionOperations["delivery.unresolved_request.count"],
      ({ body }, caller) => countUnresolvedRequests(caller, body),
    );
    registry.register(
      missionOperations["assessment.submit"],
      ({ params, body }, caller) => {
        const claim = caller.execution;
        assert.ok(claim);
        const ends = executionEnds();
        const result = caller.commit((tx) =>
          submitAssessment(
            tx,
            this.dependencies,
            claim,
            params.node_id,
            body,
            Date.now(),
            ends,
          ),
        );
        reportEnds(this.dependencies, ends);
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
      missionOperations["proposal.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => proposalPage(tx, params.node_id, query)),
    );
    registry.register(
      missionOperations["proposal.approve"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.ApproveProposal,
          caller,
          { proposal_id: params.proposal_id },
          (tx, ends) =>
            this.covered(tx, { proposal_id: params.proposal_id }, (tx) =>
              approveProposal(
                tx,
                this.dependencies,
                params.proposal_id,
                body,
                humanActor(caller),
                Date.now(),
                ends,
              ),
            ),
        ),
    );
    registry.register(
      missionOperations["node.unblock"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Unblock,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            this.covered(tx, { node_id: params.node_id }, (tx) =>
              unblockNode(
                tx,
                this.dependencies,
                params.node_id,
                body,
                humanActor(caller),
                Date.now(),
                ends,
              ),
            ),
        ),
    );
    registry.register(
      missionOperations["node.override"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Override,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            overrideNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
            ),
        ),
    );
    registry.register(
      missionOperations["node.block"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Block,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            blockNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
            ),
        ),
    );
    registry.register(
      missionOperations["node.discard"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Discard,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            discardNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
            ),
        ),
    );
    registry.register(
      missionOperations["node.ready"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Ready,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            readyNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
            ),
        ),
    );
    registry.register(
      missionOperations["node.resume"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Resume,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            resumeNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
            ),
        ),
    );
    registry.register(
      missionOperations["node.pause"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.Pause,
          caller,
          { node_id: params.node_id },
          (tx, ends) =>
            pauseNode(
              tx,
              this.dependencies,
              params.node_id,
              body,
              humanActor(caller),
              Date.now(),
              ends,
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
        this.commitGraph(
          caller,
          { mission_id: params.mission_id },
          (tx, ends) =>
            this.covered(tx, { mission_id: params.mission_id }, (tx) =>
              applyImport(
                tx,
                params.mission_id,
                body,
                humanActor(caller),
                this.dependencies.bindings,
                this.dependencies.environments,
                this.dependencies.workQueue,
                this.dependencies.config.text_max_bytes,
                this.dependencies.schedulerClaims,
                ends,
              ),
            ),
        ),
    );
    registry.register(
      missionOperations["import.preview"],
      ({ params, body }, caller) => {
        let probed: ImportPreview | null = null;
        try {
          return caller.commit((tx) => {
            const mission = requireMission(
              tx,
              params.mission_id,
              body.mission_version,
            );
            const prepared = prepareImport(
              tx,
              mission,
              body,
              params.mission_id,
              this.dependencies.bindings,
              this.dependencies.environments,
              this.dependencies.config.text_max_bytes,
            );
            if (prepared.preview.violations.length > NO_VIOLATIONS)
              return prepared.preview;
            probed = {
              ...prepared.preview,
              violations: probeCoverage(
                tx,
                mission,
                prepared,
                body.reason,
                humanActor(caller),
                this.dependencies,
              ),
            };
            throw new ProbeRollback();
          });
        } catch (error) {
          if (!(error instanceof ProbeRollback)) throw error;
          assert.ok(probed);
          return probed;
        }
      },
    );
    registry.register(
      missionOperations["edge.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          edgePage(
            tx,
            params.mission_id,
            {
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
        this.commitGraph(caller, { node_id: params.node_id }, (tx, ends) =>
          addDependency(
            tx,
            params.node_id,
            params.depends_on_id,
            body,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
            this.dependencies.bindings,
            this.dependencies.schedulerClaims,
            ends,
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
              intent: query.intent,
              state: query.state,
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
          this.covered(tx, { mission_id: params.mission_id }, (tx) =>
            rebindNodes(
              tx,
              params.mission_id,
              body,
              humanActor(caller),
              this.dependencies.bindings,
              this.dependencies.environments,
              this.dependencies.config.text_max_bytes,
            ),
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
          this.covered(tx, { node_id: params.node_id }, (tx) =>
            updateNode(
              tx,
              params.node_id,
              body,
              humanActor(caller),
              this.dependencies.bindings,
              this.dependencies.environments,
              this.dependencies.config.text_max_bytes,
            ),
          ),
        ),
    );
    registry.register(
      missionOperations["node.create"],
      ({ params, body }, caller) =>
        this.commitGraph(caller, { mission_id: params.mission_id }, (tx) =>
          this.covered(tx, { mission_id: params.mission_id }, (tx) =>
            createNode(
              tx,
              params.mission_id,
              body,
              humanActor(caller),
              this.dependencies.bindings,
              this.dependencies.environments,
              this.dependencies.workQueue,
              this.dependencies.config.text_max_bytes,
            ),
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

  private covered<T>(
    tx: Transaction,
    scope: WriteScope,
    write: (tx: Transaction) => T,
  ): T {
    return guardCoverage(tx, this.dependencies, projectOf(tx, scope), write);
  }

  private commitGraph<T>(
    caller: CallerContext,
    scope: WriteScope,
    write: (tx: Transaction, ends: ExecutionEnds) => T,
    committed?: () => void,
  ): T {
    let projectId: string | null = null;
    const ends = executionEnds();
    const result = caller.commit((tx) => {
      const result = write(tx, ends);
      projectId = projectOf(tx, scope);
      return result;
    });
    assert.ok(projectId);
    reportEnds(this.dependencies, ends);
    committed?.();
    this.dependencies.wakeup.wake(projectId);
    return result;
  }

  private commitAct<T>(
    act: Act,
    caller: CallerContext,
    scope: WriteScope,
    write: (tx: Transaction, ends: ExecutionEnds) => Acted<T>,
  ): T {
    let facts: ActFacts | null = null;
    return this.commitGraph(
      caller,
      scope,
      (tx, ends) => {
        const acted = write(tx, ends);
        facts = acted.act;
        return acted.result;
      },
      () => {
        assert.ok(facts);
        recordAct(this.dependencies, act, facts);
      },
    );
  }

  createMission(tx: Transaction, projectId: string, actor: HumanActor): void {
    void actor;
    insertMission(tx, projectId, Date.now());
  }

  liveNodesPinning(tx: Transaction, bindingId: string): string[] {
    return readLiveNodesPinning(tx, bindingId);
  }

  currentNodePins(
    tx: Transaction,
    projectId: string,
    bindingIds: readonly string[],
  ): CurrentNodePin[] {
    return readCurrentPins(tx, projectId, bindingIds)
      .filter(({ state }) => !isTerminal(state))
      .map(({ node_id, binding_id }) => ({ node_id, binding_id }));
  }

  claimFacts(tx: Transaction, nodeId: string) {
    return claimFacts(tx, this.dependencies.bindings, nodeId);
  }

  openingFacts(tx: Transaction, nodeId: string) {
    return openingFacts(tx, nodeId);
  }

  claimFactsOf(tx: Transaction, projectId: string) {
    return claimFactsOf(tx, this.dependencies.bindings, projectId);
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
    input: {
      key: string;
      commit: string;
      reusedEvidenceId: string | null;
      mergeEvidenceId: string | null;
    },
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

  intentOf(tx: Transaction, nodeId: string, nodeRevision: number): Intent {
    return getRevision(tx, nodeId, nodeRevision).content.intent;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
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
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await this.start();
    if (error) return error;
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      operations:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

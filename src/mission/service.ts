import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { Logger } from "pino";
import {
  type CallerIdentity,
  isHumanIdentity,
  type MachineIdentity,
  type ServiceIdentity,
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
  type Healthcheck,
  HealthStatus,
  lifecycle,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { ServerTrace } from "../tracking/contract.ts";
import { isTerminal } from "./admission.ts";
import type { MissionConfig } from "./config.ts";
import {
  ActorKind,
  type AttemptPromptStack,
  type ControlResult,
  type CurrentNodePin,
  type EventDecoder,
  type ExecutionAttribution,
  type ExecutionEnds,
  type HumanActor,
  type ImportApply,
  type ImportPreview,
  type ImportResult,
  type IntakeCheck,
  type IntakeGateFiles,
  type IntakeLinks,
  type IntakeStorage,
  type Intent,
  type LinkUpdatePage,
  MISSION_SERVICE_NAME,
  type MissionActions,
  type MissionBindings,
  type MissionCollaborations,
  type MissionEnvironments,
  MissionErrorCode,
  missionOperations,
  type MissionPromptPins,
  type MissionTelemetry,
  type MissionTransitions,
  type NodeBody,
  type NodeStateFact,
  nodeStateSchema,
  type PauseFacts,
  type ReleaseStop,
  type SchedulerClaims,
  type SchedulerMatch,
  type SchedulerWakeup,
  type WorkerStopOrders,
  type WorkQueue,
} from "./contract.ts";
import {
  Act,
  type Acted,
  type ActFacts,
  type ActTelemetry,
  recordAct,
} from "./act-telemetry.ts";
import { type ImportFacts, recordImport } from "./import-telemetry.ts";
import { executionEnds, reportEnds } from "./control.ts";
import { executionReleased } from "./close-release.ts";
import { type PendingClose, PendingCloses } from "./pending-close.ts";
import { addDependency, removeDependency } from "./dependency.ts";
import {
  pauseNode,
  readyNode,
  resumeNode,
  revokeForInstanceArchive,
  revokePausedClaim,
} from "./control-hold.ts";
import { blockNode, discardNode, overrideNode } from "./control-close.ts";
import { unblockNode } from "./control-unblock.ts";
import { decideFollowup } from "./followup-decide.ts";
import { withContent } from "./inbox-item-content.ts";
import { inboxItemPage, markInboxItem } from "./inbox-item.ts";
import { decideProposals } from "./proposal-decide.ts";
import {
  followupPage,
  proposalPage,
  requireAssessment,
} from "./proposal-read.ts";
import { decideFinding } from "./finding-decide.ts";
import {
  findingPage,
  getFinding,
  undecidedFindingPage,
} from "./finding-read.ts";
import { createFinding, updateFinding } from "./finding-report.ts";
import { completeEvidence } from "./evidence-complete.ts";
import { requestEvidence } from "./evidence-request.ts";
import { submitEvidence } from "./evidence-submit.ts";
import { evidencePage, getEvidence } from "./evidence-read.ts";
import {
  downloadContent,
  executionContentBound,
  readContent,
} from "./evidence-content-read.ts";
import { submitAssessment } from "./assessment-submit.ts";
import { serverGateFiles } from "./gate-files.ts";
import { checkNode, resumeDeferredChecks } from "./node-check.ts";
import { DeferredRounds } from "./deferred-rounds.ts";
import {
  AdmissionQueue,
  admitDelivery,
  countUnresolvedRequests,
} from "./delivery-admit.ts";
import { deleteEvidenceAsset, removeEvidence } from "./evidence-delete.ts";
import {
  clearedAssessment,
  clearedOutcome,
  executionDependencies,
  executionDependencyEvidence,
  executionDependencyOutcomes,
  executionEvidencePage,
  executionRevision,
  executionRevisionPage,
  reviewRound,
  reworkAssessment,
} from "./execution-read.ts";
import {
  claim,
  failure,
  nodeBranchesOf,
  release,
  stopped,
} from "./transitions.ts";
import { actionContextOf } from "./action-context.ts";
import { linkUpdatePage, linkUpdatesOf } from "./link-update-read.ts";
import { claimFacts, claimFactsOf, openingFacts } from "./claim-facts.ts";
import { guardCoverage } from "./coverage.ts";
import {
  type AssetUse,
  authorizeAction,
  authorizeEvidenceAsset,
  authorizeFrozenAction,
  authorizeObjectPut,
  authorizeRequest,
  authorizeRequestEvidence,
  authorizeServiceMerge,
  type ObjectPutInput,
} from "./authorization.ts";
import { repositoryBindingIdsOf } from "./evidence-content.ts";
import {
  listAttempts,
  pinPromptCommits,
  readAttempt,
  readEvidence,
  readOpenAttempt,
  readPromptCommits,
} from "./record-store.ts";
import {
  assessmentPage,
  attemptPage,
  externalActionPage,
  getAssessment,
  getAttempt,
  getExternalAction,
  getOutcome,
  outcomePage,
  recordNotFound,
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
  nodeCursor,
  nodePage,
  nodeRecord,
  requireNode,
  revisionCursor,
  revisionPage,
} from "./node-read.ts";
import {
  insertMission,
  readCurrentPins,
  readLiveNodesPinning,
  readMissionByProject,
  readNodeStates,
  updateNodePriority,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";
import { parsePlanFile } from "./parser.ts";

const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const NO_VIOLATIONS = 0;
const DEFERRED_CHECK_RESUME_FAILED = "Deferred check resume failed.";
const NO_DEPENDENCIES = 0;
const LATEST_ATTEMPT_COUNT = 1;
const NodeBodyRefusal = {
  TaskFile: "task_file_forbidden",
  Id: "id_forbidden",
  DependsOn: "depends_on_forbidden",
} as const;

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

function refuseNodeBody(filename: string, reason: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.PlanInvalid,
    `Plan file ${filename}: ${reason}.`,
    { filename, reason },
  );
}

export function nodeBodyOf(filename: string, text: string): NodeBody {
  const parsed = parsePlanFile(filename, text);
  if ("node" in parsed) refuseNodeBody(filename, NodeBodyRefusal.TaskFile);
  if (parsed.id !== undefined) refuseNodeBody(filename, NodeBodyRefusal.Id);
  if (parsed.depends_on.length > NO_DEPENDENCIES)
    refuseNodeBody(filename, NodeBodyRefusal.DependsOn);
  return {
    filename,
    content: {
      name: parsed.name,
      requirement: parsed.requirement,
      criterion: parsed.criterion,
      verifications: parsed.verifications,
      bindings: parsed.bindings,
      intent: parsed.intent,
      tags: parsed.tags,
      ...(parsed.commit_type === undefined
        ? {}
        : { commit_type: parsed.commit_type }),
    },
    tasks: [],
  };
}

function claimLiveRefusal(pending: PendingClose): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.ClaimLive,
    "The node keeps a live claim that waits for its stop.",
    { node_id: pending.node_id, execution_id: pending.execution_id },
  );
}

type WriteScope =
  { mission_id: string } | { node_id: string } | { assessment_id: string };

function projectOf(tx: Transaction, scope: WriteScope): string {
  const missionId =
    "mission_id" in scope
      ? scope.mission_id
      : "node_id" in scope
        ? requireNode(tx, scope.node_id).mission_id
        : requireNode(tx, requireAssessment(tx, scope.assessment_id).node_id)
            .mission_id;
  return requireMission(tx, missionId).project_id;
}

export interface Dependencies {
  store: Store;
  intakeStorage: IntakeStorage;
  intakeCheck: IntakeCheck;
  intakeGateFiles: IntakeGateFiles;
  intakeLinks: IntakeLinks;
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
  workerStopOrders: WorkerStopOrders;
  pauseFacts: PauseFacts;
  telemetry: MissionTelemetry;
  acts: ActTelemetry;
  logger: Logger;
  shutdown?: Context;
  rounds?: DeferredRounds;
  projectPaused(tx: Transaction, projectId: string): boolean;
}

export class MissionService
  implements
    Service,
    MissionCollaborations,
    MissionTransitions,
    MissionActions,
    MissionPromptPins
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

  stopped(...args: Parameters<MissionTransitions["stopped"]>) {
    const [tx, ...rest] = args;
    return stopped(tx, this.dependencies, ...rest);
  }

  nodeBranchesOf(...args: Parameters<typeof nodeBranchesOf>) {
    return nodeBranchesOf(...args);
  }
  private readonly shutdown = new CancellationContext();
  private readonly rounds = new DeferredRounds();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly dependencies: Dependencies;
  private readonly admissions = new AdmissionQueue();
  private readonly closes = new PendingCloses();

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.shutdown = this.shutdown;
    dependencies.rounds = this.rounds;
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
      missionOperations["execution.review_round.get"],
      (_input, caller) => {
        assert.ok(caller.execution);
        const claim = caller.execution;
        return caller.commit((tx) => reviewRound(tx, this.dependencies, claim));
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
      ({ params, body }, caller) => {
        const nodeId = this.dependencies.store.transaction(
          (tx) => readEvidence(tx, params.evidence_id)?.node_id,
        );
        const pending =
          nodeId === undefined ? null : this.closes.ofNode(nodeId);
        if (pending === null)
          return removeEvidence(
            this.dependencies,
            caller,
            params.evidence_id,
            body,
            humanActor(caller),
            this.closes,
          );
        if (
          pending.act === Act.DeleteEvidence &&
          pending.evidence_id === params.evidence_id
        )
          return caller.commit(() => null);
        throw claimLiveRefusal(pending);
      },
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
      ({ body }, caller) =>
        countUnresolvedRequests(this.dependencies, caller, body),
    );
    registry.register(
      missionOperations["assessment.submit"],
      async ({ params, body }, caller) => {
        const claim = caller.execution;
        assert.ok(claim);
        const gateFiles = await serverGateFiles(
          this.dependencies,
          caller,
          params.node_id,
          body,
        );
        const ends = executionEnds();
        const result = caller.commit((tx) =>
          submitAssessment(
            tx,
            this.dependencies,
            claim,
            params.node_id,
            body,
            gateFiles,
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
      missionOperations["evidence.asset.content.download"],
      ({ params, query }, caller) =>
        downloadContent(this.dependencies, caller, {
          assetId: params.asset_id,
          range: query,
        }),
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
      missionOperations["link_update.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          linkUpdatePage(tx, this.dependencies.bindings, params.node_id, query),
        ),
    );
    registry.register(
      missionOperations["inbox_item.list"],
      async ({ query }, caller) => {
        const page = this.dependencies.store.transaction((tx) =>
          inboxItemPage(tx, this.dependencies.bindings, query, Date.now()),
        );
        const items = await withContent(
          this.dependencies.intakeLinks,
          caller.context,
          page.items,
        );
        return caller.commit(() => ({ ...page, items }));
      },
    );
    registry.register(
      missionOperations["inbox_item.done"],
      async ({ params, body }, caller) => {
        const thread = this.dependencies.store.transaction((tx) =>
          markInboxItem(
            tx,
            this.dependencies.bindings,
            params.link_update_id,
            body,
            Date.now(),
          ),
        );
        const [item] = await withContent(
          this.dependencies.intakeLinks,
          caller.context,
          [thread],
        );
        assert.ok(item);
        return caller.commit(() => item);
      },
    );
    registry.register(
      missionOperations["proposal.decide"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.DecideProposals,
          caller,
          { assessment_id: params.assessment_id },
          (tx, ends) =>
            this.covered(tx, { assessment_id: params.assessment_id }, (tx) =>
              decideProposals(
                tx,
                this.dependencies,
                params.assessment_id,
                body,
                humanActor(caller),
                Date.now(),
                ends,
              ),
            ),
        ),
    );
    registry.register(
      missionOperations["followup.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => followupPage(tx, params.project_id, query)),
    );
    registry.register(
      missionOperations["followup.decide"],
      ({ params, body }, caller) =>
        this.commitAct(
          Act.DecideFollowup,
          caller,
          { node_id: params.node_id },
          (tx) =>
            this.covered(tx, { node_id: params.node_id }, (tx) =>
              decideFollowup(
                tx,
                this.dependencies,
                params.node_id,
                body,
                humanActor(caller),
                Date.now(),
              ),
            ),
        ),
    );
    registry.register(
      missionOperations["finding.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) => findingPage(tx, params.node_id, query)),
    );
    registry.register(missionOperations["finding.get"], ({ params }, caller) =>
      caller.commit((tx) => getFinding(tx, params.finding_id)),
    );
    registry.register(
      missionOperations["finding.undecided.list"],
      ({ params, query }, caller) =>
        caller.commit((tx) =>
          undecidedFindingPage(tx, params.project_id, query),
        ),
    );
    registry.register(
      missionOperations["finding.decide"],
      ({ params, body }, caller) =>
        this.commitFindingAct(Act.DecideFinding, caller, (tx) =>
          decideFinding(
            tx,
            params.finding_id,
            body,
            humanActor(caller),
            this.dependencies.config.text_max_bytes,
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["finding.create"],
      ({ params, body }, caller) =>
        this.commitFindingAct(Act.CreateFinding, caller, (tx) =>
          createFinding(
            tx,
            params.node_id,
            body,
            humanActor(caller),
            Date.now(),
          ),
        ),
    );
    registry.register(
      missionOperations["finding.update"],
      ({ params, body }, caller) =>
        this.commitFindingAct(Act.UpdateFinding, caller, (tx) =>
          updateFinding(tx, params.finding_id, body, Date.now()),
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
        this.repeatedClose(caller, params.node_id, Act.Override) ??
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
          (held, trace, attempt) => ({
            act: Act.Override,
            execution_id: held.execution_id,
            node_id: params.node_id,
            attempt,
            actor: humanActor(caller),
            trace,
            body,
            result: held.result,
          }),
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
        this.repeatedClose(caller, params.node_id, Act.Discard) ??
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
          (held, trace, attempt) => ({
            act: Act.Discard,
            execution_id: held.execution_id,
            node_id: params.node_id,
            attempt,
            actor: humanActor(caller),
            trace,
            body,
            result: held.result,
          }),
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
        this.importApplied(params.mission_id, body, caller),
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
            this.dependencies,
          ),
        );
      },
    );
    registry.register(missionOperations["node.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getNode(
          tx,
          params.node_id,
          this.dependencies.bindings,
          this.dependencies,
        ),
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
              this.dependencies,
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
            this.dependencies,
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

  private importApplied(
    missionId: string,
    body: ImportApply,
    caller: CallerContext,
  ): ImportResult {
    const observed: {
      facts: Omit<ImportFacts, "version_to" | "error_type"> | null;
    } = { facts: null };
    let result: ImportResult;
    try {
      result = this.commitGraph(caller, { mission_id: missionId }, (tx, ends) =>
        this.covered(tx, { mission_id: missionId }, (tx) =>
          applyImport(
            tx,
            missionId,
            body,
            humanActor(caller),
            this.dependencies.bindings,
            this.dependencies.environments,
            this.dependencies.workQueue,
            this.dependencies.config.text_max_bytes,
            this.dependencies.schedulerClaims,
            ends,
            (facts) => {
              observed.facts = facts;
            },
          ),
        ),
      );
    } catch (error) {
      if (error instanceof OperationError && observed.facts !== null)
        recordImport(this.dependencies, {
          ...observed.facts,
          version_to: observed.facts.version_from,
          error_type: error.code,
        });
      throw error;
    }
    assert.ok(observed.facts);
    recordImport(this.dependencies, {
      ...observed.facts,
      version_to: result.mission_version,
      error_type: null,
    });
    return result;
  }

  private repeatedClose(
    caller: CallerContext,
    nodeId: string,
    act: PendingClose["act"],
  ): ControlResult | null {
    const pending = this.closes.ofNode(nodeId);
    if (pending === null) return null;
    if (pending.act !== act || pending.act === Act.DeleteEvidence)
      throw claimLiveRefusal(pending);
    return caller.commit(() => pending.result);
  }

  private commitAct<T>(
    act: Act,
    caller: CallerContext,
    scope: WriteScope,
    write: (tx: Transaction, ends: ExecutionEnds) => Acted<T>,
    pendingOf?: (
      held: NonNullable<Acted<T>["pendingClose"]>,
      trace: ServerTrace | null,
      attempt: number,
    ) => PendingClose,
  ): T {
    if ("node_id" in scope) {
      const pending = this.closes.ofNode(scope.node_id);
      if (pending !== null) throw claimLiveRefusal(pending);
    }
    let facts: ActFacts | null = null;
    let stopOrder: Acted<T>["stopOrder"];
    let pendingClose: Acted<T>["pendingClose"];
    return this.commitGraph(
      caller,
      scope,
      (tx, ends) => {
        const acted = write(tx, ends);
        facts = acted.act;
        stopOrder = acted.stopOrder;
        pendingClose = acted.pendingClose;
        return acted.result;
      },
      () => {
        assert.ok(facts);
        const trace = recordAct(this.dependencies, act, facts);
        if (pendingClose) {
          assert.ok(pendingOf);
          this.closes.add(pendingOf(pendingClose, trace, facts.attempt));
        }
        if (stopOrder)
          this.dependencies.workerStopOrders.sendStopOrder(
            stopOrder.execution_id,
            stopOrder.runtime_identity,
            "human_paused",
          );
      },
    );
  }

  private commitFindingAct<T>(
    act: Act,
    caller: CallerContext,
    write: (tx: Transaction) => Acted<T>,
  ): T {
    let facts: ActFacts | null = null;
    const result = caller.commit((tx) => {
      const acted = write(tx);
      facts = acted.act;
      return acted.result;
    });
    assert.ok(facts);
    recordAct(this.dependencies, act, facts);
    return result;
  }

  createMission(tx: Transaction, projectId: string, actor: HumanActor): void {
    void actor;
    insertMission(tx, projectId, Date.now());
  }

  nodeStates(
    tx: Transaction,
    nodeIds: readonly string[],
  ): Map<string, NodeStateFact> {
    const states = new Map<string, NodeStateFact>();
    for (const [id, fact] of readNodeStates(tx, nodeIds))
      states.set(id, {
        state: nodeStateSchema.parse(fact.state),
        retired: fact.retired,
      });
    return states;
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

  revokeForInstanceArchive(
    tx: Transaction,
    executionId: string,
    instance: string,
    actor: HumanActor,
  ) {
    return revokeForInstanceArchive(
      tx,
      this.dependencies,
      executionId,
      instance,
      actor,
      Date.now(),
    );
  }

  executionReleased(executionId: string, stop: ReleaseStop | null): void {
    executionReleased(this.dependencies, this.closes, executionId, stop);
  }

  revokePausedClaim(executionId: string) {
    return revokePausedClaim(this.dependencies, executionId, Date.now());
  }

  reportExecutionEnds(ends: ExecutionEnds): void {
    reportEnds(this.dependencies, ends);
  }

  actionContextOf(tx: Transaction, nodeId: string, attempt: number) {
    return actionContextOf(tx, this.dependencies, nodeId, attempt);
  }
  linkUpdatesOf(
    tx: Transaction,
    nodeId: string,
    attempt: number,
    page: LinkUpdatePage,
  ) {
    return linkUpdatesOf(tx, this.dependencies.bindings, nodeId, attempt, page);
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
      commit: string | null;
      reusedEvidenceId: string | null;
      mergeEvidenceId: string | null;
    },
  ) {
    return authorizeFrozenAction(tx, this.dependencies, identity, claim, input);
  }
  authorizeServiceMerge(
    tx: Transaction,
    identity: ServiceIdentity,
    input: { evidenceId: string; commit: string },
  ) {
    return authorizeServiceMerge(tx, this.dependencies, identity, input);
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

  attemptPromptCommits(
    ...args: Parameters<MissionPromptPins["attemptPromptCommits"]>
  ) {
    return readPromptCommits(...args);
  }

  pinPromptCommits(...args: Parameters<MissionPromptPins["pinPromptCommits"]>) {
    return pinPromptCommits(...args);
  }

  attemptPromptStackOf(
    tx: Transaction,
    nodeId: string,
    attempt: number | null,
  ): AttemptPromptStack {
    requireNode(tx, nodeId);
    const row =
      attempt === null
        ? (readOpenAttempt(tx, nodeId) ??
          listAttempts(tx, nodeId, null, LATEST_ATTEMPT_COUNT)[0] ??
          null)
        : readAttempt(tx, nodeId, attempt);
    if (row === null) recordNotFound();
    return {
      attempt: row.attempt,
      binding_ids: repositoryBindingIdsOf(
        tx,
        this.dependencies.bindings,
        nodeId,
        row.node_revision,
      ),
      prompt_commits: readPromptCommits(tx, nodeId, row.attempt),
    };
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
    this.rounds.quiesce();
    return this.quiesceTask;
  }

  drain(): Promise<void> {
    return this.rounds.drain();
  }

  stop(): Promise<Error | null> {
    void this.quiesce();
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= lifecycle(() => this.drain());
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
    try {
      resumeDeferredChecks(this.dependencies);
    } catch (error) {
      this.dependencies.logger.warn({ error }, DEFERRED_CHECK_RESUME_FAILED);
    }
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

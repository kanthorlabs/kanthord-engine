import assert from "node:assert/strict";
import { z } from "zod";
import { background, type Context } from "../kernel/context.ts";
import { type ErrorBody, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { ResultClass } from "../intake/contract.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  actorSchema,
  ActorService,
  AssessmentResult,
  AssetKind,
  CheckEndState,
  checkEndStateSchema,
  commitSchema,
  type IntakeCheck,
  MissionErrorCode,
  NodeState,
  platformAddressSchema,
  RepositoryAction,
  RepositoryLanding,
  Resolution,
} from "./contract.ts";
import {
  closeExternalAttempt,
  requireRunnable,
  transition,
} from "./control.ts";
import { actionStatesOf, requiredActionsOf } from "./frozen-action.ts";
import { gateFilesOf } from "./gate-files.ts";
import { requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  insertEvidence,
  readAssets,
  readAttempt,
  readDeferredCheckNodes,
  readEvidence,
  readOpenAttempt,
  readRequests,
} from "./record-store.ts";
import { claimableMap, reconcileMission } from "./routing.ts";
import { type NodeRow, readNode, setNodeState } from "./store.ts";
import type { Dependencies } from "./service.ts";
import { type DeferredRounds, IMMEDIATE_DELAY_MS } from "./deferred-rounds.ts";
import { requireMission } from "./write.ts";
import { assessedCommitOf, authorizeRequest } from "./authorization.ts";
import { currentAssessmentOf } from "./currency.ts";

const NO_LANDED_COMMITS = 0;
const FIRST_ASSET_INDEX = 0;
const NO_UNRESOLVED_REQUESTS = 0;
const SINGLE_ASSET_COUNT = 1;
const EXPECTED_ROW_CHANGE = 1;
const NO_GATE_FILES = 0;
const FIRST_ROUND = 0;
const NEXT_ROUND_STEP = 1;
const FIRST_ROW_INDEX = 0;
const OVERFLOW_PROBE_ROWS = 1;
export const DEFERRED_CHECK_RETRY_MS = 60000;
export const DEFERRED_CHECK_ROUND_LIMIT = 60;
export const DEFERRED_CHECK_START_LIMIT = 50;
const DEFERRED_CHECKS_RESUMED = "Deferred checks resumed.";
const DEFERRED_CHECK_LIMIT_REACHED = "Deferred check start limit reached.";
const DEFERRED_MERGE_FAILED = "Deferred merge failed.";
const DEFERRED_RUN_PREFIX = "deferred";
const RETRIED_MERGE_CLASSES: readonly string[] = [
  ResultClass.ConfirmedFailure,
  ResultClass.RetryableRefusal,
  ResultClass.UnknownOutcome,
];
const MergeOutcome = {
  Merged: "merged",
  Retry: "retry",
  Stop: "stop",
} as const;
type MergeOutcome = (typeof MergeOutcome)[keyof typeof MergeOutcome];
export const LANDED_COMMIT_SUBJECT = "Landed commit";
type CheckAnswer = Awaited<ReturnType<IntakeCheck["check"]>>;
const checkAnswerSchema = z
  .strictObject({
    end_state: checkEndStateSchema,
    landed_commits: z.array(commitSchema),
  })
  .refine((answer) =>
    answer.end_state === CheckEndState.Expected
      ? answer.landed_commits.length > NO_LANDED_COMMITS
      : answer.landed_commits.length === NO_LANDED_COMMITS,
  );

export function changesNothing(endState: CheckAnswer["end_state"]): boolean {
  return (
    endState === CheckEndState.None || endState === CheckEndState.ChecksPending
  );
}

export function requestContext(
  tx: Transaction,
  dependencies: Dependencies,
  evidenceId: string,
) {
  const request = readEvidence(tx, evidenceId);
  if (!request) recordNotFound();
  assert.ok(request.requirement_key);
  const attempt = readAttempt(tx, request.node_id, request.attempt);
  assert.ok(attempt);
  const frozenAction = requiredActionsOf(
    tx,
    dependencies.bindings,
    request.node_id,
    attempt.node_revision,
  ).find((action) => action.key === request.requirement_key);
  assert.ok(frozenAction);
  const assets = readAssets(tx, evidenceId);
  assert.equal(assets.length, SINGLE_ASSET_COUNT);
  assert.equal(assets[FIRST_ASSET_INDEX]!.kind, AssetKind.Platform);
  return {
    request,
    frozen_action: frozenAction,
    address: platformAddressSchema.parse(
      JSON.parse(assets[FIRST_ASSET_INDEX]!.content),
    ),
  };
}

export function foldExternalState(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  attempt: number,
  now: number,
): void {
  if (node.state !== NodeState.ExternalRequested) return;
  if (readOpenAttempt(tx, node.id)?.attempt !== attempt) return;
  const states = actionStatesOf(tx, dependencies.bindings, node.id, attempt);
  if (states.some((state) => state.resolution === Resolution.OtherEnd))
    setNodeState(tx, node.id, NodeState.ExternalFailed);
  else if (states.every((state) => state.resolution === Resolution.ExpectedEnd))
    setNodeState(tx, node.id, NodeState.ExternalSuccess);
  closeExternalAttempt(tx, dependencies, requireNode(tx, node.id), now);
}

export function applyEndState(
  tx: Transaction,
  dependencies: Dependencies,
  evidenceId: string,
  answer: CheckAnswer,
  now: number,
  admission?: { inboundEventId: string },
): void {
  checkAnswerSchema.parse(answer);
  const provenance = actorSchema.parse({
    kind: ActorKind.Service,
    service: ActorService.Mission,
    ...(admission === undefined
      ? {}
      : { inbound_event_id: admission.inboundEventId }),
  });
  const { request, frozen_action: frozenAction } = requestContext(
    tx,
    dependencies,
    evidenceId,
  );
  const node = requireNode(tx, request.node_id);
  const mission = requireMission(tx, node.mission_id);
  const before = claimableMap(tx, mission.id, dependencies.bindings);
  if (request.end_state !== null || changesNothing(answer.end_state)) return;
  if (
    answer.end_state === CheckEndState.Conflict ||
    answer.end_state === CheckEndState.ChecksFailed
  ) {
    if (
      node.state === NodeState.ExternalRequested &&
      readOpenAttempt(tx, node.id)?.attempt === request.attempt
    )
      transition(tx, dependencies, mission, node, NodeState.Available, now);
    return;
  }
  const write = tx.database
    .prepare(
      "UPDATE mission_evidence SET end_state = ? WHERE id = ? AND end_state IS NULL",
    )
    .run(answer.end_state, evidenceId);
  assert.equal(write.changes, EXPECTED_ROW_CHANGE);
  if (answer.end_state === CheckEndState.Expected) {
    for (const commit of answer.landed_commits) {
      const id = createIdentity("evidence");
      insertEvidence(
        tx,
        {
          id,
          node_id: node.id,
          attempt: request.attempt,
          subject: LANDED_COMMIT_SUBJECT,
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(provenance),
          created_at: now,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Repository,
            content: canonicalJSON({
              binding_id: frozenAction.binding_id,
              commit,
            }),
            published_at: now,
            expired_at: null,
          },
        ],
      );
    }
  }
  if (
    node.state === NodeState.ExternalRequested &&
    readOpenAttempt(tx, node.id)?.attempt === request.attempt
  )
    foldExternalState(tx, dependencies, node, request.attempt, now);
  else
    reconcileMission(
      tx,
      dependencies.workQueue,
      mission.id,
      mission.project_id,
      before,
      dependencies.bindings,
    );
}

function checkError(error: unknown, requestId: string): ErrorBody {
  return {
    request_id: requestId,
    error:
      error instanceof OperationError
        ? { code: error.code, message: error.message, details: error.details }
        : {
            code: "system.operation.unknown",
            message: "Operation failed.",
            details: null,
          },
  };
}

export async function checkNode(
  dependencies: Dependencies,
  caller: CallerContext,
  nodeId: string,
  expectedMissionVersion: number,
) {
  const prepared = dependencies.store.transaction((tx) => {
    const node = requireNode(tx, nodeId);
    requireRunnable(node);
    const mission = requireMission(tx, node.mission_id, expectedMissionVersion);
    const attempt = readOpenAttempt(tx, nodeId);
    const requests =
      attempt === null
        ? []
        : readRequests(tx, nodeId, attempt.attempt)
            .filter((row) => row.end_state === null)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => requestContext(tx, dependencies, row.id));
    if (requests.length === NO_UNRESOLVED_REQUESTS)
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.NoUnresolvedRequest,
        "The node has no unresolved request.",
      );
    return { mission, requests };
  });
  const failures: { evidence_id: string; error: ErrorBody }[] = [];
  const checked: string[] = [];
  for (const item of prepared.requests) {
    let answer: CheckAnswer;
    try {
      dependencies.store.transaction((tx) =>
        authorizeRequest(tx, dependencies, item.request.id),
      );
      answer = checkAnswerSchema.parse(
        await dependencies.intakeCheck.check(caller.context, item.request.id),
      );
    } catch (error) {
      failures.push({
        evidence_id: item.request.id,
        error: checkError(error, caller.requestId),
      });
      continue;
    }
    const live = dependencies.store.transaction((tx) => {
      requireMission(tx, prepared.mission.id, expectedMissionVersion);
      const now = Date.now();
      const claim = changesNothing(answer.end_state)
        ? null
        : dependencies.schedulerClaims.liveExecutionOf(
            tx,
            item.request.node_id,
            now,
          );
      if (claim === null)
        applyEndState(tx, dependencies, item.request.id, answer, now);
      return claim;
    });
    if (live !== null) {
      failures.push({
        evidence_id: item.request.id,
        error: checkError(
          new OperationError(
            HttpStatus.Conflict,
            MissionErrorCode.ClaimLive,
            "Node has a live claim.",
            { node_id: item.request.node_id, execution_id: live.execution_id },
          ),
          caller.requestId,
        ),
      });
      continue;
    }
    checked.push(item.request.id);
  }
  const result = caller.commit((tx) => ({
    results: checked.map((id) => {
      const row = readEvidence(tx, id);
      if (!row) recordNotFound();
      assert.ok(row.requirement_key);
      return {
        evidence_id: id,
        requirement_key: row.requirement_key,
        resolution:
          row.end_state === null
            ? Resolution.Unresolved
            : row.end_state === CheckEndState.Expected
              ? Resolution.ExpectedEnd
              : Resolution.OtherEnd,
      };
    }),
    failures,
  }));
  dependencies.wakeup.wake(prepared.mission.project_id);
  return result;
}

type RequestItem = ReturnType<typeof requestContext>;
type RoundOutcome = { merged: boolean; pending: boolean; failed: boolean };

function roundsOf(dependencies: Dependencies): DeferredRounds {
  assert.ok(dependencies.rounds, "The Mission Service owns the rounds.");
  return dependencies.rounds;
}

function quiescent(dependencies: Dependencies): boolean {
  return (
    roundsOf(dependencies).quiescent ||
    dependencies.shutdown?.signal.aborted === true
  );
}

function roundContext(dependencies: Dependencies): Context {
  return dependencies.shutdown ?? background;
}

function mergeCommitOf(
  tx: Transaction,
  dependencies: Dependencies,
  item: RequestItem,
  now: number,
): string | null {
  const action = item.frozen_action;
  if (
    action.action !== RepositoryAction.PullRequest ||
    action.configuration.landing !== RepositoryLanding.KanthorD
  )
    return null;
  const { node_id: nodeId, attempt } = item.request;
  const assessment = currentAssessmentOf(tx, nodeId, attempt);
  if (assessment?.result !== AssessmentResult.Success) return null;
  if (gateFilesOf(assessment, action.binding_id).length > NO_GATE_FILES)
    return null;
  if (dependencies.schedulerClaims.liveExecutionOf(tx, nodeId, now) !== null)
    return null;
  return assessedCommitOf(tx, nodeId, attempt, action.binding_id);
}

async function requestMerge(
  dependencies: Dependencies,
  item: RequestItem,
  commit: string,
  run: string,
  round: number,
): Promise<MergeOutcome> {
  const { node_id: nodeId, attempt, id } = item.request;
  try {
    const answer = await dependencies.intakeCheck.merge(
      roundContext(dependencies),
      {
        evidence_id: id,
        commit,
        request_key: `${nodeId}/${attempt}/${item.frozen_action.key}/merge/${commit}/service/${run}/${round}`,
      },
    );
    if ("kind" in answer) return MergeOutcome.Merged;
    dependencies.logger.warn(
      { evidence_id: id, class: answer.class, code: answer.code },
      DEFERRED_MERGE_FAILED,
    );
    return RETRIED_MERGE_CLASSES.includes(answer.class)
      ? MergeOutcome.Retry
      : MergeOutcome.Stop;
  } catch (error) {
    dependencies.logger.warn({ error, evidence_id: id }, DEFERRED_MERGE_FAILED);
    return MergeOutcome.Stop;
  }
}

async function runDeferredCheck(
  dependencies: Dependencies,
  nodeId: string,
  attempt: number,
  run: string,
  stopped: Set<string>,
  round: number,
): Promise<RoundOutcome | null> {
  const prepared = dependencies.store.transaction((tx) => {
    const node = readNode(tx, nodeId);
    if (!node || node.state !== NodeState.ExternalRequested) return null;
    const openAttempt = readOpenAttempt(tx, nodeId);
    if (openAttempt?.attempt !== attempt) return null;
    const requests = readRequests(tx, nodeId, attempt)
      .filter((row) => row.end_state === null)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => requestContext(tx, dependencies, row.id));
    if (requests.length === NO_UNRESOLVED_REQUESTS) return null;
    const mission = requireMission(tx, node.mission_id);
    return { mission, requests };
  });
  if (prepared === null) return null;
  const outcome: RoundOutcome = {
    merged: false,
    pending: false,
    failed: false,
  };
  for (const item of prepared.requests) {
    if (quiescent(dependencies)) break;
    let answer: CheckAnswer;
    try {
      dependencies.store.transaction((tx) =>
        authorizeRequest(tx, dependencies, item.request.id),
      );
      answer = checkAnswerSchema.parse(
        await dependencies.intakeCheck.check(
          roundContext(dependencies),
          item.request.id,
        ),
      );
    } catch (error) {
      dependencies.logger.warn(
        { error, evidence_id: item.request.id },
        "Deferred check failed.",
      );
      outcome.failed = true;
      continue;
    }
    if (answer.end_state === CheckEndState.ChecksPending)
      outcome.pending = true;
    const mergeCommit = dependencies.store.transaction((tx) => {
      const now = Date.now();
      if (answer.end_state === CheckEndState.None)
        return mergeCommitOf(tx, dependencies, item, now);
      const claim = changesNothing(answer.end_state)
        ? null
        : dependencies.schedulerClaims.liveExecutionOf(
            tx,
            item.request.node_id,
            now,
          );
      if (claim === null)
        applyEndState(tx, dependencies, item.request.id, answer, now);
      return null;
    });
    if (
      mergeCommit === null ||
      stopped.has(item.request.id) ||
      quiescent(dependencies)
    )
      continue;
    const merge = await requestMerge(
      dependencies,
      item,
      mergeCommit,
      run,
      round,
    );
    if (merge === MergeOutcome.Merged) outcome.merged = true;
    if (merge === MergeOutcome.Retry) outcome.failed = true;
    if (merge === MergeOutcome.Stop) stopped.add(item.request.id);
  }
  dependencies.wakeup.wake(prepared.mission.project_id);
  return outcome;
}

function nextRound(
  dependencies: Dependencies,
  nodeId: string,
  attempt: number,
  run: string,
  stopped: Set<string>,
  round: number,
  outcome: RoundOutcome,
): void {
  const next = round + NEXT_ROUND_STEP;
  if (next >= DEFERRED_CHECK_ROUND_LIMIT) return;
  if (outcome.merged)
    return roundsOf(dependencies).arm(IMMEDIATE_DELAY_MS, () =>
      runRound(dependencies, nodeId, attempt, run, stopped, next),
    );
  if (outcome.pending || outcome.failed)
    roundsOf(dependencies).arm(DEFERRED_CHECK_RETRY_MS, () =>
      runRound(dependencies, nodeId, attempt, run, stopped, next),
    );
}

function runRound(
  dependencies: Dependencies,
  nodeId: string,
  attempt: number,
  run: string,
  stopped: Set<string>,
  round: number,
): void {
  if (quiescent(dependencies)) return;
  roundsOf(dependencies).admit(
    runDeferredCheck(dependencies, nodeId, attempt, run, stopped, round)
      .then((outcome) => {
        if (outcome === null) return;
        nextRound(dependencies, nodeId, attempt, run, stopped, round, outcome);
      })
      .catch((error) => {
        dependencies.logger.warn(
          { error, node_id: nodeId },
          "Deferred check crashed.",
        );
      }),
  );
}

export function scheduleDeferredCheck(
  dependencies: Dependencies,
  nodeId: string,
  attempt: number,
): void {
  const run = createIdentity(DEFERRED_RUN_PREFIX);
  const stopped = new Set<string>();
  roundsOf(dependencies).arm(IMMEDIATE_DELAY_MS, () =>
    runRound(dependencies, nodeId, attempt, run, stopped, FIRST_ROUND),
  );
}

export function resumeDeferredChecks(
  dependencies: Dependencies,
  limit = DEFERRED_CHECK_START_LIMIT,
): void {
  const rows = dependencies.store.transaction((tx) =>
    readDeferredCheckNodes(tx, limit + OVERFLOW_PROBE_ROWS),
  );
  const nodes = rows.slice(FIRST_ROW_INDEX, limit);
  for (const { node_id, attempt } of nodes)
    scheduleDeferredCheck(dependencies, node_id, attempt);
  dependencies.logger.info(
    { count: nodes.length, limit },
    DEFERRED_CHECKS_RESUMED,
  );
  if (rows.length > limit)
    dependencies.logger.warn({ limit }, DEFERRED_CHECK_LIMIT_REACHED);
}

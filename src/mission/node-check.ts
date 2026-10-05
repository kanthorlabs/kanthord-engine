import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError, type ErrorBody } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  ActorService,
  AssetKind,
  CheckEndState,
  MissionErrorCode,
  NodeState,
  Resolution,
  platformAddressSchema,
  checkEndStateSchema,
  commitSchema,
  type IntakeCheck,
} from "./contract.ts";
import { closeExternalAttempt, requireRunnable } from "./control.ts";
import { actionStatesOf, requiredActionsOf } from "./frozen-action.ts";
import { requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  insertEvidence,
  readAssets,
  readAttempt,
  readEvidence,
  readOpenAttempt,
  readRequests,
} from "./record-store.ts";
import { claimableMap, reconcileMission } from "./routing.ts";
import { setNodeState } from "./store.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";
import { authorizeRequest } from "./authorization.ts";

const NO_LANDED_COMMITS = 0;
const FIRST_ASSET_INDEX = 0;
const NO_UNRESOLVED_REQUESTS = 0;
const SINGLE_ASSET_COUNT = 1;
const EXPECTED_ROW_CHANGE = 1;
export const LANDED_COMMIT_SUBJECT = "Landed commit";
type CheckAnswer = Awaited<ReturnType<IntakeCheck["check"]>>;
const checkAnswerSchema = z
  .strictObject({
    endState: checkEndStateSchema,
    landedCommits: z.array(commitSchema),
  })
  .refine((answer) =>
    answer.endState === CheckEndState.Expected
      ? answer.landedCommits.length > NO_LANDED_COMMITS
      : answer.landedCommits.length === NO_LANDED_COMMITS,
  );

function requestContext(
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
    frozenAction,
    address: platformAddressSchema.parse(
      JSON.parse(assets[FIRST_ASSET_INDEX]!.content),
    ),
  };
}

export function applyEndState(
  tx: Transaction,
  dependencies: Dependencies,
  evidenceId: string,
  answer: CheckAnswer,
  now: number,
): void {
  checkAnswerSchema.parse(answer);
  const { request, frozenAction } = requestContext(
    tx,
    dependencies,
    evidenceId,
  );
  const node = requireNode(tx, request.node_id);
  const mission = requireMission(tx, node.mission_id);
  const before = claimableMap(tx, mission.id, dependencies.bindings);
  if (request.end_state !== null || answer.endState === CheckEndState.None)
    return;
  const write = tx.database
    .prepare(
      "UPDATE mission_evidence SET end_state = ? WHERE id = ? AND end_state IS NULL",
    )
    .run(answer.endState, evidenceId);
  assert.equal(write.changes, EXPECTED_ROW_CHANGE);
  if (answer.endState === CheckEndState.Expected) {
    for (const commit of answer.landedCommits) {
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
          provenance: canonicalJSON({
            kind: ActorKind.Service,
            service: ActorService.Mission,
          }),
          created_at: now,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Repository,
            content: canonicalJSON({
              bindingId: frozenAction.bindingId,
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
  ) {
    const states = actionStatesOf(
      tx,
      dependencies.bindings,
      node.id,
      request.attempt,
    );
    if (states.some((state) => state.resolution === Resolution.OtherEnd))
      setNodeState(tx, node.id, NodeState.ExternalFailed);
    else if (
      states.every((state) => state.resolution === Resolution.ExpectedEnd)
    )
      setNodeState(tx, node.id, NodeState.ExternalSuccess);
    closeExternalAttempt(tx, dependencies, requireNode(tx, node.id), now);
  } else
    reconcileMission(
      tx,
      dependencies.workQueue,
      mission.id,
      mission.projectId,
      before,
      dependencies.bindings,
    );
}

function checkError(error: unknown, requestId: string): ErrorBody {
  return {
    requestId,
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
  const failures: { evidenceId: string; error: ErrorBody }[] = [];
  const checked: string[] = [];
  for (const item of prepared.requests) {
    let answer: CheckAnswer;
    try {
      dependencies.store.transaction((tx) =>
        authorizeRequest(tx, dependencies, item.request.id),
      );
      answer = checkAnswerSchema.parse(
        await dependencies.intakeCheck.check(caller.context, {
          frozenAction: item.frozenAction,
          address: item.address,
        }),
      );
    } catch (error) {
      failures.push({
        evidenceId: item.request.id,
        error: checkError(error, caller.requestId),
      });
      continue;
    }
    const live = dependencies.store.transaction((tx) => {
      requireMission(tx, prepared.mission.id, expectedMissionVersion);
      const now = Date.now();
      const claim =
        answer.endState === CheckEndState.None
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
        evidenceId: item.request.id,
        error: checkError(
          new OperationError(
            HttpStatus.Conflict,
            MissionErrorCode.ClaimLive,
            "Node has a live claim.",
            { nodeId: item.request.node_id, executionId: live.executionId },
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
        evidenceId: id,
        requirementKey: row.requirement_key,
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
  dependencies.wakeup.wake(prepared.mission.projectId);
  return result;
}

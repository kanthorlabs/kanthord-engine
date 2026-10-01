import assert from "node:assert/strict";
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

const ZERO = 0;
const ONE = 1;
export const LANDED_COMMIT_SUBJECT = "Landed commit";
type CheckAnswer = Awaited<ReturnType<IntakeCheck["check"]>>;

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
  assert.equal(assets.length, ONE);
  assert.equal(assets[ZERO]!.kind, AssetKind.Platform);
  return {
    request,
    frozenAction,
    address: platformAddressSchema.parse(JSON.parse(assets[ZERO]!.content)),
  };
}

export function applyEndState(
  tx: Transaction,
  dependencies: Dependencies,
  evidenceId: string,
  answer: CheckAnswer,
  now: number,
): void {
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
  assert.equal(write.changes, ONE);
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
    if (requests.length === ZERO)
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
      answer = await dependencies.intakeCheck.check(caller.context, {
        frozenAction: item.frozenAction,
        address: item.address,
      });
    } catch (error) {
      failures.push({
        evidenceId: item.request.id,
        error: checkError(error, caller.requestId),
      });
      continue;
    }
    dependencies.store.transaction((tx) =>
      applyEndState(tx, dependencies, item.request.id, answer, Date.now()),
    );
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

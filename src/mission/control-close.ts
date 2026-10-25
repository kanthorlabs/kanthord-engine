import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  NodeState,
  OVERRIDE_STATES,
  Intent,
  AssetKind,
  type Override,
  type RepositoryAddress,
  type HumanAct,
  type HumanActor,
  RevokeCause,
  type Mission,
  type ExecutionEnds,
} from "./contract.ts";
import type { ExecutionTrace } from "../tracking/contract.ts";
import type { Dependencies } from "./service.ts";
import type { NodeRow } from "./store.ts";
import { getRevision } from "./node-read.ts";
import { requireRepositoryInput } from "./evidence-content.ts";
import {
  closeAttempt,
  readLandedCommitEvidence,
  insertEvidence,
} from "./record-store.ts";
import {
  admitControl,
  requireNoUnresolvedAction,
  endLiveClaim,
  writeHumanRecords,
  transition,
  controlResult,
  actRevision,
  actedOn,
} from "./control.ts";

const NO_ATTEMPT = 0;
const BINDING_MISMATCH = "mission.evidence.binding_mismatch";
const LANDED_COMMIT_FIELD = "landed_commit";

function landedEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  landed: RepositoryAddress | RepositoryAddress[],
  reason: string,
  actor: HumanActor,
  now: number,
): string {
  const revision = getRevision(tx, node.id, actRevision(tx, node));
  assert.ok(node.attempt !== null);
  const addresses = Array.isArray(landed) ? landed : [landed];
  const [first] = addresses;
  assert.ok(first);
  if (revision.content.intent !== Intent.Implement)
    throw new OperationError(
      HttpStatus.BadRequest,
      BINDING_MISMATCH,
      "Landed commit does not name the pinned repository of an implement node.",
      { binding_id: first.binding_id },
    );
  requireRepositoryInput(
    tx,
    dependencies.bindings,
    revision,
    landed,
    LANDED_COMMIT_FIELD,
  );
  const id = createIdentity("evidence");
  insertEvidence(
    tx,
    {
      id,
      node_id: node.id,
      attempt: node.attempt,
      subject: reason,
      requirement_key: null,
      end_state: null,
      verification: null,
      provenance: canonicalJSON(actor),
      created_at: now,
    },
    addresses.map((address) => ({
      id: createIdentity("evidence_asset"),
      evidence_id: id,
      kind: AssetKind.Repository,
      content: canonicalJSON({
        binding_id: address.binding_id,
        commit: address.commit,
      }),
      published_at: now,
      expired_at: null,
    })),
  );
  return id;
}

export function overrideNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: Override,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    OVERRIDE_STATES,
    now,
    ends,
  );
  requireNoUnresolvedAction(tx, node);
  const claim = endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
  );
  assert.ok(node.attempt !== null);
  const evidenceIds =
    node.attempt === NO_ATTEMPT
      ? []
      : readLandedCommitEvidence(tx, nodeId, node.attempt).map((row) => row.id);
  if (body.landed_commit !== undefined)
    evidenceIds.push(
      landedEvidence(
        tx,
        dependencies,
        node,
        body.landed_commit,
        body.reason,
        actor,
        now,
      ),
    );
  if (node.attempt > NO_ATTEMPT && node.state !== NodeState.Blocked)
    closeAttempt(tx, nodeId, node.attempt, now);
  const outcome = writeHumanRecords(
    tx,
    node,
    AssessmentResult.Success,
    body.reason,
    actor,
    evidenceIds,
    now,
  );
  transition(tx, dependencies, mission, node, NodeState.Completed, now);
  const acted = actedOn(
    tx,
    mission,
    node,
    body.reason,
    now,
    controlResult(tx, dependencies, nodeId, outcome, actor, now),
    claim?.execution.trace ?? null,
  );
  const firstQueuedAt = dependencies.workQueue.firstQueuedAt(tx, nodeId);
  if (acted.result.node.state !== NodeState.Completed || firstQueuedAt === null)
    return acted;
  return { ...acted, act: { ...acted.act, lead_time_ms: now - firstQueuedAt } };
}
const DISCARD_STATES = [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.Blocked,
  NodeState.Paused,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
];

function closeHuman(
  tx: Transaction,
  dependencies: Dependencies,
  mission: Mission,
  node: NodeRow,
  body: HumanAct,
  actor: HumanActor,
  state: NodeState,
  now: number,
  revoked: ExecutionTrace | null,
) {
  assert.ok(node.attempt !== null);
  assert.ok(state === NodeState.Blocked || state === NodeState.Discarded);
  if (node.attempt > NO_ATTEMPT && node.state !== NodeState.Blocked)
    closeAttempt(tx, node.id, node.attempt, now);
  const evidenceIds =
    node.attempt === NO_ATTEMPT
      ? []
      : readLandedCommitEvidence(tx, node.id, node.attempt).map(
          (row) => row.id,
        );
  const outcome = writeHumanRecords(
    tx,
    node,
    AssessmentResult.Undetermined,
    body.reason,
    actor,
    evidenceIds,
    now,
  );
  transition(tx, dependencies, mission, node, state, now);
  return actedOn(
    tx,
    mission,
    node,
    body.reason,
    now,
    controlResult(tx, dependencies, node.id, outcome, actor, now),
    revoked,
  );
}

export function blockNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    [NodeState.Paused],
    now,
    ends,
  );
  return closeHuman(
    tx,
    dependencies,
    mission,
    node,
    body,
    actor,
    NodeState.Blocked,
    now,
    null,
  );
}

export function discardNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  actor: HumanActor,
  now: number,
  ends: ExecutionEnds,
) {
  const { node, mission } = admitControl(
    tx,
    dependencies,
    nodeId,
    body,
    DISCARD_STATES,
    now,
    ends,
  );
  requireNoUnresolvedAction(tx, node);
  const claim = endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Human,
    null,
    ends,
  );
  return closeHuman(
    tx,
    dependencies,
    mission,
    node,
    body,
    actor,
    NodeState.Discarded,
    now,
    claim?.execution.trace ?? null,
  );
}

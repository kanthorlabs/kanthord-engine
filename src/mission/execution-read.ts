import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  actorSchema,
  MissionErrorCode,
  NodeKind,
  NODE_LIST_LIMIT_DEFAULT,
  type ExecutionObjective,
} from "./contract.ts";
import { identitySchema } from "../kernel/identity.ts";
import { evidencePage } from "./evidence-read.ts";
import { recordNotFound } from "./record-list.ts";
import { outcomeRecord, evidenceRecord } from "./record-read.ts";
import {
  readOutcomesOfAttempt,
  readCurrentOutcome,
  readEvidence,
} from "./record-store.ts";
import { readMissionNodes } from "./store.ts";
import { admitExecution } from "./execution.ts";
import {
  getRevision,
  revisionCursor,
  revisionPage,
  requireNode,
  nodeRecord,
  decode,
  encode,
  invalidCursor,
} from "./node-read.ts";
import type { Dependencies } from "./service.ts";

const FIRST_ATTEMPT = 1;
const ZERO = 0;

export function currentObjectivesOf(tx: Transaction, initiativeId: string) {
  const initiative = requireNode(tx, initiativeId);
  assert.equal(initiative.kind, NodeKind.Initiative);
  assert.ok(tx.database.isTransaction);
  return readMissionNodes(tx, initiative.mission_id)
    .filter(
      (node) =>
        node.kind === NodeKind.Objective &&
        node.parent_id === initiativeId &&
        node.retired_at === null,
    )
    .map((node) => ({ node, outcome: readCurrentOutcome(tx, node.id) }));
}

function identityPage<T extends { id: string }>(
  items: T[],
  prefix: string,
  query: { limit?: number; cursor?: string },
) {
  const after = query.cursor === undefined ? undefined : decode(query.cursor);
  if (after !== undefined && !identitySchema(prefix).safeParse(after).success)
    invalidCursor();
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = items
    .filter((item) => after === undefined || item.id < after)
    .sort((a, b) =>
      a.id < b.id ? FIRST_ATTEMPT : a.id > b.id ? -FIRST_ATTEMPT : ZERO,
    );
  const page = rows.slice(ZERO, limit);
  return {
    items: page,
    nextCursor:
      rows.length > limit ? encode(page.at(-FIRST_ATTEMPT)!.id) : null,
  };
}

export function executionObjectives(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node } = executionRead(tx, dependencies, claim);
  const page = identityPage(
    node.kind === NodeKind.Objective
      ? []
      : currentObjectivesOf(tx, node.id).map((item) => ({
          ...item,
          id: item.node.id,
        })),
    "node",
    query,
  );
  const items: ExecutionObjective[] = page.items.map(
    ({ node: child, outcome }) => {
      assert.ok(child.state);
      if (!outcome) return { id: child.id, state: child.state };
      const record = outcomeRecord(tx, dependencies.bindings, outcome);
      const revision = getRevision(tx, child.id, record.nodeRevision);
      const view = nodeRecord(tx, child, dependencies.bindings);
      assert.ok(view.kind === NodeKind.Objective);
      return {
        ...view,
        filename: revision.filename,
        content: revision.content,
        visibleRevision: revision.revision,
        pinnedByAttempts: revision.pinnedByAttempts,
      };
    },
  );
  return { ...page, items };
}

export function executionObjectiveOutcomes(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node } = executionRead(tx, dependencies, claim);
  const items =
    node.kind === NodeKind.Objective
      ? []
      : currentObjectivesOf(tx, node.id).flatMap(({ outcome }) =>
          outcome ? [outcome] : [],
        );
  const page = identityPage(items, "outcome", query);
  return {
    ...page,
    items: page.items.map((row) =>
      outcomeRecord(tx, dependencies.bindings, row),
    ),
  };
}

export function executionObjectiveEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node } = executionRead(tx, dependencies, claim);
  const ids =
    node.kind === NodeKind.Objective
      ? []
      : currentObjectivesOf(tx, node.id).flatMap(({ outcome }) =>
          outcome
            ? outcomeRecord(tx, dependencies.bindings, outcome).evidenceIds
            : [],
        );
  const page = identityPage(
    [...new Set(ids)].map((id) => ({ id })),
    "evidence",
    query,
  );
  const items = page.items.map(({ id }) => {
    const evidence = readEvidence(tx, id);
    assert.ok(evidence);
    return evidenceRecord(tx, evidence);
  });
  return { ...page, items };
}

export function executionEvidencePage(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { cursor?: string; limit?: number },
) {
  executionRead(tx, dependencies, claim);
  return evidencePage(tx, claim.nodeId, { ...query, attempt: claim.attempt });
}

export function clearedOutcome(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  const { attempt } = executionRead(tx, dependencies, claim);
  if (claim.attempt === FIRST_ATTEMPT) recordNotFound();
  assert.equal(
    actorSchema.parse(JSON.parse(attempt.opened_by)).kind,
    ActorKind.Human,
  );
  const outcome = readOutcomesOfAttempt(
    tx,
    claim.nodeId,
    claim.attempt - FIRST_ATTEMPT,
  ).at(-FIRST_ATTEMPT);
  assert.ok(outcome);
  return outcomeRecord(tx, dependencies.bindings, outcome);
}

export function executionRead(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(claim.executionId);
  return admitExecution(
    tx,
    dependencies,
    claim,
    claim.nodeId,
    {
      executionId: claim.executionId,
      attempt: claim.attempt,
      nodeRevision: claim.pinnedRevision,
    },
    Date.now(),
  );
}

function requireRevisionBound(revision: number, claim: ExecutionClaim): void {
  if (revision > claim.pinnedRevision)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.ExecutionRevisionAbovePin,
      "The revision is above the execution pin.",
    );
}

export function executionRevision(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  revision = claim.pinnedRevision,
) {
  executionRead(tx, dependencies, claim);
  requireRevisionBound(revision, claim);
  return getRevision(tx, claim.nodeId, revision);
}

export function executionRevisionPage(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { cursor?: string; limit?: number },
) {
  executionRead(tx, dependencies, claim);
  const after =
    query.cursor === undefined ? undefined : revisionCursor(query.cursor);
  if (after !== undefined) requireRevisionBound(after, claim);
  return revisionPage(
    tx,
    claim.nodeId,
    after,
    query.limit,
    claim.pinnedRevision,
  );
}

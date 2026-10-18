import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  actorSchema,
  AssessmentResult,
  MissionErrorCode,
  Intent,
  NODE_LIST_LIMIT_DEFAULT,
  type ExecutionDependency,
} from "./contract.ts";
import { identitySchema } from "../kernel/identity.ts";
import { evidencePage } from "./evidence-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  assessmentRecord,
  outcomeRecord,
  evidenceRecord,
} from "./record-read.ts";
import {
  readAssessment,
  readExecutionAssessmentsOfAttempt,
  readOutcomesOfAttempt,
  readCurrentOutcome,
  readEvidence,
} from "./record-store.ts";
import { directDependenciesOf } from "./graph.ts";
import { readDependencies, readMissionNodes } from "./store.ts";
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
const SORT_EQUAL = 0;
const SLICE_FROM_START = 0;

export function currentDependenciesOf(tx: Transaction, nodeId: string) {
  const node = requireNode(tx, nodeId);
  assert.ok(tx.database.isTransaction);
  const direct = new Set(
    directDependenciesOf(nodeId, readDependencies(tx, node.mission_id)),
  );
  return readMissionNodes(tx, node.mission_id)
    .filter(
      (dependency) =>
        direct.has(dependency.id) && dependency.retired_at === null,
    )
    .map((dependency) => ({
      node: dependency,
      outcome: readCurrentOutcome(tx, dependency.id),
    }));
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
      a.id < b.id ? FIRST_ATTEMPT : a.id > b.id ? -FIRST_ATTEMPT : SORT_EQUAL,
    );
  const page = rows.slice(SLICE_FROM_START, limit);
  return {
    items: page,
    next_cursor:
      rows.length > limit ? encode(page.at(-FIRST_ATTEMPT)!.id) : null,
  };
}

export function executionDependencies(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node, revision: pinned } = executionRead(tx, dependencies, claim);
  const page = identityPage(
    pinned.content.intent === Intent.Implement
      ? []
      : currentDependenciesOf(tx, node.id).map((item) => ({
          ...item,
          id: item.node.id,
        })),
    "node",
    query,
  );
  const items: ExecutionDependency[] = page.items.map(
    ({ node: dependency, outcome }) => {
      assert.ok(dependency.state);
      if (!outcome) return { id: dependency.id, state: dependency.state };
      const record = outcomeRecord(tx, dependencies.bindings, outcome);
      const revision = getRevision(tx, dependency.id, record.node_revision);
      return {
        ...nodeRecord(tx, dependency, dependencies.bindings),
        filename: revision.filename,
        content: revision.content,
        intent: revision.content.intent,
        tags: revision.content.tags,
        tasks: revision.tasks,
        visible_revision: revision.revision,
        pinned_by_attempts: revision.pinned_by_attempts,
      };
    },
  );
  return { ...page, items };
}

export function executionDependencyOutcomes(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node, revision } = executionRead(tx, dependencies, claim);
  const items =
    revision.content.intent === Intent.Implement
      ? []
      : currentDependenciesOf(tx, node.id).flatMap(({ outcome }) =>
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

export function executionDependencyEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { limit?: number; cursor?: string },
) {
  const { node, revision } = executionRead(tx, dependencies, claim);
  const ids =
    revision.content.intent === Intent.Implement
      ? []
      : currentDependenciesOf(tx, node.id).flatMap(({ outcome }) =>
          outcome
            ? outcomeRecord(tx, dependencies.bindings, outcome).evidence_ids
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

function clearedOutcomeRow(
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
  return outcome;
}

export function clearedOutcome(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  return outcomeRecord(
    tx,
    dependencies.bindings,
    clearedOutcomeRow(tx, dependencies, claim),
  );
}

export function clearedAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  const outcome = clearedOutcomeRow(tx, dependencies, claim);
  const assessment = readAssessment(tx, outcome.assessment_id);
  assert.ok(assessment);
  return assessmentRecord(tx, dependencies, assessment);
}

export function reworkAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  executionRead(tx, dependencies, claim);
  const assessment = readExecutionAssessmentsOfAttempt(
    tx,
    claim.nodeId,
    claim.attempt,
    AssessmentResult.CriterionNotMet,
  ).at(-1);
  if (!assessment) recordNotFound();
  return assessmentRecord(tx, dependencies, assessment);
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
      execution_id: claim.executionId,
      attempt: claim.attempt,
      node_revision: claim.pinnedRevision,
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

import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ExecutionIntent,
  type UnitRecord,
  unitRecordSchema,
  WorkerErrorCode,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

type UnitRecordDependencies = Pick<
  Dependencies,
  "schedulerClaims" | "repositoryBindingIdsOf" | "unitIdsOf" | "intentOf"
>;

const storedCommitsSchema = unitRecordSchema.shape.commits;

interface UnitRecordRow {
  unit_id: string;
  content_digest: string;
  commits: string;
}

export function unitRecordsOf(tx: Transaction, nodeId: string): UnitRecord[] {
  return (
    tx.database
      .prepare(
        "SELECT unit_id, content_digest, commits FROM worker_unit_record WHERE node_id = ? ORDER BY unit_id",
      )
      .all(nodeId) as unknown as UnitRecordRow[]
  ).map((row) => ({
    unit_id: row.unit_id,
    content_digest: row.content_digest,
    commits: storedCommitsSchema.parse(JSON.parse(row.commits)),
  }));
}

export function deleteNodeUnitRecords(tx: Transaction, nodeId: string): void {
  assert.ok(tx.database.isTransaction);
  tx.database
    .prepare("DELETE FROM worker_unit_record WHERE node_id = ?")
    .run(nodeId);
}

function refused(
  code: string,
  message: string,
  details: Record<string, string>,
): never {
  throw new OperationError(HttpStatus.Conflict, code, message, details);
}

export function putUnitRecord(
  dependencies: UnitRecordDependencies,
  caller: CallerContext,
  record: UnitRecord,
): UnitRecord {
  const claim = caller.execution;
  assert.ok(claim);
  return caller.commit((tx) => {
    dependencies.schedulerClaims.requireRunning(
      tx,
      claim.executionId,
      claim.runtimeIdentity,
      Date.now(),
    );
    const intent = dependencies.intentOf(
      tx,
      claim.nodeId,
      claim.pinnedRevision,
    );
    if (intent !== ExecutionIntent.Implement)
      refused(
        WorkerErrorCode.UnitRecordIntentInvalid,
        "Only an implement execution writes a unit record.",
        { intent },
      );
    if (
      !dependencies
        .unitIdsOf(tx, claim.nodeId, claim.pinnedRevision)
        .includes(record.unit_id)
    )
      refused(
        WorkerErrorCode.UnitRecordUnitUnknown,
        "The unit is neither the node nor a task of the pinned revision.",
        { unit_id: record.unit_id },
      );
    const bindings = new Set(
      dependencies.repositoryBindingIdsOf(
        tx,
        claim.nodeId,
        claim.pinnedRevision,
      ),
    );
    const unknown = record.commits.find(
      ({ binding_id }) => !bindings.has(binding_id),
    );
    if (unknown !== undefined)
      refused(
        WorkerErrorCode.UnitRecordBindingUnknown,
        "The binding is no repository binding of the pinned revision.",
        { binding_id: unknown.binding_id },
      );
    tx.database
      .prepare(
        "INSERT INTO worker_unit_record (node_id, unit_id, content_digest, commits) VALUES (?, ?, ?, ?) ON CONFLICT (node_id, unit_id) DO UPDATE SET content_digest = excluded.content_digest, commits = excluded.commits",
      )
      .run(
        claim.nodeId,
        record.unit_id,
        record.content_digest,
        canonicalJSON(record.commits),
      );
    return record;
  });
}

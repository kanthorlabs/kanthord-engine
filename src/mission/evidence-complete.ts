import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  MissionErrorCode,
  type ExecutionContext,
} from "./contract.ts";
import { admitExecution } from "./execution.ts";
import { readEvidence, type AssetRow } from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import {
  authorizeClaim,
  authorizeStorage,
  pendingObjectAdmitted,
} from "./authorization.ts";

const objectContentSchema = z.strictObject({
  location: z.string(),
  size: z.number().int().nonnegative(),
  media_type: z.string(),
  storage_binding_id: z.string(),
  sha256: z.string().optional(),
  object_version: z.string().optional(),
});
const EXPECTED_ROW_CHANGE = 1;

export function prepareComplete(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  assetId: string,
  context: ExecutionContext,
  now: number,
) {
  assert.ok(tx.database.isTransaction);
  const asset = tx.database
    .prepare("SELECT * FROM mission_evidence_asset WHERE id = ?")
    .get(assetId) as AssetRow | undefined;
  if (!asset || asset.kind !== AssetKind.Object)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.RecordNotFound,
      "Evidence asset not found.",
    );
  const evidence = readEvidence(tx, asset.evidence_id);
  assert.ok(evidence);
  authorizeClaim(tx, dependencies, claim, evidence.node_id);
  admitExecution(tx, dependencies, claim, evidence.node_id, context, now);
  const pending = pendingObjectAdmitted(evidence, asset, claim, now);
  const content = objectContentSchema.parse(JSON.parse(asset.content));
  const result = {
    asset_id: asset.id,
    evidence_id: evidence.id,
    uri: content.location,
  };
  if (!pending) return { result, pending: null };
  authorizeStorage(tx, dependencies.bindings, content.storage_binding_id);
  return { result, pending: { content } };
}

export async function completeEvidence(
  dependencies: Dependencies,
  caller: CallerContext,
  assetId: string,
  context: ExecutionContext,
) {
  const claim = caller.execution;
  assert.ok(claim);
  assert.ok(caller.identity);
  const prepared = dependencies.store.transaction((tx) =>
    prepareComplete(tx, dependencies, claim, assetId, context, Date.now()),
  );
  if (!prepared.pending)
    return caller.commit(
      (tx) =>
        prepareComplete(tx, dependencies, claim, assetId, context, Date.now())
          .result,
    );
  const { content } = prepared.pending;
  const checked = await dependencies.intakeStorage.check(
    {
      context: caller.context,
      identity: caller.identity,
      executionId: claim.executionId,
    },
    assetId,
  );
  assert.equal(checked.location, content.location);
  return caller.commit((tx) => {
    const now = Date.now();
    const current = prepareComplete(
      tx,
      dependencies,
      claim,
      assetId,
      context,
      now,
    );
    if (!current.pending) return current.result;
    assert.equal(
      canonicalJSON(current.pending.content),
      canonicalJSON(content),
    );
    const updated = {
      ...content,
      ...(checked.version === null ? {} : { object_version: checked.version }),
    };
    const write = tx.database
      .prepare(
        "UPDATE mission_evidence_asset SET published_at = ?, content = ? WHERE id = ? AND published_at IS NULL",
      )
      .run(now, canonicalJSON(updated), assetId);
    assert.equal(write.changes, EXPECTED_ROW_CHANGE);
    return current.result;
  });
}

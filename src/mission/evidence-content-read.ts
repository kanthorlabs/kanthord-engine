import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  CONTENT_ENCODING,
  storedContentSchema,
  MissionErrorCode,
  NodeKind,
  type EvidenceAsset,
} from "./contract.ts";
import { keyOfLocation } from "./evidence-content.ts";
import { admitExecution } from "./execution.ts";
import { evidenceRecord, outcomeRecord } from "./record-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  readCurrentOutcome,
  readEvidence,
  type AssetRow,
  type EvidenceRow,
} from "./record-store.ts";
import { readNode } from "./store.ts";
import type { Dependencies } from "./service.ts";
import { authorizeClaim, authorizeStorage } from "./authorization.ts";

export type ContentBound = (tx: Transaction, evidence: EvidenceRow) => boolean;
const FUNCTION_TYPE = "function";
const MAX_SIGNINGS = 2;
const inlineSchema = z.object({ media_type: z.string(), data: z.string() });
export const objectContentSchema = z.object({
  location: z.string(),
  size: z.number(),
  media_type: z.string(),
  storage_binding_id: z.string(),
  object_version: z.string().optional(),
  sha256: z.string().optional(),
});

export function executionContentBound(
  dependencies: Dependencies,
  claim: ExecutionClaim,
): ContentBound {
  return (tx, evidence) => {
    authorizeClaim(tx, dependencies, claim, claim.nodeId);
    const admitted = admitExecution(
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
    if (evidence.node_id === claim.nodeId && evidence.attempt === claim.attempt)
      return true;
    if (admitted.node.kind !== NodeKind.Initiative) return false;
    const child = readNode(tx, evidence.node_id);
    if (
      !child ||
      child.kind !== NodeKind.Objective ||
      child.parent_id !== claim.nodeId ||
      child.retired_at !== null
    )
      return false;
    const outcome = readCurrentOutcome(tx, child.id);
    return (
      outcome !== null &&
      outcomeRecord(tx, dependencies.bindings, outcome).evidence_ids.includes(
        evidence.id,
      )
    );
  };
}

function contentConflict(
  code: string,
  evidenceId: string,
  asset: EvidenceAsset,
): never {
  throw new OperationError(
    HttpStatus.Conflict,
    code,
    "Evidence content is represented by its external address.",
    { evidence_id: evidenceId, address: asset.address },
  );
}

export function contentOf(
  tx: Transaction,
  assetId: string,
  bound: ContentBound,
) {
  assert.equal(typeof bound, FUNCTION_TYPE);
  assert.ok(tx.database.isTransaction);
  const row = tx.database
    .prepare("SELECT * FROM mission_evidence_asset WHERE id = ?")
    .get(assetId) as AssetRow | undefined;
  if (!row) recordNotFound();
  const evidence = readEvidence(tx, row.evidence_id);
  assert.ok(evidence);
  if (!bound(tx, evidence)) recordNotFound();
  const asset = evidenceRecord(tx, evidence).assets.find(
    (item) => item.id === assetId,
  );
  assert.ok(asset);
  if (asset.kind === AssetKind.Repository)
    contentConflict(
      MissionErrorCode.EvidenceContentRepository,
      evidence.id,
      asset,
    );
  if (asset.kind === AssetKind.Platform)
    contentConflict(
      MissionErrorCode.EvidenceContentPlatform,
      evidence.id,
      asset,
    );
  if (asset.kind === AssetKind.Produced) {
    const content = inlineSchema.parse(JSON.parse(row.content));
    return {
      result: {
        asset_id: assetId,
        address: asset.address,
        ...content,
        encoding: CONTENT_ENCODING,
      },
      object: null,
    };
  }
  const object = objectContentSchema.parse(JSON.parse(row.content));
  return {
    result: {
      asset_id: assetId,
      address: asset.address,
      media_type: object.media_type,
      size: object.size,
    },
    object,
  };
}

export async function readContent(
  dependencies: Dependencies,
  caller: CallerContext,
  assetId: string,
  bound: ContentBound,
  execution: boolean,
) {
  assert.ok(caller.identity);
  assert.equal(typeof bound, FUNCTION_TYPE);
  const prepared = dependencies.store.transaction((tx) => {
    const content = contentOf(tx, assetId, bound);
    if (!content.object) return { ...content, binding: null };
    const binding = authorizeStorage(
      tx,
      dependencies.bindings,
      content.object.storage_binding_id,
    );
    assert.ok(binding);
    return { ...content, binding };
  });
  if (!prepared.object || !prepared.binding)
    return caller.commit((tx) =>
      storedContentSchema.parse(contentOf(tx, assetId, bound).result),
    );
  let object = prepared.object;
  const binding = prepared.binding;
  const method = execution ? "executionGet" : "get";
  for (let attempt = 0; attempt < MAX_SIGNINGS; attempt++) {
    const signed = await dependencies.intakeStorage[method](
      { context: caller.context, identity: caller.identity },
      binding,
      keyOfLocation(binding, object.location),
      object.object_version ?? null,
    );
    const current = dependencies.store.transaction((tx) =>
      contentOf(tx, assetId, bound),
    );
    assert.ok(current.object);
    if (current.object.object_version !== object.object_version) {
      object = current.object;
      continue;
    }
    return caller.commit((tx) => {
      const final = contentOf(tx, assetId, bound);
      assert.equal(final.object?.object_version, object.object_version);
      return storedContentSchema.parse({ ...final.result, ...signed });
    });
  }
  assert.fail(
    "An asset version is written once, so signing converges within two attempts.",
  );
}

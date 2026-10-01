import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  MissionErrorCode,
  UPLOAD_LIFETIME_MS,
  type EvidenceSubmit,
  type StorageBinding,
} from "./contract.ts";
import { admitExecution, requireTextBound } from "./execution.ts";
import {
  objectKey,
  objectLocation,
  producedContent,
  requireRepositoryAddress,
  requireTestedInput,
  storageBindingIdOf,
} from "./evidence-content.ts";
import { evidenceRecord } from "./record-read.ts";
import {
  insertEvidence,
  type AssetRow,
  type EvidenceRow,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";

type Identities = { evidenceId: string; assetIds: string[] };
type ObjectUpload = {
  assetId: string;
  binding: StorageBinding;
  key: string;
  size: number;
  sha256: string | null;
};

export function prepareEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  nodeId: string,
  body: EvidenceSubmit,
  now: number,
  ids: Identities,
) {
  const { node, revision, actor } = admitExecution(
    tx,
    dependencies,
    claim,
    nodeId,
    body,
    now,
  );
  requireTextBound("subject", body.subject, dependencies.config.textMaxBytes);
  assert.equal(ids.assetIds.length, body.assets.length);
  if (body.verification)
    requireTestedInput(
      tx,
      dependencies.bindings,
      node,
      revision,
      body.verification.testedInput,
    );
  const objects: ObjectUpload[] = [];
  const assets: AssetRow[] = body.assets.map((asset, index) => {
    const id = ids.assetIds[index];
    assert.ok(id);
    const base = {
      id,
      evidence_id: ids.evidenceId,
      kind: asset.kind,
      published_at: now,
      expired_at: null,
    };
    if (asset.kind === AssetKind.Repository) {
      requireRepositoryAddress(
        tx,
        dependencies.bindings,
        node,
        revision,
        asset.address,
      );
      return { ...base, content: canonicalJSON(asset.address) };
    }
    if (asset.kind === AssetKind.Produced)
      return {
        ...base,
        content: canonicalJSON(producedContent(asset.content)),
      };
    const storageBindingId = storageBindingIdOf(
      tx,
      dependencies.bindings,
      revision,
    );
    if (!storageBindingId)
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.EvidenceStorageBindingAbsent,
        "The pinned revision has no storage binding.",
      );
    const binding = dependencies.bindings.storageBindingOf(
      tx,
      storageBindingId,
    );
    assert.ok(binding);
    const key = objectKey(
      binding,
      claim.projectId,
      node.mission_id,
      node.id,
      claim.attempt,
      id,
    );
    objects.push({
      assetId: id,
      binding,
      key,
      size: asset.size,
      sha256: asset.sha256 ?? null,
    });
    return {
      ...base,
      content: canonicalJSON({
        location: objectLocation(binding, key),
        size: asset.size,
        mediaType: asset.mediaType,
        storageBindingId,
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      }),
      published_at: null,
      expired_at: now + UPLOAD_LIFETIME_MS,
    };
  });
  const evidence: EvidenceRow = {
    id: ids.evidenceId,
    node_id: node.id,
    attempt: claim.attempt,
    subject: body.subject,
    requirement_key: null,
    end_state: null,
    verification: body.verification ? canonicalJSON(body.verification) : null,
    provenance: canonicalJSON(actor),
    created_at: now,
  };
  return { evidence, assets, objects };
}

export async function submitEvidence(
  dependencies: Dependencies,
  caller: CallerContext,
  nodeId: string,
  body: EvidenceSubmit,
) {
  const claim = caller.execution;
  assert.ok(claim);
  assert.ok(caller.identity);
  const identity = caller.identity;
  const ids = {
    evidenceId: createIdentity("evidence"),
    assetIds: body.assets.map(() => createIdentity("evidence_asset")),
  };
  const uploads: {
    assetId: string;
    putUrl: string;
    headers: Record<string, string>;
    expiresAt: number;
  }[] = [];
  if (body.assets.some((asset) => asset.kind === AssetKind.Object)) {
    const prepared = dependencies.store.transaction((tx) =>
      prepareEvidence(tx, dependencies, claim, nodeId, body, Date.now(), ids),
    );
    for (const object of prepared.objects) {
      const signed = await dependencies.intakeStorage.put(
        { context: caller.context, identity },
        object.binding,
        object.key,
        object.size,
        object.sha256,
      );
      uploads.push({ assetId: object.assetId, ...signed });
    }
  }
  return caller.commit((tx) => {
    const prepared = prepareEvidence(
      tx,
      dependencies,
      claim,
      nodeId,
      body,
      Date.now(),
      ids,
    );
    insertEvidence(tx, prepared.evidence, prepared.assets);
    return { evidence: evidenceRecord(tx, prepared.evidence), uploads };
  });
}

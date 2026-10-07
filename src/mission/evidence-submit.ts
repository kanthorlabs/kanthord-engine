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
import { authorizeClaim, authorizeStorage } from "./authorization.ts";

type Identities = { evidence_id: string; asset_ids: string[] };
type ObjectUpload = {
  asset_id: string;
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
  if (body.assets.some((asset) => asset.kind === AssetKind.Object))
    authorizeClaim(tx, dependencies, claim, nodeId);
  const { node, revision, actor } = admitExecution(
    tx,
    dependencies,
    claim,
    nodeId,
    body,
    now,
  );
  requireTextBound("subject", body.subject, dependencies.config.text_max_bytes);
  for (const result of body.verification?.results ?? []) {
    requireTextBound(
      "verification.results.command",
      result.command,
      dependencies.config.text_max_bytes,
    );
    if (result.signal !== null)
      requireTextBound(
        "verification.results.signal",
        result.signal,
        dependencies.config.text_max_bytes,
      );
  }
  assert.equal(ids.asset_ids.length, body.assets.length);
  if (body.verification)
    requireTestedInput(
      tx,
      dependencies.bindings,
      node,
      revision,
      body.verification.tested_input,
    );
  const objects: ObjectUpload[] = [];
  const assets: AssetRow[] = body.assets.map((asset, index) => {
    const id = ids.asset_ids[index];
    assert.ok(id);
    const base = {
      id,
      evidence_id: ids.evidence_id,
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
    const binding = authorizeStorage(
      tx,
      dependencies.bindings,
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
      asset_id: id,
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
        media_type: asset.media_type,
        storage_binding_id: storageBindingId,
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      }),
      published_at: null,
      expired_at: now + UPLOAD_LIFETIME_MS,
    };
  });
  const evidence: EvidenceRow = {
    id: ids.evidence_id,
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
    evidence_id: createIdentity("evidence"),
    asset_ids: body.assets.map(() => createIdentity("evidence_asset")),
  };
  const uploads: {
    asset_id: string;
    put_url: string;
    headers: Record<string, string>;
    expires_at: number;
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
      uploads.push({ asset_id: object.asset_id, ...signed });
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

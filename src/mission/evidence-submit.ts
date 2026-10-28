import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { isObject } from "../kernel/values.ts";
import { S3_RESULT_CODE_PREFIX } from "../storage/contract.ts";
import {
  AssetKind,
  type EvidenceSubmit,
  Intent,
  type MissionBindings,
  MissionErrorCode,
  type Revision,
  UPLOAD_LIFETIME_MS,
} from "./contract.ts";
import { admitExecution, requireTextBound } from "./execution.ts";
import {
  objectKey,
  objectLocation,
  producedContent,
  requireRepositoryAddress,
  requireRepositorySet,
  requireTestedInput,
  storageBindingIdsOf,
} from "./evidence-content.ts";
import { evidenceRecord } from "./record-read.ts";
import {
  type AssetRow,
  type EvidenceRow,
  failedBindingsOf,
  insertEvidence,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import {
  AuthorizationRefusal,
  authorizeClaim,
  authorizeStorage,
  storageEnabled,
} from "./authorization.ts";

type Identities = { evidence_id: string; asset_ids: string[] };
type ObjectUpload = {
  nodeId: string;
  assetId: string;
  size: number;
  sha256: string | null;
};
type StorageCandidates = { failed: string[]; grantable: string[] };
type Upload = {
  asset_id: string;
  put_url: string;
  headers: Record<string, string>;
  expires_at: number;
};
const NO_STORAGE_BINDINGS = 0;
const NO_REPOSITORY_ASSETS = 0;
const FIRST_CANDIDATE = 0;
const FAILOVER_REFUSALS: readonly string[] = [
  AuthorizationRefusal.BindingDisabled,
  AuthorizationRefusal.BindingRemoved,
];

function storageCandidates(
  tx: Transaction,
  bindings: MissionBindings,
  revision: Revision,
  attempt: number,
): StorageCandidates {
  const storage = storageBindingIdsOf(tx, bindings, revision);
  const failed = new Set(failedBindingsOf(tx, revision.node_id, attempt));
  return {
    failed: storage.filter((id) => failed.has(id)),
    grantable: storage.filter(
      (id) => !failed.has(id) && storageEnabled(tx, bindings, id),
    ),
  };
}

export function prepareEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  nodeId: string,
  body: EvidenceSubmit,
  now: number,
  ids: Identities,
  grants: ReadonlyMap<string, string>,
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
  const repositoryBindingIds = body.assets.flatMap((asset) =>
    asset.kind === AssetKind.Repository ? [asset.address.binding_id] : [],
  );
  if (
    revision.content.intent === Intent.Implement &&
    repositoryBindingIds.length > NO_REPOSITORY_ASSETS
  )
    requireRepositorySet(
      tx,
      dependencies.bindings,
      revision,
      repositoryBindingIds,
    );
  const rows = body.assets.map((asset, index): AssetRow | null => {
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
    const storageBindingIds = storageBindingIdsOf(
      tx,
      dependencies.bindings,
      revision,
    );
    if (storageBindingIds.length === NO_STORAGE_BINDINGS)
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.EvidenceStorageBindingAbsent,
        "The pinned revision has no storage binding.",
      );
    const storageBindingId = grants.get(id);
    if (storageBindingId === undefined) return null;
    assert.ok(storageBindingIds.includes(storageBindingId));
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
  const assets = rows.filter((row): row is AssetRow => row !== null);
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
  return { evidence, assets, revision };
}

function objectUploadsOf(
  nodeId: string,
  body: EvidenceSubmit,
  ids: Identities,
): ObjectUpload[] {
  return body.assets.flatMap((asset, index) => {
    const assetId = ids.asset_ids[index];
    assert.ok(assetId);
    if (asset.kind !== AssetKind.Object) return [];
    return [
      { nodeId, assetId, size: asset.size, sha256: asset.sha256 ?? null },
    ];
  });
}

function signingFailsOver(caller: CallerContext, error: unknown): boolean {
  if (caller.context.signal.aborted || !(error instanceof OperationError))
    return false;
  if (error.code.startsWith(S3_RESULT_CODE_PREFIX)) return true;
  return (
    error.code === MissionErrorCode.AuthorizationRefused &&
    isObject(error.details) &&
    "reason" in error.details &&
    FAILOVER_REFUSALS.includes(String(error.details.reason))
  );
}

async function signObject(
  dependencies: Dependencies,
  caller: CallerContext,
  object: ObjectUpload,
  candidates: readonly string[],
  start: number,
) {
  const claim = caller.execution;
  assert.ok(claim && caller.identity);
  const call = {
    context: caller.context,
    identity: caller.identity,
    executionId: claim.executionId,
  };
  for (let index = start; index < candidates.length; index++) {
    const storageBindingId = candidates[index]!;
    try {
      const signed = await dependencies.intakeStorage.put(call, {
        ...object,
        storageBindingId,
      });
      return { index, storageBindingId, signed };
    } catch (error) {
      if (!signingFailsOver(caller, error)) throw error;
    }
  }
  return null;
}

function storageExhausted(
  nodeId: string,
  attempt: number,
  bindings: string[],
): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.EvidenceStorageExhausted,
    "No storage binding of the node is left for the upload.",
    { node_id: nodeId, attempt, bindings },
  );
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
  const ids = {
    evidence_id: createIdentity("evidence"),
    asset_ids: body.assets.map(() => createIdentity("evidence_asset")),
  };
  const uploads: Upload[] = [];
  const grants = new Map<string, string>();
  if (body.assets.some((asset) => asset.kind === AssetKind.Object)) {
    const { failed, grantable } = dependencies.store.transaction((tx) => {
      const { revision } = prepareEvidence(
        tx,
        dependencies,
        claim,
        nodeId,
        body,
        Date.now(),
        ids,
        grants,
      );
      return storageCandidates(
        tx,
        dependencies.bindings,
        revision,
        claim.attempt,
      );
    });
    let next = FIRST_CANDIDATE;
    for (const object of objectUploadsOf(nodeId, body, ids)) {
      const granted = await signObject(
        dependencies,
        caller,
        object,
        grantable,
        next,
      );
      if (!granted) storageExhausted(nodeId, claim.attempt, failed);
      next = granted.index;
      grants.set(object.assetId, granted.storageBindingId);
      uploads.push({ asset_id: object.assetId, ...granted.signed });
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
      grants,
    );
    assert.equal(prepared.assets.length, body.assets.length);
    insertEvidence(tx, prepared.evidence, prepared.assets);
    return { evidence: evidenceRecord(tx, prepared.evidence), uploads };
  });
}

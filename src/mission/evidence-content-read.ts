import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus, MediaType } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  CONTENT_ENCODING,
  type EvidenceAsset,
  Intent,
  MissionErrorCode,
  storedContentSchema,
} from "./contract.ts";
import { admitExecution } from "./execution.ts";
import { evidenceRecord, outcomeRecord } from "./record-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  type AssetRow,
  type EvidenceRow,
  readCurrentOutcome,
  readEvidence,
} from "./record-store.ts";
import { directDependenciesOf } from "./graph.ts";
import { readDependencies } from "./store.ts";
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
    if (admitted.revision.content.intent !== Intent.Examine) return false;
    if (
      !directDependenciesOf(
        claim.nodeId,
        readDependencies(tx, admitted.node.mission_id),
      ).includes(evidence.node_id)
    )
      return false;
    const outcome = readCurrentOutcome(tx, evidence.node_id);
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

function signGet(
  dependencies: Dependencies,
  caller: CallerContext,
  assetId: string,
  execution: boolean,
) {
  assert.ok(caller.identity);
  const call = { context: caller.context, identity: caller.identity };
  if (!execution) return dependencies.intakeStorage.get(call, assetId);
  assert.ok(caller.execution);
  return dependencies.intakeStorage.executionGet(
    { ...call, executionId: caller.execution.executionId },
    assetId,
  );
}

export interface ContentRequest {
  assetId: string;
  bound: ContentBound;
  execution: boolean;
}

export interface ContentRange {
  offset?: number;
  length?: number;
}

export interface DownloadRequest {
  assetId: string;
  range: ContentRange;
}

export async function prepareContent(
  dependencies: Dependencies,
  caller: CallerContext,
  request: ContentRequest,
) {
  const { assetId, bound, execution } = request;
  assert.ok(caller.identity);
  assert.equal(typeof bound, FUNCTION_TYPE);
  const prepared = dependencies.store.transaction((tx) => {
    const content = contentOf(tx, assetId, bound);
    if (content.object)
      authorizeStorage(
        tx,
        dependencies.bindings,
        content.object.storage_binding_id,
      );
    return content;
  });
  if (!prepared.object) return { result: prepared.result, signed: null };
  let object = prepared.object;
  for (let attempt = 0; attempt < MAX_SIGNINGS; attempt++) {
    const signed = await signGet(dependencies, caller, assetId, execution);
    const current = dependencies.store.transaction((tx) =>
      contentOf(tx, assetId, bound),
    );
    assert.ok(current.object);
    if (current.object.object_version !== object.object_version) {
      object = current.object;
      continue;
    }
    return { result: current.result, signed };
  }
  assert.fail(
    "An asset version is written once, so signing converges within two attempts.",
  );
}

export async function readContent(
  dependencies: Dependencies,
  caller: CallerContext,
  assetId: string,
  bound: ContentBound,
  execution: boolean,
) {
  const { result, signed } = await prepareContent(dependencies, caller, {
    assetId,
    bound,
    execution,
  });
  if (!signed)
    return caller.commit((tx) =>
      storedContentSchema.parse(contentOf(tx, assetId, bound).result),
    );
  return caller.commit((tx) => {
    const final = contentOf(tx, assetId, bound);
    assert.deepEqual(final.result.address, result.address);
    return storedContentSchema.parse({ ...final.result, ...signed });
  });
}

const EVIDENCE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/yaml": ".yaml",
  "text/yaml": ".yaml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const DEFAULT_FILE_EXTENSION = ".bin";
const EMPTY_SIZE = 0;
const DEFAULT_OFFSET = 0;
const MEDIA_TYPE_PARAMETER_SEPARATOR = ";";

function fileExtension(mediaType: string) {
  const essence = mediaType
    .split(MEDIA_TYPE_PARAMETER_SEPARATOR)[0]
    ?.trim()
    .toLowerCase();
  return (
    (essence === undefined ? undefined : EVIDENCE_FILE_EXTENSIONS[essence]) ??
    DEFAULT_FILE_EXTENSION
  );
}

function sliceOf(content: Buffer, range: ContentRange) {
  if (content.length === EMPTY_SIZE) return content;
  const offset = range.offset ?? DEFAULT_OFFSET;
  if (offset >= content.length)
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.EvidenceContentRangeInvalid,
      "The offset is at or after the end of the content.",
    );
  return content.subarray(offset, offset + (range.length ?? content.length));
}

export async function downloadContent(
  dependencies: Dependencies,
  caller: CallerContext,
  request: DownloadRequest,
) {
  const { result, signed } = await prepareContent(dependencies, caller, {
    assetId: request.assetId,
    bound: () => true,
    execution: false,
  });
  if (signed || !("data" in result))
    throw new OperationError(
      HttpStatus.BadGateway,
      MissionErrorCode.EvidenceContentUnavailable,
      "The storage read failed.",
    );
  const content = Buffer.from(result.data, CONTENT_ENCODING);
  const body = sliceOf(content, request.range);
  return new Response(body, {
    status: HttpStatus.OK,
    headers: {
      "Content-Type": MediaType.Binary,
      "Content-Length": String(body.length),
      "Content-Disposition": `attachment; filename="${request.assetId}${fileExtension(result.media_type)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "X-Evidence-Media-Type": result.media_type,
      "X-Evidence-Size": String(content.length),
    },
  });
}

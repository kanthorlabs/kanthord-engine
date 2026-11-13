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
    return { result: current.result, signed: { ...signed, headers: {} } };
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
  const { get_url, expires_at } = signed;
  return caller.commit((tx) => {
    const final = contentOf(tx, assetId, bound);
    assert.deepEqual(final.result.address, result.address);
    return storedContentSchema.parse({ ...final.result, get_url, expires_at });
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
const LAST_INDEX_OFFSET = 1;
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

interface ContentSlice {
  start: number;
  stop: number;
}

interface StoredBytes {
  mediaType: string;
  size: number;
  length: number;
}

interface ProducedContent {
  media_type: string;
  data: string;
}

interface ObjectSource {
  mediaType: string;
  size: number;
  signed: { get_url: string; headers: Record<string, string> };
}

function sliceBounds(size: number, range: ContentRange): ContentSlice {
  if (size === EMPTY_SIZE) return { start: EMPTY_SIZE, stop: EMPTY_SIZE };
  const start = range.offset ?? DEFAULT_OFFSET;
  if (start >= size)
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.EvidenceContentRangeInvalid,
      "The offset is at or after the end of the content.",
    );
  return { start, stop: Math.min(start + (range.length ?? size), size) };
}

function downloadHeaders(request: DownloadRequest, stored: StoredBytes) {
  return {
    "Content-Type": MediaType.Binary,
    "Content-Length": String(stored.length),
    "Content-Disposition": `attachment; filename="${request.assetId}${fileExtension(stored.mediaType)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Evidence-Media-Type": stored.mediaType,
    "X-Evidence-Size": String(stored.size),
  };
}

function storageUnavailable() {
  return new OperationError(
    HttpStatus.BadGateway,
    MissionErrorCode.EvidenceContentUnavailable,
    "The storage read failed.",
  );
}

function producedAnswer(request: DownloadRequest, produced: ProducedContent) {
  const content = Buffer.from(produced.data, CONTENT_ENCODING);
  const { start, stop } = sliceBounds(content.length, request.range);
  return new Response(content.subarray(start, stop), {
    status: HttpStatus.OK,
    headers: downloadHeaders(request, {
      mediaType: produced.media_type,
      size: content.length,
      length: stop - start,
    }),
  });
}

async function objectAnswer(
  caller: CallerContext,
  request: DownloadRequest,
  source: ObjectSource,
) {
  const { start, stop } = sliceBounds(source.size, request.range);
  const headers = downloadHeaders(request, {
    mediaType: source.mediaType,
    size: source.size,
    length: stop - start,
  });
  if (source.size === EMPTY_SIZE)
    return new Response(new Uint8Array(), { status: HttpStatus.OK, headers });
  const ranged = start > DEFAULT_OFFSET || stop < source.size;
  const { get_url } = source.signed;
  const storage = await fetch(get_url, {
    headers: {
      ...source.signed.headers,
      ...(ranged
        ? { Range: `bytes=${start}-${stop - LAST_INDEX_OFFSET}` }
        : {}),
    },
    redirect: "error",
    signal: caller.context.signal,
  }).catch(() => null);
  const accepted = ranged ? HttpStatus.PartialContent : HttpStatus.OK;
  if (storage?.status === accepted && storage.body)
    return new Response(storage.body, { status: HttpStatus.OK, headers });
  await storage?.body?.cancel().catch(() => undefined);
  throw storageUnavailable();
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
  if ("data" in result) return producedAnswer(request, result);
  assert.ok(signed);
  return objectAnswer(caller, request, {
    mediaType: result.media_type,
    size: result.size,
    signed,
  });
}

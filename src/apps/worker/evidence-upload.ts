import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  abortSignal,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import type { UploadResult } from "../../worker/contract.ts";
import type { WorkerApi } from "./api.ts";
import { completed } from "./handover.ts";

export const WorkerErrorCode = {
  EvidenceUploadPathRefused: "worker.evidence_upload.path_refused",
  EvidenceUploadTransferFailed: "worker.evidence_upload.transfer_failed",
} as const;
export const PathRefusal = {
  OutsideWorkspace: "outside_workspace",
  SymbolicLink: "symbolic_link",
  NotRegular: "not_regular",
  Replaced: "replaced",
} as const;
export const OBJECT_MEDIA_TYPE = "application/octet-stream";
const PARENT_DIRECTORY = "..";

function refuse(reason: (typeof PathRefusal)[keyof typeof PathRefusal]): never {
  throw Object.assign(
    new Diagnostic(
      WorkerErrorCode.EvidenceUploadPathRefused,
      `evidence upload: ${reason}.`,
    ),
    { details: { reason } },
  );
}
function inside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference !== PARENT_DIRECTORY &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

export async function openEvidence(workspace: string, path: string) {
  assert.ok(workspace);
  if (
    !path ||
    isAbsolute(path) ||
    !inside(resolve(workspace), resolve(workspace, path))
  )
    refuse(PathRefusal.OutsideWorkspace);
  const root = await realpath(workspace);
  const target = resolve(workspace, path);
  const parent = await realpath(dirname(target));
  if (!inside(root, parent)) refuse(PathRefusal.OutsideWorkspace);
  const before = await lstat(target);
  if (before.isSymbolicLink()) refuse(PathRefusal.SymbolicLink);
  if (!before.isFile()) refuse(PathRefusal.NotRegular);
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    const symlink = "ELOOP";
    if (error.code === symlink) refuse(PathRefusal.SymbolicLink);
    throw error;
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) refuse(PathRefusal.NotRegular);
    const after = await lstat(target);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      before.ino !== stat.ino ||
      before.dev !== stat.dev
    )
      refuse(PathRefusal.Replaced);
    if ((await realpath(dirname(target))) !== parent)
      refuse(PathRefusal.Replaced);
    assert.ok(stat.isFile());
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function transfer(
  file: Awaited<ReturnType<typeof open>>,
  putUrl: string,
  headers: Record<string, string>,
  context: Context,
) {
  const stream = file.createReadStream({ start: 0, autoClose: false });
  const bridge = abortSignal(context);
  try {
    const options: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers,
      body: stream as unknown as RequestInit["body"],
      duplex: "half",
      signal: bridge.signal,
      redirect: "error",
    };
    const response = await fetch(putUrl, options);
    await response.body?.cancel();
    if (!response.ok)
      throw new Diagnostic(
        WorkerErrorCode.EvidenceUploadTransferFailed,
        `evidence upload: the transfer failed with status ${response.status}.`,
      );
  } catch (error) {
    if (error instanceof Diagnostic) throw error;
    throw new Diagnostic(
      WorkerErrorCode.EvidenceUploadTransferFailed,
      "evidence upload: the transfer failed.",
    );
  } finally {
    stream.destroy();
    bridge.dispose();
  }
}

export async function uploadEvidence(input: {
  workspace: string;
  path: string;
  claim: ExecutionRecord;
  api: WorkerApi;
  context: Context;
}): Promise<UploadResult> {
  const { claim, api } = input;
  const context = new CancellationContext(input.context, claim.expiredAt);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfCancelled(context);
    file = await openEvidence(input.workspace, input.path);
    const bytes = await file.readFile();
    throwIfCancelled(context);
    const execution = {
      executionId: claim.executionId,
      attempt: claim.attempt,
      nodeRevision: claim.pinnedRevision,
    };
    const submitted = completed(
      await api.mission["evidence.submit"](
        {
          params: { nodeId: claim.nodeId },
          query: {},
          body: {
            ...execution,
            subject: input.path,
            assets: [
              {
                kind: "object",
                size: bytes.length,
                mediaType: OBJECT_MEDIA_TYPE,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              },
            ],
          },
        },
        { context, idempotencyKey: ulid() },
      ),
    );
    const singleUpload = 1;
    assert.equal(submitted.uploads.length, singleUpload);
    const upload = submitted.uploads[0]!;
    await transfer(file, upload.putUrl, upload.headers, context);
    const result = completed(
      await api.mission["evidence.asset.complete"](
        { params: { assetId: upload.assetId }, query: {}, body: execution },
        { context, idempotencyKey: ulid() },
      ),
    );
    assert.equal(result.assetId, upload.assetId);
    return {
      evidenceId: result.evidenceId,
      assetId: result.assetId,
      uri: result.uri,
    };
  } finally {
    await file?.close();
    context.cancel();
  }
}

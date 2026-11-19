import { createHash } from "node:crypto";
import { Diagnostic } from "../../kernel/errors.ts";
import { MissionErrorCode, OBJECT_SIZE_MAX } from "../../mission/contract.ts";
import type { LinkUpdateRead, UploadResult } from "../../worker/contract.ts";
import type {
  MethodClaim,
  SessionHostTools,
  TasksOutput,
} from "../../worker/unit/index.ts";
import {
  OBJECT_MEDIA_TYPE,
  openEvidence,
  WorkerErrorCode,
} from "./evidence-upload.ts";

const LOCAL_URI_PREFIX = "s3://local";
const FIRST_ITEM = 0;
const NO_CURSOR = null;

export interface LocalHostToolsInput {
  output: TasksOutput;
  claim: MethodClaim;
  linkUpdates: LinkUpdateRead["items"];
}

async function evidenceBytes(workspace: string, path: string): Promise<Buffer> {
  const file = await openEvidence(workspace, path);
  try {
    const { size } = await file.stat();
    if (size > OBJECT_SIZE_MAX)
      throw new Diagnostic(
        WorkerErrorCode.EvidenceUploadTransferFailed,
        "evidence upload: object exceeds the size limit.",
      );
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function linkUpdatePage(
  items: LinkUpdateRead["items"],
  cursor: string | undefined,
  limit: number,
): LinkUpdateRead {
  const start = cursor === undefined ? FIRST_ITEM : Number(cursor);
  if (
    !Number.isSafeInteger(start) ||
    start < FIRST_ITEM ||
    start > items.length
  )
    throw new Diagnostic(
      MissionErrorCode.CursorInvalid,
      "link updates: the cursor names no page.",
    );
  const end = start + limit;
  return {
    items: items.slice(start, end),
    next_cursor: end < items.length ? String(end) : NO_CURSOR,
    total: items.length,
  };
}

export function localHostTools(input: LocalHostToolsInput): SessionHostTools {
  const { output, claim } = input;
  const execution = {
    execution_id: claim.execution_id,
    attempt: claim.attempt,
    node_revision: claim.pinned_revision,
  };
  return (workspace) => ({
    async evidenceUpload(path): Promise<UploadResult> {
      const bytes = await evidenceBytes(workspace, path);
      const ids = output.nextEvidence();
      output.upload(ids, bytes);
      output.record({
        operation: "mission.evidence.submit",
        body: {
          ...execution,
          subject: path,
          assets: [
            {
              kind: "object",
              size: bytes.length,
              media_type: OBJECT_MEDIA_TYPE,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
        step: null,
      });
      return {
        ...ids,
        uri: `${LOCAL_URI_PREFIX}/${ids.evidence_id}/${ids.asset_id}`,
      };
    },
    async linkUpdateList(page) {
      output.record({
        operation: "worker.execution.link_update.get",
        body: { execution_id: claim.execution_id, ...page },
        step: null,
      });
      return linkUpdatePage(input.linkUpdates, page.cursor, page.limit);
    },
  });
}

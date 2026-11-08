import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../../kernel/json.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  EVIDENCE_UPLOAD_PARAMETERS,
  LINK_UPDATE_LIST_PARAMETERS,
} from "../../agent/catalog.ts";
import {
  HostTool,
  type HostTools,
  LINK_UPDATE_LIMIT_DEFAULT,
  linkUpdateReadSchema,
  uploadResultSchema,
} from "../contract.ts";

export function evidenceUploadTool(
  hostTools: HostTools,
): ToolDefinition<typeof EVIDENCE_UPLOAD_PARAMETERS> {
  assert.ok(hostTools);
  assert.ok(hostTools.evidenceUpload);
  return {
    name: HostTool.EvidenceUpload,
    label: "Upload workspace evidence",
    description:
      "Upload a workspace-relative path and return evidence_id, asset_id and uri.",
    parameters: EVIDENCE_UPLOAD_PARAMETERS,
    async execute(_id, params, signal) {
      assert.ok(params.path);
      const result = uploadResultSchema.parse(
        await asToolError(() => hostTools.evidenceUpload(params.path, signal)),
      );
      assert.ok(result.uri);
      return {
        content: [{ type: "text", text: canonicalJSON(result) }],
        details: result,
      };
    },
  };
}

export function linkUpdateListTool(
  hostTools: HostTools,
): ToolDefinition<typeof LINK_UPDATE_LIST_PARAMETERS> {
  assert.ok(hostTools);
  assert.ok(hostTools.linkUpdateList);
  return {
    name: HostTool.LinkUpdateList,
    label: "List link updates",
    description:
      "List a page of the updates of the external links of this node, newest first. Pass the cursor of a page to read the next page.",
    parameters: LINK_UPDATE_LIST_PARAMETERS,
    async execute(_id, params, signal) {
      const result = linkUpdateReadSchema.parse(
        await asToolError(() =>
          hostTools.linkUpdateList(
            {
              ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
              limit: params.limit ?? LINK_UPDATE_LIMIT_DEFAULT,
            },
            signal,
          ),
        ),
      );
      return {
        content: [{ type: "text", text: canonicalJSON(result) }],
        details: result,
      };
    },
  };
}

async function asToolError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Diagnostic)
      throw new Error(`${error.code}: ${error.message}`, { cause: error });
    throw error;
  }
}

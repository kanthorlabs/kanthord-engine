import assert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../kernel/json.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { HostTool, uploadResultSchema, type HostTools } from "./contract.ts";

export const EVIDENCE_UPLOAD_PARAMETERS = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export function evidenceUploadTool(
  hostTools: HostTools,
): ToolDefinition<typeof EVIDENCE_UPLOAD_PARAMETERS> {
  assert.ok(hostTools);
  assert.ok(hostTools.evidenceUpload);
  return {
    name: HostTool.EvidenceUpload,
    label: "Upload workspace evidence",
    description:
      "Upload a workspace-relative path and return evidenceId, assetId and uri.",
    parameters: EVIDENCE_UPLOAD_PARAMETERS,
    async execute(_id, params, signal) {
      assert.ok(params.path);
      const result = uploadResultSchema.parse(
        await invokeUpload(hostTools, params.path, signal),
      );
      assert.ok(result.uri);
      return {
        content: [{ type: "text", text: canonicalJSON(result) }],
        details: result,
      };
    },
  };
}

async function invokeUpload(
  hostTools: HostTools,
  path: string,
  signal: AbortSignal | undefined,
) {
  assert.ok(path);
  assert.ok(hostTools.evidenceUpload);
  try {
    return await hostTools.evidenceUpload(path, signal);
  } catch (error) {
    if (error instanceof Diagnostic)
      throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

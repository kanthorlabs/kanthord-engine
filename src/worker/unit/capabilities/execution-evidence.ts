import assert from "node:assert/strict";
import type {
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../../../kernel/json.ts";
import {
  EVIDENCE_UPLOAD_PARAMETERS,
  HostTool,
  type HostTools,
  uploadResultSchema,
} from "../../contract.ts";
import { asToolError, type SessionHostTools } from "./host-tools.ts";

type EvidenceUploadTool = ToolDefinition<typeof EVIDENCE_UPLOAD_PARAMETERS>;

const DECLARATION = {
  name: HostTool.EvidenceUpload,
  label: "Upload workspace evidence",
  description:
    "Upload a workspace-relative path and return evidence_id, asset_id and uri.",
  parameters: EVIDENCE_UPLOAD_PARAMETERS,
  annotations: { openWorldHint: false },
} satisfies Omit<EvidenceUploadTool, "execute">;

export function evidenceUploadTool(hostTools: HostTools): EvidenceUploadTool {
  assert.ok(hostTools);
  assert.ok(hostTools.evidenceUpload);
  return {
    ...DECLARATION,
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

export function executionEvidence(tools: SessionHostTools): InlineExtension {
  assert.ok(tools);
  return (pi) => {
    pi.registerTool({
      ...DECLARATION,
      execute: (...args: Parameters<EvidenceUploadTool["execute"]>) =>
        evidenceUploadTool(tools(args[4].cwd)).execute(...args),
    });
  };
}

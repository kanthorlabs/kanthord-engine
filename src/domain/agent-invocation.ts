import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, jsonText } from "./column.ts";
import { agentKind } from "./agent.ts";
import { blobHash } from "./blob.ts";

export const agentInvocationRow = z.object({
  id: identity("agentInvocation"),
  attemptId: identity("attempt"),
  agent: agentKind,
  adapterVersion: z.string(),
  promptBlob: blobHash,
  sourcesJson: jsonText,
  toolDefinitionsBlob: blobHash,
  toolTraceBlob: blobHash.nullable(),
  diffBlob: blobHash.nullable(),
  verdict: z.enum(["accept", "reject"]).nullable(),
  reasonBlob: blobHash.nullable(),
  usageJson: jsonText.nullable(),
  errorBlob: blobHash.nullable(),
  endedAt: epochMillis.nullable(),
});
export type AgentInvocationRow = z.infer<typeof agentInvocationRow>;

import {
  type Api,
  type AssistantMessage,
  type Model,
  type Tool,
  type ToolCall,
  Type,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { GUARD_PROMPT } from "../agent/prompt-assets.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  GUARD_AUTO_CONFIDENCE,
  GUARD_MAX_TOKENS,
  GUARD_REASON_MAX_CHARS,
  GUARD_REQUEST_MAX_BYTES,
  GUARD_TEXT_KEEP_CHARS,
  GUARD_TIMEOUT_MS,
  GUARD_TOOL_NAME,
  GuardCause,
} from "./contract.ts";

const NO_CHARS = 0;
export const GuardTier = { Auto: "auto", Confirm: "confirm" } as const;
export const ClassifyKind = {
  Verdict: "verdict",
  Failed: "failed",
  Aborted: "aborted",
} as const;
const TOOL_CALL_BLOCK = "toolCall";
const TOOL_USE_STOP = "toolUse";

export const GUARD_TOOL: Tool = {
  name: GUARD_TOOL_NAME,
  description:
    "Give the verdict on the tool call: auto when the run message directs it, confirm otherwise.",
  parameters: Type.Object(
    {
      tier: Type.Unsafe<typeof GuardTier.Auto | typeof GuardTier.Confirm>({
        type: "string",
        enum: [GuardTier.Auto, GuardTier.Confirm],
      }),
      confidence: Type.Number(),
      request_quote: Type.String(),
      reason: Type.String(),
    },
    { additionalProperties: false },
  ),
  constrainedSampling: { type: "json_schema", strict: "require" },
};

export const guardVerdictSchema = z.strictObject({
  tier: z.enum(GuardTier),
  confidence: z.number().min(0).max(1),
  request_quote: z.string(),
  reason: z.string().max(GUARD_REASON_MAX_CHARS),
});
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

export interface GuardCall {
  operation_id: string;
  description: string;
  input: unknown;
}

export type GuardRequest = UserMessage & { content: string };

export type ClassifyResult =
  | { kind: typeof ClassifyKind.Verdict; verdict: GuardVerdict }
  | {
      kind: typeof ClassifyKind.Failed;
      cause: typeof GuardCause.NoVerdict | typeof GuardCause.Oversize;
    }
  | { kind: typeof ClassifyKind.Aborted };

export type CallDecision =
  | { tier: typeof GuardTier.Auto }
  | { tier: typeof GuardTier.Confirm; cause: typeof GuardCause.Classifier };

export interface ClassifyInput {
  runtime: Pick<ModelRuntime, "complete">;
  model: Model<Api>;
  request: GuardRequest;
  signal: AbortSignal;
}

export function redactForeignText(input: unknown, request: string): unknown {
  if (isString(input))
    return input.length > GUARD_TEXT_KEEP_CHARS && !request.includes(input)
      ? `<agent text, ${input.length} chars>`
      : input;
  if (Array.isArray(input))
    return input.map((item) => redactForeignText(item, request));
  if (!isObject(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      redactForeignText(value, request),
    ]),
  );
}

export function guardRequest(
  request: string,
  call: GuardCall,
  agentName: string,
): GuardRequest {
  return {
    role: "user",
    content: JSON.stringify({
      agent: agentName,
      request,
      call: {
        operation_id: call.operation_id,
        description: call.description,
        input: redactForeignText(call.input, request),
      },
    }),
    timestamp: Date.now(),
  };
}

function verdictOf(reply: AssistantMessage): ClassifyResult {
  const noVerdict = {
    kind: ClassifyKind.Failed,
    cause: GuardCause.NoVerdict,
  } as const;
  if (reply.stopReason !== TOOL_USE_STOP) return noVerdict;
  const call = reply.content.find(
    (block): block is ToolCall =>
      block.type === TOOL_CALL_BLOCK && block.name === GUARD_TOOL_NAME,
  );
  if (!call) return noVerdict;
  const parsed = guardVerdictSchema.safeParse(call.arguments);
  return parsed.success
    ? { kind: ClassifyKind.Verdict, verdict: parsed.data }
    : noVerdict;
}

export async function classifyCall(
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const { runtime, model, request, signal } = input;
  if (Buffer.byteLength(request.content) > GUARD_REQUEST_MAX_BYTES)
    return { kind: ClassifyKind.Failed, cause: GuardCause.Oversize };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), GUARD_TIMEOUT_MS);
  try {
    const reply = await runtime.complete(
      model,
      { systemPrompt: GUARD_PROMPT, messages: [request], tools: [GUARD_TOOL] },
      {
        signal: AbortSignal.any([signal, timeout.signal]),
        maxTokens: GUARD_MAX_TOKENS,
        toolChoice: { type: "tool", name: GUARD_TOOL_NAME },
        thinkingEnabled: false,
      },
    );
    return signal.aborted ? { kind: ClassifyKind.Aborted } : verdictOf(reply);
  } catch {
    return signal.aborted
      ? { kind: ClassifyKind.Aborted }
      : { kind: ClassifyKind.Failed, cause: GuardCause.NoVerdict };
  } finally {
    clearTimeout(timer);
  }
}

export function decide(verdict: GuardVerdict, request: string): CallDecision {
  const authorized =
    verdict.tier === GuardTier.Auto &&
    verdict.confidence >= GUARD_AUTO_CONFIDENCE &&
    verdict.request_quote.length > NO_CHARS &&
    request.includes(verdict.request_quote);
  return authorized
    ? { tier: GuardTier.Auto }
    : { tier: GuardTier.Confirm, cause: GuardCause.Classifier };
}

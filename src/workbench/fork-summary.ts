import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FORK_SUMMARY_PROMPT } from "../agent/prompt-assets.ts";
import { CancellationContext } from "../kernel/context.ts";
import {
  FORK_SUMMARY_MAX_BYTES,
  FORK_SUMMARY_MAX_TOKENS,
  FORK_SUMMARY_TIMEOUT_MS,
} from "./contract.ts";

const HIDDEN_CHARACTERS =
  /[\p{Cf}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]|(?![\n\t])\p{Cc}/gu;
const NO_TEXT = "";
const TEXT_BLOCK = "text";
const STOP = "stop";

export type ForkSummaryRequest = UserMessage & { content: string };

export type SummarizeResult = { ok: true; summary: string } | { ok: false };

export interface SummarizeInput {
  runtime: Pick<ModelRuntime, "completeSimple">;
  model: Model<Api>;
  request: ForkSummaryRequest;
  signal: AbortSignal;
}

export function visibleText(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, NO_TEXT);
}

export function forkSummaryRequest(
  material: string,
  text: string,
): ForkSummaryRequest {
  return {
    role: "user",
    content: JSON.stringify({ instruction: text, conversation: material }),
    timestamp: Date.now(),
  };
}

function summaryOf(reply: AssistantMessage): SummarizeResult {
  if (reply.stopReason !== STOP) return { ok: false };
  const summary = visibleText(
    reply.content
      .filter((block): block is TextContent => block.type === TEXT_BLOCK)
      .map((block) => block.text)
      .join(NO_TEXT),
  );
  if (summary.trim() === NO_TEXT) return { ok: false };
  if (Buffer.byteLength(summary) > FORK_SUMMARY_MAX_BYTES) return { ok: false };
  return { ok: true, summary };
}

export async function summarize(
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const { runtime, model, request, signal } = input;
  const deadline = new CancellationContext(
    { signal, deadline: null },
    Date.now() + FORK_SUMMARY_TIMEOUT_MS,
  );
  try {
    const reply = await runtime.completeSimple(
      model,
      { systemPrompt: FORK_SUMMARY_PROMPT, messages: [request] },
      { signal: deadline.signal, maxTokens: FORK_SUMMARY_MAX_TOKENS },
    );
    return deadline.signal.aborted ? { ok: false } : summaryOf(reply);
  } catch {
    return { ok: false };
  } finally {
    deadline.cancel();
  }
}

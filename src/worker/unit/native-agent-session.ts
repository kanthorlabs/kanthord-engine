import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import type { PromptTemplate } from "../../agent/contract.ts";
import type { SpanStatus } from "../../tracking/contract.ts";
import type { ExecutionBudget } from "./budget.ts";

export interface NativeAgent {
  prompt(work: WorkPrompt): Promise<void>;
  instruct(
    work: WorkPrompt,
    text: string,
    template: PromptTemplate,
  ): Promise<void>;
  lastText(): string | undefined;
  abort(): Promise<void>;
  readonly budget: ExecutionBudget;
  closeTrace(status: SpanStatus): void;
  close(): Promise<void>;
}

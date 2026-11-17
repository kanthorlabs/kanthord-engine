import type { HumanIdentity } from "../../kernel/caller.ts";
import type {
  InlineExtension,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export type ToolDecision =
  | { allowed: true; approver?: HumanIdentity }
  | { allowed: false; reason: string; terminate: boolean };

export function toolApproval(input: {
  approve(
    call: ToolCallEvent,
    signal: AbortSignal | undefined,
  ): Promise<ToolDecision>;
}): InlineExtension {
  return (pi) => {
    pi.on("tool_call", async (event, context) => {
      const decision = await input.approve(event, context.signal);
      return decision.allowed
        ? undefined
        : {
            block: true,
            reason: decision.reason,
            terminate: decision.terminate,
          };
    });
  };
}

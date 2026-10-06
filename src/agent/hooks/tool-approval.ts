import assert from "node:assert/strict";
import type {
  InlineExtension,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export function toolApproval(input: {
  approve(
    call: ToolCallEvent,
    signal: AbortSignal | undefined,
  ): Promise<boolean>;
  reason: string;
}): InlineExtension {
  assert.ok(input.reason);
  return (pi) => {
    pi.on("tool_call", async (event, context) =>
      (await input.approve(event, context.signal))
        ? undefined
        : { block: true, reason: input.reason },
    );
  };
}

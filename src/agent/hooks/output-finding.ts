import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionRedaction } from "../redaction.ts";

const ASSISTANT_ROLE = "assistant";

export function outputFinding(state: SessionRedaction): InlineExtension {
  return (pi) => {
    pi.on("message_end", (event) => {
      const message = event.message as unknown as Record<string, unknown>;
      if (message.role !== ASSISTANT_ROLE) return undefined;
      state.recordOutputFinding(message);
      return undefined;
    });
  };
}

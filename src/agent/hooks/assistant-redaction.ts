import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionRedaction } from "../redaction.ts";

const ASSISTANT_ROLE = "assistant";
const CUSTOM_ROLE = "custom";
const COMPACTION_SUMMARY_ROLE = "compactionSummary";

export function assistantRedaction(state: SessionRedaction): InlineExtension {
  return (pi) => {
    pi.on("message_end", async (event) => {
      const message = event.message as unknown as Record<string, unknown>;
      if (message.role !== ASSISTANT_ROLE) return undefined;
      await state.refresh();
      const copy = state.redactEvent(message);
      return copy ? { message: copy as typeof event.message } : undefined;
    });
    pi.on("context", (event) => {
      let changed = false;
      const messages = event.messages.map((message) => {
        const record = message as unknown as Record<string, unknown>;
        if (record.role === COMPACTION_SUMMARY_ROLE) {
          const summary = String(record.summary);
          const next = state.redactSummaryText(summary);
          if (next === summary) return message;
          changed = true;
          return { ...message, summary: next } as typeof message;
        }
        if (record.role !== CUSTOM_ROLE) return message;
        const copy = state.redactEvent(record);
        if (!copy) return message;
        changed = true;
        return copy as unknown as typeof message;
      });
      return changed ? { messages } : undefined;
    });
    pi.on("session_compact", (event) => {
      const summary = event.compactionEntry.summary;
      event.compactionEntry.summary = state.redactSessionCompact(summary);
    });
  };
}

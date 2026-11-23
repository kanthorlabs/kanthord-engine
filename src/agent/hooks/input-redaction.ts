import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionRedaction } from "../redaction.ts";

const REDACTED_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "toolResult",
  "custom",
]);

export function inputRedaction(state: SessionRedaction): InlineExtension {
  return (pi) => {
    pi.on("turn_start", async () => {
      await state.refresh();
    });
    pi.on("message_end", async (event) => {
      const message = event.message as unknown as Record<string, unknown>;
      if (!REDACTED_ROLES.has(String(message.role))) return undefined;
      const copy = state.redactEvent(message);
      return copy ? { message: copy as typeof event.message } : undefined;
    });
  };
}

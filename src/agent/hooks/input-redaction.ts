import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionRedaction } from "../redaction.ts";

const REDACTED_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "toolResult",
  "custom",
]);
const ASSISTANT_ROLE = "assistant";
const CUSTOM_ROLE = "custom";

type Message = Record<string, unknown>;

async function redacted(
  state: SessionRedaction,
  message: Message,
): Promise<Message | undefined> {
  if (message.role === ASSISTANT_ROLE) {
    await state.refresh();
    return state.redactErrorMessage(message);
  }
  if (!REDACTED_ROLES.has(String(message.role))) return undefined;
  return state.redactEvent(message);
}

export function inputRedaction(state: SessionRedaction): InlineExtension {
  return (pi) => {
    pi.on("turn_start", async () => {
      await state.refresh();
    });
    pi.on("message_end", async (event) => {
      const copy = await redacted(state, event.message as unknown as Message);
      return copy ? { message: copy as typeof event.message } : undefined;
    });
    pi.on("context", (event) => {
      let changed = false;
      const messages = event.messages.map((message) => {
        const record = message as unknown as Message;
        if (record.role !== CUSTOM_ROLE) return message;
        const copy = state.redactEvent(record);
        if (!copy) return message;
        changed = true;
        return copy as unknown as typeof message;
      });
      return changed ? { messages } : undefined;
    });
  };
}

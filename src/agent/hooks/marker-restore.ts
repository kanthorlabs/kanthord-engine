import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { RestoreReason, type SessionRedaction } from "../redaction.ts";

export function markerRestore(state: SessionRedaction): InlineExtension {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (state.hasKnownSecretIn(event.input as Record<string, unknown>)) {
        state.addRestoreBlocked();
        return { block: true, reason: RestoreReason.KnownCredential };
      }
      let reason: RestoreReason | undefined;
      try {
        reason = state.restoreInput(event);
      } catch {
        reason = RestoreReason.Unkept;
      }
      if (!reason) return undefined;
      state.addRestoreBlocked();
      if (state.outermostCallId(event) === event.toolCallId)
        state.deletePending(event.toolCallId);
      return { block: true, reason };
    });
    pi.on("agent_end", () => {
      state.clearPending();
    });
  };
}

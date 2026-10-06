import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const LAYER_MESSAGE_TYPE = "kanthord.prompt-layer";
const CUSTOM_ROLE = "custom";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const TEXT_TYPE = "text";
const FIRST_INDEX = 0;

export function pinnedLayersHook(
  pinned: () => { layers: string[]; work: string | null },
): InlineExtension {
  const message = (content: string): AgentMessage => ({
    role: CUSTOM_ROLE,
    customType: LAYER_MESSAGE_TYPE,
    content,
    display: false,
    timestamp: Date.now(),
  });
  return (pi) => {
    pi.on("context", (event) => {
      const { layers, work } = pinned();
      const messages = layers.map(message);
      const hasWork = event.messages.some(
        (entry) =>
          entry.role === USER_ROLE &&
          (Array.isArray(entry.content)
            ? entry.content
                .filter((block) => block.type === TEXT_TYPE)
                .map((block) => block.text)
                .join("")
            : entry.content) === work,
      );
      if (work && !hasWork) messages.push(message(work));
      const remaining = event.messages.filter(
        (entry) =>
          !(
            entry.role === CUSTOM_ROLE &&
            entry.customType === LAYER_MESSAGE_TYPE
          ),
      );
      const boundary = remaining.findIndex(
        (entry) => entry.role !== SYSTEM_ROLE,
      );
      const prefix = boundary < FIRST_INDEX ? remaining.length : boundary;
      return {
        messages: [
          ...remaining.slice(0, prefix),
          ...messages,
          ...remaining.slice(prefix),
        ],
      };
    });
  };
}

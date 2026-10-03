import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { LayerText, WorkPrompt } from "./prompt-composer.ts";

export const LAYER_MESSAGE_TYPE = "kanthord.prompt-layer";
const CUSTOM_ROLE = "custom";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const TEXT_TYPE = "text";
const TURN_END = "turn_end";
const FIRST_INDEX = 0;

export function pinnedLayers(layers: {
  global: LayerText | null;
  project: LayerText | null;
}): {
  extension: InlineExtension;
  setWork(work: WorkPrompt): void;
  pinInference(session: AgentSession, systemPrompt: string): void;
} {
  assert.ok(Object.hasOwn(layers, "global"));
  assert.ok(Object.hasOwn(layers, "project"));
  let work: WorkPrompt | null = null;
  const message = (content: string): AgentMessage => ({
    role: CUSTOM_ROLE,
    customType: LAYER_MESSAGE_TYPE,
    content,
    display: false,
    timestamp: Date.now(),
  });
  const extension: InlineExtension = (pi) => {
    pi.on("context", (event) => {
      const pinned = [layers.global, layers.project]
        .filter((layer) => layer !== null)
        .map((layer) => message(layer.marked));
      const hasWork = event.messages.some(
        (entry) =>
          entry.role === USER_ROLE &&
          (Array.isArray(entry.content)
            ? entry.content
                .filter((block) => block.type === TEXT_TYPE)
                .map((block) => block.text)
                .join("")
            : entry.content) === work?.marked,
      );
      if (work && !hasWork) pinned.push(message(work.marked));
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
          ...pinned,
          ...remaining.slice(prefix),
        ],
      };
    });
  };
  return {
    extension,
    setWork: (value) => {
      work = value;
    },
    pinInference: (session, systemPrompt) => {
      const original = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) =>
        original(
          model,
          pinContext(
            context,
            systemPrompt,
            [
              layers.global?.marked,
              layers.project?.marked,
              work?.marked,
            ].filter((text) => text !== undefined),
          ),
          options,
        );
    },
  };
}

function pinContext(
  context: TranscriptContext,
  systemPrompt: string,
  layers: string[],
): TranscriptContext {
  assert.ok(systemPrompt);
  assert.ok(context.messages);
  const messages = [...context.messages];
  const first = messages[0];
  const declared =
    first?.role === SYSTEM_ROLE &&
    (contentText(first.content) === systemPrompt ||
      Object.values(first.sections ?? {}).includes(systemPrompt));
  if (!declared)
    messages.unshift({
      role: SYSTEM_ROLE,
      content: systemPrompt,
      timestamp: Date.now(),
    });
  const boundary = messages.findIndex((entry) => entry.role !== SYSTEM_ROLE);
  const prefix = boundary < FIRST_INDEX ? messages.length : boundary;
  const missing: Message[] = layers
    .filter(
      (layer) =>
        !messages.some(
          (entry) =>
            entry.role === USER_ROLE && contentText(entry.content) === layer,
        ),
    )
    .map((content) => ({ role: USER_ROLE, content, timestamp: Date.now() }));
  return {
    ...context,
    messages: [
      ...messages.slice(0, prefix),
      ...missing,
      ...messages.slice(prefix),
    ],
  };
}

export function countTurns(
  session: AgentSession,
  onTurnEnd: () => void,
): () => void {
  assert.ok(session);
  assert.ok(onTurnEnd);
  return session.subscribe((event) => {
    if (event.type === TURN_END) onTurnEnd();
  });
}

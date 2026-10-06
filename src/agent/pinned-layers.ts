import assert from "node:assert/strict";
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
import { pinnedLayersHook } from "./hooks/pinned-layers.ts";

const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const TURN_END = "turn_end";
const FIRST_INDEX = 0;

export function pinnedLayers(layers: {
  global: LayerText | null;
  project: LayerText | null;
}): {
  hook: InlineExtension;
  setWork(work: WorkPrompt): void;
  pinInference(session: AgentSession, systemPrompt: string): void;
} {
  assert.ok(Object.hasOwn(layers, "global"));
  assert.ok(Object.hasOwn(layers, "project"));
  let work: WorkPrompt | null = null;
  const hook = pinnedLayersHook(() => ({
    layers: [layers.global, layers.project]
      .filter((layer) => layer !== null)
      .map((layer) => layer.marked),
    work: work?.marked ?? null,
  }));
  return {
    hook,
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

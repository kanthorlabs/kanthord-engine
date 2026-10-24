import assert from "node:assert/strict";
import { PromptLayerKind, PromptSourceState } from "./contract.ts";
import { layerText, type LayerText } from "./prompt-composer.ts";
import type { ResolvedLayer } from "./prompt-layers.ts";
import {
  PromptTemplate,
  type AgentName,
  type PromptTemplates,
} from "./contract.ts";
import { renderTemplate } from "./prompt-templates.ts";

export const PromptConsumer = {
  Workbench: "workbench",
  Worker: "worker",
} as const;
export type PromptConsumer =
  (typeof PromptConsumer)[keyof typeof PromptConsumer];

const FRAMING_TEMPLATES: Record<PromptConsumer, PromptTemplate> = {
  [PromptConsumer.Workbench]: PromptTemplate.FramingWorkbench,
  [PromptConsumer.Worker]: PromptTemplate.FramingWorker,
};

export function framing(
  templates: PromptTemplates,
  consumer: PromptConsumer,
): string {
  assert.ok(Object.hasOwn(FRAMING_TEMPLATES, consumer));
  return renderTemplate(templates, FRAMING_TEMPLATES[consumer], {});
}

export function layerTexts(
  layer: ResolvedLayer,
  templates: PromptTemplates,
): LayerText[] {
  return layer.sources
    .filter((source) => source.state === PromptSourceState.Present)
    .map((source) => {
      assert.ok(source.text !== null);
      return layerText(
        templates,
        layer.name,
        source.owner,
        source.label,
        source.text,
      );
    });
}

const PART_SEPARATOR = "\n\n";
const NO_CHARACTERS = 0;

export interface BindingPrompt {
  name: string;
  text: string;
}

export function bindingPrompts(
  repositories: readonly {
    name: string;
    prompts: Partial<Record<AgentName, string>>;
  }[],
  agentName: string,
): BindingPrompt[] {
  return repositories.flatMap(({ name, prompts }) => {
    const text = Object.hasOwn(prompts, agentName)
      ? prompts[agentName as AgentName]
      : undefined;
    return text === undefined || text.trim().length === NO_CHARACTERS
      ? []
      : [{ name, text }];
  });
}

function bindingText(binding: BindingPrompt): string {
  assert.ok(binding.name);
  return `Instructions of repository ${binding.name}:\n\n${binding.text}`;
}

export function systemPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
  templates: PromptTemplates,
  bindings: readonly BindingPrompt[] = [],
): string {
  return [
    ...layers
      .filter((layer) => layer.layer !== PromptLayerKind.Working)
      .flatMap((layer) => layerTexts(layer, templates))
      .map(({ text }) => text),
    ...bindings.map(bindingText),
    framing(templates, consumer),
  ].join(PART_SEPARATOR);
}

export function finalPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
  templates: PromptTemplates,
  bindings: readonly BindingPrompt[] = [],
): string {
  return [
    systemPrompt(layers, consumer, templates, bindings),
    ...workingTexts(layers, templates).map(({ message }) => message),
  ].join(PART_SEPARATOR);
}

export function workingTexts(
  layers: readonly ResolvedLayer[],
  templates: PromptTemplates,
): LayerText[] {
  return layers
    .filter((layer) => layer.layer === PromptLayerKind.Working)
    .flatMap((layer) => layerTexts(layer, templates));
}

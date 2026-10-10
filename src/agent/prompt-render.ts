import assert from "node:assert/strict";
import { PromptLayerKind, PromptSourceState } from "./contract.ts";
import {
  layerText,
  type CompositionRecord,
  type LayerText,
} from "./prompt-composer.ts";
import type { ResolvedLayer } from "./prompt-layers.ts";
import { PromptTemplate, type PromptTemplates } from "./contract.ts";
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

export function systemPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
  templates: PromptTemplates,
): string {
  return [
    ...layers
      .filter((layer) => layer.layer !== PromptLayerKind.Working)
      .flatMap((layer) => layerTexts(layer, templates))
      .map(({ text }) => text),
    framing(templates, consumer),
  ].join(PART_SEPARATOR);
}

export function finalPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
  templates: PromptTemplates,
): string {
  return [
    systemPrompt(layers, consumer, templates),
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

export function compositionRecord(
  layers: readonly ResolvedLayer[],
): CompositionRecord {
  const record: CompositionRecord = { selected: [], rejected: [] };
  for (const layer of layers)
    for (const source of layer.sources) {
      if (source.state === PromptSourceState.Present) {
        assert.ok(source.digest !== null);
        record.selected.push({
          layer: layer.name,
          owner: source.owner,
          source: source.label,
          path: source.path,
          digest: source.digest,
        });
      }
      if (source.state === PromptSourceState.Invalid) {
        assert.ok(source.reason !== null);
        record.rejected.push({
          layer: layer.name,
          source: source.label,
          path: source.path,
          reason: source.reason,
        });
      }
    }
  return record;
}

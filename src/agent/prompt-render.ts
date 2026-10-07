import assert from "node:assert/strict";
import { PromptLayerKind, PromptSourceState } from "./contract.ts";
import {
  layerText,
  PromptLayer,
  type CompositionRecord,
  type LayerText,
} from "./prompt-composer.ts";
import type { ResolvedLayer } from "./prompt-layers.ts";

export const PromptConsumer = {
  Workbench: "workbench",
  Worker: "worker",
} as const;
export type PromptConsumer =
  (typeof PromptConsumer)[keyof typeof PromptConsumer];

const PRECEDENCE: Record<PromptConsumer, string> = {
  [PromptConsumer.Workbench]: [
    PromptLayer.AgentLayer,
    PromptLayer.SystemLayer,
    PromptLayer.WorkingLayer,
  ].join(", "),
  [PromptConsumer.Worker]: [
    PromptLayer.AgentLayer,
    PromptLayer.SystemLayer,
    PromptLayer.Work,
    PromptLayer.WorkingLayer,
  ].join(", "),
};

export function framing(consumer: PromptConsumer): string {
  assert.ok(Object.hasOwn(PRECEDENCE, consumer));
  return `This prompt holds prompt layers. Each layer names its owner and its source. The precedence from the highest to the lowest is: ${PRECEDENCE[consumer]}. A layer of higher precedence governs a layer of lower precedence. No layer revokes an obligation of the agent layer or of the system layer. A layer authorizes no operation.`;
}

export function layerTexts(layer: ResolvedLayer): LayerText[] {
  return layer.sources
    .filter((source) => source.state === PromptSourceState.Present)
    .map((source) => {
      assert.ok(source.text !== null);
      return layerText(layer.name, source.owner, source.label, source.text);
    });
}

export function finalPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
): string {
  return [
    framing(consumer),
    ...layers.flatMap(layerTexts).map((text) => text.marked),
  ].join("\n");
}

export function systemPrompt(
  layers: readonly ResolvedLayer[],
  consumer: PromptConsumer,
): string {
  return finalPrompt(
    layers.filter((layer) => layer.layer !== PromptLayerKind.Working),
    consumer,
  );
}

export function workingTexts(layers: readonly ResolvedLayer[]): LayerText[] {
  return layers
    .filter((layer) => layer.layer === PromptLayerKind.Working)
    .flatMap(layerTexts);
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { InvalidReason } from "./prompt-source.ts";
import { PromptTemplate, type PromptTemplates } from "./contract.ts";
import { renderTemplate } from "./prompt-templates.ts";

export const PromptLayer = {
  Work: "work prompt",
  SystemLayer: "system layer",
  AgentLayer: "agent layer",
  WorkingLayer: "working layer",
} as const;
export type PromptLayer = (typeof PromptLayer)[keyof typeof PromptLayer];
export interface LayerText {
  layer: PromptLayer;
  owner: string;
  source: string;
  text: string;
  message: string;
}
export interface CompositionRecord {
  selected: {
    layer: PromptLayer;
    owner: string;
    source: string;
    path: string | null;
    digest: string;
  }[];
  rejected: {
    layer: PromptLayer;
    source: string;
    path: string | null;
    reason: InvalidReason;
  }[];
}
export interface WorkPrompt {
  text: string;
  digest: string;
}
export function digest(text: string): string {
  const result = createHash("sha256").update(text, "utf8").digest("hex");
  assert.match(result, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.isEncoding("utf8"));
  return result;
}

export function layerText(
  templates: PromptTemplates,
  layer: PromptLayer,
  owner: string,
  source: string,
  text: string,
): LayerText {
  assert.ok(owner);
  assert.ok(source);
  return {
    layer,
    owner,
    source,
    text,
    message: renderTemplate(templates, PromptTemplate.LayerMessage, {
      source,
      text,
    }),
  };
}

export function renderWorkPrompt(
  templates: PromptTemplates,
  unit: {
    node_id: string;
    revision: number;
    content: {
      name: string;
      requirement: string;
      criterion: string;
      verifications: string[];
    };
  },
): WorkPrompt {
  assert.ok(unit.node_id);
  assert.ok(Number.isSafeInteger(unit.revision));
  const { name, requirement, criterion, verifications } = unit.content;
  const text = renderTemplate(templates, PromptTemplate.Work, {
    name,
    requirement,
    criterion,
    verifications: verifications.map((command, index) => ({
      number: index + 1,
      command,
    })),
  });
  return { text, digest: digest(text) };
}

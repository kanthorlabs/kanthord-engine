import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { InvalidReason } from "./prompt-source.ts";

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
    message: `Instructions of ${source}:\n\n${text}`,
  };
}

export function renderWorkPrompt(unit: {
  node_id: string;
  revision: number;
  content: {
    name: string;
    requirement: string;
    criterion: string;
    verifications: string[];
  };
}): WorkPrompt {
  assert.ok(unit.node_id);
  assert.ok(Number.isSafeInteger(unit.revision));
  const { name, requirement, criterion, verifications } = unit.content;
  const text = `# ${name}\n\n## Requirement\n\n${requirement}\n\n## Criterion\n\n${criterion}\n\n## Verifications\n\n${verifications.map((command, index) => `${index + 1}. ${command}`).join("\n")}`;
  return { text, digest: digest(text) };
}

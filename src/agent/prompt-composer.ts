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

const LISTED_REPOSITORIES_MIN = 2;
export interface WorkRepository {
  name: string;
  directory: string;
  base_branch: string;
}

export interface WorkTask {
  id: string;
  content: { name: string; criterion: string };
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
    repositories?: readonly WorkRepository[];
    tasks?: readonly WorkTask[];
  },
): WorkPrompt {
  assert.ok(unit.node_id);
  assert.ok(Number.isSafeInteger(unit.revision));
  const { name, requirement, criterion, verifications } = unit.content;
  const repositories = unit.repositories ?? [];
  const tasks = unit.tasks ?? [];
  const text = renderTemplate(templates, PromptTemplate.Work, {
    name,
    requirement,
    criterion,
    verifications: verifications.map((command, index) => ({
      number: index + 1,
      command,
    })),
    tasks: tasks.map((task, index) => ({
      number: index + 1,
      id: task.id,
      name: task.content.name,
      criterion: task.content.criterion,
    })),
    repositories:
      repositories.length >= LISTED_REPOSITORIES_MIN ? repositories : [],
  });
  return { text, digest: digest(text) };
}

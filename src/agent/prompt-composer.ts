import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PromptTemplate, type PromptTemplates } from "./contract.ts";
import { renderTemplate } from "./prompt-templates.ts";

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

export interface WorkNode {
  name: string;
  requirement: string;
  criterion: string;
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
    node?: WorkNode;
  },
): WorkPrompt {
  assert.ok(unit.node_id);
  assert.ok(Number.isSafeInteger(unit.revision));
  const { name, requirement, criterion, verifications } = unit.content;
  const repositories = unit.repositories ?? [];
  const tasks = unit.tasks ?? [];
  const text = renderTemplate(templates, PromptTemplate.Work, {
    node: unit.node
      ? {
          name: unit.node.name,
          requirement: unit.node.requirement,
          criterion: unit.node.criterion,
        }
      : null,
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

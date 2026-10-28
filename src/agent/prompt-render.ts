import assert from "node:assert/strict";
import {
  type AgentName,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptTemplate,
  type PromptTemplates,
} from "./contract.ts";
import { digest } from "./prompt-composer.ts";
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

const PART_SEPARATOR = "\n\n";
const NO_CHARACTERS = 0;

export function bindingParts(
  repositories: readonly {
    name: string;
    prompts: Partial<Record<AgentName, string>>;
  }[],
  agentName: string,
): PromptPartAnswer[] {
  return repositories.flatMap(({ name, prompts }) => {
    const text = Object.hasOwn(prompts, agentName)
      ? prompts[agentName as AgentName]
      : undefined;
    return text === undefined || text.trim().length === NO_CHARACTERS
      ? []
      : [
          {
            part: PromptPart.Binding,
            name,
            origin: PromptOrigin.Database,
            path: null,
            digest: digest(text),
            text,
          },
        ];
  });
}

function partText(part: PromptPartAnswer): string {
  if (part.part !== PromptPart.Binding) return part.text;
  assert.ok(part.name);
  return `Instructions of repository ${part.name}:\n\n${part.text}`;
}

export function systemPrompt(
  parts: readonly PromptPartAnswer[],
  consumer: PromptConsumer,
  templates: PromptTemplates,
): string {
  return [...parts.map(partText), framing(templates, consumer)].join(
    PART_SEPARATOR,
  );
}

import assert from "node:assert/strict";
import {
  type AgentName,
  PromptLayer,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptReference,
  PromptTemplate,
  type PromptTemplates,
} from "./contract.ts";
import { digest } from "./prompt-composer.ts";
import { renderTemplate } from "./prompt-templates.ts";
import { composeSystemPrompt, type PromptText } from "./prompt-chain.ts";

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

export function framingTemplate(consumer: PromptConsumer): PromptTemplate {
  assert.ok(Object.hasOwn(FRAMING_TEMPLATES, consumer));
  return FRAMING_TEMPLATES[consumer];
}

export function isFramingTemplate(name: string): name is PromptTemplate {
  return Object.values<string>(FRAMING_TEMPLATES).includes(name);
}

export function framing(
  templates: PromptTemplates,
  consumer: PromptConsumer,
): string {
  return renderTemplate(templates, framingTemplate(consumer), {});
}

const NO_CHARACTERS = 0;

const PART_LAYERS: Record<PromptPart, PromptLayer | null> = {
  [PromptPart.Standard]: PromptLayer.KanthorD,
  [PromptPart.Role]: PromptLayer.KanthorD,
  [PromptPart.Workbench]: PromptLayer.KanthorD,
  [PromptPart.InstructionFile]: PromptLayer.Repository,
  [PromptPart.Repository]: PromptLayer.Repository,
  [PromptPart.Binding]: PromptLayer.Binding,
  [PromptPart.Framing]: null,
};

export function layerOf(part: PromptPart): PromptLayer | null {
  assert.ok(Object.hasOwn(PART_LAYERS, part));
  return PART_LAYERS[part];
}

export function headingOf(
  reference: Pick<PromptReference, "part" | "name" | "path">,
): string | null {
  switch (reference.part) {
    case PromptPart.InstructionFile:
      assert.ok(reference.path);
      return `Repository prompt of repository ${reference.name}, file ${reference.path}:`;
    case PromptPart.Repository:
      return `Repository prompt of repository ${reference.name}, set in KanthorD:`;
    case PromptPart.Binding:
      return `Binding prompt of repository ${reference.name}:`;
    default:
      return null;
  }
}

export function promptPart(
  reference: PromptReference,
  state: PromptPartState,
  text: string | null,
): PromptPartAnswer {
  assert.equal(state === PromptPartState.Resolved, text !== null);
  return {
    layer: layerOf(reference.part),
    part: reference.part,
    name: reference.name,
    origin: reference.origin,
    path: reference.path,
    binding_id: reference.binding_id,
    commit: reference.commit,
    digest: reference.digest,
    heading: headingOf(reference),
    state,
    text,
  };
}

interface InstructionFileResolved {
  state: typeof PromptPartState.Resolved;
  path: string;
  commit: string;
  text: string;
}

interface InstructionFileUnresolved {
  state: typeof PromptPartState.Invalid | typeof PromptPartState.Unreachable;
  path: string;
  commit: string | null;
}

export type InstructionFilePart =
  InstructionFileResolved | InstructionFileUnresolved;

interface RepositoryPromptsContent {
  repository?: string;
  agents?: Partial<Record<AgentName, string>>;
}

export interface RepositoryPrompts {
  binding_id: string;
  name: string;
  prompts: RepositoryPromptsContent;
}

function databasePart(
  part: typeof PromptPart.Repository | typeof PromptPart.Binding,
  name: string,
  bindingId: string,
  text: string | undefined,
): PromptPartAnswer[] {
  return text === undefined || text.trim().length === NO_CHARACTERS
    ? []
    : [
        promptPart(
          {
            part,
            name,
            origin: PromptOrigin.Database,
            path: null,
            binding_id: bindingId,
            commit: null,
            digest: digest(text),
          },
          PromptPartState.Resolved,
          text,
        ),
      ];
}

function filePart(
  name: string,
  bindingId: string,
  file: InstructionFilePart,
): PromptPartAnswer {
  const reference = {
    part: PromptPart.InstructionFile,
    name,
    origin: PromptOrigin.Repository,
    path: file.path,
    binding_id: bindingId,
    commit: file.commit,
  };
  if (file.state === PromptPartState.Resolved)
    return promptPart(
      { ...reference, digest: digest(file.text) },
      PromptPartState.Resolved,
      file.text,
    );
  return {
    layer: layerOf(reference.part),
    ...reference,
    digest: null,
    heading: headingOf(reference),
    state: file.state,
    text: null,
  };
}

export function bindingParts(
  repositories: readonly RepositoryPrompts[],
  agentName: string,
  files: ReadonlyMap<string, InstructionFilePart> = new Map(),
): PromptPartAnswer[] {
  return repositories.flatMap(({ binding_id, name, prompts }) => {
    const agents = prompts.agents ?? {};
    const file = files.get(binding_id);
    return [
      ...(file === undefined ? [] : [filePart(name, binding_id, file)]),
      ...databasePart(
        PromptPart.Repository,
        name,
        binding_id,
        prompts.repository,
      ),
      ...databasePart(
        PromptPart.Binding,
        name,
        binding_id,
        Object.hasOwn(agents, agentName)
          ? agents[agentName as AgentName]
          : undefined,
      ),
    ];
  });
}

function toPromptText(part: PromptPartAnswer): PromptText {
  assert.ok(part.state === PromptPartState.Resolved && part.text !== null);
  return { heading: part.heading, text: part.text };
}

export function finalPrompt(parts: readonly PromptPartAnswer[]): string | null {
  assert.equal(parts.at(-1)?.part, PromptPart.Framing);
  if (!parts.every(({ state }) => state === PromptPartState.Resolved))
    return null;
  return composeSystemPrompt(parts.map(toPromptText), []);
}

export function framingPartFromTemplates(
  templates: PromptTemplates,
  consumer: PromptConsumer,
): PromptPartAnswer {
  const name = framingTemplate(consumer);
  const text = framing(templates, consumer);
  return promptPart(
    {
      part: PromptPart.Framing,
      name,
      origin: PromptOrigin.Binary,
      path: null,
      binding_id: null,
      commit: null,
      digest: digest(text),
    },
    PromptPartState.Resolved,
    text,
  );
}

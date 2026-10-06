import assert from "node:assert/strict";
import type { Context } from "../kernel/context.ts";
import type { AgentDeclaration } from "../agent/catalog.ts";
import { WORKBENCH_PROMPT } from "../agent/prompt-assets.ts";
import {
  digest,
  globalLayer,
  layerText,
  PromptLayer,
  type CompositionRecord,
  type GlobalPromptSource,
  type LayerText,
} from "../agent/prompt-composer.ts";

const FRAMING =
  "This prompt holds prompt layers. Each layer names its owner and its source. The precedence from the highest to the lowest is: agent prompt, base prompt, workbench prompt, global prompt. A layer of higher precedence governs a layer of lower precedence. No layer revokes an obligation of the agent prompt or of the base prompt. A layer authorizes no operation.";
const OWNER = "Workbench Service";

export interface WorkbenchPrompt {
  systemPrompt: string;
  global: LayerText | null;
  record: CompositionRecord;
}

export async function composeWorkbenchPrompt(
  input: {
    agent: AgentDeclaration;
    globalPrompt: GlobalPromptSource;
    hostHome: string;
  },
  context: Context,
): Promise<WorkbenchPrompt> {
  assert.ok(input.agent.agentPrompt);
  assert.ok(input.hostHome);
  const record: CompositionRecord = { selected: [], rejected: [] };
  const global = await globalLayer(input, record, context);
  const declaration = `declaration of ${input.agent.agentName}`;
  const declared = [
    ...(input.agent.basePrompt === undefined
      ? []
      : [
          layerText(
            PromptLayer.Base,
            OWNER,
            declaration,
            input.agent.basePrompt,
          ),
        ]),
    layerText(PromptLayer.Agent, OWNER, declaration, input.agent.agentPrompt),
    layerText(
      PromptLayer.Workbench,
      OWNER,
      "workbench prompt",
      WORKBENCH_PROMPT,
    ),
  ];
  for (const layer of declared)
    record.selected.push({
      layer: layer.layer,
      owner: layer.owner,
      source: layer.source,
      path: null,
      digest: digest(layer.text),
    });
  const lines = record.selected.map(
    (layer) =>
      `- ${layer.layer}: owner ${layer.owner}; source ${layer.source}.`,
  );
  return {
    systemPrompt: [
      FRAMING,
      ...lines,
      ...declared.map((layer) => layer.marked),
    ].join("\n"),
    global,
    record,
  };
}

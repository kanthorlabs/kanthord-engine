import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Context } from "../kernel/context.ts";
import { homeRelative } from "../kernel/xdg.ts";
import type { AgentDeclaration } from "./catalog.ts";
import { WorkerMethod } from "../worker/contract.ts";
import {
  configuredSource,
  readAgentFile,
  SourceState,
  validateText,
  type InvalidReason,
  type SourceRead,
} from "./prompt-source.ts";

export const PromptLayer = {
  Global: "global prompt",
  Base: "base prompt",
  Agent: "agent prompt",
  Project: "project prompt",
  Work: "work prompt",
  Workbench: "workbench prompt",
} as const;
export type PromptLayer = (typeof PromptLayer)[keyof typeof PromptLayer];
export const PRECEDENCE = [
  PromptLayer.Agent,
  PromptLayer.Base,
  PromptLayer.Work,
  PromptLayer.Project,
  PromptLayer.Global,
] as const;
export type GlobalPromptSource =
  | { state: typeof SourceState.Absent }
  | { state: typeof SourceState.Disabled }
  | { state: typeof SourceState.Present; path: string; text: string }
  | { state: typeof SourceState.Invalid; path: string; reason: InvalidReason };
export interface CompositionInput {
  workerName: string;
  agent: AgentDeclaration;
  method: WorkerMethod;
  globalPrompt: GlobalPromptSource;
  hostHome: string;
  repository: { name: string; projectPrompt: string | null } | null;
  workspace: string;
}
export interface LayerText {
  layer: PromptLayer;
  owner: string;
  source: string;
  text: string;
  marked: string;
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
export interface ComposedPrompt {
  systemPrompt: string;
  layers: { global: LayerText | null; project: LayerText | null };
  record: CompositionRecord;
}
export interface WorkPrompt {
  text: string;
  marked: string;
  digest: string;
}
const FRAMING =
  "This prompt holds prompt layers. Each layer names its owner and its source. The precedence from the highest to the lowest is: agent prompt, base prompt, work prompt, project prompt, global prompt. A layer of higher precedence governs a layer of lower precedence. No layer revokes an obligation of the agent prompt or of the base prompt. A layer authorizes no operation.";

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
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return {
    layer,
    owner,
    source,
    text,
    marked: `<prompt-layer name="${layer}" owner="${escape(owner)}" source="${escape(source)}">\n${text}\n</prompt-layer>`,
  };
}

function select(
  record: CompositionRecord,
  layer: PromptLayer,
  owner: string,
  source: string,
  path: string | null,
  value: GlobalPromptSource | ReturnType<typeof configuredSource>,
): LayerText | null {
  assert.ok(source);
  assert.ok(owner);
  if (value.state === SourceState.Invalid) {
    record.rejected.push({ layer, source, path, reason: value.reason });
    return null;
  }
  if (value.state !== SourceState.Present) return null;
  const reason = validateText(value.text);
  if (reason) {
    record.rejected.push({ layer, source, path, reason });
    return null;
  }
  record.selected.push({
    layer,
    owner,
    source,
    path,
    digest: digest(value.text),
  });
  return layerText(layer, owner, source, value.text);
}

async function fileSource(
  paths: readonly string[],
  workspace: string | null,
  context: Context,
): Promise<SourceRead> {
  assert.ok(paths.length);
  assert.ok(context);
  for (const path of paths) {
    const result = await readAgentFile(path, { workspace, context });
    if (result.state !== SourceState.Absent) return result;
  }
  return { state: SourceState.Absent, path: paths.at(-1)! };
}

export async function resolveGlobalPrompt(
  value: string,
  dataDirectory: string,
  context: Context,
): Promise<GlobalPromptSource> {
  assert.ok(dataDirectory);
  assert.ok(context);
  const configured = configuredSource(value);
  const source =
    configured.state === SourceState.Present
      ? await readAgentFile(resolve(dataDirectory, configured.text), {
          workspace: null,
          context,
        })
      : configured;
  return source.state === SourceState.Absent
    ? { state: SourceState.Absent }
    : source;
}

export async function globalLayer(
  input: Pick<CompositionInput, "globalPrompt" | "hostHome">,
  record: CompositionRecord,
  context: Context,
): Promise<LayerText | null> {
  assert.ok(input.hostHome);
  assert.ok(record.selected);
  const configured = input.globalPrompt;
  if (configured.state !== SourceState.Absent)
    return select(
      record,
      PromptLayer.Global,
      "operator of the server",
      `configuration of the server: ${"path" in configured ? homeRelative(configured.path, input.hostHome) : "worker.globalPrompt"}`,
      "path" in configured ? configured.path : null,
      configured,
    );
  const value = await fileSource(
    [
      join(input.hostHome, ".agents/AGENTS.md"),
      join(input.hostHome, ".claude/CLAUDE.md"),
    ],
    null,
    context,
  );
  return select(
    record,
    PromptLayer.Global,
    "operator of the server",
    `agent file of the host: ${homeRelative(value.path, input.hostHome)}`,
    value.path,
    value,
  );
}

async function projectLayer(
  input: CompositionInput,
  record: CompositionRecord,
  context: Context,
): Promise<LayerText | null> {
  assert.ok(input.workspace);
  assert.ok(record.rejected);
  if (!input.repository) return null;
  const owner = `project of repository binding ${input.repository.name}`;
  const configured = configuredSource(input.repository.projectPrompt);
  if (
    configured.state !== SourceState.Absent ||
    input.method === WorkerMethod.Evaluation
  )
    return select(
      record,
      PromptLayer.Project,
      owner,
      `repository binding ${input.repository.name}`,
      null,
      configured,
    );
  const value = await fileSource(
    [join(input.workspace, "AGENTS.md"), join(input.workspace, "CLAUDE.md")],
    input.workspace,
    context,
  );
  return select(
    record,
    PromptLayer.Project,
    owner,
    `agent file of the workspace: ${homeRelative(value.path, input.hostHome)}`,
    value.path,
    value,
  );
}

export async function composePrompt(
  input: CompositionInput,
  context: Context,
): Promise<ComposedPrompt> {
  assert.ok(input.agent.agentPrompt);
  assert.ok(input.workerName);
  const record: CompositionRecord = { selected: [], rejected: [] };
  const global = await globalLayer(input, record, context);
  const owner = `worker ${input.workerName}`;
  const source = `declaration of ${input.agent.agentName}`;
  const declarations = [
    ...(input.agent.basePrompt === undefined
      ? []
      : [layerText(PromptLayer.Base, owner, source, input.agent.basePrompt)]),
    layerText(PromptLayer.Agent, owner, source, input.agent.agentPrompt),
  ];
  for (const layer of declarations)
    record.selected.push({
      layer: layer.layer,
      owner,
      source,
      path: null,
      digest: digest(layer.text),
    });
  const project = await projectLayer(input, record, context);
  const lines = record.selected.map(
    (layer) =>
      `- ${layer.layer}: owner ${layer.owner}; source ${layer.source}.`,
  );
  return {
    systemPrompt: [
      FRAMING,
      ...lines,
      ...declarations.map((layer) => layer.marked),
    ].join("\n"),
    layers: { global, project },
    record,
  };
}

export function renderWorkPrompt(unit: {
  nodeId: string;
  revision: number;
  content: {
    name: string;
    requirement: string;
    criterion: string;
    verifications: string[];
  };
}): WorkPrompt {
  assert.ok(unit.nodeId);
  assert.ok(Number.isSafeInteger(unit.revision));
  const { name, requirement, criterion, verifications } = unit.content;
  const text = `# ${name}\n\n## Requirement\n\n${requirement}\n\n## Criterion\n\n${criterion}\n\n## Verifications\n\n${verifications.map((command, index) => `${index + 1}. ${command}`).join("\n")}`;
  return {
    text,
    marked: layerText(
      PromptLayer.Work,
      `node revision ${unit.revision} of ${unit.nodeId}`,
      `pinned node revision ${unit.revision}`,
      text,
    ).marked,
    digest: digest(text),
  };
}

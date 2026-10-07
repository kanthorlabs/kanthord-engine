import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import type { Context } from "../kernel/context.ts";
import { homeRelative } from "../kernel/xdg.ts";
import type { AgentDeclaration } from "./catalog.ts";
import {
  AgentPromptSource,
  PromptLayerKind,
  PromptOrigin,
  PromptSourceState,
  SYSTEM_LAYER_SWITCH,
  SystemLayerOverride,
  SystemPromptSource,
  WorkbenchPromptSource,
  type PromptSettings,
} from "./contract.ts";
import type { WorkingLayer } from "../project/contract.ts";
import { BASE_PROMPT, WORKBENCH_PROMPT } from "./prompt-assets.ts";
import { digest, PromptLayer } from "./prompt-composer.ts";
import {
  readAgentFile,
  SourceState,
  validateText,
  type InvalidReason,
} from "./prompt-source.ts";

const HOST_DISCOVERY = [".agents/AGENTS.md", ".claude/CLAUDE.md"] as const;
const SYSTEM_OWNER = "operator of the server";
const WORKING_OWNER = "Workbench Service";
const SHIPPED_BASE_NAME = "base.md";
const SHIPPED_WORKBENCH_NAME = "workbench.md";
const MARKDOWN_EXTENSION = ".md";
const PROJECT_PROMPT_SOURCE = "project_prompt";
const WORKING_FILES = [
  [WorkbenchPromptSource.AgentsMd, "AGENTS.md"],
  [WorkbenchPromptSource.AgentsLocalMd, "AGENTS.local.md"],
  [WorkbenchPromptSource.ClaudeMd, "CLAUDE.md"],
  [WorkbenchPromptSource.ClaudeLocalMd, "CLAUDE.local.md"],
] as const;

type Loaded =
  | { state: typeof SourceState.Present; path: string | null; text: string }
  | { state: typeof SourceState.Absent; path: string | null }
  | {
      state: typeof SourceState.Invalid;
      path: string | null;
      reason: InvalidReason;
    };

export interface ResolvedSource {
  source: string;
  origin: PromptOrigin;
  path: string | null;
  enabled: boolean;
  state: PromptSourceState;
  reason: InvalidReason | null;
  digest: string | null;
  text: string | null;
  owner: string;
  label: string;
}

export interface ResolvedLayer {
  layer: PromptLayerKind;
  name: PromptLayer;
  enabled: boolean;
  sources: ResolvedSource[];
}

export interface PromptSettingsSet {
  system: PromptSettings;
  agent: PromptSettings;
  working: PromptSettings;
}

export interface RepositoryWorking {
  name: string;
  projectPrompt: string | null;
  workingLayer: WorkingLayer;
}

export interface LayerInput {
  agent: AgentDeclaration;
  settings: PromptSettingsSet;
  systemFile: string;
  agentDirectory: string;
  dataDirectory: string;
  hostHome: string;
  workingDirectory: string;
  repository?: RepositoryWorking | null;
  context: Context;
}

export interface RepositoryLayerInput {
  repository: RepositoryWorking;
  workspace: string | null;
  hostHome: string;
  context: Context;
}

interface SourceSpec {
  source: string;
  origin: PromptOrigin;
  path: string | null;
  deferred?: boolean;
  owner: string;
  label: (path: string | null) => string;
  load: () => Promise<Loaded>;
}

function textSource(text: string): () => Promise<Loaded> {
  return async () => {
    if (!text) return { state: SourceState.Absent, path: null };
    const reason = validateText(text);
    return reason
      ? { state: SourceState.Invalid, path: null, reason }
      : { state: SourceState.Present, path: null, text };
  };
}

function fileSource(
  paths: readonly string[],
  workspace: string | null,
  context: Context,
): () => Promise<Loaded> {
  assert.ok(paths.length);
  return async () => {
    for (const path of paths) {
      const result = await readAgentFile(path, { workspace, context });
      if (result.state !== SourceState.Absent) return result;
    }
    return { state: SourceState.Absent, path: paths.at(-1)! };
  };
}

function resolveSource(
  spec: SourceSpec,
  switches: Record<string, boolean>,
  hostHome: string,
): Promise<ResolvedSource> {
  const enabled = switches[spec.source] === true;
  const base = {
    source: spec.source,
    origin: spec.origin,
    enabled,
    owner: spec.owner,
    reason: null,
    digest: null,
    text: null,
  };
  const home = (path: string | null) =>
    path === null ? null : homeRelative(path, hostHome);
  const known = spec.path === null ? null : home(spec.path);
  if (!enabled)
    return Promise.resolve({
      ...base,
      path: known,
      state: PromptSourceState.Off,
      label: spec.label(known),
    });
  if (spec.deferred)
    return Promise.resolve({
      ...base,
      path: known,
      state: PromptSourceState.Deferred,
      label: spec.label(known),
    });
  return spec.load().then((loaded) => {
    const path = spec.origin === PromptOrigin.File ? home(loaded.path) : null;
    const label = spec.label(path);
    if (loaded.state === SourceState.Invalid)
      return {
        ...base,
        path,
        label,
        state: PromptSourceState.Invalid,
        reason: loaded.reason,
      };
    if (loaded.state === SourceState.Absent)
      return { ...base, path, label, state: PromptSourceState.Absent };
    return {
      ...base,
      path,
      label,
      state: PromptSourceState.Present,
      digest: digest(loaded.text),
      text: loaded.text,
    };
  });
}

const fileLabel = (path: string | null) => `file ${path ?? "unset"}`;

function systemSpecs(input: LayerInput): SourceSpec[] {
  const configured = input.systemFile
    ? resolve(input.dataDirectory, input.systemFile)
    : null;
  const discovery = configured
    ? [configured]
    : HOST_DISCOVERY.map((path) => join(input.hostHome, path));
  return [
    {
      source: SystemPromptSource.HostFile,
      origin: PromptOrigin.File,
      path: configured,
      owner: SYSTEM_OWNER,
      label: fileLabel,
      load: fileSource(discovery, null, input.context),
    },
    {
      source: SystemPromptSource.Base,
      origin: PromptOrigin.Binary,
      path: null,
      owner: SYSTEM_OWNER,
      label: () => `binary ${SHIPPED_BASE_NAME}`,
      load: textSource(BASE_PROMPT),
    },
    {
      source: SystemPromptSource.Custom,
      origin: PromptOrigin.Database,
      path: null,
      owner: SYSTEM_OWNER,
      label: () => "database custom system prompt",
      load: textSource(input.settings.system.custom_text),
    },
  ];
}

function agentSpecs(input: LayerInput): SourceSpec[] {
  const owner = `agent ${input.agent.agent_name}`;
  const path = input.agentDirectory
    ? join(
        resolve(input.dataDirectory, input.agentDirectory),
        `${input.agent.agent_name}${MARKDOWN_EXTENSION}`,
      )
    : null;
  return [
    {
      source: AgentPromptSource.AgentFile,
      origin: PromptOrigin.File,
      path,
      owner,
      label: fileLabel,
      load:
        path === null
          ? async () => ({ state: SourceState.Absent, path: null })
          : fileSource([path], null, input.context),
    },
    {
      source: AgentPromptSource.Shipped,
      origin: PromptOrigin.Binary,
      path: null,
      owner,
      label: () => `binary ${input.agent.agent_name}${MARKDOWN_EXTENSION}`,
      load: textSource(input.agent.agent_prompt),
    },
    {
      source: AgentPromptSource.Custom,
      origin: PromptOrigin.Database,
      path: null,
      owner,
      label: () => "database custom agent prompt",
      load: textSource(input.settings.agent.custom_text),
    },
  ];
}

function workingSpecs(input: LayerInput): SourceSpec[] {
  return [
    ...WORKING_FILES.map(([source, name]): SourceSpec => ({
      source,
      origin: PromptOrigin.File,
      path: join(input.workingDirectory, name),
      owner: WORKING_OWNER,
      label: fileLabel,
      load: fileSource(
        [join(input.workingDirectory, name)],
        input.workingDirectory,
        input.context,
      ),
    })),
    {
      source: WorkbenchPromptSource.Shipped,
      origin: PromptOrigin.Binary,
      path: null,
      owner: WORKING_OWNER,
      label: () => `binary ${SHIPPED_WORKBENCH_NAME}`,
      load: textSource(WORKBENCH_PROMPT),
    },
    {
      source: WorkbenchPromptSource.Custom,
      origin: PromptOrigin.Database,
      path: null,
      owner: WORKING_OWNER,
      label: () => "database custom workbench prompt",
      load: textSource(input.settings.working.custom_text),
    },
  ];
}

function repositorySpecs(input: RepositoryLayerInput): SourceSpec[] {
  const { name, projectPrompt } = input.repository;
  const owner = `repository binding ${name}`;
  const workspace = input.workspace;
  return [
    ...WORKING_FILES.map(([source, file]): SourceSpec => {
      const path = workspace === null ? file : join(workspace, file);
      return {
        source,
        origin: PromptOrigin.File,
        path,
        deferred: workspace === null,
        owner,
        label: fileLabel,
        load: fileSource([path], workspace, input.context),
      };
    }),
    {
      source: PROJECT_PROMPT_SOURCE,
      origin: PromptOrigin.Database,
      path: null,
      owner,
      label: () => "database project prompt",
      load: textSource(projectPrompt ?? ""),
    },
  ];
}

async function resolveLayer(
  layer: PromptLayerKind,
  name: PromptLayer,
  specs: SourceSpec[],
  switches: Record<string, boolean>,
  hostHome: string,
  enabled = true,
): Promise<ResolvedLayer> {
  assert.ok(specs.length);
  const sources: ResolvedSource[] = [];
  for (const spec of specs)
    sources.push(await resolveSource(spec, enabled ? switches : {}, hostHome));
  return { layer, name, enabled, sources };
}

export function systemLayerEnabled(settings: PromptSettingsSet): boolean {
  const override = settings.agent.system_layer;
  if (override === SystemLayerOverride.On) return true;
  if (override === SystemLayerOverride.Off) return false;
  return settings.system.switches[SYSTEM_LAYER_SWITCH] === true;
}

export function resolveRepositoryLayer(
  input: RepositoryLayerInput,
): Promise<ResolvedLayer> {
  assert.ok(input.hostHome);
  return resolveLayer(
    PromptLayerKind.Working,
    PromptLayer.WorkingLayer,
    repositorySpecs(input),
    input.repository.workingLayer,
    input.hostHome,
  );
}

export async function resolveLayers(
  input: LayerInput,
): Promise<ResolvedLayer[]> {
  assert.ok(input.hostHome);
  assert.ok(input.workingDirectory);
  return [
    await resolveLayer(
      PromptLayerKind.System,
      PromptLayer.SystemLayer,
      systemSpecs(input),
      input.settings.system.switches,
      input.hostHome,
      systemLayerEnabled(input.settings),
    ),
    await resolveLayer(
      PromptLayerKind.Agent,
      PromptLayer.AgentLayer,
      agentSpecs(input),
      input.settings.agent.switches,
      input.hostHome,
    ),
    input.repository
      ? await resolveRepositoryLayer({
          repository: input.repository,
          workspace: null,
          hostHome: input.hostHome,
          context: input.context,
        })
      : await resolveLayer(
          PromptLayerKind.Working,
          PromptLayer.WorkingLayer,
          workingSpecs(input),
          input.settings.working.switches,
          input.hostHome,
        ),
  ];
}

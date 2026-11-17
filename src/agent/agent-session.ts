import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  InlineExtension,
  ModelRuntime,
  ResourceLoader,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  CancellationContext,
  cancelled,
  type Context,
} from "../kernel/context.ts";
import { loadPi, piAgentDirectory, type PiCodingAgent } from "./pi.ts";
import { homeRelativeCwd } from "./hooks/home-relative-cwd.ts";
import {
  type KnownSecrets,
  sensitiveTextRedaction,
  type SensitiveTextRedaction,
} from "./hooks/sensitive-text-redaction.ts";

export const RUNTIME_SETUP_DEADLINE_MS = 30000;

export async function withDeadline<T>(
  promise: Promise<T>,
  parent: Context,
  disposeLate?: (value: T) => void,
): Promise<T> {
  assert.ok(promise);
  assert.ok(parent);
  const context = new CancellationContext(
    parent,
    Date.now() + RUNTIME_SETUP_DEADLINE_MS,
  );
  let abandoned = false;
  const pending = promise.then((value) => {
    if (abandoned || context.signal.aborted) {
      disposeLate?.(value);
      throw context.signal.reason;
    }
    return value;
  });
  try {
    return await Promise.race([
      pending,
      cancelled(context.signal).then(() => {
        throw context.signal.reason;
      }),
    ]);
  } finally {
    abandoned = true;
    context.cancel();
  }
}

export interface OpenSessionInput {
  cwd: string;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  allowlist: string[];
  customTools: ToolDefinition[];
  hostHome: string;
  hooks: InlineExtension[];
  context: Context;
  sessionManager?: SessionManager;
}

export type SessionRedactionInput =
  { knownSecrets: KnownSecrets } | { redaction: SensitiveTextRedaction };

interface SessionParts {
  pi: PiCodingAgent;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  redaction: SensitiveTextRedaction;
  systemPrompt: string;
  resourceLoader: ResourceLoader;
}

async function sessionParts(
  input: OpenSessionInput & SessionRedactionInput,
): Promise<SessionParts> {
  assert.ok(input.cwd);
  assert.ok(input.hostHome);
  assert.ok(input.systemPrompt);
  input.context.signal.throwIfAborted();
  const pi = await withDeadline(loadPi(), input.context);
  const settingsManager = pi.SettingsManager.inMemory({
    enableInstallTelemetry: false,
    enableAnalytics: false,
  });
  const sessionManager =
    input.sessionManager ?? pi.SessionManager.inMemory(input.cwd);
  const redaction =
    "redaction" in input
      ? input.redaction
      : sensitiveTextRedaction(
          input.knownSecrets,
          sessionManager.getSessionId(),
        );
  const systemPrompt = await withDeadline(
    redaction.text(input.systemPrompt),
    input.context,
  );
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: piAgentDirectory(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    extensionFactories: [
      homeRelativeCwd(input.hostHome),
      redaction.restore,
      ...input.hooks,
      redaction.hook,
    ],
  });
  await withDeadline(resourceLoader.reload(), input.context);
  return {
    pi,
    settingsManager,
    sessionManager,
    redaction,
    systemPrompt,
    resourceLoader,
  };
}

export async function openSession(
  input: OpenSessionInput & SessionRedactionInput,
): Promise<{
  session: AgentSession;
  redaction: SensitiveTextRedaction;
  systemPrompt: string;
}> {
  const parts = await sessionParts(input);
  const { session } = await withDeadline(
    parts.pi.createAgentSession({
      cwd: input.cwd,
      agentDir: piAgentDirectory(),
      modelRuntime: input.modelRuntime,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      tools: input.allowlist,
      customTools: input.customTools,
      resourceLoader: parts.resourceLoader,
      sessionManager: parts.sessionManager,
      settingsManager: parts.settingsManager,
    }),
    input.context,
    ({ session }) => session.dispose(),
  );
  return {
    session,
    redaction: parts.redaction,
    systemPrompt: parts.systemPrompt,
  };
}

export interface OpenedRuntime {
  runtime: AgentSessionRuntime;
  redaction: SensitiveTextRedaction;
  systemPrompt: string;
}

function runtimeFactory(
  input: OpenSessionInput,
  parts: SessionParts,
): CreateAgentSessionRuntimeFactory {
  return async (options) => {
    const services = {
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime: input.modelRuntime,
      settingsManager: parts.settingsManager,
      resourceLoader: parts.resourceLoader,
      diagnostics: [],
    };
    const created = await parts.pi.createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      tools: input.allowlist,
      customTools: input.customTools,
    });
    return { ...created, services, diagnostics: [] };
  };
}

export async function closeRuntime(
  runtime: AgentSessionRuntime,
  cleanup: CancellationContext,
): Promise<void> {
  const ended = runtime.session
    .abort()
    .then(() => runtime.dispose())
    .then(
      () => true,
      () => false,
    );
  try {
    const disposed = await Promise.race([
      ended,
      cancelled(cleanup.signal).then(() => false),
    ]);
    if (!disposed) runtime.session.dispose();
  } finally {
    cleanup.cancel();
  }
}

function setupCleanup(parent: Context): CancellationContext {
  return new CancellationContext(
    parent,
    Date.now() + RUNTIME_SETUP_DEADLINE_MS,
  );
}

export async function openSessionRuntime(
  input: OpenSessionInput & SessionRedactionInput,
): Promise<OpenedRuntime> {
  const parts = await sessionParts(input);
  const runtime = await withDeadline(
    parts.pi.createAgentSessionRuntime(runtimeFactory(input, parts), {
      cwd: input.cwd,
      agentDir: piAgentDirectory(),
      sessionManager: parts.sessionManager,
    }),
    input.context,
    (late) => void closeRuntime(late, setupCleanup(input.context)),
  );
  try {
    await withDeadline(runtime.session.bindExtensions({}), input.context);
  } catch (error) {
    await closeRuntime(runtime, setupCleanup(input.context));
    throw error;
  }
  return {
    runtime,
    redaction: parts.redaction,
    systemPrompt: parts.systemPrompt,
  };
}

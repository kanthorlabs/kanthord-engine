import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  InlineExtension,
  ModelRuntime,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { loadPi, piAgentDirectory } from "./pi.ts";

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
    if (abandoned || context.err()) {
      disposeLate?.(value);
      throw context.err();
    }
    return value;
  });
  try {
    return await Promise.race([
      pending,
      context.done().then(() => {
        throw context.err();
      }),
    ]);
  } finally {
    abandoned = true;
    context.cancel();
  }
}

export async function openSession(input: {
  cwd: string;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  allowlist: string[];
  customTools: ToolDefinition[];
  extensions: InlineExtension[];
  context: Context;
  sessionManager?: SessionManager;
}): Promise<AgentSession> {
  assert.ok(input.cwd);
  assert.ok(input.systemPrompt);
  throwIfCancelled(input.context);
  const pi = await withDeadline(loadPi(), input.context);
  const settingsManager = pi.SettingsManager.inMemory({
    enableInstallTelemetry: false,
    enableAnalytics: false,
  });
  const sessionManager =
    input.sessionManager ?? pi.SessionManager.inMemory(input.cwd);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: piAgentDirectory(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: input.systemPrompt,
    extensionFactories: input.extensions,
  });
  await withDeadline(resourceLoader.reload(), input.context);
  const { session } = await withDeadline(
    pi.createAgentSession({
      cwd: input.cwd,
      agentDir: piAgentDirectory(),
      modelRuntime: input.modelRuntime,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      tools: input.allowlist,
      customTools: input.customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    }),
    input.context,
    ({ session }) => session.dispose(),
  );
  return session;
}

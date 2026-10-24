import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { CancellationContext, type Context } from "../kernel/context.ts";
import type { Environment, EnvironmentSource } from "../kernel/devcontainer.ts";
import { FacilityError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import { openSession, withDeadline } from "../agent/agent-session.ts";
import { checkoutConfinement } from "../agent/hooks/checkout-confinement.ts";
import { loadPi } from "../agent/pi.ts";
import type { PromptTemplates, AgentView } from "../agent/contract.ts";
import type { ResolvedLayer } from "../agent/prompt-layers.ts";
import {
  bindingPrompts,
  PromptConsumer,
  systemPrompt,
} from "../agent/prompt-render.ts";
import {
  connectModel,
  type ModelConnectorInput,
} from "../llm/model-connector.ts";
import type { ReasoningLevel } from "../llm/platforms.ts";
import type {
  CredentialMetadataFn,
  ServerAgentCredentialsInput,
} from "../custody/contract.ts";
import type { EnvironmentTarget, RepositoryPolicy } from "./contract.ts";
import { ENVIRONMENT_DIRECTORY, type ProofFile } from "./environment-state.ts";

export const ENV_AGENT_NAME = "env@1";

export const EnvironmentSessionEnd = {
  NotEnabled: "not_enabled",
  Ended: "ended",
  Aborted: "aborted",
} as const;
export type EnvironmentSessionEnd =
  (typeof EnvironmentSessionEnd)[keyof typeof EnvironmentSessionEnd];
export const environmentSessionEndSchema = z.enum(EnvironmentSessionEnd);

export type EnvironmentModelRuntimeFactory = (
  input: ModelConnectorInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

const defaultModelRuntimeFactory: EnvironmentModelRuntimeFactory = async (
  input,
) => connectModel(await loadPi(), input);

export interface EnvironmentAgentDependencies {
  store: Store;
  stateDirectory: string;
  hostHome: string;
  identity: ServiceIdentity;
  agentView(tx: Transaction, agentName: string): AgentView | null;
  serverAgentCredentials(input: ServerAgentCredentialsInput): CredentialStore;
  composePrompt(agentName: string, context: Context): Promise<ResolvedLayer[]>;
  repositoryPromptsOf(
    tx: Transaction,
    bindingId: string,
  ): Pick<RepositoryPolicy, "name" | "prompts"> | null;
  templates(context: Context): Promise<PromptTemplates>;
  exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void>;
  credentialMetadata?: CredentialMetadataFn;
  modelRuntimeFactory?: EnvironmentModelRuntimeFactory;
}

export interface EnvironmentSessionHandle {
  session_id: string;
  checkout: string;
  end(): void;
}

export interface EnvironmentSessionInput {
  project_id: string;
  binding_id: string;
  binding_name: string;
  resource_identity: string;
  commit: string;
  target: EnvironmentTarget;
  source: EnvironmentSource;
  document: Environment | null;
  failure: ProofFile;
  context: Context;
  tools(handle: EnvironmentSessionHandle): ToolDefinition[];
}

const SESSION_PREFIX = "env_session";
const RUN_DIRECTORY_PREFIX = "run-";
const CHECKOUT_DIRECTORY = "checkout";
const PRIVATE_DIRECTORY_MODE = 0o700;
const END_TURN = { action: "end" } as const;

type UsableView = AgentView & {
  effective: NonNullable<AgentView["effective"]>;
};

function usable(view: AgentView | null): view is UsableView {
  return view !== null && view.valid && view.effective !== null;
}

export class EnvironmentAgent {
  private readonly dependencies: EnvironmentAgentDependencies;

  constructor(dependencies: EnvironmentAgentDependencies) {
    this.dependencies = dependencies;
  }

  enabled(): boolean {
    return usable(this.view());
  }

  async run(input: EnvironmentSessionInput): Promise<EnvironmentSessionEnd> {
    const view = this.view();
    if (!usable(view)) return EnvironmentSessionEnd.NotEnabled;
    const sessionId = createIdentity(SESSION_PREFIX);
    const directory = join(
      this.dependencies.stateDirectory,
      ENVIRONMENT_DIRECTORY,
      `${RUN_DIRECTORY_PREFIX}${sessionId}`,
    );
    const checkout = join(directory, CHECKOUT_DIRECTORY);
    mkdirSync(checkout, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const lifetime = new CancellationContext(input.context);
    let session: AgentSession | null = null;
    try {
      await this.dependencies.exportRepository(
        input.binding_id,
        input.commit,
        checkout,
        input.context,
      );
      session = await this.open(input, view, sessionId, checkout, lifetime);
      await this.drive(session, input);
    } catch (error) {
      if (!input.context.signal.aborted) throw error;
    } finally {
      session?.dispose();
      lifetime.cancel();
      rmSync(directory, { recursive: true, force: true });
    }
    return input.context.signal.aborted
      ? EnvironmentSessionEnd.Aborted
      : EnvironmentSessionEnd.Ended;
  }

  private view(): AgentView | null {
    return this.dependencies.store.transaction((tx) =>
      this.dependencies.agentView(tx, ENV_AGENT_NAME),
    );
  }

  private async open(
    input: EnvironmentSessionInput,
    view: UsableView,
    sessionId: string,
    checkout: string,
    lifetime: CancellationContext,
  ): Promise<AgentSession> {
    const { effective } = view;
    const declaration = getAgentDeclaration(ENV_AGENT_NAME);
    assert.ok(declaration);
    const credentials = this.dependencies.serverAgentCredentials({
      session_id: sessionId,
      platform: effective.provider,
      requester: () => this.dependencies.identity,
      authorize: (tx) => {
        const current = this.dependencies.agentView(tx, ENV_AGENT_NAME);
        if (!usable(current)) throw new FacilityError();
        return {
          credential: current.effective.credential,
          platform: current.effective.provider,
        };
      },
    });
    const stored = this.dependencies.credentialMetadata
      ? this.dependencies.store.transaction((tx) =>
          this.dependencies.credentialMetadata!(tx, effective.credential),
        )
      : null;
    const credentialId = stored?.id ?? effective.credential;
    const { runtime, model } = await withDeadline(
      (this.dependencies.modelRuntimeFactory ?? defaultModelRuntimeFactory)({
        credentials,
        handoverItem: {
          credential_id: credentialId,
          provider_id: piProviderId(effective.provider),
        },
        credentialId,
        configuration: {
          agent_provider: effective.agent_provider,
          provider: effective.provider,
          model_identifier: effective.model_identifier,
          reasoning_effort: effective.reasoning_effort as ReasoningLevel,
        },
        metadata: stored?.metadata ?? null,
        signal: lifetime.signal,
      }),
      input.context,
    );
    const layers = await this.dependencies.composePrompt(
      ENV_AGENT_NAME,
      input.context,
    );
    const templates = await this.dependencies.templates(input.context);
    const repository = this.dependencies.store.transaction((tx) =>
      this.dependencies.repositoryPromptsOf(tx, input.binding_id),
    );
    let ended = false;
    const customTools = input.tools({
      session_id: sessionId,
      checkout,
      end: () => {
        ended = true;
      },
    });
    const session = await openSession({
      cwd: checkout,
      modelRuntime: runtime,
      model,
      thinkingLevel: effective.reasoning_effort as ReasoningLevel,
      systemPrompt: systemPrompt(
        layers,
        PromptConsumer.Worker,
        templates,
        bindingPrompts(repository ? [repository] : [], ENV_AGENT_NAME),
      ),
      allowlist: [
        ...declaration.tools,
        ...customTools.map((tool) => tool.name),
      ],
      customTools,
      hostHome: this.dependencies.hostHome,
      hooks: [checkoutConfinement(checkout)],
      context: input.context,
    });
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) =>
      ended ? END_TURN : ((await finishTurn?.(turn, signal)) ?? undefined);
    return session;
  }

  private async drive(
    session: AgentSession,
    input: EnvironmentSessionInput,
  ): Promise<void> {
    using _abort = addAbortListener(input.context.signal, () => {
      void session.abort();
    });
    await session.prompt(firstMessage(input), {
      expandPromptTemplates: false,
    });
    await session.waitForIdle();
    const failure = session.state.errorMessage;
    if (failure !== undefined && !input.context.signal.aborted)
      throw new Error(failure);
  }
}

function firstMessage(input: EnvironmentSessionInput): string {
  const { failure } = input;
  return JSON.stringify({
    binding_name: input.binding_name,
    target: input.target,
    source: input.source,
    document: input.document,
    class: failure.class,
    command: failure.command,
    exit_code: failure.exit_code,
    tail: failure.tail,
    checks: failure.checks,
  });
}

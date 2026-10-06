import assert from "node:assert/strict";
import { homedir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { HumanIdentity } from "../kernel/caller.ts";
import { isHumanIdentity } from "../kernel/caller.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  AgentErrorCode,
  type AgentEntry,
  type AgentView,
} from "../agent/contract.ts";
import { openSession, withDeadline } from "../agent/agent-session.ts";
import { pinnedLayers } from "../agent/pinned-layers.ts";
import { loadPi } from "../agent/pi.ts";
import { resolveGlobalPrompt } from "../agent/prompt-composer.ts";
import {
  connectModel,
  type ModelConnectorInput,
} from "../llm/model-connector.ts";
import type { ReasoningLevel } from "../llm/platforms.ts";
import type {
  CredentialMetadataFn,
  WorkbenchAuthorization,
  WorkbenchCredentialsFn,
} from "../custody/contract.ts";
import {
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_SESSION_PREFIX,
  WorkbenchErrorCode,
  workbenchConfigurationSchema,
  workbenchOperations,
  type SessionEntry,
  type WorkbenchConfiguration,
  type WorkbenchSession,
} from "./contract.ts";
import { composeWorkbenchPrompt } from "./prompt.ts";
import {
  createSession,
  findSession,
  lastModel,
  lastThinkingLevel,
  listSessions,
  sessionPlace,
  storedConfiguration,
  type SessionPlace,
} from "./sessions.ts";

export type WorkbenchModelRuntimeFactory = (
  input: ModelConnectorInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export interface Dependencies {
  store: Store;
  stateDirectory: string;
  dataDirectory: string;
  globalPrompt: string;
  hostHome?: string;
  agentConfiguration: {
    validateEntry(tx: Transaction, agentName: string, entry: AgentEntry): void;
    agentView(
      tx: Transaction,
      agentName: string,
      entry: AgentEntry,
    ): AgentView | null;
  };
  credentialMetadata: CredentialMetadataFn;
  workbenchCredentials: WorkbenchCredentialsFn;
  modelRuntimeFactory?: WorkbenchModelRuntimeFactory;
}

interface Resolved {
  provider: string;
  credentialId: string;
  metadata: unknown;
}

interface OpenSession {
  id: string;
  agentName: string;
  place: SessionPlace;
  manager: SessionManager;
  configuration: WorkbenchConfiguration;
  requester: HumanIdentity | undefined;
  agent: AgentSession | null;
  disposeAgent: () => void;
  queue: Promise<void>;
}

const defaultModelRuntimeFactory: WorkbenchModelRuntimeFactory = async (
  input,
) => connectModel(await loadPi(), input);

function sessionNotFound(sessionId: string): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkbenchErrorCode.SessionNotFound,
    "Workbench session not found.",
    { sessionId },
  );
}

function refused(sessionId: string): OperationError {
  return new OperationError(
    HttpStatus.Forbidden,
    WorkbenchErrorCode.AuthorizationRefused,
    "The workbench session refuses the credential release.",
    { sessionId },
  );
}

function requireAgent(agentName: string): void {
  if (!getAgentDeclaration(agentName))
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "Agent not found.",
      { agentName },
    );
}

function humanOf(caller: CallerContext): HumanIdentity {
  assert.ok(isHumanIdentity(caller.identity));
  return caller.identity;
}

export class WorkbenchService implements Service {
  private readonly dependencies: Dependencies;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly loading = new Map<string, Promise<OpenSession>>();
  private readonly shutdown = new CancellationContext();
  private started = false;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  authorize(
    tx: Transaction,
    requester: HumanIdentity,
    sessionId: string,
  ): WorkbenchAuthorization {
    assert.ok(isHumanIdentity(requester));
    const session = this.sessions.get(sessionId);
    if (!session) throw refused(sessionId);
    const view = this.dependencies.agentConfiguration.agentView(
      tx,
      session.agentName,
      session.configuration,
    );
    if (!view?.valid || !view.effective) throw refused(sessionId);
    return {
      credential: view.effective.credential,
      platform: view.effective.provider,
    };
  }

  private resolve(
    tx: Transaction,
    agentName: string,
    configuration: WorkbenchConfiguration,
  ): Resolved {
    const { agentConfiguration, credentialMetadata } = this.dependencies;
    agentConfiguration.validateEntry(tx, agentName, configuration);
    const view = agentConfiguration.agentView(tx, agentName, configuration);
    assert.ok(view?.valid && view.effective);
    const metadata = credentialMetadata(tx, view.effective.credential);
    assert.ok(metadata);
    return {
      provider: view.effective.provider,
      credentialId: metadata.id,
      metadata: metadata.metadata,
    };
  }

  private exclusive<T>(session: OpenSession, work: () => Promise<T>) {
    const result = session.queue.then(work, work);
    session.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async session(sessionId: string): Promise<OpenSession> {
    const open = this.sessions.get(sessionId);
    if (open) return open;
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = this.load(sessionId);
      this.loading.set(sessionId, pending);
      void pending
        .finally(() => this.loading.delete(sessionId))
        .catch(() => undefined);
    }
    return pending;
  }

  private async load(sessionId: string): Promise<OpenSession> {
    const found = await findSession(
      this.dependencies.stateDirectory,
      sessionId,
    );
    if (!found) throw sessionNotFound(sessionId);
    const parsed = workbenchConfigurationSchema.safeParse(
      storedConfiguration(this.entries(found.manager)),
    );
    if (!parsed.success)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.ConfigurationInvalid,
        "The stored configuration of the workbench session is invalid.",
        { sessionId },
      );
    const session: OpenSession = {
      id: sessionId,
      agentName: found.agentName,
      place: sessionPlace(this.dependencies.stateDirectory, found.agentName),
      manager: found.manager,
      configuration: parsed.data,
      requester: undefined,
      agent: null,
      disposeAgent: () => {},
      queue: Promise.resolve(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private entries(manager: SessionManager): SessionEntry[] {
    return JSON.parse(JSON.stringify(manager.getEntries())) as SessionEntry[];
  }

  private async openAgent(
    session: OpenSession,
    resolved: Resolved,
    context: Context,
  ): Promise<void> {
    assert.equal(session.agent, null);
    const declaration = getAgentDeclaration(session.agentName);
    assert.ok(declaration);
    const controller = new AbortController();
    const unsubscribe = this.shutdown.onCancel((error) =>
      controller.abort(error),
    );
    let agent: AgentSession | undefined;
    try {
      const credentials = this.dependencies.workbenchCredentials({
        sessionId: session.id,
        platform: resolved.provider,
        requester: () => session.requester,
        authorize: (tx, requester, sessionId) =>
          this.authorize(tx, requester, sessionId),
      });
      const { runtime, model } = await withDeadline(
        (this.dependencies.modelRuntimeFactory ?? defaultModelRuntimeFactory)({
          credentials,
          handoverItem: {
            credentialId: resolved.credentialId,
            providerId: resolved.provider,
          },
          credentialId: resolved.credentialId,
          configuration: {
            ...session.configuration,
            provider: resolved.provider,
            reasoningEffort: session.configuration
              .reasoningEffort as ReasoningLevel,
          },
          metadata: resolved.metadata,
          signal: controller.signal,
        }),
        context,
      ).catch((error: unknown) => {
        if (!(error instanceof Diagnostic)) throw error;
        throw new OperationError(
          HttpStatus.Conflict,
          WorkbenchErrorCode.SetupRefused,
          "The agent runtime of the workbench session refuses the configuration.",
          { sessionId: session.id },
        );
      });
      const prompt = await composeWorkbenchPrompt(
        {
          agent: declaration,
          globalPrompt: await resolveGlobalPrompt(
            this.dependencies.globalPrompt,
            this.dependencies.dataDirectory,
            context,
          ),
          hostHome: this.dependencies.hostHome ?? homedir(),
        },
        context,
      );
      const pins = pinnedLayers({ global: prompt.global, project: null });
      agent = await openSession({
        cwd: session.place.cwd,
        modelRuntime: runtime,
        model,
        thinkingLevel: session.configuration.reasoningEffort,
        systemPrompt: prompt.systemPrompt,
        allowlist: [],
        customTools: [],
        extensions: [pins.extension],
        context,
        sessionManager: session.manager,
      });
      pins.pinInference(agent, prompt.systemPrompt);
      const opened = agent;
      session.agent = opened;
      session.disposeAgent = () => {
        opened.dispose();
        unsubscribe();
        controller.abort();
      };
    } catch (error) {
      agent?.dispose();
      unsubscribe();
      controller.abort();
      throw error;
    }
  }

  private closeAgent(session: OpenSession): void {
    session.disposeAgent();
    session.disposeAgent = () => {};
    session.agent = null;
  }

  private syncEntries(session: OpenSession, provider: string): void {
    const { manager, configuration } = session;
    const entries = this.entries(manager);
    if (
      storedConfiguration(entries).agentProvider !== configuration.agentProvider
    )
      manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
        agentProvider: configuration.agentProvider,
      });
    const model = lastModel(entries);
    if (
      model?.provider !== provider ||
      model.modelId !== configuration.modelIdentifier
    )
      manager.appendModelChange(provider, configuration.modelIdentifier);
    if (lastThinkingLevel(entries) !== configuration.reasoningEffort)
      manager.appendThinkingLevelChange(configuration.reasoningEffort);
  }

  private view(session: OpenSession): WorkbenchSession {
    return {
      id: session.id,
      agentName: session.agentName,
      configuration: { ...session.configuration },
      entries: this.entries(session.manager),
      runActive: false,
    };
  }

  async list(agentName: string) {
    requireAgent(agentName);
    return {
      items: await listSessions(
        sessionPlace(this.dependencies.stateDirectory, agentName),
      ),
    };
  }

  async create(
    caller: CallerContext,
    body: WorkbenchConfiguration & { agentName: string },
  ): Promise<WorkbenchSession> {
    const { agentName, ...configuration } = body;
    requireAgent(agentName);
    const resolved = this.dependencies.store.transaction((tx) =>
      this.resolve(tx, agentName, configuration),
    );
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    const place = sessionPlace(this.dependencies.stateDirectory, agentName);
    const session: OpenSession = {
      id,
      agentName,
      place,
      manager: await createSession(place, id),
      configuration,
      requester: humanOf(caller),
      agent: null,
      disposeAgent: () => {},
      queue: Promise.resolve(),
    };
    this.sessions.set(id, session);
    try {
      await this.openAgent(session, resolved, caller.context);
      this.syncEntries(session, resolved.provider);
    } catch (error) {
      this.closeAgent(session);
      this.sessions.delete(id);
      throw error;
    }
    return this.view(session);
  }

  async get(sessionId: string): Promise<WorkbenchSession> {
    return this.view(await this.session(sessionId));
  }

  async configure(
    caller: CallerContext,
    sessionId: string,
    configuration: WorkbenchConfiguration,
  ): Promise<WorkbenchConfiguration> {
    const session = await this.session(sessionId);
    return this.exclusive(session, async () => {
      const resolved = this.dependencies.store.transaction((tx) =>
        this.resolve(tx, session.agentName, configuration),
      );
      const previous = session.configuration;
      session.requester = humanOf(caller);
      this.closeAgent(session);
      session.configuration = configuration;
      try {
        await this.openAgent(session, resolved, caller.context);
      } catch (error) {
        session.configuration = previous;
        throw error;
      }
      this.syncEntries(session, resolved.provider);
      return { ...session.configuration };
    });
  }

  declare(registry: OperationRegistry): void {
    registry.register(workbenchOperations["session.list"], ({ query }) =>
      this.list(query.agentName),
    );
    registry.register(
      workbenchOperations["session.create"],
      ({ body }, caller) => this.create(caller, body),
    );
    registry.register(workbenchOperations["session.get"], ({ params }) =>
      this.get(params.sessionId),
    );
    registry.register(
      workbenchOperations["session.configure"],
      ({ params, body }, caller) =>
        this.configure(caller, params.sessionId, body),
    );
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          WorkbenchErrorCode.Stopped,
          "workbench: a stopped service cannot start again.",
        ),
      );
    this.started = true;
    return Promise.resolve(null);
  }

  quiesce(): Promise<Error | null> {
    return Promise.resolve(null);
  }

  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    for (const session of this.sessions.values()) this.closeAgent(session);
    this.sessions.clear();
    return Promise.resolve(null);
  }

  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      sessions:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

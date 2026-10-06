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
import type {
  CallerContext,
  Operation,
  OperationRegistry,
} from "../kernel/operation.ts";
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
  WORKBENCH_EVENTS_WAIT_MS,
  WORKBENCH_REJECTION_REASON,
  WorkbenchErrorCode,
  workbenchConfigurationSchema,
  workbenchOperations,
  type PendingApproval,
  type RunSnapshot,
  type SessionEntry,
  type SessionEvents,
  type WorkbenchConfiguration,
  type WorkbenchSession,
} from "./contract.ts";
import { composeWorkbenchPrompt } from "./prompt.ts";
import {
  builtinTools,
  operationTool,
  toolOperations,
  type InvokeOperation,
  toolName,
} from "./tools.ts";
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
  operations: () => readonly Operation[];
  invoke: InvokeOperation;
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
  run: Run | null;
  runError: string | null;
  waiters: Set<() => void>;
  version: number;
  approvals: Map<string, Approval>;
}

interface Approval {
  approval: PendingApproval;
  decide: (approved: boolean) => void;
}

interface Run {
  firstEntry: number;
  ended: boolean;
  settled: Promise<void>;
}

const IDLE_SESSION = {
  disposeAgent: () => {},
  run: null,
  runError: null,
} as const;
const NOT_FOUND_INDEX = -1;
const AGENT_END = "agent_end";

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
      ...IDLE_SESSION,
      queue: Promise.resolve(),
      waiters: new Set(),
      version: 0,
      approvals: new Map(),
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
      const builtin = builtinTools(
        await loadPi(),
        session.agentName,
        session.place.cwd,
      );
      const mutations = new Map<string, Operation>();
      const operations = toolOperations(this.dependencies.operations()).map(
        (operation) => {
          if (operation.mutation)
            mutations.set(toolName(operation.id), operation);
          return operationTool(
            operation,
            this.dependencies.invoke,
            () => session.requester,
          );
        },
      );
      agent = await openSession({
        cwd: session.place.cwd,
        modelRuntime: runtime,
        model,
        thinkingLevel: session.configuration.reasoningEffort,
        systemPrompt: prompt.systemPrompt,
        allowlist: [
          ...builtin.allowlist,
          ...operations.map((tool) => tool.name),
        ],
        customTools: [...builtin.customTools, ...operations],
        extensions: [pins.extension],
        context,
        sessionManager: session.manager,
      });
      pins.pinInference(agent, prompt.systemPrompt);
      const beforeToolCall = agent.agent.beforeToolCall;
      agent.agent.beforeToolCall = async (call, signal) => {
        const previous = await beforeToolCall?.(call, signal);
        const operation = mutations.get(call.toolCall.name);
        if (previous?.block || !operation) return previous;
        const approved = await this.approval(
          session,
          {
            toolCallId: call.toolCall.id,
            operationId: operation.id,
            input: JSON.parse(JSON.stringify(call.args ?? {})),
          },
          signal,
        );
        return approved
          ? previous
          : { block: true, reason: WORKBENCH_REJECTION_REASON };
      };
      const opened = agent;
      const unsubscribeEvents = opened.subscribe((event) => {
        if (event.type === AGENT_END && session.run) session.run.ended = true;
        this.notify(session);
      });
      session.agent = opened;
      session.disposeAgent = () => {
        unsubscribeEvents();
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

  private approval(
    session: OpenSession,
    approval: PendingApproval,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const decision = Promise.withResolvers<boolean>();
    const reject = () => decide(false);
    const decide = (approved: boolean) => {
      signal?.removeEventListener("abort", reject);
      session.approvals.delete(approval.toolCallId);
      decision.resolve(approved);
      this.notify(session);
    };
    if (signal?.aborted) return Promise.resolve(false);
    signal?.addEventListener("abort", reject, { once: true });
    session.approvals.set(approval.toolCallId, { approval, decide });
    this.notify(session);
    return decision.promise;
  }

  private rejectApprovals(session: OpenSession): void {
    for (const { decide } of [...session.approvals.values()]) decide(false);
  }

  approve(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ): { sessionId: string; toolCallId: string; approved: boolean } {
    const pending = this.sessions.get(sessionId)?.approvals.get(toolCallId);
    if (!pending)
      throw new OperationError(
        HttpStatus.NotFound,
        WorkbenchErrorCode.ApprovalNotFound,
        "The workbench session holds no pending call with this identity.",
        { sessionId, toolCallId },
      );
    pending.decide(approved);
    return { sessionId, toolCallId, approved };
  }

  private closeAgent(session: OpenSession): void {
    this.rejectApprovals(session);
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
    const entries = this.entries(session.manager);
    return {
      id: session.id,
      agentName: session.agentName,
      configuration: { ...session.configuration },
      entries: this.runActive(session)
        ? entries.slice(0, session.run!.firstEntry)
        : entries,
      runActive: this.runActive(session),
    };
  }

  private runActive(session: OpenSession): boolean {
    return session.run !== null && !session.run.ended;
  }

  private notify(session: OpenSession): void {
    session.version++;
    for (const wake of [...session.waiters]) wake();
  }

  private requireIdle(session: OpenSession): void {
    if (session.run)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.RunActive,
        "The workbench session holds an active run.",
        { sessionId: session.id },
      );
  }

  private snapshot(session: OpenSession): RunSnapshot {
    const state = session.agent?.state;
    const streaming = state?.streamingMessage;
    return {
      streamingMessage:
        streaming === undefined ? null : JSON.parse(JSON.stringify(streaming)),
      pendingToolCalls: state ? [...state.pendingToolCalls] : [],
      pendingApproval:
        session.approvals.values().next().value?.approval ?? null,
      runActive: this.runActive(session),
      errorMessage: session.runError ?? state?.errorMessage ?? null,
    };
  }

  private changes(session: OpenSession, after: string | undefined) {
    const entries = this.entries(session.manager);
    const index =
      after === undefined
        ? NOT_FOUND_INDEX
        : entries.findIndex((entry) => entry.id === after);
    return {
      entries: entries.slice(index + 1),
      snapshot: this.snapshot(session),
      version: session.version,
    };
  }

  async events(
    sessionId: string,
    after: string | undefined,
    version: number | undefined,
    context: Context,
  ): Promise<SessionEvents> {
    const session = await this.session(sessionId);
    const window = new CancellationContext(
      context,
      Date.now() + WORKBENCH_EVENTS_WAIT_MS,
    );
    const wake = () => window.cancel();
    session.waiters.add(wake);
    try {
      const current = this.changes(session, after);
      if (current.entries.length || version !== current.version) return current;
      await window.done();
      await new Promise((resolve) => setImmediate(resolve));
      return this.changes(session, after);
    } finally {
      session.waiters.delete(wake);
      window.cancel();
    }
  }

  async message(
    caller: CallerContext,
    sessionId: string,
    text: string,
  ): Promise<{ sessionId: string; runActive: true }> {
    const session = await this.session(sessionId);
    if (session.run?.ended) await session.run.settled;
    this.requireIdle(session);
    const completion = Promise.withResolvers<void>();
    const run: Run = {
      firstEntry: session.manager.getEntries().length,
      ended: false,
      settled: completion.promise,
    };
    session.run = run;
    session.runError = null;
    this.notify(session);
    const settle = () => {
      if (session.run === run) session.run = null;
      completion.resolve();
      this.notify(session);
    };
    try {
      await this.exclusive(session, async () => {
        session.requester = humanOf(caller);
        const resolved = this.dependencies.store.transaction((tx) =>
          this.resolve(tx, session.agentName, session.configuration),
        );
        if (!session.agent)
          await this.openAgent(session, resolved, caller.context);
        assert.ok(session.agent);
        void session.agent
          .prompt(text, { expandPromptTemplates: false })
          .catch((error: unknown) => {
            session.runError =
              error instanceof Error ? error.message : String(error);
          })
          .finally(settle);
      });
    } catch (error) {
      settle();
      throw error;
    }
    return { sessionId, runActive: true };
  }

  async abort(sessionId: string): Promise<{
    sessionId: string;
    runActive: false;
  }> {
    const session = await this.session(sessionId);
    await this.exclusive(session, async () => {
      const run = session.run;
      this.rejectApprovals(session);
      if (!run) return;
      await session.agent?.abort();
      await run.settled;
    });
    return { sessionId, runActive: false };
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
      ...IDLE_SESSION,
      queue: Promise.resolve(),
      waiters: new Set(),
      version: 0,
      approvals: new Map(),
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
    this.requireIdle(session);
    return this.exclusive(session, async () => {
      this.requireIdle(session);
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
    registry.register(
      workbenchOperations["session.message"],
      ({ params, body }, caller) =>
        this.message(caller, params.sessionId, body.text),
    );
    registry.register(
      workbenchOperations["session.approve"],
      ({ params, body }) =>
        this.approve(params.sessionId, body.toolCallId, body.approved),
    );
    registry.register(workbenchOperations["session.abort"], ({ params }) =>
      this.abort(params.sessionId),
    );
    registry.register(
      workbenchOperations["session.events"],
      ({ params, query }, caller) =>
        this.events(
          params.sessionId,
          query.after,
          query.version,
          caller.context,
        ),
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
    for (const session of this.sessions.values()) {
      void session.agent?.abort();
      this.closeAgent(session);
    }
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

import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type {
  AgentSession,
  ModelRuntime,
  SessionManager,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  joined,
  reasonOf,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { HumanIdentity } from "../kernel/caller.ts";
import { isHumanIdentity } from "../kernel/caller.ts";
import type {
  CallerContext,
  Operation,
  OperationRegistry,
} from "../kernel/operation.ts";
import {
  type Healthcheck,
  HealthStatus,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  getAgentDeclaration,
  workbenchAgentNames,
  WorkbenchTool,
} from "../agent/catalog.ts";
import {
  AgentErrorCode,
  type AgentView,
  PromptTemplate,
} from "../agent/contract.ts";
import { openSession, withDeadline } from "../agent/agent-session.ts";
import {
  credentialSecrets,
  type KnownSecrets,
  REDACTION_LOG_MESSAGE,
  redactionObserved,
  redactionSummary,
  type SensitiveTextRedaction,
} from "../agent/hooks/sensitive-text-redaction.ts";
import { pinnedLayers } from "../agent/pinned-layers.ts";
import {
  toolApproval,
  type ToolDecision,
} from "../agent/hooks/tool-approval.ts";
import { loadPi } from "../agent/pi.ts";
import type { PromptPartAnswer, PromptTemplates } from "../agent/contract.ts";
import { PromptConsumer, systemPrompt } from "../agent/prompt-render.ts";
import { renderTemplate } from "../agent/prompt-templates.ts";
import {
  connectModel,
  type ModelConnectorInput,
} from "../llm/model-connector.ts";
import { ReasoningLevel } from "../llm/platforms.ts";
import type {
  CredentialMetadataFn,
  WorkbenchAuthorization,
  WorkbenchCredentialsFn,
} from "../custody/contract.ts";
import {
  ActionOutcome,
  type ConversationMember,
  GUARD_AGENT_NAME,
  GuardSummaryCause,
  MessageDelivery,
  type PendingApproval,
  type PlanPhase,
  type QueuedMessage,
  type RunSnapshot,
  type SessionEntry,
  type SessionEvents,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_EVENTS_WAIT_MS,
  WORKBENCH_EXPIRY_REASON,
  WORKBENCH_QUEUE_LIMIT,
  WORKBENCH_QUEUED_MESSAGE_PREFIX,
  WORKBENCH_REJECTION_REASON,
  WORKBENCH_RELAY_ENTRY,
  WORKBENCH_SESSION_PREFIX,
  type WorkbenchConfiguration,
  workbenchConfigurationSchema,
  WorkbenchErrorCode,
  workbenchOperations,
  WorkbenchRecordKind,
  type WorkbenchSession,
} from "./contract.ts";
import { missionOperations } from "../mission/contract.ts";
import {
  forkMaterial,
  lastAnswerer,
  lastTurnEntry,
  type MentionMatch,
  mergeEntries,
  type MergeMember,
  parseCursor,
  type RelayMember,
  relayText,
  resolveMention,
} from "./conversation.ts";
import { offerActionTool } from "./actions.ts";
import {
  checkSummary,
  classifyCall,
  type SummaryDecision,
  SummaryVerdict,
} from "./guard-classifier.ts";
import { forkSummaryRequest, summarize, visibleText } from "./fork-summary.ts";
import {
  GuardAction,
  type GuardClassifier,
  guardDecision,
  type GuardDecision,
  type GuardRun,
} from "./guard.ts";
import {
  EVIDENCE_ASSET_MISMATCH,
  EVIDENCE_READ_TOOL,
  evidenceFacts,
  evidenceReadTool,
} from "./evidence.ts";
import type { WorkbenchConfig } from "./config.ts";
import {
  createPhaseSession,
  openPhaseSession,
  type PhaseAnswer,
  PLAN_AGENT,
  planMutations,
  planOf,
  runPlanPipeline,
  withoutOfferAction,
} from "./plan-pipeline.ts";
import {
  builtinTools,
  type InvokeOperation,
  operationTool,
  toolName,
  toolOperations,
} from "./tools.ts";
import {
  actionSettled,
  appendForkOpening,
  appendOpening,
  appendRecord,
  createSession,
  findSession,
  forkedFrom,
  forkSourceTitle,
  hostIdOf,
  lastModel,
  lastThinkingLevel,
  listSessions,
  recordOf,
  resumeCommand,
  type SessionPlace,
  sessionPlace,
  storedAutoMode,
  storedConfiguration,
} from "./sessions.ts";

export type WorkbenchModelRuntimeFactory = (
  input: ModelConnectorInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export interface Dependencies {
  store: Store;
  config: WorkbenchConfig;
  logger: Logger;
  stateDirectory: string;
  hostHome?: string;
  agentPrompt: {
    compose(agentName: string, context: Context): Promise<PromptPartAnswer[]>;
    templates(context: Context): Promise<PromptTemplates>;
  };
  agentConfiguration: {
    validateEntry(
      tx: Transaction,
      agentName: string,
      entry: WorkbenchConfiguration | null,
    ): void;
    agentView(
      tx: Transaction,
      agentName: string,
      entry: WorkbenchConfiguration | null,
    ): AgentView | null;
  };
  credentialMetadata: CredentialMetadataFn;
  workbenchCredentials: WorkbenchCredentialsFn;
  modelRuntimeFactory?: WorkbenchModelRuntimeFactory;
  guardClassifier?: typeof classifyCall;
  operations: () => readonly Operation[];
  invoke: InvokeOperation;
}

interface Resolved {
  provider: string;
  credentialId: string;
  metadata: unknown;
}

interface GuardResolved extends Resolved {
  credential: string;
  agentProvider: string;
  model: string;
}

interface GuardAuthorization extends WorkbenchAuthorization {
  agentProvider: string;
}

interface BuiltRuntime {
  provider: string;
  runtime: ModelRuntime;
  model: Model<Api>;
  credentials: ReturnType<Dependencies["workbenchCredentials"]>;
  lifetime: CancellationContext;
}

export interface ForkInput {
  text: string;
}

interface RuntimeOwner {
  id: string;
  configuration: WorkbenchConfiguration;
  requester: HumanIdentity | undefined;
}

interface SummaryInput {
  resolved: Resolved;
  request: ReturnType<typeof forkSummaryRequest>;
}

interface SummaryCheckInput {
  instruction: string;
  summary: string;
}

interface ForkSummary {
  summary: string;
  model: Model<Api>;
}

interface GuardRuntime {
  runtime: ModelRuntime;
  model: Model<Api>;
}

interface GuardSession {
  key: string;
  ready: Promise<GuardRuntime>;
}

interface GuardOutcomeOptions {
  call: ToolCallEvent;
  operation: Operation;
  input: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

interface OpenSession {
  id: string;
  hostId: string | null;
  members: OpenSession[];
  agentName: string;
  place: SessionPlace;
  manager: SessionManager;
  configuration: WorkbenchConfiguration;
  requester: HumanIdentity | undefined;
  agent: AgentSession | null;
  disposeAgent: () => void;
  queue: Promise<void>;
  run: Run | null;
  phase: PlanPhase | null;
  runError: string | null;
  agentErrorStale: boolean;
  queuedMessages: PendingMessage[];
  waiters: Set<() => void>;
  version: number;
  approvals: Map<string, Approval>;
  doneReports: Set<string>;
  evidenceGrants: Set<string>;
  autoMode: boolean;
  guard: GuardSession | null;
  redaction: SensitiveTextRedaction | null;
  secrets: KnownSecrets;
}

interface EvidenceGrantOptions {
  signal: AbortSignal | undefined;
}

type PendingApprovalRequest = Omit<PendingApproval, "session_id">;

interface Approval {
  approval: PendingApproval;
  decide: (decision: ToolDecision) => void;
}

interface PendingMessage extends QueuedMessage {
  requester: HumanIdentity;
}

interface EnqueueItem {
  text: string;
  requester: HumanIdentity;
}

function queuedView({
  id,
  text,
  agent_name,
  display_name,
}: PendingMessage): QueuedMessage {
  return { id, text, agent_name, display_name };
}

interface LaunchItem {
  text: string;
  requester: HumanIdentity;
  context: Context;
}

interface ClaimOptions {
  clearError: boolean;
  request: string;
}

interface MessageBody {
  text: string;
  delivery: MessageDelivery;
}

interface Run {
  request: string;
  memberId: string | null;
  settle: () => void;
  stopped: boolean;
  firstEntry: number;
  ended: boolean;
  endingCall: string | null;
  offerToolCallId: string | null;
  phase: PlanPhase | null;
  phaseSession: OpenSession | null;
  phases: OpenSession[];
  settled: Promise<void>;
}

interface PlanLaunch {
  host: OpenSession;
  member: OpenSession;
  run: Run;
  item: LaunchItem;
  resolved: Resolved;
}

type AgentEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

function requiresAbort(run: Run | null, event: AgentEvent): boolean {
  if (!run) return false;
  if (event.type === AGENT_START) return run.stopped;
  return (
    event.type === TOOL_EXECUTION_END && event.toolCallId === run.endingCall
  );
}

interface ActionReportBody {
  outcome: ActionOutcome;
  error_code: string | null;
}

interface ActionReportResult {
  session_id: string;
  tool_call_id: string;
  outcome: ActionOutcome;
}

const IDLE_SESSION = {
  disposeAgent: () => {},
  run: null,
  phase: null,
  runError: null,
  agentErrorStale: false,
  redaction: null,
  guard: null,
  secrets: async () => [],
} as const;
const NOT_FOUND_INDEX = -1;
const SUMMARY_REFUSED_LOG = "workbench.fork.summary_refused";
const AGENT_START = "agent_start";
const AGENT_END = "agent_end";
const ASSISTANT_ROLE = "assistant";
const TEXT_BLOCK = "text";
const ERROR_STOP_REASON = "error";
const ABORTED_STOP_REASON = "aborted";
const PHASE_ERROR_MESSAGE = "The plan phase ended with an error.";
const TOOL_EXECUTION_END = "tool_execution_end";
const ALLOWED: ToolDecision = { allowed: true };
const REJECTED: ToolDecision = {
  allowed: false,
  reason: WORKBENCH_REJECTION_REASON,
  terminate: false,
};
const EXPIRED: ToolDecision = {
  allowed: false,
  reason: WORKBENCH_EXPIRY_REASON,
  terminate: true,
};

const defaultModelRuntimeFactory: WorkbenchModelRuntimeFactory = async (
  input,
) => connectModel(await loadPi(), input);

function sessionNotFound(sessionId: string): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkbenchErrorCode.SessionNotFound,
    "Workbench session not found.",
    { session_id: sessionId },
  );
}

function summaryFailed(sessionId: string): OperationError {
  return new OperationError(
    HttpStatus.BadGateway,
    WorkbenchErrorCode.SummaryFailed,
    "The summary of the workbench conversation failed.",
    { session_id: sessionId },
  );
}

function summaryRefused(
  cause: GuardSummaryCause,
  reason: string | null,
): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    WorkbenchErrorCode.SummaryRefused,
    "The guard refused the summary of the workbench conversation.",
    { cause, reason },
  );
}

function displayNameOf(agentName: string): string {
  const declaration = getAgentDeclaration(agentName);
  assert.ok(declaration);
  return declaration.display_name;
}

function notHost(session: OpenSession): OperationError {
  assert.ok(session.hostId);
  return new OperationError(
    HttpStatus.Conflict,
    WorkbenchErrorCode.NotHost,
    "The workbench session is a participant. Use the host session.",
    { session_id: session.id, host_session_id: session.hostId },
  );
}

interface StoredSession {
  agentName: string;
  manager: SessionManager;
}

interface SessionFields {
  id: string;
  hostId: string | null;
  agentName: string;
  place: SessionPlace;
  manager: SessionManager;
  configuration: WorkbenchConfiguration;
  requester: HumanIdentity | undefined;
  autoMode: boolean;
}

function newOpenSession(fields: SessionFields): OpenSession {
  return {
    ...fields,
    members: [],
    agent: null,
    ...IDLE_SESSION,
    queuedMessages: [],
    queue: Promise.resolve(),
    waiters: new Set(),
    version: 0,
    approvals: new Map(),
    doneReports: new Set(),
    evidenceGrants: new Set(),
  };
}

function refused(sessionId: string): OperationError {
  return new OperationError(
    HttpStatus.Forbidden,
    WorkbenchErrorCode.AuthorizationRefused,
    "The workbench session refuses the credential release.",
    { session_id: sessionId },
  );
}

function requireAgent(agentName: string): void {
  if (!getAgentDeclaration(agentName))
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "Agent not found.",
      { agent_name: agentName },
    );
}

function requireWorkbenchAgent(agentName: string): void {
  requireAgent(agentName);
  if (!workbenchAgentNames().includes(agentName))
    throw new OperationError(
      HttpStatus.Conflict,
      WorkbenchErrorCode.AgentRefused,
      "The agent cannot hold a Workbench session.",
      { agent_name: agentName },
    );
}

function humanOf(caller: CallerContext): HumanIdentity {
  assert.ok(isHumanIdentity(caller.identity));
  return caller.identity;
}

export class WorkbenchService implements Service {
  private readonly dependencies: Dependencies;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly finishedPhaseEntries = new Map<string, SessionEntry[]>();
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

  authorizeGuard(
    tx: Transaction,
    requester: HumanIdentity,
    sessionId: string,
  ): GuardAuthorization {
    assert.ok(isHumanIdentity(requester));
    if (!this.sessions.has(sessionId)) throw refused(sessionId);
    const view = this.dependencies.agentConfiguration.agentView(
      tx,
      GUARD_AGENT_NAME,
      null,
    );
    if (!view?.valid || !view.effective) throw refused(sessionId);
    return {
      credential: view.effective.credential,
      platform: view.effective.provider,
      agentProvider: view.effective.agent_provider,
    };
  }

  private resolveGuard(
    tx: Transaction,
    sessionId: string,
    requester: HumanIdentity | undefined,
  ): GuardResolved {
    if (!requester) throw refused(sessionId);
    const { credential, platform, agentProvider } = this.authorizeGuard(
      tx,
      requester,
      sessionId,
    );
    const metadata = this.dependencies.credentialMetadata(tx, credential);
    if (!metadata) throw refused(sessionId);
    const model =
      getAgentDeclaration(GUARD_AGENT_NAME)?.pinned_model_identifier;
    assert.ok(model);
    return {
      provider: platform,
      credentialId: metadata.id,
      metadata: metadata.metadata,
      credential,
      agentProvider,
      model,
    };
  }

  private connectGuard(
    owner: Pick<RuntimeOwner, "id" | "requester">,
    resolved: GuardResolved,
    signal: AbortSignal,
  ): Promise<GuardRuntime> {
    const credentials = this.dependencies.workbenchCredentials({
      session_id: owner.id,
      platform: resolved.provider,
      requester: () => owner.requester,
      authorize: (tx, requester, sessionId) =>
        this.authorizeGuard(tx, requester, sessionId),
    });
    return (
      this.dependencies.modelRuntimeFactory ?? defaultModelRuntimeFactory
    )({
      credentials,
      handoverItem: {
        credential_id: resolved.credentialId,
        provider_id: piProviderId(resolved.provider),
      },
      credentialId: resolved.credentialId,
      configuration: {
        agent_provider: resolved.agentProvider,
        provider: resolved.provider,
        model_identifier: resolved.model,
        reasoning_effort: ReasoningLevel.Off,
      },
      metadata: resolved.metadata,
      signal,
    });
  }

  private startGuardRuntime(
    session: OpenSession,
    resolved: GuardResolved,
    key: string,
  ): GuardSession {
    const ready = this.connectGuard(session, resolved, this.shutdown.signal);
    const started = { key, ready };
    session.guard = started;
    ready.catch(() => {
      if (session.guard === started) session.guard = null;
    });
    return started;
  }

  private async guardClassifier(
    session: OpenSession,
    signal: AbortSignal | undefined,
  ): Promise<GuardClassifier | null> {
    let resolved: GuardResolved;
    try {
      resolved = this.dependencies.store.transaction((tx) =>
        this.resolveGuard(tx, session.id, session.requester),
      );
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return null;
    }
    const key = JSON.stringify([
      resolved.credentialId,
      resolved.provider,
      resolved.model,
    ]);
    const cached = session.guard;
    const started =
      cached?.key === key
        ? cached
        : this.startGuardRuntime(session, resolved, key);
    let guard: GuardRuntime;
    try {
      guard = await started.ready;
    } catch (error) {
      if (!(error instanceof Diagnostic)) throw error;
      return null;
    }
    const classify = this.dependencies.guardClassifier ?? classifyCall;
    return (request) =>
      classify({
        runtime: guard.runtime,
        model: guard.model,
        request,
        signal: signal ?? this.shutdown.signal,
      });
  }

  private guardRun(
    session: OpenSession,
    signal: AbortSignal | undefined,
  ): GuardRun {
    const host = this.hostOf(session);
    assert.ok(host.run);
    return {
      agentName: session.agentName,
      request: host.run.request,
      autoMode: () => host.autoMode,
      classifier: () => this.guardClassifier(session, signal),
    };
  }

  private guardOutcome(
    session: OpenSession,
    decision: GuardDecision,
    options: GuardOutcomeOptions,
  ): ToolDecision | Promise<ToolDecision> {
    const { call, operation, input, signal } = options;
    if (decision.action === GuardAction.Run) return ALLOWED;
    if (decision.action === GuardAction.Block)
      return { allowed: false, reason: decision.reason, terminate: false };
    if (decision.action === GuardAction.Auto) {
      appendRecord(session.manager, {
        kind: WorkbenchRecordKind.Guard,
        tool_call_id: call.toolCallId,
        operation_id: operation.id,
        reason: decision.reason,
      });
      this.notify(session);
      return ALLOWED;
    }
    return this.approval(
      session,
      {
        tool_call_id: call.toolCallId,
        operation_id: operation.id,
        input,
        guard: decision.guard,
      },
      signal,
    );
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
    const host = this.hostOf(session);
    const result = host.queue.then(work, work);
    host.queue = result.then(
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
    const parentPath = found.manager.getHeader()?.parentSession;
    if (parentPath !== undefined) {
      await this.session(hostIdOf(parentPath));
      const participant = this.sessions.get(sessionId);
      if (!participant) throw sessionNotFound(sessionId);
      return participant;
    }
    const host = this.stored(found, null);
    this.sessions.set(host.id, host);
    host.members.push(host);
    for (const participant of await this.participantsOf(host)) {
      this.sessions.set(participant.id, participant);
      host.members.push(participant);
    }
    return host;
  }

  private stored(found: StoredSession, hostId: string | null): OpenSession {
    const id = found.manager.getSessionId();
    const entries = this.entries(found.manager);
    const parsed = workbenchConfigurationSchema.safeParse(
      storedConfiguration(entries),
    );
    if (!parsed.success)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.ConfigurationInvalid,
        "The stored configuration of the workbench session is invalid.",
        { session_id: id },
      );
    return newOpenSession({
      id,
      hostId,
      agentName: found.agentName,
      place: sessionPlace(this.dependencies.stateDirectory, found.agentName),
      manager: found.manager,
      configuration: parsed.data,
      requester: undefined,
      autoMode: storedAutoMode(entries),
    });
  }

  private async participantsOf(host: OpenSession): Promise<OpenSession[]> {
    const participants: { created: number; session: OpenSession }[] = [];
    for (const agentName of workbenchAgentNames()) {
      const listed = await listSessions(
        sessionPlace(this.dependencies.stateDirectory, agentName),
        agentName,
      );
      for (const { id, created, host_session_id } of listed) {
        if (host_session_id !== host.id) continue;
        const found = await findSession(this.dependencies.stateDirectory, id);
        assert.ok(found);
        participants.push({ created, session: this.stored(found, host.id) });
      }
    }
    return participants
      .sort((left, right) => left.created - right.created)
      .map(({ session }) => session);
  }

  private hostOf(session: OpenSession): OpenSession {
    if (session.hostId === null) return session;
    const host = this.sessions.get(session.hostId);
    assert.ok(host);
    return host;
  }

  private requireHost(session: OpenSession): void {
    if (session.hostId !== null) throw notHost(session);
  }

  private membersOf(session: OpenSession): OpenSession[] {
    return session.hostId === null ? session.members : [session];
  }

  private runningMember(host: OpenSession): OpenSession {
    return this.memberOfRun(host, host.run);
  }

  private memberOfRun(host: OpenSession, run: Run | null): OpenSession {
    return host.members.find(({ id }) => id === run?.memberId) ?? host;
  }

  private entries(manager: SessionManager): SessionEntry[] {
    return JSON.parse(JSON.stringify(manager.getEntries())) as SessionEntry[];
  }

  private async greeting(
    session: OpenSession,
    context: Context,
  ): Promise<string> {
    const declaration = getAgentDeclaration(session.agentName);
    assert.ok(declaration);
    return renderTemplate(
      await this.dependencies.agentPrompt.templates(context),
      PromptTemplate.Greeting,
      {
        display_name: declaration.display_name,
        model: session.configuration.model_identifier,
      },
    );
  }

  private title(session: OpenSession, text: string): void {
    if (session.manager.getSessionName() === undefined)
      session.manager.appendSessionInfo(text);
  }

  private async buildRuntime(
    session: RuntimeOwner,
    resolved: Resolved,
    context: Context,
  ): Promise<BuiltRuntime> {
    const lifetime = new CancellationContext(this.shutdown);
    try {
      const credentials = this.dependencies.workbenchCredentials({
        session_id: session.id,
        platform: resolved.provider,
        requester: () => session.requester,
        authorize: (tx, requester, sessionId) =>
          this.authorize(tx, requester, sessionId),
      });
      const { runtime, model } = await withDeadline(
        (this.dependencies.modelRuntimeFactory ?? defaultModelRuntimeFactory)({
          credentials,
          handoverItem: {
            credential_id: resolved.credentialId,
            provider_id: piProviderId(resolved.provider),
          },
          credentialId: resolved.credentialId,
          configuration: {
            agent_provider: session.configuration.agent_provider,
            provider: resolved.provider,
            model_identifier: session.configuration.model_identifier,
            reasoning_effort: session.configuration
              .reasoning_effort as ReasoningLevel,
          },
          metadata: resolved.metadata,
          signal: lifetime.signal,
        }),
        context,
      ).catch((error: unknown) => {
        if (!(error instanceof Diagnostic)) throw error;
        throw new OperationError(
          HttpStatus.Conflict,
          WorkbenchErrorCode.SetupRefused,
          "The agent runtime of the workbench session refuses the configuration.",
          { session_id: session.id },
        );
      });
      return {
        provider: resolved.provider,
        runtime,
        model,
        credentials,
        lifetime,
      };
    } catch (error) {
      lifetime.cancel();
      throw error;
    }
  }

  private async openAgent(
    session: OpenSession,
    built: BuiltRuntime,
    context: Context,
  ): Promise<void> {
    assert.equal(session.agent, null);
    const isPhase = session.phase !== null;
    const declaration = getAgentDeclaration(session.agentName);
    assert.ok(declaration);
    const { provider, runtime, model, credentials, lifetime } = built;
    let agent: AgentSession | undefined;
    try {
      const hostHome = this.dependencies.hostHome ?? homedir();
      const composed = await this.dependencies.agentPrompt.compose(
        session.agentName,
        context,
      );
      const parts = isPhase ? withoutOfferAction(composed) : composed;
      const templates = await this.dependencies.agentPrompt.templates(context);
      const prompt = systemPrompt(parts, PromptConsumer.Workbench, templates);
      const builtin = builtinTools(
        await loadPi(),
        session.agentName,
        session.place.cwd,
      );
      const toolOperationsByName = new Map<string, Operation>();
      const operations = toolOperations(
        this.dependencies.operations(),
        declaration.tools.operation,
      ).map((operation) => {
        toolOperationsByName.set(toolName(operation.id), operation);
        return operationTool(
          operation,
          this.dependencies.invoke,
          () => session.requester,
        );
      });
      const offer = isPhase
        ? []
        : [
            offerActionTool({
              operations: this.dependencies.operations(),
              invoke: this.dependencies.invoke,
              requester: () => session.requester,
              offer: {
                taken: () => this.hostOf(session).run?.offerToolCallId != null,
                append: (record) => {
                  appendRecord(session.manager, record);
                  const { run } = this.hostOf(session);
                  assert.ok(run);
                  run.offerToolCallId = record.tool_call_id;
                  this.notify(session);
                },
              },
            }),
          ];
      const evidence = declaration.tools.workbench.includes(
        WorkbenchTool.EvidenceRead,
      )
        ? [
            evidenceReadTool(
              this.dependencies.invoke,
              () => session.requester,
              {
                grants: {
                  has: (nodeId) =>
                    this.hostOf(session).evidenceGrants.has(nodeId) ||
                    this.messageGrants(session, nodeId),
                },
              },
            ),
          ]
        : [];
      session.secrets = credentialSecrets(credentials, piProviderId(provider));
      const opened = await openSession({
        cwd: session.place.cwd,
        modelRuntime: runtime,
        model,
        thinkingLevel: session.configuration.reasoning_effort,
        systemPrompt: prompt,
        allowlist: [
          ...builtin.allowlist,
          ...operations.map((tool) => tool.name),
          ...offer.map((tool) => tool.name),
          ...evidence.map((tool) => tool.name),
        ],
        customTools: [
          ...builtin.customTools,
          ...operations,
          ...offer,
          ...evidence,
        ],
        hostHome,
        hooks: [
          toolApproval({
            approve: async (call, signal) => {
              if (call.toolName === EVIDENCE_READ_TOOL)
                return this.evidenceGrant(session, call, { signal });
              const operation = toolOperationsByName.get(call.toolName);
              if (!operation) return ALLOWED;
              const input = JSON.parse(JSON.stringify(call.input ?? {}));
              const decision = await guardDecision(
                operation,
                input,
                this.guardRun(session, signal),
              );
              return this.guardOutcome(session, decision, {
                call,
                operation,
                input,
                signal,
              });
            },
          }),
        ],
        context,
        sessionManager: session.manager,
        ...(session.redaction
          ? { redaction: session.redaction }
          : { knownSecrets: () => session.secrets() }),
      });
      agent = opened.session;
      session.redaction = opened.redaction;
      pinnedLayers().pinInference(agent, opened.systemPrompt);
      const unsubscribeEvents = agent.subscribe((event) => {
        const host = this.hostOf(session);
        if (requiresAbort(host.run, event)) void session.agent?.abort();
        if (event.type === AGENT_START && !host.run?.stopped)
          host.agentErrorStale = false;
        if (event.type === AGENT_END && host.run && !isPhase)
          host.run.ended = true;
        this.notify(session);
      });
      const running = agent;
      session.agent = running;
      session.disposeAgent = () => {
        unsubscribeEvents();
        running.dispose();
        lifetime.cancel();
      };
    } catch (error) {
      agent?.dispose();
      lifetime.cancel();
      throw error;
    }
  }

  private async evidenceGrant(
    session: OpenSession,
    call: ToolCallEvent,
    options: EvidenceGrantOptions,
  ): Promise<ToolDecision> {
    let facts: Awaited<ReturnType<typeof evidenceFacts>>;
    try {
      facts = await evidenceFacts(
        this.dependencies.invoke,
        () => session.requester,
        { input: call.input, signal: options.signal },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(EVIDENCE_ASSET_MISMATCH)) return ALLOWED;
      return { allowed: false, reason: message, terminate: false };
    }
    const host = this.hostOf(session);
    if (host.evidenceGrants.has(facts.node_id)) return ALLOWED;
    if (this.messageGrants(session, facts.node_id)) return ALLOWED;
    const { offset, length } = call.input as {
      offset?: number;
      length?: number;
    };
    const decision = await this.approval(
      session,
      {
        tool_call_id: call.toolCallId,
        operation_id: missionOperations["evidence.asset.content.download"].id,
        input: {
          node_id: facts.node_id,
          attempt: facts.attempt,
          evidence_id: facts.evidence_id,
          asset_id: facts.asset_id,
          kind: facts.kind,
          ...(offset === undefined ? {} : { offset }),
          ...(length === undefined ? {} : { length }),
        },
        guard: null,
      },
      options.signal,
    );
    if (decision.allowed) host.evidenceGrants.add(facts.node_id);
    return decision;
  }

  private messageGrants(session: OpenSession, nodeId: string): boolean {
    const host = this.hostOf(session);
    return host.autoMode && !!host.run?.request.includes(nodeId);
  }

  private approval(
    session: OpenSession,
    approval: PendingApprovalRequest,
    signal: AbortSignal | undefined,
  ): Promise<ToolDecision> {
    if (signal?.aborted) return Promise.resolve(REJECTED);
    const decision = Promise.withResolvers<ToolDecision>();
    const reject = () => decide(REJECTED);
    const expire = () => {
      const { run } = this.hostOf(session);
      if (run) run.endingCall = approval.tool_call_id;
      decide(EXPIRED);
    };
    const timer = setTimeout(expire, this.dependencies.config.approval_wait_ms);
    const decide = (result: ToolDecision) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", reject);
      session.approvals.delete(approval.tool_call_id);
      decision.resolve(result);
      this.notify(session);
    };
    signal?.addEventListener("abort", reject, { once: true });
    session.approvals.set(approval.tool_call_id, {
      approval: { ...approval, session_id: session.id },
      decide,
    });
    this.notify(session);
    return decision.promise;
  }

  private rejectApprovals(session: OpenSession): void {
    for (const { decide } of [...session.approvals.values()]) decide(REJECTED);
  }

  approve(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ): { session_id: string; tool_call_id: string; approved: boolean } {
    const pending = this.sessions.get(sessionId)?.approvals.get(toolCallId);
    if (!pending)
      throw new OperationError(
        HttpStatus.NotFound,
        WorkbenchErrorCode.ApprovalNotFound,
        "The workbench session holds no pending call with this identity.",
        { session_id: sessionId, tool_call_id: toolCallId },
      );
    pending.decide(approved ? ALLOWED : REJECTED);
    return { session_id: sessionId, tool_call_id: toolCallId, approved };
  }

  async autoModeSet(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ session_id: string; enabled: boolean }> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    if (session.autoMode !== enabled) {
      session.autoMode = enabled;
      appendRecord(session.manager, {
        kind: WorkbenchRecordKind.AutoMode,
        enabled,
      });
      this.notify(session);
    }
    return { session_id: sessionId, enabled };
  }

  async actionReport(
    sessionId: string,
    toolCallId: string,
    body: ActionReportBody,
  ): Promise<ActionReportResult> {
    const session = await this.session(sessionId);
    const entries = this.entries(session.manager);
    const [offered] = entries.flatMap((entry) => {
      const record = recordOf(entry);
      return record?.kind === WorkbenchRecordKind.ActionOffer &&
        record.tool_call_id === toolCallId
        ? [record]
        : [];
    });
    if (!offered)
      throw new OperationError(
        HttpStatus.NotFound,
        WorkbenchErrorCode.ActionNotFound,
        "The workbench session holds no action card with this identity.",
        { session_id: sessionId, tool_call_id: toolCallId },
      );
    const settled =
      session.doneReports.has(toolCallId) || actionSettled(entries, toolCallId);
    if (settled)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.ActionSettled,
        "The action card of this identity already has a done result.",
        { session_id: sessionId, tool_call_id: toolCallId },
      );
    const failure =
      body.outcome === ActionOutcome.Failed
        ? `failed${body.error_code === null ? "" : `, ${body.error_code}`}`
        : ActionOutcome.Done;
    const text = `The owner ran ${offered.operation_id} on ${offered.target_id}. Result: ${failure}.`;
    const details = {
      tool_call_id: toolCallId,
      operation_id: offered.operation_id,
      target_id: offered.target_id,
      outcome: body.outcome,
      error_code: body.error_code,
    };
    if (body.outcome === ActionOutcome.Done)
      session.doneReports.add(toolCallId);
    if (session.agent) {
      try {
        await session.agent.sendCustomMessage(
          {
            customType: WORKBENCH_ACTION_RESULT_ENTRY,
            content: text,
            display: false,
            details,
          },
          { triggerTurn: false },
        );
      } catch (error) {
        session.doneReports.delete(toolCallId);
        throw error;
      }
    } else
      session.manager.appendCustomMessageEntry(
        WORKBENCH_ACTION_RESULT_ENTRY,
        text,
        false,
        details,
      );
    this.notify(session);
    return {
      session_id: sessionId,
      tool_call_id: toolCallId,
      outcome: body.outcome,
    };
  }

  private closeAgent(session: OpenSession): void {
    this.rejectApprovals(session);
    session.disposeAgent();
    session.disposeAgent = () => {};
    session.agent = null;
    if (!session.redaction) return;
    const summary = redactionSummary(session.redaction.counts());
    if (redactionObserved(summary))
      this.dependencies.logger.info(
        { session_id: session.id, ...summary },
        REDACTION_LOG_MESSAGE,
      );
  }

  private syncEntries(session: OpenSession, provider: string): void {
    const { manager, configuration } = session;
    const entries = this.entries(manager);
    if (
      storedConfiguration(entries).agent_provider !==
      configuration.agent_provider
    )
      manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
        agent_provider: configuration.agent_provider,
      });
    const model = lastModel(entries);
    if (
      model?.provider !== provider ||
      model.modelId !== configuration.model_identifier
    )
      manager.appendModelChange(provider, configuration.model_identifier);
    if (lastThinkingLevel(entries) !== configuration.reasoning_effort)
      manager.appendThinkingLevelChange(configuration.reasoning_effort);
  }

  private memberEntries(host: OpenSession, limited: boolean): MergeMember[] {
    const running = limited && this.runActive(host);
    const active = this.runningMember(host);
    return host.members.map((member) => {
      const entries = this.entries(member.manager);
      return {
        sessionId: member.id,
        agentName: member.agentName,
        entries:
          running && member === active
            ? entries.slice(0, host.run!.firstEntry)
            : entries,
      };
    });
  }

  private async plannedPhases(member: OpenSession): Promise<MergeMember[]> {
    const phases = this.entries(member.manager).flatMap(
      (entry) => planOf(entry)?.details.phases ?? [],
    );
    const opened = await Promise.all(
      phases.map(async ({ phase, session_id: id }) => {
        const entries = await this.phaseEntries(id);
        return entries === null
          ? []
          : [{ sessionId: id, agentName: member.agentName, phase, entries }];
      }),
    );
    return opened.flat();
  }

  private async phaseEntries(
    sessionId: string,
  ): Promise<SessionEntry[] | null> {
    const cached = this.finishedPhaseEntries.get(sessionId);
    if (cached) return cached;
    const manager = await openPhaseSession(
      this.dependencies.stateDirectory,
      sessionId,
    );
    if (manager === null) return null;
    const entries = this.entries(manager);
    this.finishedPhaseEntries.set(sessionId, entries);
    return entries;
  }

  private async phaseMembers(host: OpenSession): Promise<MergeMember[]> {
    const found = new Map<string, MergeMember>();
    for (const member of host.members.filter(
      ({ agentName }) => agentName === PLAN_AGENT,
    ))
      for (const phased of await this.plannedPhases(member))
        found.set(phased.sessionId, phased);
    const { run } = host;
    if (run !== null && !run.ended)
      for (const session of run.phases) {
        assert.ok(session.phase);
        found.set(session.id, {
          sessionId: session.id,
          agentName: session.agentName,
          phase: session.phase,
          entries: this.entries(session.manager),
        });
      }
    return [...found.values()];
  }

  private conversationMembers(host: OpenSession): ConversationMember[] {
    return host.members.map((member) => ({
      session_id: member.id,
      agent_name: member.agentName,
      display_name: displayNameOf(member.agentName),
    }));
  }

  private async view(session: OpenSession): Promise<WorkbenchSession> {
    return {
      id: session.id,
      agent_name: session.agentName,
      configuration: { ...session.configuration },
      members: this.conversationMembers(session),
      forked_from: forkedFrom(this.entries(session.manager)),
      entries: mergeEntries([
        ...this.memberEntries(session, true),
        ...(await this.phaseMembers(session)),
      ]),
      run_active: this.runActive(session),
      resume_command: resumeCommand(
        session.manager,
        this.dependencies.hostHome ?? homedir(),
      ),
    };
  }

  private runState(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const pending = session ? this.pendingApprovalOf(session) : null;
    return {
      run_active:
        session !== undefined &&
        this.runActive(session) &&
        this.runsMember(session),
      pending_approval: pending
        ? {
            tool_call_id: pending.tool_call_id,
            operation_id: pending.operation_id,
          }
        : null,
    };
  }

  private runsMember(session: OpenSession): boolean {
    return (
      session.hostId === null ||
      this.hostOf(session).run?.memberId === session.id
    );
  }

  private pendingApprovalOf(session: OpenSession): PendingApproval | null {
    for (const member of this.membersOf(session)) {
      const pending = member.approvals.values().next().value?.approval;
      if (pending) return pending;
    }
    return null;
  }

  private runActive(session: OpenSession): boolean {
    const { run } = this.hostOf(session);
    return run !== null && !run.ended;
  }

  private activePhase(session: OpenSession): PlanPhase | null {
    const { run } = this.hostOf(session);
    return run !== null && !run.ended ? run.phase : null;
  }

  private notify(session: OpenSession): void {
    const host = this.hostOf(session);
    host.version++;
    for (const wake of [...host.waiters]) wake();
  }

  private requireIdle(session: OpenSession): void {
    if (this.hostOf(session).run)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.RunActive,
        "The workbench session holds an active run.",
        { session_id: session.id },
      );
  }

  private snapshot(session: OpenSession): RunSnapshot {
    const state = this.runningMember(session).agent?.state;
    const streaming = state?.streamingMessage;
    return {
      streaming_message:
        streaming === undefined ? null : JSON.parse(JSON.stringify(streaming)),
      pending_tool_calls: state ? [...state.pendingToolCalls] : [],
      pending_approval: this.pendingApprovalOf(session),
      run_active: this.runActive(session),
      phase: this.activePhase(session),
      queue: session.queuedMessages.map(queuedView),
      error_message:
        session.runError ??
        (session.agentErrorStale ? undefined : state?.errorMessage) ??
        null,
      auto_mode: session.autoMode,
    };
  }

  private async changes(host: OpenSession, after: string | undefined) {
    return {
      members: this.conversationMembers(host),
      entries: mergeEntries(
        [
          ...this.memberEntries(host, false),
          ...(await this.phaseMembers(host)),
        ],
        parseCursor(after, host.id),
      ),
      snapshot: this.snapshot(host),
      version: host.version,
    };
  }

  async events(
    sessionId: string,
    after: string | undefined,
    version: number | undefined,
    context: Context,
  ): Promise<SessionEvents> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    const window = new CancellationContext(
      context,
      Date.now() + WORKBENCH_EVENTS_WAIT_MS,
    );
    const wake = () => window.cancel();
    session.waiters.add(wake);
    try {
      const current = await this.changes(session, after);
      if (current.entries.length || version !== current.version) return current;
      await cancelled(window.signal);
      await new Promise((resolve) => setImmediate(resolve));
      return await this.changes(session, after);
    } finally {
      session.waiters.delete(wake);
      window.cancel();
    }
  }

  private claim(session: OpenSession, options: ClaimOptions): Run {
    const completion = Promise.withResolvers<void>();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (!run.stopped)
        session.runError ??=
          this.memberOfRun(session, run).agent?.state.errorMessage ?? null;
      if (session.run === run) session.run = null;
      completion.resolve();
      this.notify(session);
      this.startNext(session);
    };
    const run: Run = {
      request: options.request,
      memberId: null,
      settle,
      firstEntry: session.manager.getEntries().length,
      ended: false,
      endingCall: null,
      offerToolCallId: null,
      phase: null,
      phaseSession: null,
      phases: [],
      stopped: false,
      settled: completion.promise,
    };
    session.run = run;
    if (options.clearError) session.runError = null;
    this.notify(session);
    return run;
  }

  private async launch(
    host: OpenSession,
    run: Run,
    item: LaunchItem,
  ): Promise<void> {
    if (run.stopped) return run.settle();
    const member = await this.member(host, item);
    run.memberId = member.id;
    run.firstEntry = member.manager.getEntries().length;
    member.requester = item.requester;
    const resolved = this.dependencies.store.transaction((tx) =>
      this.resolve(tx, member.agentName, member.configuration),
    );
    if (member.agentName === PLAN_AGENT)
      return this.launchPlan({ host, member, run, item, resolved });
    if (!member.agent) {
      const built = await this.buildRuntime(member, resolved, item.context);
      await this.openAgent(member, built, item.context);
    }
    assert.ok(member.agent);
    await this.relay(host, member, item);
    void member.agent
      .prompt(item.text, { expandPromptTemplates: false })
      .catch((error: unknown) => {
        host.runError = error instanceof Error ? error.message : String(error);
      })
      .finally(run.settle);
  }

  private async launchPlan(launch: PlanLaunch): Promise<void> {
    const { host, member, run, item } = launch;
    const relay = await this.relayContent(host, member, item);
    const templates = await this.dependencies.agentPrompt.templates(
      item.context,
    );
    void runPlanPipeline({
      participant: member.manager,
      request: item.text,
      relay: relay ?? "",
      mutations: planMutations(this.dependencies.operations()),
      templates,
      stopped: () => this.phaseEnded(run),
      runPhase: (phase, message) => this.runPhase(launch, phase, message),
    })
      .catch((error: unknown) => {
        host.runError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        run.ended = true;
        run.phase = null;
        run.settle();
      });
  }

  private phaseEnded(run: Run): boolean {
    return run.stopped || this.shutdown.signal.aborted;
  }

  private async runPhase(
    launch: PlanLaunch,
    phase: PlanPhase,
    message: string,
  ): Promise<PhaseAnswer | null> {
    const { host, member, run, resolved } = launch;
    if (this.phaseEnded(run)) return null;
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    const session = {
      ...newOpenSession({
        id,
        hostId: host.id,
        agentName: member.agentName,
        place: member.place,
        manager: await createPhaseSession(this.dependencies.stateDirectory, id),
        configuration: member.configuration,
        requester: member.requester,
        autoMode: true,
      }),
      phase,
    };
    run.phase = phase;
    run.phaseSession = session;
    run.phases.push(session);
    this.notify(host);
    try {
      const built = await this.buildRuntime(member, resolved, this.shutdown);
      await this.openAgent(session, built, this.shutdown);
      if (this.phaseEnded(run)) return null;
      assert.ok(session.agent);
      await session.agent.prompt(message, { expandPromptTemplates: false });
      return this.phaseAnswer(launch, session);
    } finally {
      this.closeAgent(session);
      run.phaseSession = null;
    }
  }

  private phaseAnswer(
    launch: PlanLaunch,
    session: OpenSession,
  ): PhaseAnswer | null {
    if (this.phaseEnded(launch.run)) return null;
    assert.ok(session.agent);
    const last = session.agent.state.messages.findLast(
      (entry): entry is AssistantMessage => entry.role === ASSISTANT_ROLE,
    );
    if (!last) return null;
    if (last.stopReason === ABORTED_STOP_REASON) return null;
    if (last.stopReason === ERROR_STOP_REASON) {
      launch.host.runError = last.errorMessage ?? PHASE_ERROR_MESSAGE;
      return null;
    }
    return {
      sessionId: session.id,
      text: last.content
        .flatMap((block) => (block.type === TEXT_BLOCK ? [block.text] : []))
        .join(""),
    };
  }

  private relayMember(member: OpenSession): RelayMember {
    return {
      id: member.id,
      displayName: displayNameOf(member.agentName),
      entries: this.entries(member.manager),
    };
  }

  private async relayContent(
    host: OpenSession,
    member: OpenSession,
    item: LaunchItem,
  ): Promise<string | null> {
    const self = this.relayMember(member);
    return relayText(self, {
      members: host.members.map((other) => this.relayMember(other)),
      startEntry: lastTurnEntry(self.entries),
      authorName: item.requester.name,
      templates: await this.dependencies.agentPrompt.templates(item.context),
    });
  }

  private async relay(
    host: OpenSession,
    member: OpenSession,
    item: LaunchItem,
  ): Promise<void> {
    assert.ok(member.agent);
    const content = await this.relayContent(host, member, item);
    if (content === null) return;
    await member.agent.sendCustomMessage({
      customType: WORKBENCH_RELAY_ENTRY,
      content,
      display: false,
    });
  }

  private async member(host: OpenSession, item: LaunchItem) {
    const mention = this.dependencies.store.transaction((tx) =>
      resolveMention(tx, item.text, this.dependencies),
    );
    if (mention === null) return this.answeredLast(host);
    const existing = host.members.find(
      ({ agentName }) => agentName === mention.agent_name,
    );
    return existing ?? this.createParticipant(host, mention.agent_name, item);
  }

  private answeredLast(host: OpenSession): OpenSession {
    const id = lastAnswerer(
      host.members.map((member) => ({
        id: member.id,
        entries: this.entries(member.manager),
      })),
    );
    return host.members.find((member) => member.id === id) ?? host;
  }

  private async createParticipant(
    host: OpenSession,
    agentName: string,
    item: LaunchItem,
  ): Promise<OpenSession> {
    const { configuration, resolved } = this.dependencies.store.transaction(
      (tx) => {
        const view = this.dependencies.agentConfiguration.agentView(
          tx,
          agentName,
          null,
        );
        const defaults = workbenchConfigurationSchema.parse(view?.defaults);
        return {
          configuration: defaults,
          resolved: this.resolve(tx, agentName, defaults),
        };
      },
    );
    const parentSession = host.manager.getSessionFile();
    assert.ok(parentSession);
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    const place = sessionPlace(this.dependencies.stateDirectory, agentName);
    const participant = newOpenSession({
      id,
      hostId: host.id,
      agentName,
      place,
      manager: await createSession(place, id, { parentSession }),
      configuration,
      requester: item.requester,
      autoMode: true,
    });
    this.sessions.set(id, participant);
    host.members.push(participant);
    let built: BuiltRuntime | undefined;
    try {
      built = await this.buildRuntime(participant, resolved, item.context);
      await this.openAgent(participant, built, item.context);
      this.syncEntries(participant, piProviderId(resolved.provider));
    } catch (error) {
      built?.lifetime.cancel();
      this.closeAgent(participant);
      this.sessions.delete(id);
      host.members.splice(host.members.indexOf(participant), 1);
      const file = participant.manager.getSessionFile();
      if (file) rmSync(file, { force: true });
      throw error;
    }
    return participant;
  }

  private startNext(session: OpenSession): void {
    if (this.shutdown.signal.aborted) {
      session.queuedMessages.length = 0;
      return;
    }
    if (session.run) return;
    const item = session.queuedMessages.shift();
    if (!item) return;
    const run = this.claim(session, {
      clearError: false,
      request: item.text,
    });
    this.exclusive(session, () =>
      this.launch(session, run, { ...item, context: this.shutdown }),
    ).catch((error: unknown) => {
      session.runError = error instanceof Error ? error.message : String(error);
      run.settle();
    });
  }

  private async stopRun(session: OpenSession, run: Run | null): Promise<void> {
    if (!run || session.run !== run) return;
    run.stopped = true;
    session.agentErrorStale = true;
    for (const member of session.members) this.rejectApprovals(member);
    await run.phaseSession?.agent?.abort();
    await this.memberOfRun(session, run).agent?.abort();
  }

  private enqueue(
    session: OpenSession,
    item: EnqueueItem,
    mention: MentionMatch | null,
  ): string {
    if (session.queuedMessages.length >= WORKBENCH_QUEUE_LIMIT)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.QueueFull,
        "The workbench session holds the maximum number of queued messages.",
        { session_id: session.id, limit: WORKBENCH_QUEUE_LIMIT },
      );
    const id = createIdentity(WORKBENCH_QUEUED_MESSAGE_PREFIX);
    session.queuedMessages.push({
      id,
      text: item.text,
      requester: item.requester,
      agent_name: mention?.agent_name ?? null,
      display_name: mention?.display_name ?? null,
    });
    this.notify(session);
    return id;
  }

  private clearQueue(session: OpenSession): QueuedMessage[] {
    const cleared = session.queuedMessages.splice(0).map(queuedView);
    if (cleared.length) this.notify(session);
    return cleared;
  }

  async message(
    caller: CallerContext,
    sessionId: string,
    body: MessageBody,
  ): Promise<{
    session_id: string;
    agent_name: string | null;
    run_active: true;
    queued_message_id: string | null;
    cleared: QueuedMessage[];
  }> {
    const { text, delivery } = body;
    const session = await this.session(sessionId);
    this.requireHost(session);
    const requester = humanOf(caller);
    const active = session.run;
    if (active) {
      const mention = this.dependencies.store.transaction((tx) =>
        resolveMention(tx, text, this.dependencies),
      );
      const cleared =
        delivery === MessageDelivery.Replace ? this.clearQueue(session) : [];
      const queued = this.enqueue(session, { text, requester }, mention);
      this.title(session, text);
      if (delivery === MessageDelivery.Replace)
        this.exclusive(session, () => this.stopRun(session, active)).catch(
          (error: unknown) => {
            session.runError =
              error instanceof Error ? error.message : String(error);
            this.notify(session);
          },
        );
      return {
        session_id: sessionId,
        agent_name: mention?.agent_name ?? null,
        run_active: true,
        queued_message_id: queued,
        cleared,
      };
    }
    const run = this.claim(session, { clearError: true, request: text });
    try {
      await this.exclusive(session, () =>
        this.launch(session, run, {
          text,
          requester,
          context: caller.context,
        }),
      );
    } catch (error) {
      run.settle();
      throw error;
    }
    this.title(session, text);
    return {
      session_id: sessionId,
      agent_name: this.memberOfRun(session, run).agentName,
      run_active: true,
      queued_message_id: null,
      cleared: [],
    };
  }

  private requireLive(context: Context): void {
    const reason = reasonOf(context.signal);
    if (reason) throw reason;
  }

  private async summarizeSource(
    caller: CallerContext,
    source: OpenSession,
    summary: SummaryInput,
  ): Promise<ForkSummary> {
    const built = await this.buildRuntime(
      {
        id: source.id,
        configuration: source.configuration,
        requester: humanOf(caller),
      },
      summary.resolved,
      caller.context,
    );
    try {
      const result = await summarize({
        runtime: built.runtime,
        model: built.model,
        request: summary.request,
        signal: caller.context.signal,
      });
      this.requireLive(caller.context);
      if (!result.ok) throw summaryFailed(source.id);
      return { summary: result.summary, model: built.model };
    } finally {
      built.lifetime.cancel();
    }
  }

  private async checkSource(
    caller: CallerContext,
    source: OpenSession,
    check: SummaryCheckInput,
  ): Promise<SummaryDecision> {
    const owner = { id: source.id, requester: humanOf(caller) };
    let resolved: GuardResolved;
    try {
      resolved = this.dependencies.store.transaction((tx) =>
        this.resolveGuard(tx, owner.id, owner.requester),
      );
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return this.unavailable();
    }
    const lifetime = new CancellationContext(
      joined(caller.context, this.shutdown),
    );
    try {
      const guard = await withDeadline(
        this.connectGuard(owner, resolved, lifetime.signal),
        caller.context,
      ).catch((error: unknown) => {
        if (!(error instanceof Diagnostic)) throw error;
        return null;
      });
      if (guard === null) return this.unavailable();
      return await checkSummary({
        runtime: guard.runtime,
        model: guard.model,
        ...check,
        signal: caller.context.signal,
      });
    } finally {
      lifetime.cancel();
    }
  }

  private unavailable(): SummaryDecision {
    return {
      decision: SummaryVerdict.Refuse,
      cause: GuardSummaryCause.Unavailable,
      reason: null,
    };
  }

  private async writeFork(
    caller: CallerContext,
    source: OpenSession,
    opening: ForkSummary & { provider: string; title: string },
  ): Promise<OpenSession> {
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    const place = sessionPlace(
      this.dependencies.stateDirectory,
      source.agentName,
    );
    const fork = newOpenSession({
      id,
      hostId: null,
      agentName: source.agentName,
      place,
      manager: await createSession(place, id, {}),
      configuration: { ...source.configuration },
      requester: humanOf(caller),
      autoMode: true,
    });
    fork.members.push(fork);
    this.sessions.set(id, fork);
    try {
      this.syncEntries(fork, opening.provider);
      appendRecord(fork.manager, {
        kind: WorkbenchRecordKind.Fork,
        source_title: opening.title,
      });
      appendForkOpening(fork.manager, {
        model: opening.model,
        sourceId: source.id,
        summary: opening.summary,
      });
    } catch (error) {
      this.discardFork(fork);
      throw error;
    }
    return fork;
  }

  private discardFork(fork: OpenSession): void {
    for (const member of fork.members) {
      this.closeAgent(member);
      this.sessions.delete(member.id);
      const file = member.manager.getSessionFile();
      if (file) rmSync(file, { force: true });
    }
  }

  async fork(
    caller: CallerContext,
    sourceId: string,
    input: ForkInput,
  ): Promise<{ session_id: string; run_active: true }> {
    const source = await this.session(sourceId);
    this.requireHost(source);
    const resolved = this.dependencies.store.transaction((tx) => {
      resolveMention(tx, input.text, this.dependencies);
      return this.resolve(tx, source.agentName, source.configuration);
    });
    const instruction = visibleText(input.text);
    const members = this.memberEntries(source, true).map((member) => ({
      id: member.sessionId,
      displayName: displayNameOf(member.agentName),
      entries: member.entries,
    }));
    const material = forkMaterial({
      members,
      authorName: humanOf(caller).name,
      inProgress: this.runActive(source) ? source.run!.request : null,
    });
    const title = forkSourceTitle(
      this.entries(source.manager),
      source.manager.getSessionName(),
    );
    const { summary, model } = await this.summarizeSource(caller, source, {
      resolved,
      request: forkSummaryRequest(visibleText(material), instruction),
    });
    const visibleSummary = visibleText(summary);
    const decision = await this.checkSource(caller, source, {
      instruction,
      summary: visibleSummary,
    });
    this.requireLive(caller.context);
    if (decision.decision === SummaryVerdict.Refuse) {
      this.dependencies.logger.info(
        { session_id: sourceId, cause: decision.cause },
        SUMMARY_REFUSED_LOG,
      );
      throw summaryRefused(decision.cause, decision.reason);
    }
    const fork = await this.writeFork(caller, source, {
      summary: visibleSummary,
      model,
      provider: piProviderId(resolved.provider),
      title,
    });
    try {
      await this.message(caller, fork.id, {
        text: input.text,
        delivery: MessageDelivery.Queue,
      });
    } catch (error) {
      this.discardFork(fork);
      throw error;
    }
    return { session_id: fork.id, run_active: true };
  }

  async removeQueued(
    sessionId: string,
    queuedMessageId: string,
  ): Promise<{ session_id: string; queued_message_id: string }> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    const index = session.queuedMessages.findIndex(
      ({ id }) => id === queuedMessageId,
    );
    if (index === NOT_FOUND_INDEX)
      throw new OperationError(
        HttpStatus.NotFound,
        WorkbenchErrorCode.QueuedMessageNotFound,
        "The workbench session holds no queued message with this identity.",
        { session_id: sessionId, queued_message_id: queuedMessageId },
      );
    session.queuedMessages.splice(index, 1);
    this.notify(session);
    return { session_id: sessionId, queued_message_id: queuedMessageId };
  }

  async abort(sessionId: string): Promise<{
    session_id: string;
    run_active: false;
    cleared: QueuedMessage[];
  }> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    const run = session.run;
    const cleared = this.clearQueue(session);
    await this.exclusive(session, () => this.stopRun(session, run));
    if (run) await run.settled;
    return { session_id: sessionId, run_active: false, cleared };
  }

  async list(agentName: string | undefined) {
    if (agentName !== undefined) requireAgent(agentName);
    const stored = [];
    for (const name of workbenchAgentNames())
      stored.push(
        ...(await listSessions(
          sessionPlace(this.dependencies.stateDirectory, name),
          name,
        )),
      );
    const items = [];
    for (const host of stored) {
      if (host.host_session_id !== null) continue;
      if (agentName !== undefined && host.agent_name !== agentName) continue;
      const participants = stored
        .filter(({ host_session_id }) => host_session_id === host.id)
        .sort((left, right) => left.created - right.created)
        .map((participant) => ({
          ...participant,
          ...this.runState(participant.id),
          display_name: displayNameOf(participant.agent_name),
          participants: [] as [],
        }));
      items.push({
        ...host,
        ...this.runState(host.id),
        display_name: displayNameOf(host.agent_name),
        modified: Math.max(
          host.modified,
          ...participants.map(({ modified }) => modified),
        ),
        participants,
      });
    }
    return { items };
  }

  async create(
    caller: CallerContext,
    body: WorkbenchConfiguration & { agent_name: string },
  ): Promise<WorkbenchSession> {
    const { agent_name: agentName, ...configuration } = body;
    requireWorkbenchAgent(agentName);
    const resolved = this.dependencies.store.transaction((tx) =>
      this.resolve(tx, agentName, configuration),
    );
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    const place = sessionPlace(this.dependencies.stateDirectory, agentName);
    const session = newOpenSession({
      id,
      hostId: null,
      agentName,
      place,
      manager: await createSession(place, id, {}),
      configuration,
      requester: humanOf(caller),
      autoMode: true,
    });
    session.members.push(session);
    this.sessions.set(id, session);
    let built: BuiltRuntime | undefined;
    try {
      built = await this.buildRuntime(session, resolved, caller.context);
      this.syncEntries(session, piProviderId(resolved.provider));
      appendOpening(session.manager, {
        model: built.model,
        greeting: await this.greeting(session, caller.context),
      });
      await this.openAgent(session, built, caller.context);
    } catch (error) {
      built?.lifetime.cancel();
      this.closeAgent(session);
      this.sessions.delete(id);
      const file = session.manager.getSessionFile();
      if (file) rmSync(file, { force: true });
      throw error;
    }
    return this.view(session);
  }

  async get(sessionId: string): Promise<WorkbenchSession> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    return this.view(session);
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
        const built = await this.buildRuntime(
          session,
          resolved,
          caller.context,
        );
        await this.openAgent(session, built, caller.context);
      } catch (error) {
        session.configuration = previous;
        throw error;
      }
      this.syncEntries(session, piProviderId(resolved.provider));
      return { ...session.configuration };
    });
  }

  declare(registry: OperationRegistry): void {
    registry.register(workbenchOperations["session.list"], ({ query }) =>
      this.list(query.agent_name),
    );
    registry.register(
      workbenchOperations["session.create"],
      ({ body }, caller) => this.create(caller, body),
    );
    registry.register(workbenchOperations["session.get"], ({ params }) =>
      this.get(params.session_id),
    );
    registry.register(
      workbenchOperations["session.fork"],
      ({ params, body }, caller) => this.fork(caller, params.session_id, body),
    );
    registry.register(
      workbenchOperations["session.configure"],
      ({ params, body }, caller) =>
        this.configure(caller, params.session_id, body),
    );
    registry.register(
      workbenchOperations["session.message"],
      ({ params, body }, caller) =>
        this.message(caller, params.session_id, body),
    );
    registry.register(
      workbenchOperations["session.approve"],
      ({ params, body }) =>
        this.approve(params.session_id, body.tool_call_id, body.approved),
    );
    registry.register(
      workbenchOperations["session.action.report"],
      ({ params, body }) =>
        this.actionReport(params.session_id, params.tool_call_id, body),
    );
    registry.register(
      workbenchOperations["session.autoMode.set"],
      ({ params, body }) => this.autoModeSet(params.session_id, body.enabled),
    );
    registry.register(workbenchOperations["session.abort"], ({ params }) =>
      this.abort(params.session_id),
    );
    registry.register(
      workbenchOperations["session.queue.remove"],
      ({ params }) =>
        this.removeQueued(params.session_id, params.queued_message_id),
    );
    registry.register(
      workbenchOperations["session.events"],
      ({ params, query }, caller) =>
        this.events(
          params.session_id,
          query.after,
          query.version,
          caller.context,
        ),
    );
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
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
      const phaseSession = session.run?.phaseSession;
      if (phaseSession) {
        void phaseSession.agent?.abort();
        this.closeAgent(phaseSession);
      }
      this.closeAgent(session);
    }
    this.sessions.clear();
    this.finishedPhaseEntries.clear();
    return Promise.resolve(null);
  }

  async run(context: Context = background): Promise<Error | null> {
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await this.start();
    if (error) return error;
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      sessions:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

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
import { HttpStatus, MediaType } from "../kernel/http.ts";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import { ProjectErrorCode, projectOperations } from "../project/contract.ts";
import type { ProjectLookup, ProjectScope } from "../kernel/project-scope.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { GuestIdentity, HumanIdentity } from "../kernel/caller.ts";
import {
  isGuestIdentity,
  isHumanIdentity,
  isReadOnlyIdentity,
} from "../kernel/caller.ts";
import {
  type CallerContext,
  type Operation,
  type OperationRegistry,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import { isObject, isString } from "../kernel/values.ts";
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
import type { AgentVariant, AgentVariantItem } from "../agent/variants.ts";
import type {
  ComposeOptions,
  PromptPartAnswer,
  PromptTemplates,
  PromptVariant,
} from "../agent/contract.ts";
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
  type Author,
  AuthorKind,
  type ConversationMember,
  type GrantClaim,
  type GrantedInvite,
  GUARD_AGENT_NAME,
  GuardSummaryCause,
  MessageDelivery,
  MessageKind,
  type PendingApproval,
  type PlanPhase,
  QueueClearCause,
  type QueuedMessage,
  type RunSnapshot,
  type ScopeRequestView,
  type SessionEntry,
  type SessionEvents,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_EVENTS_WAIT_MS,
  WORKBENCH_EXPIRY_REASON,
  WORKBENCH_INVITE_NAME_MAX_LENGTH,
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WORKBENCH_QUEUE_LIMIT,
  WORKBENCH_QUEUED_MESSAGE_PREFIX,
  WORKBENCH_REJECTION_REASON,
  WORKBENCH_RELAY_ENTRY,
  WORKBENCH_REQUEST_OWNER_ACT_TOOL,
  WORKBENCH_SESSION_PREFIX,
  type WorkbenchConfiguration,
  workbenchConfigurationSchema,
  WorkbenchErrorCode,
  workbenchGuestScopeText,
  workbenchOperations,
  WorkbenchRecordKind,
  type WorkbenchSession,
  type WorkbenchSessionGet,
} from "./contract.ts";
import { missionOperations } from "../mission/contract.ts";
import type { ScopedInput } from "../kernel/project-scope.ts";
import {
  type OwnerActCall,
  OwnerActDrop,
  ownerActRefusal,
  requestInputSchema,
  requestOwnerActTool,
  type ScopeRequest,
  ScopeRequests,
} from "./scope-requests.ts";
import {
  authorMark,
  type DeclarationOf,
  forkMaterial,
  guestMentionNames,
  lastAnswerer,
  lastTurnEntry,
  type MentionMatch,
  type MentionTarget,
  mergeEntries,
  type MergeMember,
  parseCursor,
  type RelayMember,
  relayText,
  resolveGuestMention,
  resolveMention,
  validateGuestMention,
  validateMention,
  variantNotFound,
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
  grantableOperations,
  grantCovers,
  type GrantedCall,
  GuardAction,
  type GuardClassifier,
  guardDecision,
  type GuardDecision,
  type GuardRun,
  HUMAN_ONLY_OPERATIONS,
  liveGrant,
} from "./guard.ts";
import {
  EVIDENCE_ASSET_MISMATCH,
  EVIDENCE_READ_TOOL,
  EVIDENCE_SHARED_CONVERSATION,
  evidenceFacts,
  evidenceReadTool,
} from "./evidence.ts";
import type { WorkbenchConfig } from "./config.ts";
import { type FeedState, GuestFeed } from "./guest-feed.ts";
import { projectEntries } from "./guest-view.ts";
import type { CreatedInvite, LiveInvite, WorkbenchInvites } from "./invites.ts";
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
  fullInput,
  type InvokeOperation,
  operationTool,
  type ToolCaller,
  toolName,
  toolOperations,
} from "./tools.ts";
import {
  actionSettled,
  appendForkOpening,
  appendOpening,
  appendRecord,
  createSession,
  existingVariantPlaces,
  findSession,
  forkedFrom,
  forkSourceTitle,
  hostIdOf,
  lastModel,
  lastThinkingLevel,
  listSessions,
  recordOf,
  removeEmptyVariantDirectory,
  resumeCommand,
  type SessionPlace,
  sessionPlace,
  storedAutoMode,
  storedConfiguration,
  variantSessionPlace,
} from "./sessions.ts";
import {
  createdNodeIds,
  noticeSummary,
  openWatch,
  pendingNotice,
  WatchChecker,
} from "./watch.ts";

export type WorkbenchModelRuntimeFactory = (
  input: ModelConnectorInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export interface GuestTokenRequest {
  guestId: string;
  name: string;
  inviteId: string;
  expiresAt: number;
}

interface ApprovalDecision {
  toolCallId: string;
  approved: boolean;
  nodeName?: string | undefined;
}

interface InviteBody {
  invitee_name: string;
  project_ids: string[];
  granted_operations: string[];
}

const SCOPE_REQUEST_APPROVED = "approved";
const SCOPE_REQUEST_REJECTED = "rejected";
const SCOPE_REQUEST_INDETERMINATE = "indeterminate";
const SCOPE_REQUEST_FAILED = "workbench.scope_request.failed";

interface ScopeRequestAnswer {
  request_id: string;
  outcome: ActionOutcome;
  error_code: string | null;
}

interface ScopeRequestSettled {
  decision: string;
  typedName: string | null;
  code: string | null;
}

interface ScopeRequestDone {
  result: OperationResult<unknown>;
  typedName: string;
}

interface RunningScopeRequest {
  request: ScopeRequest;
  body: ScopeRequestApproveBody;
}

interface ScopeRequestApproveBody {
  project_name: string;
  expected: Record<string, number | string>;
}

interface ScopeRequestApproval {
  sessionId: string;
  requestId: string;
  body: ScopeRequestApproveBody;
}

interface JoinBody {
  invite_token: string;
  name: string;
}

export interface Dependencies {
  store: Store;
  invites: WorkbenchInvites;
  declarationOf: DeclarationOf;
  projectScope: ProjectScope;
  projectLookup: ProjectLookup;
  watchNow?: () => number;
  projectNames(ids: readonly string[]): ReadonlyMap<string, string>;
  signGuestToken: (guest: GuestTokenRequest) => Promise<{ token: string }>;
  config: WorkbenchConfig;
  logger: Logger;
  stateDirectory: string;
  hostHome?: string;
  agentVariant: (tx: Transaction, variantId: string) => AgentVariant | null;
  agentVariants: (tx: Transaction) => readonly AgentVariantItem[];
  agentPrompt: {
    compose(
      agentName: string,
      options: ComposeOptions,
    ): Promise<PromptPartAnswer[]>;
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

interface BlockedCall {
  call: ToolCallEvent;
  operation: Operation;
}

interface ScopeRaise {
  hostId: string;
  inviteId: string;
  guestName: string;
  agentName: string;
  operation: Operation;
  input: Record<string, unknown>;
}

interface DroppedRaise {
  hostId: string;
  inviteId: string;
  operationId: string;
}

interface GrantTicket {
  session_id: string;
  invite_id: string;
  operation_id: string;
}

interface OpenSession {
  id: string;
  hostId: string | null;
  members: OpenSession[];
  agentName: string;
  variantId: string | null;
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
  approvals: Map<string, Approval>;
  approvers: Map<string, HumanIdentity>;
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

type PendingApprovalRequest = Omit<
  PendingApproval,
  "session_id" | "requested_by"
>;

interface Approval {
  approval: PendingApproval;
  decide: (decision: ToolDecision) => void;
}

interface PendingMessage extends QueuedMessage {
  requester: HumanIdentity;
  origin: Author;
  invite_id: string | null;
}

interface EnqueueItem {
  text: string;
  requester: HumanIdentity;
  origin: Author;
  invite_id: string | null;
}

function queuedTarget(item: PendingMessage): MentionTarget | null {
  return item.agent_name === null
    ? null
    : { agent_name: item.agent_name, variant_id: item.variant_id };
}

function queuedView({
  id,
  text,
  agent_name,
  variant_id,
  display_name,
}: PendingMessage): QueuedMessage {
  return { id, text, agent_name, variant_id, display_name };
}

interface LaunchItem {
  text: string;
  requester: HumanIdentity;
  origin: Author;
  invite_id: string | null;
  mention: MentionTarget | null;
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

interface ScopeStop {
  tool_call_id: string;
  operation_id: string;
}

interface Run {
  request: string;
  origin: Author | null;
  inviteId: string | null;
  memberId: string | null;
  settle: () => void;
  stopped: boolean;
  firstEntry: number;
  ended: boolean;
  endingCall: string | null;
  scopeStop: ScopeStop | null;
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
const EVIDENCE_SHARED_TEXT = `${EVIDENCE_SHARED_CONVERSATION}: The conversation has a live invite. The owner unblocks a node with the typed name of the node.`;
const INVITE_ENDED_CODE = "gateway.jwt.invite_ended";
const STREAM_HEADERS = {
  "Content-Type": MediaType.EventStream,
  "Cache-Control": "no-store",
};
const NO_CHARACTERS = 0;
const NO_ITEMS = 0;
const OWNER_NAME_MAX_LENGTH = WORKBENCH_INVITE_NAME_MAX_LENGTH;
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

function evidenceRequest(
  call: ToolCallEvent,
  facts: Awaited<ReturnType<typeof evidenceFacts>>,
  shared: boolean,
): PendingApprovalRequest {
  const { offset, length } = call.input as {
    offset?: number;
    length?: number;
  };
  return {
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
      ...(shared ? { shared: true } : {}),
    },
    guard: null,
  };
}

function approvalNotFound(
  sessionId: string,
  toolCallId: string,
): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkbenchErrorCode.ApprovalNotFound,
    "The workbench session holds no pending call with this identity.",
    { session_id: sessionId, tool_call_id: toolCallId },
  );
}

function guestOf(caller: CallerContext): GuestIdentity {
  assert.ok(isGuestIdentity(caller.identity));
  return caller.identity;
}

function inviteEnded(): OperationError {
  return new OperationError(
    HttpStatus.Unauthorized,
    INVITE_ENDED_CODE,
    "The invite of the guest token ended.",
  );
}

function inviteNotFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkbenchErrorCode.InviteNotFound,
    "Workbench invite not found.",
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

function grantedView(agentName: string, stored: readonly string[]) {
  const grantable = grantableOperations(agentName);
  return [...liveGrant(stored, agentName)].map((operationId) => ({
    operation_id: operationId,
    guard_class: grantable.get(operationId)!,
  }));
}

type VariantOwned = { variant_id: string | null };
type ListedSession = VariantOwned & { agent_name: string };

function displayNameOf(agentName: string): string {
  const declaration = getAgentDeclaration(agentName);
  assert.ok(declaration);
  return declaration.display_name;
}

function scopeRequestError(
  status: number,
  code: string,
  message: string,
): OperationError {
  return new OperationError(status, code, message);
}

function scopeRequestNotFound(): OperationError {
  return scopeRequestError(
    HttpStatus.NotFound,
    WorkbenchErrorCode.ScopeRequestNotFound,
    "The workbench conversation holds no such request.",
  );
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
  variantId: string | null;
  place: SessionPlace;
  manager: SessionManager;
}

interface SessionFields {
  id: string;
  hostId: string | null;
  agentName: string;
  variantId: string | null;
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
    approvals: new Map(),
    approvers: new Map(),
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
  private readonly feeds = new Map<string, GuestFeed>();
  private readonly grantTickets = new Map<string, GrantTicket>();
  private readonly scopeRequests = new ScopeRequests(() => Date.now());
  private readonly loading = new Map<string, Promise<OpenSession>>();
  private readonly shutdown = new CancellationContext();
  private readonly watch: WatchChecker;
  private started = false;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.watch = new WatchChecker({
      invoke: dependencies.invoke,
      projectOf: (prefix, id) =>
        dependencies.projectLookup.projectOf(prefix, id),
      projectNames: (ids) => dependencies.projectNames(ids),
      now: dependencies.watchNow,
    });
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
    const scope = this.scopeOf(session);
    return {
      agentName: session.agentName,
      ...(scope === null
        ? {}
        : {
            guest: {
              scope,
              resolver: this.dependencies.projectScope,
              covers: (call) => this.runGrantCovers(host, call),
            },
          }),
      request: host.run.request,
      autoMode: () => host.autoMode,
      classifier: () => this.guardClassifier(session, signal),
    };
  }

  private endRunAtScope(run: Run, stop: ScopeStop): boolean {
    if (run.scopeStop !== null) return false;
    run.endingCall = stop.tool_call_id;
    run.scopeStop = stop;
    return true;
  }

  private endsRun(
    session: OpenSession,
    reason: string,
    blocked: BlockedCall,
  ): boolean {
    const { call, operation } = blocked;
    const { run } = this.hostOf(session);
    if (
      !operation.mutation ||
      reason !== WORKBENCH_PROJECT_SCOPE_TEXT ||
      run?.origin?.kind !== AuthorKind.Guest
    )
      return false;
    this.endRunAtScope(run, {
      tool_call_id: call.toolCallId,
      operation_id: operation.id,
    });
    return true;
  }

  private requestOwnerAct(
    session: OpenSession,
    toolCallId: string,
    call: OwnerActCall,
  ): void {
    const host = this.hostOf(session);
    const { run } = host;
    assert.ok(run?.origin?.kind === AuthorKind.Guest && run.inviteId !== null);
    const operation = this.dependencies
      .operations()
      .find(
        ({ id }) =>
          id === call.operationId || toolName(id) === call.operationId,
      );
    const operationId = operation?.id ?? call.operationId;
    const stopped = this.endRunAtScope(run, {
      tool_call_id: toolCallId,
      operation_id: operationId,
    });
    const { inviteId } = run;
    const refusal = ownerActRefusal(stopped, call, operation);
    if (refusal !== null) {
      this.logDroppedRaise({ hostId: host.id, inviteId, operationId }, refusal);
      return;
    }
    assert.ok(operation && call.input !== null);
    const raise = {
      hostId: host.id,
      inviteId,
      guestName: run.origin.name,
      agentName: session.agentName,
      operation,
      input: call.input,
    };
    setImmediate(() => {
      try {
        this.raiseScopeRequest(raise);
      } catch (error) {
        this.dependencies.logger.error(
          { err: error },
          "workbench.scope_request.raise_failed",
        );
      }
    });
  }

  private logDroppedRaise(dropped: DroppedRaise, reason: OwnerActDrop): void {
    this.dependencies.logger.warn(
      {
        conversation_id: dropped.hostId,
        invite_id: dropped.inviteId,
        operation_id: dropped.operationId,
        reason,
      },
      "workbench.scope_request.dropped",
    );
  }

  private raiseScopeRequest(raise: ScopeRaise): void {
    const { operation } = raise;
    const dropped = (reason: OwnerActDrop) =>
      this.logDroppedRaise(
        {
          hostId: raise.hostId,
          inviteId: raise.inviteId,
          operationId: operation.id,
        },
        reason,
      );
    const row = this.dependencies.invites.resolve(raise.inviteId);
    if (row === null || row.session_id !== raise.hostId)
      return dropped(OwnerActDrop.NoRaise);
    const parsed = requestInputSchema(operation).safeParse(
      fullInput(operation, raise.input),
    );
    if (!parsed.success) return dropped(OwnerActDrop.InputParseFailure);
    const scope = new Set(row.project_ids);
    const { projects } = this.dependencies.projectScope.resolve(operation, {
      input: parsed.data as ScopedInput,
      scope,
    });
    const raised = this.scopeRequests.raise({
      sessionId: raise.hostId,
      inviteId: raise.inviteId,
      inviteExpiresAt: row.expires_at,
      guestName: raise.guestName,
      agentName: raise.agentName,
      operation,
      input: parsed.data,
      projects,
      scope,
    });
    if (!raised) return dropped(OwnerActDrop.NoRaise);
    const host = this.sessions.get(raise.hostId);
    if (host) this.notifyOwners(host);
  }

  private applyRunTools(member: OpenSession, guestRun: boolean): void {
    const { agent } = member;
    assert.ok(agent);
    const kept = agent
      .getActiveToolNames()
      .filter((name) => name !== WORKBENCH_REQUEST_OWNER_ACT_TOOL);
    agent.setActiveToolsByName(
      guestRun ? [...kept, WORKBENCH_REQUEST_OWNER_ACT_TOOL] : kept,
    );
  }

  private runGrantCovers(host: OpenSession, call: GrantedCall): boolean {
    const inviteId = host.run?.inviteId ?? null;
    if (inviteId === null) return false;
    const row = this.dependencies.invites.resolve(inviteId);
    return (
      row !== null &&
      grantCovers(liveGrant(row.granted_operations, host.agentName), call)
    );
  }

  private storeGrantTicket(
    session: OpenSession,
    call: ToolCallEvent,
    operation: Operation,
  ) {
    const host = this.hostOf(session);
    const inviteId = host.run?.inviteId ?? null;
    if (host.run?.origin?.kind !== AuthorKind.Guest || inviteId === null)
      return undefined;
    this.grantTickets.set(`${host.id}:${call.toolCallId}`, {
      session_id: host.id,
      invite_id: inviteId,
      operation_id: operation.id,
    });
    return { invite_id: inviteId, author: this.requestedBy(session) };
  }

  private dropGrantTickets(host: OpenSession): void {
    for (const [key, ticket] of this.grantTickets)
      if (ticket.session_id === host.id) this.grantTickets.delete(key);
  }

  claimGrant(claim: GrantClaim): GrantedInvite | null {
    const key = `${claim.sessionId}:${claim.toolCallId}`;
    const ticket = this.grantTickets.get(key);
    this.grantTickets.delete(key);
    if (
      !ticket ||
      ticket.session_id !== claim.sessionId ||
      ticket.invite_id !== claim.inviteId ||
      ticket.operation_id !== claim.operationId
    )
      return null;
    const row = this.dependencies.invites.resolve(claim.inviteId);
    const host = this.sessions.get(claim.sessionId);
    if (!row || row.session_id !== claim.sessionId || !host?.autoMode)
      return null;
    const covered = grantCovers(
      liveGrant(row.granted_operations, host.agentName),
      {
        operationId: claim.operationId,
        input: claim.input,
      },
    );
    return covered
      ? { invitedBy: row.invited_by, projectIds: row.project_ids }
      : null;
  }

  private guardOutcome(
    session: OpenSession,
    decision: GuardDecision,
    options: GuardOutcomeOptions,
  ): ToolDecision | Promise<ToolDecision> {
    const { call, operation, input, signal } = options;
    if (decision.action === GuardAction.Run) return ALLOWED;
    if (decision.action === GuardAction.Block)
      return {
        allowed: false,
        reason: decision.reason,
        terminate: this.endsRun(session, decision.reason, { call, operation }),
      };
    if (decision.action === GuardAction.Auto) {
      const grant = this.storeGrantTicket(session, call, operation);
      appendRecord(session.manager, {
        kind: WorkbenchRecordKind.Guard,
        tool_call_id: call.toolCallId,
        operation_id: operation.id,
        reason: decision.reason,
        ...(grant ? { grant } : {}),
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
      variantId: found.variantId,
      place: found.place,
      manager: found.manager,
      configuration: parsed.data,
      requester: undefined,
      autoMode: storedAutoMode(entries),
    });
  }

  private async storedSessions() {
    const stored = [];
    for (const agentName of workbenchAgentNames()) {
      stored.push(
        ...(await listSessions(
          sessionPlace(this.dependencies.stateDirectory, agentName),
          { agentName, variantId: null },
        )),
      );
      for (const { variantId, place } of existingVariantPlaces(
        this.dependencies.stateDirectory,
        agentName,
      ))
        stored.push(...(await listSessions(place, { agentName, variantId })));
    }
    return stored;
  }

  private async participantsOf(host: OpenSession): Promise<OpenSession[]> {
    const participants: { created: number; session: OpenSession }[] = [];
    for (const {
      id,
      created,
      host_session_id,
    } of await this.storedSessions()) {
      if (host_session_id !== host.id) continue;
      const found = await findSession(this.dependencies.stateDirectory, id);
      assert.ok(found);
      participants.push({ created, session: this.stored(found, host.id) });
    }
    return participants
      .sort((left, right) => left.created - right.created)
      .map(({ session }) => session);
  }

  private watchCreated(
    session: OpenSession,
    operationId: string,
    data: unknown,
  ): void {
    const nodeIds = createdNodeIds(operationId, data);
    if (nodeIds.length === NO_ITEMS) return;
    appendRecord(this.hostOf(session).manager, {
      kind: WorkbenchRecordKind.Watch,
      node_ids: nodeIds,
    });
  }

  private watchOpen(host: OpenSession): boolean {
    return openWatch(this.entries(host.manager)).nodeIds.length > NO_ITEMS;
  }

  private async runWatch(
    host: OpenSession,
    caller: CallerContext,
  ): Promise<void> {
    if (isReadOnlyIdentity(caller.identity)) return;
    try {
      await this.watch.check(
        {
          id: host.id,
          entries: () => this.entries(host.manager),
          append: (record) => {
            appendRecord(host.manager, record);
            this.notify(host);
          },
        },
        { identity: humanOf(caller), context: caller.context },
      );
    } catch (error) {
      this.dependencies.logger.warn(
        { conversation_id: host.id, err: error },
        "workbench.watch.check_failed",
      );
    }
  }

  private async noticeOf(
    sessionId: string,
    caller: CallerContext,
  ): Promise<string | null> {
    const host = await this.loadedHost(sessionId);
    if (host === null) return null;
    if (this.watchOpen(host)) await this.runWatch(host, caller);
    const record = pendingNotice(
      host.members.flatMap((member) =>
        member.manager.getEntries().map((entry) => ({
          ...entry,
          session_id: member.id,
          agent_name: member.agentName,
        })),
      ),
    );
    return record === null ? null : noticeSummary(record);
  }

  private async loadedHost(sessionId: string): Promise<OpenSession | null> {
    try {
      return await this.session(sessionId);
    } catch (error) {
      if (error instanceof OperationError) return null;
      throw error;
    }
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

  private variantRowOf(variantId: string): AgentVariant {
    const row = this.dependencies.store.transaction((tx) =>
      this.dependencies.agentVariant(tx, variantId),
    );
    if (row === null) throw variantNotFound(variantId);
    return row;
  }

  private findVariantRow(variantId: string): AgentVariant | null {
    return this.dependencies.store.transaction((tx) =>
      this.dependencies.agentVariant(tx, variantId),
    );
  }

  private promptVariantOf(session: OpenSession): PromptVariant | null {
    if (session.variantId === null) return null;
    const { display_name, instruction } = this.variantRowOf(session.variantId);
    return { display_name, instruction };
  }

  private displayNameOfSession(session: OpenSession): string {
    const row =
      session.variantId === null
        ? null
        : this.findVariantRow(session.variantId);
    return row?.display_name ?? displayNameOf(session.agentName);
  }

  private async greeting(
    session: OpenSession,
    context: Context,
  ): Promise<string> {
    return renderTemplate(
      await this.dependencies.agentPrompt.templates(context),
      PromptTemplate.Greeting,
      {
        display_name: this.displayNameOfSession(session),
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
        { context, variant: this.promptVariantOf(session) },
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
        return operationTool(operation, this.dependencies.invoke, {
          callerOf: (toolCallId) => this.callerOf(session, toolCallId),
          scopeOf: () => this.scopeOf(session),
          projectScope: this.dependencies.projectScope,
          completed: (operationId, data) =>
            this.watchCreated(session, operationId, data),
        });
      });
      const offer = isPhase
        ? []
        : [
            offerActionTool({
              operations: this.dependencies.operations(),
              invoke: this.dependencies.invoke,
              requester: () => session.requester,
              guestRun: () =>
                this.hostOf(session).run?.origin?.kind === AuthorKind.Guest,
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
      const request = isPhase
        ? []
        : [
            requestOwnerActTool((toolCallId, call) =>
              this.requestOwnerAct(session, toolCallId, call),
            ),
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
                  has: (nodeId) => this.granted(session, nodeId),
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
          ...request.map((tool) => tool.name),
          ...evidence.map((tool) => tool.name),
        ],
        customTools: [
          ...builtin.customTools,
          ...operations,
          ...offer,
          ...request,
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
    const host = this.hostOf(session);
    const guestBlock = this.guestEvidenceBlock(host);
    if (guestBlock) return guestBlock;
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
    const shared = this.dependencies.invites.isShared(host.id);
    if (this.granted(session, facts.node_id)) return ALLOWED;
    const decision = await this.approval(
      session,
      evidenceRequest(call, facts, shared),
      options.signal,
    );
    if (!decision.allowed) return decision;
    session.approvers.delete(call.toolCallId);
    if (!shared && this.dependencies.invites.isShared(host.id))
      return { allowed: false, reason: EVIDENCE_SHARED_TEXT, terminate: false };
    host.evidenceGrants.add(facts.node_id);
    return decision;
  }

  private guestEvidenceBlock(host: OpenSession): ToolDecision | null {
    if (host.run?.origin?.kind !== AuthorKind.Guest) return null;
    return {
      allowed: false,
      reason: workbenchGuestScopeText(EVIDENCE_READ_TOOL),
      terminate: false,
    };
  }

  private granted(session: OpenSession, nodeId: string): boolean {
    const host = this.hostOf(session);
    if (host.evidenceGrants.has(nodeId)) return true;
    return (
      !this.dependencies.invites.isShared(host.id) &&
      this.messageGrants(session, nodeId)
    );
  }

  private messageGrants(session: OpenSession, nodeId: string): boolean {
    const host = this.hostOf(session);
    return host.autoMode && !!host.run?.request.includes(nodeId);
  }

  private requestedBy(session: OpenSession): Author {
    const origin = this.hostOf(session).run?.origin;
    assert.ok(origin, "An approval card belongs to a run with an origin.");
    return { kind: origin.kind, name: origin.name };
  }

  private callerOf(session: OpenSession, toolCallId: string): ToolCaller {
    const host = this.hostOf(session);
    if (this.grantTickets.has(`${host.id}:${toolCallId}`))
      return {
        identity: session.requester,
        grant: { sessionId: host.id, toolCallId },
      };
    const approver = session.approvers.get(toolCallId);
    session.approvers.delete(toolCallId);
    return { identity: approver ?? session.requester };
  }

  private scopeOf(session: OpenSession): ReadonlySet<string> | null {
    const { run } = this.hostOf(session);
    const ids = run === null ? null : this.runScope(run);
    return ids === null ? null : new Set(ids);
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
      if (result.allowed && result.approver)
        session.approvers.set(approval.tool_call_id, result.approver);
      decision.resolve(result);
      this.notify(session);
    };
    signal?.addEventListener("abort", reject, { once: true });
    session.approvals.set(approval.tool_call_id, {
      approval: {
        ...approval,
        session_id: session.id,
        requested_by: this.requestedBy(session),
      },
      decide,
    });
    this.notify(session);
    return decision.promise;
  }

  private rejectApprovals(session: OpenSession): void {
    for (const { decide } of [...session.approvals.values()]) decide(REJECTED);
  }

  private async requireNodeName(
    caller: CallerContext,
    pending: Approval,
    nodeName: string | undefined,
  ): Promise<void> {
    const nodeId = pending.approval.input.node_id;
    assert.ok(isString(nodeId), "A shared evidence card names its node.");
    const result = await this.dependencies.invoke(
      missionOperations["node.get"],
      { params: { node_id: nodeId }, query: {}, body: null },
      { identity: caller.identity, context: caller.context },
    );
    if (result.type === OperationResultType.Failure)
      throw new OperationError(
        result.status,
        result.error.error.code,
        result.error.error.message,
      );
    assert.ok(result.type === OperationResultType.Completed);
    const node = missionOperations["node.get"].output.parse(result.data);
    if (nodeName === node.content.name) return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkbenchErrorCode.EvidenceNameMismatch,
      "The typed name differs from the name of the node.",
      {
        session_id: pending.approval.session_id,
        tool_call_id: pending.approval.tool_call_id,
      },
    );
  }

  async approve(
    caller: CallerContext,
    sessionId: string,
    decision: ApprovalDecision,
  ): Promise<{ session_id: string; tool_call_id: string; approved: boolean }> {
    const { toolCallId, approved, nodeName } = decision;
    const pending = this.sessions.get(sessionId)?.approvals.get(toolCallId);
    if (!pending) throw approvalNotFound(sessionId, toolCallId);
    if (approved && pending.approval.input.shared === true) {
      await this.requireNodeName(caller, pending, nodeName);
      if (this.sessions.get(sessionId)?.approvals.get(toolCallId) !== pending)
        throw approvalNotFound(sessionId, toolCallId);
    }
    pending.decide(
      approved ? { allowed: true, approver: humanOf(caller) } : REJECTED,
    );
    return { session_id: sessionId, tool_call_id: toolCallId, approved };
  }

  private scopeRequestViews(host: OpenSession): ScopeRequestView[] {
    const names = new Map(
      this.dependencies.invites
        .list(host.id)
        .map(({ id, invitee_name: name }) => [id, name]),
    );
    const descriptions = new Map(
      this.dependencies
        .operations()
        .map(({ id, description }) => [id, description]),
    );
    return this.scopeRequests.open(host.id).map((request) => ({
      id: request.id,
      invite_id: request.inviteId,
      invitee_name: names.get(request.inviteId) ?? request.guestName,
      guest_name: request.guestName,
      agent_name: request.agentName,
      operation_id: request.operationId,
      description: descriptions.get(request.operationId) ?? "",
      input: request.input,
      target_id: request.targetId,
      ids: [...request.ids],
      project_id: request.projectId,
      expected_keys: [...request.expectedKeys],
      created_at: request.createdAt,
      expires_at: request.expiresAt,
      state: request.state,
      error_code: request.error,
    }));
  }

  private logScopeRequest(
    host: OpenSession,
    request: ScopeRequest,
    settled: ScopeRequestSettled,
  ): void {
    this.dependencies.logger.info(
      {
        conversation_id: host.id,
        request_id: request.id,
        invite_id: request.inviteId,
        guest_name: request.guestName,
        operation_id: request.operationId,
        target_id: request.targetId,
        project_id: request.projectId,
        typed_name: settled.typedName,
        decision: settled.decision,
        outcome_code: settled.code,
      },
      "workbench.scope_request.settled",
    );
  }

  private async projectNameOf(
    caller: CallerContext,
    projectId: string,
  ): Promise<string> {
    const result = await this.dependencies.invoke(
      projectOperations.get,
      { params: { project_id: projectId }, query: {}, body: null },
      { identity: caller.identity, context: caller.context },
    );
    if (result.type === OperationResultType.Failure)
      throw new OperationError(
        result.status,
        result.error.error.code,
        result.error.error.message,
      );
    assert.ok(result.type === OperationResultType.Completed);
    return projectOperations.get.output.parse(result.data).name;
  }

  private scopeRequestOperation(
    request: ScopeRequest,
    row: LiveInvite,
  ): Operation | null {
    const operation = this.dependencies
      .operations()
      .find(({ id }) => id === request.operationId);
    if (!operation || HUMAN_ONLY_OPERATIONS.has(operation.id)) return null;
    const grantable = new Set(grantableOperations(request.agentName).keys());
    const covered = grantCovers(grantable, {
      operationId: operation.id,
      input: request.input,
    });
    const scope = new Set(row.project_ids);
    const { projects } = this.dependencies.projectScope.resolve(operation, {
      input: request.input as ScopedInput,
      scope,
    });
    const owners = [...projects.values()];
    const held =
      owners.length > NO_CHARACTERS &&
      owners.every((owner) => owner === request.projectId) &&
      !scope.has(request.projectId);
    return covered && held ? operation : null;
  }

  private mergedScopeInput(
    operation: Operation,
    request: ScopeRequest,
    expected: Record<string, number | string>,
  ): ScopedInput {
    const stored = request.input as ScopedInput;
    const merged = isObject(stored.body)
      ? { ...stored, body: { ...stored.body, ...expected } }
      : stored;
    const parsed = operation.input.safeParse(merged);
    if (!parsed.success)
      throw scopeRequestError(
        HttpStatus.BadRequest,
        WorkbenchErrorCode.ScopeRequestExpectedInvalid,
        "The values do not fit the input of the act.",
      );
    return parsed.data as ScopedInput;
  }

  private async runScopeRequest(
    caller: CallerContext,
    host: OpenSession,
    approval: RunningScopeRequest,
  ): Promise<ScopeRequestAnswer> {
    const { request, body } = approval;
    const row = this.dependencies.invites.resolve(request.inviteId);
    if (row === null || row.session_id !== host.id) {
      this.scopeRequests.settle(request);
      throw scopeRequestNotFound();
    }
    const name = await this.projectNameOf(caller, request.projectId).catch(
      (error: unknown) => {
        if (
          !(error instanceof OperationError) ||
          error.code !== ProjectErrorCode.ProjectNotFound
        )
          throw error;
        this.scopeRequests.settle(request);
        throw scopeRequestError(
          HttpStatus.Conflict,
          WorkbenchErrorCode.ScopeRequestRefused,
          "The act is no longer open to the owner as an out-of-scope request.",
        );
      },
    );
    if (body.project_name !== name)
      throw scopeRequestError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.ScopeRequestNameMismatch,
        "The typed name differs from the name of the project.",
      );
    const keys = Object.keys(body.expected).sort();
    if (keys.join() !== request.expectedKeys.join())
      throw scopeRequestError(
        HttpStatus.BadRequest,
        WorkbenchErrorCode.ScopeRequestExpectedInvalid,
        "The expected values name the concurrency keys of the act.",
      );
    const operation = this.scopeRequestOperation(request, row);
    if (operation === null) {
      this.scopeRequests.settle(request);
      throw scopeRequestError(
        HttpStatus.Conflict,
        WorkbenchErrorCode.ScopeRequestRefused,
        "The act is no longer open to the owner as an out-of-scope request.",
      );
    }
    const input = this.mergedScopeInput(operation, request, body.expected);
    const result = await this.dependencies.invoke(operation, input, {
      identity: caller.identity,
      context: caller.context,
      idempotencyKey: createIdempotencyKey(),
    });
    return this.settledScopeRequest(host, request, {
      result,
      typedName: body.project_name,
    });
  }

  private settledScopeRequest(
    host: OpenSession,
    request: ScopeRequest,
    done: ScopeRequestDone,
  ): ScopeRequestAnswer {
    const { result, typedName } = done;
    if (result.type === OperationResultType.Completed) {
      this.scopeRequests.settle(request);
      this.logScopeRequest(host, request, {
        decision: SCOPE_REQUEST_APPROVED,
        typedName,
        code: null,
      });
      return {
        request_id: request.id,
        outcome: ActionOutcome.Done,
        error_code: null,
      };
    }
    const code =
      result.type === OperationResultType.Failure
        ? result.error.error.code
        : SCOPE_REQUEST_INDETERMINATE;
    if (result.type === OperationResultType.Failure)
      this.scopeRequests.release(request, code);
    else this.scopeRequests.settle(request);
    this.logScopeRequest(host, request, {
      decision: SCOPE_REQUEST_APPROVED,
      typedName,
      code,
    });
    return {
      request_id: request.id,
      outcome: ActionOutcome.Failed,
      error_code: code,
    };
  }

  async scopeRequestApprove(
    caller: CallerContext,
    approval: ScopeRequestApproval,
  ): Promise<ScopeRequestAnswer> {
    const host = await this.session(approval.sessionId);
    this.requireHost(host);
    const request = this.scopeRequests.claim(host.id, approval.requestId);
    if (!request) throw scopeRequestNotFound();
    this.notifyOwners(host);
    try {
      return await this.runScopeRequest(caller, host, {
        request,
        body: approval.body,
      });
    } catch (error) {
      this.scopeRequests.release(
        request,
        error instanceof OperationError ? error.code : SCOPE_REQUEST_FAILED,
      );
      throw error;
    } finally {
      this.notifyOwners(host);
    }
  }

  async scopeRequestReject(sessionId: string, requestId: string) {
    const host = await this.session(sessionId);
    this.requireHost(host);
    const request = this.scopeRequests.reject(host.id, requestId);
    if (!request) throw scopeRequestNotFound();
    this.logScopeRequest(host, request, {
      decision: SCOPE_REQUEST_REJECTED,
      typedName: null,
      code: null,
    });
    this.notifyOwners(host);
    return { request_id: request.id };
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
      display_name: this.displayNameOfSession(member),
    }));
  }

  private async view(session: OpenSession): Promise<WorkbenchSession> {
    return {
      id: session.id,
      agent_name: session.agentName,
      variant_id: session.variantId,
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
    if (this.shutdown.signal.aborted) return;
    this.feedOf(this.hostOf(session)).notify();
  }

  private notifyOwners(session: OpenSession): void {
    if (this.shutdown.signal.aborted) return;
    this.feedOf(this.hostOf(session)).wakeOwners();
  }

  private feedOf(host: OpenSession): GuestFeed {
    const existing = this.feeds.get(host.id);
    if (existing) return existing;
    const feed = new GuestFeed({
      entries: (after) =>
        mergeEntries(
          this.memberEntries(host, false),
          parseCursor(after, host.id),
        ),
      state: () => this.feedState(host),
    });
    this.feeds.set(host.id, feed);
    return feed;
  }

  private feedState(host: OpenSession): FeedState {
    const active = this.runActive(host);
    const running = this.runningMember(host);
    const streaming = running.agent?.state.streamingMessage;
    const waiting = this.pendingApprovalOf(host);
    return {
      run_active: active,
      display_name: active ? this.displayNameOfSession(running) : null,
      auto_mode: host.autoMode,
      streaming:
        streaming === undefined ? null : JSON.parse(JSON.stringify(streaming)),
      waiting_for_approval:
        waiting && host.run?.origin?.kind === AuthorKind.Guest
          ? { operation_id: waiting.operation_id }
          : null,
      queue: this.queuedViews(host.queuedMessages).map((view, index) => ({
        id: view.id,
        agent_name: view.agent_name,
        display_name: view.display_name,
        author_name: host.queuedMessages[index]!.origin.name,
      })),
    };
  }

  private queuedViews(items: readonly PendingMessage[]): QueuedMessage[] {
    const names = this.variantNamesOf(items);
    return items.map((item) => ({
      ...queuedView(item),
      display_name:
        (item.variant_id === null ? undefined : names.get(item.variant_id)) ??
        item.display_name,
    }));
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
      queue: this.queuedViews(session.queuedMessages),
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
      scope_requests: this.scopeRequestViews(host),
      version: this.feedOf(host).version,
    };
  }

  async events(
    sessionId: string,
    after: string | undefined,
    version: number | undefined,
    caller: CallerContext,
  ): Promise<SessionEvents> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    if (this.watchOpen(session)) await this.runWatch(session, caller);
    const window = new CancellationContext(
      caller.context,
      Date.now() + WORKBENCH_EVENTS_WAIT_MS,
    );
    const unsubscribe = this.feedOf(session).subscribe(() => window.cancel());
    try {
      const current = await this.changes(session, after);
      if (current.entries.length || version !== current.version) return current;
      await cancelled(window.signal);
      await new Promise((resolve) => setImmediate(resolve));
      return await this.changes(session, after);
    } finally {
      unsubscribe();
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
      if (run.scopeStop)
        appendRecord(this.memberOfRun(session, run).manager, {
          kind: WorkbenchRecordKind.ScopeStop,
          ...run.scopeStop,
        });
      if (session.run === run) session.run = null;
      this.dropGrantTickets(session);
      completion.resolve();
      this.notify(session);
      this.startNext(session);
    };
    const run: Run = {
      request: options.request,
      origin: null,
      inviteId: null,
      memberId: null,
      settle,
      firstEntry: session.manager.getEntries().length,
      ended: false,
      endingCall: null,
      scopeStop: null,
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
    run.origin = item.origin;
    run.inviteId = item.invite_id;
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
    this.applyRunTools(member, item.origin.kind === AuthorKind.Guest);
    this.appendAuthor(member, item);
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
    this.appendAuthor(member, item);
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

  private appendAuthor(member: OpenSession, item: LaunchItem): void {
    if (item.origin.kind !== AuthorKind.Guest) return;
    appendRecord(member.manager, {
      kind: WorkbenchRecordKind.Author,
      author: { kind: item.origin.kind, name: item.origin.name },
    });
    this.notify(member);
  }

  runScope(run: Run): readonly string[] | null {
    if (run.inviteId === null) return null;
    return this.inviteProjects(run.inviteId);
  }

  private inviteProjects(inviteId: string | null): readonly string[] {
    if (inviteId === null) return [];
    return this.dependencies.invites.resolve(inviteId)?.project_ids ?? [];
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
        variantId: member.variantId,
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
      displayName: this.displayNameOfSession(member),
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
      projects: this.projectsOf(this.inviteProjects(item.invite_id)),
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
    const { mention } = item;
    if (mention === null) return this.answeredLast(host);
    const existing = host.members.find(
      ({ agentName, variantId }) =>
        agentName === mention.agent_name && variantId === mention.variant_id,
    );
    return existing ?? this.createParticipant(host, mention, item);
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

  private participantPlace(
    tx: Transaction,
    agentName: string,
    variantId: string | null,
  ): SessionPlace {
    if (variantId === null)
      return sessionPlace(this.dependencies.stateDirectory, agentName);
    const row = this.dependencies.agentVariant(tx, variantId);
    if (row?.agent_name !== agentName) throw variantNotFound(variantId);
    return variantSessionPlace(this.dependencies.stateDirectory, {
      agentName,
      variantId,
    });
  }

  private releaseVariantDirectory(agentName: string, variantId: string): void {
    if (
      [...this.sessions.values()].some((open) => open.variantId === variantId)
    )
      return;
    removeEmptyVariantDirectory(this.dependencies.stateDirectory, {
      agentName,
      variantId,
    });
  }

  private async createParticipant(
    host: OpenSession,
    mention: MentionTarget,
    item: LaunchItem,
  ): Promise<OpenSession> {
    const { agent_name: agentName, variant_id: variantId } = mention;
    const { configuration, resolved, place } =
      this.dependencies.store.transaction((tx) => {
        const view = this.dependencies.agentConfiguration.agentView(
          tx,
          agentName,
          null,
        );
        const defaults = workbenchConfigurationSchema.parse(view?.defaults);
        return {
          configuration: defaults,
          resolved: this.resolve(tx, agentName, defaults),
          place: this.participantPlace(tx, agentName, variantId),
        };
      });
    const parentSession = host.manager.getSessionFile();
    assert.ok(parentSession);
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    let participant: OpenSession | undefined;
    let built: BuiltRuntime | undefined;
    try {
      participant = newOpenSession({
        id,
        hostId: host.id,
        agentName,
        variantId,
        place,
        manager: await createSession(place, id, { parentSession }),
        configuration,
        requester: item.requester,
        autoMode: true,
      });
      this.sessions.set(id, participant);
      host.members.push(participant);
      built = await this.buildRuntime(participant, resolved, item.context);
      await this.openAgent(participant, built, item.context);
      this.syncEntries(participant, piProviderId(resolved.provider));
    } catch (error) {
      built?.lifetime.cancel();
      if (participant) {
        this.closeAgent(participant);
        this.sessions.delete(id);
        host.members.splice(host.members.indexOf(participant), 1);
        const file = participant.manager.getSessionFile();
        if (file) rmSync(file, { force: true });
      }
      if (variantId !== null)
        this.releaseVariantDirectory(agentName, variantId);
      throw error;
    }
    return participant;
  }

  private queuedRefusal(item: PendingMessage): OperationError | null {
    if (
      item.invite_id !== null &&
      this.dependencies.invites.resolve(item.invite_id) === null
    )
      return new OperationError(
        HttpStatus.Unauthorized,
        INVITE_ENDED_CODE,
        "The invite of the queued message ended.",
      );
    try {
      this.validateQueued(item);
    } catch (error) {
      if (error instanceof OperationError) return error;
      throw error;
    }
    return null;
  }

  private validateQueued(item: PendingMessage): void {
    const target = queuedTarget(item);
    if (target === null) return;
    this.dependencies.store.transaction((tx) =>
      item.invite_id === null
        ? validateMention(tx, target, this.dependencies)
        : validateGuestMention(tx, target, this.dependencies),
    );
  }

  private startNext(session: OpenSession): void {
    if (this.shutdown.signal.aborted) {
      session.queuedMessages.length = 0;
      return;
    }
    if (session.run) return;
    const item = session.queuedMessages.shift();
    if (!item) return;
    const refusal = this.queuedRefusal(item);
    if (refusal) {
      session.runError = refusal.message;
      this.notify(session);
      return this.startNext(session);
    }
    const run = this.claim(session, {
      clearError: false,
      request: item.text,
    });
    this.exclusive(session, () =>
      this.launch(session, run, {
        ...item,
        mention: queuedTarget(item),
        context: this.shutdown,
      }),
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
      origin: item.origin,
      invite_id: item.invite_id,
      agent_name: mention?.agent_name ?? null,
      variant_id: mention?.variant_id ?? null,
      display_name: mention?.display_name ?? null,
    });
    this.notify(session);
    return id;
  }

  private clearQueue(
    session: OpenSession,
    cause: QueueClearCause,
  ): QueuedMessage[] {
    const removed = session.queuedMessages.splice(NO_CHARACTERS);
    if (removed.length === NO_CHARACTERS) return [];
    appendRecord(session.manager, {
      kind: WorkbenchRecordKind.QueueClear,
      count: removed.length,
      cause,
    });
    this.notify(session);
    return this.queuedViews(
      removed.filter(({ origin }) => origin.kind === AuthorKind.Owner),
    );
  }

  private mentioned(text: string): boolean {
    return (
      this.dependencies.store.transaction((tx) =>
        resolveMention(tx, text, this.dependencies),
      ) !== null
    );
  }

  private appendNote(host: OpenSession, author: Author, text: string): void {
    appendRecord(host.manager, {
      kind: WorkbenchRecordKind.Note,
      text,
      author: { kind: author.kind, name: author.name },
    });
    this.notify(host);
  }

  async note(sessionId: string, author: Author, text: string): Promise<void> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    this.appendNote(session, author, text);
  }

  private async guestHost(guest: GuestIdentity): Promise<OpenSession> {
    const host = await this.session(guest.sessionId);
    this.requireHost(host);
    return host;
  }

  private requireLiveInvite(guest: GuestIdentity): LiveInvite {
    const invite = this.dependencies.invites.resolve(guest.inviteId);
    if (invite === null) throw inviteEnded();
    return invite;
  }

  async guestGet(guest: GuestIdentity) {
    const host = await this.guestHost(guest);
    const invite = this.requireLiveInvite(guest);
    return {
      session_id: host.id,
      title: host.manager.getSessionName() ?? null,
      members: this.conversationMembers(host),
      owner_name: invite.invited_by_name,
      projects: this.projectsOf(invite.project_ids),
      granted_operations: grantedView(
        host.agentName,
        invite.granted_operations,
      ),
      mention_names: guestMentionNames(
        this.dependencies.declarationOf,
        this.dependencies.store.transaction((tx) =>
          this.dependencies.agentVariants(tx),
        ),
      ),
      entries: projectEntries(mergeEntries(this.memberEntries(host, false))),
      run_active: this.runActive(host),
    };
  }

  async guestStream(
    guest: GuestIdentity,
    after: string | undefined,
    context: Context,
  ): Promise<Response> {
    const host = await this.guestHost(guest);
    const invite = this.requireLiveInvite(guest);
    const stream = this.feedOf(host).open({
      inviteId: guest.inviteId,
      expiresAt: invite.expires_at,
      after,
      signal: context.signal,
    });
    return new Response(stream, { headers: STREAM_HEADERS });
  }

  async guestMessage(guest: GuestIdentity, text: string, context: Context) {
    const host = await this.guestHost(guest);
    this.requireLiveInvite(guest);
    const origin = { kind: AuthorKind.Guest, name: guest.name };
    const mention = this.dependencies.store.transaction((tx) =>
      resolveGuestMention(tx, text, this.dependencies),
    );
    if (mention === null) {
      this.appendNote(host, origin, text);
      return { kind: MessageKind.Note };
    }
    const item = {
      text,
      requester: guest.reader,
      origin,
      invite_id: guest.inviteId,
    };
    const target = {
      agent_name: mention.agent_name,
      variant_id: mention.variant_id,
    };
    if (host.run) {
      const queued = this.enqueue(host, item, mention);
      this.title(host, text);
      return {
        kind: MessageKind.Run,
        agent_name: mention.agent_name,
        queued_message_id: queued,
      };
    }
    const run = this.claim(host, { clearError: true, request: text });
    try {
      await this.exclusive(host, () =>
        this.launch(host, run, { ...item, mention: target, context }),
      );
    } catch (error) {
      run.settle();
      throw error;
    }
    this.title(host, text);
    return {
      kind: MessageKind.Run,
      agent_name: this.memberOfRun(host, run).agentName,
      queued_message_id: null,
    };
  }

  async message(
    caller: CallerContext,
    sessionId: string,
    body: MessageBody,
  ): Promise<{
    session_id: string;
    agent_name: string | null;
    run_active: boolean;
    queued_message_id: string | null;
    cleared: QueuedMessage[];
    kind: MessageKind;
  }> {
    const { text, delivery } = body;
    const session = await this.session(sessionId);
    this.requireHost(session);
    const requester = humanOf(caller);
    const origin = {
      kind: AuthorKind.Owner,
      name: requester.name.slice(NO_CHARACTERS, OWNER_NAME_MAX_LENGTH),
    };
    if (
      this.dependencies.invites.isShared(session.id) &&
      !this.mentioned(text)
    ) {
      await this.note(sessionId, origin, text);
      return {
        session_id: sessionId,
        agent_name: null,
        run_active: this.runActive(session),
        queued_message_id: null,
        cleared: [],
        kind: MessageKind.Note,
      };
    }
    const mention = this.dependencies.store.transaction((tx) =>
      resolveMention(tx, text, this.dependencies),
    );
    const active = session.run;
    if (active) {
      const cleared =
        delivery === MessageDelivery.Replace
          ? this.clearQueue(session, QueueClearCause.Replace)
          : [];
      const queued = this.enqueue(
        session,
        { text, requester, origin, invite_id: null },
        mention,
      );
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
        kind: MessageKind.Run,
      };
    }
    const run = this.claim(session, { clearError: true, request: text });
    try {
      await this.exclusive(session, () =>
        this.launch(session, run, {
          text,
          requester,
          origin,
          invite_id: null,
          mention,
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
      kind: MessageKind.Run,
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
    const place = this.dependencies.store.transaction((tx) => {
      if (source.variantId === null)
        return sessionPlace(this.dependencies.stateDirectory, source.agentName);
      if (this.dependencies.agentVariant(tx, source.variantId) === null)
        throw variantNotFound(source.variantId);
      return variantSessionPlace(this.dependencies.stateDirectory, {
        agentName: source.agentName,
        variantId: source.variantId,
      });
    });
    const fork = newOpenSession({
      id,
      hostId: null,
      agentName: source.agentName,
      variantId: source.variantId,
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
      displayName: this.displayNameOfSession(
        source.members.find(({ id }) => id === member.sessionId)!,
      ),
      entries: member.entries,
    }));
    const material = forkMaterial({
      members,
      authorName: humanOf(caller).name,
      inProgress: this.runActive(source)
        ? this.inProgressOf(source.run!)
        : null,
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
    const cleared = this.clearQueue(session, QueueClearCause.Stop);
    await this.exclusive(session, () => this.stopRun(session, run));
    if (run) await run.settled;
    return { session_id: sessionId, run_active: false, cleared };
  }

  private variantNamesOf(
    sessions: readonly VariantOwned[],
  ): ReadonlyMap<string, string> {
    const ids = new Set(sessions.flatMap(({ variant_id }) => variant_id ?? []));
    return this.dependencies.store.transaction(
      (tx) =>
        new Map(
          [...ids].flatMap((id) => {
            const row = this.dependencies.agentVariant(tx, id);
            return row ? [[id, row.display_name] as const] : [];
          }),
        ),
    );
  }

  private listedDisplayName(
    item: ListedSession,
    variantNames: ReadonlyMap<string, string>,
  ): string {
    return (
      (item.variant_id === null
        ? undefined
        : variantNames.get(item.variant_id)) ?? displayNameOf(item.agent_name)
    );
  }

  async list(agentName: string | undefined, caller: CallerContext) {
    if (agentName !== undefined) requireAgent(agentName);
    const stored = await this.storedSessions();
    const variantNames = this.variantNamesOf(stored);
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
          display_name: this.listedDisplayName(participant, variantNames),
          notice: null,
          participants: [] as [],
        }));
      items.push({
        ...host,
        ...this.runState(host.id),
        scope_requests: this.scopeRequests.count(host.id),
        notice: await this.noticeOf(host.id, caller),
        display_name: this.listedDisplayName(host, variantNames),
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
    body: WorkbenchConfiguration & {
      agent_name: string;
      variant_id?: string | undefined;
    },
  ): Promise<WorkbenchSession> {
    const {
      agent_name: agentName,
      variant_id: variantId,
      ...configuration
    } = body;
    requireWorkbenchAgent(agentName);
    const { resolved, place } = this.dependencies.store.transaction((tx) => {
      if (variantId !== undefined) {
        const row = this.dependencies.agentVariant(tx, variantId);
        if (row?.agent_name !== agentName) throw variantNotFound(variantId);
      }
      return {
        resolved: this.resolve(tx, agentName, configuration),
        place:
          variantId === undefined
            ? sessionPlace(this.dependencies.stateDirectory, agentName)
            : variantSessionPlace(this.dependencies.stateDirectory, {
                agentName,
                variantId,
              }),
      };
    });
    const id = createIdentity(WORKBENCH_SESSION_PREFIX);
    let session: OpenSession | undefined;
    let built: BuiltRuntime | undefined;
    try {
      session = newOpenSession({
        id,
        hostId: null,
        agentName,
        variantId: variantId ?? null,
        place,
        manager: await createSession(place, id, {}),
        configuration,
        requester: humanOf(caller),
        autoMode: true,
      });
      session.members.push(session);
      this.sessions.set(id, session);
      built = await this.buildRuntime(session, resolved, caller.context);
      this.syncEntries(session, piProviderId(resolved.provider));
      appendOpening(session.manager, {
        model: built.model,
        greeting: await this.greeting(session, caller.context),
      });
      await this.openAgent(session, built, caller.context);
    } catch (error) {
      built?.lifetime.cancel();
      if (session) {
        this.closeAgent(session);
        this.sessions.delete(id);
        const file = session.manager.getSessionFile();
        if (file) rmSync(file, { force: true });
      }
      if (variantId !== undefined)
        this.releaseVariantDirectory(agentName, variantId);
      throw error;
    }
    return this.view(session);
  }

  async get(
    sessionId: string,
    caller: CallerContext,
  ): Promise<WorkbenchSessionGet> {
    const session = await this.session(sessionId);
    this.requireHost(session);
    if (this.watchOpen(session)) await this.runWatch(session, caller);
    return {
      ...(await this.view(session)),
      scope_requests: this.scopeRequestViews(session),
    };
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

  async inviteCreate(
    caller: CallerContext,
    sessionId: string,
    body: InviteBody,
  ): Promise<CreatedInvite> {
    const host = await this.session(sessionId);
    this.requireHost(host);
    const requester = humanOf(caller);
    const created = this.dependencies.invites.create(
      host.id,
      {
        accountId: requester.accountId,
        name: requester.name.slice(NO_CHARACTERS, OWNER_NAME_MAX_LENGTH),
      },
      {
        name: body.invitee_name,
        projectIds: body.project_ids,
        agentName: host.agentName,
        grantedOperations: body.granted_operations,
      },
    );
    host.evidenceGrants.clear();
    return created;
  }

  private inProgressOf(run: Run): string {
    return run.origin?.kind === AuthorKind.Guest
      ? `${authorMark(run.origin)}: ${run.request}`
      : run.request;
  }

  private projectsOf(ids: readonly string[]) {
    const names = this.dependencies.projectNames(ids);
    return ids.map((id) => ({ id, name: names.get(id) ?? null }));
  }

  private grantableView(agentName: string) {
    const descriptions = new Map(
      this.dependencies
        .operations()
        .map(({ id, description }) => [id, description]),
    );
    return [...grantableOperations(agentName)].map(
      ([operationId, guardClass]) => {
        const description = descriptions.get(operationId);
        assert.ok(description !== undefined, `${operationId} is registered`);
        return {
          operation_id: operationId,
          guard_class: guardClass,
          description,
        };
      },
    );
  }

  async inviteList(sessionId: string) {
    const host = await this.session(sessionId);
    this.requireHost(host);
    const live = this.dependencies.invites.list(host.id);
    return {
      items: live.map(
        ({ project_ids: ids, granted_operations: stored, ...item }) => ({
          ...item,
          projects: this.projectsOf(ids),
          granted_operations: grantedView(host.agentName, stored),
        }),
      ),
      project_ids: live[NO_CHARACTERS]?.project_ids ?? null,
      grantable: this.grantableView(host.agentName),
    };
  }

  inviteRevoke(inviteId: string): { id: string } {
    const revoked = this.dependencies.invites.revoke(inviteId);
    if (!revoked) throw inviteNotFound();
    this.scopeRequests.dropInvite(revoked.id);
    this.feeds.get(revoked.session_id)?.closeInvite(revoked.id);
    return { id: revoked.id };
  }

  async inviteJoin(body: JoinBody) {
    const joined = this.dependencies.invites.join(body.invite_token, body.name);
    if (!joined) throw inviteNotFound();
    const { token } = await this.dependencies.signGuestToken({
      guestId: joined.guest_id,
      name: joined.name,
      inviteId: joined.invite_id,
      expiresAt: joined.expires_at,
    });
    return {
      guest_token: token,
      guest_id: joined.guest_id,
      name: joined.name,
      session_id: joined.session_id,
      expires_at: joined.expires_at,
    };
  }

  declare(registry: OperationRegistry): void {
    registry.register(
      workbenchOperations["session.list"],
      ({ query }, caller) => this.list(query.agent_name, caller),
    );
    registry.register(
      workbenchOperations["session.create"],
      ({ body }, caller) => this.create(caller, body),
    );
    registry.register(
      workbenchOperations["session.get"],
      ({ params }, caller) => this.get(params.session_id, caller),
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
      ({ params, body }, caller) =>
        this.approve(caller, params.session_id, {
          toolCallId: body.tool_call_id,
          approved: body.approved,
          nodeName: body.node_name,
        }),
    );
    registry.register(
      workbenchOperations["session.scopeRequest.approve"],
      ({ params, body }, caller) =>
        this.scopeRequestApprove(caller, {
          sessionId: params.session_id,
          requestId: params.request_id,
          body,
        }),
    );
    registry.register(
      workbenchOperations["session.scopeRequest.reject"],
      ({ params }) =>
        this.scopeRequestReject(params.session_id, params.request_id),
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
      workbenchOperations["invite.create"],
      ({ params, body }, caller) =>
        this.inviteCreate(caller, params.session_id, body),
    );
    registry.register(workbenchOperations["invite.list"], ({ params }) =>
      this.inviteList(params.session_id),
    );
    registry.register(workbenchOperations["invite.revoke"], ({ params }) =>
      this.inviteRevoke(params.invite_id),
    );
    registry.register(workbenchOperations["invite.join"], ({ body }) =>
      this.inviteJoin(body),
    );
    registry.register(workbenchOperations["guest.get"], (_input, caller) =>
      this.guestGet(guestOf(caller)),
    );
    registry.register(
      workbenchOperations["guest.stream"],
      ({ query }, caller) =>
        this.guestStream(guestOf(caller), query.after, caller.context),
    );
    registry.register(
      workbenchOperations["guest.message"],
      ({ body }, caller) =>
        this.guestMessage(guestOf(caller), body.text, caller.context),
    );
    registry.register(
      workbenchOperations["session.events"],
      ({ params, query }, caller) =>
        this.events(params.session_id, query.after, query.version, caller),
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
    for (const feed of this.feeds.values()) feed.stop();
    this.feeds.clear();
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

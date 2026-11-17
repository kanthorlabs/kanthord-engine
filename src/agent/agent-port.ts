import assert from "node:assert/strict";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionRuntime,
  InlineExtension,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { CancellationContext, Context } from "../kernel/context.ts";
import { SpanStatus } from "../tracking/contract.ts";
import type { AgentSetup, ExecutionSetup } from "../worker/contract.ts";
import {
  closeRuntime,
  openSessionRuntime,
  withDeadline,
} from "./agent-session.ts";
import { isConfinedAgent } from "./catalog.ts";
import { checkoutConfinement } from "./hooks/checkout-confinement.ts";
import type {
  KnownSecrets,
  SensitiveTextRedaction,
} from "./hooks/sensitive-text-redaction.ts";
import { toolAllowlist } from "./hooks/tool-allowlist.ts";
import { loadPi, type PiCodingAgent } from "./pi.ts";
import { pinnedLayers } from "./pinned-layers.ts";
import { type ReviewRoots, reviewRootsOf } from "./review-roots.ts";
import { executionSessionDirectory } from "./session-directory.ts";
import { sessionTools, ToolProcesses } from "./tool-table.ts";

const WORKING_AGENT = 0;
const SINGLE_CHECKOUT = 1;

export interface SessionBudget {
  agentContext(parent: Context): CancellationContext;
  cleanupContext(parent: Context): CancellationContext;
  remainingMs(): number;
}

export interface SessionModelRequest {
  agent: AgentSetup;
  signal: AbortSignal;
}

export type SessionModelFactory = (
  request: SessionModelRequest,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

export interface SessionTrace {
  sessionId: string;
  end(status: SpanStatus): void;
}

export interface SessionTraceStart {
  agent: AgentSetup;
  formatVersion: number;
}

export type SessionTraceFactory<T extends SessionTrace> = (
  start: SessionTraceStart,
) => T | null;

export interface AgentPortInput<T extends SessionTrace> {
  capabilities: readonly InlineExtension[];
  modelRuntimeFactory: SessionModelFactory;
  knownSecrets: KnownSecrets;
  trace: SessionTraceFactory<T>;
  sessionRoot: string | null;
  budget: SessionBudget;
  env: NodeJS.ProcessEnv;
  hostHome: string;
}

export interface SessionOpenRequest {
  claim: { execution_id: string };
  setup: Pick<ExecutionSetup, "agents">;
  checkouts: readonly { directory: string }[];
  reviewWorkspace: ReviewRoots | null;
}

export interface PortSession<T extends SessionTrace> {
  agent: AgentSetup;
  session: AgentSession;
  context: CancellationContext;
  redaction: SensitiveTextRedaction;
  pins: ReturnType<typeof pinnedLayers>;
  processes: ToolProcesses;
  trace: T | null;
  close(): Promise<void>;
}

export interface SessionPort<T extends SessionTrace> {
  open(request: SessionOpenRequest, context: Context): Promise<PortSession<T>>;
}

interface SessionPlan {
  agent: AgentSetup;
  cwd: string;
  roots: readonly string[] | null;
}

function checkoutsRootOf(checkouts: SessionOpenRequest["checkouts"]): string {
  const [first] = checkouts;
  assert.ok(first);
  return checkouts.length > SINGLE_CHECKOUT
    ? dirname(first.directory)
    : first.directory;
}

function planOf(request: SessionOpenRequest): SessionPlan {
  const agent = request.setup.agents[WORKING_AGENT];
  assert.ok(agent);
  const review = request.reviewWorkspace;
  const cwd = review?.directory ?? checkoutsRootOf(request.checkouts);
  if (!isConfinedAgent(agent.agent_name)) return { agent, cwd, roots: null };
  return { agent, cwd, roots: review === null ? [cwd] : reviewRootsOf(review) };
}

function guardsOf(
  plan: SessionPlan,
  declared: readonly string[],
): InlineExtension[] {
  return [
    toolAllowlist(declared),
    ...(plan.roots === null
      ? []
      : [checkoutConfinement({ cwd: plan.cwd, roots: plan.roots })]),
  ];
}

interface SessionStore {
  cwd: string;
  executionId: string;
  trace: SessionTrace | null;
}

function sessionManagerOf(
  pi: PiCodingAgent,
  sessionRoot: string | null,
  session: SessionStore,
) {
  const options = session.trace === null ? {} : { id: session.trace.sessionId };
  return sessionRoot
    ? pi.SessionManager.create(
        session.cwd,
        executionSessionDirectory(sessionRoot, session.executionId),
        options,
      )
    : pi.SessionManager.inMemory(session.cwd, options);
}

export function agentPort<T extends SessionTrace>(
  input: AgentPortInput<T>,
): SessionPort<T> {
  assert.ok(input.hostHome);
  return {
    async open(request, parent) {
      const plan = planOf(request);
      const { agent, cwd } = plan;
      const context = input.budget.agentContext(parent);
      let trace: T | null = null;
      let runtime: AgentSessionRuntime | null = null;
      try {
        await input.knownSecrets();
        const { runtime: modelRuntime, model } = await withDeadline(
          input.modelRuntimeFactory({ agent, signal: context.signal }),
          context,
        );
        const pins = pinnedLayers();
        const pi = await withDeadline(loadPi(), context);
        trace = input.trace({
          agent,
          formatVersion: pi.CURRENT_SESSION_VERSION,
        });
        const processes = new ToolProcesses(pi.getShellConfig());
        const tools = sessionTools(pi, agent.agent_name, {
          cwd,
          budget: input.budget,
          env: input.env,
          processes,
        });
        const opened = await openSessionRuntime({
          cwd,
          modelRuntime,
          model,
          thinkingLevel: agent.effective_configuration.reasoning_effort,
          systemPrompt: agent.prompt.final,
          ...tools,
          hostHome: input.hostHome,
          hooks: [
            ...guardsOf(plan, tools.allowlist),
            pins.hook,
            ...input.capabilities,
          ],
          context,
          sessionManager: sessionManagerOf(pi, input.sessionRoot, {
            cwd,
            executionId: request.claim.execution_id,
            trace,
          }),
          knownSecrets: input.knownSecrets,
        });
        runtime = opened.runtime;
        const { session } = opened.runtime;
        pins.pinInference(session, opened.systemPrompt);
        let closed = false;
        return {
          agent,
          session,
          context,
          redaction: opened.redaction,
          pins,
          processes,
          trace,
          async close() {
            if (closed) return;
            closed = true;
            context.cancel();
            await closeRuntime(
              opened.runtime,
              input.budget.cleanupContext(parent),
            );
          },
        };
      } catch (error) {
        trace?.end(SpanStatus.Error);
        context.cancel();
        if (runtime)
          await closeRuntime(runtime, input.budget.cleanupContext(parent));
        throw error;
      }
    },
  };
}

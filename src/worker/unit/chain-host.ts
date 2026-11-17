import type { Context } from "../../kernel/context.ts";
import type { SshAccess } from "../../repository/contract.ts";
import type { RepositoryTransport } from "../contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import type {
  DeadlineKind,
  ExecutionCtx,
  Key,
  StepResult,
  StopCode,
} from "./chain.ts";
import type { ExecutionRun } from "./execution-run.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { SpanRecorder } from "./telemetry.ts";
import type { WorkspaceRoot } from "./workspace.ts";

type InputKeys = "claim" | "setup" | "sshAccess";

export interface StepHost {
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  env: NodeJS.ProcessEnv;
}

export interface HostInput extends StepsInput {
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  sshAccess: ReadonlyMap<string, SshAccess>;
}

export interface StepIo<P extends CommonPorts = CommonPorts> {
  run: ExecutionRun;
  budget: ExecutionBudget;
  context: Context;
  deadline: number;
  resources: AsyncDisposableStack;
  spans: SpanRecorder;
  host: StepHost;
  ports: P;
}

export interface Step<
  S,
  R extends Key,
  W extends Key,
  P extends CommonPorts = CommonPorts,
> {
  id: string;
  deadline: DeadlineKind;
  reads: readonly R[];
  writes: readonly W[];
  stops: readonly StopCode[];
  llm?: boolean;
  note?: string;
  run(
    ctx: Readonly<Pick<ExecutionCtx, R>>,
    scope: S,
    io: StepIo<P>,
  ): Promise<StepResult<S, W>>;
}

export function hostInputOf(
  ctx: Pick<ExecutionCtx, InputKeys>,
  io: Pick<StepIo, "host">,
): HostInput {
  return {
    claim: ctx.claim,
    setup: ctx.setup,
    sshAccess: ctx.sshAccess,
    workspaces: io.host.workspaces,
    transport: io.host.transport,
    env: io.host.env,
  };
}

export function seedOf(input: HostInput): Pick<ExecutionCtx, InputKeys> {
  return {
    claim: input.claim,
    setup: input.setup,
    sshAccess: input.sshAccess,
  };
}

export function hostOf(input: HostInput): StepHost {
  return {
    workspaces: input.workspaces,
    transport: input.transport,
    env: input.env,
  };
}

import type { AgentKind } from "../../domain/agent.ts";

export type AgentRequest = Readonly<{
  agent: AgentKind;
  prompt: string;
  workspacePath: string;
  timeoutMs: number;
}>;

export type AgentVerdict = "accept" | "reject";

export type AgentResult = Readonly<{
  verdict: AgentVerdict | null;
  diff: string | null;
  reason: string | null;
  toolTrace: string | null;
  usage: unknown;
  adapterVersion: string;
}>;

export type AgentErrorCode = "not-implemented" | "agent-timeout";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export interface Agent {
  invoke(request: AgentRequest): Promise<AgentResult>;
}

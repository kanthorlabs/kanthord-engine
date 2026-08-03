import {
  AgentError,
  type Agent,
  type AgentRequest,
  type AgentResult,
} from "./index.ts";

export class NotImplementedAgent implements Agent {
  invoke(request: AgentRequest): Promise<AgentResult> {
    void request;
    throw new AgentError(
      "not-implemented",
      "the agent service is implemented in phase 2",
    );
  }
}

import { agentOperations, AgentErrorCode } from "../../../agent/contract.ts";
import { httpClient } from "../../../gateway/client.ts";
import { Diagnostic } from "../../../kernel/errors.ts";
import { OperationResultType } from "../../../kernel/operation.ts";
import type { WorkbenchConfiguration } from "../../../workbench/contract.ts";
import { ALL_AGENTS, CouncilErrorCode } from "./contract.ts";

const ENABLED = "enabled";
const NO_MISSING_AGENTS = 0;

export type EnablementView = {
  state: "enabled" | "disabled";
  default_configuration: WorkbenchConfiguration;
};
export type EnablementReader = (
  agentName: string,
) => Promise<EnablementView | undefined>;

export async function requireEnabled(
  read: EnablementReader,
  agents: readonly string[] = ALL_AGENTS,
): Promise<Map<string, WorkbenchConfiguration>> {
  const views = await Promise.all(agents.map((agentName) => read(agentName)));
  const missing = agents.filter((_, index) => views[index]?.state !== ENABLED);
  if (missing.length > NO_MISSING_AGENTS)
    throw new Diagnostic(
      CouncilErrorCode.AgentNotEnabled,
      `enable these agents first: ${missing.join(", ")}`,
    );
  return new Map(
    agents.map((agentName, index) => [
      agentName,
      views[index]!.default_configuration,
    ]),
  );
}

export function httpEnablementReader(
  endpoint: string,
  token: string,
): EnablementReader {
  const client = httpClient(agentOperations, endpoint, token);
  return async (agentName) => {
    const result = await client["enablement.get"]({
      params: { agent_name: agentName },
      query: {},
      body: null,
    });
    if (result.type === OperationResultType.Completed) return result.data;
    if (
      result.type === OperationResultType.Failure &&
      result.error.error.code === AgentErrorCode.NotFound
    )
      return undefined;
    throw new Diagnostic(
      result.type === OperationResultType.Failure
        ? result.error.error.code
        : CouncilErrorCode.AgentSessionFailed,
      `agent.enablement.get ${agentName} failed`,
    );
  };
}

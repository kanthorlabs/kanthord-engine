import type { AgentContract } from "./agent-contract.ts";
import { harnesses } from "./harness.ts";

export type AgentContractErrorCode = "harness-unknown" | "harness-cannot-deny";

export class AgentContractError extends Error {
  readonly code: AgentContractErrorCode;

  constructor(code: AgentContractErrorCode, message: string) {
    super(message);
    this.name = "AgentContractError";
    this.code = code;
  }
}

function renderTool(tool: string): string {
  if (tool === "ls") {
    return "LS";
  }

  return `${tool.slice(0, 1).toUpperCase()}${tool.slice(1)}`;
}

export function renderAgentContract(
  contract: AgentContract,
  harnessId: string,
): string {
  const descriptor = harnesses.find((candidate) => candidate.id === harnessId);
  if (!descriptor) {
    throw new AgentContractError(
      "harness-unknown",
      `unknown harness: ${harnessId}`,
    );
  }
  if (!descriptor.denyByDefault) {
    throw new AgentContractError(
      "harness-cannot-deny",
      `harness cannot deny tools by default: ${harnessId}`,
    );
  }

  const renderedTools = contract.capabilities.tools.map(renderTool).join(",");
  return `---\nname: ${contract.agent}\ndescription: ${contract.purpose}\ntools: ${renderedTools}\n---\n`;
}

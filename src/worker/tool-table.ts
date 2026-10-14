import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { COMMAND_LIMIT_MS, type ExecutionBudget } from "./budget.ts";
import { BuiltinTool, getAgentDeclaration } from "../agent/catalog.ts";
import { loadPi, piAgentDirectory, type PiCodingAgent } from "../agent/pi.ts";

import { ToolSource } from "../agent/contract.ts";
import type { HostTools } from "./contract.ts";
import {
  evidenceUploadTool,
  EVIDENCE_UPLOAD_PARAMETERS,
} from "./host-tools.ts";
export { ToolSource } from "../agent/contract.ts";
import { childEnvironment } from "../agent/environment.ts";
export { childEnvironment } from "../agent/environment.ts";

const MINIMUM_SECONDS = 1;
const MILLISECONDS_PER_SECOND = 1000;
export function sessionTools(
  pi: PiCodingAgent,
  agentName: string,
  cwd: string,
  budget: ExecutionBudget,
  hostTools: HostTools,
): { allowlist: string[]; customTools: ToolDefinition[] } {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent);
  assert.ok(cwd);
  const allowlist: string[] = [...agent.tools, ...agent.host_tools];
  const customTools: ToolDefinition[] = agent.host_tools.map(() =>
    evidenceUploadTool(hostTools),
  );
  if (!agent.tools.includes(BuiltinTool.Bash))
    return { allowlist, customTools };
  const local = pi.createLocalBashOperations();
  const bash = pi.createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({
      ...context,
      env: childEnvironment(context.env),
    }),
    operations: {
      exec: (command, directory, options) => {
        const limit = Math.floor(
          (Math.min(budget.remainingMs(), COMMAND_LIMIT_MS) - 1) /
            MILLISECONDS_PER_SECOND,
        );
        if (limit < MINIMUM_SECONDS)
          return Promise.reject(new Error("resource budget ended"));
        return local.exec(command, directory, {
          ...options,
          timeout: Math.min(options.timeout ?? limit, limit),
          env: childEnvironment(options.env ?? process.env),
        });
      },
    },
  });
  return {
    allowlist,
    customTools: [bash as unknown as ToolDefinition, ...customTools],
  };
}

export async function toolDeclarations(agentName: string): Promise<
  {
    name: string;
    source: ToolSource;
    input_schema: Record<string, unknown>;
  }[]
> {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent, "Tool declarations require a known agent");
  const pi = await loadPi();
  const factories = {
    [BuiltinTool.Read]: pi.createReadToolDefinition,
    [BuiltinTool.Edit]: pi.createEditToolDefinition,
    [BuiltinTool.Write]: pi.createWriteToolDefinition,
    [BuiltinTool.Grep]: pi.createGrepToolDefinition,
    [BuiltinTool.Find]: pi.createFindToolDefinition,
    [BuiltinTool.Ls]: pi.createLsToolDefinition,
    [BuiltinTool.Bash]: pi.createBashToolDefinition,
  };
  assert.ok(agent.tools.every((name) => Object.hasOwn(factories, name)));
  const builtin = agent.tools.map((name) => {
    const definition = factories[name](piAgentDirectory());
    return {
      name: definition.name,
      source: ToolSource.Builtin,
      input_schema: JSON.parse(JSON.stringify(definition.parameters)) as Record<
        string,
        unknown
      >,
    };
  });
  return [
    ...builtin,
    ...agent.host_tools.map((name) => ({
      name,
      source: ToolSource.Host,
      input_schema: JSON.parse(
        JSON.stringify(EVIDENCE_UPLOAD_PARAMETERS),
      ) as Record<string, unknown>,
    })),
  ];
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Diagnostic } from "../kernel/errors.ts";
import type { ExecutionBudget } from "./budget.ts";
import { BuiltinTool, getAgentDeclaration } from "./catalog.ts";
import { loadPi, piAgentDirectory, type PiCodingAgent } from "./pi.ts";

import { ToolSource, WorkerErrorCode, type HostTools } from "./contract.ts";
import {
  evidenceUploadTool,
  EVIDENCE_UPLOAD_PARAMETERS,
} from "./host-tools.ts";
export { ToolSource } from "./contract.ts";

const SUCCESS = 0;
const MINIMUM_SECONDS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const COMMAND_ABSENT = "ENOENT";
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  assert.ok(env);
  const output = { ...env };
  const providerEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const provider of getBuiltinProviders())
    for (const name of findEnvKeys(provider, providerEnv) ?? [])
      delete output[name];
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
  ])
    delete output[name];
  assert.notEqual(output, env);
  return output;
}

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
  const allowlist: string[] = [...agent.tools, ...agent.hostTools];
  const customTools: ToolDefinition[] = agent.hostTools.map(() =>
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
          (budget.remainingMs() - 1) / MILLISECONDS_PER_SECOND,
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

export function checkAgentTools(): void {
  const options = { timeout: 10000, env: childEnvironment(process.env) };
  const rg = spawnSync("rg", ["--version"], options);
  const fd = spawnSync("fd", ["--version"], options);
  const selected =
    fd.error && "code" in fd.error && fd.error.code === COMMAND_ABSENT
      ? spawnSync("fdfind", ["--version"], options)
      : fd;
  if (rg.error || rg.status !== SUCCESS)
    throw new Diagnostic(WorkerErrorCode.StartToolMissing, "rg: not found");
  if (selected.error || selected.status !== SUCCESS)
    throw new Diagnostic(WorkerErrorCode.StartToolMissing, "fd: not found");
  assert.equal(rg.status, SUCCESS);
  assert.equal(selected.status, SUCCESS);
}

export async function toolDeclarations(agentName: string): Promise<
  {
    name: string;
    source: ToolSource;
    inputSchema: Record<string, unknown>;
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
      inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<
        string,
        unknown
      >,
    };
  });
  return [
    ...builtin,
    ...agent.hostTools.map((name) => ({
      name,
      source: ToolSource.Host,
      inputSchema: JSON.parse(
        JSON.stringify(EVIDENCE_UPLOAD_PARAMETERS),
      ) as Record<string, unknown>,
    })),
  ];
}

import assert from "node:assert/strict";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { COMMAND_LIMIT_MS, type ExecutionBudget } from "./budget.ts";
import { BuiltinTool, getAgentDeclaration } from "../../agent/catalog.ts";
import type { PiCodingAgent } from "../../agent/pi.ts";
import type { HostTools } from "../contract.ts";
import { evidenceUploadTool } from "./host-tools.ts";
export { ToolSource } from "../../agent/contract.ts";
import { childEnvironment } from "../../agent/environment.ts";
import {
  processBashOperations,
  type BashProcess,
  type ShellConfig,
} from "../../agent/bash-process.ts";
export { childEnvironment } from "../../agent/environment.ts";

const MINIMUM_SECONDS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const PROCESSES_MAX = 1024;

export interface ToolTimeout {
  requestedMs: number | null;
  appliedMs: number;
}

export class ToolProcesses {
  private readonly shell: ShellConfig;
  private readonly ended = new Map<string, BashProcess>();
  private readonly timeouts = new Map<string, ToolTimeout>();

  constructor(shell: ShellConfig) {
    assert.ok(shell.shell);
    this.shell = shell;
  }

  operations(toolCallId: string): BashOperations {
    assert.ok(toolCallId);
    return processBashOperations(this.shell, (bashProcess) => {
      if (this.ended.size >= PROCESSES_MAX) this.ended.clear();
      this.ended.set(toolCallId, bashProcess);
    });
  }

  take(toolCallId: string): BashProcess | undefined {
    const bashProcess = this.ended.get(toolCallId);
    this.ended.delete(toolCallId);
    return bashProcess;
  }

  recordTimeout(toolCallId: string, timeout: ToolTimeout): void {
    assert.ok(toolCallId);
    if (this.timeouts.size >= PROCESSES_MAX) this.timeouts.clear();
    this.timeouts.set(toolCallId, timeout);
  }

  takeTimeout(toolCallId: string): ToolTimeout | undefined {
    const timeout = this.timeouts.get(toolCallId);
    this.timeouts.delete(toolCallId);
    return timeout;
  }
}

export function sessionTools(
  pi: PiCodingAgent,
  agentName: string,
  cwd: string,
  budget: ExecutionBudget,
  hostTools: HostTools,
  env: NodeJS.ProcessEnv,
  processes: ToolProcesses,
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
  const options = (
    toolCallId: string,
    operations: BashOperations,
  ): BashToolOptions => ({
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({
      ...context,
      env: childEnvironment(context.env),
    }),
    operations: {
      exec: (command, directory, execOptions) => {
        const limit = Math.floor(
          (Math.min(budget.remainingMs(), COMMAND_LIMIT_MS) - 1) /
            MILLISECONDS_PER_SECOND,
        );
        if (limit < MINIMUM_SECONDS)
          return Promise.reject(new Error("resource budget ended"));
        const applied = Math.min(execOptions.timeout ?? limit, limit);
        processes.recordTimeout(toolCallId, {
          requestedMs:
            execOptions.timeout === undefined
              ? null
              : execOptions.timeout * MILLISECONDS_PER_SECOND,
          appliedMs: applied * MILLISECONDS_PER_SECOND,
        });
        return operations.exec(command, directory, {
          ...execOptions,
          timeout: applied,
          env: childEnvironment(execOptions.env ?? env),
        });
      },
    },
  });
  const declared = pi.createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
  });
  const bash: typeof declared = {
    ...declared,
    execute: (toolCallId, params, signal, onUpdate, context) =>
      pi
        .createBashToolDefinition(
          cwd,
          options(toolCallId, processes.operations(toolCallId)),
        )
        .execute(toolCallId, params, signal, onUpdate, context),
  };
  return {
    allowlist,
    customTools: [bash as unknown as ToolDefinition, ...customTools],
  };
}

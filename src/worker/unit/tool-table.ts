import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { COMMAND_LIMIT_MS, type ExecutionBudget } from "./budget.ts";
import { BuiltinTool, getAgentDeclaration } from "../../agent/catalog.ts";
import type { PiCodingAgent } from "../../agent/pi.ts";
import { HostTool, type HostTools } from "../contract.ts";
import { evidenceUploadTool, linkUpdateListTool } from "./host-tools.ts";
export { ToolSource } from "../../agent/contract.ts";
import { childEnvironment } from "../../agent/environment.ts";
import {
  type BashProcess,
  processBashOperations,
  type ShellConfig,
} from "../../agent/bash-process.ts";
import { bashSandbox, type SandboxScope } from "../../agent/bash-sandbox.ts";
import { endMarkedGroups } from "../../kernel/process-group.ts";
export { childEnvironment } from "../../agent/environment.ts";

const MINIMUM_SECONDS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const PROCESSES_MAX = 1024;
const PNPM_STORE_DIRECTORY = "pnpm-store";
const PNPM_CACHE_DIRECTORY = "pnpm-cache";
const NPM_CACHE_DIRECTORY = "npm-cache";

const HOST_TOOLS: Readonly<
  Record<HostTool, (hostTools: HostTools) => ToolDefinition>
> = {
  [HostTool.EvidenceUpload]: evidenceUploadTool,
  [HostTool.LinkUpdateList]: linkUpdateListTool,
};

export interface ToolTimeout {
  requestedMs: number | null;
  appliedMs: number;
}

export class ToolProcesses {
  private readonly shell: ShellConfig;
  private readonly ended = new Map<string, BashProcess>();
  private readonly timeouts = new Map<string, ToolTimeout>();
  private readonly marker = randomUUID();

  constructor(shell: ShellConfig) {
    assert.ok(shell.shell);
    this.shell = shell;
  }

  operations(toolCallId: string): BashOperations {
    assert.ok(toolCallId);
    return processBashOperations(
      this.shell,
      (bashProcess) => {
        if (this.ended.size >= PROCESSES_MAX) this.ended.clear();
        this.ended.set(toolCallId, bashProcess);
      },
      {
        killGroupAtEnd: true,
        marker: this.marker,
      },
    );
  }

  endGroups(): Promise<void> {
    return endMarkedGroups(this.marker);
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

function packageCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const temporary = env.TMPDIR;
  if (temporary === undefined) return env;
  return {
    ...env,
    pnpm_config_store_dir: join(temporary, PNPM_STORE_DIRECTORY),
    pnpm_config_cache_dir: join(temporary, PNPM_CACHE_DIRECTORY),
    npm_config_cache: join(temporary, NPM_CACHE_DIRECTORY),
  };
}

export function sessionTools(
  pi: PiCodingAgent,
  agentName: string,
  cwd: string,
  budget: ExecutionBudget,
  hostTools: HostTools,
  env: NodeJS.ProcessEnv,
  processes: ToolProcesses,
  sandbox: SandboxScope,
): { allowlist: string[]; customTools: ToolDefinition[] } {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent);
  assert.ok(cwd);
  const allowlist: string[] = [...agent.tools.builtin, ...agent.tools.host];
  const customTools: ToolDefinition[] = agent.tools.host.map((name) =>
    HOST_TOOLS[name](hostTools),
  );
  if (!agent.tools.builtin.includes(BuiltinTool.Bash))
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
      exec: async (command, directory, execOptions) => {
        const limit = Math.floor(
          (Math.min(budget.remainingMs(), COMMAND_LIMIT_MS) - 1) /
            MILLISECONDS_PER_SECOND,
        );
        if (limit < MINIMUM_SECONDS) throw new Error("resource budget ended");
        const applied = Math.min(execOptions.timeout ?? limit, limit);
        const childEnv = packageCacheEnvironment(
          childEnvironment(execOptions.env ?? env),
        );
        const wrapped = await bashSandbox.wrap(command, directory, {
          ...sandbox,
          env: childEnv,
        });
        processes.recordTimeout(toolCallId, {
          requestedMs:
            execOptions.timeout === undefined
              ? null
              : execOptions.timeout * MILLISECONDS_PER_SECOND,
          appliedMs: applied * MILLISECONDS_PER_SECOND,
        });
        return operations.exec(wrapped, directory, {
          ...execOptions,
          timeout: applied,
          env: childEnv,
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

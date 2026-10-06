import assert from "node:assert/strict";
import { ulid } from "ulid";
import { z } from "zod";
import type { TSchema } from "@earendil-works/pi-ai";
import type { PiCodingAgent } from "../agent/pi.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CancellationContext } from "../kernel/context.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { HumanIdentity } from "../kernel/caller.ts";
import {
  AccessPolicy,
  OperationLifetime,
  OperationResultType,
  type ClientOptions,
  type Operation,
  type OperationResult,
} from "../kernel/operation.ts";
import { BuiltinTool, getAgentDeclaration } from "../agent/catalog.ts";
import { childEnvironment } from "../agent/environment.ts";
import { llmOperations } from "../llm/contract.ts";
import { repositoryOperations } from "../repository/contract.ts";
import { storageOperations } from "../storage/contract.ts";

export const SECRET_OPERATION_IDS: ReadonlySet<string> = new Set([
  llmOperations.create.id,
  llmOperations.rotate.id,
  llmOperations.check.id,
  llmOperations.login_code.id,
  repositoryOperations.create.id,
  repositoryOperations.rotate.id,
  repositoryOperations.check.id,
  storageOperations.create.id,
  storageOperations.rotate.id,
  storageOperations.check.id,
]);

export type InvokeOperation = (
  operation: Operation,
  input: unknown,
  options: ClientOptions,
) => Promise<OperationResult<unknown>>;

export function toolOperations(operations: readonly Operation[]): Operation[] {
  return operations.filter(
    (operation) =>
      operation.access === AccessPolicy.Human &&
      operation.lifetime !== OperationLifetime.Stream &&
      !operation.secret &&
      !SECRET_OPERATION_IDS.has(operation.id),
  );
}

function parameters(operation: Operation): TSchema {
  const schema = z.toJSONSchema(operation.input, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema as unknown as TSchema;
}

export function operationTool(
  operation: Operation,
  invoke: InvokeOperation,
  requester: () => HumanIdentity | undefined,
): ToolDefinition {
  assert.equal(operation.access, AccessPolicy.Human);
  return {
    name: operation.id,
    label: operation.id,
    description: operation.description,
    parameters: parameters(operation),
    async execute(_toolCallId, params, signal) {
      const identity = requester();
      assert.ok(identity);
      const context = new CancellationContext();
      const cancel = () => context.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await invoke(operation, params, {
          identity,
          context,
          ...(operation.mutation ? { idempotencyKey: ulid() } : {}),
        });
        if (result.type === OperationResultType.Completed)
          return {
            content: [{ type: "text", text: canonicalJSON(result.data) }],
            details: result.data,
          };
        if (result.type === OperationResultType.Failure)
          throw new Error(
            `${result.error.error.code}: ${result.error.error.message}`,
          );
        throw new Error(
          `${operation.id}: the result of the operation is indeterminate.`,
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
        context.cancel();
      }
    },
  };
}

export function builtinTools(
  pi: PiCodingAgent,
  agentName: string,
  cwd: string,
): { allowlist: string[]; customTools: ToolDefinition[] } {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent);
  assert.ok(cwd);
  const allowlist: string[] = [...agent.tools];
  if (!agent.tools.includes(BuiltinTool.Bash))
    return { allowlist, customTools: [] };
  const local = pi.createLocalBashOperations();
  const bash = pi.createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({
      ...context,
      env: childEnvironment(context.env),
    }),
    operations: {
      exec: (command, directory, options) =>
        local.exec(command, directory, {
          ...options,
          env: childEnvironment(options.env ?? process.env),
        }),
    },
  });
  return {
    allowlist,
    customTools: [bash as unknown as ToolDefinition],
  };
}

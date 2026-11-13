import assert from "node:assert/strict";
import { z } from "zod";
import type { TSchema } from "@earendil-works/pi-ai";
import type { PiCodingAgent } from "../agent/pi.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CancellationContext } from "../kernel/context.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { isObject } from "../kernel/values.ts";
import type { HumanIdentity } from "../kernel/caller.ts";
import {
  AccessPolicy,
  type ClientOptions,
  type Operation,
  OperationLifetime,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import { BuiltinTool, getAgentDeclaration } from "../agent/catalog.ts";
import {
  GuardClass,
  type ToolDeclaration,
  ToolSource,
} from "../agent/contract.ts";
import { childEnvironment } from "../agent/environment.ts";
import { processBashOperations } from "../agent/bash-process.ts";
import {
  intakeCredentialOperations,
  intakeOperations,
} from "../intake/contract.ts";
import { llmOperations } from "../llm/contract.ts";
import { missionOperations } from "../mission/contract.ts";
import { environmentSecretOperations } from "../project/contract.ts";
import { repositoryOperations } from "../repository/contract.ts";
import { storageOperations } from "../storage/contract.ts";
import {
  EVIDENCE_READ_DESCRIPTION,
  EVIDENCE_READ_PARAMETERS,
  EVIDENCE_READ_TOOL,
} from "./evidence.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";

const NO_PROPERTIES = 0;

export const SECRET_OPERATION_IDS: ReadonlySet<string> = new Set([
  llmOperations.create.id,
  llmOperations.rotate.id,
  llmOperations.check.id,
  llmOperations.login_code.id,
  repositoryOperations.create.id,
  repositoryOperations.rotate.id,
  repositoryOperations.check.id,
  repositoryOperations.host_key_pin.id,
  repositoryOperations.ssh_key_create.id,
  repositoryOperations.ssh_key_rotate.id,
  storageOperations.create.id,
  storageOperations.rotate.id,
  storageOperations.check.id,
  intakeOperations["inbound.get"].id,
  intakeOperations["storage.get"].id,
  missionOperations["evidence.asset.content.get"].id,
  intakeCredentialOperations.create.id,
  intakeCredentialOperations.rotate.id,
  intakeCredentialOperations.check.id,
  environmentSecretOperations.create.id,
  environmentSecretOperations.rotate.id,
  environmentSecretOperations.check.id,
]);

const HUMAN_POLICIES: readonly AccessPolicy[] = [
  AccessPolicy.Human,
  AccessPolicy.HumanOrWorker,
  AccessPolicy.HumanOrService,
];

export type InvokeOperation = (
  operation: Operation,
  input: unknown,
  options: ClientOptions,
) => Promise<OperationResult<unknown>>;

export function toolOperations(
  operations: readonly Operation[],
  listed: readonly string[],
): Operation[] {
  return operations.filter(
    (operation) =>
      HUMAN_POLICIES.includes(operation.access) &&
      operation.lifetime !== OperationLifetime.Stream &&
      !operation.secret &&
      !SECRET_OPERATION_IDS.has(operation.id) &&
      listed.includes(operation.id),
  );
}

const BODY_PART = "body";
const ENVELOPE_PARTS = ["params", "query", BODY_PART] as const;
const BODYLESS_SCHEMA = { type: "null" };

interface ToolShape {
  schema: TSchema;
  omitted: Record<string, unknown>;
}

function omittedValue(part: string, schema: unknown): unknown {
  if (!isObject(schema)) return undefined;
  if (part === BODY_PART)
    return canonicalJSON(schema) === canonicalJSON(BODYLESS_SCHEMA)
      ? null
      : undefined;
  const { properties } = schema as { properties?: unknown };
  return isObject(properties) &&
    Object.keys(properties).length === NO_PROPERTIES
    ? {}
    : undefined;
}

function toolShape(operation: Operation): ToolShape {
  const schema = z.toJSONSchema(operation.input, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  const omitted: Record<string, unknown> = {};
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return { schema: schema as unknown as TSchema, omitted };
  for (const part of ENVELOPE_PARTS) {
    const value = omittedValue(part, properties[part]);
    if (value === undefined) continue;
    omitted[part] = value;
    delete properties[part];
  }
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((part) => !(part in omitted));
    if (required.length === NO_PROPERTIES) delete schema.required;
    else schema.required = required;
  }
  return { schema: schema as unknown as TSchema, omitted };
}

function parameters(operation: Operation): TSchema {
  return toolShape(operation).schema;
}

export function toolName(operationId: string): string {
  return operationId.replaceAll(".", "--");
}

export function operationToolDeclarations(
  operations: readonly Operation[],
  agentName: string,
): ToolDeclaration[] {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent);
  const listed = agent.tools.operation;
  return toolOperations(operations, listed)
    .sort((a, b) => listed.indexOf(a.id) - listed.indexOf(b.id))
    .map((operation) => ({
      name: toolName(operation.id),
      source: ToolSource.Operation,
      input_schema: parameters(operation) as unknown as Record<string, unknown>,
      description: operation.description,
      guard_class: operation.mutation ? GuardClass.Card : GuardClass.Read,
    }));
}

export function workbenchToolDeclarations(
  agentName: string,
): ToolDeclaration[] {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent);
  return agent.tools.workbench.map(() => ({
    name: EVIDENCE_READ_TOOL,
    source: ToolSource.Workbench,
    input_schema: EVIDENCE_READ_PARAMETERS as unknown as Record<
      string,
      unknown
    >,
    description: EVIDENCE_READ_DESCRIPTION,
    guard_class: GuardClass.Card,
  }));
}

export function operationTool(
  operation: Operation,
  invoke: InvokeOperation,
  requester: () => HumanIdentity | undefined,
): ToolDefinition {
  assert.ok(HUMAN_POLICIES.includes(operation.access));
  const { schema, omitted } = toolShape(operation);
  return {
    name: toolName(operation.id),
    label: operation.id,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal) {
      const identity = requester();
      assert.ok(identity);
      const context = new CancellationContext();
      const cancel = () => context.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await invoke(
          operation,
          { ...(params as object), ...omitted },
          {
            identity,
            context,
            ...(operation.mutation
              ? { idempotencyKey: createIdempotencyKey() }
              : {}),
          },
        );
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
  const allowlist: string[] = [...agent.tools.builtin];
  if (!agent.tools.builtin.includes(BuiltinTool.Bash))
    return { allowlist, customTools: [] };
  const local = processBashOperations(pi.getShellConfig(), () => {}, {
    killGroupAtEnd: false,
  });
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

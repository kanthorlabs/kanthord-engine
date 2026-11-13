import assert from "node:assert/strict";
import { z } from "zod";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HumanIdentity } from "../kernel/caller.ts";
import { CancellationContext } from "../kernel/context.ts";
import { identitySchema } from "../kernel/identity.ts";
import { type Operation, OperationResultType } from "../kernel/operation.ts";
import { nodeStateSchema } from "../mission/contract.ts";
import { type WorkbenchRecord, WorkbenchRecordKind } from "./contract.ts";
import type { InvokeOperation } from "./tools.ts";

export const ActionTarget = { Node: "node", Project: "project" } as const;
export type ActionTarget = (typeof ActionTarget)[keyof typeof ActionTarget];

export const WORKBENCH_ACTION_TOOL_NAME = "offer_action";

export const ACTION_CARD_OPERATIONS: Readonly<Record<string, ActionTarget>> = {
  "mission.node.resume": ActionTarget.Node,
  "mission.node.unblock": ActionTarget.Node,
  "mission.node.check": ActionTarget.Node,
  "mission.node.discard": ActionTarget.Node,
  "mission.node.override": ActionTarget.Node,
  "mission.node.pause": ActionTarget.Node,
  "project.pause": ActionTarget.Project,
  "project.resume": ActionTarget.Project,
};

export const TARGET_READS: Readonly<
  Record<ActionTarget, { operation_id: string; param: string }>
> = {
  [ActionTarget.Node]: { operation_id: "mission.node.get", param: "node_id" },
  [ActionTarget.Project]: { operation_id: "project.get", param: "project_id" },
};

const nodeReadSchema = z.looseObject({
  state: nodeStateSchema,
  attempt: z.number().int().nonnegative(),
});
const projectReadSchema = z.looseObject({
  paused_at: z.number().int().nullable(),
});

const offerParametersSchema = z.strictObject({
  operation_id: z.string(),
  target_id: z.string(),
});

function offerParameters(): TSchema {
  const schema = z.toJSONSchema(offerParametersSchema, {
    io: "input",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema as unknown as TSchema;
}

export interface OfferActionToolInput {
  operations: readonly Operation[];
  invoke: InvokeOperation;
  requester: () => HumanIdentity | undefined;
  offer: { taken(): boolean; append(record: WorkbenchRecord): void };
}

type ActionOffer = Extract<
  WorkbenchRecord,
  { kind: typeof WorkbenchRecordKind.ActionOffer }
>;

function seenOf(target: ActionTarget, data: unknown): ActionOffer["seen"] {
  if (target === ActionTarget.Node) {
    const { state, attempt } = nodeReadSchema.parse(data);
    return { state, attempt };
  }
  return { paused: projectReadSchema.parse(data).paused_at !== null };
}

export function offerActionTool(input: OfferActionToolInput): ToolDefinition {
  const { operations, invoke, requester, offer } = input;
  async function readTarget(
    target: ActionTarget,
    targetId: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const read = TARGET_READS[target];
    const operation = operations.find(({ id }) => id === read.operation_id);
    assert.ok(operation);
    const identity = requester();
    assert.ok(identity);
    const context = new CancellationContext();
    const cancel = () => context.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await invoke(
        operation,
        { params: { [read.param]: targetId }, query: {}, body: null },
        { identity, context },
      );
      if (result.type === OperationResultType.Completed) return result.data;
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
  }
  return {
    name: WORKBENCH_ACTION_TOOL_NAME,
    label: WORKBENCH_ACTION_TOOL_NAME,
    description:
      "Show an action card to the owner. The tool runs nothing. The owner decides whether the act runs.",
    parameters: offerParameters(),
    async execute(toolCallId, params, signal) {
      const { operation_id, target_id } = offerParametersSchema.parse(params);
      if (!Object.hasOwn(ACTION_CARD_OPERATIONS, operation_id))
        throw new Error(
          `workbench.action.operation_refused: ${operation_id} is no action card act.`,
        );
      const target = ACTION_CARD_OPERATIONS[operation_id];
      assert.ok(target);
      if (!identitySchema(target).safeParse(target_id).success)
        throw new Error(
          `workbench.action.target_invalid: The target is no ${target} identity.`,
        );
      if (offer.taken())
        throw new Error(
          "workbench.action.offer_limit: One action card per answer. The first card stays.",
        );
      const seen = seenOf(target, await readTarget(target, target_id, signal));
      const record: ActionOffer = {
        kind: WorkbenchRecordKind.ActionOffer,
        tool_call_id: toolCallId,
        operation_id,
        target_id,
        seen,
      };
      offer.append(record);
      return {
        content: [
          {
            type: "text",
            text: `Card shown: ${operation_id} on ${target_id}. The owner decides. Do not state that the act ran. End the answer.`,
          },
        ],
        details: record,
      };
    },
  };
}

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderFailure, providerFailureOf } from "../scheduler/contract.ts";
import type { SecretWarning } from "./redaction.ts";

const TOOL_CALL_PART = "toolCall";

export { ProviderFailure };

export const RunEnd = {
  Completed: "completed",
  BudgetEnd: "budget_end",
  Stopped: "stopped",
  Failed: "failed",
} as const;
export type RunEnd = (typeof RunEnd)[keyof typeof RunEnd];

export const BudgetLimit = {
  Wall: "wall",
  Usd: "usd",
} as const;
export type BudgetLimit = (typeof BudgetLimit)[keyof typeof BudgetLimit];

export const FailureClass = {
  Retryable: "retryable",
  Terminal: "terminal",
} as const;
export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

export const InternalFailure = {
  Internal: "internal",
} as const;

export interface TurnEnd {
  end: RunEnd;
  budgetReached: BudgetLimit | null;
  failure: RunFailure | null;
  text: string | null;
  totals: RunTotals;
  warnings: readonly SecretWarning[];
}

export interface RunFailure {
  kind: ProviderFailure | typeof InternalFailure.Internal;
  class: FailureClass;
  reason: string;
}

export interface RunTotals {
  modelCalls: number;
  toolCalls: number;
  usage: TokenUsage;
  listPriceUsd: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface FailureInput {
  internal: boolean;
  reason: string;
}

export interface TurnEndInput {
  budgetReached: BudgetLimit | null;
  stopped: boolean;
  failure: FailureInput | null;
  text: string | null;
  totals: RunTotals;
  warnings: readonly SecretWarning[];
}

export function zeroTotals(): RunTotals {
  return {
    modelCalls: 0,
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    listPriceUsd: 0,
  };
}

export function addMessageTotals(
  current: RunTotals,
  message: AssistantMessage,
): RunTotals {
  const toolCallCount = message.content.filter(
    (part) => part.type === TOOL_CALL_PART,
  ).length;
  return {
    modelCalls: current.modelCalls + 1,
    toolCalls: current.toolCalls + toolCallCount,
    usage: {
      input: current.usage.input + message.usage.input,
      output: current.usage.output + message.usage.output,
      cacheRead: current.usage.cacheRead + message.usage.cacheRead,
      cacheWrite: current.usage.cacheWrite + message.usage.cacheWrite,
    },
    listPriceUsd: current.listPriceUsd + message.usage.cost.total,
  };
}

export function buildTurnEnd(input: TurnEndInput): TurnEnd {
  const { budgetReached, stopped, failure, text, totals, warnings } = input;
  if (budgetReached !== null) {
    return {
      end: RunEnd.BudgetEnd,
      budgetReached,
      failure: null,
      text,
      totals,
      warnings,
    };
  }
  if (stopped) {
    return {
      end: RunEnd.Stopped,
      budgetReached: null,
      failure: null,
      text,
      totals,
      warnings,
    };
  }
  if (failure !== null) {
    const kind = failure.internal
      ? InternalFailure.Internal
      : providerFailureOf(failure.reason);
    return {
      end: RunEnd.Failed,
      budgetReached: null,
      failure: { kind, class: FailureClass.Terminal, reason: failure.reason },
      text,
      totals,
      warnings,
    };
  }
  return {
    end: RunEnd.Completed,
    budgetReached: null,
    failure: null,
    text,
    totals,
    warnings,
  };
}

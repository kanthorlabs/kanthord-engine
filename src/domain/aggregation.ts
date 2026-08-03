import type { NodeKind, TerminalState } from "./state.ts";

export type ParentKind = Extract<NodeKind, "objective" | "initiative">;

export type AggregationErrorCode = "empty-parent" | "invalid-child-state";

export class AggregationError extends Error {
  readonly code: AggregationErrorCode;

  constructor(code: AggregationErrorCode, message: string) {
    super(message);
    this.name = "AggregationError";
    this.code = code;
  }
}

export function aggregate(
  parent: ParentKind,
  children: readonly TerminalState[],
): TerminalState {
  if (children.length === 0) {
    throw new AggregationError(
      "empty-parent",
      `an ${parent} with no child is invalid`,
    );
  }

  if (parent === "objective" && children.some((child) => child === "partial")) {
    throw new AggregationError(
      "invalid-child-state",
      "a task is never partial",
    );
  }

  if (children.every((child) => child === "done")) {
    return "done";
  }

  if (children.every((child) => child === "discarded")) {
    return "discarded";
  }

  return "partial";
}

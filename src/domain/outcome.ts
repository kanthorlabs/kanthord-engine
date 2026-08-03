import type { NodeState, TerminalState } from "./state.ts";

export const e2eResults = [
  "pending",
  "passed",
  "failed",
  "not-applicable",
] as const;

export type E2eResult = (typeof e2eResults)[number];

export type LevelOutcome = Readonly<
  | { state: Exclude<NodeState, "blocked">; blockReason: null }
  | { state: "blocked"; blockReason: "e2e-failed" }
>;

export function objectiveOutcome(projected: TerminalState): LevelOutcome {
  if (projected === "discarded") {
    return { state: "discarded", blockReason: null };
  }

  return { state: "awaiting_approval", blockReason: null };
}

export function initiativeOutcome(
  projected: TerminalState,
  e2e: E2eResult,
): LevelOutcome {
  if (projected === "discarded") {
    return { state: "discarded", blockReason: null };
  }

  if (e2e === "pending") {
    return { state: "running", blockReason: null };
  }

  if (e2e === "failed") {
    return { state: "blocked", blockReason: "e2e-failed" };
  }

  return { state: projected, blockReason: null };
}

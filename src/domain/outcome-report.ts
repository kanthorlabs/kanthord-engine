import type { AttemptAccounting } from "./attempt-accounting.ts";
import type { AttemptOutcome } from "./attempt.ts";
import type { NodeKind, NodeState, TerminalState } from "./state.ts";
import type { ExternalTriggerId } from "./external-transition.ts";

export const reportKinds = [
  "accepted",
  "rejected",
  "failed",
  "cancelled",
  "attested",
  "closed",
] as const;
export type ReportKind = (typeof reportKinds)[number];

export const taskReportOutcomes = [
  "accepted",
  "rejected",
  "failed",
  "cancelled",
] as const;
export type TaskReportOutcome = (typeof taskReportOutcomes)[number];

export const objectiveReportKinds = ["attested", "closed"] as const;
export type ObjectiveReportKind = (typeof objectiveReportKinds)[number];

export type TaskReportEffect = Readonly<{
  attemptOutcome: AttemptOutcome;
  nodeState: NodeState;
  blockReason: "attempt-limit" | null;
  runEnd: "done" | "blocked" | null;
  objectIdRequired: boolean;
  trigger: ExternalTriggerId;
}>;

export type TaskReportEffectInput = Readonly<{
  outcome: TaskReportOutcome;
  accounting: AttemptAccounting;
}>;

export function taskReportEffect(
  input: TaskReportEffectInput,
): TaskReportEffect {
  switch (input.outcome) {
    case "accepted":
      return {
        attemptOutcome: "accepted",
        nodeState: "done",
        blockReason: null,
        runEnd: "done",
        objectIdRequired: true,
        trigger: "outcome-accepted",
      };
    case "rejected":
    case "failed":
    case "cancelled":
      if (input.accounting.exhausted) {
        return {
          attemptOutcome: input.outcome,
          nodeState: "blocked",
          blockReason: "attempt-limit",
          runEnd: "blocked",
          objectIdRequired: false,
          trigger: "attempt-limit-reached",
        };
      }
      return {
        attemptOutcome: input.outcome,
        nodeState: "ready",
        blockReason: null,
        runEnd: null,
        objectIdRequired: false,
        trigger:
          input.outcome === "rejected"
            ? "attempt-rejected"
            : input.outcome === "failed"
              ? "attempt-failed"
              : "report-cancelled",
      };
  }
}

export type NodeReportResult = Readonly<{
  nodeId: string;
  kind: NodeKind;
  state: NodeState;
  blockReason: string | null;
  attemptId: string | null;
  attemptNo: number | null;
  attemptsRemaining: number | null;
  objectId: string | null;
  objectiveState: NodeState | null;
  objectiveProjection: TerminalState | null;
}>;

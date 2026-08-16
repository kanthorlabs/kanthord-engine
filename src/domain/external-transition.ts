import type { RunDriver } from "./run.ts";
import type { NodeKind, NodeState } from "./state.ts";

export const externalTriggerIds = [
  "attempt-rejected",
  "outcome-accepted",
  "attempt-limit-reached",
  "object-reported",
  "human-close",
  "human-close-partial",
  "claim-released",
  "claim-expired",
] as const;
export type ExternalTriggerId = (typeof externalTriggerIds)[number];

export type ExternalPrecondition = Readonly<{
  runDriver: RunDriver;
  activeRun: boolean;
  leaseFence: "valid" | "none";
  actorKind: "human" | "daemon" | "harness";
  attemptLimit: "under" | "reached" | "not-applicable";
  reportedObjectId: "required" | "absent";
  childAggregation:
    | "every-task-terminal-one-done"
    | "every-task-done"
    | "at-least-one-task-discarded"
    | "not-applicable";
}>;

export type ExternalTransition = Readonly<{
  level: NodeKind;
  from: NodeState;
  to: NodeState;
  trigger: ExternalTriggerId;
  precondition: ExternalPrecondition;
}>;

export const externalTransitions: readonly ExternalTransition[] = [
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "attempt-rejected",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "done",
    trigger: "outcome-accepted",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "blocked",
    trigger: "attempt-limit-reached",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "reached",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "objective",
    from: "running",
    to: "awaiting_approval",
    trigger: "object-reported",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-terminal-one-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "done",
    trigger: "human-close",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "partial",
    trigger: "human-close-partial",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "at-least-one-task-discarded",
    },
  },
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "claim-released",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "claim-expired",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "daemon",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
] as const;

export type DrivePinInput = Readonly<{
  runDrivers: readonly RunDriver[];
  claimDriver: RunDriver;
}>;

export type DrivePinRefusal = Readonly<{
  pinnedDriver: RunDriver;
  claimDriver: RunDriver;
}>;

export function objectiveDrivePin(
  input: DrivePinInput,
): DrivePinRefusal | null {
  const pinnedDriver = input.runDrivers.find(
    (driver) => driver !== input.claimDriver,
  );
  if (pinnedDriver === undefined) {
    return null;
  }
  return { pinnedDriver, claimDriver: input.claimDriver };
}

export const externalTriggerConsumer: Readonly<
  Record<ExternalTriggerId, string>
> = {
  "attempt-rejected": "src/commands/outcome/report-outcome.ts",
  "outcome-accepted": "src/commands/outcome/report-outcome.ts",
  "attempt-limit-reached": "src/commands/outcome/report-outcome.ts",
  "object-reported": "src/commands/outcome/report-objective.ts",
  "human-close": "src/commands/outcome/close-objective.ts",
  "human-close-partial": "src/commands/outcome/close-objective.ts",
  "claim-released": "src/commands/node/release-node.ts",
  "claim-expired": "src/commands/startup/recover-expired-leases.ts",
};

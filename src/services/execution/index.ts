import type { AttemptOutcome } from "../../domain/attempt.ts";
import type { RunDriver } from "../../domain/run.ts";
import type { Transaction } from "../storage/index.ts";

export type RunKind = "objective" | "task";

export type RunRecord = Readonly<{
  id: string;
  kind: RunKind;
  nodeId: string;
  parentRunId: string | null;
  driver: RunDriver;
  leaseFence: number;
  attemptLimit: number;
  state: "active" | "ended";
  outcome: string | null;
  headOid: string | null;
  endedAt: number | null;
}>;

export type AttemptRecord = Readonly<{
  id: string;
  runId: string;
  driver: RunDriver;
  attemptNo: number;
  headOid: string | null;
  outcome: AttemptOutcome | null;
  endedAt: number | null;
}>;

export type OpenRunInput = Readonly<{
  nodeId: string;
  kind: RunKind;
  parentRunId: string | null;
  leaseFence: number;
  attemptLimit: number;
}>;

export type AdoptRunInput = Readonly<{ runId: string; leaseFence: number }>;

export type EndRunInput = Readonly<{
  runId: string;
  outcome: string;
  at: number;
}>;

export type OpenAttemptInput = Readonly<{ runId: string }>;

export type CloseAttemptInput = Readonly<{
  attemptId: string;
  outcome: AttemptOutcome;
  at: number;
}>;

export type ExecutionErrorCode =
  "run-not-found" | "run-not-active" | "attempt-not-open";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

export interface Execution {
  openRun(transaction: Transaction, input: OpenRunInput): RunRecord;
  activeRunOfNode(transaction: Transaction, nodeId: string): RunRecord | null;
  adoptRun(transaction: Transaction, input: AdoptRunInput): RunRecord;
  endRun(transaction: Transaction, input: EndRunInput): RunRecord;
  openAttempt(transaction: Transaction, input: OpenAttemptInput): AttemptRecord;
  closeAttempt(
    transaction: Transaction,
    input: CloseAttemptInput,
  ): AttemptRecord;
  attemptsOfRun(
    transaction: Transaction,
    runId: string,
  ): readonly AttemptRecord[];
  runDriversUnderObjective(
    transaction: Transaction,
    objectiveId: string,
  ): readonly RunDriver[];
}

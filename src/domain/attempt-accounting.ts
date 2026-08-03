import type { AttemptOutcome } from "./attempt.ts";

export type AttemptRecord = Readonly<{
  attemptNo: number;
  outcome: AttemptOutcome | null;
}>;

export type AttemptAccounting = Readonly<{
  counter: number;
  rejections: number;
  exhausted: boolean;
  nextAttemptNo: number;
}>;

export type AttemptVerdict =
  | Readonly<{ state: "running"; blockReason: null }>
  | Readonly<{ state: "blocked"; blockReason: "attempt-limit" }>;

export type AttemptAccountingErrorCode =
  "attempt-limit-invalid" | "attempt-no-invalid" | "attempt-no-duplicate";

export class AttemptAccountingError extends Error {
  readonly code: AttemptAccountingErrorCode;

  constructor(code: AttemptAccountingErrorCode, message: string) {
    super(message);
    this.name = "AttemptAccountingError";
    this.code = code;
  }
}

export function accountAttempts(
  input: Readonly<{ attempts: readonly AttemptRecord[]; limit: number }>,
): AttemptAccounting {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new AttemptAccountingError(
      "attempt-limit-invalid",
      `attempt limit ${input.limit} is not a positive integer`,
    );
  }

  const seen = new Set<number>();
  for (const attempt of input.attempts) {
    if (!Number.isInteger(attempt.attemptNo) || attempt.attemptNo < 1) {
      throw new AttemptAccountingError(
        "attempt-no-invalid",
        `attempt number ${attempt.attemptNo} is not a positive integer`,
      );
    }
    if (seen.has(attempt.attemptNo)) {
      throw new AttemptAccountingError(
        "attempt-no-duplicate",
        `attempt number ${attempt.attemptNo} appears twice`,
      );
    }
    seen.add(attempt.attemptNo);
  }

  let counter = 0;
  let rejections = 0;
  for (const attempt of input.attempts) {
    if (attempt.attemptNo > counter) {
      counter = attempt.attemptNo;
    }
    if (attempt.outcome === "rejected") {
      rejections++;
    }
  }

  const counterRecord = input.attempts.find((a) => a.attemptNo === counter);
  const exhausted =
    counterRecord !== undefined &&
    counterRecord.outcome === "rejected" &&
    counter >= input.limit;

  return {
    counter,
    rejections,
    exhausted,
    nextAttemptNo: counter + 1,
  };
}

export function attemptVerdict(accounting: AttemptAccounting): AttemptVerdict {
  if (accounting.exhausted) {
    return { state: "blocked", blockReason: "attempt-limit" };
  }
  return { state: "running", blockReason: null };
}

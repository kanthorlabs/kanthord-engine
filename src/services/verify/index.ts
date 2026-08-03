export type CheckOutcome =
  "passed" | "failed" | "error" | "timed-out" | "cancelled" | "not-applicable";

export type CheckRequest = Readonly<{
  checkName: string;
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  outputLimitBytes: number;
}>;

export type CheckOutput = Readonly<{
  result: CheckOutcome;
  exitCode: number | null;
  output: string;
  envIdentity: string;
  toolchainVersion: string;
  endedAt: number;
}>;

export type VerifyErrorCode = "not-implemented";

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
  }
}

export interface Verify {
  run(request: CheckRequest): Promise<CheckOutput>;
}
